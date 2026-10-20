import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Sales bundles (FP-29 A7, migration 0077): a bundle line on an issued invoice takes its tracked
 * components out of stock at their own average cost; revenue is the bundle line. Real PostgreSQL.
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
  a: string;
  b: string;
  bundle: string;
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
  const make = async (name: string, track: boolean) => {
    const item = await o.owner.post('/sales/items', {
      name,
      itemType: 'product',
      unitPrice: '100',
      revenueAccountId: o.accounts['4100'],
    });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    if (track) {
      const tracked = await o.owner.post(`/inventory/items/${item.body.data.id}`, {
        inventoryAccountId: o.accounts['1140'],
        cogsAccountId: o.accounts['5100'],
      });
      expect(tracked.status, JSON.stringify(tracked.body)).toBe(201);
    }
    return item.body.data.id as string;
  };
  return {
    ...o,
    vendorId: vendor.body.data.id,
    customerId: customer.body.data.id,
    a: await make('Coconut oil 1L', true),
    b: await make('Sea salt 1kg', true),
    bundle: await make('Gift basket', false),
  };
}

async function buy(o: Org, itemId: string, quantity: string, unitPrice: string) {
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

const stock = async (o: Org, itemId: string) =>
  (await o.owner.get(`/inventory/items/${itemId}`)).body.data as {
    quantity: string;
    value: string;
  };

async function sell(o: Org, itemId: string, quantity: string, unitPrice = '100') {
  const draft = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate: todayIso(),
    dueDate: todayIso(),
    lines: [{ itemId, description: 'Sale', quantity, unitPrice }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  return o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
}

const define = (
  o: Org,
  components = [
    { itemId: o.a, quantity: '2' },
    { itemId: o.b, quantity: '1' },
  ],
) => o.owner.put(`/inventory/bundles/${o.bundle}`, { components });

async function balance(organizationId: string, accountId: string) {
  const { rows } = await db.query(
    `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
    [organizationId, accountId],
  );
  return rows[0].b as string;
}

describe('bundles', () => {
  it('defines a bundle, lists it and audits the change', async () => {
    const o = await org();
    const set = await define(o);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data).toMatchObject({ bundleItemId: o.bundle, name: 'Gift basket' });
    expect(set.body.data.components).toHaveLength(2);
    expect(set.body.data.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: o.a, quantity: '2' }),
        expect.objectContaining({ itemId: o.b, quantity: '1' }),
      ]),
    );
    expect((await o.owner.get('/inventory/bundles')).body.data).toHaveLength(1);
    expect((await o.owner.get(`/inventory/bundles/${o.bundle}`)).status).toBe(200);
    const replaced = await define(o, [{ itemId: o.a, quantity: '1.5' }]);
    expect(replaced.body.data.components).toEqual([
      expect.objectContaining({ itemId: o.a, quantity: '1.5' }),
    ]);
    const actions = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'inventory.bundle_%' ORDER BY occurred_at`,
      [o.organizationId],
    );
    expect(actions.rows.map((r: { action: string }) => r.action)).toEqual([
      'inventory.bundle_created',
      'inventory.bundle_updated',
    ]);
    expect((await o.owner.delete(`/inventory/bundles/${o.bundle}`)).status).toBe(200);
    expect((await o.owner.get(`/inventory/bundles/${o.bundle}`)).status).toBe(404);
    expect((await o.owner.delete(`/inventory/bundles/${o.bundle}`)).status).toBe(404);
  });

  it('validates components and refuses nesting and tracking a bundle', async () => {
    const o = await org();
    expect((await define(o, [])).status).toBe(400);
    expect((await define(o, [{ itemId: o.a, quantity: '0' }])).status).toBe(400);
    expect(
      (
        await define(o, [
          { itemId: o.a, quantity: '1' },
          { itemId: o.a, quantity: '2' },
        ])
      ).status,
    ).toBe(400);
    expect((await define(o, [{ itemId: o.bundle, quantity: '1' }])).status).toBe(400); // itself / untracked
    expect((await define(o, [{ itemId: o.customerId, quantity: '1' }])).status).toBe(400);
    expect((await define(o, [{ itemId: o.a, quantity: '1.1234567' }])).status).toBe(400);
    expect(
      (
        await o.owner.put(`/inventory/bundles/${o.a}`, {
          components: [{ itemId: o.b, quantity: '1' }],
        })
      ).status,
    ).toBe(400); // a tracked item cannot be a bundle
    expect((await define(o)).status).toBe(200);
    // A bundle cannot be tracked; a component cannot stop being tracked.
    const track = await o.owner.post(`/inventory/items/${o.bundle}`, {
      inventoryAccountId: o.accounts['1140'],
      cogsAccountId: o.accounts['5100'],
    });
    expect(track.status).toBe(409);
    expect((await o.owner.delete(`/inventory/items/${o.a}`)).status).toBe(409);
    // No nesting: a second bundle cannot use the first as a component, and a component cannot become a bundle.
    const second = await o.owner.post('/sales/items', {
      name: 'Big basket',
      itemType: 'product',
      unitPrice: '300',
      revenueAccountId: o.accounts['4100'],
    });
    expect(
      (
        await o.owner.put(`/inventory/bundles/${second.body.data.id}`, {
          components: [{ itemId: o.bundle, quantity: '1' }],
        })
      ).status,
    ).toBe(400);
    await expect(
      db.query(
        `INSERT INTO inventory_bundle_components (organization_id, bundle_item_id, component_item_id, quantity) VALUES ($1, $2, $3, 1)`,
        [o.organizationId, o.bundle, o.bundle],
      ),
    ).rejects.toThrow();
  });

  it('issues components at their own cost, posts revenue for the bundle, and voids back', async () => {
    const o = await org();
    await buy(o, o.a, '10', '12'); // oil: 10 for 120
    await buy(o, o.b, '4', '5'); // salt: 4 for 20
    expect((await define(o)).status).toBe(200); // 2 oil + 1 salt per basket
    const invoice = await sell(o, o.bundle, '3', '100');
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(200);
    expect(await stock(o, o.a)).toMatchObject({ quantity: '4', value: '48.0000' }); // 6 oil out at 12
    expect(await stock(o, o.b)).toMatchObject({ quantity: '1', value: '5.0000' }); // 3 salt out at 5
    // Cost of goods sold: 6 * 12 + 3 * 5 = 87; inventory fell by the same; revenue is the 300 invoiced.
    expect(await balance(o.organizationId, o.accounts['5100']!)).toBe('87.00');
    expect(await balance(o.organizationId, o.accounts['1140']!)).toBe('53.00'); // 140 bought - 87
    expect(await balance(o.organizationId, o.accounts['4100']!)).toBe('-300.00');
    const movements = await db.query(
      `SELECT kind, count(*)::int AS n FROM inventory_movements WHERE organization_id = $1 GROUP BY kind ORDER BY kind`,
      [o.organizationId],
    );
    expect(movements.rows).toEqual([
      { kind: 'purchase', n: 2 },
      { kind: 'sale', n: 2 },
    ]);
    // Voiding the invoice returns the components at the cost they left.
    const voided = await o.owner.post(`/sales/invoices/${invoice.body.data.id}/void`, {
      version: invoice.body.data.version,
      reason: 'Entered in error',
    });
    if (voided.status !== 200) {
      await o.owner.reauthenticate();
      const again = await o.owner.post(`/sales/invoices/${invoice.body.data.id}/void`, {
        version: invoice.body.data.version,
        reason: 'Entered in error',
      });
      expect(again.status, JSON.stringify(again.body)).toBe(200);
    }
    expect(await stock(o, o.a)).toMatchObject({ quantity: '10', value: '120.0000' });
    expect(await stock(o, o.b)).toMatchObject({ quantity: '4', value: '20.0000' });
    expect(await balance(o.organizationId, o.accounts['5100']!)).toBe('0.00');
  });

  it('blocks the sale when a component is short, naming it, and leaves nothing half done', async () => {
    const o = await org();
    await buy(o, o.a, '10', '12');
    await buy(o, o.b, '1', '5');
    expect((await define(o)).status).toBe(200);
    const refused = await sell(o, o.bundle, '2'); // needs 2 salt, only 1 in stock
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('Sea salt 1kg');
    expect(await stock(o, o.a)).toMatchObject({ quantity: '10' });
    expect(await stock(o, o.b)).toMatchObject({ quantity: '1' });
  });

  it('applies the current definition only to future invoices, mixes with plain lines, and respects permissions and tenants', async () => {
    const o = await org();
    await buy(o, o.a, '20', '10');
    await buy(o, o.b, '20', '5');
    expect((await define(o)).status).toBe(200);
    await sell(o, o.bundle, '1'); // 2 oil + 1 salt
    expect((await define(o, [{ itemId: o.a, quantity: '5' }])).status).toBe(200);
    await sell(o, o.bundle, '1'); // 5 oil
    expect(await stock(o, o.a)).toMatchObject({ quantity: '13' });
    expect(await stock(o, o.b)).toMatchObject({ quantity: '19' });
    const mixed = await o.owner.post('/sales/invoices', {
      customerId: o.customerId,
      invoiceDate: todayIso(),
      dueDate: todayIso(),
      lines: [
        { itemId: o.bundle, description: 'Basket', quantity: '1', unitPrice: '100' },
        { itemId: o.a, description: 'Loose oil', quantity: '2', unitPrice: '30' },
      ],
    });
    const issued = await o.owner.post(`/sales/invoices/${mixed.body.data.id}/issue`, {
      version: mixed.body.data.version,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(await stock(o, o.a)).toMatchObject({ quantity: '6' }); // 13 - 5 - 2
    await o.owner.post('/organizations/current/roles', {
      name: 'Viewer',
      permissionKeys: ['organization.read', 'inventory.view'],
    });
    const viewer = await joinWithRole(ctx, o.owner, 'Viewer');
    expect((await viewer.client.get('/inventory/bundles')).status).toBe(200);
    expect(
      (
        await viewer.client.put(`/inventory/bundles/${o.bundle}`, {
          components: [{ itemId: o.a, quantity: '1' }],
        })
      ).status,
    ).toBe(403);
    expect((await viewer.client.delete(`/inventory/bundles/${o.bundle}`)).status).toBe(403);
    expect((await ctx.client().get('/inventory/bundles')).status).toBe(401);
    const other = await org();
    expect((await other.owner.get('/inventory/bundles')).body.data).toEqual([]);
    expect((await other.owner.get(`/inventory/bundles/${o.bundle}`)).status).toBe(404);
    expect(
      (
        await other.owner.put(`/inventory/bundles/${o.bundle}`, {
          components: [{ itemId: o.a, quantity: '1' }],
        })
      ).status,
    ).toBe(404);
  });
});
