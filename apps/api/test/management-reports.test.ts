import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';
import type pg from 'pg';

/**
 * Management reports (FP-22): sales trend, inventory low stock / slow-moving / COGS profitability
 * and the tax liability review summary. Each ties back to the ledgers it derives from.
 */

let ctx: TestContext;
let db: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext();
  db = await connectAs('owner');
});
afterAll(async () => {
  await db.end();
  await ctx.close();
});

interface Org extends AccountingOrg {
  vendorId: string;
  customerId: string;
  itemId: string;
  gst: string;
}

async function org(reorderPoint: string | null = null): Promise<Org> {
  const base = await setUpAccountingOrg(ctx);
  const codes = (await base.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
  const profile = await base.owner.put('/organizations/current/profile', {
    version: 0,
    legalName: 'Atoll Trading Pvt Ltd',
    gstRegistered: true,
    gstRegisteredFrom: '2026-01-01',
    gstRegistrationNumber: '1000234GST501',
  });
  expect(profile.status, JSON.stringify(profile.body)).toBe(200);
  const purchases = await base.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: base.accounts['2110'],
    defaultExpenseAccountId: base.accounts['5400'],
    defaultPaymentAccountId: base.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(purchases.status, JSON.stringify(purchases.body)).toBe(200);
  const sales = await base.owner.put('/sales/settings', {
    version: 0,
    arAccountId: base.accounts['1130'],
    defaultRevenueAccountId: base.accounts['4100'],
    defaultDepositAccountId: base.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(sales.status, JSON.stringify(sales.body)).toBe(200);
  const vendor = await base.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Wholesale' },
  });
  const customer = await base.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Sun Island Resort' },
  });
  const item = await base.owner.post('/sales/items', {
    name: 'Coconut oil 1L',
    itemType: 'product',
    unitPrice: '60',
    revenueAccountId: base.accounts['4100'],
  });
  const tracked = await base.owner.post(`/inventory/items/${item.body.data.id}`, {
    inventoryAccountId: base.accounts['1140'],
    cogsAccountId: base.accounts['5100'],
    ...(reorderPoint ? { reorderPoint } : {}),
  });
  expect(tracked.status, JSON.stringify(tracked.body)).toBe(201);
  return {
    ...base,
    vendorId: vendor.body.data.id,
    customerId: customer.body.data.id,
    itemId: item.body.data.id,
    gst: codes.find((c) => c.code === 'GST')!.id,
  };
}

async function buy(o: Org, quantity: string, unitPrice: string, date = '2026-03-10') {
  const draft = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: date,
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: [{ itemId: o.itemId, description: 'Oil', quantity, unitPrice, taxCodeId: null }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const posted = await o.owner.post(`/purchases/bills/${draft.body.data.id}/post`, {
    version: draft.body.data.version,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
}

async function sell(o: Org, quantity: string, date: string, taxCodeId: string | null = null) {
  const draft = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate: date,
    lines: [{ itemId: o.itemId, description: 'Oil', quantity, unitPrice: '60', taxCodeId }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const issued = await o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data;
}

const get = async (o: Org, path: string) => {
  const res = await o.owner.get(path);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};

describe('sales trend', () => {
  it('groups net sales by month, counts credit notes negatively and agrees with sales-by-customer', async () => {
    const o = await org();
    await buy(o, '50', '10', '2026-01-02');
    await sell(o, '2', '2026-01-15'); // 120
    const march = await sell(o, '3', '2026-03-05'); // 180
    await sell(o, '1', '2026-03-20'); // 60
    const note = await o.owner.post('/sales/credit-notes', {
      customerId: o.customerId,
      creditDate: '2026-03-25',
      invoiceId: march.id,
      lines: [
        {
          itemId: o.itemId,
          description: 'Returned',
          quantity: '1',
          unitPrice: '60',
          taxCodeId: null,
        },
      ],
    });
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    expect(
      (
        await o.owner.post(`/sales/credit-notes/${note.body.data.id}/issue`, {
          version: note.body.data.version,
        })
      ).status,
    ).toBe(200);
    const trend = await get(o, '/sales/reports/sales-trend?from=2026-01-01&to=2026-03-31');
    expect(trend.granularity).toBe('month');
    expect(trend.periods).toEqual([
      { periodStart: '2026-01-01', invoices: 1, creditNotes: 0, netSales: '120.00', tax: '0.00' },
      { periodStart: '2026-03-01', invoices: 2, creditNotes: 1, netSales: '180.00', tax: '0.00' },
    ]);
    expect(trend.totals.netSales).toBe('300.00');
    const byCustomer = await get(
      o,
      '/sales/reports/sales-by-customer?from=2026-01-01&to=2026-03-31',
    );
    expect(byCustomer.totals.netSales).toBe(trend.totals.netSales);
    const daily = await get(
      o,
      '/sales/reports/sales-trend?from=2026-03-01&to=2026-03-31&granularity=day',
    );
    expect(daily.periods.map((p: { periodStart: string }) => p.periodStart)).toEqual([
      '2026-03-05',
      '2026-03-20',
      '2026-03-25',
    ]);
    // Validation: strict, ordered dates, known granularity.
    for (const bad of [
      '?from=2026-03-31&to=2026-03-01',
      '?from=2026-03-01&to=2026-03-31&granularity=year',
      '?from=2026-03-01&to=2026-03-31&extra=1',
      '?from=x&to=y',
    ]) {
      expect((await o.owner.get(`/sales/reports/sales-trend${bad}`)).status, bad).toBe(400);
    }
  });
});

describe('inventory reports', () => {
  it('lists items at or below their reorder point', async () => {
    const o = await org('10');
    await buy(o, '4', '10');
    const low = await get(o, '/inventory/reports/low-stock');
    expect(low.items).toEqual([
      expect.objectContaining({
        itemId: o.itemId,
        quantity: '4',
        reorderPoint: '10',
        shortfall: '6',
      }),
    ]);
    await buy(o, '20', '10');
    expect((await get(o, '/inventory/reports/low-stock')).items).toEqual([]);
    const none = await org();
    await buy(none, '1', '10');
    expect((await get(none, '/inventory/reports/low-stock')).items).toEqual([]);
  });

  it('ages stock by the days since the last sale', async () => {
    const o = await org();
    await buy(o, '20', '10', '2026-01-02');
    let report = await get(o, '/inventory/reports/slow-moving?asOf=2026-03-31');
    expect(report.items[0]).toMatchObject({
      itemId: o.itemId,
      lastSale: null,
      daysSinceLastSale: null,
      bucket: 'neverSold',
      value: '200.00',
    });
    await sell(o, '2', '2026-02-15');
    report = await get(o, '/inventory/reports/slow-moving?asOf=2026-03-31');
    expect(report.items[0]).toMatchObject({
      lastSale: '2026-02-15',
      lastReceipt: '2026-01-02',
      daysSinceLastSale: 44,
      bucket: 'days31to60',
      quantity: '18',
      value: '180.00',
    });
    expect(report.totals).toMatchObject({
      days31to60: '180.00',
      neverSold: '0.00',
      over90: '0.00',
    });
    // As of before the sale the item had never sold.
    const before = await get(o, '/inventory/reports/slow-moving?asOf=2026-02-01');
    expect(before.items[0].bucket).toBe('neverSold');
    expect((await o.owner.get('/inventory/reports/slow-moving?asOf=bad')).status).toBe(400);
  });

  it('shows net sales against the cost taken from stock, with returns netting both sides', async () => {
    const o = await org();
    await buy(o, '20', '10');
    const invoice = await sell(o, '5', '2026-03-15'); // sales 300, cost 50
    const note = await o.owner.post('/sales/credit-notes', {
      customerId: o.customerId,
      creditDate: '2026-03-20',
      invoiceId: invoice.id,
      lines: [
        {
          itemId: o.itemId,
          description: 'Returned',
          quantity: '2',
          unitPrice: '60',
          taxCodeId: null,
        },
      ],
    });
    await o.owner.post(`/sales/credit-notes/${note.body.data.id}/issue`, {
      version: note.body.data.version,
    });
    const ret = await o.owner.post('/inventory/returns', {
      returnDate: '2026-03-21',
      creditNoteId: note.body.data.id,
      reason: 'Back',
      lines: [{ itemId: o.itemId, quantity: '2' }],
    });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    const report = await get(
      o,
      '/inventory/reports/cogs-profitability?from=2026-03-01&to=2026-03-31',
    );
    expect(report.items).toEqual([
      expect.objectContaining({
        itemId: o.itemId,
        quantitySold: '3',
        netSales: '180.00',
        cogs: '30.00',
        grossMargin: '150.00',
        marginPercent: '83.33',
      }),
    ]);
    expect(report.totals).toEqual({
      netSales: '180.00',
      cogs: '30.00',
      grossMargin: '150.00',
      marginPercent: '83.33',
    });
    // The report's cost equals the cost-of-goods-sold account's net movement in the period.
    const { rows } = await db.query(
      `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
         FROM accounting_journal_lines l
         JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
        WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
      [o.organizationId, o.accounts['5100']],
    );
    expect(rows[0].b).toBe(report.totals.cogs);
  });

  it('needs inventory.view, and COGS profitability also sales.reports.view', async () => {
    const o = await org();
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Stock viewer',
      permissionKeys: ['inventory.view'],
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const member = await joinWithRole(ctx, o.owner, 'Stock viewer');
    expect((await member.client.get('/inventory/reports/low-stock')).status).toBe(200);
    expect((await member.client.get('/inventory/reports/slow-moving?asOf=2026-03-31')).status).toBe(
      200,
    );
    expect(
      (
        await member.client.get(
          '/inventory/reports/cogs-profitability?from=2026-03-01&to=2026-03-31',
        )
      ).status,
    ).toBe(403);
    expect(
      (await member.client.get('/accounting/reports/tax-liability?from=2026-03-01&to=2026-03-31'))
        .status,
    ).toBe(403);
    // Another organization's data never appears.
    const other = await org('5');
    await buy(other, '1', '10');
    expect((await get(o, '/inventory/reports/low-stock')).items).toEqual([]);
  });
});

describe('tax liability summary', () => {
  it('is output tax on sales less recoverable input tax on purchases, per tax code', async () => {
    const o = await org();
    await buy(o, '20', '10');
    await sell(o, '2', '2026-03-10', o.gst); // 120 net
    const bill = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorId,
      billDate: '2026-03-12',
      vendorReference: `SI-${randomUUID().slice(0, 8)}`,
      lines: [
        {
          description: 'Cleaning',
          quantity: '1',
          unitPrice: '100',
          accountId: o.accounts['5400'],
          taxCodeId: o.gst,
        },
      ],
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const posted = await o.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
      version: bill.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const sales = await get(o, '/sales/reports/tax-summary?from=2026-03-01&to=2026-03-31');
    const purchases = await get(
      o,
      '/purchases/reports/input-tax-summary?from=2026-03-01&to=2026-03-31',
    );
    const report = await get(o, '/accounting/reports/tax-liability?from=2026-03-01&to=2026-03-31');
    expect(report.reviewOnly).toBe(true);
    expect(report.totals.outputTax).toBe(sales.totals.tax);
    expect(report.totals.recoverableInputTax).toBe(purchases.totals.recoverableTax);
    const gst = report.codes.find((c: { taxCodeId: string | null }) => c.taxCodeId === o.gst);
    expect(gst).toBeDefined();
    expect(gst.outputTax).not.toBe('0');
    expect(gst.recoverableInputTax).not.toBe('0');
    expect(Number(report.totals.netPayable)).toBeCloseTo(
      Number(report.totals.outputTax) - Number(report.totals.recoverableInputTax),
      4,
    );
    expect(
      (await o.owner.get('/accounting/reports/tax-liability?from=2026-03-31&to=2026-03-01')).status,
    ).toBe(400);
  });
});
