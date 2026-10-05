import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Phase 4B-4 limits (P4-50, D5): at most 100 vendors and 497 bills per payment, and 2,000 bills
 * per batch. Every limit is checked before anything is recorded.
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

async function org() {
  const o = await setUpAccountingOrg(ctx);
  const settings = await o.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: o.accounts['2110'],
    defaultExpenseAccountId: o.accounts['5400'],
    defaultPaymentAccountId: o.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(settings.status).toBe(200);
  return o;
}

async function vendor(o: AccountingOrg, name: string) {
  const res = await o.owner.post('/vendors', {
    party: { kind: 'organization', displayName: name },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function postedBill(o: AccountingOrg, vendorId: string) {
  const bill = await o.owner.post('/purchases/bills', {
    vendorId,
    billDate: '2026-03-10',
    vendorReference: `INV-${randomUUID()}`,
    lines: [{ description: 'Part', quantity: '1', unitPrice: '1', taxCodeId: null }],
  });
  expect(bill.status, JSON.stringify(bill.body)).toBe(201);
  const res = await o.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
    version: bill.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return bill.body.data.id as string;
}

async function inBatches<T>(count: number, make: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < count; i += 8) {
    out.push(
      ...(await Promise.all(Array.from({ length: Math.min(8, count - i) }, (_, k) => make(i + k)))),
    );
  }
  return out;
}

async function paymentsOf(o: AccountingOrg) {
  const { rows } = await owner.query(
    `SELECT count(*)::int AS n FROM purchases_payments WHERE organization_id = $1`,
    [o.organizationId],
  );
  return rows[0].n as number;
}

describe('Pay bills limits (P4-50, D5)', () => {
  it('refuses more than 100 vendors before recording anything', async () => {
    const o = await org();
    const bills = await inBatches(101, async (i) => postedBill(o, await vendor(o, `Vendor ${i}`)));
    const res = await o.owner.post('/purchases/payment-batches', {
      paymentDate: '2026-03-20',
      bills: bills.map((billId) => ({ billId, amount: '1' })),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toEqual([
      { path: 'bills', message: 'A batch pays at most 100 vendors (P4-50).' },
    ]);
    expect(await paymentsOf(o)).toBe(0);
  }, 600_000);

  it('refuses more than 497 bills for one vendor and currency', async () => {
    const o = await org();
    const vendorId = await vendor(o, 'Bulk Supplier');
    const bills = await inBatches(498, () => postedBill(o, vendorId));
    const res = await o.owner.post('/purchases/payment-batches', {
      paymentDate: '2026-03-20',
      bills: bills.map((billId) => ({ billId, amount: '1' })),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toEqual([
      {
        path: 'groups.0',
        message:
          'A payment settles at most 497 bills (P4-50); this vendor has 498 MVR bills selected.',
      },
    ]);
    expect(await paymentsOf(o)).toBe(0);
  }, 600_000);

  it('accepts a full 2,000-bill request body and checks every bill', async () => {
    const o = await org();
    const res = await o.owner.post('/purchases/payment-batches', {
      paymentDate: '2026-03-20',
      bills: Array.from({ length: 2000 }, () => ({ billId: randomUUID(), amount: '1.25' })),
    });
    // Not 413: the route allows the largest valid batch; unknown bills are reported one by one.
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toHaveLength(2000);
  });
});
