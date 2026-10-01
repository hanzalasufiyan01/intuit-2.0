import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 3B step 16: AR aging (D9 buckets), customer statements, AR opening invoices (D5,
 * Decision 69), the AR subledger ↔ GL reconciliation (Decision 11) and the read-only S9 exposure
 * provider for open foreign-currency AR (E5).
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const origin = { requestId: null, ipAddress: null, userAgent: null };

interface SalesOrg extends AccountingOrg {
  customerId: string;
}

async function salesOrg(currencyCode = 'MVR'): Promise<SalesOrg> {
  const org = await setUpAccountingOrg(ctx);
  const settings = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'no_tax',
    defaultPaymentTermsDays: 0,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const customer = await org.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Reef Divers' },
    currencyCode,
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  return { ...org, customerId: customer.body.data.id };
}

async function invoice(o: SalesOrg, amount: string, invoiceDate: string, extra: object = {}) {
  const created = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate,
    lines: [{ description: 'Dive package', quantity: '1', unitPrice: amount }],
    ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const issued = await o.owner.post(`/sales/invoices/${created.body.data.id}/issue`, {
    version: created.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data;
}

async function receive(o: SalesOrg, body: object) {
  const res = await o.owner.post('/sales/receipts', { customerId: o.customerId, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function reconciliation(client: TestClient, asOf: string) {
  const res = await client.get(`/sales/reports/ar-reconciliation?asOf=${asOf}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

describe('AR aging (D9)', () => {
  it('ages open invoices by due date as of a date, net of customer credit', async () => {
    const o = await salesOrg();
    const old = await invoice(o, '300', '2026-01-01'); // due 01-01: 89 days at 03-31
    await invoice(o, '200', '2026-02-15'); // due 02-15: 44 days
    await invoice(o, '100', '2026-03-20', { paymentTermsDays: 30 }); // due 04-19: current
    await receive(o, {
      receiptDate: '2026-03-25',
      amount: '400',
      allocations: [{ invoiceId: old.id, amount: '300' }],
    }); // 100 of customer credit
    const aging = (await o.owner.get('/sales/reports/aging?asOf=2026-03-31')).body.data;
    expect(aging.totals).toEqual({
      current: '100.00',
      days1to30: '0.00',
      days31to60: '200.00',
      days61to90: '0.00',
      over90: '0.00',
      credit: '-100.00',
      total: '200.00',
    });
    expect(aging.customers[0].credits).toHaveLength(1);

    // Earlier, before the receipt and the last invoice: the old invoice was then 1–30 days due.
    const earlier = (await o.owner.get('/sales/reports/aging?asOf=2026-01-20')).body.data;
    expect(earlier.totals).toMatchObject({ days1to30: '300.00', credit: '0.00', total: '300.00' });
    const member = await o.owner.get('/sales/reports/aging?asOf=bad');
    expect(member.status).toBe(400);
  });
});

describe('customer statement', () => {
  it('shows the balance brought forward, the period activity and the closing balance', async () => {
    const o = await salesOrg();
    await invoice(o, '500', '2026-01-10');
    const inv = await invoice(o, '250', '2026-02-05');
    await receive(o, {
      receiptDate: '2026-02-20',
      amount: '250',
      allocations: [{ invoiceId: inv.id, amount: '250' }],
    });
    const voided = await receive(o, { receiptDate: '2026-02-21', amount: '40' });
    const v = await o.owner.post(`/sales/receipts/${voided.id}/void`, {
      version: voided.version,
      reason: 'Entered twice',
    });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const res = await o.owner.get(
      `/sales/reports/statement?customerId=${o.customerId}&from=2026-02-01&to=2026-02-28`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [mvr] = res.body.data.currencies;
    expect(mvr).toMatchObject({
      currencyCode: 'MVR',
      openingBalance: '500.00',
      closingBalance: '500.00',
    });
    expect(
      mvr.lines.map((l: { type: string; amount: string; balance: string }) => [
        l.type,
        l.amount,
        l.balance,
      ]),
    ).toEqual([
      ['invoice', '250.00', '750.00'],
      ['receipt', '-250.00', '500.00'],
    ]);
    expect(mvr.openInvoices).toHaveLength(1);
  });
});

describe('AR opening invoices (D5, Decision 69)', () => {
  it('posts Dr AR / Cr Opening Balance Equity on or before the opening date', async () => {
    const o = await salesOrg();
    const body = {
      kind: 'opening',
      customerId: o.customerId,
      invoiceDate: '2026-01-01',
      lines: [{ description: 'Balance at conversion', quantity: '1', unitPrice: '1200' }],
    };
    const noDate = await o.owner.post('/sales/invoices', body);
    expect(noDate.status).toBe(400);
    expect(noDate.body.error.details.issues[0].path).toBe('kind');
    const set = await o.owner.put('/accounting/settings/conversion-date', {
      conversionDate: '2026-01-02',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const late = await o.owner.post('/sales/invoices', { ...body, invoiceDate: '2026-01-05' });
    expect(late.body.error.details.issues[0].path).toBe('invoiceDate');
    const taxed = await o.owner.post('/sales/invoices', { ...body, taxTreatment: 'exclusive' });
    expect(taxed.body.error.details.issues[0].path).toBe('taxTreatment');

    const draft = await o.owner.post('/sales/invoices', body);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.data).toMatchObject({ kind: 'opening', taxTotal: '0.00', total: '1200.00' });
    expect(draft.body.data.approval.facts).toMatchObject({
      transactionType: 'opening',
      baseAmount: '1200.00',
    });
    const issued = await o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
      version: 1,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const journal = (await o.owner.get(`/accounting/journals/${issued.body.data.journalId}`)).body
      .data;
    expect(journal).toMatchObject({
      source: 'system',
      sourceModule: 'sales',
      sourceType: 'opening_balance',
    });
    const obe = journal.lines.find(
      (l: { accountId: string }) => l.accountId === o.accounts['3900'],
    );
    expect(obe).toMatchObject({ credit: '1200.0000' });
    expect((await reconciliation(o.owner, '2026-01-31')).reconciled).toBe(true);

    // Generic reversal is refused (E2); the invoice void reverses it.
    const manual = await o.owner.post(`/accounting/journals/${journal.id}/reverse`, {
      reason: 'Manual attempt',
    });
    expect(manual.body.error.code).toBe('SYSTEM_JOURNAL');
    const voided = await o.owner.post(`/sales/invoices/${draft.body.data.id}/void`, {
      version: issued.body.data.version,
      reason: 'Wrong balance',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await reconciliation(o.owner, '2026-01-31')).toMatchObject({
      glBalance: '0.00',
      reconciled: true,
    });
  });

  it('carries a foreign opening balance at its explicit carrying value (S8-06)', async () => {
    const o = await salesOrg('USD');
    await o.owner.put('/accounting/settings/conversion-date', { conversionDate: '2026-01-02' });
    const created = await o.owner.post('/sales/invoices', {
      kind: 'opening',
      customerId: o.customerId,
      invoiceDate: '2025-12-15',
      openingBaseTotal: '15400',
      lines: [{ description: 'Balance at conversion', quantity: '1', unitPrice: '1000' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // Dated before FY2026: the posting date must fall in an open period.
    const outside = await o.owner.post(`/sales/invoices/${created.body.data.id}/issue`, {
      version: 1,
    });
    expect(outside.body.error.code).toBe('PERIOD_NOT_FOUND');
    const moved = await o.owner.put(`/sales/invoices/${created.body.data.id}`, {
      version: 1,
      customerId: o.customerId,
      invoiceDate: '2026-01-01',
      openingBaseTotal: '15400',
      lines: [{ description: 'Balance at conversion', quantity: '1', unitPrice: '1000' }],
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const issued = await o.owner.post(`/sales/invoices/${created.body.data.id}/issue`, {
      version: 2,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.data).toMatchObject({
      kind: 'opening',
      currencyCode: 'USD',
      exchangeRateSource: 'carrying',
      exchangeRate: '15.4000000000',
      baseTotal: '15400.0000',
      openingBaseTotal: '15400.0000',
    });
    expect((await reconciliation(o.owner, '2026-01-31')).reconciled).toBe(true);
  });
});

describe('AR reconciliation and revaluation exposure (Decision 11, E5)', () => {
  it('reconciles through receipts, credit, realized FX and S9 revaluation', async () => {
    const o = await salesOrg('USD');
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-01',
      rate: '15.42',
    });
    const a = await invoice(o, '1000', '2026-03-05');
    await invoice(o, '500', '2026-03-06');
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-15',
      rate: '15.50',
    });
    await receive(o, {
      receiptDate: '2026-03-20',
      amount: '1200',
      allocations: [{ invoiceId: a.id, amount: '1000' }],
    });
    const before = await reconciliation(o.owner, '2026-03-31');
    expect(before).toMatchObject({
      reconciled: true,
      difference: '0.00',
      postingsOutsideSales: '0.00',
      revaluationAdjustments: '0.00',
      // 500 at 15.42 open, less 200 of credit at 15.50.
      subledger: { openInvoices: '7710.00', unappliedCredit: '-3100.00', total: '4610.00' },
    });

    // E5: S9 sees the open USD invoice and the USD credit on the AR control account.
    const principal = await ctx.services.auth.authenticate(o.owner.sessionToken!, origin);
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-31',
      rate: '15.60',
    });
    const preview = await ctx.services.revaluations.preview(principal!, {
      revaluationDate: '2026-03-31',
    });
    expect(preview.errors).toEqual([]);
    const documents = preview.lines.filter((l) => l.exposureKind === 'DOCUMENT');
    expect(documents.map((l) => [l.accountId, l.foreignBalance, l.carryingBase]).sort()).toEqual(
      [
        [o.accounts['1130'], '-200', '-3100'],
        [o.accounts['1130'], '500', '7710'],
      ].sort(),
    );
    const posted = await ctx.services.revaluations.post(
      principal!,
      { revaluationDate: '2026-03-31' },
      origin,
    );
    expect(posted.status, JSON.stringify(posted)).toBe('POSTED');
    // The adjustment on AR is a reconciling item, not a difference.
    const after = await reconciliation(o.owner, '2026-03-31');
    expect(after.reconciled).toBe(true);
    // +90 on the invoice (500 × 0.18) and −20 on the credit (200 × 0.10).
    expect(after.revaluationAdjustments).toBe('70.00');
  });
});

describe('sales reports (step 17, Decision 45)', () => {
  it('reports net sales by customer and item, and tax by code, net of credit notes', async () => {
    const o = await salesOrg();
    const codes = (await o.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
    const gst = codes.find((c) => c.code === 'GST')!.id;
    const item = await o.owner.post('/sales/items', {
      name: 'Dive',
      itemType: 'service',
      unitPrice: '100',
    });
    await invoice(o, '0', '2026-03-05', {
      taxTreatment: 'exclusive',
      lines: [
        { itemId: item.body.data.id, quantity: '3', taxCodeId: gst },
        { description: 'Fuel surcharge', quantity: '1', unitPrice: '50', taxCodeId: null },
      ],
    });
    const voided = await invoice(o, '999', '2026-03-06');
    await o.owner.post(`/sales/invoices/${voided.id}/void`, {
      version: voided.version,
      reason: 'Duplicate',
    });
    const note = await o.owner.post('/sales/credit-notes', {
      customerId: o.customerId,
      creditDate: '2026-03-10',
      taxTreatment: 'exclusive',
      lines: [{ itemId: item.body.data.id, quantity: '1', taxCodeId: gst }],
    });
    await o.owner.post(`/sales/credit-notes/${note.body.data.id}/issue`, { version: 1 });
    // Outside the period.
    await invoice(o, '500', '2026-04-02');

    const period = 'from=2026-03-01&to=2026-03-31';
    const byCustomer = (await o.owner.get(`/sales/reports/sales-by-customer?${period}`)).body.data;
    expect(byCustomer.customers).toEqual([
      expect.objectContaining({
        invoices: 1,
        creditNotes: 1,
        netSales: '250.00',
        tax: '16.00',
        total: '266.00',
      }),
    ]);
    const byItem = (await o.owner.get(`/sales/reports/sales-by-item?${period}`)).body.data;
    expect(byItem.items).toEqual([
      expect.objectContaining({ name: 'Dive', quantity: '2', netSales: '200.00' }),
      expect.objectContaining({ itemId: null, quantity: '1', netSales: '50.00' }),
    ]);
    const tax = (await o.owner.get(`/sales/reports/tax-summary?${period}`)).body.data;
    expect(tax.codes).toEqual([
      expect.objectContaining({ code: 'GST', rate: '8', taxable: '200.00', tax: '16.00' }),
      expect.objectContaining({ taxCodeId: null, taxable: '50.00', tax: '0.00' }),
    ]);
    expect(
      (await o.owner.get('/sales/reports/tax-summary?from=2026-04-01&to=2026-03-01')).status,
    ).toBe(400);
  });

  it('needs sales.reports.view', async () => {
    const o = await salesOrg();
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Invoices only',
      permissionKeys: ['invoices.view'],
    });
    expect(role.status).toBe(201);
    const { joinWithRole } = await import('./fixtures.js');
    const clerk = await joinWithRole(ctx, o.owner, 'Invoices only');
    for (const path of [
      '/sales/reports/aging?asOf=2026-03-31',
      '/sales/reports/sales-by-customer?from=2026-03-01&to=2026-03-31',
      '/sales/reports/ar-reconciliation?asOf=2026-03-31',
    ]) {
      expect((await clerk.client.get(path)).status, path).toBe(403);
    }
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/sales/reports/aging?asOf=2026-03-31')).status).toBe(200);
  });
});
