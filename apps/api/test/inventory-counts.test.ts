import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Physical stock counts (FP-29 A5): a count lists the tracked items, people enter what they
 * counted, and posting turns the differences into one stock adjustment, so stock, the ledger and
 * the valuation report agree afterwards. Real PostgreSQL.
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

interface StockOrg extends AccountingOrg {
  vendorId: string;
  itemId: string;
  secondItemId: string;
}

async function stockOrg(): Promise<StockOrg> {
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
  const adjustment = await org.owner.put('/inventory/settings', {
    version: 0,
    negativeStockPolicy: 'block',
    adjustmentAccountId: org.accounts['5400'],
  });
  expect(adjustment.status, JSON.stringify(adjustment.body)).toBe(200);
  const vendor = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Wholesale' },
  });
  const make = async (name: string) => {
    const item = await org.owner.post('/sales/items', {
      name,
      itemType: 'product',
      unitPrice: '60',
      revenueAccountId: org.accounts['4100'],
    });
    const tracked = await org.owner.post(`/inventory/items/${item.body.data.id}`, {
      inventoryAccountId: org.accounts['1140'],
      cogsAccountId: org.accounts['5100'],
    });
    expect(tracked.status, JSON.stringify(tracked.body)).toBe(201);
    return item.body.data.id as string;
  };
  const itemId = await make('Coconut oil 1L');
  const secondItemId = await make('Sea salt 1kg');
  return { ...org, vendorId: vendor.body.data.id, itemId, secondItemId };
}

async function buy(o: StockOrg, itemId: string, quantity: string, unitPrice: string) {
  const draft = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: '2026-03-10',
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: [{ itemId, description: 'Stock', quantity, unitPrice, taxCodeId: null }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const posted = await o.owner.post(`/purchases/bills/${draft.body.data.id}/post`, {
    version: draft.body.data.version,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
}

const stock = async (o: StockOrg, itemId: string) =>
  (await o.owner.get(`/inventory/items/${itemId}`)).body.data as {
    quantity: string;
    value: string;
  };

async function glBalance(organizationId: string, accountId: string) {
  const { rows } = await db.query(
    `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
    [organizationId, accountId],
  );
  return rows[0].b as string;
}

const start = (o: StockOrg, extra: object = {}) =>
  o.owner.post('/inventory/counts', { countDate: '2026-03-31', memo: 'Quarter end', ...extra });

describe('stock counts', () => {
  it('counts, posts the differences as one adjustment, and leaves stock equal to the ledger', async () => {
    const o = await stockOrg();
    await buy(o, o.itemId, '10', '12'); // 10 for 120
    await buy(o, o.secondItemId, '5', '4'); // 5 for 20
    const started = await start(o);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const count = started.body.data;
    expect(count).toMatchObject({ number: 'CNT-00001', status: 'DRAFT' });
    expect(count.lines.map((l: { expectedQuantity: string }) => l.expectedQuantity).sort()).toEqual(
      ['10', '5'],
    );
    // Count 8 of the oil (2 lost) and 6 of the salt (1 found); nothing entered would be left alone.
    const entered = await o.owner.put(`/inventory/counts/${count.id}/lines`, {
      lines: [
        { itemId: o.itemId, countedQuantity: '8' },
        { itemId: o.secondItemId, countedQuantity: '6' },
      ],
    });
    expect(entered.status, JSON.stringify(entered.body)).toBe(200);
    const oil = entered.body.data.lines.find((l: { itemId: string }) => l.itemId === o.itemId);
    expect(oil).toMatchObject({ countedQuantity: '8', difference: '-2' });
    const posted = await o.owner.post(`/inventory/counts/${count.id}/post`, {
      version: count.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data.status).toBe('POSTED');
    expect(posted.body.data.adjustmentId).toBeTruthy();
    expect(await stock(o, o.itemId)).toMatchObject({ quantity: '8', value: '96.0000' });
    expect(await stock(o, o.secondItemId)).toMatchObject({ quantity: '6', value: '24.0000' });
    const valuation = (await o.owner.get('/inventory/valuation')).body.data;
    expect(valuation.totalValue).toBe('120.0000');
    for (const account of valuation.accounts) expect(account.difference).toBe('0.0000');
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('120.00');
    const adjustment = (
      await o.owner.get(`/inventory/adjustments/${posted.body.data.adjustmentId}`)
    ).body.data;
    expect(adjustment).toMatchObject({ status: 'POSTED', reason: 'Stock count CNT-00001' });
    expect(adjustment.lines).toHaveLength(2);
    // A posted count is final in the service and in the database.
    expect(
      (
        await o.owner.post(`/inventory/counts/${count.id}/post`, {
          version: posted.body.data.version,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await o.owner.put(`/inventory/counts/${count.id}/lines`, {
          lines: [{ itemId: o.itemId, countedQuantity: '1' }],
        })
      ).status,
    ).toBe(409);
    await expect(
      db.query(`UPDATE inventory_count_lines SET counted_quantity = 1 WHERE count_id = $1`, [
        count.id,
      ]),
    ).rejects.toThrow(/not a draft/);
    await expect(
      db.query(`UPDATE inventory_counts SET memo = 'x' WHERE id = $1`, [count.id]),
    ).rejects.toThrow(/final/);
    await expect(
      db.query(`DELETE FROM inventory_counts WHERE id = $1`, [count.id]),
    ).rejects.toThrow(/never deleted/);
  });

  it('measures against the quantity on hand at posting, and posts uncounted or matching counts without an adjustment', async () => {
    const o = await stockOrg();
    await buy(o, o.itemId, '10', '12');
    const count = (await start(o, { itemIds: [o.itemId] })).body.data;
    expect(count.lines).toHaveLength(1);
    // Stock moves after the count started (5 more arrive); the physical count of 15 is still right.
    await buy(o, o.itemId, '5', '12');
    await o.owner.put(`/inventory/counts/${count.id}/lines`, {
      lines: [{ itemId: o.itemId, countedQuantity: '15' }],
    });
    const posted = await o.owner.post(`/inventory/counts/${count.id}/post`, {
      version: count.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data.adjustmentId).toBeNull(); // 15 counted = 15 on hand: nothing to adjust
    expect(await stock(o, o.itemId)).toMatchObject({ quantity: '15' });
    // Nothing entered: also posts without an adjustment.
    const empty = (await start(o)).body.data;
    const done = await o.owner.post(`/inventory/counts/${empty.id}/post`, {
      version: empty.version,
    });
    expect(done.body.data.adjustmentId).toBeNull();
  });

  it('refuses counting more than can be costed, and bad input', async () => {
    const o = await stockOrg();
    // No stock at all: an increase needs a unit cost.
    const count = (await start(o, { itemIds: [o.itemId] })).body.data;
    await o.owner.put(`/inventory/counts/${count.id}/lines`, {
      lines: [{ itemId: o.itemId, countedQuantity: '3' }],
    });
    const noCost = await o.owner.post(`/inventory/counts/${count.id}/post`, {
      version: count.version,
    });
    expect(noCost.status).toBe(400);
    expect((await stock(o, o.itemId)).quantity).toBe('0');
    const withCost = await o.owner.post(`/inventory/counts/${count.id}/post`, {
      version: count.version,
      unitCosts: { [o.itemId]: '10' },
    });
    expect(withCost.status, JSON.stringify(withCost.body)).toBe(200);
    expect(await stock(o, o.itemId)).toMatchObject({ quantity: '3', value: '30.0000' });
    for (const bad of [{ countDate: 'x' }, { itemIds: [randomUUID()] }, { extra: 1 }]) {
      expect((await start(o, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const c2 = (await start(o)).body.data;
    expect(
      (
        await o.owner.put(`/inventory/counts/${c2.id}/lines`, {
          lines: [{ itemId: randomUUID(), countedQuantity: '1' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await o.owner.put(`/inventory/counts/${c2.id}/lines`, {
          lines: [{ itemId: o.itemId, countedQuantity: '-1' }],
        })
      ).status,
    ).toBe(400);
    expect((await o.owner.post(`/inventory/counts/${c2.id}/post`, { version: 99 })).status).toBe(
      409,
    );
  });

  it('cancels a draft with a reason, once', async () => {
    const o = await stockOrg();
    const count = (await start(o)).body.data;
    expect(
      (
        await o.owner.post(`/inventory/counts/${count.id}/cancel`, {
          version: count.version,
          reason: ' ',
        })
      ).status,
    ).toBe(400);
    const cancelled = await o.owner.post(`/inventory/counts/${count.id}/cancel`, {
      version: count.version,
      reason: 'Wrong warehouse',
    });
    expect(cancelled.body.data).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Wrong warehouse',
    });
    expect(
      (
        await o.owner.post(`/inventory/counts/${count.id}/cancel`, {
          version: cancelled.body.data.version,
          reason: 'again',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await o.owner.post(`/inventory/counts/${count.id}/post`, {
          version: cancelled.body.data.version,
        })
      ).status,
    ).toBe(409);
  });

  it('needs inventory.counts.manage, and adjustments.create to post; isolates tenants; audits', async () => {
    const o = await stockOrg();
    await buy(o, o.itemId, '10', '12');
    const count = (await start(o)).body.data;
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/inventory/counts')).status).toBe(403);
    expect(
      (await member.client.post('/inventory/counts', { countDate: '2026-03-31' })).status,
    ).toBe(403);
    await o.owner.post('/organizations/current/roles', {
      name: 'Counter',
      permissionKeys: ['inventory.counts.manage', 'inventory.view'],
    });
    const counter = await joinWithRole(ctx, o.owner, 'Counter');
    await counter.client.put(`/inventory/counts/${count.id}/lines`, {
      lines: [{ itemId: o.itemId, countedQuantity: '7' }],
    });
    expect(
      (await counter.client.post(`/inventory/counts/${count.id}/post`, { version: count.version }))
        .status,
    ).toBe(403);
    expect(
      (await o.owner.post(`/inventory/counts/${count.id}/post`, { version: count.version })).status,
    ).toBe(200);
    const other = await stockOrg();
    expect((await other.owner.get('/inventory/counts')).body.data).toEqual([]);
    expect((await other.owner.get(`/inventory/counts/${count.id}`)).status).toBe(404);
    expect(
      (await other.owner.post(`/inventory/counts/${count.id}/cancel`, { version: 1, reason: 'x' }))
        .status,
    ).toBe(404);
    const audit = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'inventory_count.%' ORDER BY occurred_at, id`,
      [o.organizationId],
    );
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual([
      'inventory_count.started',
      'inventory_count.entered',
      'inventory_count.posted',
    ]);
  });
});
