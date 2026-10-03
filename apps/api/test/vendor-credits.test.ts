import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, line, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/**
 * Phase 4B-1: vendor credits and debit notes (ADR 0004 P4-23, P4-24, P4-37, P4-39, P4-42, P4-51;
 * decided 2026-10-03). One document, two origins, both reducing AP (the reverse of a bill);
 * conditional approval separate from Post (re-authenticated); VC- and DN- numbering; rates (bill,
 * table, manual); input tax; void while unapplied through the Purchases reversal.
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

interface Org extends AccountingOrg {
  gst: string;
  vendorId: string;
}

async function purchasesOrg(options: { vendor?: Record<string, unknown> } = {}): Promise<Org> {
  const org = await setUpAccountingOrg(ctx);
  const codes = (await org.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
  const profile = await org.owner.put('/organizations/current/profile', {
    version: 0,
    legalName: 'Atoll Trading Pvt Ltd',
    gstRegistered: true,
    gstRegisteredFrom: '2026-01-01',
    gstRegistrationNumber: '1000234GST501',
  });
  expect(profile.status, JSON.stringify(profile.body)).toBe(200);
  const settings = await org.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: org.accounts['2110'],
    defaultExpenseAccountId: org.accounts['5400'],
    defaultPaymentAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const vendor = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Supplies', email: 'ap@island.test' },
    ...options.vendor,
  });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  return {
    ...org,
    gst: codes.find((c) => c.code === 'GST')!.id,
    vendorId: vendor.body.data.id,
  };
}

const credit = (
  o: Org,
  origin: 'supplier_credit_note' | 'debit_note',
  overrides: Record<string, unknown> = {},
) => ({
  origin,
  vendorId: o.vendorId,
  creditDate: '2026-03-12',
  ...(origin === 'supplier_credit_note'
    ? { vendorReference: `CN-${randomUUID().slice(0, 8)}` }
    : {}),
  lines: [{ description: 'Returned goods', quantity: '1', unitPrice: '40', taxCodeId: null }],
  ...overrides,
});

async function create(client: TestClient, body: object) {
  const res = await client.post('/purchases/vendor-credits', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function post(client: TestClient, doc: { id: string; version: number }) {
  return client.post(`/purchases/vendor-credits/${doc.id}/post`, { version: doc.version });
}

async function posted(client: TestClient, body: object) {
  const doc = await create(client, body);
  const res = await post(client, doc);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function postedBill(o: Org, overrides: Record<string, unknown> = {}) {
  const bill = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: '2026-03-10',
    vendorReference: `INV-${randomUUID().slice(0, 8)}`,
    lines: [{ description: 'Stock', quantity: '1', unitPrice: '100', taxCodeId: null }],
    ...overrides,
  });
  expect(bill.status, JSON.stringify(bill.body)).toBe(201);
  const res = await o.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
    version: bill.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function journalLines(o: AccountingOrg, journalId: string) {
  return (await o.owner.get(`/accounting/journals/${journalId}`)).body.data.lines as {
    accountId: string;
    debit: string | null;
    credit: string | null;
    baseDebit: string | null;
    baseCredit: string | null;
    dimensions: { dimensionValueId: string }[];
  }[];
}

/** AP control (credit balance, base) vs the AP subledger: open bills less unapplied credits. */
async function apReconciliation(o: AccountingOrg) {
  const { rows } = await owner.query(
    `SELECT
       (SELECT coalesce(sum(coalesce(l.base_credit,0) - coalesce(l.base_debit,0)), 0)::numeric(28,2)::text
          FROM accounting_journal_lines l JOIN accounting_journal_entries j ON j.id = l.journal_id
          JOIN accounting_accounts a ON a.id = l.account_id
         WHERE a.organization_id = $1 AND a.control_subledger = 'purchases'
           AND j.status IN ('POSTED','REVERSED')) AS gl,
       ((SELECT coalesce(sum(base_due), 0) FROM purchases_bills WHERE organization_id = $1 AND status = 'POSTED')
        - (SELECT coalesce(sum(base_unapplied), 0) FROM purchases_vendor_credits
            WHERE organization_id = $1 AND status = 'POSTED'))::numeric(28,2)::text AS subledger`,
    [o.organizationId],
  );
  return rows[0] as { gl: string; subledger: string };
}

async function auditActions(o: AccountingOrg, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action, metadata FROM audit_events WHERE organization_id = $1 AND resource_id = $2
      ORDER BY occurred_at, id`,
    [o.organizationId, resourceId],
  );
  return rows as { action: string; metadata: Record<string, unknown> }[];
}

async function createRole(client: TestClient, name: string, permissionKeys: string[]) {
  const res = await client.post('/organizations/current/roles', { name, permissionKeys });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe('vendor credit drafts (P4-23)', () => {
  it('creates supplier credit notes and debit notes as one document with an origin', async () => {
    const o = await purchasesOrg();
    const supplier = await create(
      o.owner,
      credit(o, 'supplier_credit_note', {
        vendorReference: '  CN 2026/07  ',
        lines: [{ description: 'Damaged goods', quantity: '2', unitPrice: '50', taxCodeId: o.gst }],
      }),
    );
    expect(supplier).toMatchObject({
      origin: 'supplier_credit_note',
      status: 'DRAFT',
      number: null,
      vendorName: 'Island Supplies',
      vendorReference: 'CN 2026/07',
      currencyCode: 'MVR',
      subtotal: '100.00',
      taxTotal: '8.00',
      recoverableTaxTotal: '8.00',
      total: '108.00',
      version: 1,
    });
    expect(supplier.lines[0]).toMatchObject({
      accountId: o.accounts['5400'],
      taxRecoverable: true,
      recoverableTax: '8.00',
    });
    const debit = await create(o.owner, credit(o, 'debit_note'));
    expect(debit).toMatchObject({ origin: 'debit_note', vendorReference: null, total: '40.00' });
    expect((await auditActions(o, debit.id)).map((a) => a.action)).toEqual([
      'vendor_credit.created',
    ]);
  });

  it('validates the origin rules, the bill link and the strict schema', async () => {
    const o = await purchasesOrg();
    const withRef = await o.owner.post(
      '/purchases/vendor-credits',
      credit(o, 'debit_note', { vendorReference: 'X-1' }),
    );
    expect(withRef.body.error.details.issues[0]).toEqual({
      path: 'vendorReference',
      message: 'Debit notes carry our own number; they have no supplier reference.',
    });
    // Supplier reference optional on drafts, required to post.
    const noRef = await create(
      o.owner,
      credit(o, 'supplier_credit_note', { vendorReference: null }),
    );
    const blocked = await post(o.owner, noRef);
    expect(blocked.body.error.details.issues).toContainEqual({
      path: 'vendorReference',
      message: "Enter the supplier's credit-note number before posting.",
    });
    // The bill link: posted, same vendor.
    const draftBill = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorId,
      billDate: '2026-03-10',
      lines: [{ description: 'x', quantity: '1', unitPrice: '10' }],
    });
    const unposted = await o.owner.post(
      '/purchases/vendor-credits',
      credit(o, 'debit_note', { billId: draftBill.body.data.id }),
    );
    expect(unposted.body.error.details.issues[0]).toEqual({
      path: 'billId',
      message: 'Only a posted bill can be credited.',
    });
    const other = await o.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Other Supplier' },
    });
    const bill = await postedBill(o);
    const wrongVendor = await o.owner.post(
      '/purchases/vendor-credits',
      credit(o, 'debit_note', { vendorId: other.body.data.id, billId: bill.id }),
    );
    expect(wrongVendor.body.error.details.issues[0].message).toBe(
      'The bill is from another vendor.',
    );
    const unknownOrigin = await o.owner.post('/purchases/vendor-credits', {
      ...credit(o, 'debit_note'),
      origin: 'refund',
    });
    expect(unknownOrigin.status).toBe(400);
    const extra = await o.owner.post('/purchases/vendor-credits', {
      ...credit(o, 'debit_note'),
      appliedTo: bill.id,
    });
    expect(extra.status).toBe(400);
  });

  it('edits drafts under versions, keeps the origin, and deletes drafts only', async () => {
    const o = await purchasesOrg();
    const doc = await create(o.owner, credit(o, 'supplier_credit_note'));
    const { origin: _origin, ...body } = credit(o, 'supplier_credit_note', { memo: 'Edited' });
    const updated = await o.owner.put(`/purchases/vendor-credits/${doc.id}`, {
      ...body,
      version: doc.version,
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data).toMatchObject({
      memo: 'Edited',
      version: 2,
      origin: 'supplier_credit_note',
    });
    const stale = await o.owner.put(`/purchases/vendor-credits/${doc.id}`, {
      ...body,
      version: doc.version,
    });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    // The origin cannot be changed (not in the update schema).
    const originChange = await o.owner.put(`/purchases/vendor-credits/${doc.id}`, {
      ...body,
      origin: 'debit_note',
      version: 2,
    });
    expect(originChange.status).toBe(400);
    expect((await o.owner.delete(`/purchases/vendor-credits/${doc.id}?version=2`)).status).toBe(
      200,
    );
    expect((await o.owner.get(`/purchases/vendor-credits/${doc.id}`)).status).toBe(404);
    const done = await posted(o.owner, credit(o, 'debit_note'));
    const refused = await o.owner.delete(
      `/purchases/vendor-credits/${done.id}?version=${done.version}`,
    );
    expect(refused.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// Posting and accounting
// ---------------------------------------------------------------------------

describe('posting vendor credits', () => {
  it('posts the reverse of a bill: Dr AP / Cr lines / Cr input tax, with VC- and DN- numbers', async () => {
    const o = await purchasesOrg({ vendor: { defaultTaxRecoverable: false } });
    await postedBill(o, {
      lines: [{ description: 'Stock', quantity: '1', unitPrice: '500', taxCodeId: null }],
    });
    const supplier = await posted(
      o.owner,
      credit(o, 'supplier_credit_note', {
        lines: [
          {
            description: 'Recoverable return',
            quantity: '1',
            unitPrice: '100',
            taxCodeId: o.gst,
            taxRecoverable: true,
          },
          // Vendor default: not recoverable, so the tax is part of the line amount.
          { description: 'Fuel return', quantity: '1', unitPrice: '50', taxCodeId: o.gst },
        ],
      }),
    );
    expect(supplier).toMatchObject({
      status: 'POSTED',
      number: 'VC-00001',
      total: '162.00',
      recoverableTaxTotal: '8.00',
      amountUnapplied: '162.00',
      baseTotal: '162.0000',
      exchangeRateSource: 'base',
    });
    const lines = await journalLines(o, supplier.journalId);
    const by = (id: string) => lines.filter((l) => l.accountId === id);
    expect(by(o.accounts['2110']!).map((l) => [l.debit, l.credit])).toEqual([['162.0000', null]]);
    expect(by(o.accounts['5400']!).map((l) => l.credit)).toEqual(['154.0000']);
    expect(by(o.accounts['1160']!).map((l) => l.credit)).toEqual(['8.0000']);
    expect(by(o.accounts['2130']!)).toEqual([]);
    const debit = await posted(o.owner, credit(o, 'debit_note'));
    expect(debit.number).toBe('DN-00001');
    // AP control = open bills less unapplied credits.
    expect(await apReconciliation(o)).toEqual({ gl: '298.00', subledger: '298.00' });
    const { rows } = await owner.query(
      `SELECT j.source_module, j.source_type, j.source_id, e.event_type
         FROM accounting_journal_entries j JOIN accounting_events e ON e.id = j.accounting_event_id
        WHERE j.id = $1`,
      [supplier.journalId],
    );
    expect(rows[0]).toEqual({
      source_module: 'purchases',
      source_type: 'vendor_credit',
      source_id: supplier.id,
      event_type: 'purchases.vendor_credit_posted',
    });
    expect((await auditActions(o, supplier.id)).map((a) => a.action)).toContain(
      'vendor_credit.posted',
    );
    // Posted documents and their lines are immutable at the database.
    await expect(
      owner.query(`UPDATE purchases_vendor_credits SET memo = 'x' WHERE id = $1`, [supplier.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(
        `UPDATE purchases_vendor_credit_lines SET description = 'x' WHERE vendor_credit_id = $1`,
        [supplier.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // Manual journals to AP stay refused; the credit's journal is reversed only through Purchases.
    const reverse = await o.owner.post(`/accounting/journals/${supplier.journalId}/reverse`, {
      reason: 'Trying a manual reversal',
    });
    expect(reverse.status).toBe(409);
  });

  it('needs a recent password to post (P4-42) and is retry-safe', async () => {
    const o = await purchasesOrg();
    const doc = await create(o.owner, credit(o, 'debit_note'));
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await post(o.owner, doc);
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const key = randomUUID();
    const first = await o.owner.post(
      `/purchases/vendor-credits/${doc.id}/post`,
      { version: doc.version },
      { 'idempotency-key': key },
    );
    const second = await o.owner.post(
      `/purchases/vendor-credits/${doc.id}/post`,
      { version: doc.version },
      { 'idempotency-key': key },
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.body.data.journalId).toBe(first.body.data.journalId);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_events WHERE event_key = $1`,
      [`vendor_credit:${doc.id}:posted`],
    );
    expect(rows[0].n).toBe(1);
    expect((await post(o.owner, doc)).status).toBe(409);
  });

  it('follows the linked bill rate, or the table rate, or a manual rate with a reason', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-01',
      rate: '15.42',
    });
    const bill = await postedBill(o, {
      rateOverride: '15.60',
      rateOverrideReason: 'Bank rate on the invoice',
      lines: [{ description: 'Engine', quantity: '1', unitPrice: '1000' }],
    });
    expect(bill.exchangeRate).toBe('15.6000000000');
    const linked = await posted(
      o.owner,
      credit(o, 'supplier_credit_note', {
        billId: bill.id,
        lines: [{ description: 'Engine part returned', quantity: '1', unitPrice: '100' }],
      }),
    );
    expect(linked).toMatchObject({
      currencyCode: 'USD',
      billId: bill.id,
      billNumber: bill.number,
      exchangeRate: '15.6000000000',
      exchangeRateSource: 'bill',
      tableRate: '15.4200000000',
      baseTotal: '1560.0000',
    });
    // A linked credit cannot override the bill's rate.
    const override = await o.owner.post(
      '/purchases/vendor-credits',
      credit(o, 'debit_note', {
        billId: bill.id,
        rateOverride: '16',
        rateOverrideReason: 'x',
      }),
    );
    expect(override.body.error.details.issues[0].message).toBe(
      "A credit for a bill uses the bill's exchange rate.",
    );
    const table = await posted(o.owner, credit(o, 'debit_note'));
    expect(table).toMatchObject({ exchangeRateSource: 'table', baseTotal: '616.8000' });
    const manual = await posted(
      o.owner,
      credit(o, 'debit_note', { rateOverride: '15.50', rateOverrideReason: 'Agreed rate' }),
    );
    expect(manual).toMatchObject({
      exchangeRateSource: 'manual',
      exchangeRate: '15.5000000000',
      tableRate: '15.4200000000',
      baseTotal: '620.0000',
    });
    expect(
      (await auditActions(o, manual.id)).find((a) => a.action === 'vendor_credit.rate_overridden')
        ?.metadata,
    ).toMatchObject({ reason: 'Agreed rate', tableRate: '15.4200000000' });
    // Base balanced and reconciled: 15,600 bill less 1,560 + 616.80 + 620 credits.
    const lines = await journalLines(o, manual.journalId);
    const base = lines.reduce(
      (s, l) => s + Number(l.baseDebit ?? 0) - Number(l.baseCredit ?? 0),
      0,
    );
    expect(base).toBe(0);
    expect(await apReconciliation(o)).toEqual({ gl: '12803.20', subledger: '12803.20' });
  });

  it('enforces required dimensions at submit and post and keeps them on the journal', async () => {
    const o = await purchasesOrg();
    const type = await o.owner.post('/accounting/dimensions', {
      code: 'DEPT',
      name: 'Department',
      isRequired: true,
      scope: { accountTypes: ['EXPENSE'], accountSubtypes: [] },
    });
    const value = await o.owner.post(`/accounting/dimensions/${type.body.data.id}/values`, {
      code: 'OPS',
      name: 'Operations',
    });
    const missing = await post(o.owner, await create(o.owner, credit(o, 'debit_note')));
    expect(missing.body.error.details.issues).toEqual([
      { path: 'lines', message: 'Department is required for expense lines.' },
    ]);
    const tagged = await posted(
      o.owner,
      credit(o, 'debit_note', { dimensionValueIds: [value.body.data.id] }),
    );
    const expense = (await journalLines(o, tagged.journalId)).find(
      (l) => l.accountId === o.accounts['5400'],
    )!;
    expect(expense.dimensions.map((d) => d.dimensionValueId)).toEqual([value.body.data.id]);
  });
});

// ---------------------------------------------------------------------------
// Approval (P4-37)
// ---------------------------------------------------------------------------

describe('vendor credit approval', () => {
  it('requires approval above the threshold, forbids self-approval, needs a reject reason', async () => {
    const o = await purchasesOrg();
    const roles = (await o.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    const policy = await o.owner.put('/approvals/policies/purchases.vendor_credit.post', {
      steps: [
        {
          name: 'AP supervisor',
          requiredApprovals: 1,
          roleIds: [roles.find((r) => r.name === 'Administrator')!.id],
          membershipIds: [],
          conditions: { minBaseAmount: '100', transactionTypes: ['debit_note'] },
        },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const admin = (await joinWithRole(ctx, o.owner, 'Administrator')).client;
    // Below the threshold, or another transaction type: post directly.
    expect((await posted(o.owner, credit(o, 'debit_note'))).status).toBe('POSTED');
    const big = { lines: [{ description: 'Overcharge', quantity: '1', unitPrice: '500' }] };
    expect((await posted(o.owner, credit(o, 'supplier_credit_note', big))).status).toBe('POSTED');
    const doc = await create(o.owner, credit(o, 'debit_note', big));
    expect((await post(o.owner, doc)).body.error.code).toBe('APPROVAL_REQUIRED');
    const submitted = (
      await o.owner.post(`/purchases/vendor-credits/${doc.id}/submit`, { version: doc.version })
    ).body.data;
    expect(submitted.status).toBe('PENDING_APPROVAL');
    expect(submitted.approval.facts).toMatchObject({
      transactionType: 'debit_note',
      baseAmount: '500.00',
    });
    const requestId = submitted.approval.requestId;
    expect(
      (await o.owner.post(`/approvals/requests/${requestId}/approve`, {})).body.error.code,
    ).toBe('SELF_APPROVAL_PROHIBITED');
    const noReason = await admin.post(`/approvals/requests/${requestId}/reject`, {});
    expect(noReason.status).toBe(400);
    const rejected = await admin.post(`/approvals/requests/${requestId}/reject`, {
      comment: 'Wrong amount',
    });
    expect(rejected.status).toBe(200);
    const back = (await o.owner.get(`/purchases/vendor-credits/${doc.id}`)).body.data;
    expect(back.status).toBe('DRAFT');
    const again = (
      await o.owner.post(`/purchases/vendor-credits/${doc.id}/submit`, { version: back.version })
    ).body.data;
    const withdrawn = await o.owner.post(`/purchases/vendor-credits/${doc.id}/withdraw`, {
      version: again.version,
    });
    expect(withdrawn.body.data.status).toBe('DRAFT');
    const third = (
      await o.owner.post(`/purchases/vendor-credits/${doc.id}/submit`, {
        version: withdrawn.body.data.version,
      })
    ).body.data;
    expect(
      (await admin.post(`/approvals/requests/${third.approval.requestId}/approve`, {})).status,
    ).toBe(200);
    const ready = (await o.owner.get(`/purchases/vendor-credits/${doc.id}`)).body.data;
    expect(ready).toMatchObject({ status: 'PENDING_APPROVAL', number: null });
    const done = await post(o.owner, ready);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await auditActions(o, doc.id)).map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'vendor_credit.submitted',
        'vendor_credit.rejected',
        'vendor_credit.withdrawn',
        'vendor_credit.approved',
        'vendor_credit.posted',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Void (P4-24)
// ---------------------------------------------------------------------------

describe('voiding vendor credits', () => {
  it('reverses an unapplied credit through Purchases with re-authentication', async () => {
    const o = await purchasesOrg();
    await postedBill(o);
    const doc = await posted(o.owner, credit(o, 'supplier_credit_note'));
    expect(await apReconciliation(o)).toEqual({ gl: '60.00', subledger: '60.00' });
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await o.owner.post(`/purchases/vendor-credits/${doc.id}/void`, {
      version: doc.version,
      reason: 'Entered twice',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const voided = await o.owner.post(`/purchases/vendor-credits/${doc.id}/void`, {
      version: doc.version,
      reason: 'Entered twice',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'VOID', amountUnapplied: '0.00' });
    const original = (await o.owner.get(`/accounting/journals/${doc.journalId}`)).body.data;
    expect(original.status).toBe('REVERSED');
    expect(await apReconciliation(o)).toEqual({ gl: '100.00', subledger: '100.00' });
    const again = await o.owner.post(`/purchases/vendor-credits/${doc.id}/void`, {
      version: voided.body.data.version,
      reason: 'Again',
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('refuses closed periods and partly applied credits (API and database)', async () => {
    const o = await purchasesOrg();
    const march = await posted(o.owner, credit(o, 'debit_note'));
    const applied = await posted(o.owner, credit(o, 'debit_note'));
    // Simulate a later application (the settlement stage reduces the unapplied balance this way).
    await owner.query(
      `UPDATE purchases_vendor_credits
          SET amount_unapplied = total - 10, base_unapplied = base_total - 10 WHERE id = $1`,
      [applied.id],
    );
    const fresh = (await o.owner.get(`/purchases/vendor-credits/${applied.id}`)).body.data;
    const refused = await o.owner.post(`/purchases/vendor-credits/${applied.id}/void`, {
      version: fresh.version,
      reason: 'Applied already',
    });
    expect(refused.body.error.code).toBe('INVALID_STATE_TRANSITION');
    await expect(
      owner.query(
        `UPDATE purchases_vendor_credits SET status = 'VOID', voided_at = now(), void_reason = 'x',
                void_journal_id = journal_id, amount_unapplied = 0, base_unapplied = 0 WHERE id = $1`,
        [applied.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const period = o.periods.find((p) => p.startDate === '2026-03-01')!;
    expect((await o.owner.post(`/accounting/periods/${period.id}/close`)).status).toBe(200);
    const closed = await o.owner.post(`/purchases/vendor-credits/${march.id}/void`, {
      version: march.version,
      reason: 'Too late',
    });
    expect(closed.body.error.code).toBe('PERIOD_CLOSED');
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('vendor credit security', () => {
  it('follows the vendor-credit permission catalog', async () => {
    const o = await purchasesOrg();
    const member = await joinWithRole(ctx, o.owner, 'Member');
    const doc = await create(o.owner, credit(o, 'debit_note'));
    expect((await member.client.get('/purchases/vendor-credits')).status).toBe(200);
    expect((await member.client.get(`/purchases/vendor-credits/${doc.id}`)).status).toBe(200);
    expect(
      (await member.client.post('/purchases/vendor-credits', credit(o, 'debit_note'))).status,
    ).toBe(403);
    expect((await post(member.client, doc)).status).toBe(403);
    await createRole(o.owner, 'Credit clerk', [
      'vendor_credits.view',
      'vendor_credits.create',
      'vendors.view',
    ]);
    const clerk = await joinWithRole(ctx, o.owner, 'Credit clerk');
    const own = await create(clerk.client, credit(o, 'debit_note'));
    expect((await post(clerk.client, own)).status).toBe(403);
    // A manual rate needs vendor_credits.post.
    const usd = await o.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'USD Supplier' },
      currencyCode: 'USD',
    });
    const manual = await clerk.client.post(
      '/purchases/vendor-credits',
      credit(o, 'debit_note', {
        vendorId: usd.body.data.id,
        rateOverride: '15.5',
        rateOverrideReason: 'Agreed',
      }),
    );
    expect(manual.status).toBe(403);
    expect((await o.owner.delete(`/purchases/vendor-credits/${own.id}?version=1`)).status).toBe(
      200,
    );
  });

  it('keeps vendor credits tenant-isolated (API and RLS)', async () => {
    const a = await purchasesOrg();
    const b = await purchasesOrg();
    const doc = await create(a.owner, credit(a, 'debit_note'));
    expect((await b.owner.get(`/purchases/vendor-credits/${doc.id}`)).status).toBe(404);
    expect((await post(b.owner, doc)).status).toBe(404);
    const foreignVendor = await b.owner.post(
      '/purchases/vendor-credits',
      credit(b, 'debit_note', { vendorId: a.vendorId }),
    );
    expect(foreignVendor.body.error.details.issues[0]).toEqual({
      path: 'vendorId',
      message: 'Vendor not found.',
    });
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      for (const table of [
        'purchases_vendor_credits',
        'purchases_vendor_credit_lines',
        'purchases_document_emails',
      ]) {
        expect((await app.query(`SELECT id FROM ${table}`)).rows).toEqual([]);
      }
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
  });

  it('gives Administrators every vendor-credit key and Members the view key', async () => {
    const o = await setUpAccountingOrg(ctx);
    const { rows } = await owner.query(
      `SELECT r.name, array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
         FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.organization_id = $1 AND rp.permission_key LIKE 'vendor_credits.%'
        GROUP BY r.name ORDER BY r.name`,
      [o.organizationId],
    );
    const all = [
      'vendor_credits.approve',
      'vendor_credits.create',
      'vendor_credits.post',
      'vendor_credits.view',
      'vendor_credits.void',
    ];
    expect(rows).toEqual([
      { name: 'Administrator', keys: all },
      { name: 'Member', keys: ['vendor_credits.view'] },
      { name: 'Owner', keys: all },
    ]);
  });

  it('keeps manual journals away from AP after credits post', async () => {
    const o = await purchasesOrg();
    await posted(o.owner, credit(o, 'debit_note'));
    const manual = await o.owner.post('/accounting/journals', {
      entryDate: '2026-03-15',
      description: 'Manual AP',
      currency: 'MVR',
      lines: [
        line(o.accounts['2110']!, 'debit', '10.00'),
        line(o.accounts['5400']!, 'credit', '10.00'),
      ],
    });
    expect(manual.status).toBe(400);
  });
});
