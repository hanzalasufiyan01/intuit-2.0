import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Landed cost (FP-29 A8, migration 0081, ADR 0014 AI-08): freight and duty spread over a posted
 * bill's stock. The part for units still on hand raises the stock value, the part for units already
 * sold goes to cost of goods sold, and the stock value keeps equalling the ledger. Real PostgreSQL.
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
  salt: string;
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
  const make = async (name: string) => {
    const item = await o.owner.post('/sales/items', {
      name,
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
    return item.body.data.id as string;
  };
  return {
    ...o,
    vendorId: vendor.body.data.id,
    customerId: customer.body.data.id,
    oil: await make('Coconut oil 1L'),
    salt: await make('Sea salt 1kg'),
  };
}

async function buy(o: Org, lines: { itemId: string; quantity: string; unitPrice: string }[]) {
  const draft = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: '2026-03-10',
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: lines.map((l) => ({ ...l, description: 'Stock', taxCodeId: null })),
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const posted = await o.owner.post(`/purchases/bills/${draft.body.data.id}/post`, {
    version: draft.body.data.version,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return posted.body.data as { id: string; version: number };
}

async function sell(o: Org, itemId: string, quantity: string) {
  const draft = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate: todayIso(),
    dueDate: todayIso(),
    lines: [{ itemId, description: 'Sale', quantity, unitPrice: '100' }],
  });
  const res = await o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const stock = async (o: Org, itemId: string) =>
  (await o.owner.get(`/inventory/items/${itemId}`)).body.data as {
    quantity: string;
    value: string;
    averageCost: string;
  };

async function glBalance(o: Org, accountId: string) {
  const { rows } = await db.query(
    `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
    [o.organizationId, accountId],
  );
  return rows[0].b as string;
}

async function valuationIsZero(o: Org) {
  for (const a of (await o.owner.get('/inventory/valuation')).body.data.accounts) {
    expect(Number(a.difference), `valuation ${a.accountId}`).toBe(0);
  }
}

const post = (o: Org, billId: string, extra: object = {}) =>
  o.owner.post('/inventory/landed-costs', {
    costDate: todayIso(),
    billId,
    description: 'Sea freight',
    amount: '30',
    basis: 'value',
    creditAccountId: o.accounts['5400'],
    ...extra,
  });

describe('landed cost', () => {
  it('adds the share for units on hand to stock value and the share for units sold to cost of goods sold', async () => {
    const o = await org();
    const bill = await buy(o, [{ itemId: o.oil, quantity: '10', unitPrice: '12' }]); // 120
    await sell(o, o.oil, '4'); // COGS 48; 6 left worth 72
    const res = await post(o, bill.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      number: 'LC-00001',
      status: 'POSTED',
      amount: '30.0000',
    });
    // 6 of the 10 units remain: 18 goes to stock, 12 to cost of goods sold.
    expect(res.body.data.lines).toEqual([
      expect.objectContaining({
        allocated: '30.0000',
        toInventory: '18.0000',
        toCostOfGoodsSold: '12.0000',
      }),
    ]);
    expect(await stock(o, o.oil)).toMatchObject({
      quantity: '6',
      value: '90.0000',
      averageCost: '15.0000',
    });
    expect(await glBalance(o, o.accounts['1140']!)).toBe('90.00'); // 120 - 48 + 18
    expect(await glBalance(o, o.accounts['5100']!)).toBe('60.00'); // 48 + 12
    await valuationIsZero(o);
    const movements = await db.query(
      `SELECT kind, quantity::text AS q, value::text AS v FROM inventory_movements WHERE organization_id = $1 AND kind = 'landed_cost'`,
      [o.organizationId],
    );
    expect(movements.rows).toEqual([{ kind: 'landed_cost', q: '0.000000', v: '18.0000' }]);
    // The cost is part of the next sale.
    await sell(o, o.oil, '6'); // 6 * 15 = 90
    expect(await stock(o, o.oil)).toMatchObject({ quantity: '0', value: '0.0000' });
    await valuationIsZero(o);
  });

  it('spreads the amount over several items exactly, by value or by quantity', async () => {
    const o = await org();
    const bill = await buy(o, [
      { itemId: o.oil, quantity: '10', unitPrice: '12' }, // 120
      { itemId: o.salt, quantity: '30', unitPrice: '2' }, // 60
    ]);
    const byValue = await post(o, bill.id, { amount: '100.01' });
    expect(byValue.status, JSON.stringify(byValue.body)).toBe(201);
    const allocated = byValue.body.data.lines.map((l: { allocated: string }) =>
      Number(l.allocated),
    );
    expect(allocated.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(100.01, 4);
    expect(Math.max(...allocated)).toBeGreaterThan(66); // 2/3 of 100.01 to the oil
    const byQuantity = await post(o, bill.id, {
      amount: '40',
      basis: 'quantity',
      description: 'Duty',
    });
    expect(byQuantity.status).toBe(201);
    const q = Object.fromEntries(
      byQuantity.body.data.lines.map((l: { name: string; allocated: string }) => [
        l.name,
        l.allocated,
      ]),
    );
    expect(q).toEqual({ 'Coconut oil 1L': '10.0000', 'Sea salt 1kg': '30.0000' }); // 10:30 of 40
    expect(await glBalance(o, o.accounts['1140']!)).toBe('320.01'); // 180 bought + 100.01 + 40, all on hand
    await valuationIsZero(o);
    expect((await o.owner.get('/inventory/landed-costs')).body.data).toHaveLength(2);
    expect((await o.owner.get(`/inventory/landed-costs?billId=${bill.id}`)).body.data).toHaveLength(
      2,
    );
  });

  it('voids by reversing the journal and the value, and refuses when the value has been used', async () => {
    const o = await org();
    const bill = await buy(o, [{ itemId: o.oil, quantity: '10', unitPrice: '12' }]);
    const lc = (await post(o, bill.id)).body.data;
    expect(await stock(o, o.oil)).toMatchObject({ value: '150.0000' });
    // Selling it all uses the value; the cost can no longer be taken back.
    await sell(o, o.oil, '10');
    let blocked = await o.owner.post(`/inventory/landed-costs/${lc.id}/void`, {
      version: lc.version,
      reason: 'Wrong bill',
    });
    if (blocked.body?.error?.code === 'REAUTHENTICATION_REQUIRED') {
      await o.owner.reauthenticate();
      blocked = await o.owner.post(`/inventory/landed-costs/${lc.id}/void`, {
        version: lc.version,
        reason: 'Wrong bill',
      });
    }
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await glBalance(o, o.accounts['5400']!)).toBe('-30.00'); // nothing was reversed
    // On another bill, nothing sold: the void restores everything.
    const bill2 = await buy(o, [{ itemId: o.salt, quantity: '5', unitPrice: '4' }]);
    const lc2 = (await post(o, bill2.id, { amount: '10' })).body.data;
    const voided = await o.owner.post(`/inventory/landed-costs/${lc2.id}/void`, {
      version: lc2.version,
      reason: 'Wrong bill',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.status).toBe('VOID');
    expect(await stock(o, o.salt)).toMatchObject({ quantity: '5', value: '20.0000' });
    await valuationIsZero(o);
    expect(
      (
        await o.owner.post(`/inventory/landed-costs/${lc2.id}/void`, {
          version: 2,
          reason: 'again',
        })
      ).status,
    ).toBe(409);
    await expect(
      db.query(`UPDATE inventory_landed_costs SET amount = 1 WHERE id = $1`, [lc2.id]),
    ).rejects.toThrow();
    await expect(
      db.query(`DELETE FROM inventory_landed_costs WHERE id = $1`, [lc2.id]),
    ).rejects.toThrow(/never deleted/);
  });

  it('validates, replays idempotently, and is permissioned and tenant isolated', async () => {
    const o = await org();
    const bill = await buy(o, [{ itemId: o.oil, quantity: '2', unitPrice: '5' }]);
    for (const bad of [
      { amount: '0' },
      { amount: '10.123' },
      { creditAccountId: o.accounts['1140'] }, // an inventory account
      { creditAccountId: randomUUID() },
      { costDate: '2026-02-30' },
      { description: ' ' },
      { basis: 'weight' },
      { extra: 1 },
    ]) {
      expect((await post(o, bill.id, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post(o, randomUUID())).status).toBe(404);
    const draft = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorId,
      billDate: '2026-03-10',
      vendorReference: `D-${randomUUID().slice(0, 8)}`,
      lines: [{ itemId: o.oil, description: 'x', quantity: '1', unitPrice: '5', taxCodeId: null }],
    });
    expect((await post(o, draft.body.data.id)).status).toBe(409); // not posted
    const service = await buy(o, [{ itemId: o.salt, quantity: '1', unitPrice: '1' }]);
    void service;
    const key = { 'idempotency-key': 'lc-1' };
    const a = await o.owner.post(
      '/inventory/landed-costs',
      {
        costDate: todayIso(),
        billId: bill.id,
        description: 'Freight',
        amount: '5',
        creditAccountId: o.accounts['5400'],
      },
      key,
    );
    const b = await o.owner.post(
      '/inventory/landed-costs',
      {
        costDate: todayIso(),
        billId: bill.id,
        description: 'Freight',
        amount: '5',
        creditAccountId: o.accounts['5400'],
      },
      key,
    );
    expect(a.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    const other = await org();
    expect((await other.owner.get(`/inventory/landed-costs/${a.body.data.id}`)).status).toBe(404);
    expect((await post(other, bill.id)).status).toBe(404);
    await o.owner.post('/organizations/current/roles', {
      name: 'Viewer',
      permissionKeys: ['organization.read', 'inventory.view'],
    });
    const viewer = await joinWithRole(ctx, o.owner, 'Viewer');
    expect((await viewer.client.get('/inventory/landed-costs')).status).toBe(200);
    expect(
      (
        await viewer.client.post('/inventory/landed-costs', {
          costDate: todayIso(),
          billId: bill.id,
          description: 'x',
          amount: '1',
          creditAccountId: o.accounts['5400'],
        })
      ).status,
    ).toBe(403);
    expect((await ctx.client().get('/inventory/landed-costs')).status).toBe(401);
    const journal = (await o.owner.get(`/accounting/journals/${a.body.data.journalId}`)).body.data;
    expect(journal.sourceDocument).toMatchObject({
      documentType: 'landed_cost',
      number: a.body.data.number,
    });
  });
});
