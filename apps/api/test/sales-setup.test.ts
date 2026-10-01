import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setDbContext } from '../src/application/unit-of-work.js';
import { formatDocumentNumber, takeNextNumber } from '../src/modules/sales/index.js';
import {
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/**
 * Phase 3B steps 3–5: Sales settings and numbering (D3, D7; D12, E3), customers on the Party
 * master (Decisions 8, 28, 48; D6) and the items catalog (D4, Decision 31; D8).
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

async function createRole(owner: TestClient, name: string, permissionKeys: string[]) {
  const res = await owner.post('/organizations/current/roles', { name, permissionKeys });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function gstId(org: AccountingOrg) {
  const codes = (await org.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
  return codes.find((c) => c.code === 'GST')!.id;
}

async function configure(org: AccountingOrg, overrides: object = {}) {
  const res = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: await gstId(org),
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function accountFlag(org: AccountingOrg, code: string) {
  const res = await org.owner.get(`/accounting/accounts/${org.accounts[code]}`);
  return res.body.data.isControlAccount as boolean;
}

async function withOwnerDb<T>(work: (db: Awaited<ReturnType<typeof connectAs>>) => Promise<T>) {
  const db = await connectAs('owner');
  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

async function auditActions(organizationId: string, resourceId: string) {
  return withOwnerDb(async (db) => {
    const { rows } = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND resource_id = $2
        ORDER BY occurred_at, id`,
      [organizationId, resourceId],
    );
    return rows.map((r) => r.action as string);
  });
}

// ---------------------------------------------------------------------------
// Settings and numbering
// ---------------------------------------------------------------------------

describe('Sales settings (D7, E3)', () => {
  it('shows defaults with a suggested AR account until the first save', async () => {
    const org = await setUpAccountingOrg(ctx);
    const res = await org.owner.get('/sales/settings');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      configured: false,
      version: 0,
      arAccountId: null,
      suggestedArAccountId: org.accounts['1130'],
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
      arLocked: false,
      numbering: {
        invoice: { prefix: 'INV-', minDigits: 5, nextNumber: 1, preview: 'INV-00001' },
        credit_note: { prefix: 'CN-', preview: 'CN-00001' },
        receipt: { prefix: 'RCT-', preview: 'RCT-00001' },
      },
    });
  });

  it('saves settings, marks the AR control account and audits it', async () => {
    const org = await setUpAccountingOrg(ctx);
    const saved = await configure(org, {
      numbering: { invoice: { prefix: 'SI/', minDigits: 4, nextNumber: 1001 } },
    });
    expect(saved).toMatchObject({
      configured: true,
      version: 1,
      arAccountId: org.accounts['1130'],
      suggestedArAccountId: null,
      numbering: { invoice: { preview: 'SI/1001' }, receipt: { preview: 'RCT-00001' } },
    });
    expect(await accountFlag(org, '1130')).toBe(true);
    expect(await auditActions(org.organizationId, org.organizationId)).toContain(
      'sales_settings.created',
    );
    expect(await auditActions(org.organizationId, org.accounts['1130']!)).toContain(
      'account.control_marked',
    );

    // C3: manual journals to the AR control account are refused from now on.
    const manual = await org.owner.post('/accounting/journals', {
      entryDate: '2026-03-15',
      description: 'Manual AR',
      currency: 'MVR',
      lines: [
        line(org.accounts['1130']!, 'debit', '10.00'),
        line(org.accounts['4100']!, 'credit', '10.00'),
      ],
    });
    expect(manual.status).toBe(400);

    // Stale versions are refused; any change bumps the version (numbering included).
    const stale = await org.owner.put('/sales/settings', { ...pick(saved), version: 0 });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const renumbered = await org.owner.put('/sales/settings', {
      ...pick(saved),
      numbering: { receipt: { prefix: 'OR-', minDigits: 6, nextNumber: 50 } },
    });
    expect(renumbered.status, JSON.stringify(renumbered.body)).toBe(200);
    expect(renumbered.body.data).toMatchObject({
      version: 2,
      numbering: { receipt: { preview: 'OR-000050' }, invoice: { preview: 'SI/1001' } },
    });
    const backwards = await org.owner.put('/sales/settings', {
      ...pick(renumbered.body.data),
      numbering: { receipt: { prefix: 'OR-', minDigits: 6, nextNumber: 49 } },
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.details.issues[0].path).toBe('numbering.receipt.nextNumber');
  });

  it('moves the control flag when the AR account changes, and fixes it once locked (D12)', async () => {
    const org = await setUpAccountingOrg(ctx);
    const saved = await configure(org);
    const second = await org.owner.post('/accounting/accounts', {
      code: '1135',
      name: 'Receivables - projects',
      type: 'ASSET',
      parentId: org.accounts['1100'],
      subtype: 'ACCOUNTS_RECEIVABLE',
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const moved = await org.owner.put('/sales/settings', {
      ...pick(saved),
      arAccountId: second.body.data.id,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await accountFlag(org, '1130')).toBe(false);
    expect(
      (await org.owner.get(`/accounting/accounts/${second.body.data.id}`)).body.data,
    ).toMatchObject({ isControlAccount: true });
    expect(await auditActions(org.organizationId, org.accounts['1130']!)).toContain(
      'account.control_released',
    );

    // Once the first Sales document is issued, the AR account is fixed (API and database).
    await withOwnerDb((db) =>
      db.query(`UPDATE sales_settings SET ar_locked_at = now() WHERE organization_id = $1`, [
        org.organizationId,
      ]),
    );
    const locked = await org.owner.put('/sales/settings', {
      ...pick(moved.body.data),
      arAccountId: org.accounts['1130'],
    });
    expect(locked.status).toBe(400);
    expect(locked.body.error.details.issues[0].path).toBe('arAccountId');
    expect((await org.owner.get('/sales/settings')).body.data.arLocked).toBe(true);
    await expect(
      withOwnerDb((db) =>
        db.query(`UPDATE sales_settings SET ar_account_id = $2 WHERE organization_id = $1`, [
          org.organizationId,
          org.accounts['1130'],
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses unsuitable accounts, including AR accounts with history outside Sales', async () => {
    const org = await setUpAccountingOrg(ctx);
    const base = {
      version: 0,
      arAccountId: org.accounts['1130'],
      defaultRevenueAccountId: org.accounts['4100'],
      defaultDepositAccountId: org.accounts['1120'],
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    };
    const expectIssue = async (body: object, path: string) => {
      const res = await org.owner.put('/sales/settings', { ...base, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.details.issues.map((i: { path: string }) => i.path)).toContain(path);
    };
    await expectIssue({ arAccountId: org.accounts['1120'] }, 'arAccountId'); // bank, not AR
    await expectIssue({ arAccountId: org.accounts['1100'] }, 'arAccountId'); // parent
    await expectIssue({ defaultRevenueAccountId: org.accounts['1110'] }, 'defaultRevenueAccountId');
    await expectIssue({ defaultDepositAccountId: org.accounts['4100'] }, 'defaultDepositAccountId');

    // A receivables account that already carries manual postings cannot become the control.
    await postJournal(org, {
      entryDate: '2026-03-15',
      description: 'Legacy receivable',
      currency: 'MVR',
      lines: [
        line(org.accounts['1130']!, 'debit', '50.00'),
        line(org.accounts['4100']!, 'credit', '50.00'),
      ],
    });
    await expectIssue({}, 'arAccountId');
    // Nothing was saved or marked.
    expect((await org.owner.get('/sales/settings')).body.data.configured).toBe(false);
    expect(await accountFlag(org, '1130')).toBe(false);
    // Settings without an AR account can still be saved (missing accounts block issue, D7).
    const res = await org.owner.put('/sales/settings', { ...base, arAccountId: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('needs sales.settings.manage and a recent password confirmation to change', async () => {
    const org = await setUpAccountingOrg(ctx);
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.get('/sales/settings')).status).toBe(200); // invoices.view
    const denied = await member.client.put('/sales/settings', {
      version: 0,
      arAccountId: null,
      defaultRevenueAccountId: null,
      defaultDepositAccountId: null,
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    });
    expect(denied.status).toBe(403);
    await createRole(org.owner, 'Ledger only', ['accounting.accounts.view']);
    const ledger = await joinWithRole(ctx, org.owner, 'Ledger only');
    expect((await ledger.client.get('/sales/settings')).status).toBe(403);

    ctx.clock.advance(16 * MINUTE);
    await org.owner.get('/auth/session');
    const stale = await org.owner.put('/sales/settings', {
      version: 0,
      arAccountId: null,
      defaultRevenueAccountId: null,
      defaultDepositAccountId: null,
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
  });

  it('hands out numbers in order and never moves a sequence backwards', async () => {
    const org = await setUpAccountingOrg(ctx);
    await configure(org, {
      numbering: { invoice: { prefix: 'INV-', minDigits: 3, nextNumber: 998 } },
    });
    const who = {
      organizationId: org.organizationId,
      userId: (await org.owner.get('/auth/session')).body.data.user.id as string,
    };
    const take = () =>
      inTransaction(ctx.database.db, who, async (tx) => {
        await setDbContext(tx, who);
        return takeNextNumber(tx, org.organizationId, 'invoice');
      });
    const numbers = [];
    for (let i = 0; i < 3; i += 1) numbers.push((await take())!.number);
    // The minimum width pads; longer numbers keep all their digits.
    expect(numbers).toEqual(['INV-998', 'INV-999', 'INV-1000']);
    expect(formatDocumentNumber({ prefix: '', minDigits: 5 }, 42)).toBe('00042');
    // Concurrent takers get distinct numbers.
    const concurrent = await Promise.all([take(), take(), take(), take()]);
    expect(new Set(concurrent.map((n) => n!.number)).size).toBe(4);
    await expect(
      withOwnerDb((db) =>
        db.query(
          `UPDATE sales_number_sequences SET next_number = 1
            WHERE organization_id = $1 AND document_type = 'invoice'`,
          [org.organizationId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

/** The settings fields of a view, for a follow-up PUT. */
function pick(view: Record<string, unknown>) {
  return {
    version: view.version,
    arAccountId: view.arAccountId,
    defaultRevenueAccountId: view.defaultRevenueAccountId,
    defaultDepositAccountId: view.defaultDepositAccountId,
    defaultTaxCodeId: view.defaultTaxCodeId,
    defaultTaxTreatment: view.defaultTaxTreatment,
    defaultPaymentTermsDays: view.defaultPaymentTermsDays,
  };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const newParty = (overrides: object = {}) => ({
  kind: 'organization',
  displayName: 'Coral Reef Resort',
  tin: '1009988GST501',
  email: 'accounts@coralreef.test',
  addresses: [{ kind: 'billing', line1: 'Boduthakurufaanu Magu', countryCode: 'MV' }],
  ...overrides,
});

async function createCustomer(client: TestClient, body: object) {
  const res = await client.post('/customers', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

describe('customers (Decisions 8, 28, 48; D6)', () => {
  it('creates a customer with a new party that holds the customer role', async () => {
    const org = await setUpAccountingOrg(ctx);
    const customer = await createCustomer(org.owner, {
      party: newParty(),
      paymentTermsDays: 15,
      creditLimit: '5000',
    });
    expect(customer).toMatchObject({
      displayName: 'Coral Reef Resort',
      tin: '1009988GST501',
      currencyCode: 'MVR', // the base currency by default
      paymentTermsDays: 15,
      creditLimit: '5000.00',
      status: 'ACTIVE',
      version: 1,
      roles: ['customer'],
      warnings: [],
    });
    expect(customer.addresses).toHaveLength(1);
    const party = (await org.owner.get(`/parties/${customer.partyId}`)).body.data;
    expect(party.roles).toEqual(['customer']);
    expect(await auditActions(org.organizationId, customer.id)).toEqual(['customer.created']);
    expect(await auditActions(org.organizationId, customer.partyId)).toEqual(['party.created']);
  });

  it('makes an existing contact a customer, once', async () => {
    const org = await setUpAccountingOrg(ctx);
    const party = await org.owner.post('/parties', {
      kind: 'organization',
      displayName: 'Island Supplies',
      roles: ['vendor'],
    });
    expect(party.status).toBe(201);
    const customer = await createCustomer(org.owner, {
      partyId: party.body.data.id,
      currencyCode: 'USD',
      creditLimit: null,
    });
    expect(customer).toMatchObject({ currencyCode: 'USD', creditLimit: null });
    expect(customer.roles).toEqual(['customer', 'vendor']);
    const again = await org.owner.post('/customers', { partyId: party.body.data.id });
    expect(again.status).toBe(409);

    const archivedParty = await org.owner.post('/parties', {
      kind: 'individual',
      firstName: 'Old',
      lastName: 'Contact',
    });
    await org.owner.post(`/parties/${archivedParty.body.data.id}/archive`);
    const refused = await org.owner.post('/customers', { partyId: archivedParty.body.data.id });
    expect(refused.status).toBe(400);
    const bad = await org.owner.post('/customers', {
      partyId: party.body.data.id,
      party: newParty(),
    });
    expect(bad.status).toBe(400);
  });

  it('lists, searches and pages customers only', async () => {
    const org = await setUpAccountingOrg(ctx);
    for (const name of ['Alpha Traders', 'Beta Hotel', 'Gamma Travels']) {
      await createCustomer(org.owner, {
        party: newParty({ displayName: name, tin: null, email: null }),
      });
    }
    await org.owner.post('/parties', { kind: 'organization', displayName: 'Delta (vendor only)' });
    const page1 = (await org.owner.get('/customers?limit=2')).body.data;
    expect(page1.items.map((c: { displayName: string }) => c.displayName)).toEqual([
      'Alpha Traders',
      'Beta Hotel',
    ]);
    const page2 = (
      await org.owner.get(`/customers?limit=2&after=${encodeURIComponent(page1.nextCursor)}`)
    ).body.data;
    expect(page2.items.map((c: { displayName: string }) => c.displayName)).toEqual([
      'Gamma Travels',
    ]);
    expect(page2.nextCursor).toBeNull();
    const found = (await org.owner.get('/customers?search=hotel')).body.data.items;
    expect(found.map((c: { displayName: string }) => c.displayName)).toEqual(['Beta Hotel']);
  });

  it('edits terms and identity under customers.update, with version checks', async () => {
    const org = await setUpAccountingOrg(ctx);
    const customer = await createCustomer(org.owner, { party: newParty() });
    const tooPrecise = await org.owner.patch(`/customers/${customer.id}`, {
      version: 1,
      currencyCode: 'USD',
      creditLimit: '10.123',
    });
    expect(tooPrecise.status).toBe(400);
    const edited = await org.owner.patch(`/customers/${customer.id}`, {
      version: 1,
      currencyCode: 'USD',
      creditLimit: '2500.50',
      party: { version: customer.partyVersion, displayName: 'Coral Reef Resort & Spa' },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data).toMatchObject({
      version: 2,
      currencyCode: 'USD',
      creditLimit: '2500.50',
      displayName: 'Coral Reef Resort & Spa',
    });
    const stale = await org.owner.patch(`/customers/${customer.id}`, {
      version: 1,
      paymentTermsDays: 7,
    });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const roles = await org.owner.patch(`/customers/${customer.id}`, {
      version: 2,
      party: { version: edited.body.data.partyVersion, roles: [] },
    });
    expect(roles.status).toBe(400); // roles are not edited from the customer screen

    // D6: a role with customers.update edits identity here but not on the Contacts screens.
    await createRole(org.owner, 'Customer clerk', ['customers.view', 'customers.update']);
    const clerk = await joinWithRole(ctx, org.owner, 'Customer clerk');
    const address = await clerk.client.post(`/customers/${customer.id}/addresses`, {
      kind: 'delivery',
      line1: 'Resort jetty',
      countryCode: 'MV',
    });
    expect(address.status, JSON.stringify(address.body)).toBe(201);
    expect(address.body.data.addresses).toHaveLength(2);
    const contact = await clerk.client.post(`/customers/${customer.id}/contacts`, {
      firstName: 'Mariyam',
      isPrimary: true,
    });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.data.contacts[0].id;
    expect(
      (
        await clerk.client.patch(`/customers/${customer.id}/contacts/${contactId}`, {
          jobTitle: 'Finance',
        })
      ).status,
    ).toBe(200);
    expect(
      (await clerk.client.delete(`/customers/${customer.id}/contacts/${contactId}`)).status,
    ).toBe(200);
    expect(
      (await clerk.client.patch(`/parties/${customer.partyId}`, { version: 99, notes: 'x' }))
        .status,
    ).toBe(403);
    expect((await clerk.client.post('/customers', { party: newParty() })).status).toBe(403);
  });

  it('keeps the party customer role while the customer exists', async () => {
    const org = await setUpAccountingOrg(ctx);
    const customer = await createCustomer(org.owner, { party: newParty() });
    const party = (await org.owner.get(`/parties/${customer.partyId}`)).body.data;
    const removed = await org.owner.patch(`/parties/${customer.partyId}`, {
      version: party.version,
      roles: ['vendor'],
    });
    expect(removed.status).toBe(400);
    expect(removed.body.error.details.issues[0].path).toBe('roles');
    // Other role changes still work and keep the customer role.
    const added = await org.owner.patch(`/parties/${customer.partyId}`, {
      version: party.version,
      roles: ['customer', 'vendor'],
    });
    expect(added.status).toBe(200);
    // The database refuses it too, at commit.
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [org.organizationId]);
      await app.query(`DELETE FROM party_roles WHERE party_id = $1 AND role = 'customer'`, [
        customer.partyId,
      ]);
      await expect(app.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally {
      await app.end();
    }
  });

  it('archives and restores customers', async () => {
    const org = await setUpAccountingOrg(ctx);
    const customer = await createCustomer(org.owner, { party: newParty() });
    const archived = await org.owner.post(`/customers/${customer.id}/archive`, { version: 1 });
    expect(archived.body.data).toMatchObject({ status: 'ARCHIVED', version: 2 });
    expect((await org.owner.get('/customers')).body.data.items).toHaveLength(0);
    expect((await org.owner.get('/customers?status=archived')).body.data.items).toHaveLength(1);
    await org.owner.post(`/parties/${customer.partyId}/archive`);
    const blocked = await org.owner.post(`/customers/${customer.id}/restore`, { version: 2 });
    expect(blocked.body.error.code).toBe('INVALID_STATE_TRANSITION');
    await org.owner.post(`/parties/${customer.partyId}/restore`);
    const restored = await org.owner.post(`/customers/${customer.id}/restore`, { version: 2 });
    expect(restored.body.data).toMatchObject({ status: 'ACTIVE', archivedAt: null });
    expect(await auditActions(org.organizationId, customer.id)).toEqual([
      'customer.created',
      'customer.archived',
      'customer.restored',
    ]);
  });

  it('enforces permissions, tenant isolation and database guards', async () => {
    const org = await setUpAccountingOrg(ctx);
    const other = await setUpAccountingOrg(ctx);
    const customer = await createCustomer(org.owner, { party: newParty() });
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.get(`/customers/${customer.id}`)).status).toBe(200);
    expect((await member.client.post('/customers', { party: newParty() })).status).toBe(403);
    expect(
      (await member.client.post(`/customers/${customer.id}/archive`, { version: 1 })).status,
    ).toBe(403);
    expect((await other.owner.get(`/customers/${customer.id}`)).status).toBe(404);

    const app = await connectAs('app');
    try {
      const inTenant = async (organizationId: string, statement: string) => {
        await app.query('BEGIN');
        try {
          await app.query(`SELECT set_config('app.organization_id', $1, true)`, [organizationId]);
          return await app.query(statement);
        } finally {
          await app.query('ROLLBACK');
        }
      };
      const hidden = await inTenant(
        other.organizationId,
        `SELECT count(*)::int AS n FROM customers WHERE id = '${customer.id}'`,
      );
      expect(hidden.rows[0].n).toBe(0);
      await expect(
        inTenant(org.organizationId, `DELETE FROM customers WHERE id = '${customer.id}'`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        inTenant(
          org.organizationId,
          `UPDATE customers SET party_id = gen_random_uuid() WHERE id = '${customer.id}'`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await app.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

describe('items catalog (D4, Decision 31, D8)', () => {
  it('creates, edits, archives and restores items with version checks', async () => {
    const org = await setUpAccountingOrg(ctx);
    const res = await org.owner.post('/sales/items', {
      sku: 'SNK-01',
      name: 'Snorkel trip',
      itemType: 'service',
      description: 'Half-day',
      unitPrice: '750.5',
      revenueAccountId: org.accounts['4100'],
      taxCodeId: await gstId(org),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const item = res.body.data;
    expect(item).toMatchObject({
      sku: 'SNK-01',
      unitPrice: '750.50',
      status: 'ACTIVE',
      version: 1,
    });
    const duplicate = await org.owner.post('/sales/items', {
      sku: 'snk-01',
      name: 'Other',
      itemType: 'service',
    });
    expect(duplicate.status).toBe(409);
    const badAccount = await org.owner.post('/sales/items', {
      name: 'Other',
      itemType: 'product',
      revenueAccountId: org.accounts['1110'],
    });
    expect(badAccount.status).toBe(400);

    const edited = await org.owner.patch(`/sales/items/${item.id}`, {
      version: 1,
      unitPrice: '800',
      taxCodeId: null,
    });
    expect(edited.body.data).toMatchObject({ unitPrice: '800.00', taxCodeId: null, version: 2 });
    const stale = await org.owner.patch(`/sales/items/${item.id}`, { version: 1, name: 'X' });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const archived = await org.owner.post(`/sales/items/${item.id}/archive`, { version: 2 });
    expect(archived.body.data.status).toBe('ARCHIVED');
    expect((await org.owner.get('/sales/items')).body.data.items).toHaveLength(0);
    const restored = await org.owner.post(`/sales/items/${item.id}/restore`, { version: 3 });
    expect(restored.body.data.status).toBe('ACTIVE');
    expect(await auditActions(org.organizationId, item.id)).toEqual([
      'sales_item.created',
      'sales_item.updated',
      'sales_item.archived',
      'sales_item.restored',
    ]);
  });

  it('searches and pages by name', async () => {
    const org = await setUpAccountingOrg(ctx);
    for (const [name, sku] of [
      ['Airport transfer', 'TRF'],
      ['Dive course', 'DIVE-OW'],
      ['Sunset cruise', null],
    ] as const) {
      await org.owner.post('/sales/items', { name, sku, itemType: 'service' });
    }
    const first = (await org.owner.get('/sales/items?limit=2')).body.data;
    expect(first.items.map((i: { name: string }) => i.name)).toEqual([
      'Airport transfer',
      'Dive course',
    ]);
    const next = (
      await org.owner.get(`/sales/items?limit=2&after=${encodeURIComponent(first.nextCursor)}`)
    ).body.data;
    expect(next.items.map((i: { name: string }) => i.name)).toEqual(['Sunset cruise']);
    expect((await org.owner.get('/sales/items?search=dive-ow')).body.data.items).toHaveLength(1);
    // LIKE wildcards in the search are literal.
    expect((await org.owner.get('/sales/items?search=%25')).body.data.items).toHaveLength(0);
  });

  it('lets invoice viewers read items and only sales.items.manage change them', async () => {
    const org = await setUpAccountingOrg(ctx);
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.get('/sales/items')).status).toBe(200);
    expect(
      (await member.client.post('/sales/items', { name: 'X', itemType: 'service' })).status,
    ).toBe(403);
    await createRole(org.owner, 'Customers only', ['customers.view']);
    const viewer = await joinWithRole(ctx, org.owner, 'Customers only');
    expect((await viewer.client.get('/sales/items')).status).toBe(403);
    await createRole(org.owner, 'Catalog', ['sales.items.manage']);
    const catalog = await joinWithRole(ctx, org.owner, 'Catalog');
    expect(
      (await catalog.client.post('/sales/items', { name: 'Y', itemType: 'product' })).status,
    ).toBe(201);
  });
});
