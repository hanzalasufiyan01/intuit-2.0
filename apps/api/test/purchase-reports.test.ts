import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/application/unit-of-work.js';
import { decimal } from '../src/domain/money.js';
import {
  attributeGroupBase,
  attributePurchaseDocument,
  buildPurchaseJournal,
} from '../src/modules/documents/index.js';
import {
  compareRegisterRows,
  limitRegister,
  PAYMENT_REGISTER_LIMIT,
  registerRefunds,
} from '../src/modules/purchases/index.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 4B-6: unpaid bills, purchases by vendor, item and account, the input-tax summary and the
 * payment register (ADR 0004 P4-49; PD1–PD12 and the PD4 clarification "Canonical Group Base
 * Attribution"). Read-only; base values come from the canonical purchase journal.
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

// ---------------------------------------------------------------------------
// Canonical Group Base Attribution (pure)
// ---------------------------------------------------------------------------

describe('Canonical Group Base Attribution (PD4 clarification)', () => {
  const rate = decimal('15.50');

  it('attributes 0.03 + 0.03 at 15.50 deterministically to the canonical 0.93', () => {
    // Canonical: round(0.06 × 15.50) = 0.93; provisional per line 0.47 + 0.47 = 0.94.
    const shares = attributeGroupBase(
      decimal('0.93'),
      [decimal('0.03'), decimal('0.03')],
      rate,
      'MVR',
    );
    expect(shares.map((s) => s.toFixed(2))).toEqual(['0.46', '0.47']);
    // Same input, same output.
    expect(
      attributeGroupBase(decimal('0.93'), [decimal('0.03'), decimal('0.03')], rate, 'MVR').map(
        (s) => s.toFixed(2),
      ),
    ).toEqual(['0.46', '0.47']);
    // The residue goes to the largest member, not the first.
    expect(
      attributeGroupBase(decimal('1.08'), [decimal('0.03'), decimal('0.04')], rate, 'MVR').map(
        (s) => s.toFixed(2),
      ),
    ).toEqual(['0.47', '0.61']);
  });

  it('reproduces the canonical journal and sums every attribution exactly to its group', () => {
    const lines = [
      // Two lines sharing account A (one canonical group), one with recoverable tax.
      { lineNo: 1, accountId: 'A', net: '0.03', rec: '0.01', nonRec: '0', tax: 'GST' },
      { lineNo: 2, accountId: 'A', net: '0.03', rec: '0', nonRec: '0.01', tax: 'TGST' },
      { lineNo: 3, accountId: 'B', net: '10.07', rec: '0.81', nonRec: '0', tax: 'GST' },
    ].map((l) => ({
      lineNo: l.lineNo,
      accountId: l.accountId,
      dimensionValueIds: [],
      netAmount: decimal(l.net),
      recoverableTax: decimal(l.rec),
      nonRecoverableTax: decimal(l.nonRec),
      taxCodeId: l.tax,
      inputTaxAccountId: 'INPUT',
    }));
    const input = {
      direction: 'bill' as const,
      currency: 'USD',
      baseCurrency: 'MVR',
      rate,
      documentDimensionValueIds: [],
      typeOf: new Map<string, string>(),
      lines,
    };
    const { groups, lines: attributed } = attributePurchaseDocument(input);
    // The same builder posting uses: identical group bases.
    const journal = buildPurchaseJournal({
      direction: 'bill',
      documentLabel: '',
      apAccountId: null,
      documentDimensionValueIds: [],
      typeOf: new Map(),
      lines: lines.map((l) => ({
        accountId: l.accountId,
        dimensionValueIds: [],
        net: l.netAmount,
        nonRecoverableTax: l.nonRecoverableTax,
      })),
      inputTaxes: lines
        .filter((l) => !l.recoverableTax.isZero())
        .map((l) => ({
          taxCodeId: l.taxCodeId,
          label: '',
          accountId: 'INPUT',
          amount: l.recoverableTax,
        })),
      currency: 'USD',
      baseCurrency: 'MVR',
      rate,
    });
    expect(groups.expense.map((g) => g.base.toFixed(2))).toEqual(
      journal.lines.filter((l) => l.role === 'expense').map((l) => l.baseAmount.toFixed(2)),
    );
    expect(groups.tax.map((g) => g.base.toFixed(2))).toEqual(
      journal.lines.filter((l) => l.role === 'tax').map((l) => l.baseAmount.toFixed(2)),
    );
    expect(groups.baseTotal.toFixed(2)).toBe(journal.baseTotal.toFixed(2));
    const byNo = new Map(attributed.map((a) => [a.lineNo, a]));
    // Members sum exactly to each canonical group.
    for (const g of groups.expense) {
      const sum = g.lineNos.reduce((s, n) => s.plus(byNo.get(n)!.costBase), decimal(0));
      expect(sum.toFixed(2)).toBe(g.base.toFixed(2));
    }
    for (const g of groups.tax) {
      const sum = g.lineNos.reduce((s, n) => s.plus(byNo.get(n)!.recoverableTaxBase), decimal(0));
      expect(sum.toFixed(2)).toBe(g.base.toFixed(2));
    }
    // netBase + nonRecoverableTaxBase = costBase, and every line sums to the document total.
    for (const a of attributed) {
      expect(a.netBase.plus(a.nonRecoverableTaxBase).toFixed(2)).toBe(a.costBase.toFixed(2));
    }
    const all = attributed.reduce(
      (s, a) => s.plus(a.costBase).plus(a.recoverableTaxBase),
      decimal(0),
    );
    expect(all.toFixed(2)).toBe(groups.baseTotal.toFixed(2));
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Org extends AccountingOrg {
  gst: string;
  tgst: string;
}

async function purchasesOrg(): Promise<Org> {
  const org = await setUpAccountingOrg(ctx);
  const codes = (await org.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
  const profile = await org.owner.put('/organizations/current/profile', {
    version:
      (await org.owner.get('/organizations/current/profile')).body.data.profile?.version ?? 0,
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
  return {
    ...org,
    gst: codes.find((c) => c.code === 'GST')!.id,
    tgst: codes.find((c) => c.code === 'TGST')!.id,
  };
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

type Line = Record<string, unknown>;
const line = (unitPrice: string, extra: Line = {}): Line => ({
  description: 'Purchase',
  quantity: '1',
  unitPrice,
  taxCodeId: null,
  ...extra,
});

interface Doc {
  id: string;
  number: string;
  version: number;
  journalId: string;
}

async function bill(
  o: AccountingOrg,
  vendorId: string,
  billDate: string,
  lines: Line[],
  extra: Record<string, unknown> = {},
): Promise<Doc> {
  const created = await o.owner.post('/purchases/bills', {
    vendorId,
    billDate,
    vendorReference: `INV-${randomUUID().slice(0, 8)}`,
    lines,
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
  creditDate: string,
  lines: Line[],
  creditOrigin: 'supplier_credit_note' | 'debit_note' = 'supplier_credit_note',
): Promise<Doc> {
  const created = await o.owner.post('/purchases/vendor-credits', {
    origin: creditOrigin,
    vendorId,
    creditDate,
    ...(creditOrigin === 'supplier_credit_note'
      ? { vendorReference: `CN-${randomUUID().slice(0, 8)}` }
      : {}),
    lines,
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
  body: Record<string, unknown>,
): Promise<Doc> {
  const draft = await o.owner.post('/purchases/payments', { vendorId, allocations: [], ...body });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const res = await o.owner.post(`/purchases/payments/${draft.body.data.id}/record`, {
    version: draft.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
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

/** GL movement (base, debit-positive) on an account from journals dated in a period. */
async function glMovement(o: AccountingOrg, accountId: string, from: string, to: string) {
  const { rows } = await owner.query(
    `SELECT coalesce(sum(coalesce(l.base_debit,0) - coalesce(l.base_credit,0)), 0)::numeric(28,2)::text AS v
       FROM accounting_journal_lines l JOIN accounting_journal_entries j ON j.id = l.journal_id
      WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED','REVERSED')
        AND j.entry_date BETWEEN $3 AND $4`,
    [o.organizationId, accountId, from, to],
  );
  return rows[0].v as string;
}

async function inputTaxAccount(o: Org) {
  const code = (await o.owner.get('/tax/codes')).body.data.find(
    (c: { id: string }) => c.id === o.gst,
  );
  return code.inputTaxAccountId as string;
}

// ---------------------------------------------------------------------------
// Unpaid bills (PD1, PD3)
// ---------------------------------------------------------------------------

describe('unpaid bills (PD1, PD3)', () => {
  it('groups open bills in relative 7-day windows and equals the AP aging bills', async () => {
    const o = await purchasesOrg();
    const v = await vendor(o, 'Atoll Supplies');
    const asOf = '2026-03-31';
    // Due date → expected bucket (days until due from 2026-03-31).
    const cases: [string, string, string][] = [
      ['2026-03-20', '1', 'overdue'],
      ['2026-03-31', '2', 'days0to7'], // 0
      ['2026-04-07', '4', 'days0to7'], // 7
      ['2026-04-08', '8', 'days8to14'], // 8
      ['2026-04-14', '16', 'days8to14'], // 14
      ['2026-04-15', '32', 'days15to21'], // 15
      ['2026-04-22', '64', 'days22to28'], // 22
      ['2026-04-28', '128', 'days22to28'], // 28
      ['2026-04-29', '256', 'later'], // 29
    ];
    const docs: Doc[] = [];
    for (const [dueDate, amount] of cases) {
      docs.push(await bill(o, v, '2026-03-02', [line(amount)], { dueDate }));
    }
    // A partial payment, a full payment, an applied credit; an unapplied credit and an unapplied
    // prepayment that do not reduce any bill; a voided bill; a bill dated after the as-of date.
    await pay(o, v, {
      paymentDate: '2026-03-10',
      amount: '256',
      allocations: [
        { billId: docs[8]!.id, amount: '200' },
        { billId: docs[0]!.id, amount: '1' },
      ],
    });
    const applied = await credit(o, v, '2026-03-11', [line('5')]);
    const res = await o.owner.post('/purchases/credit-applications', {
      sourceType: 'vendor_credit',
      sourceId: applied.id,
      date: '2026-03-12',
      allocations: [{ billId: docs[7]!.id, amount: '5' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await credit(o, v, '2026-03-13', [line('7')]);
    await pay(o, v, { paymentDate: '2026-03-14', amount: '9' });
    const voided = await bill(o, v, '2026-03-02', [line('500')], { dueDate: '2026-04-01' });
    await voidDoc(o, '/purchases/bills', voided.id);
    await bill(o, v, '2026-04-02', [line('1000')], { dueDate: '2026-04-03' });

    const r = await report(o.owner, `unpaid-bills?asOf=${asOf}`);
    expect(r.buckets.map((b: { key: string }) => b.key)).toEqual([
      'overdue',
      'days0to7',
      'days8to14',
      'days15to21',
      'days22to28',
      'later',
    ]);
    expect(
      r.buckets.map((b: { from: string | null; to: string | null }) => [b.from, b.to]),
    ).toEqual([
      [null, '2026-03-30'],
      ['2026-03-31', '2026-04-07'],
      ['2026-04-08', '2026-04-14'],
      ['2026-04-15', '2026-04-21'],
      ['2026-04-22', '2026-04-28'],
      ['2026-04-29', null],
    ]);
    const bucketOf = new Map<string, string>();
    const openOf = new Map<string, string>();
    for (const b of r.buckets) {
      for (const x of b.bills) {
        bucketOf.set(x.id, b.key);
        openOf.set(x.id, x.openAmount);
      }
    }
    // The fully paid overdue bill is gone; the rest sit in their windows.
    expect(bucketOf.has(docs[0]!.id)).toBe(false);
    cases.slice(1).forEach(([, , key], i) => expect(bucketOf.get(docs[i + 1]!.id)).toBe(key));
    // Partial payment and applied credit reduce; unapplied credits and prepayments do not.
    expect(openOf.get(docs[8]!.id)).toBe('56.00');
    expect(openOf.get(docs[7]!.id)).toBe('123.00');
    expect(openOf.get(docs[6]!.id)).toBe('64.00');
    expect(bucketOf.has(voided.id)).toBe(false);
    expect(r.buckets.find((b: { key: string }) => b.key === 'days22to28')).toMatchObject({
      base: '187.00',
      currencies: [{ currencyCode: 'MVR', amount: '187.00' }],
    });
    // 2 + 4 + 8 + 16 + 32 + 64 + 123 + 56 = 305.
    expect(r.totals).toEqual({
      currencies: [{ currencyCode: 'MVR', amount: '305.00' }],
      base: '305.00',
    });
    // Equal to the AP aging's bills (total less the credit column) on the same date.
    const aging = await report(o.owner, `aging?asOf=${asOf}`);
    expect(decimal(aging.totals.total).minus(decimal(aging.totals.credit)).toFixed(2)).toBe(
      r.totals.base,
    );
  });
});

// ---------------------------------------------------------------------------
// Purchases by vendor, item and account; input tax (PD2, PD4, PD5, PD10, PD12)
// ---------------------------------------------------------------------------

describe('purchase analysis and input tax', () => {
  it('reports canonical bases that reconcile exactly to the documents and the GL', async () => {
    const o = await purchasesOrg();
    const v1 = await vendor(o, 'Atoll Supplies');
    const v2 = await vendor(o, 'Blue Lagoon Imports', 'USD');
    await rate(o, '2026-03-01', '15.50');
    const item = async (name: string) => {
      const res = await o.owner.post('/sales/items', {
        name,
        itemType: 'product',
        isSold: false,
        isPurchased: true,
        expenseAccountId: o.accounts['5400'],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.data.id as string;
    };
    const paper = await item('Paper');
    const ink = await item('Ink');
    const a5400 = o.accounts['5400']!;
    const a1510 = o.accounts['1510']!;

    // Bill A (MVR): Paper 2 × 50 with recoverable GST 8%; an account line 30 with non-recoverable
    // TGST 17% (5.10), capitalized into 1510.
    const billA = await bill(o, v1, '2026-03-10', [
      line('50', { quantity: '2', itemId: paper, accountId: a5400, taxCodeId: o.gst }),
      line('30', { accountId: a1510, taxCodeId: o.tgst, taxRecoverable: false }),
    ]);
    // Bill B (USD 15.50): 0.03 + 0.03 on one account — the canonical 0.93.
    const billB = await bill(
      o,
      v2,
      '2026-03-11',
      [
        line('0.03', { itemId: paper, accountId: a5400 }),
        line('0.03', { itemId: ink, accountId: a5400 }),
      ],
      { currencyCode: 'USD' },
    );
    // A supplier credit (Paper 1 × 50 with GST) and a debit note (account line 10).
    const vc = await credit(o, v1, '2026-03-12', [
      line('50', { itemId: paper, accountId: a5400, taxCodeId: o.gst }),
    ]);
    const dn = await credit(o, v1, '2026-03-13', [line('10', { accountId: a1510 })], 'debit_note');
    // Out of the reports: a voided bill, an April bill and a draft.
    const voided = await bill(o, v1, '2026-03-14', [line('999', { accountId: a5400 })]);
    await voidDoc(o, '/purchases/bills', voided.id);
    await bill(o, v1, '2026-04-02', [line('777', { accountId: a5400 })]);
    expect(
      (
        await o.owner.post('/purchases/bills', {
          vendorId: v1,
          billDate: '2026-03-15',
          lines: [line('555')],
        })
      ).status,
    ).toBe(201);
    // A later GST rate effective 2026-03-01: posted snapshots keep 8%; new bills get 10%.
    const added = await o.owner.post(`/tax/codes/${o.gst}/rates`, {
      rate: '10',
      effectiveFrom: '2026-03-01',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const billC = await bill(o, v1, '2026-03-20', [
      line('100', { accountId: a5400, taxCodeId: o.gst }),
    ]);

    const period = 'from=2026-03-01&to=2026-03-31';
    // Documents' canonical base totals (the AP line): A 143.10, B 0.93, VC −54, DN −10, C 110.
    const byVendor = await report(o.owner, `purchases-by-vendor?${period}`);
    expect(byVendor.vendors).toEqual([
      {
        vendorId: v1,
        vendorName: 'Atoll Supplies',
        bills: 2,
        credits: 2,
        net: '170.00',
        recoverableTax: '14.00',
        nonRecoverableTax: '5.10',
        cost: '175.10',
        tax: '19.10',
        total: '189.10',
      },
      {
        vendorId: v2,
        vendorName: 'Blue Lagoon Imports',
        bills: 1,
        credits: 0,
        net: '0.93',
        recoverableTax: '0.00',
        nonRecoverableTax: '0.00',
        cost: '0.93',
        tax: '0.00',
        total: '0.93',
      },
    ]);
    expect(byVendor.totals.total).toBe('190.03');
    // Vendor totals equal the documents' canonical base totals (signed).
    const { rows: docTotals } = await owner.query(
      `SELECT (SELECT sum(base_total) FROM purchases_bills WHERE id = ANY($1))
            - (SELECT sum(base_total) FROM purchases_vendor_credits WHERE id = ANY($2)) AS v`,
      [
        [billA.id, billB.id, billC.id],
        [vc.id, dn.id],
      ],
    );
    expect(decimal(docTotals[0].v).toFixed(2)).toBe(byVendor.totals.total);
    // The vendor filter.
    expect(
      (await report(o.owner, `purchases-by-vendor?${period}&vendorId=${v2}`)).vendors.map(
        (x: { vendorId: string }) => x.vendorId,
      ),
    ).toEqual([v2]);

    // By item: the pathological pair split 0.46 / 0.47 (residue on the first of equal lines).
    const byItem = await report(o.owner, `purchases-by-item?${period}`);
    expect(
      byItem.items.map(
        (i: {
          name: string | null;
          quantity: string;
          lines: number;
          net: string;
          recoverableTax: string;
          nonRecoverableTax: string;
        }) => [i.name, i.quantity, i.lines, i.net, i.recoverableTax, i.nonRecoverableTax],
      ),
    ).toEqual([
      ['Ink', '1', 1, '0.47', '0.00', '0.00'],
      ['Paper', '2', 3, '50.46', '4.00', '0.00'],
      // Account-based lines (PD10): 30 − 10 + 100.
      [null, '1', 3, '120.00', '10.00', '5.10'],
    ]);
    expect(byItem.items.at(-1).itemId).toBeNull();
    // Item totals add up to the canonical USD group (0.93).
    expect(decimal(byItem.items[0].net).plus(decimal('0.46')).toFixed(2)).toBe('0.93');
    expect(byItem.totals).toEqual(byVendor.totals);

    // By account: cost = net + non-recoverable tax (PD2); equal to the GL movement exactly.
    const byAccount = await report(o.owner, `purchases-by-account?${period}`);
    const rows = Object.fromEntries(
      byAccount.accounts.map(
        (a: { accountId: string; net: string; nonRecoverableTax: string; cost: string }) => [
          a.accountId,
          [a.net, a.nonRecoverableTax, a.cost],
        ],
      ),
    );
    expect(rows).toEqual({
      [a5400]: ['150.93', '0.00', '150.93'],
      [a1510]: ['20.00', '5.10', '25.10'],
    });
    expect(byAccount.totals).toEqual({
      net: '170.93',
      nonRecoverableTax: '5.10',
      cost: '176.03',
      recoverableTax: '14.00',
    });
    expect(await glMovement(o, a5400, '2026-03-01', '2026-03-31')).toBe('150.93');
    expect(await glMovement(o, a1510, '2026-03-01', '2026-03-31')).toBe('25.10');
    // The AP control account never appears.
    expect(Object.keys(rows)).not.toContain(o.accounts['2110']);

    // Input tax by code and snapshotted rate; equal to the input-tax account's GL movement.
    const tax = await report(o.owner, `input-tax-summary?${period}`);
    expect(tax.reviewOnly).toBe(true);
    expect(
      tax.codes.map(
        (c: {
          code: string | null;
          rate: string | null;
          taxable: string;
          recoverableTax: string;
          nonRecoverableTax: string;
          tax: string;
        }) => [c.code, c.rate, c.taxable, c.recoverableTax, c.nonRecoverableTax, c.tax],
      ),
    ).toEqual([
      ['GST', '8', '50.00', '4.00', '0.00', '4.00'],
      ['GST', '10', '100.00', '10.00', '0.00', '10.00'],
      ['TGST', '17', '30.00', '0.00', '5.10', '5.10'],
      [null, null, '-9.07', '0.00', '0.00', '0.00'],
    ]);
    expect(tax.totals).toEqual({
      taxable: '170.93',
      recoverableTax: '14.00',
      nonRecoverableTax: '5.10',
      tax: '19.10',
    });
    expect(await glMovement(o, await inputTaxAccount(o), '2026-03-01', '2026-03-31')).toBe(
      tax.totals.recoverableTax,
    );
  });
});

// ---------------------------------------------------------------------------
// Payment register (PD6, PD7, PD8, PD11)
// ---------------------------------------------------------------------------

describe('payment register (PD6–PD8)', () => {
  it('lists payments with their own allocations and FX, refunds apart, voids flagged', async () => {
    const o = await purchasesOrg();
    const v1 = await vendor(o, 'Atoll Supplies');
    const v2 = await vendor(o, 'Blue Lagoon Imports', 'USD');
    await rate(o, '2026-03-01', '15.40');
    await rate(o, '2026-03-15', '15.50');
    const b1 = await bill(o, v1, '2026-03-02', [line('100')]);
    const b2 = await bill(o, v1, '2026-03-03', [line('300')]);
    const b3 = await bill(o, v2, '2026-03-02', [line('100')], { currencyCode: 'USD' });
    const b4 = await bill(o, v1, '2026-03-04', [line('40')]);

    // A full MVR payment; a partial USD payment with FX (60 × 15.50 − 60 × 15.40 = 6.00 loss).
    const p1 = await pay(o, v1, {
      paymentDate: '2026-03-10',
      amount: '100',
      allocations: [{ billId: b1.id, amount: '100' }],
    });
    const p2 = await pay(o, v2, {
      paymentDate: '2026-03-16',
      currencyCode: 'USD',
      amount: '60',
      allocations: [{ billId: b3.id, amount: '60' }],
    });
    // A prepayment with part applied on its own record, the rest applied later (not a row).
    const p3 = await pay(o, v1, {
      paymentDate: '2026-03-17',
      amount: '250',
      allocations: [{ billId: b2.id, amount: '100' }],
    });
    const applied = await o.owner.post('/purchases/credit-applications', {
      sourceType: 'payment',
      sourceId: p3.id,
      date: '2026-03-18',
      allocations: [{ billId: b2.id, amount: '50' }],
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    // A batch payment, and a voided payment.
    const batch = await o.owner.post('/purchases/payment-batches', {
      paymentDate: '2026-03-20',
      bills: [{ billId: b4.id, amount: '40' }],
    });
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    const p5 = await pay(o, v1, { paymentDate: '2026-03-21', amount: '70' });
    await voidDoc(o, '/purchases/payments', p5.id);
    // Refunds: one recorded, one voided.
    const refund = await o.owner.post('/purchases/refunds', {
      sourceType: 'payment',
      sourceId: p3.id,
      refundDate: '2026-03-22',
      amount: '30',
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    const refund2 = await o.owner.post('/purchases/refunds', {
      sourceType: 'payment',
      sourceId: p3.id,
      refundDate: '2026-03-23',
      amount: '10',
    });
    expect(refund2.status).toBe(201);
    await voidDoc(o, '/purchases/refunds', refund2.body.data.id);

    const r = await report(o.owner, 'payment-register?from=2026-03-01&to=2026-03-31');
    expect(r).toMatchObject({ limit: 2000, truncated: false });
    const batchPayment = batch.body.data.payments[0];
    expect(
      r.payments.map(
        (p: {
          number: string;
          status: string;
          amount: string;
          baseAmount: string;
          appliedToBills: string;
          prepayment: string;
          realizedFx: string;
          paymentBatchId: string | null;
        }) => [
          p.number,
          p.status,
          p.amount,
          p.baseAmount,
          p.appliedToBills,
          p.prepayment,
          p.realizedFx,
          p.paymentBatchId,
        ],
      ),
    ).toEqual([
      [p1.number, 'RECORDED', '100.00', '100.00', '100.00', '0.00', '0.00', null],
      [p2.number, 'RECORDED', '60.00', '930.00', '60.00', '0.00', '-6.00', null],
      // The later 50 application is not part of the payment row.
      [p3.number, 'RECORDED', '250.00', '250.00', '100.00', '150.00', '0.00', null],
      [
        batchPayment.number,
        'RECORDED',
        '40.00',
        '40.00',
        '40.00',
        '0.00',
        '0.00',
        batch.body.data.id,
      ],
      [p5.number, 'VOID', '70.00', '70.00', '0.00', '70.00', '0.00', null],
    ]);
    expect(r.payments.find((p: { status: string }) => p.status === 'VOID').paymentDate).toBe(
      '2026-03-21',
    );
    // Totals exclude the void; subtotals per account and currency.
    expect(r.paymentSummary.totals).toEqual({ count: 4, voided: 1, baseAmount: '1320.00' });
    expect(
      r.paymentSummary.subtotals.map(
        (s: {
          currencyCode: string;
          count: number;
          amount: string;
          baseAmount: string;
          realizedFx: string;
        }) => [s.currencyCode, s.count, s.amount, s.baseAmount, s.realizedFx],
      ),
    ).toEqual([
      ['MVR', 3, '390.00', '390.00', '0.00'],
      ['USD', 1, '60.00', '930.00', '-6.00'],
    ]);
    // Refunds: a separate section; the voided one listed but not totalled.
    expect(
      r.refunds.map((x: { status: string; amount: string; sourceNumber: string }) => [
        x.status,
        x.amount,
        x.sourceNumber,
      ]),
    ).toEqual([
      ['RECORDED', '30.00', p3.number],
      ['VOID', '10.00', p3.number],
    ]);
    expect(r.refundSummary.totals).toEqual({ count: 1, voided: 1, baseAmount: '30.00' });
    // GL: the payment account's net credit equals active payments less active refunds.
    expect(await glMovement(o, o.accounts['1120']!, '2026-03-01', '2026-03-31')).toBe(
      decimal(r.refundSummary.totals.baseAmount)
        .minus(decimal(r.paymentSummary.totals.baseAmount))
        .toFixed(2),
    );

    // Filters.
    const usd = await report(
      o.owner,
      'payment-register?from=2026-03-01&to=2026-03-31&currencyCode=USD',
    );
    expect(usd.payments.map((p: { number: string }) => p.number)).toEqual([p2.number]);
    expect(usd.refunds).toEqual([]);
    const byVendor = await report(
      o.owner,
      `payment-register?from=2026-03-01&to=2026-03-31&vendorId=${v2}`,
    );
    expect(byVendor.payments).toHaveLength(1);
    const byAccount = await report(
      o.owner,
      `payment-register?from=2026-03-01&to=2026-03-31&paymentAccountId=${o.accounts['1120']}`,
    );
    expect(byAccount.payments).toHaveLength(5);
    expect(byAccount.refunds).toHaveLength(2);
    expect(
      (await report(o.owner, 'payment-register?from=2026-03-11&to=2026-03-16')).payments,
    ).toHaveLength(1);
  });

  it('caps payments and refunds together at 2,000 rows in one deterministic order (PD8)', () => {
    expect(PAYMENT_REGISTER_LIMIT).toBe(2000);
    const day = (n: number) => `2026-03-${String(1 + (n % 28)).padStart(2, '0')}`;
    const payment = (n: number) => ({
      id: `p-${String(n).padStart(5, '0')}`,
      number: `PAY-${String(n).padStart(5, '0')}`,
      paymentDate: day(n),
    });
    const refund = (n: number) => ({
      id: `r-${String(n).padStart(5, '0')}`,
      number: `VR-${String(n).padStart(5, '0')}`,
      refundDate: day(n),
    });
    const pays = (n: number) => Array.from({ length: n }, (_, i) => payment(i));
    const refs = (n: number) => Array.from({ length: n }, (_, i) => refund(i));

    // Exactly 2,000 combined rows: all returned, not truncated.
    const exact = limitRegister(pays(1500), refs(500), PAYMENT_REGISTER_LIMIT);
    expect([exact.payments.length, exact.refunds.length, exact.truncated]).toEqual([
      1500,
      500,
      false,
    ]);
    // 2,001 combined rows: 2,000 returned, truncated — refunds share the same cap.
    const over = limitRegister(pays(1500), refs(501), PAYMENT_REGISTER_LIMIT);
    expect(over.payments.length + over.refunds.length).toBe(2000);
    expect(over.truncated).toBe(true);
    // Refunds only, beyond the cap, are capped too.
    const onlyRefunds = limitRegister([], refs(2001), PAYMENT_REGISTER_LIMIT);
    expect([onlyRefunds.refunds.length, onlyRefunds.truncated]).toEqual([2000, true]);

    // The dropped row is the last in register order: date, payments before refunds, number, id.
    const all = [
      ...over.payments.map((p) => ({
        date: p.paymentDate,
        kind: 'payment' as const,
        number: p.number,
        id: p.id,
      })),
      ...over.refunds.map((r) => ({
        date: r.refundDate,
        kind: 'refund' as const,
        number: r.number,
        id: r.id,
      })),
    ].sort(compareRegisterRows);
    const everything = [
      ...pays(1500).map((p) => ({
        date: p.paymentDate,
        kind: 'payment' as const,
        number: p.number,
        id: p.id,
      })),
      ...refs(501).map((r) => ({
        date: r.refundDate,
        kind: 'refund' as const,
        number: r.number,
        id: r.id,
      })),
    ].sort(compareRegisterRows);
    expect(all).toEqual(everything.slice(0, 2000));
    // On one date a payment sorts before a refund, then numbers, then ids.
    expect(
      [
        { date: '2026-03-05', kind: 'refund' as const, number: 'VR-1', id: 'a' },
        { date: '2026-03-05', kind: 'payment' as const, number: 'PAY-2', id: 'b' },
        { date: '2026-03-05', kind: 'payment' as const, number: 'PAY-1', id: 'c' },
        { date: '2026-03-04', kind: 'refund' as const, number: 'VR-9', id: 'd' },
      ]
        .sort(compareRegisterRows)
        .map((r) => r.id),
    ).toEqual(['d', 'c', 'b', 'a']);

    // Deterministic: the input order does not matter.
    const shuffled = limitRegister(
      [...pays(1500)].reverse(),
      [...refs(501)].sort((a, b) => (a.id < b.id ? 1 : -1)),
      PAYMENT_REGISTER_LIMIT,
    );
    expect(shuffled).toEqual(over);
  });

  it('applies the combined cap after the filters; totals cover the returned rows', async () => {
    const o = await purchasesOrg();
    const v = await vendor(o, 'Atoll Supplies');
    const other = await vendor(o, 'Blue Lagoon Imports');
    const p1 = await pay(o, v, { paymentDate: '2026-03-10', amount: '100' });
    await pay(o, other, { paymentDate: '2026-03-10', amount: '999' });
    const r1 = await o.owner.post('/purchases/refunds', {
      sourceType: 'payment',
      sourceId: p1.id,
      refundDate: '2026-03-10',
      amount: '10',
    });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const p2 = await pay(o, v, { paymentDate: '2026-03-11', amount: '50' });
    const r2 = await o.owner.post('/purchases/refunds', {
      sourceType: 'payment',
      sourceId: p2.id,
      refundDate: '2026-03-12',
      amount: '5',
    });
    expect(r2.status).toBe(201);
    const principal = (await ctx.services.auth.authenticate(o.owner.sessionToken!, {
      requestId: 'pd8',
      ipAddress: null,
      userAgent: 'vitest',
    }))!;
    const input = { from: '2026-03-01', to: '2026-03-31', vendorId: v };
    // Vendor v has four rows: PAY (03-10), refund (03-10), PAY (03-11), refund (03-12).
    const full = await ctx.services.apReports.paymentRegister(principal, input, { limit: 4 });
    expect(full.truncated).toBe(false);
    expect([full.payments.length, full.refunds.length]).toEqual([2, 2]);
    // A cap of 3: the last row in register order (the 03-12 refund) is dropped.
    const capped = await ctx.services.apReports.paymentRegister(principal, input, { limit: 3 });
    expect(capped).toMatchObject({ truncated: true, limit: 3 });
    expect(capped.payments.map((p) => p.number)).toEqual([p1.number, p2.number]);
    expect(capped.refunds.map((r) => r.number)).toEqual([r1.body.data.number]);
    // Totals cover the returned rows only.
    expect(capped.paymentSummary.totals).toEqual({ count: 2, voided: 0, baseAmount: '150.00' });
    expect(capped.refundSummary.totals).toEqual({ count: 1, voided: 0, baseAmount: '10.00' });
    // A cap of 1 keeps the first payment; on 03-10 payments come before refunds.
    const one = await ctx.services.apReports.paymentRegister(principal, input, { limit: 1 });
    expect([one.payments.map((p) => p.number), one.refunds.length, one.truncated]).toEqual([
      [p1.number],
      0,
      true,
    ]);
    // Each query fetches at most the limit plus one, refunds included.
    const fetched = await inTransaction(
      ctx.database.db,
      { organizationId: o.organizationId },
      (tx) =>
        registerRefunds(
          tx,
          { organizationId: o.organizationId, from: '2026-03-01', to: '2026-03-31' },
          1,
        ),
    );
    expect(fetched).toHaveLength(2);
    // Over HTTP the cap is always 2,000.
    expect(
      (await report(o.owner, `payment-register?from=2026-03-01&to=2026-03-31&vendorId=${v}`)).limit,
    ).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Security and validation
// ---------------------------------------------------------------------------

describe('4B-6 report access', () => {
  it('needs purchases.reports.view, isolates tenants, validates strictly and writes nothing', async () => {
    const o = await purchasesOrg();
    const v = await vendor(o, 'Atoll Supplies');
    await bill(o, v, '2026-03-02', [line('100')]);
    const period = 'from=2026-03-01&to=2026-03-31';
    const paths = [
      'unpaid-bills?asOf=2026-03-31',
      `purchases-by-vendor?${period}`,
      `purchases-by-item?${period}`,
      `purchases-by-account?${period}`,
      `input-tax-summary?${period}`,
      `payment-register?${period}`,
    ];
    const counts = async () =>
      (
        await owner.query(
          `SELECT (SELECT count(*) FROM accounting_journal_entries WHERE organization_id = $1)::int AS journals,
                  (SELECT count(*) FROM audit_events WHERE organization_id = $1)::int AS audit,
                  (SELECT count(*) FROM accounting_events WHERE organization_id = $1)::int AS events`,
          [o.organizationId],
        )
      ).rows[0];
    const before = await counts();
    for (const path of paths) await report(o.owner, path);
    expect(await counts()).toEqual(before);

    const member = await joinWithRole(ctx, o.owner, 'Member');
    for (const path of paths) {
      expect((await member.client.get(`/purchases/reports/${path}`)).status).toBe(200);
    }
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Payments viewer',
      permissionKeys: ['vendor_payments.view', 'bills.view'],
    });
    expect(role.status).toBe(201);
    const viewer = await joinWithRole(ctx, o.owner, 'Payments viewer');
    for (const path of paths) {
      expect((await viewer.client.get(`/purchases/reports/${path}`)).status, path).toBe(403);
    }

    const other = await purchasesOrg();
    const foreignVendor = await vendor(other, 'Elsewhere Ltd');
    const foreignItem = (
      await other.owner.post('/sales/items', { name: 'Elsewhere item', itemType: 'service' })
    ).body.data.id;
    for (const path of [
      `unpaid-bills?asOf=2026-03-31&vendorId=${foreignVendor}`,
      `purchases-by-vendor?${period}&vendorId=${foreignVendor}`,
      `purchases-by-item?${period}&itemId=${foreignItem}`,
      `purchases-by-account?${period}&accountId=${other.accounts['5400']}`,
      `payment-register?${period}&vendorId=${foreignVendor}`,
      `payment-register?${period}&paymentAccountId=${other.accounts['1120']}`,
    ]) {
      expect((await o.owner.get(`/purchases/reports/${path}`)).status, path).toBe(404);
    }
    expect((await report(other.owner, `purchases-by-vendor?${period}`)).vendors).toEqual([]);

    for (const path of [
      'unpaid-bills',
      'unpaid-bills?asOf=2026-03-31&from=2026-03-01',
      'purchases-by-vendor?from=2026-03-31&to=2026-03-01',
      'purchases-by-item?from=2026-03-01',
      `purchases-by-account?${period}&vendorId=${v}`,
      `input-tax-summary?${period}&taxCodeId=x`,
      `payment-register?${period}&currencyCode=usd`,
      `payment-register?${period}&status=VOID`,
    ]) {
      expect((await o.owner.get(`/purchases/reports/${path}`)).status, path).toBe(400);
    }
  });
});
