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
 * Purchase orders, goods receiving and three-way matching: the lifecycle, conditional approval,
 * partial receiving, bill conversion and linking, the match in OFF, WARNING and BLOCK modes with
 * tolerances, billed quantities and their release on a void, commitments, and security. An order
 * creates no journal.
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

interface OrderOrg extends AccountingOrg {
  vendorId: string;
  itemA: string;
  itemB: string;
}

async function orderOrg(): Promise<OrderOrg> {
  const org = await setUpAccountingOrg(ctx);
  const settings = await org.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: org.accounts['2110'],
    defaultExpenseAccountId: org.accounts['5400'],
    defaultPaymentAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const vendor = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Wholesale' },
  });
  const item = async (name: string) => {
    const res = await org.owner.post('/sales/items', {
      name,
      itemType: 'product',
      unitPrice: '50',
      isPurchased: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.id as string;
  };
  return {
    ...org,
    vendorId: vendor.body.data.id as string,
    itemA: await item('Coconut oil'),
    itemB: await item('Palm sugar'),
  };
}

const draft = (o: OrderOrg, overrides: Record<string, unknown> = {}) => ({
  vendorId: o.vendorId,
  orderDate: '2026-03-10',
  expectedDate: '2026-03-20',
  lines: [
    {
      itemId: o.itemA,
      description: 'Coconut oil',
      quantity: '10',
      unitPrice: '20',
      taxCodeId: null,
    },
    {
      itemId: o.itemB,
      description: 'Palm sugar',
      quantity: '5',
      unitPrice: '100',
      taxCodeId: null,
    },
  ],
  ...overrides,
});

async function createOrder(o: OrderOrg, overrides: Record<string, unknown> = {}) {
  const res = await o.owner.post('/purchases/orders', draft(o, overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function approvedOrder(o: OrderOrg, overrides: Record<string, unknown> = {}) {
  const order = await createOrder(o, overrides);
  const res = await o.owner.post(`/purchases/orders/${order.id}/submit`, {
    version: order.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.data.status).toBe('APPROVED');
  return res.body.data;
}

async function receive(
  o: OrderOrg,
  order: { id: string },
  lines: [string, string][],
  date = '2026-03-12',
) {
  return o.owner.post(`/purchases/orders/${order.id}/receipts`, {
    receiptDate: date,
    lines: lines.map(([orderLineId, quantity]) => ({ orderLineId, quantity })),
  });
}

async function setMatch(
  o: OrderOrg,
  matchMode: string,
  quantityTolerancePct = '0',
  priceTolerancePct = '0',
) {
  const current = (await o.owner.get('/purchases/order-settings')).body.data;
  const res = await o.owner.put('/purchases/order-settings', {
    version: current.version,
    matchMode,
    quantityTolerancePct,
    priceTolerancePct,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function toBill(
  o: OrderOrg,
  order: { id: string },
  basis: 'received' | 'ordered',
  vendorReference = `SI-${randomUUID().slice(0, 8)}`,
) {
  const res = await o.owner.post(`/purchases/orders/${order.id}/create-bill`, {
    basis,
    billDate: '2026-03-15',
    vendorReference,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as {
    id: string;
    version: number;
    lines: { unitPrice: string; quantity: string }[];
  };
}

async function postBill(o: OrderOrg, bill: { id: string; version: number }) {
  return o.owner.post(`/purchases/bills/${bill.id}/post`, { version: bill.version });
}

async function auditActions(o: AccountingOrg, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action FROM audit_events
      WHERE organization_id = $1 AND resource_type = 'purchase_order' AND resource_id = $2
      ORDER BY occurred_at, id`,
    [o.organizationId, resourceId],
  );
  return (rows as { action: string }[]).map((r) => r.action);
}

async function journalCount(o: AccountingOrg) {
  const { rows } = await owner.query(
    `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
    [o.organizationId],
  );
  return rows[0].n as number;
}

async function createRole(client: TestClient, name: string, permissionKeys: string[]) {
  const res = await client.post('/organizations/current/roles', { name, permissionKeys });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

// ---------------------------------------------------------------------------
// Drafts and approval
// ---------------------------------------------------------------------------

describe('purchase order drafts and approval', () => {
  it('computes totals on the server, takes no number and posts no journal', async () => {
    const o = await orderOrg();
    const order = await createOrder(o);
    expect(order).toMatchObject({
      status: 'DRAFT',
      number: null,
      subtotal: '700.00',
      total: '700.00',
    });
    expect(order.lines).toHaveLength(2);
    expect(order.lines[0]).toMatchObject({ remainingToReceive: '10', remainingToBill: '10' });
    const edited = await o.owner.put(`/purchases/orders/${order.id}`, {
      ...draft(o, { memo: 'Rush' }),
      version: order.version,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data.memo).toBe('Rush');
    const badDate = await o.owner.post(
      '/purchases/orders',
      draft(o, { expectedDate: '2026-03-01' }),
    );
    expect(badDate.body.error.details.issues[0].path).toBe('expectedDate');
    const deleted = await o.owner.delete(
      `/purchases/orders/${order.id}?version=${edited.body.data.version}`,
    );
    expect(deleted.status).toBe(200);
    expect(await journalCount(o)).toBe(0);
  });

  it('approves at once when no policy applies, numbers PO-, and then fixes the order', async () => {
    const o = await orderOrg();
    const first = await approvedOrder(o);
    const second = await approvedOrder(o);
    expect([first.number, second.number]).toEqual(['PO-00001', 'PO-00002']);
    const edit = await o.owner.put(`/purchases/orders/${first.id}`, {
      ...draft(o),
      version: first.version,
    });
    expect(edit.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const del = await o.owner.delete(`/purchases/orders/${first.id}?version=${first.version}`);
    expect(del.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await journalCount(o)).toBe(0);
    expect(await auditActions(o, first.id)).toEqual([
      'purchase_order.created',
      'purchase_order.approved',
    ]);
    // The database holds the terms fixed too.
    await expect(
      owner.query(`UPDATE purchase_orders SET total = 1 WHERE id = $1`, [first.id]),
    ).rejects.toThrow(/cannot be edited/);
    await expect(
      owner.query(`UPDATE purchase_order_lines SET quantity = 1 WHERE order_id = $1`, [first.id]),
    ).rejects.toThrow(/immutable/);
  });

  describe('with an approval policy', () => {
    async function withPolicy(threshold: string) {
      const o = await orderOrg();
      await createRole(o.owner, 'Order approver', [
        'purchase_orders.view',
        'purchase_orders.approve',
      ]);
      const roles = (await o.owner.get('/organizations/current/roles')).body.data as {
        id: string;
        name: string;
      }[];
      const roleId = roles.find((r) => r.name === 'Order approver')!.id;
      const policy = await o.owner.put('/approvals/policies/purchases.order.approve', {
        steps: [
          {
            name: 'Purchasing manager',
            requiredApprovals: 1,
            roleIds: [roleId],
            membershipIds: [],
            conditions: { minBaseAmount: threshold },
          },
        ],
      });
      expect(policy.status, JSON.stringify(policy.body)).toBe(200);
      const approver = await joinWithRole(ctx, o.owner, 'Order approver');
      return { o, approver: approver.client };
    }

    it('holds a large order for approval, refuses self-approval and approves', async () => {
      const { o, approver } = await withPolicy('500');
      const small = await approvedOrder(o, {
        lines: [
          { itemId: o.itemA, description: 'Oil', quantity: '1', unitPrice: '20', taxCodeId: null },
        ],
      });
      expect(small.status).toBe('APPROVED');
      const large = await createOrder(o);
      const submitted = await o.owner.post(`/purchases/orders/${large.id}/submit`, {
        version: large.version,
      });
      expect(submitted.body.data).toMatchObject({ status: 'PENDING_APPROVAL' });
      expect(submitted.body.data.number).toMatch(/^PO-/);
      const requestId = submitted.body.data.approval.requestId;
      const edit = await o.owner.put(`/purchases/orders/${large.id}`, {
        ...draft(o),
        version: submitted.body.data.version,
      });
      expect(edit.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(
        (await o.owner.post(`/approvals/requests/${requestId}/approve`, {})).body.error.code,
      ).toBe('SELF_APPROVAL_PROHIBITED');
      const approved = await approver.post(`/approvals/requests/${requestId}/approve`, {});
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect((await o.owner.get(`/purchases/orders/${large.id}`)).body.data.status).toBe(
        'APPROVED',
      );
      expect(await auditActions(o, large.id)).toEqual(
        expect.arrayContaining(['purchase_order.submitted', 'purchase_order.approved']),
      );
    });

    it('needs a reason to reject, returns to draft and supports withdrawal', async () => {
      const { o, approver } = await withPolicy('0');
      const order = await createOrder(o);
      const submitted = (
        await o.owner.post(`/purchases/orders/${order.id}/submit`, { version: order.version })
      ).body.data;
      const requestId = submitted.approval.requestId;
      expect((await approver.post(`/approvals/requests/${requestId}/reject`, {})).status).toBe(400);
      const rejected = await approver.post(`/approvals/requests/${requestId}/reject`, {
        comment: 'Wrong vendor',
      });
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
      const back = (await o.owner.get(`/purchases/orders/${order.id}`)).body.data;
      expect(back.status).toBe('DRAFT');
      const again = (
        await o.owner.post(`/purchases/orders/${order.id}/submit`, { version: back.version })
      ).body.data;
      const withdrawn = await o.owner.post(`/purchases/orders/${order.id}/withdraw`, {
        version: again.version,
      });
      expect(withdrawn.body.data.status).toBe('DRAFT');
    });
  });
});

// ---------------------------------------------------------------------------
// Goods receiving
// ---------------------------------------------------------------------------

describe('goods receiving', () => {
  it('moves the order from approved to partially received to received', async () => {
    const o = await orderOrg();
    const order = await approvedOrder(o);
    const [a, b] = order.lines as { id: string }[];
    const first = await receive(o, order, [[a!.id, '4']]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.status).toBe('PARTIALLY_RECEIVED');
    expect(first.body.data.lines[0]).toMatchObject({
      receivedQuantity: '4',
      remainingToReceive: '6',
    });
    expect(first.body.data.receipts[0].number).toBe('GR-00001');
    const over = await receive(o, order, [[a!.id, '7']]);
    expect(over.status).toBe(400);
    expect(over.body.error.details.issues[0].path).toBe('lines.0.quantity');
    const rest = await receive(o, order, [
      [a!.id, '6'],
      [b!.id, '5'],
    ]);
    expect(rest.body.data.status).toBe('RECEIVED');
    const closedForReceiving = await receive(o, order, [[a!.id, '1']]);
    expect(closedForReceiving.status).toBe(400);
    expect(await journalCount(o)).toBe(0);
  });

  it('voids a receipt, taking the quantity back, and replays an idempotent receipt', async () => {
    const o = await orderOrg();
    const order = await approvedOrder(o);
    const a = order.lines[0] as { id: string };
    const body = { receiptDate: '2026-03-12', lines: [{ orderLineId: a.id, quantity: '10' }] };
    const key = randomUUID();
    const first = await o.owner.post(`/purchases/orders/${order.id}/receipts`, body, {
      'Idempotency-Key': key,
    });
    const replay = await o.owner.post(`/purchases/orders/${order.id}/receipts`, body, {
      'Idempotency-Key': key,
    });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(first.body.data.receipts).toHaveLength(1);
    expect(replay.body.data.receipts).toHaveLength(1);
    const receipt = first.body.data.receipts[0] as { id: string; version: number };
    const voided = await o.owner.post(`/purchases/receipts/${receipt.id}/void`, {
      version: receipt.version,
      reason: 'Wrong delivery',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.status).toBe('APPROVED');
    expect(voided.body.data.lines[0].receivedQuantity).toBe('0');
    const again = await o.owner.post(`/purchases/receipts/${receipt.id}/void`, {
      version: receipt.version + 1,
      reason: 'x',
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    await expect(
      owner.query(`UPDATE purchase_receipt_lines SET quantity = 1 WHERE receipt_id = $1`, [
        receipt.id,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('allows over-receipt only within the quantity tolerance', async () => {
    const o = await orderOrg();
    await setMatch(o, 'off', '10');
    const order = await approvedOrder(o);
    const a = order.lines[0] as { id: string };
    expect((await receive(o, order, [[a.id, '11']])).status).toBe(201);
    expect((await receive(o, order, [[a.id, '0.5']])).status).toBe(400);
  });

  it('closes and cancels under their rules', async () => {
    const o = await orderOrg();
    const untouched = await approvedOrder(o);
    const cancelled = await o.owner.post(`/purchases/orders/${untouched.id}/cancel`, {
      version: untouched.version,
      reason: 'Not needed',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Not needed' });
    const used = await approvedOrder(o);
    const withGoods = (await receive(o, used, [[(used.lines[0] as { id: string }).id, '2']])).body
      .data;
    const refused = await o.owner.post(`/purchases/orders/${used.id}/cancel`, {
      version: withGoods.version,
      reason: 'x',
    });
    expect(refused.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const closed = await o.owner.post(`/purchases/orders/${used.id}/close`, {
      version: withGoods.version,
      reason: 'Supplier short',
    });
    expect(closed.body.data).toMatchObject({ status: 'CLOSED', closeReason: 'Supplier short' });
    expect((await receive(o, used, [[(used.lines[0] as { id: string }).id, '1']])).status).toBe(
      409,
    );
    await expect(
      owner.query(`UPDATE purchase_orders SET memo = 'x' WHERE id = $1`, [used.id]),
    ).rejects.toThrow(/immutable/);
  });
});

// ---------------------------------------------------------------------------
// Bills and the three-way match
// ---------------------------------------------------------------------------

describe('bills and the three-way match', () => {
  it('converts received quantities into a linked draft bill at the order prices and applies the billed quantities', async () => {
    const o = await orderOrg();
    await setMatch(o, 'block');
    const order = await approvedOrder(o);
    const [a, b] = order.lines as { id: string }[];
    await receive(o, order, [
      [a!.id, '6'],
      [b!.id, '5'],
    ]);
    const bill = await toBill(o, order, 'received');
    expect(bill.lines.map((l) => [l.quantity, l.unitPrice])).toEqual([
      ['6', '20'],
      ['5', '100'],
    ]);
    const posted = await postBill(o, bill);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const after = (await o.owner.get(`/purchases/orders/${order.id}`)).body.data;
    expect(after.lines.map((l: { billedQuantity: string }) => l.billedQuantity)).toEqual([
      '6',
      '5',
    ]);
    expect(after.bills[0]).toMatchObject({
      status: 'POSTED',
      match: { mode: 'block', status: 'matched', issues: [] },
    });
    expect(after.lines[0]).toMatchObject({ remainingToBill: '4' });
    // The remaining 4 of the first line cannot be billed before they are received.
    const second = await toBill(o, order, 'ordered');
    expect(second.lines.map((l) => l.quantity)).toEqual(['4']);
    const blocked = await postBill(o, second);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.details.issues[0].message).toMatch(/billed 10 but only 6 received/);
    expect((await o.owner.get(`/purchases/bills/${second.id}`)).body.data.status).toBe('DRAFT');
    await receive(o, order, [[a!.id, '4']]);
    const ok = await postBill(o, second);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const done = (await o.owner.get(`/purchases/orders/${order.id}`)).body.data;
    expect(done.lines[0]).toMatchObject({ billedQuantity: '10', remainingToBill: '0' });
    expect(done.status).toBe('RECEIVED');
    const nothing = await o.owner.post(`/purchases/orders/${order.id}/create-bill`, {
      basis: 'ordered',
      billDate: '2026-03-16',
    });
    expect(nothing.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('checks the bill price against the order price within the tolerance, by mode', async () => {
    const o = await orderOrg();
    const order = await approvedOrder(o);
    const [a, b] = order.lines as { id: string }[];
    await receive(o, order, [
      [a!.id, '10'],
      [b!.id, '5'],
    ]);
    const priced = async (price: string) => {
      const bill = await toBill(o, order, 'received');
      const edited = await o.owner.put(`/purchases/bills/${bill.id}`, {
        vendorId: o.vendorId,
        billDate: '2026-03-15',
        vendorReference: `SI-${randomUUID().slice(0, 8)}`,
        version: bill.version,
        lines: [
          {
            itemId: o.itemA,
            description: 'Coconut oil',
            quantity: '10',
            unitPrice: price,
            taxCodeId: null,
          },
          {
            itemId: o.itemB,
            description: 'Palm sugar',
            quantity: '5',
            unitPrice: '100',
            taxCodeId: null,
          },
        ],
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      return edited.body.data as { id: string; version: number };
    };
    // BLOCK: 25 against 20 is 25% off; 5% tolerance does not cover it.
    await setMatch(o, 'block', '0', '5');
    const high = await priced('25');
    const blocked = await postBill(o, high);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.details.issues[0].message).toMatch(/differs from the order price/);
    // Within tolerance: 20.5 is 2.5% off.
    const near = await priced('20.5');
    expect((await postBill(o, near)).status).toBe(200);
  });

  it('records warnings without blocking in WARNING mode and nothing in OFF mode', async () => {
    const o = await orderOrg();
    const order = await approvedOrder(o);
    const [a] = order.lines as { id: string }[];
    await receive(o, order, [[a!.id, '3']]);
    await setMatch(o, 'warning');
    const bill = await toBill(o, order, 'ordered');
    const posted = await postBill(o, bill);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const after = (await o.owner.get(`/purchases/orders/${order.id}`)).body.data;
    expect(after.bills[0].match.status).toBe('warning');
    expect(after.bills[0].match.issues.map((i: { kind: string }) => i.kind)).toContain('quantity');
    expect(await auditActions(o, order.id)).toContain('purchase_order.bill_matched_with_warnings');

    const off = await orderOrg();
    const order2 = await approvedOrder(off);
    await setMatch(off, 'off');
    const bill2 = await toBill(off, order2, 'ordered');
    expect((await postBill(off, bill2)).status).toBe(200);
    const after2 = (await off.owner.get(`/purchases/orders/${order2.id}`)).body.data;
    expect(after2.bills[0].match).toMatchObject({ mode: 'off', status: 'matched', issues: [] });
    expect(after2.lines[0].billedQuantity).toBe('10');
  });

  it('releases the billed quantities when a bill is voided', async () => {
    const o = await orderOrg();
    const order = await approvedOrder(o);
    const bill = await toBill(o, order, 'ordered');
    const posted = (await postBill(o, bill)).body.data;
    expect(
      (await o.owner.get(`/purchases/orders/${order.id}`)).body.data.lines[0].billedQuantity,
    ).toBe('10');
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const voided = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: posted.version,
      reason: 'Wrong prices',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const after = (await o.owner.get(`/purchases/orders/${order.id}`)).body.data;
    expect(after.lines[0]).toMatchObject({ billedQuantity: '0', remainingToBill: '10' });
    expect(await auditActions(o, order.id)).toContain('purchase_order.bill_released');
  });

  it('links an existing draft bill only when it fits the order', async () => {
    const o = await orderOrg();
    const order = await approvedOrder(o);
    const other = await o.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Other Supplier' },
    });
    const wrongVendor = await o.owner.post('/purchases/bills', {
      vendorId: other.body.data.id,
      billDate: '2026-03-15',
      vendorReference: 'X-1',
      lines: [{ description: 'Oil', quantity: '1', unitPrice: '20', taxCodeId: null }],
    });
    const refused = await o.owner.post(`/purchases/orders/${order.id}/link-bill`, {
      billId: wrongVendor.body.data.id,
    });
    expect(refused.status).toBe(400);
    const right = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorId,
      billDate: '2026-03-15',
      vendorReference: 'X-2',
      lines: [
        {
          itemId: o.itemA,
          description: 'Coconut oil',
          quantity: '2',
          unitPrice: '20',
          taxCodeId: null,
        },
      ],
    });
    const linked = await o.owner.post(`/purchases/orders/${order.id}/link-bill`, {
      billId: right.body.data.id,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    const twice = await o.owner.post(`/purchases/orders/${order.id}/link-bill`, {
      billId: right.body.data.id,
    });
    expect(twice.status).toBe(400);
    // A linked draft bill can be deleted with its link.
    const deleted = await o.owner.delete(
      `/purchases/bills/${right.body.data.id}?version=${right.body.data.version}`,
    );
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect((await o.owner.get(`/purchases/orders/${order.id}`)).body.data.bills).toHaveLength(0);
  });

  it('flags a bill line that is not on the order', async () => {
    const o = await orderOrg();
    await setMatch(o, 'block');
    const order = await approvedOrder(o);
    const [a] = order.lines as { id: string }[];
    await receive(o, order, [[a!.id, '10']]);
    const extra = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorId,
      billDate: '2026-03-15',
      vendorReference: 'X-3',
      lines: [{ description: 'Freight', quantity: '1', unitPrice: '30', taxCodeId: null }],
    });
    await o.owner.post(`/purchases/orders/${order.id}/link-bill`, { billId: extra.body.data.id });
    const posted = await postBill(o, extra.body.data);
    expect(posted.status).toBe(400);
    expect(posted.body.error.details.issues[0].message).toMatch(/not on purchase order/);
  });
});

// ---------------------------------------------------------------------------
// Commitments, settings and security
// ---------------------------------------------------------------------------

describe('commitments and security', () => {
  it('reports what is still to be billed on live orders', async () => {
    const o = await orderOrg();
    const order = await approvedOrder(o);
    await setMatch(o, 'off');
    const report = (await o.owner.get('/purchases/reports/commitments')).body.data;
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      vendorName: 'Island Wholesale',
      ordered: '700.00',
      openValue: '700.00',
      orderCount: 1,
    });
    const bill = await toBill(o, order, 'ordered');
    await postBill(o, bill);
    const after = (await o.owner.get('/purchases/reports/commitments')).body.data;
    expect(after.items[0].openValue).toBe('0.00');
  });

  it('keeps the match settings under their own permission and validates them', async () => {
    const o = await orderOrg();
    const bad = await o.owner.put('/purchases/order-settings', {
      version: 0,
      matchMode: 'block',
      quantityTolerancePct: '150',
      priceTolerancePct: '1',
    });
    expect(bad.status).toBe(400);
    await setMatch(o, 'warning', '2.5', '1');
    expect((await o.owner.get('/purchases/order-settings')).body.data).toMatchObject({
      matchMode: 'warning',
      quantityTolerancePct: '2.5',
      priceTolerancePct: '1',
      version: 1,
    });
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/purchases/order-settings')).status).toBe(200);
    expect(
      (
        await member.client.put('/purchases/order-settings', {
          version: 1,
          matchMode: 'off',
          quantityTolerancePct: '0',
          priceTolerancePct: '0',
        })
      ).status,
    ).toBe(403);
  });

  it('is permissioned and tenant-isolated', async () => {
    const a = await orderOrg();
    const b = await orderOrg();
    const order = await approvedOrder(a);
    expect((await b.owner.get(`/purchases/orders/${order.id}`)).status).toBe(404);
    expect(
      (await b.owner.post(`/purchases/orders/${order.id}/cancel`, { version: 1, reason: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (
        await b.owner.post(`/purchases/orders/${order.id}/receipts`, {
          receiptDate: '2026-03-12',
          lines: [{ orderLineId: order.lines[0].id, quantity: '1' }],
        })
      ).status,
    ).toBe(404);
    expect((await b.owner.get('/purchases/orders')).body.data.items).toEqual([]);
    const member = await joinWithRole(ctx, a.owner, 'Member');
    expect((await member.client.get(`/purchases/orders/${order.id}`)).status).toBe(200);
    expect((await member.client.post('/purchases/orders', draft(a))).status).toBe(403);
    expect(
      (
        await member.client.post(`/purchases/orders/${order.id}/receipts`, {
          receiptDate: '2026-03-12',
          lines: [{ orderLineId: order.lines[0].id, quantity: '1' }],
        })
      ).status,
    ).toBe(403);
    expect(
      (await member.client.post(`/purchases/orders/${order.id}/close`, { version: order.version }))
        .status,
    ).toBe(403);
    const client = await connectAs('app');
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      for (const table of [
        'purchase_orders',
        'purchase_order_lines',
        'purchase_receipts',
        'purchase_order_bills',
      ]) {
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
