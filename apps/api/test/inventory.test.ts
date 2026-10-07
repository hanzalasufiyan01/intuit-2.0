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
 * Inventory: perpetual weighted-average costing, an immutable stock ledger, stock entering on bills
 * and leaving on invoices (an additive cost-of-goods-sold journal through an accounting event),
 * stock adjustments, negative-stock policy, valuation against the general ledger and security.
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
}

async function stockOrg(options: { track?: boolean } = {}): Promise<StockOrg> {
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
  });
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
  const result = {
    ...org,
    vendorId: vendor.body.data.id as string,
    customerId: customer.body.data.id as string,
    itemId: item.body.data.id as string,
  };
  if (options.track !== false) await track(result);
  return result;
}

async function track(o: StockOrg, itemId = o.itemId) {
  const res = await o.owner.post(`/inventory/items/${itemId}`, {
    inventoryAccountId: o.accounts['1140'],
    cogsAccountId: o.accounts['5100'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function bill(
  o: StockOrg,
  lines: { quantity: string; unitPrice: string; itemId?: string }[],
  date = '2026-03-10',
) {
  const draft = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: date,
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: lines.map((l) => ({
      itemId: l.itemId ?? o.itemId,
      description: 'Coconut oil',
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxCodeId: null,
    })),
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const posted = await o.owner.post(`/purchases/bills/${draft.body.data.id}/post`, {
    version: draft.body.data.version,
  });
  return { draft: draft.body.data, posted };
}

async function postedBill(o: StockOrg, quantity: string, unitPrice: string) {
  const { posted } = await bill(o, [{ quantity, unitPrice }]);
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return posted.body.data;
}

async function invoice(o: StockOrg, quantity: string, date = '2026-03-15') {
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
  return { draft: draft.body.data, issued };
}

async function issuedInvoice(o: StockOrg, quantity: string, date?: string) {
  const { issued } = await invoice(o, quantity, date);
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data;
}

async function stock(o: StockOrg, itemId = o.itemId) {
  const res = await o.owner.get(`/inventory/items/${itemId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { quantity: string; averageCost: string; value: string };
}

async function movements(o: StockOrg, itemId = o.itemId) {
  const res = await o.owner.get(`/inventory/items/${itemId}/movements`);
  return res.body.data.items as {
    kind: string;
    quantity: string;
    value: string;
    quantityAfter: string;
    valueAfter: string;
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

async function journalOf(o: AccountingOrg, journalId: string) {
  return (await o.owner.get(`/accounting/journals/${journalId}`)).body.data as {
    status: string;
    sourceDocument: { documentType: string; number: string } | null;
    lines: { accountId: string; debit: string | null; credit: string | null }[];
  };
}

async function auditActions(o: AccountingOrg, resourceType: string, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action FROM audit_events
      WHERE organization_id = $1 AND resource_type = $2 AND resource_id = $3 ORDER BY occurred_at, id`,
    [o.organizationId, resourceType, resourceId],
  );
  return (rows as { action: string }[]).map((r) => r.action);
}

async function reauth(client: TestClient) {
  ctx.clock.advance(16 * MINUTE);
  await client.get('/auth/session');
  expect((await client.reauthenticate()).status).toBe(200);
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

describe('tracked items', () => {
  it('tracks a product with an inventory and a cost-of-goods-sold account, and defaults its purchases', async () => {
    const o = await stockOrg({ track: false });
    const service = await o.owner.post('/sales/items', { name: 'Delivery', itemType: 'service' });
    const refusedService = await o.owner.post(`/inventory/items/${service.body.data.id}`, {
      inventoryAccountId: o.accounts['1140'],
      cogsAccountId: o.accounts['5100'],
    });
    expect(refusedService.status).toBe(400);
    for (const body of [
      { inventoryAccountId: o.accounts['1120'], cogsAccountId: o.accounts['5100'] }, // a bank account
      { inventoryAccountId: o.accounts['1140'], cogsAccountId: o.accounts['1140'] },
      { inventoryAccountId: o.accounts['1140'], cogsAccountId: o.accounts['4100'] }, // revenue
    ]) {
      const res = await o.owner.post(`/inventory/items/${o.itemId}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const tracked = await track(o);
    expect(tracked).toMatchObject({ quantity: '0', averageCost: '0.0000', value: '0.0000' });
    const item = (await o.owner.get(`/sales/items/${o.itemId}`)).body.data;
    expect(item).toMatchObject({ isPurchased: true, expenseAccountId: o.accounts['1140'] });
    const again = await o.owner.post(`/inventory/items/${o.itemId}`, {
      inventoryAccountId: o.accounts['1140'],
      cogsAccountId: o.accounts['5100'],
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await auditActions(o, 'inventory_item', o.itemId)).toContain('inventory.item_tracked');
  });

  it('can stop tracking only an item that never moved', async () => {
    const o = await stockOrg();
    const untracked = await o.owner.delete(`/inventory/items/${o.itemId}`);
    expect(untracked.status, JSON.stringify(untracked.body)).toBe(200);
    expect((await o.owner.get(`/inventory/items/${o.itemId}`)).status).toBe(404);
    await track(o);
    await postedBill(o, '5', '10');
    const refused = await o.owner.delete(`/inventory/items/${o.itemId}`);
    expect(refused.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const changed = await o.owner.patch(`/inventory/items/${o.itemId}`, {
      version: 1,
      cogsAccountId: o.accounts['5400'],
    });
    expect(changed.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const reorder = await o.owner.patch(`/inventory/items/${o.itemId}`, {
      version: 1,
      reorderPoint: '10',
    });
    expect(reorder.body.data).toMatchObject({ reorderPoint: '10', belowReorderPoint: true });
  });
});

// ---------------------------------------------------------------------------
// Stock in on bills, out on invoices
// ---------------------------------------------------------------------------

describe('stock on bills and invoices', () => {
  it('brings stock in on a bill at the posted cost and averages later receipts', async () => {
    const o = await stockOrg();
    const first = await postedBill(o, '10', '20');
    expect(await stock(o)).toMatchObject({
      quantity: '10',
      averageCost: '20.0000',
      value: '200.0000',
    });
    await postedBill(o, '10', '30');
    expect(await stock(o)).toMatchObject({
      quantity: '20',
      averageCost: '25.0000',
      value: '500.0000',
    });
    // The bill debited the inventory account; the subledger equals it.
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('500.00');
    const journal = await journalOf(o, first.journalId);
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: o.accounts['1140'], debit: '200.0000' }),
      ]),
    );
    const rows = await movements(o);
    expect(rows.map((r) => [r.kind, r.quantity, r.value])).toEqual([
      ['purchase', '10', '300.0000'],
      ['purchase', '10', '200.0000'],
    ]);
  });

  it('issues stock on an invoice at the average cost and posts the cost of goods sold additively', async () => {
    const o = await stockOrg();
    await postedBill(o, '10', '20');
    await postedBill(o, '10', '30');
    const invoiceDoc = await issuedInvoice(o, '4');
    // The invoice journal is the sales one: AR and revenue only.
    const sales = await journalOf(o, invoiceDoc.journalId);
    expect(sales.lines.map((l) => l.accountId).sort()).toEqual(
      [o.accounts['1130'], o.accounts['4100']].sort(),
    );
    const sale = (await movements(o)).find((m) => m.kind === 'sale')!;
    expect(sale).toMatchObject({
      quantity: '-4',
      value: '-100.0000',
      quantityAfter: '16',
      valueAfter: '400.0000',
    });
    const cogs = await journalOf(o, sale.journalId!);
    expect(cogs.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: o.accounts['5100'], debit: '100.0000' }),
        expect.objectContaining({ accountId: o.accounts['1140'], credit: '100.0000' }),
      ]),
    );
    expect(cogs.sourceDocument).toMatchObject({
      documentType: 'invoice',
      number: invoiceDoc.number,
    });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('400.00');
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('100.00');
    // The generic journal reversal refuses an Inventory journal.
    const generic = await o.owner.post(`/accounting/journals/${sale.journalId}/reverse`, {
      reason: 'Reverse it',
    });
    expect(generic.body.error.code).toBe('SYSTEM_JOURNAL');
  });

  it('blocks an invoice that would take stock below zero, issuing nothing', async () => {
    const o = await stockOrg();
    await postedBill(o, '5', '10');
    const { draft, issued } = await invoice(o, '6');
    expect(issued.status).toBe(409);
    expect(issued.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await o.owner.get(`/sales/invoices/${draft.id}`)).body.data.status).toBe('DRAFT');
    expect(await stock(o)).toMatchObject({ quantity: '5', value: '50.0000' });
    expect((await movements(o)).map((m) => m.kind)).toEqual(['purchase']);
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('0.00');
  });

  it('takes the whole remaining value for the last unit, leaving no residue', async () => {
    const o = await stockOrg();
    await postedBill(o, '3', '3.3333');
    await issuedInvoice(o, '1');
    await issuedInvoice(o, '1');
    await issuedInvoice(o, '1');
    expect(await stock(o)).toMatchObject({ quantity: '0', value: '0.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('0.00');
  });

  it('returns the stock of a voided invoice at its original cost and reverses the cost journal', async () => {
    const o = await stockOrg();
    await postedBill(o, '10', '20');
    const doc = await issuedInvoice(o, '4');
    await postedBill(o, '10', '40'); // the average moves after the sale
    await reauth(o.owner);
    const voided = await o.owner.post(`/sales/invoices/${doc.id}/void`, {
      version: doc.version,
      reason: 'Wrong customer',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    // 4 units left at the average of 20 (cost 80); the later bill moved the average, but the 4 return at 80.
    expect(await stock(o)).toMatchObject({ quantity: '20', value: '600.0000' });
    const rows = await movements(o);
    expect(rows.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['purchase', 'sale', 'sale_void']),
    );
    const sale = rows.find((r) => r.kind === 'sale')!;
    expect((await journalOf(o, sale.journalId!)).status).toBe('REVERSED');
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('600.00');
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('0.00');
  });

  it('removes the stock of a voided bill, unless it has been sold', async () => {
    const o = await stockOrg();
    const first = await postedBill(o, '10', '20');
    await reauth(o.owner);
    const voided = await o.owner.post(`/purchases/bills/${first.id}/void`, {
      version: first.version,
      reason: 'Duplicate',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await stock(o)).toMatchObject({ quantity: '0', value: '0.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('0.00');

    const second = await postedBill(o, '10', '20');
    await issuedInvoice(o, '7');
    await reauth(o.owner);
    const refused = await o.owner.post(`/purchases/bills/${second.id}/void`, {
      version: second.version,
      reason: 'Duplicate',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await o.owner.get(`/purchases/bills/${second.id}`)).body.data.status).toBe('POSTED');
    expect(await stock(o)).toMatchObject({ quantity: '3' });
  });

  it('keeps tracked items on their inventory account and stock accounts for tracked items', async () => {
    const o = await stockOrg();
    const wrongAccount = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorId,
      billDate: '2026-03-10',
      vendorReference: 'X-1',
      lines: [
        {
          itemId: o.itemId,
          description: 'Oil',
          quantity: '1',
          unitPrice: '5',
          accountId: o.accounts['5400'],
          taxCodeId: null,
        },
      ],
    });
    const post = await o.owner.post(`/purchases/bills/${wrongAccount.body.data.id}/post`, {
      version: 1,
    });
    expect(post.status).toBe(400);
    expect(post.body.error.details.issues[0].path).toBe('lines.0.accountId');
    const intoStock = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorId,
      billDate: '2026-03-10',
      vendorReference: 'X-2',
      lines: [
        {
          description: 'Mystery stock',
          quantity: '1',
          unitPrice: '5',
          accountId: o.accounts['1140'],
          taxCodeId: null,
        },
      ],
    });
    const post2 = await o.owner.post(`/purchases/bills/${intoStock.body.data.id}/post`, {
      version: 1,
    });
    expect(post2.status).toBe(400);
    expect((await stock(o)).quantity).toBe('0');
  });

  it('refuses tracked items on expenses and vendor credits until they can move stock', async () => {
    const o = await stockOrg();
    const expense = await o.owner.post('/purchases/expenses', {
      vendorId: o.vendorId,
      expenseDate: '2026-03-10',
      lines: [
        { itemId: o.itemId, description: 'Oil', quantity: '1', unitPrice: '5', taxCodeId: null },
      ],
    });
    expect(expense.status, JSON.stringify(expense.body)).toBe(201);
    const post = await o.owner.post(`/purchases/expenses/${expense.body.data.id}/post`, {
      version: 1,
    });
    expect(post.status).toBe(400);
    expect(post.body.error.details.issues[0].path).toBe('lines.0.itemId');
  });
});

// ---------------------------------------------------------------------------
// Negative stock policy
// ---------------------------------------------------------------------------

describe('negative stock policy', () => {
  it('blocks by default and lets an organization allow it, with the policy change audited', async () => {
    const o = await stockOrg();
    const settings = (await o.owner.get('/inventory/settings')).body.data;
    expect(settings).toMatchObject({ negativeStockPolicy: 'block', version: 0 });
    const allowed = await o.owner.put('/inventory/settings', {
      version: 0,
      negativeStockPolicy: 'allow',
      adjustmentAccountId: null,
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    // New tracked items follow the policy; the existing one is updated when it next moves.
    await postedBill(o, '2', '10');
    const sold = await issuedInvoice(o, '5');
    expect(sold.status).toBe('ISSUED');
    const item = await stock(o);
    expect(item.quantity).toBe('-3');
    expect(Number(item.value)).toBeLessThan(0);
    // Blocking again is refused while an item is negative.
    const blocked = await o.owner.put('/inventory/settings', {
      version: 1,
      negativeStockPolicy: 'block',
      adjustmentAccountId: null,
    });
    expect(blocked.body.error.code).toBe('INVALID_STATE_TRANSITION');
    // A receipt that covers the shortfall brings it back and the policy can be blocked again.
    await postedBill(o, '10', '10');
    expect((await stock(o)).quantity).toBe('7');
    const back = await o.owner.put('/inventory/settings', {
      version: 1,
      negativeStockPolicy: 'block',
      adjustmentAccountId: null,
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await auditActions(o, 'inventory_settings', o.organizationId)).toEqual([
      'inventory.settings_updated',
      'inventory.settings_updated',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

describe('stock adjustments', () => {
  async function withOffset(o: StockOrg) {
    const res = await o.owner.put('/inventory/settings', {
      version: 0,
      negativeStockPolicy: 'block',
      adjustmentAccountId: o.accounts['5400'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  it('posts a count increase at a stated cost and a decrease at the average, through the accounting event', async () => {
    const o = await stockOrg();
    await withOffset(o);
    const increase = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: '2026-03-12',
      reason: 'Opening count',
      lines: [{ itemId: o.itemId, quantityChange: '10', unitCost: '12' }],
    });
    expect(increase.status, JSON.stringify(increase.body)).toBe(201);
    expect(increase.body.data).toMatchObject({
      number: 'ADJ-00001',
      netValue: '120.0000',
      status: 'POSTED',
    });
    const journal = await journalOf(o, increase.body.data.journalId);
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: o.accounts['1140'], debit: '120.0000' }),
        expect.objectContaining({ accountId: o.accounts['5400'], credit: '120.0000' }),
      ]),
    );
    expect(journal.sourceDocument).toMatchObject({
      documentType: 'adjustment',
      number: 'ADJ-00001',
    });
    const decrease = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: '2026-03-13',
      reason: 'Damaged',
      lines: [{ itemId: o.itemId, quantityChange: '-4' }],
    });
    expect(decrease.body.data).toMatchObject({ netValue: '-48.0000' });
    expect(await stock(o)).toMatchObject({ quantity: '6', value: '72.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('72.00');
    expect(await glBalance(o.organizationId, o.accounts['5400']!)).toBe('-72.00');
  });

  it('needs a cost on empty stock, an offset account, and refuses a decrease beyond the stock', async () => {
    const o = await stockOrg();
    const noOffset = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: '2026-03-12',
      reason: 'Count',
      lines: [{ itemId: o.itemId, quantityChange: '1', unitCost: '5' }],
    });
    expect(noOffset.body.error.details.issues[0].path).toBe('adjustmentAccountId');
    await withOffset(o);
    const noCost = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: '2026-03-12',
      reason: 'Count',
      lines: [{ itemId: o.itemId, quantityChange: '1' }],
    });
    expect(noCost.body.error.details.issues[0].path).toBe('lines.0.unitCost');
    const tooMany = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: '2026-03-12',
      reason: 'Count',
      lines: [{ itemId: o.itemId, quantityChange: '-1' }],
    });
    expect(tooMany.body.error.code).toBe('INSUFFICIENT_STOCK');
    const duplicate = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: '2026-03-12',
      reason: 'Count',
      lines: [
        { itemId: o.itemId, quantityChange: '1', unitCost: '5' },
        { itemId: o.itemId, quantityChange: '1', unitCost: '5' },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect((await o.owner.get('/inventory/adjustments')).body.data.items).toHaveLength(0);
  });

  it('replays an idempotent adjustment and voids with re-authentication, restoring the stock', async () => {
    const o = await stockOrg();
    await withOffset(o);
    const body = {
      adjustmentDate: '2026-03-12',
      reason: 'Count',
      lines: [{ itemId: o.itemId, quantityChange: '10', unitCost: '8' }],
    };
    const key = randomUUID();
    const first = await o.owner.post('/inventory/adjustments', body, { 'Idempotency-Key': key });
    const replay = await o.owner.post('/inventory/adjustments', body, { 'Idempotency-Key': key });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect((await stock(o)).quantity).toBe('10');
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await o.owner.post(`/inventory/adjustments/${first.body.data.id}/void`, {
      version: first.body.data.version,
      reason: 'Mistake',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const voided = await o.owner.post(`/inventory/adjustments/${first.body.data.id}/void`, {
      version: first.body.data.version,
      reason: 'Mistake',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'VOID', voidReason: 'Mistake' });
    expect(await stock(o)).toMatchObject({ quantity: '0', value: '0.0000' });
    expect((await journalOf(o, first.body.data.journalId)).status).toBe('REVERSED');
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('0.00');
    const again = await o.owner.post(`/inventory/adjustments/${first.body.data.id}/void`, {
      version: voided.body.data.version,
      reason: 'x',
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await auditActions(o, 'inventory_adjustment', first.body.data.id)).toEqual(
      expect.arrayContaining(['inventory.adjustment_posted', 'inventory.adjustment_voided']),
    );
  });

  it('refuses to void an increase whose stock has been sold', async () => {
    const o = await stockOrg();
    await withOffset(o);
    const adj = (
      await o.owner.post('/inventory/adjustments', {
        adjustmentDate: '2026-03-12',
        reason: 'Count',
        lines: [{ itemId: o.itemId, quantityChange: '10', unitCost: '8' }],
      })
    ).body.data;
    await issuedInvoice(o, '6');
    await reauth(o.owner);
    const voided = await o.owner.post(`/inventory/adjustments/${adj.id}/void`, {
      version: adj.version,
      reason: 'Mistake',
    });
    expect(voided.body.error.code).toBe('INSUFFICIENT_STOCK');
  });
});

// ---------------------------------------------------------------------------
// Valuation, ledger immutability and security
// ---------------------------------------------------------------------------

describe('valuation and the stock ledger', () => {
  it('reconciles the stock value with the inventory accounts of the general ledger', async () => {
    const o = await stockOrg();
    await postedBill(o, '10', '20');
    await issuedInvoice(o, '3');
    const valuation = (await o.owner.get('/inventory/valuation')).body.data;
    expect(valuation.totalValue).toBe('140.0000');
    expect(valuation.accounts).toEqual([
      {
        accountId: o.accounts['1140'],
        stockValue: '140.0000',
        glBalance: '140.0000',
        difference: '0.0000',
      },
    ]);
    // A manual journal into the inventory account shows up as a difference.
    const drift = await o.owner.post('/accounting/journals', {
      entryDate: '2026-03-20',
      description: 'Manual',
      currency: 'MVR',
      lines: [
        { accountId: o.accounts['1140'], debit: '25.00', credit: null },
        { accountId: o.accounts['4100'], debit: null, credit: '25.00' },
      ],
    });
    await o.owner.post(`/accounting/journals/${drift.body.data.id}/post`);
    const after = (await o.owner.get('/inventory/valuation')).body.data;
    expect(after.accounts[0].difference).toBe('25.0000');
  });

  it('keeps the stock ledger immutable and refuses a negative balance at the database when blocked', async () => {
    const o = await stockOrg();
    await postedBill(o, '4', '5');
    const { rows } = await owner.query(
      `SELECT id FROM inventory_movements WHERE organization_id = $1 AND item_id = $2`,
      [o.organizationId, o.itemId],
    );
    await expect(
      owner.query(`UPDATE inventory_movements SET quantity = 1 WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.query(`DELETE FROM inventory_movements WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.query(
        `UPDATE inventory_balances SET quantity = -1 WHERE organization_id = $1 AND item_id = $2`,
        [o.organizationId, o.itemId],
      ),
    ).rejects.toThrow(/inventory_balances_not_negative/);
    await expect(
      owner.query(
        `UPDATE inventory_items SET cogs_account_id = $3 WHERE organization_id = $1 AND item_id = $2`,
        [o.organizationId, o.itemId, o.accounts['5400']],
      ),
    ).rejects.toThrow(/stock history/);
  });

  it('is permissioned and tenant-isolated', async () => {
    const a = await stockOrg();
    const b = await stockOrg();
    await postedBill(a, '3', '5');
    expect((await b.owner.get(`/inventory/items/${a.itemId}`)).status).toBe(404);
    expect((await b.owner.get(`/inventory/items/${a.itemId}/movements`)).status).toBe(404);
    expect(
      (
        await b.owner.post(`/inventory/items/${a.itemId}`, {
          inventoryAccountId: b.accounts['1140'],
          cogsAccountId: b.accounts['5100'],
        })
      ).status,
    ).toBe(404);
    const member = await joinWithRole(ctx, a.owner, 'Member');
    expect((await member.client.get('/inventory/items')).status).toBe(200);
    expect((await member.client.get('/inventory/valuation')).status).toBe(200);
    expect(
      (
        await member.client.post('/inventory/adjustments', {
          adjustmentDate: '2026-03-12',
          reason: 'x',
          lines: [{ itemId: a.itemId, quantityChange: '1', unitCost: '1' }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await member.client.post(`/inventory/items/${a.itemId}`, {
          inventoryAccountId: a.accounts['1140'],
          cogsAccountId: a.accounts['5100'],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await member.client.put('/inventory/settings', {
          version: 0,
          negativeStockPolicy: 'allow',
          adjustmentAccountId: null,
        })
      ).status,
    ).toBe(403);
    const client = await connectAs('app');
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      for (const table of ['inventory_items', 'inventory_balances', 'inventory_movements']) {
        const { rows } = await client.query(`SELECT organization_id FROM ${table}`);
        expect(
          rows.every((r: { organization_id: string }) => r.organization_id === b.organizationId),
          table,
        ).toBe(true);
      }
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
