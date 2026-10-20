import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, DAY, type TestContext } from './helpers.js';

/**
 * Purchase suggestions from reorder points (specification section 18, R-03). A suggestion is
 * read-only: it creates no purchase order, moves no stock and posts nothing. For each tracked item
 * with a reorder point, available = on hand - reserved + on order, and the suggestion is what would
 * bring available back up to the reorder point, listed only when it is above zero.
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
}

async function org(): Promise<Org> {
  const o = await setUpAccountingOrg(ctx);
  for (const [path, body] of [
    [
      '/purchases/settings',
      {
        version: 0,
        apAccountId: o.accounts['2110'],
        defaultExpenseAccountId: o.accounts['5400'],
        defaultPaymentAccountId: o.accounts['1120'],
        defaultTaxCodeId: null,
        defaultTaxTreatment: 'exclusive',
        defaultPaymentTermsDays: 30,
      },
    ],
    [
      '/inventory/settings',
      { version: 0, negativeStockPolicy: 'block', adjustmentAccountId: o.accounts['5400'] },
    ],
  ] as const) {
    expect((await o.owner.put(path, body)).status, path).toBe(200);
  }
  const vendor = await o.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Wholesale' },
  });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  return { ...o, vendorId: vendor.body.data.id };
}

/** A tracked item with an optional reorder point and an opening quantity brought in by a bill. */
async function item(
  o: Org,
  name: string,
  opts: { reorderPoint?: string; stock?: string; tracked?: boolean } = {},
) {
  const created = await o.owner.post('/sales/items', {
    name,
    itemType: 'product',
    unitPrice: '50',
    isPurchased: true,
    revenueAccountId: o.accounts['4100'],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  if (opts.tracked === false) return id;
  const tracking = await o.owner.post(`/inventory/items/${id}`, {
    inventoryAccountId: o.accounts['1140'],
    cogsAccountId: o.accounts['5100'],
    ...(opts.reorderPoint !== undefined ? { reorderPoint: opts.reorderPoint } : {}),
  });
  expect(tracking.status, JSON.stringify(tracking.body)).toBe(201);
  if (opts.stock && opts.stock !== '0') {
    const bill = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorId,
      billDate: '2026-03-10',
      vendorReference: `SI-${randomUUID().slice(0, 8)}`,
      lines: [
        {
          itemId: id,
          description: 'Stock',
          quantity: opts.stock,
          unitPrice: '10',
          taxCodeId: null,
        },
      ],
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const posted = await o.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
      version: bill.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  }
  return id;
}

const suggestions = (o: AccountingOrg) => o.owner.get('/inventory/reports/purchase-suggestions');

type Suggestion = {
  itemId: string;
  name: string;
  onHand: string;
  reserved: string;
  onOrder: string;
  available: string;
  reorderPoint: string;
  suggestedQuantity: string;
};

async function listed(o: AccountingOrg) {
  const res = await suggestions(o);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.items as Suggestion[];
}

const byName = (items: Suggestion[], name: string) => items.find((i) => i.name === name);

async function purchaseOrder(
  o: Org,
  lines: { itemId: string; quantity: string }[],
  options: { submit?: boolean } = {},
) {
  const created = await o.owner.post('/purchases/orders', {
    vendorId: o.vendorId,
    orderDate: '2026-03-10',
    expectedDate: '2026-03-20',
    lines: lines.map((l) => ({
      itemId: l.itemId,
      description: 'Stock',
      quantity: l.quantity,
      unitPrice: '10',
      taxCodeId: null,
    })),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  if (options.submit === false) return created.body.data;
  const submitted = await o.owner.post(`/purchases/orders/${created.body.data.id}/submit`, {
    version: created.body.data.version,
  });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  expect(submitted.body.data.status).toBe('APPROVED');
  return submitted.body.data;
}

describe('quantities and edge cases', () => {
  it('lists only tracked items strictly below their reorder point, largest shortfall first', async () => {
    const o = await org();
    await item(o, 'Short by six', { reorderPoint: '10', stock: '4' });
    await item(o, 'Short by fifteen', { reorderPoint: '20', stock: '5' });
    await item(o, 'Exactly at the point', { reorderPoint: '10', stock: '10' });
    await item(o, 'Plenty', { reorderPoint: '10', stock: '25' });
    await item(o, 'No reorder point', { stock: '0' });
    await item(o, 'Not tracked', { tracked: false });
    await item(o, 'Empty shelf', { reorderPoint: '8' });

    const items = await listed(o);
    expect(items.map((i) => [i.name, i.suggestedQuantity])).toEqual([
      ['Short by fifteen', '15'],
      ['Empty shelf', '8'],
      ['Short by six', '6'],
    ]);
    expect(byName(items, 'Short by six')).toMatchObject({
      onHand: '4',
      reserved: '0',
      onOrder: '0',
      available: '4',
      reorderPoint: '10',
    });
    // Against the low-stock report on the same data: every suggestion is a low-stock item with the
    // same shortfall, and the item exactly at its point is low stock but needs nothing.
    const low = (await o.owner.get('/inventory/reports/low-stock')).body.data.items as {
      name: string;
      shortfall: string;
    }[];
    for (const s of items) {
      expect(low.find((l) => l.name === s.name)?.shortfall, s.name).toBe(s.suggestedQuantity);
    }
    expect(low.map((l) => l.name)).toContain('Exactly at the point');
    expect(items.map((i) => i.name)).not.toContain('Exactly at the point');
  });

  it('shows an empty list, and an empty note, when nothing is below its point', async () => {
    const o = await org();
    await item(o, 'Plenty', { reorderPoint: '5', stock: '9' });
    const res = await suggestions(o);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.note).toMatch(/nothing is ordered/i);
  });

  it('lowers availability by active reservations and ignores expired ones', async () => {
    const o = await org();
    const id = await item(o, 'Reserved oil', { reorderPoint: '10', stock: '12' });
    // 12 on hand is above the point of 10: nothing to suggest yet.
    expect(await listed(o)).toEqual([]);
    const held = await o.owner.post('/inventory/reservations', { itemId: id, quantity: '5' });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    // 12 - 5 = 7 available: 3 short of the point.
    expect(byName(await listed(o), 'Reserved oil')).toMatchObject({
      onHand: '12',
      reserved: '5',
      available: '7',
      suggestedQuantity: '3',
    });
    // A reservation that lapses stops holding stock. (The clock is not moved: that would also end
    // the session, so the expiry date is set in the past directly.)
    const tomorrow = new Date(ctx.clock.now().getTime() + DAY).toISOString().slice(0, 10);
    const timed = await o.owner.post('/inventory/reservations', {
      itemId: id,
      quantity: '2',
      expiresOn: tomorrow,
    });
    expect(timed.status, JSON.stringify(timed.body)).toBe(201);
    expect(byName(await listed(o), 'Reserved oil')?.suggestedQuantity).toBe('5');
    await db.query(
      `UPDATE stock_reservations SET expires_on = (current_date - 1) WHERE organization_id = $1 AND id = $2`,
      [o.organizationId, timed.body.data.id],
    );
    expect(byName(await listed(o), 'Reserved oil')?.suggestedQuantity).toBe('3');
  });

  it('is the same figure the availability screen shows for reservations', async () => {
    const o = await org();
    const id = await item(o, 'Shown oil', { reorderPoint: '10', stock: '12' });
    await o.owner.post('/inventory/reservations', { itemId: id, quantity: '4' });
    const availability = (await o.owner.get(`/inventory/items/${id}/availability`)).body.data;
    const row = byName(await listed(o), 'Shown oil')!;
    expect(row.reserved).toBe(availability.reserved);
    expect(row.available).toBe(availability.available);
  });
});

describe('purchase orders already placed', () => {
  it('counts approved orders for their unbilled remainder and nothing else', async () => {
    const o = await org();
    const id = await item(o, 'Ordered oil', { reorderPoint: '10', stock: '4' });
    expect(byName(await listed(o), 'Ordered oil')?.suggestedQuantity).toBe('6');

    // A draft order is not a commitment.
    await purchaseOrder(o, [{ itemId: id, quantity: '5' }], { submit: false });
    expect(byName(await listed(o), 'Ordered oil')).toMatchObject({
      onOrder: '0',
      suggestedQuantity: '6',
    });

    // An approved order for 5 is on its way: 4 + 5 = 9, one short of the point.
    const order = await purchaseOrder(o, [{ itemId: id, quantity: '5' }]);
    expect(byName(await listed(o), 'Ordered oil')).toMatchObject({
      onOrder: '5',
      available: '9',
      suggestedQuantity: '1',
    });

    // Receiving goods does not by itself add stock (stock enters on the bill), so nothing changes.
    const line = (await o.owner.get(`/purchases/orders/${order.id}`)).body.data.lines[0];
    const received = await o.owner.post(`/purchases/orders/${order.id}/receipts`, {
      receiptDate: '2026-03-12',
      lines: [{ orderLineId: line.id, quantity: '2' }],
    });
    expect(received.status, JSON.stringify(received.body)).toBe(201);
    expect(byName(await listed(o), 'Ordered oil')).toMatchObject({ onHand: '4', onOrder: '5' });

    // Billing the 2 received moves them from "on order" to "on hand": the total is unchanged.
    const bill = await o.owner.post(`/purchases/orders/${order.id}/create-bill`, {
      basis: 'received',
      billDate: '2026-03-15',
      vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const posted = await o.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
      version: bill.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(byName(await listed(o), 'Ordered oil')).toMatchObject({
      onHand: '6',
      onOrder: '3',
      available: '9',
      suggestedQuantity: '1',
    });

    // Closing the order gives up the rest: 6 on hand, nothing coming, 4 short.
    const current = (await o.owner.get(`/purchases/orders/${order.id}`)).body.data;
    const closed = await o.owner.post(`/purchases/orders/${order.id}/close`, {
      version: current.version,
      reason: 'Supplier cannot deliver the rest',
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(byName(await listed(o), 'Ordered oil')).toMatchObject({
      onHand: '6',
      onOrder: '0',
      suggestedQuantity: '4',
    });
  });

  it('stops suggesting an item once an order covers it, and converts purchase units to base units', async () => {
    const o = await org();
    const id = await item(o, 'Carton oil', { reorderPoint: '30' });
    const units = await o.owner.put(`/inventory/items/${id}/units`, {
      version: 1,
      baseUnit: 'bottle',
      purchaseUnit: { unit: 'carton', factor: '12' },
      salesUnit: null,
    });
    expect(units.status, JSON.stringify(units.body)).toBe(200);
    expect(byName(await listed(o), 'Carton oil')?.suggestedQuantity).toBe('30');
    // Two cartons are 24 bottles on order: 6 bottles still short of 30.
    await purchaseOrder(o, [{ itemId: id, quantity: '2' }]);
    expect(byName(await listed(o), 'Carton oil')).toMatchObject({
      baseUnit: 'bottle',
      onOrder: '24',
      suggestedQuantity: '6',
    });
    // Three more cartons cover it completely: the item disappears.
    await purchaseOrder(o, [{ itemId: id, quantity: '3' }]);
    expect(byName(await listed(o), 'Carton oil')).toBeUndefined();
  });
});

describe('a suggestion changes nothing', () => {
  it('creates no order, moves no stock, posts no journal and writes no audit event', async () => {
    const o = await org();
    const id = await item(o, 'Quiet oil', { reorderPoint: '10', stock: '2' });
    await purchaseOrder(o, [{ itemId: id, quantity: '3' }]);
    const counts = async () => {
      const { rows } = await db.query(
        `SELECT (SELECT count(*) FROM purchase_orders WHERE organization_id = $1)::int AS orders,
                (SELECT count(*) FROM inventory_movements WHERE organization_id = $1)::int AS movements,
                (SELECT count(*) FROM accounting_journal_entries WHERE organization_id = $1)::int AS journals,
                (SELECT count(*) FROM stock_reservations WHERE organization_id = $1)::int AS reservations,
                (SELECT count(*) FROM audit_events WHERE organization_id = $1)::int AS audits,
                (SELECT quantity::text FROM inventory_balances WHERE organization_id = $1 AND item_id = $2) AS quantity`,
        [o.organizationId, id],
      );
      return rows[0];
    };
    const before = await counts();
    for (let i = 0; i < 3; i += 1) expect((await suggestions(o)).status).toBe(200);
    expect(await counts()).toEqual(before);
    expect(byName(await listed(o), 'Quiet oil')?.suggestedQuantity).toBe('5');
  });
});

describe('permissions and tenants', () => {
  it('needs both the inventory and the purchase-order view permissions', async () => {
    const o = await org();
    await item(o, 'Guarded oil', { reorderPoint: '10', stock: '1' });
    const role = async (name: string, permissionKeys: string[]) => {
      const created = await o.owner.post('/organizations/current/roles', { name, permissionKeys });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return (await joinWithRole(ctx, o.owner, name)).client;
    };
    const stockOnly = await role('Stock clerk', ['inventory.view']);
    const ordersOnly = await role('Order clerk', ['purchase_orders.view']);
    const both = await role('Buyer', ['inventory.view', 'purchase_orders.view']);
    const nothing = await role('Customer clerk', ['customers.view']);
    const path = '/inventory/reports/purchase-suggestions';
    for (const [who, client] of [
      ['stock only', stockOnly],
      ['orders only', ordersOnly],
      ['neither', nothing],
    ] as const) {
      const res = await client.get(path);
      expect(res.status, who).toBe(403);
      expect(JSON.stringify(res.body), who).not.toContain('Guarded oil');
    }
    const allowed = await both.get(path);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.data.items.map((i: Suggestion) => i.name)).toEqual(['Guarded oil']);
    // Signed out is refused.
    const anonymous = await ctx.app.inject({ method: 'GET', url: `/api/v1${path}` });
    expect(anonymous.statusCode).toBe(401);
  });

  it('never mixes the items, reservations or orders of two organizations', async () => {
    const a = await org();
    const b = await org();
    const idA = await item(a, 'Alpha oil', { reorderPoint: '10', stock: '2' });
    await a.owner.post('/inventory/reservations', { itemId: idA, quantity: '1' });
    await purchaseOrder(a, [{ itemId: idA, quantity: '4' }]);
    // Organization B has an item of the same name; A's reservation and order must not touch it.
    await item(b, 'Alpha oil', { reorderPoint: '10', stock: '2' });
    const ofA = byName(await listed(a), 'Alpha oil');
    const ofB = byName(await listed(b), 'Alpha oil');
    expect(ofA).toMatchObject({ reserved: '1', onOrder: '4', suggestedQuantity: '5' });
    expect(ofB).toMatchObject({ reserved: '0', onOrder: '0', suggestedQuantity: '8' });
    expect(ofA?.itemId).not.toBe(ofB?.itemId);
  });
});
