import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Accounting integrity checkpoint (after 4B-7). Cross-module proofs that each document reaches
 * the ledger only through an accounting event and a journal, that the subledgers equal their
 * control accounts, and the weighted-average inventory scenario at the accounting level.
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

interface StockOrg extends AccountingOrg {
  vendorId: string;
  customerId: string;
  itemId: string;
  gst: string;
}

async function stockOrg(options: { vendor?: Record<string, unknown> } = {}): Promise<StockOrg> {
  const org = await setUpAccountingOrg(ctx);
  const purchases = await org.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: org.accounts['2110'],
    defaultExpenseAccountId: org.accounts['5400'],
    defaultPaymentAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(purchases.status, JSON.stringify(purchases.body)).toBe(200);
  const sales = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(sales.status, JSON.stringify(sales.body)).toBe(200);
  const vendor = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Wholesale' },
    ...options.vendor,
  });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  const customer = await org.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Sun Island Resort' },
  });
  const item = await org.owner.post('/sales/items', {
    name: 'Coconut oil 1L',
    itemType: 'product',
    unitPrice: '60',
    revenueAccountId: org.accounts['4100'],
  });
  expect(item.status, JSON.stringify(item.body)).toBe(201);
  const tracked = await org.owner.post(`/inventory/items/${item.body.data.id}`, {
    inventoryAccountId: org.accounts['1140'],
    cogsAccountId: org.accounts['5100'],
  });
  expect(tracked.status, JSON.stringify(tracked.body)).toBe(201);
  const codes = (await org.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
  return {
    ...org,
    vendorId: vendor.body.data.id as string,
    customerId: customer.body.data.id as string,
    itemId: item.body.data.id as string,
    gst: codes.find((c) => c.code === 'GST')!.id,
  };
}

async function billOf(
  o: StockOrg,
  line: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const created = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: '2026-03-10',
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: [{ itemId: o.itemId, description: 'Coconut oil', taxCodeId: null, ...line }],
    ...extra,
  });
  if (created.status !== 201) return created;
  return o.owner.post(`/purchases/bills/${created.body.data.id}/post`, {
    version: created.body.data.version,
  });
}

async function postedBill(
  o: StockOrg,
  quantity: string,
  unitPrice: string,
  extra: Record<string, unknown> = {},
  line: Record<string, unknown> = {},
) {
  const res = await billOf(o, { quantity, unitPrice, ...line }, extra);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; version: number; journalId: string };
}

async function issuedInvoice(o: StockOrg, quantity: string, date = '2026-03-15') {
  const draft = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate: date,
    lines: [
      { itemId: o.itemId, description: 'Coconut oil', quantity, unitPrice: '60', taxCodeId: null },
    ],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const issued = await o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data as { id: string; version: number; journalId: string };
}

async function stock(o: StockOrg) {
  const res = await o.owner.get(`/inventory/items/${o.itemId}`);
  return res.body.data as { quantity: string; averageCost: string; value: string };
}

async function movements(o: StockOrg) {
  const res = await o.owner.get(`/inventory/items/${o.itemId}/movements`);
  return res.body.data.items as {
    kind: string;
    quantity: string;
    value: string;
    journalId: string | null;
  }[];
}

async function glBalance(organizationId: string, accountId: string) {
  const { rows } = await owner.query(
    `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
    [organizationId, accountId],
  );
  return rows[0].b as string;
}

/** The chain: document → accounting event → journal → journal lines (→ GL). */
async function chainOf(journalId: string) {
  const { rows } = await owner.query(
    `SELECT j.source, j.source_module, j.source_type, j.status, e.event_type, e.source_module AS event_module,
            (SELECT count(*)::int FROM accounting_journal_lines l WHERE l.journal_id = j.id) AS lines,
            (SELECT coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0)
               FROM accounting_journal_lines l WHERE l.journal_id = j.id)::numeric(28,4)::text AS imbalance
       FROM accounting_journal_entries j
       LEFT JOIN accounting_events e ON e.id = j.accounting_event_id
      WHERE j.id = $1`,
    [journalId],
  );
  return rows[0] as {
    source: string;
    source_module: string | null;
    source_type: string | null;
    status: string;
    event_type: string | null;
    event_module: string | null;
    lines: number;
    imbalance: string;
  };
}

/** Every journal of the organization balances in base, and none is a stray direct write. */
async function expectLedgerSound(organizationId: string) {
  const unbalanced = await owner.query(
    `SELECT j.id FROM accounting_journal_entries j
       JOIN accounting_journal_lines l ON l.journal_id = j.id
      WHERE j.organization_id = $1 AND j.status IN ('POSTED', 'REVERSED')
      GROUP BY j.id
     HAVING coalesce(sum(l.base_debit), 0) <> coalesce(sum(l.base_credit), 0)`,
    [organizationId],
  );
  expect(unbalanced.rows).toEqual([]);
  const stray = await owner.query(
    `SELECT j.id, j.source, j.source_module FROM accounting_journal_entries j
      WHERE j.organization_id = $1 AND j.status IN ('POSTED', 'REVERSED')
        AND j.source_module IS NOT NULL
        AND NOT (j.source IN ('event', 'system', 'reversal'))`,
    [organizationId],
  );
  expect(stray.rows).toEqual([]);
  const eventless = await owner.query(
    `SELECT j.id FROM accounting_journal_entries j
      WHERE j.organization_id = $1 AND j.source = 'event' AND j.accounting_event_id IS NULL`,
    [organizationId],
  );
  expect(eventless.rows).toEqual([]);
}

describe('weighted-average inventory at the accounting level', () => {
  it('values 10×100 + 10×120 at 110 and sells 5 for COGS 550, remaining 15 for 1650', async () => {
    const o = await stockOrg();
    const a = await postedBill(o, '10', '100');
    const b = await postedBill(o, '10', '120');
    expect(await stock(o)).toMatchObject({
      quantity: '20',
      value: '2200.0000',
      averageCost: '110.0000',
    });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('2200.00');
    const sold = await issuedInvoice(o, '5');
    expect(await stock(o)).toMatchObject({
      quantity: '15',
      value: '1650.0000',
      averageCost: '110.0000',
    });
    const sale = (await movements(o)).find((m) => m.kind === 'sale')!;
    expect(sale).toMatchObject({ quantity: '-5', value: '-550.0000' });
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('550.00');
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('1650.00');
    // document → event → journal → lines: nothing is written to the ledger directly.
    for (const journalId of [a.journalId, b.journalId, sold.journalId, sale.journalId!]) {
      const chain = await chainOf(journalId);
      expect(chain.source).toBe('event');
      expect(chain.event_type).not.toBeNull();
      expect(chain.lines).toBeGreaterThanOrEqual(2);
      expect(chain.imbalance).toBe('0.0000');
    }
    expect((await chainOf(sale.journalId!)).event_type).toMatch(/inventory/);
    const valuation = (await o.owner.get('/inventory/valuation')).body.data;
    expect(valuation.totalValue).toBe('1650.0000');
    expect(valuation.accounts[0]).toMatchObject({ glBalance: '1650.0000', difference: '0.0000' });
    await expectLedgerSound(o.organizationId);
  });

  it('keeps the average across partial sales, several invoices and adjustments', async () => {
    const o = await stockOrg();
    await postedBill(o, '10', '100');
    await postedBill(o, '10', '120');
    await issuedInvoice(o, '5'); // 550
    await issuedInvoice(o, '3'); // 330 at the same 110 average
    expect(await stock(o)).toMatchObject({ quantity: '12', value: '1320.0000' });
    const settings = await o.owner.put('/inventory/settings', {
      version: 0,
      negativeStockPolicy: 'block',
      adjustmentAccountId: o.accounts['5400'],
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    const decrease = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: '2026-03-20',
      reason: 'Spoilage',
      lines: [{ itemId: o.itemId, quantityChange: '-2' }],
    });
    expect(decrease.status, JSON.stringify(decrease.body)).toBe(201);
    expect(await stock(o)).toMatchObject({ quantity: '10', value: '1100.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('1100.00');
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('880.00');
    await expectLedgerSound(o.organizationId);
  });

  it('refuses a zero quantity and sells nothing it does not have', async () => {
    const o = await stockOrg();
    const zeroQty = await billOf(o, { quantity: '0', unitPrice: '100' });
    expect(zeroQty.status).toBe(400);
    const draft = await o.owner.post('/sales/invoices', {
      customerId: o.customerId,
      invoiceDate: '2026-03-15',
      lines: [
        { itemId: o.itemId, description: 'x', quantity: '1', unitPrice: '60', taxCodeId: null },
      ],
    });
    const issued = await o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
      version: draft.body.data.version,
    });
    expect(issued.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('0.00');
  });

  it('costs at a zero price without a residue and keeps the average honest', async () => {
    const o = await stockOrg();
    const free = await billOf(o, { quantity: '4', unitPrice: '0' });
    if (free.status === 200) {
      expect(await stock(o)).toMatchObject({ quantity: '4', value: '0.0000' });
      await postedBill(o, '4', '100');
      expect(await stock(o)).toMatchObject({
        quantity: '8',
        value: '400.0000',
        averageCost: '50.0000',
      });
    } else {
      // A zero-value bill may be refused by the bill rules; no stock must then have moved.
      expect(free.status).toBe(400);
      expect(await stock(o)).toMatchObject({ quantity: '0', value: '0.0000' });
    }
    await expectLedgerSound(o.organizationId);
  });

  it('costs by posting order for a backdated bill and leaves earlier cost of goods sold alone', async () => {
    const o = await stockOrg();
    await postedBill(o, '10', '100', { billDate: '2026-03-01' });
    await issuedInvoice(o, '5', '2026-03-15'); // COGS 500
    await postedBill(o, '10', '200', { billDate: '2026-03-05' }); // backdated, posted later
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('500.00');
    expect(await stock(o)).toMatchObject({ quantity: '15', value: '2500.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('2500.00');
    await expectLedgerSound(o.organizationId);
  });

  it('values a foreign-currency purchase at the base amount the bill journal booked', async () => {
    const o = await stockOrg({ vendor: { currencyCode: 'USD' } });
    const rate = await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-01',
      rate: '15.42',
    });
    expect(rate.status, JSON.stringify(rate.body)).toBe(201);
    await postedBill(o, '10', '10', { currencyCode: 'USD' }); // 100 USD at 15.42 = 1,542.00
    expect(await stock(o)).toMatchObject({
      quantity: '10',
      value: '1542.0000',
      averageCost: '154.2000',
    });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('1542.00');
    await issuedInvoice(o, '4');
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('616.80');
    await expectLedgerSound(o.organizationId);
  });

  it('capitalizes non-recoverable purchase tax into the stock cost', async () => {
    const o = await stockOrg({ vendor: { defaultTaxRecoverable: false } });
    await postedBill(o, '10', '10', {}, { taxCodeId: o.gst, taxRecoverable: false });
    // 100 net + 8% GST that cannot be recovered = 108 of stock.
    expect(await stock(o)).toMatchObject({ quantity: '10', value: '108.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('108.00');
    await expectLedgerSound(o.organizationId);
  });

  it('returns stock on a void bill or invoice and reverses the cost journal', async () => {
    const o = await stockOrg();
    const bill = await postedBill(o, '10', '100');
    const invoice = await issuedInvoice(o, '4');
    ctx.clock.advance(16 * 60_000);
    await o.owner.get('/auth/session');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const voidedInvoice = await o.owner.post(`/sales/invoices/${invoice.id}/void`, {
      version: invoice.version,
      reason: 'Wrong customer',
    });
    expect(voidedInvoice.status, JSON.stringify(voidedInvoice.body)).toBe(200);
    expect(await stock(o)).toMatchObject({ quantity: '10', value: '1000.0000' });
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('0.00');
    const voidedBill = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: bill.version,
      reason: 'Entered twice',
    });
    expect(voidedBill.status, JSON.stringify(voidedBill.body)).toBe(200);
    expect(await stock(o)).toMatchObject({ quantity: '0', value: '0.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('0.00');
    await expectLedgerSound(o.organizationId);
  });

  it('is tenant-isolated: another organization neither sees the stock nor its ledger', async () => {
    const a = await stockOrg();
    const b = await stockOrg();
    await postedBill(a, '10', '100');
    expect((await b.owner.get(`/inventory/items/${a.itemId}`)).status).toBe(404);
    expect((await b.owner.get(`/inventory/items/${a.itemId}/movements`)).status).toBe(404);
    expect(await glBalance(b.organizationId, b.accounts['1140']!)).toBe('0.00');
  });
});

describe('fixed assets and bills', () => {
  it('registers a bill-capitalized asset as already in the ledger, so cost is booked once', async () => {
    const o = await stockOrg();
    const category = await o.owner.post('/fixed-assets/categories', {
      name: 'Equipment',
      costAccountId: o.accounts['1510'],
      accumulatedAccountId: o.accounts['1520'],
      expenseAccountId: o.accounts['5500'],
      defaultLifeMonths: 60,
    });
    expect(category.status, JSON.stringify(category.body)).toBe(201);
    // The bill capitalizes the purchase straight to the asset cost account (Dr 1510 / Cr AP).
    const bill = await billOf(
      o,
      {
        itemId: undefined,
        description: 'Compressor',
        quantity: '1',
        unitPrice: '12000',
        accountId: o.accounts['1510'],
      },
      { billDate: '2026-01-15' },
    );
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(await glBalance(o.organizationId, o.accounts['1510']!)).toBe('12000.00');
    const asset = await o.owner.post('/fixed-assets/assets', {
      name: 'Compressor',
      categoryId: category.body.data.id,
      acquisitionDate: '2026-01-15',
      cost: '12000.00',
      lifeMonths: 60,
      alreadyInLedger: true,
    });
    expect(asset.status, JSON.stringify(asset.body)).toBe(201);
    expect(asset.body.data.acquisitionJournalId).toBeNull();
    // Cost is in the ledger once, and the register agrees with it.
    expect(await glBalance(o.organizationId, o.accounts['1510']!)).toBe('12000.00');
    const reconciliation = (
      await o.owner.get('/fixed-assets/reports/reconciliation?asOf=2026-03-31')
    ).body.data;
    const cost = reconciliation.accounts.find((a: { kind: string }) => a.kind === 'cost');
    expect(cost).toMatchObject({ register: '12000.00', ledger: '12000.00', difference: '0.00' });
    await expectLedgerSound(o.organizationId);
  });

  it('refuses to capitalize twice, and shows a deliberately confirmed double posting in the reconciliation', async () => {
    const o = await stockOrg();
    const category = await o.owner.post('/fixed-assets/categories', {
      name: 'Equipment',
      costAccountId: o.accounts['1510'],
      accumulatedAccountId: o.accounts['1520'],
      expenseAccountId: o.accounts['5500'],
      defaultLifeMonths: 60,
    });
    await billOf(
      o,
      {
        itemId: undefined,
        description: 'Compressor',
        quantity: '1',
        unitPrice: '12000',
        accountId: o.accounts['1510'],
      },
      { billDate: '2026-01-15' },
    );
    const asset = await o.owner.post('/fixed-assets/assets', {
      name: 'Compressor',
      categoryId: category.body.data.id,
      acquisitionDate: '2026-01-15',
      cost: '12000.00',
      lifeMonths: 60,
      creditAccountId: o.accounts['1120'],
    });
    expect(asset.status).toBe(409);
    expect(asset.body.error.code).toBe('DUPLICATE_CAPITALIZATION');
    // Only an explicit, audited confirmation posts it; the reconciliation then exposes the gap.
    const confirmed = await o.owner.post('/fixed-assets/assets', {
      name: 'Compressor',
      categoryId: category.body.data.id,
      acquisitionDate: '2026-01-15',
      cost: '12000.00',
      lifeMonths: 60,
      creditAccountId: o.accounts['1120'],
      duplicateOverrideReason: 'Test of the reconciliation',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    const reconciliation = (
      await o.owner.get('/fixed-assets/reports/reconciliation?asOf=2026-03-31')
    ).body.data;
    const cost = reconciliation.accounts.find((a: { kind: string }) => a.kind === 'cost');
    expect(cost).toMatchObject({
      register: '12000.00',
      ledger: '24000.00',
      difference: '12000.00',
    });
  });
});

describe('employee claims against the AP control account', () => {
  it('keeps the claim payable in the AP aging and reconciliation until it is reimbursed', async () => {
    const o = await stockOrg();
    const employee = await o.owner.post('/parties', {
      kind: 'individual',
      displayName: 'Aishath Ali',
      roles: ['employee'],
    });
    expect(employee.status, JSON.stringify(employee.body)).toBe(201);
    const created = await o.owner.post('/expense-claims', {
      employeePartyId: employee.body.data.id,
      claimDate: '2026-03-20',
      lines: [{ expenseDate: '2026-03-18', description: 'Taxi', amount: '200.50' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const submitted = await o.owner.post(`/expense-claims/${created.body.data.id}/submit`, {
      version: created.body.data.version,
    });
    const posted = await o.owner.post(`/expense-claims/${created.body.data.id}/post`, {
      version: submitted.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const aging = (await o.owner.get('/purchases/reports/aging?asOf=2026-03-31')).body.data;
    expect(JSON.stringify(aging)).toContain('Aishath Ali');
    const open = (await o.owner.get('/purchases/reports/ap-reconciliation?asOf=2026-03-31')).body
      .data;
    expect(open).toMatchObject({
      glBalance: '200.50',
      postingsOutsidePurchases: '0.00',
      difference: '0.00',
      reconciled: true,
    });
    // The journal belongs to Purchases (AP control ownership), created through the bill event.
    const bill = (await o.owner.get(`/purchases/bills/${posted.body.data.bill.id}`)).body.data;
    const chain = await chainOf(bill.journalId);
    expect(chain).toMatchObject({ source: 'event', source_module: 'purchases' });
    // Reimbursement is an ordinary vendor payment; the payable clears.
    const vendorId = (await o.owner.get('/vendors?search=Aishath')).body.data.items[0].id;
    const payment = await o.owner.post('/purchases/payments', {
      vendorId,
      paymentDate: '2026-03-25',
      amount: '200.50',
      allocations: [{ billId: bill.id, amount: '200.50' }],
    });
    const recorded = await o.owner.post(`/purchases/payments/${payment.body.data.id}/record`, {
      version: payment.body.data.version,
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    expect(
      (await o.owner.get('/purchases/reports/ap-reconciliation?asOf=2026-03-31')).body.data,
    ).toMatchObject({ glBalance: '0.00', difference: '0.00', reconciled: true });
    await expectLedgerSound(o.organizationId);
  });
});

describe('customer refunds against the AR control account', () => {
  it('holds the AR invariant through a refund and its void', async () => {
    const o = await stockOrg();
    const receipt = await o.owner.post('/sales/receipts', {
      customerId: o.customerId,
      receiptDate: '2026-03-10',
      amount: '500',
      allocations: [],
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const refund = await o.owner.post('/sales/refunds', {
      sourceType: 'receipt',
      sourceId: receipt.body.data.id,
      refundDate: '2026-03-20',
      amount: '120',
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    const chain = await chainOf(refund.body.data.journalId);
    expect(chain).toMatchObject({ source: 'event', source_module: 'sales', imbalance: '0.0000' });
    expect(chain.event_type).toBe('sales.refund_recorded');
    const arReconciliation = async () =>
      (await o.owner.get('/sales/reports/ar-reconciliation?asOf=2026-03-31')).body.data;
    expect(await arReconciliation()).toMatchObject({ glBalance: '-380.00', reconciled: true });
    const voided = await o.owner.post(`/sales/refunds/${refund.body.data.id}/void`, {
      version: refund.body.data.version,
      reason: 'Entered twice',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await arReconciliation()).toMatchObject({ glBalance: '-500.00', reconciled: true });
    await expectLedgerSound(o.organizationId);
  });
});

describe('schema security after migration 0039', () => {
  it('enables row level security with a tenant policy on every organization-scoped table', async () => {
    const { rows } = await owner.query(
      `SELECT c.relname, c.relrowsecurity,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
          -- Phase 1 platform tables: events can precede any organization (nullable organization_id).
          AND c.relname NOT IN ('organizations', 'schema_migrations', 'outbox_events', 'security_events')
        ORDER BY c.relname`,
    );
    const unprotected = rows.filter(
      (r: { relrowsecurity: boolean; policies: number }) => !r.relrowsecurity || r.policies === 0,
    );
    expect(unprotected).toEqual([]);
    expect(rows.length).toBeGreaterThan(100);
  });

  it('grants the application role no delete on posted-history tables (drafts stay deletable by design)', async () => {
    const { rows } = await owner.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'intuit_app' AND privilege_type IN ('DELETE', 'TRUNCATE')
          AND table_name = ANY($1)`,
      [
        [
          'accounting_journal_entries',
          'accounting_events',
          'inventory_movements',
          'sales_refunds',
          'purchases_refunds',
          'sales_receipts',
        ],
      ],
    );
    expect(rows).toEqual([]);
  });

  it('refuses to edit or delete a posted journal line directly', async () => {
    const o = await stockOrg();
    const bill = await postedBill(o, '2', '10');
    const line = await owner.query(
      `SELECT id FROM accounting_journal_lines WHERE journal_id = $1 LIMIT 1`,
      [bill.journalId],
    );
    await expect(
      owner.query(`UPDATE accounting_journal_lines SET base_debit = base_debit + 1 WHERE id = $1`, [
        line.rows[0].id,
      ]),
    ).rejects.toThrow();
    await expect(
      owner.query(`DELETE FROM accounting_journal_lines WHERE id = $1`, [line.rows[0].id]),
    ).rejects.toThrow();
  });
});
