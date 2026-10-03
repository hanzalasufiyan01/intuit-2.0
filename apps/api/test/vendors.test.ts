import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/application/unit-of-work.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 4A-3 (ADR 0004 P4-03, P4-20, P4-39, P4-40, P4-43): vendors on the shared Party master.
 * Identity stays on the Party; the vendor record holds currency, terms, the warning-only credit
 * limit, the account number with the vendor and default expense account / tax code.
 */

let ctx: TestContext;
let owner: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext();
  owner = await connectAs('owner');
});
afterAll(async () => {
  await owner.end();
  await ctx.close();
});

const newParty = (overrides: Record<string, unknown> = {}) => ({
  kind: 'organization',
  displayName: `Island Supplies ${Math.random().toString(36).slice(2, 8)}`,
  roles: [],
  ...overrides,
});

async function createVendor(client: TestClient, body: Record<string, unknown>) {
  const res = await client.post('/vendors', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function auditActions(org: AccountingOrg, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action, metadata FROM audit_events WHERE organization_id = $1 AND resource_id = $2
      ORDER BY occurred_at, id`,
    [org.organizationId, resourceId],
  );
  return rows as { action: string; metadata: Record<string, unknown> }[];
}

describe('creating vendors on the Party master (P4-03)', () => {
  it('creates a vendor with a new Party, defaulting the currency to the base currency', async () => {
    const org = await setUpAccountingOrg(ctx);
    const vendor = await createVendor(org.owner, {
      party: newParty({
        email: 'ap@islandsupplies.test',
        tin: '1000234GST001',
        addresses: [{ kind: 'billing', line1: 'Majeedhee Magu', city: 'Malé', countryCode: 'MV' }],
        contacts: [{ firstName: 'Aminath', isPrimary: true }],
      }),
      paymentTermsDays: 15,
      creditLimit: '25000.5',
      accountNumber: '  ACC-778  ',
    });
    expect(vendor).toMatchObject({
      currencyCode: 'MVR',
      paymentTermsDays: 15,
      creditLimit: '25000.50',
      accountNumber: 'ACC-778',
      defaultExpenseAccountId: null,
      defaultTaxCodeId: null,
      status: 'ACTIVE',
      version: 1,
      roles: ['vendor'],
      tin: '1000234GST001',
      email: 'ap@islandsupplies.test',
    });
    expect(vendor.addresses).toHaveLength(1);
    expect(vendor.contacts).toHaveLength(1);
    // One identity: the party is a normal party with the vendor role, no copy of its contacts.
    const party = await org.owner.get(`/parties/${vendor.partyId}`);
    expect(party.body.data.roles).toEqual(['vendor']);
    expect(party.body.data.contacts).toHaveLength(1);
    const audit = await auditActions(org, vendor.id);
    expect(audit.map((a) => a.action)).toEqual(['vendor.created']);
    expect(audit[0]!.metadata).toMatchObject({
      partyId: vendor.partyId,
      newParty: true,
      currencyCode: 'MVR',
      paymentTermsDays: 15,
      creditLimit: '25000.5000',
      accountNumber: 'ACC-778',
    });
    expect((await auditActions(org, vendor.partyId)).map((a) => a.action)).toContain(
      'party.created',
    );
  });

  it('assigns the vendor role to an existing Party, keeping its other roles', async () => {
    const org = await setUpAccountingOrg(ctx);
    const party = (await org.owner.post('/parties', newParty({ roles: ['other'] }))).body.data;
    const vendor = await createVendor(org.owner, { partyId: party.id, currencyCode: 'USD' });
    expect(vendor).toMatchObject({ partyId: party.id, currencyCode: 'USD' });
    expect([...vendor.roles].sort()).toEqual(['other', 'vendor']);
    expect((await auditActions(org, vendor.id))[0]!.metadata).toMatchObject({ newParty: false });
    // A second vendor for the same party is refused.
    const again = await org.owner.post('/vendors', { partyId: party.id });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('This contact is already a vendor.');
    // An archived party must be restored first.
    const archivedParty = (await org.owner.post('/parties', newParty())).body.data;
    expect((await org.owner.post(`/parties/${archivedParty.id}/archive`)).status).toBe(200);
    const refused = await org.owner.post('/vendors', { partyId: archivedParty.id });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.issues[0].message).toBe(
      'Restore the archived contact first.',
    );
  });

  it('lets one Party be a customer and a vendor, with separate terms', async () => {
    const org = await setUpAccountingOrg(ctx);
    const customer = (
      await org.owner.post('/customers', {
        party: newParty(),
        currencyCode: 'USD',
        paymentTermsDays: 30,
        creditLimit: '1000',
      })
    ).body.data;
    const vendor = await createVendor(org.owner, {
      partyId: customer.partyId,
      currencyCode: 'EUR',
      paymentTermsDays: 7,
      creditLimit: '500',
    });
    expect([...vendor.roles].sort()).toEqual(['customer', 'vendor']);
    // Vendor changes never touch the customer record, and vice versa.
    const updated = await org.owner.patch(`/vendors/${vendor.id}`, {
      version: vendor.version,
      paymentTermsDays: 45,
      creditLimit: null,
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const customerNow = (await org.owner.get(`/customers/${customer.id}`)).body.data;
    expect(customerNow).toMatchObject({
      currencyCode: 'USD',
      paymentTermsDays: 30,
      creditLimit: '1000.00',
      version: customer.version,
    });
    // The roles stay while the records exist.
    const party = (await org.owner.get(`/parties/${customer.partyId}`)).body.data;
    const dropVendor = await org.owner.patch(`/parties/${customer.partyId}`, {
      version: party.version,
      roles: ['customer'],
    });
    expect(dropVendor.status).toBe(400);
    expect(dropVendor.body.error.details.issues[0].message).toBe(
      'This contact is a vendor. Archive the vendor instead of removing the role.',
    );
    const dropCustomer = await org.owner.patch(`/parties/${customer.partyId}`, {
      version: party.version,
      roles: ['vendor'],
    });
    expect(dropCustomer.status).toBe(400);
    // Archiving the vendor leaves the customer active.
    const archived = await org.owner.post(`/vendors/${vendor.id}/archive`, {
      version: updated.body.data.version,
    });
    expect(archived.status).toBe(200);
    expect((await org.owner.get(`/customers/${customer.id}`)).body.data.status).toBe('ACTIVE');
  });

  it('reports duplicate hints from the Party rules', async () => {
    const org = await setUpAccountingOrg(ctx);
    await org.owner.post(
      '/parties',
      newParty({ displayName: 'Coral Traders', email: 'x@coral.test' }),
    );
    const vendor = await org.owner.post('/vendors', {
      party: newParty({ displayName: 'Coral Traders', email: 'x@coral.test' }),
    });
    expect(vendor.status).toBe(201);
    expect(vendor.body.data.warnings).toEqual([
      expect.objectContaining({ code: 'POSSIBLE_DUPLICATE' }),
    ]);
  });
});

describe('vendor defaults (brief §6; P4-19 eligibility)', () => {
  it('accepts purchase accounts and active tax codes, and refuses everything else', async () => {
    const org = await setUpAccountingOrg(ctx);
    const codes = (await org.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
    const gst = codes.find((c) => c.code === 'GST')!.id;
    for (const code of ['5300', '5100', '1150', '1510']) {
      const ok = await org.owner.post('/vendors', {
        party: newParty(),
        defaultExpenseAccountId: org.accounts[code],
        defaultTaxCodeId: gst,
      });
      expect(ok.status, `${code}: ${JSON.stringify(ok.body)}`).toBe(201);
    }
    const unclassified = (
      await org.owner.post('/accounting/accounts', {
        code: '5600',
        name: 'Unclassified expense',
        type: 'EXPENSE',
      })
    ).body.data.id as string;
    for (const [account, message] of [
      [org.accounts['1120'], 'Choose an expense, cost of sales or asset account'],
      [org.accounts['2110'], 'Choose an expense, cost of sales or asset account'],
      [org.accounts['4100'], 'Choose an expense, cost of sales or asset account'],
      [org.accounts['3100'], 'Choose an expense, cost of sales or asset account'],
      [org.accounts['5000'], 'Choose a posting (leaf) account.'],
      [org.accounts['5950'], 'A designated system account cannot be used on purchases.'],
      [unclassified, 'The account is unclassified; classify it before using it on purchases.'],
    ] as const) {
      const res = await org.owner.post('/vendors', {
        party: newParty(),
        defaultExpenseAccountId: account,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.issues[0]).toMatchObject({ path: 'defaultExpenseAccountId' });
      expect(res.body.error.details.issues[0].message).toContain(message);
    }
    const tgst = codes.find((c) => c.code === 'TGST')!;
    const tgstView = (await org.owner.get('/tax/codes')).body.data.find(
      (c: { id: string }) => c.id === tgst.id,
    );
    expect(
      (await org.owner.post(`/tax/codes/${tgst.id}/archive`, { version: tgstView.version })).status,
    ).toBe(200);
    const archivedCode = await org.owner.post('/vendors', {
      party: newParty(),
      defaultTaxCodeId: tgst.id,
    });
    expect(archivedCode.status).toBe(400);
    expect(archivedCode.body.error.details.issues[0].message).toBe('TGST is archived.');
  });

  it('accepts no unknown fields, so no bank or payment details can be stored (P4-43)', async () => {
    const org = await setUpAccountingOrg(ctx);
    for (const extra of [
      { bankAccountNumber: '7701-123' },
      { iban: 'MV00' },
      { vendorReference: 'INV-1' },
    ]) {
      const res = await org.owner.post('/vendors', { party: newParty(), ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const { rows } = await owner.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'vendors' ORDER BY 1`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'account_number',
      'archived_at',
      'archived_by_user_id',
      'created_at',
      'created_by_user_id',
      'credit_limit',
      'currency_code',
      'default_expense_account_id',
      'default_tax_code_id',
      'default_tax_recoverable', // input-tax stage (P4-12)
      'id',
      'organization_id',
      'party_id',
      'payment_terms_days',
      'status',
      'updated_at',
      'updated_by_user_id',
      'version',
    ]);
  });
});

describe('updating, versions and archiving', () => {
  it('updates vendor fields and identity with optimistic versions, audited', async () => {
    const org = await setUpAccountingOrg(ctx);
    const vendor = await createVendor(org.owner, { party: newParty() });
    const updated = await org.owner.patch(`/vendors/${vendor.id}`, {
      version: 1,
      currencyCode: 'USD',
      accountNumber: 'NEW-1',
      party: { version: vendor.partyVersion, displayName: 'Island Supplies Pvt Ltd' },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data).toMatchObject({
      version: 2,
      currencyCode: 'USD',
      accountNumber: 'NEW-1',
      displayName: 'Island Supplies Pvt Ltd',
    });
    const stale = await org.owner.patch(`/vendors/${vendor.id}`, {
      version: 1,
      paymentTermsDays: 5,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      message: 'This vendor was changed by someone else. Reload it and apply your changes again.',
    });
    const staleParty = await org.owner.patch(`/vendors/${vendor.id}`, {
      version: 2,
      party: { version: vendor.partyVersion, displayName: 'Again' },
    });
    expect(staleParty.status).toBe(409);
    expect(staleParty.body.error.code).toBe('VERSION_CONFLICT');
    const audit = await auditActions(org, vendor.id);
    expect(audit.map((a) => a.action)).toEqual(['vendor.created', 'vendor.updated']);
    expect(audit[1]!.metadata).toMatchObject({
      version: 2,
      changedFields: ['currencyCode', 'accountNumber'],
      before: { currencyCode: 'MVR', accountNumber: null },
      after: { currencyCode: 'USD', accountNumber: 'NEW-1' },
    });
  });

  it('archives and restores; archived vendors stay readable but get no new documents', async () => {
    const org = await setUpAccountingOrg(ctx);
    const vendor = await createVendor(org.owner, { party: newParty({ displayName: 'Reef Fuel' }) });
    const usable = (id: string) =>
      inTransaction(ctx.database.db, { organizationId: org.organizationId }, (tx) =>
        ctx.services.vendors.requireUsableVendorInTransaction(tx, org.organizationId, id),
      );
    await expect(usable(vendor.id)).resolves.toMatchObject({ id: vendor.id });

    const archived = await org.owner.post(`/vendors/${vendor.id}/archive`, { version: 1 });
    expect(archived.status).toBe(200);
    expect(archived.body.data).toMatchObject({ status: 'ARCHIVED', version: 2 });
    expect(archived.body.data.archivedAt).not.toBeNull();
    const twice = await org.owner.post(`/vendors/${vendor.id}/archive`, { version: 2 });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('INVALID_STATE_TRANSITION');
    // Historical use: still readable, listed under archived / all, not under active.
    expect((await org.owner.get(`/vendors/${vendor.id}`)).status).toBe(200);
    const ids = async (status: string) =>
      ((await org.owner.get(`/vendors?status=${status}`)).body.data.items as { id: string }[]).map(
        (v) => v.id,
      );
    expect(await ids('active')).not.toContain(vendor.id);
    expect(await ids('archived')).toContain(vendor.id);
    expect(await ids('all')).toContain(vendor.id);
    // Future documents: refused.
    await expect(usable(vendor.id)).rejects.toMatchObject({
      details: {
        issues: [
          { path: 'vendorId', message: 'Archived vendors cannot be used on new documents.' },
        ],
      },
    });

    const restored = await org.owner.post(`/vendors/${vendor.id}/restore`, { version: 2 });
    expect(restored.status).toBe(200);
    expect(restored.body.data).toMatchObject({ status: 'ACTIVE', archivedAt: null });
    await expect(usable(vendor.id)).resolves.toMatchObject({ id: vendor.id });

    // An archived party blocks new documents and restoring the vendor.
    expect((await org.owner.post(`/parties/${vendor.partyId}/archive`)).status).toBe(200);
    await expect(usable(vendor.id)).rejects.toMatchObject({
      details: { issues: [{ message: 'Archived vendors cannot be used on new documents.' }] },
    });
    const again = await org.owner.post(`/vendors/${vendor.id}/archive`, { version: 3 });
    expect(again.status).toBe(200);
    const blocked = await org.owner.post(`/vendors/${vendor.id}/restore`, { version: 4 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toBe(
      'Restore the archived contact before restoring the vendor.',
    );
    expect((await auditActions(org, vendor.id)).map((a) => a.action)).toEqual([
      'vendor.created',
      'vendor.archived',
      'vendor.restored',
      'vendor.archived',
    ]);
  });

  it('searches vendors by party name, reference, email and TIN', async () => {
    const org = await setUpAccountingOrg(ctx);
    const a = await createVendor(org.owner, {
      party: newParty({ displayName: 'Hulhumale Hardware', reference: 'V-HH' }),
    });
    await createVendor(org.owner, { party: newParty({ displayName: 'Addu Logistics' }) });
    await org.owner.post('/customers', { party: newParty({ displayName: 'Hulhumale Hotel' }) });
    for (const term of ['hulhumale', 'V-HH']) {
      const found = (await org.owner.get(`/vendors?search=${encodeURIComponent(term)}`)).body.data
        .items as { id: string }[];
      expect(found.map((v) => v.id)).toEqual([a.id]);
    }
  });
});

describe('vendor edits of identity sub-resources go through the Party rules', () => {
  it('adds and removes a contact and an address on the party, under vendors.update', async () => {
    const org = await setUpAccountingOrg(ctx);
    const vendor = await createVendor(org.owner, { party: newParty() });
    const withContact = await org.owner.post(`/vendors/${vendor.id}/contacts`, {
      firstName: 'Hassan',
      isPrimary: true,
    });
    expect(withContact.status, JSON.stringify(withContact.body)).toBe(201);
    const withAddress = await org.owner.post(`/vendors/${vendor.id}/addresses`, {
      kind: 'billing',
      line1: 'Orchid Magu',
      countryCode: 'MV',
    });
    expect(withAddress.status, JSON.stringify(withAddress.body)).toBe(201);
    const party = (await org.owner.get(`/parties/${vendor.partyId}`)).body.data;
    expect(party.contacts).toHaveLength(1);
    expect(party.addresses).toHaveLength(1);
    const removed = await org.owner.delete(
      `/vendors/${vendor.id}/contacts/${party.contacts[0].id}`,
    );
    expect(removed.status).toBe(200);
    expect((await org.owner.get(`/parties/${vendor.partyId}`)).body.data.contacts).toHaveLength(0);
  });
});

describe('permissions (P4-39, P4-40)', () => {
  it('lets a Member view vendors but not create, update or archive them', async () => {
    const org = await setUpAccountingOrg(ctx);
    const vendor = await createVendor(org.owner, { party: newParty() });
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.get('/vendors')).status).toBe(200);
    expect((await member.client.get(`/vendors/${vendor.id}`)).status).toBe(200);
    for (const res of [
      await member.client.post('/vendors', { party: newParty() }),
      await member.client.patch(`/vendors/${vendor.id}`, { version: 1, paymentTermsDays: 3 }),
      await member.client.post(`/vendors/${vendor.id}/archive`, { version: 1 }),
      await member.client.post(`/vendors/${vendor.id}/contacts`, { firstName: 'X' }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PERMISSION_DENIED');
    }
    expect((await org.owner.get(`/vendors/${vendor.id}`)).body.data.version).toBe(1);
  });

  it('refuses a role without vendors.view, and an Administrator has every vendor key', async () => {
    const org = await setUpAccountingOrg(ctx);
    const vendor = await createVendor(org.owner, { party: newParty() });
    const role = await org.owner.post('/organizations/current/roles', {
      name: 'No vendors',
      permissionKeys: ['organization.read', 'parties.view'],
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const outsider = await joinWithRole(ctx, org.owner, 'No vendors');
    expect((await outsider.client.get('/vendors')).status).toBe(403);
    expect((await outsider.client.get(`/vendors/${vendor.id}`)).status).toBe(403);
    const admin = await joinWithRole(ctx, org.owner, 'Administrator');
    const created = await admin.client.post('/vendors', { party: newParty() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const archived = await admin.client.post(`/vendors/${created.body.data.id}/archive`, {
      version: 1,
    });
    expect(archived.status).toBe(200);
  });
});

describe('tenant isolation and database protections', () => {
  it('hides other organizations’ vendors and parties', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    const vendor = await createVendor(a.owner, { party: newParty() });
    expect((await b.owner.get(`/vendors/${vendor.id}`)).status).toBe(404);
    expect(
      (await b.owner.patch(`/vendors/${vendor.id}`, { version: 1, paymentTermsDays: 1 })).status,
    ).toBe(404);
    expect((await b.owner.post(`/vendors/${vendor.id}/archive`, { version: 1 })).status).toBe(404);
    expect((await b.owner.post('/vendors', { partyId: vendor.partyId })).status).toBe(404);
    const listed = (await b.owner.get('/vendors?status=all')).body.data.items as { id: string }[];
    expect(listed.map((v) => v.id)).not.toContain(vendor.id);
  });

  it('enforces RLS, no deletes, immutable identity and the vendor role at the database', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    const vendor = await createVendor(a.owner, { party: newParty() });
    const db = await connectAs('app');
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      expect((await db.query('SELECT id FROM vendors WHERE id = $1', [vendor.id])).rows).toEqual(
        [],
      );
      const update = await db.query(`UPDATE vendors SET payment_terms_days = 1 WHERE id = $1`, [
        vendor.id,
      ]);
      expect(update.rowCount).toBe(0);
      await db.query('ROLLBACK');
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.organization_id', $1, true)`, [a.organizationId]);
      await expect(
        db.query('DELETE FROM vendors WHERE id = $1', [vendor.id]),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
    const refuse = (text: string, params: unknown[]) =>
      owner.query(text, params).then(
        () => 'allowed',
        (error: { code?: string }) => error.code,
      );
    expect(await refuse('DELETE FROM vendors WHERE id = $1', [vendor.id])).toBe('23514');
    const otherParty = (await a.owner.post('/parties', newParty())).body.data;
    expect(
      await refuse('UPDATE vendors SET party_id = $1 WHERE id = $2', [otherParty.id, vendor.id]),
    ).toBe('23514');
    expect(
      await refuse(`DELETE FROM party_roles WHERE party_id = $1 AND role = 'vendor'`, [
        vendor.partyId,
      ]),
    ).toBe('23514');
    expect((await a.owner.get(`/vendors/${vendor.id}`)).body.data.roles).toEqual(['vendor']);
  });
});
