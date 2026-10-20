import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Warehouses and transfers (FP-29 A3/A4, migration 0078, ADR 0014). Costing is one average per
 * item; warehouses hold quantities. Invariants proven here: warehouse levels add up to the item
 * balance, the stock ledger and the placement ledger agree, and the stock value still equals the
 * ledger after every flow. Real PostgreSQL.
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
  itemId: string;
  secondItemId: string;
  main: string;
  annex: string;
}

async function org(): Promise<Org> {
  const o = await setUpAccountingOrg(ctx);
  expect(
    (
      await o.owner.put('/purchases/settings', {
        version: 0,
        apAccountId: o.accounts['2110'],
        defaultExpenseAccountId: o.accounts['5400'],
        defaultPaymentAccountId: o.accounts['1120'],
        defaultTaxCodeId: null,
        defaultTaxTreatment: 'exclusive',
        defaultPaymentTermsDays: 30,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await o.owner.put('/sales/settings', {
        version: 0,
        arAccountId: o.accounts['1130'],
        defaultRevenueAccountId: o.accounts['4100'],
        defaultDepositAccountId: o.accounts['1120'],
        defaultTaxCodeId: null,
        defaultTaxTreatment: 'no_tax',
        defaultPaymentTermsDays: 0,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await o.owner.put('/inventory/settings', {
        version: 0,
        negativeStockPolicy: 'block',
        adjustmentAccountId: o.accounts['5400'],
      })
    ).status,
  ).toBe(200);
  const vendor = await o.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Wholesale' },
  });
  const customer = await o.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Resort' },
  });
  const make = async (name: string) => {
    const item = await o.owner.post('/sales/items', {
      name,
      itemType: 'product',
      unitPrice: '60',
      revenueAccountId: o.accounts['4100'],
    });
    const tracked = await o.owner.post(`/inventory/items/${item.body.data.id}`, {
      inventoryAccountId: o.accounts['1140'],
      cogsAccountId: o.accounts['5100'],
    });
    expect(tracked.status, JSON.stringify(tracked.body)).toBe(201);
    return item.body.data.id as string;
  };
  const warehouses = await o.owner.get('/inventory/warehouses');
  const main = warehouses.body.data.find((w: { isDefault: boolean }) => w.isDefault).id as string;
  const annex = await o.owner.post('/inventory/warehouses', { code: 'ANNEX', name: 'Annex' });
  expect(annex.status, JSON.stringify(annex.body)).toBe(201);
  return {
    ...o,
    vendorId: vendor.body.data.id,
    customerId: customer.body.data.id,
    itemId: await make('Coconut oil 1L'),
    secondItemId: await make('Sea salt 1kg'),
    main,
    annex: annex.body.data.id,
  };
}

async function buy(
  o: Org,
  itemId: string,
  quantity: string,
  unitPrice: string,
  warehouseId?: string,
) {
  const draft = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: '2026-03-10',
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: [{ itemId, description: 'Stock', quantity, unitPrice, taxCodeId: null }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  if (warehouseId) {
    const set = await o.owner.put(`/inventory/document-warehouse/bill/${draft.body.data.id}`, {
      warehouseId,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
  }
  const posted = await o.owner.post(`/purchases/bills/${draft.body.data.id}/post`, {
    version: draft.body.data.version,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return posted.body.data;
}

async function sell(o: Org, itemId: string, quantity: string, warehouseId?: string) {
  const draft = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate: todayIso(),
    dueDate: todayIso(),
    lines: [{ itemId, description: 'Sale', quantity, unitPrice: '100' }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  if (warehouseId) {
    expect(
      (
        await o.owner.put(`/inventory/document-warehouse/invoice/${draft.body.data.id}`, {
          warehouseId,
        })
      ).status,
    ).toBe(200);
  }
  return o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
}

const levels = async (o: Org, itemId: string) =>
  Object.fromEntries(
    (await o.owner.get(`/inventory/items/${itemId}/warehouses`)).body.data.map(
      (l: { warehouseId: string; quantity: string }) => [l.warehouseId, l.quantity],
    ),
  ) as Record<string, string>;

/** The invariants of ADR 0014 AI-10 that must hold after every flow. */
async function invariants(o: Org) {
  const sums = await db.query(
    `SELECT b.item_id, b.quantity::text AS balance,
            coalesce((SELECT sum(l.quantity) FROM inventory_stock_levels l
                       WHERE l.organization_id = b.organization_id AND l.item_id = b.item_id), 0)::text AS levels,
            coalesce((SELECT sum(e.quantity) FROM inventory_stock_entries e
                       WHERE e.organization_id = b.organization_id AND e.item_id = b.item_id), 0)::text AS entries,
            coalesce((SELECT sum(m.quantity) FROM inventory_movements m
                       WHERE m.organization_id = b.organization_id AND m.item_id = b.item_id), 0)::text AS movements
       FROM inventory_balances b WHERE b.organization_id = $1`,
    [o.organizationId],
  );
  for (const r of sums.rows) {
    expect(Number(r.levels), `levels of ${r.item_id}`).toBe(Number(r.balance));
    expect(Number(r.entries), `entries of ${r.item_id}`).toBe(Number(r.balance));
    expect(Number(r.movements), `movements of ${r.item_id}`).toBe(Number(r.balance));
  }
  // Every movement is fully placed: its entries add up to its own quantity.
  const unplaced = await db.query(
    `SELECT m.id FROM inventory_movements m
      WHERE m.organization_id = $1
        AND m.quantity <> coalesce((SELECT sum(e.quantity) FROM inventory_stock_entries e
                                     WHERE e.movement_id = m.id), 0)`,
    [o.organizationId],
  );
  expect(unplaced.rows).toEqual([]);
  // Stock value equals the ledger.
  const valuation = (await o.owner.get('/inventory/valuation')).body.data;
  for (const a of valuation.accounts ?? []) {
    expect(Number(a.difference ?? 0), `valuation difference ${a.accountId}`).toBe(0);
  }
}

describe('warehouses', () => {
  it('creates a default warehouse, adds and renames others, and protects the default and any stock', async () => {
    const o = await org();
    const list = (await o.owner.get('/inventory/warehouses')).body.data;
    expect(list.map((w: { code: string }) => w.code)).toEqual(['MAIN', 'ANNEX']);
    expect(list[0]).toMatchObject({ isDefault: true, status: 'ACTIVE' });
    expect(
      (await o.owner.post('/inventory/warehouses', { code: 'annex', name: 'dup' })).status,
    ).toBe(400);
    expect(
      (await o.owner.post('/inventory/warehouses', { code: 'bad code', name: 'x' })).status,
    ).toBe(400);
    const renamed = await o.owner.patch(`/inventory/warehouses/${o.annex}`, {
      version: 1,
      name: 'Annex store',
    });
    expect(renamed.body.data).toMatchObject({ name: 'Annex store', version: 2 });
    expect(
      (await o.owner.patch(`/inventory/warehouses/${o.annex}`, { version: 1, name: 'stale' }))
        .status,
    ).toBe(409);
    // The default cannot be archived; a warehouse with stock cannot either.
    expect(
      (await o.owner.patch(`/inventory/warehouses/${o.main}`, { version: 1, archived: true }))
        .status,
    ).toBe(409);
    await buy(o, o.itemId, '5', '10', o.annex);
    const blocked = await o.owner.patch(`/inventory/warehouses/${o.annex}`, {
      version: 2,
      archived: true,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('still holds stock');
    // Moving the default role.
    const made = await o.owner.patch(`/inventory/warehouses/${o.annex}`, {
      version: 2,
      makeDefault: true,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const after = (await o.owner.get('/inventory/warehouses')).body.data;
    expect(after.find((w: { code: string }) => w.code === 'ANNEX').isDefault).toBe(true);
    expect(after.find((w: { code: string }) => w.code === 'MAIN').isDefault).toBe(false);
    await invariants(o);
    const audit = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'inventory.warehouse_%'`,
      [o.organizationId],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(3);
  });

  it('receives a bill into the chosen warehouse, issues from it, and mirrors voids', async () => {
    const o = await org();
    const bill = await buy(o, o.itemId, '10', '12', o.annex); // 10 oil, 120, in the annex
    expect(await levels(o, o.itemId)).toEqual({ [o.annex]: '10' });
    const sold = await sell(o, o.itemId, '4', o.annex);
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    expect(await levels(o, o.itemId)).toEqual({ [o.annex]: '6' });
    await invariants(o);
    // Voiding the invoice puts the stock back where it left; voiding the bill takes it from there.
    const voidSale = await o.owner.post(`/sales/invoices/${sold.body.data.id}/void`, {
      version: sold.body.data.version,
      reason: 'Entered in error',
    });
    if (voidSale.status !== 200) {
      await o.owner.reauthenticate();
      expect(
        (
          await o.owner.post(`/sales/invoices/${sold.body.data.id}/void`, {
            version: sold.body.data.version,
            reason: 'Entered in error',
          })
        ).status,
      ).toBe(200);
    }
    expect(await levels(o, o.itemId)).toEqual({ [o.annex]: '10' });
    const voidBill = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: bill.version,
      reason: 'Wrong supplier',
    });
    expect(voidBill.status, JSON.stringify(voidBill.body)).toBe(200);
    expect(await levels(o, o.itemId)).toEqual({});
    await invariants(o);
  });

  it('checks stock per warehouse and allocates automatically across them, default first', async () => {
    const o = await org();
    await buy(o, o.itemId, '5', '10'); // MAIN: 5 (no choice = default)
    await buy(o, o.itemId, '5', '10', o.annex); // ANNEX: 5
    expect(await levels(o, o.itemId)).toEqual({ [o.main]: '5', [o.annex]: '5' });
    // 8 are on hand in total but only 5 in the annex.
    const short = await sell(o, o.itemId, '8', o.annex);
    expect(short.status).toBe(409);
    expect(short.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(short.body.error.message).toContain('Annex');
    // With no choice the sale takes the default warehouse first, then the other.
    const auto = await sell(o, o.itemId, '8');
    expect(auto.status, JSON.stringify(auto.body)).toBe(200);
    expect(await levels(o, o.itemId)).toEqual({ [o.annex]: '2' });
    await invariants(o);
  });

  it('transfers between warehouses without changing value, and voids only while the goods are there', async () => {
    const o = await org();
    await buy(o, o.itemId, '10', '12'); // 120
    await buy(o, o.secondItemId, '4', '5'); // 20
    const before = (await o.owner.get(`/inventory/items/${o.itemId}`)).body.data;
    const posted = await o.owner.post('/inventory/transfers', {
      transferDate: todayIso(),
      fromWarehouseId: o.main,
      toWarehouseId: o.annex,
      memo: 'Stock the annex',
      lines: [
        { itemId: o.itemId, quantity: '6' },
        { itemId: o.secondItemId, quantity: '4' },
      ],
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect(posted.body.data).toMatchObject({
      number: expect.stringMatching(/^TRF-/),
      status: 'POSTED',
    });
    expect(await levels(o, o.itemId)).toEqual({ [o.main]: '4', [o.annex]: '6' });
    expect(await levels(o, o.secondItemId)).toEqual({ [o.annex]: '4' });
    const after = (await o.owner.get(`/inventory/items/${o.itemId}`)).body.data;
    expect(after.value).toBe(before.value);
    expect(after.quantity).toBe(before.quantity);
    const annexStock = (await o.owner.get(`/inventory/warehouses/${o.annex}/stock`)).body.data;
    expect(annexStock.items).toEqual([
      expect.objectContaining({ name: 'Coconut oil 1L', quantity: '6', value: '72.0000' }),
      expect.objectContaining({ name: 'Sea salt 1kg', quantity: '4', value: '20.0000' }),
    ]);
    await invariants(o);
    // Not enough in the source.
    const tooMuch = await o.owner.post('/inventory/transfers', {
      transferDate: todayIso(),
      fromWarehouseId: o.main,
      toWarehouseId: o.annex,
      lines: [{ itemId: o.itemId, quantity: '5' }],
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_STOCK');
    // Selling the transferred stock from the annex means the transfer can no longer be voided.
    await sell(o, o.itemId, '6', o.annex);
    const blocked = await o.owner.post(`/inventory/transfers/${posted.body.data.id}/void`, {
      version: 1,
      reason: 'Mistake',
    });
    const retry =
      blocked.body?.error?.code === 'REAUTHENTICATION_REQUIRED'
        ? (await o.owner.reauthenticate(),
          await o.owner.post(`/inventory/transfers/${posted.body.data.id}/void`, {
            version: 1,
            reason: 'Mistake',
          }))
        : blocked;
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('INSUFFICIENT_STOCK');
    await invariants(o);
  });

  it('voids a transfer that can be undone and keeps every record', async () => {
    const o = await org();
    await buy(o, o.itemId, '10', '12');
    const posted = (
      await o.owner.post('/inventory/transfers', {
        transferDate: todayIso(),
        fromWarehouseId: o.main,
        toWarehouseId: o.annex,
        lines: [{ itemId: o.itemId, quantity: '3' }],
      })
    ).body.data;
    let voided = await o.owner.post(`/inventory/transfers/${posted.id}/void`, {
      version: 1,
      reason: 'Wrong day',
    });
    if (voided.body?.error?.code === 'REAUTHENTICATION_REQUIRED') {
      await o.owner.reauthenticate();
      voided = await o.owner.post(`/inventory/transfers/${posted.id}/void`, {
        version: 1,
        reason: 'Wrong day',
      });
    }
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.status).toBe('VOID');
    expect(await levels(o, o.itemId)).toEqual({ [o.main]: '10' });
    expect(
      (
        await o.owner.post(`/inventory/transfers/${posted.id}/void`, {
          version: 2,
          reason: 'again',
        })
      ).status,
    ).toBe(409);
    await expect(
      db.query(`UPDATE inventory_transfers SET number = 'X' WHERE id = $1`, [posted.id]),
    ).rejects.toThrow();
    await expect(
      db.query(`DELETE FROM inventory_transfers WHERE id = $1`, [posted.id]),
    ).rejects.toThrow(/never deleted/);
    await expect(
      db.query(`DELETE FROM inventory_stock_entries WHERE transfer_id = $1`, [posted.id]),
    ).rejects.toThrow();
    const entries = await db.query(
      `SELECT count(*)::int AS n FROM inventory_stock_entries WHERE transfer_id = $1`,
      [posted.id],
    );
    expect(entries.rows[0].n).toBe(4); // two for the transfer and two for its void
    await invariants(o);
  });

  it('places adjustments, returns and counts in a named warehouse', async () => {
    const o = await org();
    await buy(o, o.itemId, '10', '12');
    // An adjustment increase in the annex and a decrease from it.
    const up = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: todayIso(),
      reason: 'Found stock',
      warehouseId: o.annex,
      lines: [{ itemId: o.itemId, quantityChange: '3', unitCost: '12' }],
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(await levels(o, o.itemId)).toEqual({ [o.main]: '10', [o.annex]: '3' });
    const down = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: todayIso(),
      reason: 'Damaged',
      warehouseId: o.annex,
      lines: [{ itemId: o.itemId, quantityChange: '-5' }],
    });
    expect(down.status).toBe(409); // only 3 in the annex
    // A count of the annex finds 5 where the system says 3; posting adjusts that warehouse only.
    const started = await o.owner.post('/inventory/counts', {
      countDate: todayIso(),
      warehouseId: o.annex,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.data.warehouseId).toBe(o.annex);
    expect(
      started.body.data.lines.find((l: { itemId: string }) => l.itemId === o.itemId),
    ).toMatchObject({ expectedQuantity: '3' });
    await o.owner.put(`/inventory/counts/${started.body.data.id}/lines`, {
      lines: [{ itemId: o.itemId, countedQuantity: '5' }],
    });
    const posted = await o.owner.post(`/inventory/counts/${started.body.data.id}/post`, {
      version: started.body.data.version,
      unitCosts: { [o.itemId]: '12' },
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(await levels(o, o.itemId)).toEqual({ [o.main]: '10', [o.annex]: '5' });
    await invariants(o);
  });

  it('refuses unbalanced stock at commit, is tenant isolated and permissioned', async () => {
    const o = await org();
    await buy(o, o.itemId, '10', '12');
    // A stray placement entry with no matching movement fails the deferred check at commit.
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO inventory_stock_entries (organization_id, item_id, warehouse_id, quantity, entry_kind, created_at)
       VALUES ($1, $2, $3, 1, 'backfill', now())`,
      [o.organizationId, o.itemId, o.annex],
    );
    await expect(db.query('COMMIT')).rejects.toThrow(/does not add up/);
    await db.query('ROLLBACK').catch(() => undefined);
    // Negative warehouse stock is refused by the database too.
    await expect(
      db.query(
        `INSERT INTO inventory_stock_entries (organization_id, item_id, warehouse_id, quantity, entry_kind, created_at)
         VALUES ($1, $2, $3, -1, 'backfill', now())`,
        [o.organizationId, o.itemId, o.annex],
      ),
    ).rejects.toThrow(/negative/);
    const other = await org();
    expect((await other.owner.get(`/inventory/warehouses/${o.main}/stock`)).status).toBe(404);
    expect(
      (await other.owner.patch(`/inventory/warehouses/${o.main}`, { version: 1, name: 'x' }))
        .status,
    ).toBe(404);
    expect((await other.owner.get(`/inventory/items/${o.itemId}/warehouses`)).status).toBe(404);
    await o.owner.post('/organizations/current/roles', {
      name: 'Viewer',
      permissionKeys: ['organization.read', 'inventory.view'],
    });
    const viewer = await joinWithRole(ctx, o.owner, 'Viewer');
    expect((await viewer.client.get('/inventory/warehouses')).status).toBe(200);
    expect(
      (await viewer.client.post('/inventory/warehouses', { code: 'X1', name: 'x' })).status,
    ).toBe(403);
    expect(
      (
        await viewer.client.post('/inventory/transfers', {
          transferDate: todayIso(),
          fromWarehouseId: o.main,
          toWarehouseId: o.annex,
          lines: [{ itemId: o.itemId, quantity: '1' }],
        })
      ).status,
    ).toBe(403);
    expect((await ctx.client().get('/inventory/warehouses')).status).toBe(401);
    // The warehouse of a document needs that document's own permission and a draft.
    const draft = await o.owner.post('/sales/invoices', {
      customerId: o.customerId,
      invoiceDate: todayIso(),
      dueDate: todayIso(),
      lines: [{ itemId: o.itemId, description: 'x', quantity: '1', unitPrice: '10' }],
    });
    expect(
      (
        await viewer.client.put(`/inventory/document-warehouse/invoice/${draft.body.data.id}`, {
          warehouseId: o.annex,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await other.owner.put(`/inventory/document-warehouse/invoice/${draft.body.data.id}`, {
          warehouseId: other.main,
        })
      ).status,
    ).toBe(404);
    const issued = await o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
      version: draft.body.data.version,
    });
    expect(issued.status).toBe(200);
    expect(
      (
        await o.owner.put(`/inventory/document-warehouse/invoice/${draft.body.data.id}`, {
          warehouseId: o.annex,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await o.owner.put(`/inventory/document-warehouse/invoice/${draft.body.data.id}`, {
          warehouseId: other.main,
        })
      ).status,
    ).toBe(409);
  });
});

describe('one long mixed scenario', () => {
  it('keeps quantities, value, cost of goods sold and every journal consistent across purchases, landed cost, transfers, sales, adjustments and voids', async () => {
    const o = await org();
    const bill1 = await buy(o, o.itemId, '10', '10', o.main); // 100
    await buy(o, o.itemId, '10', '20', o.annex); // 200 -> average 15 over 20
    await buy(o, o.secondItemId, '6', '5'); // 30
    await invariants(o);

    // Landed cost on the first bill: the share for units on hand adds to stock value.
    const landed = await o.owner.post('/inventory/landed-costs', {
      costDate: todayIso(),
      billId: bill1.id,
      description: 'Freight',
      amount: '30',
      basis: 'value',
      creditAccountId: o.accounts['5400'],
    });
    expect(landed.status, JSON.stringify(landed.body)).toBe(201);
    await invariants(o);

    // Transfer, then a sale from the annex, then a count-style adjustment.
    const transfer = await o.owner.post('/inventory/transfers', {
      transferDate: todayIso(),
      fromWarehouseId: o.main,
      toWarehouseId: o.annex,
      lines: [{ itemId: o.itemId, quantity: '4' }],
    });
    expect(transfer.status, JSON.stringify(transfer.body)).toBe(201);
    const sale = await sell(o, o.itemId, '5', o.annex);
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    const adjustment = await o.owner.post('/inventory/adjustments', {
      adjustmentDate: todayIso(),
      reason: 'Damaged in storage',
      lines: [{ itemId: o.secondItemId, quantityChange: '-2' }],
    });
    expect(adjustment.status, JSON.stringify(adjustment.body)).toBe(201);
    await invariants(o);

    // Voiding the transfer is allowed only while the stock is still there; processing a void twice
    // is refused and changes nothing.
    const levelsBefore = await levels(o, o.itemId);
    const voided = await o.owner.post(`/inventory/transfers/${transfer.body.data.id}/void`, {
      version: transfer.body.data.version,
      reason: 'Entered by mistake',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const again = await o.owner.post(`/inventory/transfers/${transfer.body.data.id}/void`, {
      version: voided.body.data.version,
      reason: 'Entered by mistake',
    });
    expect(again.status).toBe(409);
    expect(await levels(o, o.itemId)).not.toEqual(levelsBefore);
    const voidedAdjustment = await o.owner.post(
      `/inventory/adjustments/${adjustment.body.data.id}/void`,
      { version: adjustment.body.data.version, reason: 'Recounted' },
    );
    expect(voidedAdjustment.status, JSON.stringify(voidedAdjustment.body)).toBe(200);
    expect(
      (
        await o.owner.post(`/inventory/adjustments/${adjustment.body.data.id}/void`, {
          version: voidedAdjustment.body.data.version,
          reason: 'Again',
        })
      ).status,
    ).toBe(409);
    await invariants(o);

    // The ledger as a whole: every journal balances, and the inventory control account equals the
    // stock valuation to the cent.
    const unbalanced = await db.query(
      `SELECT j.id FROM accounting_journal_entries j
        WHERE j.organization_id = $1 AND j.status IN ('POSTED', 'REVERSED')
          AND (SELECT coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0)
                 FROM accounting_journal_lines l WHERE l.journal_id = j.id) <> 0`,
      [o.organizationId],
    );
    expect(unbalanced.rows).toEqual([]);
    const gl = await db.query(
      `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2) AS b
         FROM accounting_journal_lines l
         JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
        WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
      [o.organizationId, o.accounts['1140']],
    );
    const valuation = await db.query(
      `SELECT coalesce(sum(value), 0)::numeric(28,2) AS v FROM inventory_balances WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(Number(gl.rows[0].b)).toBe(Number(valuation.rows[0].v));
    // No movement was processed twice: each source document appears once per item and kind.
    const duplicates = await db.query(
      `SELECT source_type, source_id, item_id, count(*) FROM inventory_movements
        WHERE organization_id = $1 AND TRUE
        GROUP BY source_type, source_id, item_id, kind HAVING count(*) > 1`,
      [o.organizationId],
    );
    expect(duplicates.rows).toEqual([]);
  });
});
