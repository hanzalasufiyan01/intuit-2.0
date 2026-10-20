import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Lots, serials and expiry (FP-29 A6, migration 0079, ADR 0014 AI-07). Cost stays one average per
 * item; lots carry quantities. Invariants: lot levels add up to warehouse levels and to the item
 * balance, stock value equals the ledger, voids restore the very same lots. Real PostgreSQL.
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
const shift = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface Org extends AccountingOrg {
  vendorId: string;
  customerId: string;
  oil: string; // lot + expiry tracked
  phone: string; // serial tracked
  salt: string; // plain
  main: string;
  annex: string;
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
  const make = async (name: string, extra: object = {}) => {
    const item = await o.owner.post('/sales/items', {
      name,
      itemType: 'product',
      unitPrice: '100',
      revenueAccountId: o.accounts['4100'],
    });
    const tracked = await o.owner.post(`/inventory/items/${item.body.data.id}`, {
      inventoryAccountId: o.accounts['1140'],
      cogsAccountId: o.accounts['5100'],
      ...extra,
    });
    expect(tracked.status, JSON.stringify(tracked.body)).toBe(201);
    return item.body.data.id as string;
  };
  const warehouses = await o.owner.get('/inventory/warehouses');
  const annex = await o.owner.post('/inventory/warehouses', { code: 'ANNEX', name: 'Annex' });
  return {
    ...o,
    vendorId: vendor.body.data.id,
    customerId: customer.body.data.id,
    oil: await make('Coconut oil 1L', { trackingMode: 'lot', expiryTracked: true }),
    phone: await make('Satellite phone', { trackingMode: 'serial' }),
    salt: await make('Sea salt 1kg'),
    main: warehouses.body.data.find((w: { isDefault: boolean }) => w.isDefault).id,
    annex: annex.body.data.id,
  };
}

type Lot = { itemId: string; lotCode: string; expiryDate?: string; quantity: string };

async function draftBill(o: Org, itemId: string, quantity: string, unitPrice: string) {
  const draft = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: '2026-03-10',
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: [{ itemId, description: 'Stock', quantity, unitPrice, taxCodeId: null }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  return draft.body.data as { id: string; version: number };
}

const postBill = (o: Org, b: { id: string; version: number }) =>
  o.owner.post(`/purchases/bills/${b.id}/post`, { version: b.version });

async function buy(
  o: Org,
  itemId: string,
  quantity: string,
  unitPrice: string,
  lots: Lot[],
  warehouseId?: string,
) {
  const bill = await draftBill(o, itemId, quantity, unitPrice);
  if (lots.length) {
    const set = await o.owner.put(`/inventory/document-lots/bill/${bill.id}`, { lots });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
  }
  if (warehouseId) {
    await o.owner.put(`/inventory/document-warehouse/bill/${bill.id}`, { warehouseId });
  }
  const posted = await postBill(o, bill);
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return posted.body.data;
}

async function sell(o: Org, itemId: string, quantity: string, invoiceDate = todayIso()) {
  const draft = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate,
    dueDate: invoiceDate,
    lines: [{ itemId, description: 'Sale', quantity, unitPrice: '100' }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  return o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
}

const lots = async (o: Org, itemId: string) =>
  Object.fromEntries(
    (await o.owner.get(`/inventory/items/${itemId}/lots`)).body.data.map(
      (l: { code: string; quantity: string }) => [l.code, l.quantity],
    ),
  ) as Record<string, string>;

async function invariants(o: Org) {
  const rows = await db.query(
    `SELECT i.item_id, i.tracking_mode, b.quantity::text AS balance,
            coalesce((SELECT sum(l.quantity) FROM inventory_stock_levels l WHERE l.organization_id = i.organization_id AND l.item_id = i.item_id), 0)::text AS levels,
            coalesce((SELECT sum(v.quantity) FROM inventory_lot_levels v WHERE v.organization_id = i.organization_id AND v.item_id = i.item_id), 0)::text AS lot_levels,
            coalesce((SELECT sum(e.quantity) FROM inventory_stock_entries e WHERE e.organization_id = i.organization_id AND e.item_id = i.item_id), 0)::text AS entries
       FROM inventory_items i JOIN inventory_balances b ON b.organization_id = i.organization_id AND b.item_id = i.item_id
      WHERE i.organization_id = $1`,
    [o.organizationId],
  );
  for (const r of rows.rows) {
    expect(Number(r.levels), `levels ${r.item_id}`).toBe(Number(r.balance));
    expect(Number(r.entries), `entries ${r.item_id}`).toBe(Number(r.balance));
    if (r.tracking_mode !== 'none')
      expect(Number(r.lot_levels), `lot levels ${r.item_id}`).toBe(Number(r.balance));
  }
  for (const a of (await o.owner.get('/inventory/valuation')).body.data.accounts) {
    expect(Number(a.difference), `valuation ${a.accountId}`).toBe(0);
  }
}

describe('lot tracking', () => {
  it('validates the tracking mode and fixes it once the item has stock history', async () => {
    const o = await org();
    const item = await o.owner.post('/sales/items', {
      name: 'Tea',
      itemType: 'product',
      unitPrice: '5',
      revenueAccountId: o.accounts['4100'],
    });
    const bad = await o.owner.post(`/inventory/items/${item.body.data.id}`, {
      inventoryAccountId: o.accounts['1140'],
      cogsAccountId: o.accounts['5100'],
      expiryTracked: true,
    });
    expect(bad.status).toBe(400); // expiry needs a lot mode
    const tracked = await o.owner.post(`/inventory/items/${item.body.data.id}`, {
      inventoryAccountId: o.accounts['1140'],
      cogsAccountId: o.accounts['5100'],
      trackingMode: 'lot',
    });
    expect(tracked.body.data).toMatchObject({ trackingMode: 'lot', expiryTracked: false });
    const patched = await o.owner.patch(`/inventory/items/${item.body.data.id}`, {
      version: 1,
      trackingMode: 'serial',
    });
    expect(patched.body.data.trackingMode).toBe('serial'); // no stock history yet
    await buy(o, item.body.data.id, '1', '5', [
      { itemId: item.body.data.id, lotCode: 'SN-1', quantity: '1' },
    ]);
    const late = await o.owner.patch(`/inventory/items/${item.body.data.id}`, {
      version: 2,
      trackingMode: 'lot',
    });
    expect(late.status).toBe(409);
    await expect(
      db.query(
        `UPDATE inventory_items SET tracking_mode = 'none' WHERE organization_id = $1 AND item_id = $2`,
        [o.organizationId, item.body.data.id],
      ),
    ).rejects.toThrow(/lot tracking cannot change/);
  });

  it('receives lots on a bill only with lots that add up, and needs expiry dates when tracked', async () => {
    const o = await org();
    const bill = await draftBill(o, o.oil, '10', '12');
    const refused = await postBill(o, bill);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('Coconut oil 1L');
    const set = (l: Lot[]) => o.owner.put(`/inventory/document-lots/bill/${bill.id}`, { lots: l });
    expect(
      (await set([{ itemId: o.oil, lotCode: 'A1', expiryDate: '2027-01-31', quantity: '4' }]))
        .status,
    ).toBe(200);
    const short = await postBill(o, bill);
    expect(short.status).toBe(400); // 4 of 10
    expect((await set([{ itemId: o.oil, lotCode: 'A1', quantity: '10' }])).status).toBe(200); // no expiry
    expect((await postBill(o, bill)).status).toBe(400);
    expect((await set([{ itemId: o.salt, lotCode: 'X', quantity: '1' }])).status).toBe(400); // an untracked item has no lots
    expect(
      (
        await set([
          { itemId: o.oil, lotCode: 'A1', expiryDate: '2027-01-31', quantity: '5' },
          { itemId: o.oil, lotCode: 'a1', quantity: '5' },
        ])
      ).status,
    ).toBe(400); // duplicate code
    expect(
      (
        await set([
          { itemId: o.oil, lotCode: 'A1', expiryDate: '2027-01-31', quantity: '6' },
          { itemId: o.oil, lotCode: 'B2', expiryDate: '2026-12-31', quantity: '4' },
        ])
      ).status,
    ).toBe(200);
    const ok = await postBill(o, bill);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await lots(o, o.oil)).toEqual({ A1: '6', B2: '4' });
    await invariants(o);
    // A posted bill's lots are frozen.
    expect((await set([])).status).toBe(409);
  });

  it('sells first-expired-first-out, skips expired lots, and writes expired stock off by adjustment', async () => {
    const o = await org();
    const today = todayIso();
    await buy(o, o.oil, '12', '10', [
      { itemId: o.oil, lotCode: 'OLD', expiryDate: shift(today, -5), quantity: '2' }, // expired
      { itemId: o.oil, lotCode: 'SOON', expiryDate: shift(today, 20), quantity: '4' },
      { itemId: o.oil, lotCode: 'LATE', expiryDate: shift(today, 200), quantity: '6' },
    ]);
    const sale = await sell(o, o.oil, '7');
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    expect(await lots(o, o.oil)).toEqual({ OLD: '2', SOON: '0', LATE: '3' }); // SOON first, then LATE; OLD skipped
    // Only the expired lot and 3 good units are left: 4 cannot be sold.
    const short = await sell(o, o.oil, '4');
    expect(short.status).toBe(409);
    expect(short.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(short.body.error.message).toContain('expired lots are not sold');
    await invariants(o);
    // Writing the expired lot off needs a decrease that names it.
    const wrong = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: today,
      reason: 'Expired',
      lines: [{ itemId: o.oil, quantityChange: '-2', lots: [{ lotCode: 'LATE', quantity: '3' }] }],
    });
    expect(wrong.status).toBe(400); // 3 named, 2 needed
    const writeOff = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: today,
      reason: 'Expired stock',
      lines: [{ itemId: o.oil, quantityChange: '-2', lots: [{ lotCode: 'OLD', quantity: '2' }] }],
    });
    expect(writeOff.status, JSON.stringify(writeOff.body)).toBe(201);
    expect(writeOff.body.data.lines[0]).toBeDefined();
    expect(await lots(o, o.oil)).toEqual({ OLD: '0', SOON: '0', LATE: '3' });
    await invariants(o);
  });

  it('tracks serial numbers: one unit each, oldest first, never twice in stock', async () => {
    const o = await org();
    await buy(o, o.phone, '3', '200', [
      { itemId: o.phone, lotCode: 'SN-001', quantity: '1' },
      { itemId: o.phone, lotCode: 'SN-002', quantity: '1' },
      { itemId: o.phone, lotCode: 'SN-003', quantity: '1' },
    ]);
    const bad = await draftBill(o, o.phone, '2', '200');
    expect(
      (
        await o.owner.put(`/inventory/document-lots/bill/${bad.id}`, {
          lots: [{ itemId: o.phone, lotCode: 'SN-9', quantity: '2' }],
        })
      ).status,
    ).toBe(400); // a serial is one unit
    // The same serial cannot be received again while it is in stock.
    await o.owner.put(`/inventory/document-lots/bill/${bad.id}`, {
      lots: [
        { itemId: o.phone, lotCode: 'SN-001', quantity: '1' },
        { itemId: o.phone, lotCode: 'SN-004', quantity: '1' },
      ],
    });
    const dup = await postBill(o, bad);
    expect([400, 409, 500]).toContain(dup.status);
    expect(dup.status).not.toBe(200);
    await sell(o, o.phone, '2');
    expect(await lots(o, o.phone)).toEqual({ 'SN-001': '0', 'SN-002': '0', 'SN-003': '1' });
    await invariants(o);
  });

  it('voids restore the very same lots, and a bill whose lots were sold cannot be voided', async () => {
    const o = await org();
    const bill = await buy(o, o.oil, '10', '10', [
      { itemId: o.oil, lotCode: 'L1', expiryDate: shift(todayIso(), 90), quantity: '10' },
    ]);
    const sale = await sell(o, o.oil, '4');
    expect(await lots(o, o.oil)).toEqual({ L1: '6' });
    const blocked = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: bill.version,
      reason: 'Wrong',
    });
    expect(blocked.status).toBe(409);
    const voidSale = await o.owner.post(`/sales/invoices/${sale.body.data.id}/void`, {
      version: sale.body.data.version,
      reason: 'Entered in error',
    });
    if (voidSale.status !== 200) {
      await o.owner.reauthenticate();
      expect(
        (
          await o.owner.post(`/sales/invoices/${sale.body.data.id}/void`, {
            version: sale.body.data.version,
            reason: 'Entered in error',
          })
        ).status,
      ).toBe(200);
    }
    expect(await lots(o, o.oil)).toEqual({ L1: '10' });
    expect(
      (
        await o.owner.post(`/purchases/bills/${bill.id}/void`, {
          version: bill.version,
          reason: 'Wrong',
        })
      ).status,
    ).toBe(200);
    expect(await lots(o, o.oil)).toEqual({ L1: '0' });
    await invariants(o);
  });

  it('moves lots between warehouses and back, and reports expiring lots', async () => {
    const o = await org();
    const today = todayIso();
    await buy(o, o.oil, '10', '10', [
      { itemId: o.oil, lotCode: 'E1', expiryDate: shift(today, 10), quantity: '4' },
      { itemId: o.oil, lotCode: 'E2', expiryDate: shift(today, 100), quantity: '6' },
    ]);
    const moved = await o.owner.post('/inventory/transfers', {
      transferDate: today,
      fromWarehouseId: o.main,
      toWarehouseId: o.annex,
      lines: [{ itemId: o.oil, quantity: '5' }], // first-expired-first-out: all of E1 and 1 of E2
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    const detail = (await o.owner.get(`/inventory/items/${o.oil}/lots`)).body.data;
    const e1 = detail.find((l: { code: string }) => l.code === 'E1');
    expect(
      Object.fromEntries(
        e1.warehouses.map((w: { warehouseId: string; quantity: string }) => [
          w.warehouseId,
          w.quantity,
        ]),
      ),
    ).toEqual({ [o.main]: '0', [o.annex]: '4' });
    const e2 = detail.find((l: { code: string }) => l.code === 'E2');
    expect(
      Object.fromEntries(
        e2.warehouses.map((w: { warehouseId: string; quantity: string }) => [
          w.warehouseId,
          w.quantity,
        ]),
      ),
    ).toEqual({ [o.main]: '5', [o.annex]: '1' });
    await invariants(o);
    const report = (await o.owner.get(`/inventory/lots/expiring?days=30&asOf=${today}`)).body.data;
    expect(report.lots).toHaveLength(1);
    expect(report.lots[0]).toMatchObject({
      code: 'E1',
      itemName: 'Coconut oil 1L',
      daysToExpiry: 10,
      expired: false,
      quantity: '4',
    });
    const wide = (await o.owner.get(`/inventory/lots/expiring?days=365&asOf=${today}`)).body.data;
    expect(wide.lots.length).toBeGreaterThanOrEqual(3);
    // Voiding the transfer needs the goods to be where they went.
    let voided = await o.owner.post(`/inventory/transfers/${moved.body.data.id}/void`, {
      version: 1,
      reason: 'Back',
    });
    if (voided.body?.error?.code === 'REAUTHENTICATION_REQUIRED') {
      await o.owner.reauthenticate();
      voided = await o.owner.post(`/inventory/transfers/${moved.body.data.id}/void`, {
        version: 1,
        reason: 'Back',
      });
    }
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    await invariants(o);
  });

  it('returns sold goods into their own lot, and refuses stray lots, in the right place', async () => {
    const o = await org();
    await buy(o, o.oil, '10', '10', [
      { itemId: o.oil, lotCode: 'R1', expiryDate: shift(todayIso(), 60), quantity: '10' },
    ]);
    const sale = await sell(o, o.oil, '4');
    const note = await o.owner.post('/sales/credit-notes', {
      customerId: o.customerId,
      creditDate: todayIso(),
      invoiceId: sale.body.data.id,
      lines: [
        {
          itemId: o.oil,
          description: 'Returned',
          quantity: '3',
          unitPrice: '100',
          taxCodeId: null,
        },
      ],
    });
    const issued = await o.owner.post(`/sales/credit-notes/${note.body.data.id}/issue`, {
      version: note.body.data.version,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const body = (lotsArg?: object[]) => ({
      returnDate: todayIso(),
      creditNoteId: note.body.data.id,
      reason: 'Back',
      lines: [{ itemId: o.oil, quantity: '2', ...(lotsArg ? { lots: lotsArg } : {}) }],
    });
    expect((await o.owner.post('/inventory/returns', body())).status).toBe(400); // lot not named
    expect(
      (await o.owner.post('/inventory/returns', body([{ lotCode: 'NEW', quantity: '2' }]))).status,
    ).toBe(400); // unknown lot
    const ok = await o.owner.post('/inventory/returns', body([{ lotCode: 'R1', quantity: '2' }]));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await lots(o, o.oil)).toEqual({ R1: '8' });
    await invariants(o);
  });

  it('is enforced by the database, permissioned and tenant isolated', async () => {
    const o = await org();
    await buy(o, o.oil, '5', '10', [
      { itemId: o.oil, lotCode: 'D1', expiryDate: shift(todayIso(), 60), quantity: '5' },
    ]);
    // A stray entry (here a backfill entry with no lot) breaks the sums and fails at commit.
    await expect(
      db.query(
        `INSERT INTO inventory_stock_entries (organization_id, item_id, warehouse_id, quantity, entry_kind, created_at) VALUES ($1, $2, $3, 1, 'backfill', now())`,
        [o.organizationId, o.oil, o.main],
      ),
    ).rejects.toThrow(/do not add up|does not add up/);
    // A movement entry without a lot is refused for a lot-tracked item.
    await expect(
      db.query(
        `INSERT INTO inventory_stock_entries (organization_id, item_id, warehouse_id, quantity, entry_kind, movement_id, created_at)
         SELECT organization_id, item_id, $3, 1, 'movement', id, now() FROM inventory_movements WHERE organization_id = $1 AND item_id = $2 LIMIT 1`,
        [o.organizationId, o.oil, o.main],
      ),
    ).rejects.toThrow(/must name a lot/);
    const other = await org();
    expect((await other.owner.get(`/inventory/items/${o.oil}/lots`)).status).toBe(404);
    await o.owner.post('/organizations/current/roles', {
      name: 'Viewer',
      permissionKeys: ['organization.read', 'inventory.view'],
    });
    const viewer = await joinWithRole(ctx, o.owner, 'Viewer');
    expect((await viewer.client.get(`/inventory/items/${o.oil}/lots`)).status).toBe(200);
    expect((await viewer.client.get('/inventory/lots/expiring')).status).toBe(200);
    const bill = await draftBill(o, o.oil, '1', '10');
    expect(
      (await viewer.client.put(`/inventory/document-lots/bill/${bill.id}`, { lots: [] })).status,
    ).toBe(403);
    expect(
      (await other.owner.put(`/inventory/document-lots/bill/${bill.id}`, { lots: [] })).status,
    ).toBe(404);
    expect((await ctx.client().get('/inventory/lots/expiring')).status).toBe(401);
  });
});
