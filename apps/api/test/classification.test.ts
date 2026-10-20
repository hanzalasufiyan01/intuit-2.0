import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Customer groups, custom fields on customers, item categories and barcodes (migration 0088;
 * master specification sections 10, 16 and 18). Real PostgreSQL.
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
  customerId: string;
  itemId: string;
  secondItemId: string;
}

async function org(): Promise<Org> {
  const o = await setUpAccountingOrg(ctx);
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
  const customer = await o.owner.post('/customers', {
    party: { kind: 'individual', displayName: 'Aisha' },
  });
  const item = async (name: string) =>
    (
      await o.owner.post('/sales/items', {
        name,
        itemType: 'service',
        unitPrice: '100',
        revenueAccountId: o.accounts['4100'],
      })
    ).body.data.id as string;
  return {
    ...o,
    customerId: customer.body.data.id,
    itemId: await item('Consulting'),
    secondItemId: await item('Training'),
  };
}

describe('customer groups', () => {
  it('creates, renames, archives and assigns groups, one per customer, with audit', async () => {
    const o = await org();
    const created = await o.owner.post('/customer-groups', { name: 'Resorts' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    expect((await o.owner.post('/customer-groups', { name: ' resorts ' })).status).toBe(409);
    const other = await o.owner.post('/customer-groups', { name: 'Retail' });

    const set = await o.owner.put(`/customers/${o.customerId}/group`, { groupId: id });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await o.owner.get(`/customers/${o.customerId}/group`)).body.data).toEqual({
      groupId: id,
      name: 'Resorts',
    });
    // Moving to another group replaces the first (one group per customer).
    await o.owner.put(`/customers/${o.customerId}/group`, { groupId: other.body.data.id });
    const list = (await o.owner.get('/customer-groups')).body.data as {
      name: string;
      members: number;
    }[];
    expect(Object.fromEntries(list.map((g) => [g.name, g.members]))).toEqual({
      Resorts: 0,
      Retail: 1,
    });
    expect(
      (await o.owner.get(`/customer-groups/${other.body.data.id}/customers`)).body.data,
    ).toEqual([o.customerId]);

    // An archived group cannot be assigned; versions are checked; renaming to a duplicate fails.
    const archived = await o.owner.patch(`/customer-groups/${id}`, {
      version: 1,
      status: 'ARCHIVED',
    });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect((await o.owner.put(`/customers/${o.customerId}/group`, { groupId: id })).status).toBe(
      400,
    );
    expect(
      (await o.owner.patch(`/customer-groups/${id}`, { version: 1, name: 'Old' })).status,
    ).toBe(409);
    expect(
      (
        await o.owner.patch(`/customer-groups/${other.body.data.id}`, {
          version: 1,
          name: 'resorts',
        })
      ).status,
    ).toBe(409);
    expect((await o.owner.put(`/customers/${o.customerId}/group`, { groupId: null })).status).toBe(
      200,
    );
    expect((await o.owner.get(`/customers/${o.customerId}/group`)).body.data.groupId).toBeNull();
    const audit = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND (action LIKE 'customer_group.%' OR action = 'customer.group_set') ORDER BY occurred_at`,
      [o.organizationId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'customer_group.created',
        'customer_group.updated',
        'customer.group_set',
      ]),
    );
  });

  it('needs customer permissions and stays inside the tenant', async () => {
    const o = await org();
    const group = await o.owner.post('/customer-groups', { name: 'VIP' });
    const member = await joinWithRole(ctx, o.owner, 'Member');
    // Members can read (customers.view), not change.
    expect((await member.client.get('/customer-groups')).status).toBe(200);
    expect((await member.client.post('/customer-groups', { name: 'x' })).status).toBe(403);
    expect(
      (await member.client.put(`/customers/${o.customerId}/group`, { groupId: null })).status,
    ).toBe(403);
    const view = await o.owner.post('/organizations/current/roles', {
      name: 'Customer reader',
      permissionKeys: ['customers.view'],
    });
    expect(view.status).toBe(201);
    const reader = await joinWithRole(ctx, o.owner, 'Customer reader');
    expect((await reader.client.get('/customer-groups')).status).toBe(200);
    expect((await reader.client.post('/customer-groups', { name: 'y' })).status).toBe(403);
    const stranger = await org();
    expect(
      (await stranger.owner.put(`/customers/${o.customerId}/group`, { groupId: null })).status,
    ).toBe(404);
    expect(
      (
        await stranger.owner.put(`/customers/${stranger.customerId}/group`, {
          groupId: group.body.data.id,
        })
      ).status,
    ).toBe(400);
  });
});

describe('custom fields on customers', () => {
  it('defines typed fields, validates values, clears them and keeps key and type fixed', async () => {
    const o = await org();
    const make = async (body: object) => {
      const r = await o.owner.post('/custom-fields', body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data as { id: string; version: number };
    };
    const text = await make({ key: 'passport_note', label: 'Reference', fieldType: 'text' });
    await make({ key: 'visits', label: 'Visits', fieldType: 'number', sortOrder: 2 });
    await make({ key: 'since', label: 'Customer since', fieldType: 'date', sortOrder: 3 });
    await make({ key: 'vip', label: 'VIP', fieldType: 'boolean', sortOrder: 4 });
    const tier = await make({
      key: 'tier',
      label: 'Tier',
      fieldType: 'list',
      options: ['Gold', 'Silver'],
      sortOrder: 5,
    });
    // Bad definitions.
    expect(
      (await o.owner.post('/custom-fields', { key: 'Bad Key', label: 'x', fieldType: 'text' }))
        .status,
    ).toBe(400);
    expect(
      (
        await o.owner.post('/custom-fields', {
          key: 'one',
          label: 'x',
          fieldType: 'list',
          options: ['A'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await o.owner.post('/custom-fields', {
          key: 'two',
          label: 'x',
          fieldType: 'text',
          options: ['A', 'B'],
        })
      ).status,
    ).toBe(400);
    expect(
      (await o.owner.post('/custom-fields', { key: 'visits', label: 'dup', fieldType: 'text' }))
        .status,
    ).toBe(409);

    const url = `/customers/${o.customerId}/custom-fields`;
    const ok = await o.owner.put(url, {
      values: {
        passport_note: 'Prefers e-mail',
        visits: 3,
        since: '2025-04-01',
        vip: true,
        tier: 'Gold',
      },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const byKey = Object.fromEntries(
      ok.body.data.map((f: { key: string; value: unknown }) => [f.key, f.value]),
    );
    expect(byKey).toEqual({
      passport_note: 'Prefers e-mail',
      visits: 3,
      since: '2025-04-01',
      vip: true,
      tier: 'Gold',
    });
    // Type checks, unknown keys, list membership.
    for (const values of [
      { visits: 'many' },
      { since: '04/01/2025' },
      { vip: 'yes' },
      { tier: 'Bronze' },
      { nope: 'x' },
    ]) {
      expect((await o.owner.put(url, { values })).status, JSON.stringify(values)).toBe(400);
    }
    // null clears a value.
    const cleared = await o.owner.put(url, { values: { visits: null } });
    expect(cleared.body.data.find((f: { key: string }) => f.key === 'visits').value).toBeNull();

    // Key and type are fixed; a list choice in use cannot be removed.
    expect(
      (await o.owner.patch(`/custom-fields/${text.id}`, { version: 1, key: 'other' })).status,
    ).toBe(400);
    expect(
      (
        await o.owner.patch(`/custom-fields/${tier.id}`, {
          version: 1,
          options: ['Silver', 'Bronze'],
        })
      ).status,
    ).toBe(409);
    const extended = await o.owner.patch(`/custom-fields/${tier.id}`, {
      version: 1,
      options: ['Gold', 'Silver', 'Bronze'],
    });
    expect(extended.status, JSON.stringify(extended.body)).toBe(200);
    await expect(
      db.query(`UPDATE custom_field_definitions SET field_type = 'text' WHERE id = $1`, [tier.id]),
    ).rejects.toThrow(/cannot change/);
    await expect(
      db.query(`DELETE FROM custom_field_definitions WHERE id = $1`, [tier.id]),
    ).rejects.toThrow(/archived, not deleted/);

    // An archived field disappears from new input but keeps showing a stored value.
    expect(
      (await o.owner.patch(`/custom-fields/${text.id}`, { version: 1, status: 'ARCHIVED' })).status,
    ).toBe(200);
    expect((await o.owner.put(url, { values: { passport_note: 'again' } })).status).toBe(400);
    expect(
      (await o.owner.get(url)).body.data.find((f: { key: string }) => f.key === 'passport_note')
        .value,
    ).toBe('Prefers e-mail');

    // The audit names fields, never values.
    const audit = await db.query(
      `SELECT metadata::text AS m FROM audit_events WHERE organization_id = $1 AND action = 'customer.custom_fields_set'`,
      [o.organizationId],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows.map((r) => r.m).join(' ')).not.toContain('Prefers e-mail');
  });

  it('is limited by permission and tenant', async () => {
    const o = await org();
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/custom-fields')).status).toBe(200);
    expect(
      (await member.client.post('/custom-fields', { key: 'k', label: 'k', fieldType: 'text' }))
        .status,
    ).toBe(403);
    const field = await o.owner.post('/custom-fields', {
      key: 'note',
      label: 'Note',
      fieldType: 'text',
    });
    const stranger = await org();
    expect((await stranger.owner.get('/custom-fields')).body.data).toEqual([]);
    expect(
      (
        await stranger.owner.patch(`/custom-fields/${field.body.data.id}`, {
          version: 1,
          label: 'x',
        })
      ).status,
    ).toBe(404);
    expect(
      (await stranger.owner.put(`/customers/${o.customerId}/custom-fields`, { values: {} })).status,
    ).toBe(404);
  });
});

describe('item categories and barcodes', () => {
  it('assigns one category per item and keeps barcodes unique per organization', async () => {
    const o = await org();
    const cat = await o.owner.post('/item-categories', { name: 'Services' });
    expect(cat.status, JSON.stringify(cat.body)).toBe(201);
    expect((await o.owner.post('/item-categories', { name: 'SERVICES' })).status).toBe(409);
    const catId = cat.body.data.id as string;
    expect(
      (await o.owner.put(`/sales/items/${o.itemId}/category`, { categoryId: catId })).status,
    ).toBe(200);
    const cls = (await o.owner.get(`/sales/items/${o.itemId}/classification`)).body.data;
    expect(cls).toMatchObject({ categoryId: catId, categoryName: 'Services', barcodes: [] });
    expect((await o.owner.get('/item-categories')).body.data[0]).toMatchObject({ members: 1 });
    expect((await o.owner.get(`/item-categories/${catId}/items`)).body.data).toEqual([o.itemId]);

    const set = await o.owner.put(`/sales/items/${o.itemId}/barcodes`, {
      barcodes: ['5901234123457', 'CONS-001'],
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    // A barcode belongs to one item; bad formats and duplicates in one list are refused.
    expect(
      (await o.owner.put(`/sales/items/${o.secondItemId}/barcodes`, { barcodes: ['CONS-001'] }))
        .status,
    ).toBe(409);
    expect(
      (await o.owner.put(`/sales/items/${o.secondItemId}/barcodes`, { barcodes: ['has space'] }))
        .status,
    ).toBe(400);
    expect(
      (await o.owner.put(`/sales/items/${o.secondItemId}/barcodes`, { barcodes: ['A', 'A'] }))
        .status,
    ).toBe(400);
    // Lookup finds the item; a replacement frees the old code.
    expect((await o.owner.get('/sales/items/by-barcode/CONS-001')).body.data).toMatchObject({
      id: o.itemId,
      name: 'Consulting',
    });
    expect((await o.owner.get('/sales/items/by-barcode/UNKNOWN')).status).toBe(404);
    await o.owner.put(`/sales/items/${o.itemId}/barcodes`, { barcodes: ['5901234123457'] });
    expect(
      (await o.owner.put(`/sales/items/${o.secondItemId}/barcodes`, { barcodes: ['CONS-001'] }))
        .status,
    ).toBe(200);
    // Another organization may use the same code for its own item.
    const stranger = await org();
    expect(
      (
        await stranger.owner.put(`/sales/items/${stranger.itemId}/barcodes`, {
          barcodes: ['CONS-001'],
        })
      ).status,
    ).toBe(200);
    expect((await stranger.owner.get('/sales/items/by-barcode/5901234123457')).status).toBe(404);
    expect(
      (await stranger.owner.put(`/sales/items/${o.itemId}/category`, { categoryId: null })).status,
    ).toBe(404);
    // Archived categories are not assignable.
    await o.owner.patch(`/item-categories/${catId}`, { version: 1, status: 'ARCHIVED' });
    expect(
      (await o.owner.put(`/sales/items/${o.secondItemId}/category`, { categoryId: catId })).status,
    ).toBe(400);
  });

  it('reports sales by category with an uncategorized remainder, and enforces permissions', async () => {
    const o = await org();
    const cat = await o.owner.post('/item-categories', { name: 'Consulting work' });
    await o.owner.put(`/sales/items/${o.itemId}/category`, { categoryId: cat.body.data.id });
    for (const [itemId, qty] of [
      [o.itemId, '2'],
      [o.secondItemId, '1'],
    ] as const) {
      const inv = await o.owner.post('/sales/invoices', {
        customerId: o.customerId,
        invoiceDate: '2026-03-10',
        lines: [{ itemId, description: 'Work', quantity: qty, unitPrice: '100' }],
      });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      const issued = await o.owner.post(`/sales/invoices/${inv.body.data.id}/issue`, {
        version: inv.body.data.version,
      });
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    }
    const report = await o.owner.get(
      '/sales/reports/sales-by-category?from=2026-03-01&to=2026-03-31',
    );
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const by = Object.fromEntries(
      report.body.data.categories.map((c: { name: string | null; netSales: string }) => [
        c.name ?? 'uncategorized',
        Number(c.netSales),
      ]),
    );
    expect(by).toEqual({ 'Consulting work': 200, uncategorized: 100 });
    expect(Number(report.body.data.totals.netSales)).toBe(300);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (await member.client.get('/sales/reports/sales-by-category?from=2026-03-01&to=2026-03-31'))
        .status,
    ).toBe(200);
    expect((await member.client.post('/item-categories', { name: 'x' })).status).toBe(403);
    expect((await member.client.get('/sales/items/by-barcode/X')).status).toBe(404);
    expect(
      (await member.client.put(`/sales/items/${o.itemId}/category`, { categoryId: null })).status,
    ).toBe(403);
  });
});

describe('product variants and bins (migration 0090; reversible defaults of ADR 0015)', () => {
  it('groups items as variants with unique attributes, and keeps variants ordinary items', async () => {
    const o = await org();
    const group = await o.owner.post('/variant-groups', { name: 'Coaching package' });
    expect(group.status, JSON.stringify(group.body)).toBe(201);
    const gid = group.body.data.id as string;
    expect((await o.owner.post('/variant-groups', { name: ' coaching PACKAGE ' })).status).toBe(
      409,
    );
    const set = await o.owner.put(`/sales/items/${o.itemId}/variant`, {
      groupId: gid,
      attributes: { duration: '1 hour', level: 'Basic' },
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    // Identical attributes in the same group are refused, different ones are fine.
    expect(
      (
        await o.owner.put(`/sales/items/${o.secondItemId}/variant`, {
          groupId: gid,
          attributes: { level: 'Basic', duration: '1 hour' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await o.owner.put(`/sales/items/${o.secondItemId}/variant`, {
          groupId: gid,
          attributes: { duration: '2 hours', level: 'Basic' },
        })
      ).status,
    ).toBe(200);
    // Attribute rules.
    for (const attributes of [{}, undefined, { a: '' }]) {
      expect(
        (await o.owner.put(`/sales/items/${o.itemId}/variant`, { groupId: gid, attributes }))
          .status,
      ).toBe(400);
    }
    const detail = (await o.owner.get(`/variant-groups/${gid}`)).body.data;
    expect(detail.variants.map((v: { name: string }) => v.name).sort()).toEqual([
      'Consulting',
      'Training',
    ]);
    expect((await o.owner.get('/variant-groups')).body.data[0]).toMatchObject({ members: 2 });
    expect((await o.owner.get(`/sales/items/${o.itemId}/variant`)).body.data).toMatchObject({
      groupId: gid,
      attributes: { duration: '1 hour', level: 'Basic' },
    });
    // Archived groups are not assignable; leaving the group frees the attributes.
    expect((await o.owner.put(`/sales/items/${o.itemId}/variant`, { groupId: null })).status).toBe(
      200,
    );
    await o.owner.patch(`/variant-groups/${gid}`, { version: 1, status: 'ARCHIVED' });
    expect(
      (
        await o.owner.put(`/sales/items/${o.itemId}/variant`, {
          groupId: gid,
          attributes: { duration: '1 hour' },
        })
      ).status,
    ).toBe(400);
    // Tenant and permission isolation.
    const stranger = await org();
    expect((await stranger.owner.get(`/variant-groups/${gid}`)).status).toBe(404);
    expect(
      (await stranger.owner.put(`/sales/items/${o.itemId}/variant`, { groupId: null })).status,
    ).toBe(404);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/variant-groups')).status).toBe(200);
    expect((await member.client.post('/variant-groups', { name: 'x' })).status).toBe(403);
  });

  it('keeps bins inside a warehouse, with a default bin per item and warehouse', async () => {
    const o = await org();
    const warehouses = (await o.owner.get('/inventory/warehouses')).body.data as {
      id: string;
      isDefault: boolean;
    }[];
    const main = warehouses.find((w) => w.isDefault)!.id;
    const annex = await o.owner.post('/inventory/warehouses', { code: 'ANNEX', name: 'Annex' });
    const bin = await o.owner.post('/inventory/bins', {
      warehouseId: main,
      code: 'A-01',
      name: 'Aisle A',
    });
    expect(bin.status, JSON.stringify(bin.body)).toBe(201);
    expect(
      (await o.owner.post('/inventory/bins', { warehouseId: main, code: 'a-01' })).status,
    ).toBe(409);
    // The same code may exist in another warehouse.
    const other = await o.owner.post('/inventory/bins', {
      warehouseId: annex.body.data.id,
      code: 'A-01',
    });
    expect(other.status).toBe(201);
    expect(
      (await o.owner.get(`/inventory/bins?warehouseId=${main}`)).body.data.map(
        (b: { code: string }) => b.code,
      ),
    ).toEqual(['A-01']);
    // Default bin: it must belong to the named warehouse.
    expect(
      (
        await o.owner.put(`/inventory/items/${o.itemId}/default-bin`, {
          warehouseId: main,
          binId: other.body.data.id,
        })
      ).status,
    ).toBe(400);
    const set = await o.owner.put(`/inventory/items/${o.itemId}/default-bin`, {
      warehouseId: main,
      binId: bin.body.data.id,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await o.owner.get(`/inventory/items/${o.itemId}/default-bins`)).body.data).toEqual([
      { warehouseId: main, binId: bin.body.data.id },
    ]);
    // An archived bin cannot be chosen; clearing works; stock is untouched by bins.
    await o.owner.patch(`/inventory/bins/${bin.body.data.id}`, { version: 1, status: 'ARCHIVED' });
    expect(
      (
        await o.owner.put(`/inventory/items/${o.itemId}/default-bin`, {
          warehouseId: main,
          binId: bin.body.data.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await o.owner.put(`/inventory/items/${o.itemId}/default-bin`, {
          warehouseId: main,
          binId: null,
        })
      ).status,
    ).toBe(200);
    const stranger = await org();
    expect((await stranger.owner.get(`/inventory/items/${o.itemId}/default-bins`)).status).toBe(
      404,
    );
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/inventory/bins')).status).toBe(200);
    expect(
      (await member.client.post('/inventory/bins', { warehouseId: main, code: 'Z' })).status,
    ).toBe(403);
  });
});
