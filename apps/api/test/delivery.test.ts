import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Delivery notes and stock reservations (migration 0091; reversible defaults of ADR 0015): a
 * delivery records fulfilment against a confirmed order and moves no stock; a reservation is an
 * advisory hold. Real PostgreSQL.
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
  customerId: string;
  itemId: string;
}

/** Sales, purchases and inventory set up; a product tracked in stock with 20 units on hand. */
async function org(): Promise<Org> {
  const o = await setUpAccountingOrg(ctx);
  const ok = async (res: { status: number; body: unknown }) =>
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  await ok(
    await o.owner.put('/purchases/settings', {
      version: 0,
      apAccountId: o.accounts['2110'],
      defaultExpenseAccountId: o.accounts['5400'],
      defaultPaymentAccountId: o.accounts['1120'],
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    }),
  );
  await ok(
    await o.owner.put('/sales/settings', {
      version: 0,
      arAccountId: o.accounts['1130'],
      defaultRevenueAccountId: o.accounts['4100'],
      defaultDepositAccountId: o.accounts['1120'],
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'no_tax',
      defaultPaymentTermsDays: 0,
    }),
  );
  await ok(
    await o.owner.put('/inventory/settings', {
      version: 0,
      negativeStockPolicy: 'block',
      adjustmentAccountId: o.accounts['5400'],
    }),
  );
  const customer = await o.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Resort' },
  });
  const vendor = await o.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Wholesale' },
  });
  const item = await o.owner.post('/sales/items', {
    name: 'Coconut oil 1L',
    itemType: 'product',
    unitPrice: '100',
    revenueAccountId: o.accounts['4100'],
  });
  const itemId = item.body.data.id as string;
  await ok(
    await o.owner.post(`/inventory/items/${itemId}`, {
      inventoryAccountId: o.accounts['1140'],
      cogsAccountId: o.accounts['5100'],
    }),
  );
  const bill = await o.owner.post('/purchases/bills', {
    vendorId: vendor.body.data.id,
    billDate: '2026-03-10',
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: [{ itemId, description: 'Stock', quantity: '20', unitPrice: '10', taxCodeId: null }],
  });
  await ok(
    await o.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
      version: bill.body.data.version,
    }),
  );
  return { ...o, customerId: customer.body.data.id, itemId };
}

async function confirmedOrder(o: Org, quantity = '10') {
  const created = await o.owner.post('/sales/orders', {
    customerId: o.customerId,
    orderDate: todayIso(),
    lines: [
      { itemId: o.itemId, quantity, unitPrice: '100' },
      { description: 'Setup', quantity: '1', unitPrice: '250' },
    ],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const confirmed = await o.owner.post(`/sales/orders/${created.body.data.id}/confirm`, {
    version: created.body.data.version,
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return confirmed.body.data as { id: string; version: number; number: string };
}

const stockOf = async (o: Org) =>
  (await o.owner.get(`/inventory/items/${o.itemId}`)).body.data.quantity as string;

describe('delivery notes', () => {
  it('records deliveries in parts against a confirmed order, never beyond it, and moves no stock', async () => {
    const o = await org();
    const order = await confirmedOrder(o);
    const stockBefore = await stockOf(o);
    const journalsBefore = await db.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
      [o.organizationId],
    );

    const first = await o.owner.post('/sales/delivery-notes', {
      orderId: order.id,
      deliveryDate: todayIso(),
      memo: 'First van',
      lines: [{ orderLineNo: 1, quantity: '4' }],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({
      number: 'DLV-00001',
      status: 'DRAFT',
      orderNumber: order.number,
    });
    // A draft does not count as delivered; too much for the line is refused at both steps.
    expect(
      (await o.owner.get(`/sales/orders/${order.id}/fulfilment`)).body.data.lines[0],
    ).toMatchObject({ ordered: '10', delivered: '0', remaining: '10' });
    expect(
      (
        await o.owner.post('/sales/delivery-notes', {
          orderId: order.id,
          deliveryDate: todayIso(),
          lines: [{ orderLineNo: 1, quantity: '11' }],
        })
      ).status,
    ).toBe(400);
    for (const bad of [
      { orderLineNo: 9, quantity: '1' },
      { orderLineNo: 1, quantity: '0' },
      { orderLineNo: 1, quantity: 'x' },
    ]) {
      expect(
        (
          await o.owner.post('/sales/delivery-notes', {
            orderId: order.id,
            deliveryDate: todayIso(),
            lines: [bad],
          })
        ).status,
      ).toBe(400);
    }
    // Edit the draft, then deliver it.
    const edited = await o.owner.put(`/sales/delivery-notes/${first.body.data.id}`, {
      version: first.body.data.version,
      deliveryDate: todayIso(),
      lines: [
        { orderLineNo: 1, quantity: '6' },
        { orderLineNo: 2, quantity: '1' },
      ],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const delivered = await o.owner.post(`/sales/delivery-notes/${first.body.data.id}/deliver`, {
      version: edited.body.data.version,
    });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.body.data.status).toBe('DELIVERED');
    // A second note is limited to what remains (4); delivering past it fails and changes nothing.
    const second = await o.owner.post('/sales/delivery-notes', {
      orderId: order.id,
      deliveryDate: todayIso(),
      lines: [{ orderLineNo: 1, quantity: '5' }],
    });
    expect(second.status).toBe(201);
    const over = await o.owner.post(`/sales/delivery-notes/${second.body.data.id}/deliver`, {
      version: second.body.data.version,
    });
    expect(over.status).toBe(400);
    expect(over.body.error.details.issues[0].message).toMatch(/Only 4/);
    expect(
      (await o.owner.get(`/sales/delivery-notes/${second.body.data.id}`)).body.data.status,
    ).toBe('DRAFT');
    const fulfilment = (await o.owner.get(`/sales/orders/${order.id}/fulfilment`)).body.data;
    expect(fulfilment.lines[0]).toMatchObject({ delivered: '6', remaining: '4' });

    // Nothing moved: no stock and no journal.
    expect(await stockOf(o)).toBe(stockBefore);
    const journalsAfter = await db.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(journalsAfter.rows[0].n).toBe(journalsBefore.rows[0].n);

    // A delivered note cannot be edited or deleted; voiding frees the quantity.
    expect(
      (
        await o.owner.put(`/sales/delivery-notes/${first.body.data.id}`, {
          version: delivered.body.data.version,
          deliveryDate: todayIso(),
          lines: [{ orderLineNo: 1, quantity: '1' }],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await o.owner.delete(
          `/sales/delivery-notes/${first.body.data.id}?version=${delivered.body.data.version}`,
        )
      ).status,
    ).toBe(409);
    await expect(
      db.query(`UPDATE delivery_note_lines SET quantity = 1 WHERE note_id = $1`, [
        first.body.data.id,
      ]),
    ).rejects.toThrow(/draft/);
    const voided = await o.owner.post(`/sales/delivery-notes/${first.body.data.id}/void`, {
      version: delivered.body.data.version,
      reason: 'Returned undamaged',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(
      (await o.owner.get(`/sales/orders/${order.id}/fulfilment`)).body.data.lines[0],
    ).toMatchObject({ delivered: '0', remaining: '10' });
    expect(
      (
        await o.owner.post(`/sales/delivery-notes/${first.body.data.id}/void`, {
          version: voided.body.data.version,
          reason: 'again',
        })
      ).status,
    ).toBe(409);
    // A draft can be deleted.
    const del = await o.owner.delete(
      `/sales/delivery-notes/${second.body.data.id}?version=${second.body.data.version}`,
    );
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    const audit = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'delivery_note.%'`,
      [o.organizationId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'delivery_note.created',
        'delivery_note.updated',
        'delivery_note.delivered',
        'delivery_note.voided',
        'delivery_note.deleted',
      ]),
    );
  });

  it('needs a confirmed order, sales-order permissions, and stays inside the tenant', async () => {
    const o = await org();
    const draft = await o.owner.post('/sales/orders', {
      customerId: o.customerId,
      orderDate: todayIso(),
      lines: [{ description: 'Setup', quantity: '1', unitPrice: '250' }],
    });
    expect(
      (
        await o.owner.post('/sales/delivery-notes', {
          orderId: draft.body.data.id,
          deliveryDate: todayIso(),
          lines: [{ orderLineNo: 1, quantity: '1' }],
        })
      ).status,
    ).toBe(409);
    const order = await confirmedOrder(o);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (
        await member.client.post('/sales/delivery-notes', {
          orderId: order.id,
          deliveryDate: todayIso(),
          lines: [{ orderLineNo: 1, quantity: '1' }],
        })
      ).status,
    ).toBe(403);
    const note = await o.owner.post('/sales/delivery-notes', {
      orderId: order.id,
      deliveryDate: todayIso(),
      lines: [{ orderLineNo: 1, quantity: '1' }],
    });
    const stranger = await org();
    expect((await stranger.owner.get(`/sales/delivery-notes/${note.body.data.id}`)).status).toBe(
      404,
    );
    expect((await stranger.owner.get(`/sales/orders/${order.id}/fulfilment`)).status).toBe(404);
    expect(
      (
        await stranger.owner.post('/sales/delivery-notes', {
          orderId: order.id,
          deliveryDate: todayIso(),
          lines: [{ orderLineNo: 1, quantity: '1' }],
        })
      ).status,
    ).toBe(404);
  });
});

describe('stock reservations', () => {
  it('lowers available stock without blocking anything, shrinks as an order is invoiced, and ends on cancel', async () => {
    const o = await org();
    const availability = async () =>
      (await o.owner.get(`/inventory/items/${o.itemId}/availability`)).body.data as {
        onHand: string;
        reserved: string;
        available: string;
      };
    expect(await availability()).toMatchObject({ onHand: '20', reserved: '0', available: '20' });

    // A manual reservation.
    const manual = await o.owner.post('/inventory/reservations', {
      itemId: o.itemId,
      quantity: '5',
      note: 'Held for walk-in',
    });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    expect(await availability()).toMatchObject({ reserved: '5', available: '15' });
    for (const bad of [
      { itemId: o.itemId, quantity: '0' },
      { itemId: o.itemId, quantity: '1', expiresOn: 'soon' },
      { itemId: randomUUID(), quantity: '1' },
    ]) {
      expect((await o.owner.post('/inventory/reservations', bad)).status, JSON.stringify(bad)).toBe(
        400,
      );
    }

    // An order reserves what it still needs (10), and a second call adds nothing.
    const order = await confirmedOrder(o);
    const reserved = await o.owner.post(`/sales/orders/${order.id}/reserve`, {});
    expect(reserved.status, JSON.stringify(reserved.body)).toBe(201);
    expect(reserved.body.data).toHaveLength(1);
    expect(reserved.body.data[0]).toMatchObject({ source: 'sales_order', quantity: '10' });
    expect((await o.owner.post(`/sales/orders/${order.id}/reserve`, {})).body.data).toEqual([]);
    expect(await availability()).toMatchObject({ reserved: '15', available: '5' });

    // Reservations are advisory: a sale beyond the available quantity still issues.
    const inv = await o.owner.post('/sales/invoices', {
      customerId: o.customerId,
      invoiceDate: todayIso(),
      dueDate: todayIso(),
      lines: [{ itemId: o.itemId, description: 'Walk-in', quantity: '18', unitPrice: '100' }],
    });
    const issued = await o.owner.post(`/sales/invoices/${inv.body.data.id}/issue`, {
      version: inv.body.data.version,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect((await availability()).onHand).toBe('2');

    // Invoicing part of the order lowers what the order still holds.
    await o.owner.post(`/sales/orders/${order.id}/invoice`, {
      version: order.version,
      lines: [{ lineNo: 1, quantity: '4' }],
    });
    expect((await availability()).reserved).toBe('11');

    // Cancelling the order is refused once invoiced; release by hand, and the manual one too.
    const list = (await o.owner.get('/inventory/reservations?status=ACTIVE')).body.data as {
      id: string;
      source: string;
    }[];
    expect(list).toHaveLength(2);
    const orderHold = list.find((r) => r.source === 'sales_order')!;
    expect(
      (
        await o.owner.post(`/inventory/reservations/${orderHold.id}/release`, {
          reason: 'Customer changed mind',
        })
      ).status,
    ).toBe(200);
    expect((await o.owner.post(`/inventory/reservations/${orderHold.id}/release`, {})).status).toBe(
      409,
    );
    expect((await availability()).reserved).toBe('5');
    await expect(
      db.query(`DELETE FROM stock_reservations WHERE id = $1`, [manual.body.data.id]),
    ).rejects.toThrow(/released, not deleted/);
  });

  it('releases an order reservation when the order is cancelled, and checks permissions and tenants', async () => {
    const o = await org();
    const order = await confirmedOrder(o);
    await o.owner.post(`/sales/orders/${order.id}/reserve`, {});
    expect(
      (await o.owner.get(`/inventory/items/${o.itemId}/availability`)).body.data.reserved,
    ).toBe('10');
    const cancelled = await o.owner.post(`/sales/orders/${order.id}/cancel`, {
      version: order.version,
      reason: 'Customer withdrew',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(
      (await o.owner.get(`/inventory/items/${o.itemId}/availability`)).body.data.reserved,
    ).toBe('0');
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/inventory/reservations')).status).toBe(200);
    expect(
      (await member.client.post('/inventory/reservations', { itemId: o.itemId, quantity: '1' }))
        .status,
    ).toBe(403);
    const stranger = await org();
    expect((await stranger.owner.get(`/inventory/items/${o.itemId}/availability`)).status).toBe(
      404,
    );
    expect(
      (await stranger.owner.post('/inventory/reservations', { itemId: o.itemId, quantity: '1' }))
        .status,
    ).toBe(400);
  });
});
