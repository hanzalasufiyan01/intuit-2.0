import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Units of measure (FP-29 A2, migration 0082, ADR 0014 AI-09): document quantities in an item's
 * purchase or sales unit are converted to the base unit when stock moves; cost stays one average
 * per base unit and the stock value keeps equalling the ledger. Real PostgreSQL.
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

const todayIso = () => ctx.clock.now().toISOString().slice(0, 10);

interface Org extends AccountingOrg {
  vendorId: string;
  customerId: string;
  oil: string;
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
      '/sales/settings',
      {
        version: 0,
        arAccountId: o.accounts['1130'],
        defaultRevenueAccountId: o.accounts['4100'],
        defaultDepositAccountId: o.accounts['1120'],
        defaultTaxCodeId: null,
        defaultTaxTreatment: 'no_tax',
        defaultPaymentTermsDays: 0,
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
  const customer = await o.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Resort' },
  });
  const item = await o.owner.post('/sales/items', {
    name: 'Coconut oil 1L',
    itemType: 'product',
    unitPrice: '100',
    revenueAccountId: o.accounts['4100'],
  });
  expect(
    (
      await o.owner.post(`/inventory/items/${item.body.data.id}`, {
        inventoryAccountId: o.accounts['1140'],
        cogsAccountId: o.accounts['5100'],
      })
    ).status,
  ).toBe(201);
  return {
    ...o,
    vendorId: vendor.body.data.id,
    customerId: customer.body.data.id,
    oil: item.body.data.id,
  };
}

const units = (o: Org, version: number, body: object = {}) =>
  o.owner.put(`/inventory/items/${o.oil}/units`, {
    version,
    baseUnit: 'bottle',
    purchaseUnit: { unit: 'carton', factor: '24' },
    salesUnit: { unit: 'dozen', factor: '12' },
    ...body,
  });

async function draftBill(o: Org, quantity: string, unitPrice: string) {
  const draft = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: '2026-03-10',
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: [{ itemId: o.oil, description: 'Stock', quantity, unitPrice, taxCodeId: null }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  return draft.body.data as { id: string; version: number };
}

const postBill = (o: Org, b: { id: string; version: number }) =>
  o.owner.post(`/purchases/bills/${b.id}/post`, { version: b.version });

async function draftInvoice(o: Org, quantity: string) {
  const draft = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate: todayIso(),
    dueDate: todayIso(),
    lines: [{ itemId: o.oil, description: 'Sale', quantity, unitPrice: '100' }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  return draft.body.data as { id: string; version: number };
}

const stock = async (o: Org) =>
  (await o.owner.get(`/inventory/items/${o.oil}`)).body.data as {
    quantity: string;
    value: string;
    averageCost: string;
    baseUnit: string;
    purchaseUnit: unknown;
    salesUnit: unknown;
  };

async function valuationIsZero(o: Org) {
  for (const a of (await o.owner.get('/inventory/valuation')).body.data.accounts) {
    expect(Number(a.difference), `valuation ${a.accountId}`).toBe(0);
  }
}

describe('units of measure', () => {
  it('converts purchase and sales quantities to the base unit and keeps one cost per base unit', async () => {
    const o = await org();
    const set = await units(o, 1);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data).toMatchObject({
      baseUnit: 'bottle',
      purchaseUnit: { unit: 'carton', factor: '24' },
      salesUnit: { unit: 'dozen', factor: '12' },
      version: 2,
    });
    // 2 cartons at 240 each = 480 for 48 bottles: 10 a bottle.
    expect((await postBill(o, await draftBill(o, '2', '240'))).status).toBe(200);
    expect(await stock(o)).toMatchObject({
      quantity: '48',
      value: '480.0000',
      averageCost: '10.0000',
      baseUnit: 'bottle',
    });
    // 3 dozen sold = 36 bottles, cost 360.
    const invoice = await draftInvoice(o, '3');
    const issued = await o.owner.post(`/sales/invoices/${invoice.id}/issue`, {
      version: invoice.version,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(await stock(o)).toMatchObject({ quantity: '12', value: '120.0000' });
    await valuationIsZero(o);
    const item = (await o.owner.get(`/inventory/items/${o.oil}`)).body.data;
    expect(item.purchaseUnit).toEqual({ unit: 'carton', factor: '24' });
    expect((await o.owner.get(`/inventory/items/${o.oil}/units`)).body.data.salesUnit).toEqual({
      unit: 'dozen',
      factor: '12',
    });
    // Selling more dozens than the bottles allow is refused in base terms (2 dozen = 24 > 12).
    const over = await draftInvoice(o, '2');
    const refused = await o.owner.post(`/sales/invoices/${over.id}/issue`, {
      version: over.version,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('refuses a quantity that is not an exact number of base units, and units that are invalid', async () => {
    const o = await org();
    expect((await units(o, 1, { purchaseUnit: { unit: 'half', factor: '0.5' } })).status).toBe(200);
    const bill = await draftBill(o, '0.000001', '1000000'); // 0.0000005 base units: seven places
    const refused = await postBill(o, bill);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('not a whole number of base units');
    for (const bad of [
      { purchaseUnit: { unit: 'carton', factor: '0' } },
      { purchaseUnit: { unit: '', factor: '2' } },
      { salesUnit: { unit: 'box', factor: '1.1234567' } },
      { baseUnit: ' ' },
      { extra: 1 },
    ]) {
      expect((await units(o, 2, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    // The draft bill that failed to post still carries the item: remove it before changing units.
    const del = await o.owner.delete(`/purchases/bills/${bill.id}?version=${bill.version}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    const cleared = await units(o, 2, { purchaseUnit: null, salesUnit: null });
    expect(cleared.body.data).toMatchObject({ purchaseUnit: null, salesUnit: null });
  });

  it('measures returns to suppliers and customers in base units', async () => {
    const o = await org();
    expect((await units(o, 1)).status).toBe(200);
    await postBill(o, await draftBill(o, '2', '240')); // 48 bottles
    const invoice = await draftInvoice(o, '2'); // 2 dozen = 24 bottles
    const issued = await o.owner.post(`/sales/invoices/${invoice.id}/issue`, {
      version: invoice.version,
    });
    expect(issued.status).toBe(200);
    const note = await o.owner.post('/sales/credit-notes', {
      customerId: o.customerId,
      creditDate: todayIso(),
      invoiceId: issued.body.data.id,
      lines: [
        {
          itemId: o.oil,
          description: 'Returned',
          quantity: '1',
          unitPrice: '100',
          taxCodeId: null,
        },
      ], // 1 dozen
    });
    const credit = await o.owner.post(`/sales/credit-notes/${note.body.data.id}/issue`, {
      version: note.body.data.version,
    });
    expect(credit.status, JSON.stringify(credit.body)).toBe(200);
    const returnable = (await o.owner.get(`/inventory/returns/returnable/${note.body.data.id}`))
      .body.data;
    expect(returnable.items[0]).toMatchObject({ credited: '12', remaining: '12' });
    const body = (quantity: string) => ({
      returnDate: todayIso(),
      creditNoteId: note.body.data.id,
      reason: 'Back',
      lines: [{ itemId: o.oil, quantity }],
    });
    expect((await o.owner.post('/inventory/returns', body('13'))).status).toBe(400);
    expect((await o.owner.post('/inventory/returns', body('12'))).status).toBe(201);
    expect(await stock(o)).toMatchObject({ quantity: '36' }); // 48 - 24 + 12
    await valuationIsZero(o);
  });

  it('will not change units under a draft document, and is permissioned, audited and tenant isolated', async () => {
    const o = await org();
    const draft = await draftInvoice(o, '1');
    const blocked = await units(o, 1);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('draft invoice');
    await o.owner.delete(`/sales/invoices/${draft.id}?version=${draft.version}`);
    expect((await units(o, 1)).status).toBe(200);
    expect((await units(o, 1)).status).toBe(409); // stale version
    const audit = await db.query(
      `SELECT metadata FROM audit_events WHERE organization_id = $1 AND action = 'inventory.item_units_updated'`,
      [o.organizationId],
    );
    expect(audit.rows[0].metadata.after).toMatchObject({
      baseUnit: 'bottle',
      purchaseUnit: 'carton',
    });
    const other = await org();
    expect((await other.owner.get(`/inventory/items/${o.oil}/units`)).status).toBe(404);
    await o.owner.post('/organizations/current/roles', {
      name: 'Viewer',
      permissionKeys: ['organization.read', 'inventory.view'],
    });
    const viewer = await joinWithRole(ctx, o.owner, 'Viewer');
    expect((await viewer.client.get(`/inventory/items/${o.oil}/units`)).status).toBe(200);
    expect(
      (await viewer.client.put(`/inventory/items/${o.oil}/units`, { version: 2, baseUnit: 'x' }))
        .status,
    ).toBe(403);
    expect((await ctx.client().get(`/inventory/items/${o.oil}/units`)).status).toBe(401);
    await expect(
      db.query(
        `UPDATE inventory_items SET purchase_factor = NULL WHERE organization_id = $1 AND item_id = $2`,
        [o.organizationId, o.oil],
      ),
    ).rejects.toThrow(/purchase_unit_pair/);
  });
});
