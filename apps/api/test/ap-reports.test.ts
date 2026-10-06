import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/application/unit-of-work.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 4B-5: AP aging, vendor statements, the AP reconciliation and the read-only S9 revaluation
 * provider `purchases.payables` (ADR 0004 P4-49, brief §26, decisions PD1–PD7). Positions are
 * derived as of a date from posted documents, allocations and refunds; voided documents drop out;
 * bases are historical; AP reads "what we owe" (bills positive, credits and prepayments negative).
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

const origin = { requestId: 'ap-reports-test', ipAddress: null, userAgent: 'vitest' };
const LATE = '2026-12-31';

async function purchasesOrg() {
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
  return org;
}

async function vendor(o: AccountingOrg, displayName: string, currencyCode = 'MVR') {
  const res = await o.owner.post('/vendors', {
    party: { kind: 'organization', displayName },
    currencyCode,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function rate(o: AccountingOrg, rateDate: string, value: string) {
  const res = await o.owner.post('/accounting/exchange-rates', {
    fromCurrency: 'USD',
    rateDate,
    rate: value,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

interface Doc {
  id: string;
  number: string;
  version: number;
}

async function bill(
  o: AccountingOrg,
  vendorId: string,
  amount: string,
  billDate: string,
  extra: Record<string, unknown> = {},
): Promise<Doc> {
  const created = await o.owner.post('/purchases/bills', {
    vendorId,
    billDate,
    vendorReference: `INV-${randomUUID().slice(0, 8)}`,
    lines: [{ description: 'Stock', quantity: '1', unitPrice: amount, taxCodeId: null }],
    ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const res = await o.owner.post(`/purchases/bills/${created.body.data.id}/post`, {
    version: created.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function credit(
  o: AccountingOrg,
  vendorId: string,
  amount: string,
  creditDate: string,
  creditOrigin: 'supplier_credit_note' | 'debit_note' = 'supplier_credit_note',
  extra: Record<string, unknown> = {},
): Promise<Doc> {
  const created = await o.owner.post('/purchases/vendor-credits', {
    origin: creditOrigin,
    vendorId,
    creditDate,
    ...(creditOrigin === 'supplier_credit_note'
      ? { vendorReference: `CN-${randomUUID().slice(0, 8)}` }
      : {}),
    lines: [{ description: 'Returned goods', quantity: '1', unitPrice: amount, taxCodeId: null }],
    ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const res = await o.owner.post(`/purchases/vendor-credits/${created.body.data.id}/post`, {
    version: created.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function pay(
  o: AccountingOrg,
  vendorId: string,
  body: { paymentDate: string; amount: string; allocations?: { billId: string; amount: string }[] },
  currencyCode?: string,
): Promise<Doc> {
  const draft = await o.owner.post('/purchases/payments', {
    vendorId,
    allocations: [],
    ...(currencyCode ? { currencyCode } : {}),
    ...body,
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const res = await o.owner.post(`/purchases/payments/${draft.body.data.id}/record`, {
    version: draft.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function applyTo(
  o: AccountingOrg,
  sourceType: 'payment' | 'vendor_credit',
  sourceId: string,
  date: string,
  allocations: { billId: string; amount: string }[],
) {
  const res = await o.owner.post('/purchases/credit-applications', {
    sourceType,
    sourceId,
    date,
    allocations,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function refund(
  o: AccountingOrg,
  sourceType: 'payment' | 'vendor_credit',
  sourceId: string,
  amount: string,
  refundDate: string,
): Promise<Doc> {
  const res = await o.owner.post('/purchases/refunds', {
    sourceType,
    sourceId,
    refundDate,
    amount,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function voidDoc(o: AccountingOrg, path: string, id: string) {
  const current = await o.owner.get(`${path}/${id}`);
  const res = await o.owner.post(`${path}/${id}/void`, {
    version: current.body.data.version,
    reason: 'Entered in error',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function report(client: TestClient, path: string) {
  const res = await client.get(`/purchases/reports/${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

const aging = (o: AccountingOrg, asOf: string, vendorId?: string) =>
  report(o.owner, `aging?asOf=${asOf}${vendorId ? `&vendorId=${vendorId}` : ''}`);

const reconciliation = (o: AccountingOrg, asOf: string) =>
  report(o.owner, `ap-reconciliation?asOf=${asOf}`);

/** The reconciliation holds with nothing posted from outside Purchases. */
async function expectReconciled(o: AccountingOrg, asOf: string, glBalance: string) {
  expect(await reconciliation(o, asOf)).toMatchObject({
    glBalance,
    postingsOutsidePurchases: '0.00',
    subledger: { total: glBalance },
    difference: '0.00',
    reconciled: true,
  });
}

/**
 * The as-of positions derived from history equal the stored running balances (amount_due/base_due,
 * amount_unapplied/base_unapplied, amount_unallocated/base_unallocated) for every document.
 */
async function expectConsistent(o: AccountingOrg) {
  const report = await aging(o, LATE);
  const derived = new Map<string, [string, string]>();
  for (const v of report.vendors) {
    for (const b of v.bills) derived.set(b.id, [b.openAmount, b.openBase]);
    for (const c of v.credits) derived.set(c.id, [c.openAmount, c.openBase]);
  }
  const { rows } = await owner.query(
    `SELECT id, amount_due::numeric(28,2)::text AS amount, base_due::numeric(28,2)::text AS base
       FROM purchases_bills WHERE organization_id = $1 AND status = 'POSTED'
     UNION ALL
     SELECT id, amount_unapplied::numeric(28,2)::text, base_unapplied::numeric(28,2)::text
       FROM purchases_vendor_credits WHERE organization_id = $1 AND status = 'POSTED'
     UNION ALL
     SELECT id, amount_unallocated::numeric(28,2)::text, base_unallocated::numeric(28,2)::text
       FROM purchases_payments WHERE organization_id = $1 AND status = 'RECORDED'`,
    [o.organizationId],
  );
  const stored = new Map<string, [string, string]>();
  for (const r of rows as { id: string; amount: string; base: string }[]) {
    if (r.amount !== '0.00' || r.base !== '0.00') stored.set(r.id, [r.amount, r.base]);
  }
  expect(Object.fromEntries(derived)).toEqual(Object.fromEntries(stored));
}

// ---------------------------------------------------------------------------
// AP aging
// ---------------------------------------------------------------------------

describe('AP aging (P4-49, D9)', () => {
  it('buckets open bills by days past due at the exact edges', async () => {
    const o = await purchasesOrg();
    const v = await vendor(o, 'Edge Supplies');
    // Days past due on 2026-06-30 → amount (powers of two keep the sums unambiguous).
    const cases: [string, string, string][] = [
      ['2026-06-30', '1', 'current'], // 0 days
      ['2026-06-29', '2', 'days1to30'], // 1
      ['2026-05-31', '4', 'days1to30'], // 30
      ['2026-05-30', '8', 'days31to60'], // 31
      ['2026-05-01', '16', 'days31to60'], // 60
      ['2026-04-30', '32', 'days61to90'], // 61
      ['2026-04-01', '64', 'days61to90'], // 90
      ['2026-03-31', '128', 'over90'], // 91
      ['2026-07-10', '256', 'current'], // not yet due
    ];
    const ids = new Map<string, string>();
    for (const [dueDate, amount] of cases) {
      ids.set((await bill(o, v, amount, '2026-03-01', { dueDate })).id, dueDate);
    }
    const r = await aging(o, '2026-06-30');
    expect(r.buckets).toEqual(['current', 'days1to30', 'days31to60', 'days61to90', 'over90']);
    expect(r.vendors).toHaveLength(1);
    const row = r.vendors[0];
    expect(row.currencies).toEqual([
      {
        currencyCode: 'MVR',
        current: '257.00',
        days1to30: '6.00',
        days31to60: '24.00',
        days61to90: '96.00',
        over90: '128.00',
        credit: '0.00',
        total: '511.00',
      },
    ]);
    expect(row.base).toMatchObject({ current: '257.00', over90: '128.00', total: '511.00' });
    for (const [dueDate, amount, bucket] of cases) {
      const b = row.bills.find((x: { dueDate: string }) => x.dueDate === dueDate);
      expect(b).toMatchObject({ openAmount: `${amount}.00`, bucket });
    }
    expect(row.bills.find((b: { dueDate: string }) => b.dueDate === '2026-03-31').daysOverdue).toBe(
      91,
    );
    expect(row.bills.find((b: { dueDate: string }) => b.dueDate === '2026-07-10').daysOverdue).toBe(
      0,
    );
    expect(r.totals).toMatchObject({ current: '257.00', over90: '128.00', total: '511.00' });
    // Bills dated after the as-of date are not there yet.
    expect((await aging(o, '2026-02-28')).vendors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Every flow: aging as of dates, statement, reconciliation, consistency
// ---------------------------------------------------------------------------

describe('AP positions through every flow (PD4, PD5, PD7)', () => {
  it('derives aging, statements and the reconciliation from history, with voids dropping out', async () => {
    const o = await purchasesOrg();
    const a = await vendor(o, 'Atoll Supplies');
    const b = await vendor(o, 'Blue Lagoon Imports', 'USD');
    await rate(o, '2026-03-01', '15.40');
    await rate(o, '2026-03-15', '15.50');
    const check = async (gl: string) => {
      await expectReconciled(o, LATE, gl);
      await expectConsistent(o);
    };

    // Bills, including a USD bill at 15.40 and a bill voided while unpaid.
    const a1 = await bill(o, a, '1000', '2026-03-01', { dueDate: '2026-03-31' });
    await check('1000.00');
    const a3 = await bill(o, a, '200', '2026-03-03', { dueDate: '2026-04-02' });
    const a4 = await bill(o, a, '75', '2026-03-04');
    const a2 = await bill(o, a, '500', '2026-03-05', { dueDate: '2026-04-04' });
    const b1 = await bill(o, b, '100', '2026-03-02', {
      currencyCode: 'USD',
      dueDate: '2026-04-01',
    });
    await check('3315.00');
    await voidDoc(o, '/purchases/bills', a4.id);
    await check('3240.00');

    // A partial and a full payment in one payment.
    await pay(o, a, {
      paymentDate: '2026-03-10',
      amount: '900',
      allocations: [
        { billId: a1.id, amount: '400' },
        { billId: a2.id, amount: '500' },
      ],
    });
    await check('2340.00');

    // A vendor credit, partly applied; a prepayment, partly applied and refunded.
    const vc = await credit(o, a, '200', '2026-03-12');
    await check('2140.00');
    await applyTo(o, 'vendor_credit', vc.id, '2026-03-14', [{ billId: a1.id, amount: '150' }]);
    await check('2140.00');
    const p2 = await pay(o, a, { paymentDate: '2026-03-15', amount: '300' });
    await check('1840.00');
    await applyTo(o, 'payment', p2.id, '2026-03-16', [{ billId: a1.id, amount: '100' }]);
    await check('1840.00');
    await refund(o, 'payment', p2.id, '50', '2026-03-18');
    await refund(o, 'vendor_credit', vc.id, '20', '2026-03-19');
    await check('1910.00');

    // An FX payment: 60 USD at 15.50 relieves 60 × 15.40 = 924 (a 6.00 realized loss).
    await pay(
      o,
      b,
      { paymentDate: '2026-03-16', amount: '60', allocations: [{ billId: b1.id, amount: '60' }] },
      'USD',
    );
    await check('986.00');

    // A Pay-bills batch (one MVR and one USD payment); the USD payment is then voided.
    const batch = await o.owner.post('/purchases/payment-batches', {
      paymentDate: '2026-03-20',
      bills: [
        { billId: a3.id, amount: '200' },
        { billId: b1.id, amount: '10' },
      ],
    });
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    await check('632.00');
    const usd = batch.body.data.payments.find(
      (p: { currencyCode: string }) => p.currencyCode === 'USD',
    );
    await voidDoc(o, '/purchases/payments', usd.id);
    await check('786.00');

    // Void paths: a refund, a vendor credit and a prepayment, each recorded then voided.
    const r3 = await refund(o, 'payment', p2.id, '30', '2026-03-21');
    await check('816.00');
    await voidDoc(o, '/purchases/refunds', r3.id);
    const vc2 = await credit(o, a, '25', '2026-03-12');
    await voidDoc(o, '/purchases/vendor-credits', vc2.id);
    const p4 = await pay(o, a, { paymentDate: '2026-03-22', amount: '50' });
    await voidDoc(o, '/purchases/payments', p4.id);
    await check('786.00');

    // A debit note, left unapplied.
    const dn = await credit(o, a, '40', '2026-03-25', 'debit_note');
    await check('746.00');

    // As of 2026-03-09: only the bills (A4 is void, so it never appears).
    const early = await aging(o, '2026-03-09');
    expect(early.totals).toMatchObject({ current: '3240.00', credit: '0.00', total: '3240.00' });
    const earlyA = early.vendors.find((v: { vendorId: string }) => v.vendorId === a);
    expect(earlyA.bills.map((x: { number: string }) => x.number)).toEqual([
      a1.number,
      a3.number,
      a2.number,
    ]);
    await expectReconciled(o, '2026-03-09', '3240.00');

    // As of 2026-03-15: the payment, the credit application and the new prepayment.
    const mid = await aging(o, '2026-03-15');
    const midA = mid.vendors.find((v: { vendorId: string }) => v.vendorId === a);
    expect(midA.bills.map((x: { id: string; openAmount: string }) => [x.id, x.openAmount])).toEqual(
      [
        [a1.id, '450.00'],
        [a3.id, '200.00'],
      ],
    );
    expect(
      midA.credits.map((c: { type: string; id: string; openAmount: string }) => [
        c.type,
        c.id,
        c.openAmount,
      ]),
    ).toEqual([
      ['vendor_credit', vc.id, '50.00'],
      ['payment', p2.id, '300.00'],
    ]);
    expect(mid.totals).toMatchObject({ credit: '-350.00', total: '1840.00' });
    await expectReconciled(o, '2026-03-15', '1840.00');

    // At the end: per vendor and currency, the base column at historical rates (PD7).
    const late = await aging(o, LATE);
    expect(late.vendors.map((v: { vendorName: string }) => v.vendorName)).toEqual([
      'Atoll Supplies',
      'Blue Lagoon Imports',
    ]);
    const lateA = late.vendors[0];
    expect(lateA.currencies).toEqual([
      expect.objectContaining({
        currencyCode: 'MVR',
        over90: '350.00',
        credit: '-220.00',
        total: '130.00',
      }),
    ]);
    // Vendor credits and debit notes first, then prepayments.
    expect(lateA.credits.map((c: { number: string }) => c.number)).toEqual([
      vc.number,
      dn.number,
      p2.number,
    ]);
    expect(lateA.credits.find((c: { id: string }) => c.id === dn.id).origin).toBe('debit_note');
    const lateB = late.vendors[1];
    expect(lateB.currencies).toEqual([
      expect.objectContaining({ currencyCode: 'USD', over90: '40.00', total: '40.00' }),
    ]);
    expect(lateB.base).toMatchObject({ over90: '616.00', total: '616.00' });
    expect(late.totals).toMatchObject({ over90: '966.00', credit: '-220.00', total: '746.00' });
    // The vendor filter.
    expect((await aging(o, LATE, b)).vendors.map((v: { vendorId: string }) => v.vendorId)).toEqual([
      b,
    ]);

    // The statement for Atoll Supplies (PD4): bills +, credits/debit notes −, payments −, refunds +.
    const st = await report(o.owner, `statement?vendorId=${a}&from=2026-03-11&to=2026-03-31`);
    expect(st.currencies).toHaveLength(1);
    const mvr = st.currencies[0];
    // Brought forward: 1000 + 200 + 500 − 900 (A4 is void).
    expect(mvr.openingBalance).toBe('800.00');
    expect(
      mvr.lines.map((l: { type: string; date: string; amount: string; balance: string }) => [
        l.type,
        l.date,
        l.amount,
        l.balance,
      ]),
    ).toEqual([
      ['vendor_credit', '2026-03-12', '-200.00', '600.00'],
      ['payment', '2026-03-15', '-300.00', '300.00'],
      ['refund', '2026-03-18', '50.00', '350.00'],
      ['refund', '2026-03-19', '20.00', '370.00'],
      ['payment', '2026-03-20', '-200.00', '170.00'],
      ['vendor_credit', '2026-03-25', '-40.00', '130.00'],
    ]);
    expect(mvr.lines.at(-1).origin).toBe('debit_note');
    expect(mvr.closingBalance).toBe('130.00');
    expect(mvr.openBills).toEqual([
      {
        id: a1.id,
        number: a1.number,
        dueDate: '2026-03-31',
        bucket: 'current',
        openAmount: '350.00',
      },
    ]);
    // The closing balance is the open position at the end date.
    const atEnd = await aging(o, '2026-03-31', a);
    expect(atEnd.vendors[0].currencies[0].total).toBe(mvr.closingBalance);

    // The USD vendor: the statement is in USD; the batch payment is void and omitted.
    const stB = await report(o.owner, `statement?vendorId=${b}&from=2026-03-01&to=2026-03-31`);
    expect(
      stB.currencies[0].lines.map((l: { type: string; amount: string }) => [l.type, l.amount]),
    ).toEqual([
      ['bill', '100.00'],
      ['payment', '-60.00'],
    ]);
    expect(stB.currencies[0]).toMatchObject({ currencyCode: 'USD', closingBalance: '40.00' });
  });
});

// ---------------------------------------------------------------------------
// The S9 provider `purchases.payables` (PD6)
// ---------------------------------------------------------------------------

async function principalOf(client: TestClient) {
  const found = await ctx.services.auth.authenticate(client.sessionToken!, origin);
  if (!found) throw new Error('no session');
  return found;
}

async function journalLines(o: AccountingOrg, journalId: string) {
  const j = (await o.owner.get(`/accounting/journals/${journalId}`)).body.data as {
    lines: { accountId: string; baseDebit: string | null; baseCredit: string | null }[];
  };
  return j.lines.map((l) => [l.accountId, l.baseDebit, l.baseCredit]);
}

describe('AP revaluation provider purchases.payables (PD6)', () => {
  it('reports AP exposure to S9 with AP signs; S9 posts, reconciles and cancels; AR is unchanged', async () => {
    const o = await purchasesOrg();
    // Sales too, so AR and AP are revalued in the same run.
    const sales = await o.owner.put('/sales/settings', {
      version: 0,
      arAccountId: o.accounts['1130'],
      defaultRevenueAccountId: o.accounts['4100'],
      defaultDepositAccountId: o.accounts['1120'],
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'no_tax',
      defaultPaymentTermsDays: 0,
    });
    expect(sales.status, JSON.stringify(sales.body)).toBe(200);
    const customer = await o.owner.post('/customers', {
      party: { kind: 'organization', displayName: 'Reef Divers' },
      currencyCode: 'USD',
    });
    const v = await vendor(o, 'Blue Lagoon Imports', 'USD');
    const local = await vendor(o, 'Atoll Supplies');
    await rate(o, '2026-03-01', '15.70');

    // 100 USD bill at 15.70: carrying −1,570 on AP.
    const usdBill = await bill(o, v, '100', '2026-03-02', { currencyCode: 'USD' });
    await bill(o, local, '400', '2026-03-02'); // base currency: excluded
    const prepayment = await pay(o, v, { paymentDate: '2026-03-05', amount: '30' }, 'USD');
    const vc = await credit(o, v, '20', '2026-03-06', 'supplier_credit_note', {
      currencyCode: 'USD',
    });
    const invoice = await o.owner.post('/sales/invoices', {
      customerId: customer.body.data.id,
      invoiceDate: '2026-03-05',
      lines: [{ description: 'Dive package', quantity: '1', unitPrice: '500' }],
    });
    expect(
      (
        await o.owner.post(`/sales/invoices/${invoice.body.data.id}/issue`, {
          version: invoice.body.data.version,
        })
      ).status,
    ).toBe(200);
    // AP: 1570 + 400 − 471 − 314.
    await expectReconciled(o, '2026-03-31', '1185.00');
    const arBefore = (await o.owner.get('/sales/reports/ar-reconciliation?asOf=2026-03-31')).body
      .data;

    await rate(o, '2026-03-31', '15.80');
    const journalsBefore = await owner.query(
      'SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1',
      [o.organizationId],
    );
    const owner1 = await principalOf(o.owner);
    const preview = await ctx.services.revaluations.preview(owner1, {
      revaluationDate: '2026-03-31',
    });
    expect(preview.errors).toEqual([]);
    const documents = preview.lines.filter((l) => l.exposureKind === 'DOCUMENT');
    const ap = documents.filter((l) => l.accountId === o.accounts['2110']);
    const values = (l: (typeof ap)[number]) =>
      [l.foreignBalance, l.carryingBase, l.revaluedBase, l.adjustment].map(Number);
    expect(ap.map(values).sort((x, y) => x[0]! - y[0]!)).toEqual([
      // The 100 USD bill: −1,570 → −1,580, an adjustment of −10 (a loss).
      [-100, -1570, -1580, -10],
      // The vendor credit and the prepayment are vendor debit balances (gains).
      [20, 314, 316, 2],
      [30, 471, 474, 3],
    ]);
    // AR is reported exactly as before: the USD invoice on the AR control account.
    expect(
      documents
        .filter((l) => l.accountId === o.accounts['1130'])
        .map((l) => [l.foreignBalance, l.carryingBase, l.adjustment].map(Number)),
    ).toEqual([[500, 7850, 50]]);
    // The provider itself reports the three AP documents (credit-negative bill).
    const reported = await inTransaction(
      ctx.database.db,
      { organizationId: o.organizationId },
      (tx) =>
        ctx.services.apReports.listExposures(tx, {
          organizationId: o.organizationId,
          revaluationDate: '2026-03-31',
          baseCurrency: 'MVR',
        }),
    );
    expect(reported.map((d) => [d.documentType, d.foreignBalance, d.carryingBase]).sort()).toEqual(
      [
        ['bill', '-100.0000', '-1570.0000'],
        ['payment', '30.0000', '471.0000'],
        ['vendor_credit', '20.0000', '314.0000'],
      ].sort(),
    );
    expect(new Set(reported.map((d) => d.controlAccountId))).toEqual(new Set([o.accounts['2110']]));
    // The provider is read-only: the preview wrote nothing.
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1',
          [o.organizationId],
        )
      ).rows[0].n,
    ).toBe(journalsBefore.rows[0].n);

    const run = await ctx.services.revaluations.post(
      owner1,
      { revaluationDate: '2026-03-31' },
      origin,
    );
    expect(run.status, JSON.stringify(run)).toBe('POSTED');
    expect(
      run.lines
        .filter((l) => l.document?.module === 'purchases')
        .map((l) => l.document!.type)
        .sort(),
    ).toEqual(['bill', 'payment', 'vendor_credit']);
    expect(run.lines.find((l) => l.document?.id === usdBill.id)?.adjustment).toBe('-10');
    expect(run.lines.find((l) => l.document?.id === prepayment.id)?.adjustment).toBe('3');
    expect(run.lines.find((l) => l.document?.id === vc.id)?.adjustment).toBe('2');
    // One aggregated line per account (the 500-line cap stays safe): AP net −5 is a credit.
    const revaluation = run.journals.find((j) => j.role === 'REVALUATION')!;
    const lines = await journalLines(o, revaluation.journalId);
    expect(lines.filter((l) => l[0] === o.accounts['2110'])).toEqual([
      [o.accounts['2110'], null, '5.0000'],
    ]);

    // The adjustment is a reconciling item: GL 1,190 − 5 = 1,185 subledger.
    expect(await reconciliation(o, '2026-03-31')).toMatchObject({
      glBalance: '1190.00',
      revaluationAdjustments: '5.00',
      postingsOutsidePurchases: '0.00',
      subledger: { total: '1185.00' },
      difference: '0.00',
      reconciled: true,
    });
    // Reversed on D + 1.
    expect(await reconciliation(o, '2026-04-01')).toMatchObject({
      glBalance: '1185.00',
      revaluationAdjustments: '0.00',
      reconciled: true,
    });
    // The aging keeps historical bases (PD7).
    const usdRow = (await aging(o, '2026-03-31', v)).vendors[0];
    expect(usdRow.bills[0].openBase).toBe('1570.00');
    // AR still reconciles, with its own adjustment as before.
    expect(
      (await o.owner.get('/sales/reports/ar-reconciliation?asOf=2026-03-31')).body.data,
    ).toMatchObject({
      reconciled: true,
      revaluationAdjustments: '50.00',
      subledger: arBefore.subledger,
    });

    // Cancelling the run removes the adjustment; the reconciliation returns to its prior state.
    const cancelled = await ctx.services.revaluations.cancel(
      owner1,
      run.id,
      { version: run.version, reason: 'Test run' },
      origin,
    );
    expect(cancelled.status).toBe('REVERSED');
    expect(await reconciliation(o, '2026-03-31')).toMatchObject({
      glBalance: '1185.00',
      revaluationAdjustments: '0.00',
      reconciled: true,
    });
  });

  it('reports nothing without an AP control account', async () => {
    const o = await setUpAccountingOrg(ctx);
    const exposures = await inTransaction(
      ctx.database.db,
      { organizationId: o.organizationId },
      (tx) =>
        ctx.services.apReports.listExposures(tx, {
          organizationId: o.organizationId,
          revaluationDate: '2026-03-31',
          baseCurrency: 'MVR',
        }),
    );
    expect(exposures).toEqual([]);
    // And the reconciliation asks for the account (AR parity: 409).
    const res = await o.owner.get('/purchases/reports/ap-reconciliation?asOf=2026-03-31');
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Security and validation
// ---------------------------------------------------------------------------

describe('AP report access (PD3)', () => {
  it('needs purchases.reports.view, isolates tenants and validates strictly', async () => {
    const o = await purchasesOrg();
    const v = await vendor(o, 'Atoll Supplies');
    await bill(o, v, '100', '2026-03-02');
    const paths = [
      'aging?asOf=2026-03-31',
      `statement?vendorId=${v}&from=2026-03-01&to=2026-03-31`,
      'ap-reconciliation?asOf=2026-03-31',
    ];
    // The Member template holds the key in new organizations (P4-40).
    const member = await joinWithRole(ctx, o.owner, 'Member');
    for (const path of paths) {
      expect((await member.client.get(`/purchases/reports/${path}`)).status).toBe(200);
    }
    // A custom role without it is refused; custom roles never receive it silently.
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Bill clerk',
      permissionKeys: ['bills.view', 'vendor_payments.view', 'vendors.view'],
    });
    expect(role.status).toBe(201);
    const clerk = await joinWithRole(ctx, o.owner, 'Bill clerk');
    for (const path of paths) {
      expect((await clerk.client.get(`/purchases/reports/${path}`)).status).toBe(403);
    }

    // Another organization's vendor is not found.
    const other = await purchasesOrg();
    const foreign = await vendor(other, 'Elsewhere Ltd');
    expect(
      (
        await o.owner.get(
          `/purchases/reports/statement?vendorId=${foreign}&from=2026-03-01&to=2026-03-31`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await o.owner.get(`/purchases/reports/aging?asOf=2026-03-31&vendorId=${foreign}`)).status,
    ).toBe(404);
    // And it sees none of this organization's documents.
    expect((await aging(other, '2026-03-31')).vendors).toEqual([]);

    // Strict queries.
    for (const path of [
      'aging',
      'aging?asOf=2026-03-31&extra=1',
      'aging?asOf=31-03-2026',
      `statement?vendorId=${v}&from=2026-03-31&to=2026-03-01`,
      `statement?vendorId=${v}&from=2026-03-01`,
      'ap-reconciliation?asOf=2026-03-31&vendorId=x',
    ]) {
      expect((await o.owner.get(`/purchases/reports/${path}`)).status, path).toBe(400);
    }
    const reversed = await o.owner.get(
      `/purchases/reports/statement?vendorId=${v}&from=2026-03-31&to=2026-03-01`,
    );
    expect(reversed.body.error.details.issues).toEqual([
      { path: 'from', message: 'The start date is after the end date.' },
    ]);
  });
});
