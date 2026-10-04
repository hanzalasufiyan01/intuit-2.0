import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/**
 * Phase 4B-2: vendor payments, allocations, prepayments, AP credit application and realized FX
 * (ADR 0004 P4-25 to P4-34, P4-37, P4-42, P4-50, P4-51; decisions C1-C3, A1-A6 of 2026-10-04).
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
  vendorId: string;
}

async function purchasesOrg(options: { vendor?: Record<string, unknown> } = {}): Promise<Org> {
  const org = await setUpAccountingOrg(ctx);
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
  return { ...org, vendorId: vendor.body.data.id };
}

async function rate(o: AccountingOrg, rateDate: string, value: string) {
  const res = await o.owner.post('/accounting/exchange-rates', {
    fromCurrency: 'USD',
    rateDate,
    rate: value,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function postedBill(o: Org, overrides: Record<string, unknown> = {}, amount = '100') {
  const bill = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: '2026-03-10',
    vendorReference: `INV-${randomUUID().slice(0, 8)}`,
    lines: [{ description: 'Stock', quantity: '1', unitPrice: amount, taxCodeId: null }],
    ...overrides,
  });
  expect(bill.status, JSON.stringify(bill.body)).toBe(201);
  const res = await o.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
    version: bill.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; number: string; version: number; amountDue: string };
}

async function postedCredit(o: Org, overrides: Record<string, unknown> = {}, amount = '40') {
  const doc = await o.owner.post('/purchases/vendor-credits', {
    origin: 'supplier_credit_note',
    vendorId: o.vendorId,
    creditDate: '2026-03-12',
    vendorReference: `CN-${randomUUID().slice(0, 8)}`,
    lines: [{ description: 'Returned goods', quantity: '1', unitPrice: amount, taxCodeId: null }],
    ...overrides,
  });
  expect(doc.status, JSON.stringify(doc.body)).toBe(201);
  const res = await o.owner.post(`/purchases/vendor-credits/${doc.body.data.id}/post`, {
    version: doc.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

const payment = (o: Org, overrides: Record<string, unknown> = {}) => ({
  vendorId: o.vendorId,
  paymentDate: '2026-03-20',
  amount: '100',
  allocations: [] as { billId: string; amount: string }[],
  ...overrides,
});

async function draft(client: TestClient, body: object, headers: Record<string, string> = {}) {
  const res = await client.post('/purchases/payments', body, headers);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

function record(
  client: TestClient,
  doc: { id: string; version: number },
  headers: Record<string, string> = {},
) {
  return client.post(`/purchases/payments/${doc.id}/record`, { version: doc.version }, headers);
}

async function recorded(client: TestClient, body: object) {
  const doc = await draft(client, body);
  const res = await record(client, doc);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function apply(client: TestClient, body: object, headers: Record<string, string> = {}) {
  return client.post('/purchases/credit-applications', body, headers);
}

async function journal(o: AccountingOrg, journalId: string) {
  return (await o.owner.get(`/accounting/journals/${journalId}`)).body.data as {
    status: string;
    source: string;
    sourceType: string | null;
    currency: string;
    sourceDocument: Record<string, unknown> | null;
    lines: {
      kind: string;
      accountId: string;
      debit: string | null;
      credit: string | null;
      baseDebit: string | null;
      baseCredit: string | null;
    }[];
  };
}

async function bill(o: AccountingOrg, id: string) {
  return (await o.owner.get(`/purchases/bills/${id}`)).body.data;
}

/**
 * I-1: AP control (credit balance, base) = posted bills' base due − posted vendor credits' base
 * unapplied − recorded payments' base unallocated.
 */
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
            WHERE organization_id = $1 AND status = 'POSTED')
        - (SELECT coalesce(sum(base_unallocated), 0) FROM purchases_payments
            WHERE organization_id = $1 AND status = 'RECORDED'))::numeric(28,2)::text AS subledger`,
    [o.organizationId],
  );
  return rows[0] as { gl: string; subledger: string };
}

async function expectReconciled(o: AccountingOrg, gl: string) {
  expect(await apReconciliation(o)).toEqual({ gl, subledger: gl });
}

async function auditActions(o: AccountingOrg, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action, metadata FROM audit_events WHERE organization_id = $1 AND resource_id = $2
      ORDER BY occurred_at, id`,
    [o.organizationId, resourceId],
  );
  return rows as { action: string; metadata: Record<string, unknown> }[];
}

async function account(o: AccountingOrg, body: Record<string, unknown>) {
  const res = await o.owner.post('/accounting/accounts', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

const issuesOf = (res: { body: { error?: { details?: { issues?: unknown[] } } } }) =>
  res.body.error?.details?.issues ?? [];

// ---------------------------------------------------------------------------
// Recording payments
// ---------------------------------------------------------------------------

describe('vendor payments (P4-25 to P4-29)', () => {
  it('records partial, full and multi-bill payments in the base currency', async () => {
    const o = await purchasesOrg();
    const b1 = await postedBill(o, {}, '100');
    const b2 = await postedBill(o, {}, '200');
    const b3 = await postedBill(o, {}, '300');
    await expectReconciled(o, '600.00');
    const doc = await draft(
      o.owner,
      payment(o, {
        amount: '250',
        reference: 'TT-001',
        allocations: [
          { billId: b1.id, amount: '100' },
          { billId: b2.id, amount: '150' },
        ],
      }),
    );
    expect(doc).toMatchObject({
      status: 'DRAFT',
      number: null,
      amount: '250.00',
      approval: { required: false, readyToIssue: true, facts: { transactionType: 'payment' } },
    });
    expect(doc.plannedAllocations).toHaveLength(2);
    const res = await record(o.owner, doc);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const first = res.body.data;
    expect(first).toMatchObject({
      status: 'RECORDED',
      number: 'PAY-00001',
      exchangeRate: '1.0000000000',
      exchangeRateSource: 'base',
      paymentAccountId: o.accounts['1120'],
      paymentAccountOverridden: false,
      baseAmount: '250.0000',
      amountUnallocated: '0.00',
    });
    // Rows written together share their timestamp, so compare without order.
    expect(first.allocations).toHaveLength(2);
    expect(first.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ billId: b1.id, amount: '100.00', fxDifference: '0.0000' }),
        expect.objectContaining({ billId: b2.id, amount: '150.00', fxDifference: '0.0000' }),
      ]),
    );
    const j = await journal(o, first.journalId);
    expect(j).toMatchObject({ status: 'POSTED', sourceType: 'payment', currency: 'MVR' });
    expect(j.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      [o.accounts['2110'], '100.0000', null],
      [o.accounts['2110'], '150.0000', null],
      [o.accounts['1120'], null, '250.0000'],
    ]);
    expect((await bill(o, b1.id)).amountDue).toBe('0.00');
    expect((await bill(o, b2.id)).amountDue).toBe('50.00');
    await expectReconciled(o, '350.00');
    const second = await recorded(
      o.owner,
      payment(o, {
        amount: '350',
        allocations: [
          { billId: b2.id, amount: '50' },
          { billId: b3.id, amount: '300' },
        ],
      }),
    );
    expect(second.number).toBe('PAY-00002');
    await expectReconciled(o, '0.00');
    const settled = await o.owner.post(
      '/purchases/payments',
      payment(o, { allocations: [{ billId: b1.id, amount: '10' }] }),
    );
    expect(issuesOf(settled)).toEqual([
      { path: 'allocations.0.billId', message: 'The bill is already settled.' },
    ]);
    expect((await auditActions(o, first.id)).map((a) => a.action)).toEqual([
      'vendor_payment.created',
      'vendor_payment.recorded',
    ]);
  });

  it('keeps the excess and no-bill payments as prepayments on AP (P4-29, I-1)', async () => {
    const o = await purchasesOrg();
    const b = await postedBill(o, {}, '100');
    const excess = await recorded(
      o.owner,
      payment(o, { amount: '500', allocations: [{ billId: b.id, amount: '100' }] }),
    );
    expect(excess).toMatchObject({ amountUnallocated: '400.00', baseUnallocated: '400.0000' });
    const lines = (await journal(o, excess.journalId)).lines;
    expect(lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      [o.accounts['2110'], '100.0000', null],
      [o.accounts['2110'], '400.0000', null],
      [o.accounts['1120'], null, '500.0000'],
    ]);
    const prepay = await draft(o.owner, payment(o, { amount: '300' }));
    expect(prepay.approval.facts).toMatchObject({
      transactionType: 'prepayment',
      baseAmount: '300.00',
    });
    const done = await record(o.owner, prepay);
    expect(done.body.data).toMatchObject({ amountUnallocated: '300.00', allocations: [] });
    // A vendor debit balance: AP is 700 in debit.
    await expectReconciled(o, '-700.00');
    const list = await o.owner.get('/purchases/payments?withUnallocated=true');
    expect(list.body.data.items).toHaveLength(2);
  });

  it('pays from bank, cash or credit-card accounts within the currency rules (P4-26, P4-28)', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await rate(o, '2026-03-01', '15.42');
    const card = await account(o, {
      code: '2140',
      name: 'Company card',
      type: 'LIABILITY',
      parentId: o.accounts['2100'],
      subtype: 'CREDIT_CARD',
    });
    const usdBank = await account(o, {
      code: '1125',
      name: 'USD bank',
      type: 'ASSET',
      parentId: o.accounts['1100'],
      subtype: 'BANK',
      currencyCode: 'USD',
    });
    const eurBank = await account(o, {
      code: '1126',
      name: 'EUR bank',
      type: 'ASSET',
      parentId: o.accounts['1100'],
      subtype: 'BANK',
      currencyCode: 'EUR',
    });
    const archived = await account(o, {
      code: '1127',
      name: 'Old bank',
      type: 'ASSET',
      parentId: o.accounts['1100'],
      subtype: 'BANK',
    });
    expect((await o.owner.post(`/accounting/accounts/${archived}/archive`)).status).toBe(200);
    const refused = async (paymentAccountId: string) =>
      issuesOf(await o.owner.post('/purchases/payments', payment(o, { paymentAccountId })));
    expect(await refused(eurBank)).toEqual([
      { path: 'paymentAccountId', message: 'The payment account must be in USD or MVR.' },
    ]);
    expect((await refused(o.accounts['1100']!))[0]).toMatchObject({
      message: 'Choose a posting (leaf) account.',
    });
    expect((await refused(o.accounts['2110']!))[0]).toMatchObject({
      message: 'A control account cannot be used here.',
    });
    expect((await refused(o.accounts['5400']!))[0]).toMatchObject({
      message: 'Choose a bank, cash or credit card account (Decision 42, P4-26).',
    });
    expect((await refused(archived))[0]).toMatchObject({ message: 'Choose an active account.' });
    expect((await refused(randomUUID()))[0]).toMatchObject({ message: 'Account not found.' });

    for (const [accountId, overridden] of [
      [card, true],
      [usdBank, true],
      [o.accounts['1110'], true],
      [o.accounts['1120'], false],
    ] as const) {
      const b = await postedBill(o, {}, '10');
      const paid = await recorded(
        o.owner,
        payment(o, {
          amount: '10',
          paymentAccountId: accountId === o.accounts['1120'] ? null : accountId,
          allocations: [{ billId: b.id, amount: '10' }],
        }),
      );
      expect(paid).toMatchObject({
        paymentAccountId: accountId,
        paymentAccountOverridden: overridden,
      });
      const credit = (await journal(o, paid.journalId)).lines.find((l) => l.credit !== null)!;
      expect(credit).toMatchObject({ accountId, credit: '10.0000' });
      const actions = (await auditActions(o, paid.id)).map((a) => a.action);
      expect(actions.includes('vendor_payment.account_overridden')).toBe(overridden);
    }
    // A base-currency payment cannot use a foreign-currency account.
    const mvrVendor = await o.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Local Supplier' },
    });
    const mvr = await o.owner.post(
      '/purchases/payments',
      payment(o, { vendorId: mvrVendor.body.data.id, paymentAccountId: usdBank }),
    );
    expect(issuesOf(mvr)).toEqual([
      { path: 'paymentAccountId', message: 'The payment account must be in MVR.' },
    ]);
    await expectReconciled(o, '0.00');
  });
});

// ---------------------------------------------------------------------------
// Realized FX (C1)
// ---------------------------------------------------------------------------

describe('realized FX on vendor payments', () => {
  it('posts one net base-only FX line and keeps each allocation’s own FX', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await rate(o, '2026-03-01', '15.42');
    await rate(o, '2026-03-15', '15.50');
    const a = await postedBill(o); // 100 USD at 15.42 = 1,542.00
    const b = await postedBill(o, { rateOverride: '15.60', rateOverrideReason: 'Bank rate' });
    await expectReconciled(o, '3102.00');
    const paid = await recorded(
      o.owner,
      payment(o, {
        amount: '200',
        allocations: [
          { billId: a.id, amount: '100' },
          { billId: b.id, amount: '100' },
        ],
      }),
    );
    expect(paid).toMatchObject({
      currencyCode: 'USD',
      exchangeRate: '15.5000000000',
      exchangeRateSource: 'table',
      baseAmount: '3100.0000',
    });
    // AP sign: base relieved − source base. A: 1,542 − 1,550 = −8 (loss); B: 1,560 − 1,550 = +10.
    expect(
      paid.allocations
        .map((x: Record<string, string>) => [
          x.billId,
          x.baseRelieved,
          x.sourceBase,
          x.fxDifference,
        ])
        .sort((x: string[], y: string[]) => (x[1]! < y[1]! ? -1 : 1)),
    ).toEqual([
      [a.id, '1542.0000', '1550.0000', '-8.0000'],
      [b.id, '1560.0000', '1550.0000', '10.0000'],
    ]);
    const designations = (await o.owner.get('/accounting/designations')).body.data as {
      designation: string;
      accountId: string;
    }[];
    const fxAccount = designations.find(
      (d) => d.designation === 'REALIZED_FX_GAIN_LOSS',
    )!.accountId;
    const j = await journal(o, paid.journalId);
    expect(j).toMatchObject({ source: 'system', sourceType: 'realized_fx', currency: 'USD' });
    expect(
      j.lines.map((l) => [l.kind, l.accountId, l.debit, l.credit, l.baseDebit, l.baseCredit]),
    ).toEqual([
      ['normal', o.accounts['2110'], '100.0000', null, '1542.0000', null],
      ['normal', o.accounts['2110'], '100.0000', null, '1560.0000', null],
      ['normal', o.accounts['1120'], null, '200.0000', null, '3100.0000'],
      // One net line (C1): +2.00 gain.
      ['base_only', fxAccount, null, null, null, '2.0000'],
    ]);
    expect(j.sourceDocument).toMatchObject({
      documentType: 'payment',
      id: paid.id,
      number: paid.number,
      path: `/purchases/payments/${paid.id}`,
      relation: 'source',
    });
    await expectReconciled(o, '0.00');
    // Realized-FX journals are never reversed generically (Decision 80, E2).
    const manual = await o.owner.post(`/accounting/journals/${paid.journalId}/reverse`, {
      reason: 'Trying',
    });
    expect(manual.status).toBe(409);
    // The void mirrors the system journal through Purchases.
    const voided = await o.owner.post(`/purchases/payments/${paid.id}/void`, {
      version: paid.version,
      reason: 'Wrong rate',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await journal(o, paid.journalId)).status).toBe('REVERSED');
    const mirror = await journal(o, voided.body.data.voidJournalId);
    expect(mirror).toMatchObject({
      sourceType: 'realized_fx',
      sourceDocument: { relation: 'reversal' },
    });
    expect(mirror.lines.at(-1)).toMatchObject({ kind: 'base_only', baseDebit: '2.0000' });
    await expectReconciled(o, '3102.00');
  });

  it('posts no FX at the bill’s own rate, and a gain or a loss otherwise', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await rate(o, '2026-03-01', '15.42');
    const c = await postedBill(o);
    const same = await recorded(
      o.owner,
      payment(o, {
        rateOverride: '15.42',
        rateOverrideReason: 'Paid at the invoice rate',
        allocations: [{ billId: c.id, amount: '100' }],
      }),
    );
    const j = await journal(o, same.journalId);
    expect(j).toMatchObject({ source: 'event', sourceType: 'payment' });
    expect(j.lines.some((l) => l.kind === 'base_only')).toBe(false);
    expect(same.allocations[0].fxDifference).toBe('0.0000');
    // Loss: paid at 15.80 for a bill carried at 15.42 → −38.00.
    const d = await postedBill(o);
    const loss = await recorded(
      o.owner,
      payment(o, {
        rateOverride: '15.80',
        rateOverrideReason: 'Card rate',
        allocations: [{ billId: d.id, amount: '100' }],
      }),
    );
    expect(loss.allocations[0].fxDifference).toBe('-38.0000');
    expect((await journal(o, loss.journalId)).lines.at(-1)).toMatchObject({
      kind: 'base_only',
      baseDebit: '38.0000',
    });
    // Gain: paid at 15.00 → +42.00.
    const e = await postedBill(o);
    const gain = await recorded(
      o.owner,
      payment(o, {
        rateOverride: '15.00',
        rateOverrideReason: 'Agreed rate',
        allocations: [{ billId: e.id, amount: '100' }],
      }),
    );
    expect((await journal(o, gain.journalId)).lines.at(-1)).toMatchObject({
      kind: 'base_only',
      baseCredit: '42.0000',
    });
    await expectReconciled(o, '0.00');
  });

  it('needs a reason for a manual rate, keeps the table rate and audits it (P4-27)', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await rate(o, '2026-03-01', '15.42');
    const noReason = await o.owner.post(
      '/purchases/payments',
      payment(o, { rateOverride: '15.5' }),
    );
    expect(issuesOf(noReason)).toEqual([
      { path: 'rateOverrideReason', message: 'Give a reason for overriding the rate (P4-27).' },
    ]);
    const local = await o.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Local Supplier' },
    });
    const base = await o.owner.post(
      '/purchases/payments',
      payment(o, { vendorId: local.body.data.id, rateOverride: '2', rateOverrideReason: 'x' }),
    );
    expect(issuesOf(base)[0]).toMatchObject({
      message: 'A base-currency payment has no exchange rate to override.',
    });
    const manual = await recorded(
      o.owner,
      payment(o, { rateOverride: '15.55', rateOverrideReason: 'Bank deal rate' }),
    );
    expect(manual).toMatchObject({
      exchangeRate: '15.5500000000',
      exchangeRateSource: 'manual',
      tableRate: '15.4200000000',
      rateOverrideReason: 'Bank deal rate',
      baseAmount: '1555.0000',
    });
    expect(
      (await auditActions(o, manual.id)).find((a) => a.action === 'vendor_payment.rate_overridden')
        ?.metadata,
    ).toMatchObject({ reason: 'Bank deal rate', tableRate: '15.4200000000' });
  });

  it('needs a rate on the payment date and the Realized FX designation when FX is posted', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await rate(o, '2026-03-01', '15.42');
    const bill1 = await postedBill(o);
    const early = await draft(o.owner, payment(o, { paymentDate: '2026-02-20' }));
    expect(early.warnings[0].code).toBe('EXCHANGE_RATE_REQUIRED');
    expect((await record(o.owner, early)).body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
    await owner.query(
      `DELETE FROM accounting_designations WHERE organization_id = $1 AND designation = 'REALIZED_FX_GAIN_LOSS'`,
      [o.organizationId],
    );
    await rate(o, '2026-03-15', '15.50');
    const fx = await draft(
      o.owner,
      payment(o, { allocations: [{ billId: bill1.id, amount: '100' }] }),
    );
    expect((await record(o.owner, fx)).body.error.code).toBe('DESIGNATION_REQUIRED');
    // At the bill's own rate there is no FX, so no designation is needed.
    await rate(o, '2026-03-16', '15.42');
    await recorded(o.owner, payment(o, { allocations: [{ billId: bill1.id, amount: '100' }] }));
    await expectReconciled(o, '0.00');
  });
});

// ---------------------------------------------------------------------------
// Allocation rules
// ---------------------------------------------------------------------------

describe('payment allocation rules', () => {
  it('settles posted bills of the same vendor and currency only, never vendor credits (C2)', async () => {
    const o = await purchasesOrg();
    const b = await postedBill(o, {}, '100');
    const credit = await postedCredit(o);
    const other = await o.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Other Supplier' },
    });
    const otherBill = await postedBill({ ...o, vendorId: other.body.data.id });
    const draftBill = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorId,
      billDate: '2026-03-10',
      lines: [{ description: 'x', quantity: '1', unitPrice: '10' }],
    });
    const usd = await postedBillUsd(o);
    const later = await postedBill(o, { billDate: '2026-03-25' });
    const check = async (allocations: object[], body: Record<string, unknown> = {}) =>
      issuesOf(await o.owner.post('/purchases/payments', payment(o, { allocations, ...body })));
    // C2: a vendor credit is not a bill.
    expect(await check([{ billId: credit.id, amount: '10' }])).toEqual([
      { path: 'allocations.0.billId', message: 'Bill not found.' },
    ]);
    expect(
      (
        await o.owner.post('/purchases/payments', {
          ...payment(o),
          allocations: [{ vendorCreditId: credit.id, amount: '10' }],
        })
      ).status,
    ).toBe(400);
    expect(await check([{ billId: otherBill.id, amount: '10' }])).toEqual([
      { path: 'allocations.0.billId', message: 'The bill belongs to another vendor.' },
    ]);
    expect(await check([{ billId: draftBill.body.data.id, amount: '10' }])).toEqual([
      { path: 'allocations.0.billId', message: 'Only posted bills can be settled.' },
    ]);
    expect(await check([{ billId: usd.id, amount: '10' }])).toEqual([
      {
        path: 'allocations.0.billId',
        message: 'The bill is in USD; a payment and its bills share one currency.',
      },
    ]);
    expect(await check([{ billId: later.id, amount: '10' }])).toEqual([
      { path: 'allocations.0.billId', message: 'The bill is dated after this payment.' },
    ]);
    expect(await check([{ billId: b.id, amount: '100.01' }], { amount: '200' })).toEqual([
      { path: 'allocations.0.amount', message: 'The bill has 100.00 outstanding.' },
    ]);
    expect(
      await check([
        { billId: b.id, amount: '10' },
        { billId: b.id, amount: '10' },
      ]),
    ).toContainEqual({ path: 'allocations', message: 'Allocate to each bill once.' });
    expect(await check([{ billId: b.id, amount: '100' }], { amount: '50' })).toEqual([
      { path: 'allocations', message: 'The allocations exceed the amount paid.' },
    ]);
    // P4-50 / C1: at most 497 bills (checked before any lookup).
    const tooMany = await o.owner.post(
      '/purchases/payments',
      payment(o, {
        allocations: Array.from({ length: 498 }, () => ({ billId: randomUUID(), amount: '1' })),
      }),
    );
    expect(tooMany.status).toBe(400);
    // A voided bill can no longer be settled.
    const voidable = await postedBill(o, {}, '20');
    const planned = await draft(
      o.owner,
      payment(o, { allocations: [{ billId: voidable.id, amount: '20' }] }),
    );
    const voidBill = await o.owner.post(`/purchases/bills/${voidable.id}/void`, {
      version: voidable.version,
      reason: 'Duplicate',
    });
    expect(voidBill.status, JSON.stringify(voidBill.body)).toBe(200);
    expect(issuesOf(await record(o.owner, planned))).toEqual([
      { path: 'allocations.0.billId', message: 'Only posted bills can be settled.' },
    ]);
  });

  it('re-checks the plan at record: a bill paid meanwhile, a closed period', async () => {
    const o = await purchasesOrg();
    const b = await postedBill(o, {}, '100');
    const plan = await draft(
      o.owner,
      payment(o, { allocations: [{ billId: b.id, amount: '100' }] }),
    );
    await recorded(
      o.owner,
      payment(o, { amount: '60', allocations: [{ billId: b.id, amount: '60' }] }),
    );
    const stale = await record(o.owner, plan);
    expect(stale.body.error.message).toBe('The payment cannot be recorded yet.');
    expect(issuesOf(stale)).toEqual([
      { path: 'allocations.0.amount', message: 'The bill has 40.00 outstanding.' },
    ]);
    const march = o.periods.find((p) => p.startDate === '2026-03-01')!;
    const prepay = await draft(o.owner, payment(o, { amount: '10' }));
    expect((await o.owner.post(`/accounting/periods/${march.id}/close`)).status).toBe(200);
    expect((await record(o.owner, prepay)).body.error.code).toBe('PERIOD_CLOSED');
  });
});

async function postedBillUsd(o: Org) {
  await o.owner.post('/accounting/exchange-rates', {
    fromCurrency: 'USD',
    rateDate: '2026-03-01',
    rate: '15.42',
  });
  return postedBill(o, { currencyCode: 'USD' });
}

// ---------------------------------------------------------------------------
// Credit application (A2, A3)
// ---------------------------------------------------------------------------

describe('applying vendor credits and prepayments to bills', () => {
  it('applies a vendor credit and a prepayment, AP against AP', async () => {
    const o = await purchasesOrg();
    const b1 = await postedBill(o, {}, '100');
    const b2 = await postedBill(o, {}, '300');
    const credit = await postedCredit(o, {}, '40');
    await expectReconciled(o, '360.00');
    const res = await apply(o.owner, {
      sourceType: 'vendor_credit',
      sourceId: credit.id,
      date: '2026-03-20',
      allocations: [{ billId: b1.id, amount: '30' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      sourceNumber: credit.number,
      amountApplied: '30.00',
      amountRemaining: '10.00',
    });
    const j = await journal(o, res.body.data.journalId);
    expect(j).toMatchObject({ sourceType: 'credit_application', currency: 'MVR' });
    expect(j.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      [o.accounts['2110'], '30.0000', null],
      [o.accounts['2110'], null, '30.0000'],
    ]);
    expect(j.sourceDocument).toMatchObject({
      documentType: 'credit_application',
      id: credit.id,
      path: `/purchases/vendor-credits/${credit.id}`,
    });
    expect((await bill(o, b1.id)).amountDue).toBe('70.00');
    const after = (await o.owner.get(`/purchases/vendor-credits/${credit.id}`)).body.data;
    expect(after.amountUnapplied).toBe('10.00');
    // An applied credit cannot be voided (P4-24).
    const voided = await o.owner.post(`/purchases/vendor-credits/${credit.id}/void`, {
      version: after.version,
      reason: 'x',
    });
    expect(voided.body.error.code).toBe('INVALID_STATE_TRANSITION');
    await expectReconciled(o, '360.00');
    // A prepayment applied later.
    const prepay = await recorded(o.owner, payment(o, { amount: '500' }));
    await expectReconciled(o, '-140.00');
    const fromPayment = await apply(o.owner, {
      sourceType: 'payment',
      sourceId: prepay.id,
      date: '2026-03-25',
      allocations: [
        { billId: b1.id, amount: '70' },
        { billId: b2.id, amount: '300' },
      ],
    });
    expect(fromPayment.status, JSON.stringify(fromPayment.body)).toBe(201);
    const paymentAfter = (await o.owner.get(`/purchases/payments/${prepay.id}`)).body.data;
    expect(paymentAfter.amountUnallocated).toBe('130.00');
    expect((await bill(o, b2.id)).amountDue).toBe('0.00');
    const history = (await o.owner.get(`/purchases/bills/${b1.id}/allocations`)).body.data;
    expect(
      history.map((h: { sourceNumber: string; mode: string }) => [h.sourceNumber, h.mode]),
    ).toEqual([
      [credit.number, 'credit'],
      [prepay.number, 'credit'],
    ]);
    const creditHistory = (await o.owner.get(`/purchases/vendor-credits/${credit.id}/allocations`))
      .body.data;
    expect(creditHistory).toHaveLength(1);
    await expectReconciled(o, '-140.00');
    expect((await auditActions(o, prepay.id)).map((a) => a.action)).toContain('ap_credit.applied');
  });

  it('realizes FX between the credit and the bill, but none for a credit at the bill’s rate', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await rate(o, '2026-03-01', '15.42');
    await rate(o, '2026-03-15', '15.50');
    const b = await postedBill(o); // 100 USD, base 1,542
    const credit = await postedCredit(o, { creditDate: '2026-03-16' }, '50'); // base 775
    const res = await apply(o.owner, {
      sourceType: 'vendor_credit',
      sourceId: credit.id,
      date: '2026-03-20',
      allocations: [{ billId: b.id, amount: '50' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // Bill relieved 771.00, credit released 775.00: AP fx = 771 − 775 = −4 (a loss).
    expect(res.body.data.allocations[0]).toMatchObject({
      baseRelieved: '771.0000',
      sourceBase: '775.0000',
      fxDifference: '-4.0000',
    });
    const j = await journal(o, res.body.data.journalId);
    expect(j).toMatchObject({ sourceType: 'realized_fx', currency: 'USD' });
    expect(j.lines.map((l) => [l.kind, l.debit, l.credit, l.baseDebit, l.baseCredit])).toEqual([
      ['normal', '50.0000', null, '771.0000', null],
      ['normal', null, '50.0000', null, '775.0000'],
      ['base_only', null, null, '4.0000', null],
    ]);
    // A credit linked to a bill follows the bill's rate (4B-1), so applying it to that bill
    // realizes nothing.
    const linkedBill = await postedBill(o, { rateOverride: '15.60', rateOverrideReason: 'x' });
    const linked = await postedCredit(o, { billId: linkedBill.id }, '25');
    const zero = await apply(o.owner, {
      sourceType: 'vendor_credit',
      sourceId: linked.id,
      date: '2026-03-20',
      allocations: [{ billId: linkedBill.id, amount: '25' }],
    });
    expect(zero.body.data.allocations[0].fxDifference).toBe('0.0000');
    expect((await journal(o, zero.body.data.journalId)).currency).toBe('MVR');
    // Bills: 771.00 + 1,170.00 still due; both credits fully applied.
    await expectReconciled(o, '1941.00');
  });

  it('refuses mismatches, over-application, void sources, early dates and closed periods', async () => {
    const o = await purchasesOrg();
    const b = await postedBill(o, {}, '100');
    const credit = await postedCredit(o, {}, '40');
    const usdBill = await postedBillUsd(o);
    const other = await o.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Other Supplier' },
    });
    const otherBill = await postedBill({ ...o, vendorId: other.body.data.id });
    const body = (allocations: object[], extra: Record<string, unknown> = {}) => ({
      sourceType: 'vendor_credit',
      sourceId: credit.id,
      date: '2026-03-20',
      allocations,
      ...extra,
    });
    expect(
      issuesOf(await apply(o.owner, body([{ billId: usdBill.id, amount: '10' }])))[0],
    ).toMatchObject({ message: 'The bill is in USD; a payment and its bills share one currency.' });
    expect(
      issuesOf(await apply(o.owner, body([{ billId: otherBill.id, amount: '10' }])))[0],
    ).toMatchObject({ message: 'The bill belongs to another vendor.' });
    expect(issuesOf(await apply(o.owner, body([{ billId: b.id, amount: '41' }])))).toEqual([
      { path: 'allocations', message: 'Only 40.00 of credit is available.' },
    ]);
    expect(
      issuesOf(
        await apply(o.owner, body([{ billId: b.id, amount: '10' }], { date: '2026-03-11' })),
      ),
    ).toContainEqual({
      path: 'date',
      message: 'Credit cannot be applied before it was received or paid.',
    });
    expect((await apply(o.owner, body([]))).status).toBe(400);
    const spare = await postedCredit(o, {}, '5');
    const voided = await o.owner.post(`/purchases/vendor-credits/${spare.id}/void`, {
      version: spare.version,
      reason: 'Duplicate',
    });
    expect(voided.status).toBe(200);
    const fromVoid = await apply(o.owner, {
      ...body([{ billId: b.id, amount: '5' }]),
      sourceId: spare.id,
    });
    expect(fromVoid.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const march = o.periods.find((p) => p.startDate === '2026-03-01')!;
    expect((await o.owner.post(`/accounting/periods/${march.id}/close`)).status).toBe(200);
    expect((await apply(o.owner, body([{ billId: b.id, amount: '10' }]))).body.error.code).toBe(
      'PERIOD_CLOSED',
    );
  });
});

// ---------------------------------------------------------------------------
// Approval (P4-25, P4-37; A4)
// ---------------------------------------------------------------------------

describe('vendor payment approval', () => {
  it('is optional, conditional, never self-approved, and re-checked at record', async () => {
    const o = await purchasesOrg();
    const roles = (await o.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    const adminRole = roles.find((r) => r.name === 'Administrator')!.id;
    const step = (minBaseAmount: string, name = 'AP supervisor') => ({
      name,
      requiredApprovals: 1,
      roleIds: [adminRole],
      membershipIds: [],
      conditions: { minBaseAmount, transactionTypes: ['payment'] },
    });
    const policy = await o.owner.put('/approvals/policies/purchases.payment.record', {
      steps: [step('1000')],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const admin = (await joinWithRole(ctx, o.owner, 'Administrator')).client;
    const small = await postedBill(o, {}, '100');
    // Below the threshold, or a prepayment: recorded directly.
    expect(
      (await recorded(o.owner, payment(o, { allocations: [{ billId: small.id, amount: '100' }] })))
        .status,
    ).toBe('RECORDED');
    expect((await recorded(o.owner, payment(o, { amount: '5000' }))).status).toBe('RECORDED');
    const big = await postedBill(o, {}, '2000');
    const doc = await draft(
      o.owner,
      payment(o, { amount: '2000', allocations: [{ billId: big.id, amount: '2000' }] }),
    );
    expect(doc.approval).toMatchObject({ required: true, readyToIssue: false });
    expect((await record(o.owner, doc)).body.error.code).toBe('APPROVAL_REQUIRED');
    const submitted = (
      await o.owner.post(`/purchases/payments/${doc.id}/submit`, { version: doc.version })
    ).body.data;
    expect(submitted.status).toBe('PENDING_APPROVAL');
    expect(submitted.approval.facts).toMatchObject({
      transactionType: 'payment',
      baseAmount: '2000.00',
      baseCurrency: 'MVR',
    });
    const requestId = submitted.approval.requestId;
    expect(
      (await o.owner.post(`/approvals/requests/${requestId}/approve`, {})).body.error.code,
    ).toBe('SELF_APPROVAL_PROHIBITED');
    expect((await admin.post(`/approvals/requests/${requestId}/reject`, {})).status).toBe(400);
    const rejected = await admin.post(`/approvals/requests/${requestId}/reject`, {
      comment: 'Wrong bank',
    });
    expect(rejected.status).toBe(200);
    const back = (await o.owner.get(`/purchases/payments/${doc.id}`)).body.data;
    expect(back.status).toBe('DRAFT');
    const again = (
      await o.owner.post(`/purchases/payments/${doc.id}/submit`, { version: back.version })
    ).body.data;
    const withdrawn = (
      await o.owner.post(`/purchases/payments/${doc.id}/withdraw`, { version: again.version })
    ).body.data;
    expect(withdrawn.status).toBe('DRAFT');
    const third = (
      await o.owner.post(`/purchases/payments/${doc.id}/submit`, { version: withdrawn.version })
    ).body.data;
    expect(
      (await admin.post(`/approvals/requests/${third.approval.requestId}/approve`, {})).status,
    ).toBe(200);
    // An added step makes the approval outdated; record refuses until it is covered again.
    await o.owner.put('/approvals/policies/purchases.payment.record', {
      steps: [step('1000'), step('1500', 'Finance director')],
    });
    const outdated = await record(
      o.owner,
      (await o.owner.get(`/purchases/payments/${doc.id}`)).body.data,
    );
    expect(outdated.body.error.message).toBe(
      'The payment now needs further approval. Withdraw it and submit it again.',
    );
    await o.owner.put('/approvals/policies/purchases.payment.record', { steps: [step('1000')] });
    const ready = (await o.owner.get(`/purchases/payments/${doc.id}`)).body.data;
    expect(ready.approval.readyToIssue).toBe(true);
    const done = await record(o.owner, ready);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await auditActions(o, doc.id)).map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'vendor_payment.submitted',
        'vendor_payment.rejected',
        'vendor_payment.withdrawn',
        'vendor_payment.approved',
        'vendor_payment.recorded',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Void (P4-33, P4-42)
// ---------------------------------------------------------------------------

describe('voiding vendor payments', () => {
  it('reverses the payment and its prepayment applications with re-authentication', async () => {
    const o = await purchasesOrg();
    const b1 = await postedBill(o, {}, '100');
    const b2 = await postedBill(o, {}, '300');
    const paid = await recorded(
      o.owner,
      payment(o, { amount: '500', allocations: [{ billId: b1.id, amount: '100' }] }),
    );
    const applied = await apply(o.owner, {
      sourceType: 'payment',
      sourceId: paid.id,
      date: '2026-03-22',
      allocations: [{ billId: b2.id, amount: '300' }],
    });
    expect(applied.status).toBe(201);
    await expectReconciled(o, '-100.00');
    const current = (await o.owner.get(`/purchases/payments/${paid.id}`)).body.data;
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await o.owner.post(`/purchases/payments/${paid.id}/void`, {
      version: current.version,
      reason: 'Paid the wrong vendor',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const voided = await o.owner.post(`/purchases/payments/${paid.id}/void`, {
      version: current.version,
      reason: 'Paid the wrong vendor',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'VOID', amountUnallocated: '0.00' });
    expect((await journal(o, paid.journalId)).status).toBe('REVERSED');
    expect((await journal(o, applied.body.data.journalId)).status).toBe('REVERSED');
    expect((await bill(o, b1.id)).amountDue).toBe('100.00');
    expect((await bill(o, b2.id)).amountDue).toBe('300.00');
    const rows = voided.body.data.allocations as { amount: string; reversesAllocationId: string }[];
    expect(rows.map((r) => r.amount).sort()).toEqual(['-100.00', '-300.00', '100.00', '300.00']);
    expect(rows.filter((r) => r.reversesAllocationId !== null)).toHaveLength(2);
    const reversal = await journal(o, voided.body.data.voidJournalId);
    expect(reversal.sourceDocument).toMatchObject({
      documentType: 'payment',
      relation: 'reversal',
    });
    await expectReconciled(o, '400.00');
    // Bills can be voided again once their payments are gone.
    expect(
      (
        await o.owner.post(`/purchases/bills/${b1.id}/void`, {
          version: (await bill(o, b1.id)).version,
          reason: 'Cancelled',
        })
      ).status,
    ).toBe(200);
    const again = await o.owner.post(`/purchases/payments/${paid.id}/void`, {
      version: voided.body.data.version,
      reason: 'Again',
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await auditActions(o, paid.id)).at(-1)).toMatchObject({
      action: 'vendor_payment.voided',
      metadata: { allocationsReversed: 2 },
    });
  });

  it('refuses a closed period and drafts', async () => {
    const o = await purchasesOrg();
    const paid = await recorded(o.owner, payment(o, { amount: '50' }));
    const plan = await draft(o.owner, payment(o, { amount: '50' }));
    const draftVoid = await o.owner.post(`/purchases/payments/${plan.id}/void`, {
      version: plan.version,
      reason: 'x',
    });
    expect(draftVoid.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const march = o.periods.find((p) => p.startDate === '2026-03-01')!;
    expect((await o.owner.post(`/accounting/periods/${march.id}/close`)).status).toBe(200);
    const closed = await o.owner.post(`/purchases/payments/${paid.id}/void`, {
      version: paid.version,
      reason: 'Too late',
    });
    expect(closed.body.error.code).toBe('PERIOD_CLOSED');
  });
});

// ---------------------------------------------------------------------------
// Drafts, idempotency and concurrency
// ---------------------------------------------------------------------------

describe('payment drafts, idempotency and concurrency', () => {
  it('edits drafts under versions and deletes drafts only', async () => {
    const o = await purchasesOrg();
    const b = await postedBill(o, {}, '100');
    const doc = await draft(o.owner, payment(o, { allocations: [{ billId: b.id, amount: '40' }] }));
    const edited = await o.owner.put(`/purchases/payments/${doc.id}`, {
      ...payment(o, {
        amount: '90',
        memo: 'Edited',
        allocations: [{ billId: b.id, amount: '90' }],
      }),
      version: doc.version,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data).toMatchObject({ amount: '90.00', memo: 'Edited', version: 2 });
    const stale = await o.owner.put(`/purchases/payments/${doc.id}`, {
      ...payment(o),
      version: doc.version,
    });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const deleted = await o.owner.delete(`/purchases/payments/${doc.id}?version=2`);
    expect(deleted.status).toBe(200);
    expect((await o.owner.get(`/purchases/payments/${doc.id}`)).status).toBe(404);
    const paid = await recorded(o.owner, payment(o, { amount: '10' }));
    const refused = await o.owner.delete(`/purchases/payments/${paid.id}?version=${paid.version}`);
    expect(refused.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const unknown = await o.owner.post('/purchases/payments', { ...payment(o), refund: true });
    expect(unknown.status).toBe(400);
  });

  it('replays create, record and apply under the same Idempotency-Key', async () => {
    const o = await purchasesOrg();
    const b = await postedBill(o, {}, '100');
    const createKey = randomUUID();
    const body = payment(o, { amount: '150', allocations: [{ billId: b.id, amount: '50' }] });
    const first = await draft(o.owner, body, { 'idempotency-key': createKey });
    const second = await draft(o.owner, body, { 'idempotency-key': createKey });
    expect(second.id).toBe(first.id);
    const recordKey = randomUUID();
    const r1 = await record(o.owner, first, { 'idempotency-key': recordKey });
    const r2 = await record(o.owner, first, { 'idempotency-key': recordKey });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r2.body.data.journalId).toBe(r1.body.data.journalId);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_events WHERE event_key = $1`,
      [`payment:${first.id}:recorded`],
    );
    expect(rows[0].n).toBe(1);
    expect((await record(o.owner, first)).status).toBe(409);
    const applyKey = randomUUID();
    const applyBody = {
      sourceType: 'payment',
      sourceId: first.id,
      date: '2026-03-21',
      allocations: [{ billId: b.id, amount: '50' }],
    };
    const a1 = await apply(o.owner, applyBody, { 'idempotency-key': applyKey });
    const a2 = await apply(o.owner, applyBody, { 'idempotency-key': applyKey });
    expect(a2.body.data.applicationId).toBe(a1.body.data.applicationId);
    expect((await bill(o, b.id)).amountDue).toBe('0.00');
    await expectReconciled(o, '-50.00');
  });

  it('settles a bill once when two payments race for it', async () => {
    const o = await purchasesOrg();
    const b = await postedBill(o, {}, '100');
    const one = await draft(
      o.owner,
      payment(o, { allocations: [{ billId: b.id, amount: '100' }] }),
    );
    const two = await draft(
      o.owner,
      payment(o, { allocations: [{ billId: b.id, amount: '100' }] }),
    );
    const results = await Promise.all([record(o.owner, one), record(o.owner, two)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await bill(o, b.id)).amountDue).toBe('0.00');
    await expectReconciled(o, '0.00');
  });
});

// ---------------------------------------------------------------------------
// Security and integrity
// ---------------------------------------------------------------------------

describe('vendor payment security', () => {
  it('follows the vendor-payment permission catalog', async () => {
    const o = await purchasesOrg();
    const b = await postedBill(o, {}, '100');
    const paid = await recorded(o.owner, payment(o, { amount: '30' }));
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/purchases/payments')).status).toBe(200);
    expect((await member.client.get(`/purchases/payments/${paid.id}`)).status).toBe(200);
    expect((await member.client.post('/purchases/payments', payment(o))).status).toBe(403);
    expect(
      (
        await apply(member.client, {
          sourceType: 'payment',
          sourceId: paid.id,
          date: '2026-03-21',
          allocations: [{ billId: b.id, amount: '10' }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await member.client.post(`/purchases/payments/${paid.id}/void`, {
          version: paid.version,
          reason: 'x',
        })
      ).status,
    ).toBe(403);
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Payments clerk',
      permissionKeys: ['vendor_payments.view', 'vendor_payments.create', 'vendors.view'],
    });
    expect(role.status).toBe(201);
    const clerk = await joinWithRole(ctx, o.owner, 'Payments clerk');
    // A clerk records payments (overrides included: P4-27, P4-28) but cannot void them.
    const own = await recorded(
      clerk.client,
      payment(o, { amount: '20', paymentAccountId: o.accounts['1110'] }),
    );
    expect(own.paymentAccountOverridden).toBe(true);
    expect(
      (
        await clerk.client.post(`/purchases/payments/${own.id}/void`, {
          version: own.version,
          reason: 'x',
        })
      ).status,
    ).toBe(403);
  });

  it('keeps payments and allocations tenant-isolated (API and RLS)', async () => {
    const a = await purchasesOrg();
    const b = await purchasesOrg();
    const billA = await postedBill(a, {}, '100');
    const paid = await recorded(
      a.owner,
      payment(a, { amount: '150', allocations: [{ billId: billA.id, amount: '100' }] }),
    );
    expect((await b.owner.get(`/purchases/payments/${paid.id}`)).status).toBe(404);
    expect((await record(b.owner, paid)).status).toBe(404);
    expect(
      (
        await b.owner.post(`/purchases/payments/${paid.id}/void`, {
          version: paid.version,
          reason: 'x',
        })
      ).status,
    ).toBe(404);
    expect((await b.owner.get(`/purchases/bills/${billA.id}/allocations`)).status).toBe(404);
    const crossBill = await b.owner.post(
      '/purchases/payments',
      payment(b, { allocations: [{ billId: billA.id, amount: '10' }] }),
    );
    expect(issuesOf(crossBill)).toEqual([
      { path: 'allocations.0.billId', message: 'Bill not found.' },
    ]);
    const crossSource = await apply(b.owner, {
      sourceType: 'payment',
      sourceId: paid.id,
      date: '2026-03-21',
      allocations: [],
    });
    expect(crossSource.status).toBe(400);
    const crossApply = await apply(b.owner, {
      sourceType: 'payment',
      sourceId: paid.id,
      date: '2026-03-21',
      allocations: [{ billId: billA.id, amount: '10' }],
    });
    expect(crossApply.status).toBe(404);
    // The journal's source document is never resolved for another organization.
    expect((await b.owner.get(`/accounting/journals/${paid.journalId}`)).status).toBe(404);
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      for (const table of [
        'purchases_payments',
        'purchases_payment_planned_allocations',
        'purchases_allocations',
      ]) {
        expect((await app.query(`SELECT id FROM ${table}`)).rows).toEqual([]);
      }
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
  });

  it('guards recorded payments, plans and allocations in the database', async () => {
    const o = await purchasesOrg();
    const b = await postedBill(o, {}, '100');
    const paid = await recorded(
      o.owner,
      payment(o, { amount: '100', allocations: [{ billId: b.id, amount: '100' }] }),
    );
    await expect(
      owner.query(`UPDATE purchases_payments SET amount = 1 WHERE id = $1`, [paid.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`DELETE FROM purchases_payments WHERE id = $1`, [paid.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(
        `INSERT INTO purchases_payment_planned_allocations (organization_id, payment_id, line_no, bill_id, amount)
         VALUES ($1, $2, 9, $3, 1)`,
        [o.organizationId, paid.id, b.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`UPDATE purchases_allocations SET amount = 1 WHERE payment_id = $1`, [paid.id]),
    ).rejects.toThrow();
    // The AP FX identity is enforced: fx_difference = base_relieved − source_base.
    await expect(
      owner.query(
        `INSERT INTO purchases_allocations (organization_id, source_type, payment_id, bill_id, mode,
           allocation_date, currency_code, amount, base_relieved, source_base, fx_difference,
           journal_id, created_by_user_id, created_at)
         SELECT organization_id, source_type, payment_id, bill_id, mode, allocation_date,
           currency_code, amount, base_relieved, source_base, fx_difference + 1, journal_id,
           created_by_user_id, now()
           FROM purchases_allocations WHERE payment_id = $1`,
        [paid.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('gives Administrators every vendor-payment key and Members the view key', async () => {
    const o = await setUpAccountingOrg(ctx);
    const { rows } = await owner.query(
      `SELECT r.name, array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
         FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.organization_id = $1 AND rp.permission_key LIKE 'vendor_payments.%'
        GROUP BY r.name ORDER BY r.name`,
      [o.organizationId],
    );
    const all = [
      'vendor_payments.approve',
      'vendor_payments.create',
      'vendor_payments.view',
      'vendor_payments.void',
    ];
    expect(rows).toEqual([
      { name: 'Administrator', keys: all },
      { name: 'Member', keys: ['vendor_payments.view'] },
      { name: 'Owner', keys: all },
    ]);
  });

  it('links bill, vendor-credit and reversal journals to their documents (P4-10)', async () => {
    const o = await purchasesOrg();
    const b = await postedBill(o, {}, '100');
    const credit = await postedCredit(o);
    expect((await journal(o, (await bill(o, b.id)).journalId)).sourceDocument).toEqual({
      module: 'purchases',
      documentType: 'bill',
      id: b.id,
      number: b.number,
      label: `Bill ${b.number}`,
      path: `/purchases/bills/${b.id}`,
      relation: 'source',
    });
    expect((await journal(o, credit.journalId)).sourceDocument).toMatchObject({
      documentType: 'vendor_credit',
      label: `Vendor credit ${credit.number}`,
    });
    const voided = await o.owner.post(`/purchases/vendor-credits/${credit.id}/void`, {
      version: credit.version,
      reason: 'Duplicate',
    });
    expect((await journal(o, voided.body.data.voidJournalId)).sourceDocument).toMatchObject({
      documentType: 'vendor_credit',
      relation: 'reversal',
    });
  });
});
