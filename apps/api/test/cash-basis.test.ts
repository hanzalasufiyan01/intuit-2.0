import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cashSale,
  joinWithRole,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Cash-basis profit and loss (FP-22, docs/design/cash-basis-reports.md): documents are recognised
 * in proportion to what was settled, on the settlement dates; other journals as booked.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const FROM = '2026-03-01';
const TO = '2026-03-31';

async function org() {
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
  const customer = await o.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Customer' },
  });
  const vendor = await o.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Vendor' },
    currencyCode: 'MVR',
  });
  return {
    ...o,
    customerId: customer.body.data.id as string,
    vendorId: vendor.body.data.id as string,
  };
}
type Org = Awaited<ReturnType<typeof org>>;

async function invoice(o: Org, amount: string, date: string) {
  const draft = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate: date,
    dueDate: date,
    lines: [{ description: 'Work', quantity: '1', unitPrice: amount }],
  });
  const res = await o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function receipt(o: Org, invoiceId: string, amount: string, date: string) {
  const res = await o.owner.post('/sales/receipts', {
    customerId: o.customerId,
    receiptDate: date,
    amount,
    allocations: [{ invoiceId, amount }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function bill(o: Org, amount: string, date: string) {
  const created = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: date,
    vendorReference: `B-${randomUUID().slice(0, 8)}`,
    lines: [{ description: 'Supplies', quantity: '1', unitPrice: amount, taxCodeId: null }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const res = await o.owner.post(`/purchases/bills/${created.body.data.id}/post`, {
    version: created.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function pay(o: Org, billId: string, amount: string, date: string) {
  const draft = await o.owner.post('/purchases/payments', {
    vendorId: o.vendorId,
    paymentDate: date,
    amount,
    allocations: [{ billId, amount }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const res = await o.owner.post(`/purchases/payments/${draft.body.data.id}/record`, {
    version: draft.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

const cash = async (c: TestClient, from = FROM, to = TO) => {
  const res = await c.get(`/accounting/reports/profit-and-loss-cash-basis?from=${from}&to=${to}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};
const accrual = async (c: TestClient, from = FROM, to = TO) => {
  const res = await c.get(`/accounting/reports/profit-and-loss?from=${from}&to=${to}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};
const net = (report: { summary: { netProfit: string[] } }) => Number(report.summary.netProfit[0]);

describe('cash-basis profit and loss', () => {
  it('recognises an invoice in proportion to the receipts, on the receipt dates', async () => {
    const o = await org();
    const inv = await invoice(o, '1000', '2026-03-05');
    expect(net(await accrual(o.owner))).toBe(1000); // accrual: at issue
    expect(net(await cash(o.owner))).toBe(0); // nothing received yet
    await receipt(o, inv.id, '400', '2026-03-12');
    const partial = await cash(o.owner);
    expect(net(partial)).toBe(400);
    expect(partial).toMatchObject({ basis: 'cash', report: 'profit_and_loss_cash_basis' });
    expect(partial.method).toContain('settled');
    const second = await receipt(o, inv.id, '600', '2026-04-10');
    expect(net(await cash(o.owner))).toBe(400); // the rest falls in April
    expect(net(await cash(o.owner, '2026-04-01', '2026-04-30'))).toBe(600);
    expect(net(await cash(o.owner, '2026-03-01', '2026-04-30'))).toBe(1000);
    // Voiding the April receipt takes its recognition back out (on the void date).
    const voided = await o.owner.post(`/sales/receipts/${second.id}/void`, {
      version: second.version,
      reason: 'Bounced',
    });
    if (voided.status === 403 || voided.body?.error?.code === 'REAUTHENTICATION_REQUIRED') {
      await o.owner.reauthenticate();
      const again = await o.owner.post(`/sales/receipts/${second.id}/void`, {
        version: second.version,
        reason: 'Bounced',
      });
      expect(again.status, JSON.stringify(again.body)).toBe(200);
    } else {
      expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    }
    expect(net(await cash(o.owner, '2026-03-01', '2026-12-31'))).toBe(400);
  });

  it('recognises purchase bills when paid and counts other journals as booked', async () => {
    const o = await org();
    const b = await bill(o, '300', '2026-03-03');
    expect(net(await accrual(o.owner))).toBe(-300);
    expect(net(await cash(o.owner))).toBe(0);
    await pay(o, b.id, '120', '2026-03-20');
    expect(net(await cash(o.owner))).toBe(-120);
    await postJournal(o, cashSale(o, '50.00', '2026-03-15')); // a manual journal: as booked
    expect(net(await cash(o.owner))).toBe(-70);
    const report = await cash(o.owner);
    expect(report.integrity).toBeDefined();
    expect(JSON.stringify(report.sections)).toContain('Revenue');
  });

  it('validates the range, needs report permission and stays inside the organization', async () => {
    const a = await org();
    const b = await org();
    const inv = await invoice(a, '200', '2026-03-05');
    await receipt(a, inv.id, '200', '2026-03-06');
    expect(net(await cash(b.owner))).toBe(0);
    expect(
      (
        await a.owner.get(
          '/accounting/reports/profit-and-loss-cash-basis?from=2026-03-31&to=2026-03-01',
        )
      ).status,
    ).toBe(400);
    expect(
      (await a.owner.get('/accounting/reports/profit-and-loss-cash-basis?from=x&to=2026-03-01'))
        .status,
    ).toBe(400);
    expect(
      (
        await a.owner.get(
          '/accounting/reports/profit-and-loss-cash-basis?from=2026-03-01&to=2026-03-31&extra=1',
        )
      ).status,
    ).toBe(400);
    await a.owner.post('/organizations/current/roles', {
      name: 'Staff',
      permissionKeys: ['organization.read'],
    });
    const staff = await joinWithRole(ctx, a.owner, 'Staff');
    expect(
      (
        await staff.client.get(
          '/accounting/reports/profit-and-loss-cash-basis?from=2026-03-01&to=2026-03-31',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx
          .client()
          .get('/accounting/reports/profit-and-loss-cash-basis?from=2026-03-01&to=2026-03-31')
      ).status,
    ).toBe(401);
    // Opening-balance and document journals never count twice: the invoice journal is excluded.
    expect(net(await cash(a.owner))).toBe(200);
  });
});

export type { AccountingOrg };
