import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 3B steps 6–7: invoice drafts (Decisions 32–35, 46; D9, D10) and conditional approval
 * with a separate atomic Issue (D1; Decisions 13, 77; S10-06). Posting flows only through the
 * accounting event; the AR subledger equals the AR control account.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

interface SalesOrg extends AccountingOrg {
  gst: string;
  tgst: string;
  customerId: string;
}

async function salesOrg(options: { customer?: object } = {}): Promise<SalesOrg> {
  const org = await setUpAccountingOrg(ctx);
  const codes = (await org.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
  const gst = codes.find((c) => c.code === 'GST')!.id;
  const tgst = codes.find((c) => c.code === 'TGST')!.id;
  const settings = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: gst,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const customer = await org.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Sun Island Resort' },
    ...options.customer,
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  return { ...org, gst, tgst, customerId: customer.body.data.id };
}

const draft = (o: SalesOrg, overrides: object = {}) => ({
  customerId: o.customerId,
  invoiceDate: '2026-03-10',
  lines: [{ description: 'Consulting', quantity: '2', unitPrice: '250' }],
  ...overrides,
});

async function createInvoice(client: TestClient, body: object) {
  const res = await client.post('/sales/invoices', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function issue(client: TestClient, invoice: { id: string; version: number }) {
  return client.post(`/sales/invoices/${invoice.id}/issue`, { version: invoice.version });
}

async function issued(client: TestClient, body: object) {
  const inv = await createInvoice(client, body);
  const res = await issue(client, inv);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function withOwnerDb<T>(work: (db: Awaited<ReturnType<typeof connectAs>>) => Promise<T>) {
  const db = await connectAs('owner');
  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

/** The GL balance (base, debit − credit) of an account from posted journals. */
async function glBalance(organizationId: string, accountId: string) {
  return withOwnerDb(async (db) => {
    const { rows } = await db.query(
      `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
         FROM accounting_journal_lines l
         JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
        WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
      [organizationId, accountId],
    );
    return rows[0].b as string;
  });
}

async function subledger(organizationId: string) {
  return withOwnerDb(async (db) => {
    const { rows } = await db.query(
      `SELECT coalesce(sum(base_due), 0)::numeric(28,2)::text AS b FROM sales_invoices
        WHERE organization_id = $1 AND status = 'ISSUED'`,
      [organizationId],
    );
    return rows[0].b as string;
  });
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe('invoice drafts (Decisions 32–35, 46)', () => {
  it('computes discounts before tax, per-line tax and the defaults', async () => {
    const o = await salesOrg({ customer: { paymentTermsDays: 14 } });
    const item = await o.owner.post('/sales/items', {
      name: 'Island tour',
      itemType: 'service',
      unitPrice: '1000',
      taxCodeId: o.tgst,
    });
    const inv = await createInvoice(o.owner, {
      customerId: o.customerId,
      invoiceDate: '2026-03-10',
      discount: { type: 'amount', value: '100' },
      lines: [
        // 3 x 100 = 300, less 10% = 270; share of the 100 discount: 270/1270 -> 21.26; GST 8%.
        {
          description: 'Snorkel gear',
          quantity: '3',
          unitPrice: '100',
          discount: { type: 'percent', value: '10' },
        },
        // Item defaults: name, price 1000, TGST 17%; share 78.74.
        { itemId: item.body.data.id, quantity: '1' },
      ],
    });
    expect(inv).toMatchObject({
      status: 'DRAFT',
      number: null,
      currencyCode: 'MVR',
      dueDate: '2026-03-24', // the customer's 14-day terms
      subtotal: '1300.00',
      discountTotal: '130.00',
      version: 1,
    });
    const [a, b] = inv.lines;
    expect(a).toMatchObject({
      amount: '300.00',
      lineDiscount: '30.00',
      documentDiscount: '21.26',
      netAmount: '248.74',
      taxRate: '8',
      taxAmount: '19.90',
      total: '268.64',
    });
    expect(b).toMatchObject({
      description: 'Island tour',
      amount: '1000.00',
      documentDiscount: '78.74',
      netAmount: '921.26',
      taxRate: '17',
      taxAmount: '156.61',
      total: '1077.87',
    });
    expect(inv.taxTotal).toBe('176.51');
    expect(inv.total).toBe('1346.51');
  });

  it('extracts tax under Tax Inclusive and charges none under No Tax', async () => {
    const o = await salesOrg();
    const inclusive = await createInvoice(
      o.owner,
      draft(o, {
        taxTreatment: 'inclusive',
        lines: [{ description: 'Room', quantity: '1', unitPrice: '108' }],
      }),
    );
    expect(inclusive).toMatchObject({ subtotal: '108.00', taxTotal: '8.00', total: '108.00' });
    expect(inclusive.lines[0]).toMatchObject({ netAmount: '100.00', taxAmount: '8.00' });
    const none = await createInvoice(o.owner, draft(o, { taxTreatment: 'no_tax' }));
    expect(none).toMatchObject({ taxTotal: '0.00', total: '500.00' });
    expect(none.lines[0].taxCodeId).toBeNull();
  });

  it('validates references, dates, rates and discounts', async () => {
    const o = await salesOrg();
    const expectIssues = async (body: object, path: string) => {
      const res = await o.owner.post('/sales/invoices', body);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.details.issues.map((i: { path: string }) => i.path)).toContain(path);
    };
    await expectIssues(draft(o, { customerId: randomUUID() }), 'customerId');
    // Tourism GST has no version before 2023-01-01 (Decision 15).
    await expectIssues(
      draft(o, {
        invoiceDate: '2022-12-31',
        lines: [{ description: 'x', quantity: '1', unitPrice: '1', taxCodeId: o.tgst }],
      }),
      'lines.0.taxCodeId',
    );
    await expectIssues(
      draft(o, {
        lines: [
          {
            description: 'x',
            quantity: '1',
            unitPrice: '10',
            discount: { type: 'amount', value: '11' },
          },
        ],
      }),
      'lines.0.discount',
    );
    await expectIssues(draft(o, { discount: { type: 'percent', value: '101' } }), 'discount');
    await expectIssues(
      draft(o, {
        lines: [
          { description: 'x', quantity: '1', unitPrice: '1', revenueAccountId: o.accounts['1110'] },
        ],
      }),
      'lines.0.revenueAccountId',
    );
    await expectIssues(draft(o, { dueDate: '2026-03-01' }), 'dueDate');
    await expectIssues(draft(o, { lines: [{ quantity: '1' }] }), 'lines.0.description');
    // Foreign-currency lines need an explicit price (item prices are in the base currency).
    const item = await o.owner.post('/sales/items', {
      name: 'Tour',
      itemType: 'service',
      unitPrice: '10',
    });
    await expectIssues(
      draft(o, { currencyCode: 'USD', lines: [{ itemId: item.body.data.id, quantity: '1' }] }),
      'lines.0.unitPrice',
    );
    // Archived customers get no new invoices.
    await o.owner.post(`/customers/${o.customerId}/archive`, { version: 1 });
    await expectIssues(draft(o), 'customerId');
  });

  it('edits under version checks and deletes only drafts', async () => {
    const o = await salesOrg();
    const inv = await createInvoice(o.owner, draft(o));
    const edited = await o.owner.put(`/sales/invoices/${inv.id}`, {
      ...draft(o, { lines: [{ description: 'Consulting', quantity: '4', unitPrice: '250' }] }),
      version: 1,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data).toMatchObject({ version: 2, subtotal: '1000.00' });
    const stale = await o.owner.put(`/sales/invoices/${inv.id}`, { ...draft(o), version: 1 });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await o.owner.delete(`/sales/invoices/${inv.id}?version=1`)).body.error.code).toBe(
      'VERSION_CONFLICT',
    );
    expect((await o.owner.delete(`/sales/invoices/${inv.id}?version=2`)).status).toBe(200);
    expect((await o.owner.get(`/sales/invoices/${inv.id}`)).status).toBe(404);
  });

  it('replays a create with the same Idempotency-Key and refuses a different body', async () => {
    const o = await salesOrg();
    const key = randomUUID();
    const first = await o.owner.post('/sales/invoices', draft(o), { 'idempotency-key': key });
    const again = await o.owner.post('/sales/invoices', draft(o), { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data.id).toBe(first.body.data.id);
    const other = await o.owner.post('/sales/invoices', draft(o, { invoiceDate: '2026-03-11' }), {
      'idempotency-key': key,
    });
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const list = (await o.owner.get('/sales/invoices')).body.data.items;
    expect(list).toHaveLength(1);
  });

  it('warns about possible duplicates and the credit limit without blocking', async () => {
    const o = await salesOrg({ customer: { creditLimit: '600' } });
    await createInvoice(o.owner, draft(o));
    const second = await createInvoice(o.owner, draft(o));
    expect(second.warnings.map((w: { code: string }) => w.code)).toEqual(['POSSIBLE_DUPLICATE']);
    await issued(o.owner, draft(o, { invoiceDate: '2026-03-01' }));
    const third = await createInvoice(o.owner, draft(o, { invoiceDate: '2026-03-02' }));
    expect(third.warnings.map((w: { code: string }) => w.code)).toContain('CREDIT_LIMIT_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

describe('invoice issue (D1, D9, Decision 13)', () => {
  it('posts through the accounting event and keeps the subledger equal to the GL', async () => {
    const o = await salesOrg();
    const inv = await issued(
      o.owner,
      draft(o, {
        lines: [
          { description: 'Consulting', quantity: '2', unitPrice: '250' },
          { description: 'Excursion', quantity: '1', unitPrice: '100', taxCodeId: o.tgst },
        ],
      }),
    );
    expect(inv).toMatchObject({
      status: 'ISSUED',
      number: 'INV-00001',
      total: '657.00', // 500 + 8% + 100 + 17%
      amountDue: '657.00',
      exchangeRate: '1.0000000000',
      exchangeRateSource: 'base',
      baseTotal: '657.0000',
      baseDue: '657.0000',
    });
    const journal = (await o.owner.get(`/accounting/journals/${inv.journalId}`)).body.data;
    expect(journal).toMatchObject({
      status: 'POSTED',
      source: 'event',
      sourceModule: 'sales',
      sourceType: 'invoice',
      sourceId: inv.id,
      reference: 'INV-00001',
    });
    const byAccount = (id: string) =>
      journal.lines.filter((l: { accountId: string }) => l.accountId === id);
    expect(byAccount(o.accounts['1130']!)[0]).toMatchObject({ debit: '657.0000' });
    expect(byAccount(o.accounts['4100']!)[0]).toMatchObject({ credit: '600.0000' });
    expect(
      byAccount(o.accounts['2130']!)
        .map((l: { credit: string }) => l.credit)
        .sort(),
    ).toEqual(['17.0000', '40.0000']);
    expect(await glBalance(o.organizationId, o.accounts['1130']!)).toBe('657.00');
    expect(await subledger(o.organizationId)).toBe('657.00');
    const second = await issued(o.owner, draft(o, { invoiceDate: '2026-03-12' }));
    expect(second.number).toBe('INV-00002');
    expect(await glBalance(o.organizationId, o.accounts['1130']!)).toBe(
      await subledger(o.organizationId),
    );
    // The AR control account is now fixed (D12).
    expect((await o.owner.get('/sales/settings')).body.data.arLocked).toBe(true);
    await withOwnerDb(async (db) => {
      const { rows } = await db.query(
        `SELECT action FROM audit_events WHERE organization_id = $1 AND resource_id = $2 ORDER BY occurred_at, id`,
        [o.organizationId, inv.id],
      );
      expect(rows.map((r) => r.action)).toEqual(['invoice.created', 'invoice.issued']);
    });
  });

  it('makes issued invoices immutable in the API and the database (R35)', async () => {
    const o = await salesOrg();
    const inv = await issued(o.owner, draft(o));
    expect(
      (await o.owner.put(`/sales/invoices/${inv.id}`, { ...draft(o), version: inv.version })).body
        .error.code,
    ).toBe('INVALID_STATE_TRANSITION');
    expect(
      (await o.owner.delete(`/sales/invoices/${inv.id}?version=${inv.version}`)).body.error.code,
    ).toBe('INVALID_STATE_TRANSITION');
    expect((await issue(o.owner, inv)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    const app = await connectAs('app');
    try {
      const inTenant = async (statement: string) => {
        await app.query('BEGIN');
        try {
          await app.query(`SELECT set_config('app.organization_id', $1, true)`, [o.organizationId]);
          return await app.query(statement);
        } finally {
          await app.query('ROLLBACK');
        }
      };
      for (const statement of [
        `UPDATE sales_invoices SET total = 1 WHERE id = '${inv.id}'`,
        `UPDATE sales_invoices SET status = 'DRAFT' WHERE id = '${inv.id}'`,
        `DELETE FROM sales_invoices WHERE id = '${inv.id}'`,
        `UPDATE sales_invoice_lines SET unit_price = 1 WHERE invoice_id = '${inv.id}'`,
        `DELETE FROM sales_invoice_lines WHERE invoice_id = '${inv.id}'`,
      ]) {
        await expect(inTenant(statement), statement).rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      await app.end();
    }
  });

  it('uses the table rate on the invoice date for foreign currency, and needs one', async () => {
    const o = await salesOrg({ customer: { currencyCode: 'USD' } });
    const inv = await createInvoice(
      o.owner,
      draft(o, {
        lines: [{ description: 'Charter', quantity: '1', unitPrice: '1000', taxCodeId: null }],
      }),
    );
    const missing = await issue(o.owner, inv);
    expect(missing.body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
    const after = (await o.owner.get(`/sales/invoices/${inv.id}`)).body.data;
    expect(after).toMatchObject({ status: 'DRAFT', number: null });
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-01',
      rate: '15.42',
    });
    const res = await issue(o.owner, after);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The failed attempt used no number (it rolled back).
    expect(res.body.data).toMatchObject({
      number: 'INV-00001',
      currencyCode: 'USD',
      total: '1000.00',
      exchangeRate: '15.4200000000',
      exchangeRateSource: 'table',
      baseTotal: '15420.0000',
    });
    const journal = (await o.owner.get(`/accounting/journals/${res.body.data.journalId}`)).body
      .data;
    expect(journal).toMatchObject({ currency: 'USD', exchangeRateSource: 'table' });
    expect(await glBalance(o.organizationId, o.accounts['1130']!)).toBe('15420.00');
    expect(await subledger(o.organizationId)).toBe('15420.00');
  });

  it('needs the AR account, an open period and the required dimensions', async () => {
    const org = await setUpAccountingOrg(ctx);
    const customer = await org.owner.post('/customers', {
      party: { kind: 'organization', displayName: 'No Settings Co' },
    });
    const noSettings = await createInvoice(org.owner, {
      customerId: customer.body.data.id,
      invoiceDate: '2026-03-10',
      lines: [{ description: 'x', quantity: '1', unitPrice: '10' }],
    });
    const blocked = await issue(org.owner, noSettings);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.details.issues.map((i: { path: string }) => i.path)).toContain(
      'arAccountId',
    );

    const o = await salesOrg();
    const march = o.periods.find((p) => p.startDate === '2026-03-01')!;
    await o.owner.post(`/accounting/periods/${march.id}/close`);
    const closed = await issue(o.owner, await createInvoice(o.owner, draft(o)));
    expect(closed.body.error.code).toBe('PERIOD_CLOSED');

    const type = await o.owner.post('/accounting/dimensions', {
      code: 'DEPT',
      name: 'Department',
      isRequired: true,
      scope: { accountTypes: ['REVENUE'], accountSubtypes: [] },
    });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const value = await o.owner.post(`/accounting/dimensions/${type.body.data.id}/values`, {
      code: 'OPS',
      name: 'Operations',
    });
    const april = draft(o, { invoiceDate: '2026-04-02' });
    const missing = await issue(o.owner, await createInvoice(o.owner, april));
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toBe('Required dimensions are missing.');
    // Document-level values fill the revenue lines (D10).
    const tagged = await issued(o.owner, { ...april, dimensionValueIds: [value.body.data.id] });
    const journal = (await o.owner.get(`/accounting/journals/${tagged.journalId}`)).body.data;
    for (const line of journal.lines) {
      expect(line.dimensions.map((d: { dimensionValueId: string }) => d.dimensionValueId)).toEqual([
        value.body.data.id,
      ]);
    }
  });

  it('replays an issue with the same Idempotency-Key and gives concurrent issues distinct numbers', async () => {
    const o = await salesOrg();
    const inv = await createInvoice(o.owner, draft(o));
    const key = randomUUID();
    const first = await o.owner.post(
      `/sales/invoices/${inv.id}/issue`,
      { version: 1 },
      { 'idempotency-key': key },
    );
    const again = await o.owner.post(
      `/sales/invoices/${inv.id}/issue`,
      { version: 1 },
      { 'idempotency-key': key },
    );
    expect(first.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data.number).toBe(first.body.data.number);

    const drafts = await Promise.all(
      [1, 2, 3, 4].map((d) => createInvoice(o.owner, draft(o, { invoiceDate: `2026-03-1${d}` }))),
    );
    const results = await Promise.all(drafts.map((d) => issue(o.owner, d)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.data.number)).size).toBe(4);
    // The same invoice issued twice at once: exactly one wins.
    const one = await createInvoice(o.owner, draft(o, { invoiceDate: '2026-03-20' }));
    const race = await Promise.all([issue(o.owner, one), issue(o.owner, one)]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await glBalance(o.organizationId, o.accounts['1130']!)).toBe(
      await subledger(o.organizationId),
    );
  });

  it('needs invoices.* permissions for each step', async () => {
    const o = await salesOrg();
    const member = await joinWithRole(ctx, o.owner, 'Member');
    const inv = await createInvoice(o.owner, draft(o));
    expect((await member.client.get(`/sales/invoices/${inv.id}`)).status).toBe(200);
    expect((await member.client.post('/sales/invoices', draft(o))).status).toBe(403);
    expect((await issue(member.client, inv)).status).toBe(403);
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Invoice clerk',
      permissionKeys: ['invoices.view', 'invoices.create', 'customers.view'],
    });
    expect(role.status).toBe(201);
    const clerk = await joinWithRole(ctx, o.owner, 'Invoice clerk');
    const mine = await createInvoice(clerk.client, draft(o));
    expect(
      (await clerk.client.put(`/sales/invoices/${mine.id}`, { ...draft(o), version: 1 })).status,
    ).toBe(403);
    expect((await clerk.client.delete(`/sales/invoices/${mine.id}?version=1`)).status).toBe(403);
    expect((await issue(clerk.client, mine)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Approval (D1)
// ---------------------------------------------------------------------------

describe('invoice approval then separate issue (D1, Decision 77)', () => {
  async function withPolicy(threshold: string) {
    const o = await salesOrg();
    const roles = (await o.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    const adminRole = roles.find((r) => r.name === 'Administrator')!.id;
    const policy = await o.owner.put('/approvals/policies/sales.invoice.issue', {
      steps: [
        {
          name: 'Sales manager',
          requiredApprovals: 1,
          roleIds: [adminRole],
          membershipIds: [],
          conditions: { minBaseAmount: threshold },
        },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const admin = await joinWithRole(ctx, o.owner, 'Administrator');
    return { o, admin: admin.client };
  }

  it('issues below the threshold directly and needs approval, then Issue, above it', async () => {
    const { o, admin } = await withPolicy('1000');
    const small = await createInvoice(o.owner, draft(o)); // 540
    expect(small.approval).toMatchObject({ required: false, readyToIssue: true });
    expect((await issue(o.owner, small)).status).toBe(200);

    const big = await createInvoice(
      o.owner,
      draft(o, {
        lines: [{ description: 'Consulting', quantity: '4', unitPrice: '250' }], // 1080
      }),
    );
    expect(big.approval).toMatchObject({
      required: true,
      readyToIssue: false,
      facts: { transactionType: 'standard', baseAmount: '1080.00', baseCurrency: 'MVR' },
    });
    expect((await issue(o.owner, big)).body.error.code).toBe('APPROVAL_REQUIRED');
    const submitted = await o.owner.post(`/sales/invoices/${big.id}/submit`, {
      version: big.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.status).toBe('PENDING_APPROVAL');
    const requestId = submitted.body.data.approval.requestId;
    // Drafts awaiting approval cannot be edited; the preparer cannot approve.
    expect(
      (
        await o.owner.put(`/sales/invoices/${big.id}`, {
          ...draft(o),
          version: submitted.body.data.version,
        })
      ).status,
    ).toBe(409);
    expect(
      (await o.owner.post(`/approvals/requests/${requestId}/approve`, {})).body.error.code,
    ).toBe('SELF_APPROVAL_PROHIBITED');
    const approved = await admin.post(`/approvals/requests/${requestId}/approve`, {});
    expect(approved.body.data.requestStatus).toBe('approved');
    // Approval authorizes only: nothing is issued or posted until Issue (D1).
    const waiting = (await o.owner.get(`/sales/invoices/${big.id}`)).body.data;
    expect(waiting).toMatchObject({ status: 'PENDING_APPROVAL', number: null, journalId: null });
    expect(waiting.approval.readyToIssue).toBe(true);
    const done = await issue(o.owner, waiting);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'ISSUED', number: 'INV-00002' });
  });

  it('returns a rejected invoice to draft, and withdraws a pending one', async () => {
    const { o, admin } = await withPolicy('100');
    const inv = await createInvoice(o.owner, draft(o));
    const pending = (await o.owner.post(`/sales/invoices/${inv.id}/submit`, { version: 1 })).body
      .data;
    const rejected = await admin.post(`/approvals/requests/${pending.approval.requestId}/reject`, {
      comment: 'Wrong customer',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const back = (await o.owner.get(`/sales/invoices/${inv.id}`)).body.data;
    expect(back).toMatchObject({ status: 'DRAFT' });
    expect(back.approval.requestId).toBeNull();
    const again = (
      await o.owner.post(`/sales/invoices/${inv.id}/submit`, { version: back.version })
    ).body.data;
    const withdrawn = await o.owner.post(`/sales/invoices/${inv.id}/withdraw`, {
      version: again.version,
    });
    expect(withdrawn.body.data.status).toBe('DRAFT');
  });

  it('refuses to submit when no step applies', async () => {
    const { o } = await withPolicy('100000');
    const inv = await createInvoice(o.owner, draft(o));
    const res = await o.owner.post(`/sales/invoices/${inv.id}/submit`, { version: 1 });
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});
