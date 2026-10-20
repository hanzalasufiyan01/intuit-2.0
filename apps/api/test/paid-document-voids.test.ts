import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Reversal of paid documents (R-05). The rules in the services: an invoice or a bill with a
 * payment or credit applied cannot be voided; the supported path is to void the receipt or the
 * vendor payment first (its journal and allocations are reversed and the open balance restored)
 * and then the document. A second void is refused, a stale version is refused, a user without the
 * void permission is refused, and another organization cannot reach the records at all.
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

interface World extends AccountingOrg {
  customerId: string;
  vendorId: string;
}

async function world(): Promise<World> {
  const org = await setUpAccountingOrg(ctx);
  const sales = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'no_tax',
    defaultPaymentTermsDays: 30,
  });
  expect(sales.status, JSON.stringify(sales.body)).toBe(200);
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
  const customer = await org.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Reef Resort' },
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  const vendor = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Supplies' },
  });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  return { ...org, customerId: customer.body.data.id, vendorId: vendor.body.data.id };
}

/** Debit minus credit of an account over posted and reversed journals. */
async function balance(o: AccountingOrg, code: string) {
  const { rows } = await db.query(
    `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
    [o.organizationId, o.accounts[code]],
  );
  return rows[0].b as string;
}

async function auditCount(o: AccountingOrg, action: string, resourceId: string) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE organization_id = $1 AND action = $2 AND resource_id = $3`,
    [o.organizationId, action, resourceId],
  );
  return rows[0].n as number;
}

async function issuedInvoice(o: World, amount: string) {
  const created = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate: '2026-03-10',
    lines: [{ description: 'Services', quantity: '1', unitPrice: amount }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const issued = await o.owner.post(`/sales/invoices/${created.body.data.id}/issue`, {
    version: created.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data as { id: string; version: number };
}

async function receiptFor(o: World, invoiceId: string, amount: string) {
  const res = await o.owner.post('/sales/receipts', {
    customerId: o.customerId,
    receiptDate: '2026-03-20',
    amount,
    allocations: [{ invoiceId, amount }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; version: number };
}

async function postedBill(o: World, amount: string) {
  const created = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: '2026-03-10',
    vendorReference: `INV-${randomUUID().slice(0, 8)}`,
    lines: [{ description: 'Stock', quantity: '1', unitPrice: amount, taxCodeId: null }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const posted = await o.owner.post(`/purchases/bills/${created.body.data.id}/post`, {
    version: created.body.data.version,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return posted.body.data as { id: string; version: number };
}

async function paymentFor(o: World, billId: string, amount: string) {
  const draft = await o.owner.post('/purchases/payments', {
    vendorId: o.vendorId,
    paymentDate: '2026-03-20',
    amount,
    allocations: [{ billId, amount }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const recorded = await o.owner.post(`/purchases/payments/${draft.body.data.id}/record`, {
    version: draft.body.data.version,
  });
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
  return recorded.body.data as { id: string; version: number };
}

describe('voiding a paid invoice', () => {
  it('needs the receipt voided first, and every step reverses the ledger exactly', async () => {
    const o = await world();
    const invoice = await issuedInvoice(o, '500.00');
    const receipt = await receiptFor(o, invoice.id, '300.00');
    expect(await balance(o, '1130')).toBe('200.00');
    expect(await balance(o, '1120')).toBe('300.00');

    // The invoice is part-paid: refused, and nothing changes.
    const refused = await o.owner.post(`/sales/invoices/${invoice.id}/void`, {
      version: (await o.owner.get(`/sales/invoices/${invoice.id}`)).body.data.version,
      reason: 'Wrong customer',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(refused.body.error.message).toMatch(/payments or credits applied/);
    const open = (await o.owner.get(`/sales/invoices/${invoice.id}`)).body.data;
    expect(open).toMatchObject({ status: 'ISSUED', amountDue: '200.00' });
    expect(await balance(o, '1130')).toBe('200.00');

    // A user without the void permission cannot void the receipt.
    const member = await joinWithRole(ctx, o.owner, 'Member');
    const denied = await member.client.post(`/sales/receipts/${receipt.id}/void`, {
      version: receipt.version,
      reason: 'Not allowed',
    });
    expect(denied.status).toBe(403);

    // Voiding the receipt restores the invoice to its full amount.
    const voidedReceipt = await o.owner.post(`/sales/receipts/${receipt.id}/void`, {
      version: receipt.version,
      reason: 'Cheque bounced',
    });
    expect(voidedReceipt.status, JSON.stringify(voidedReceipt.body)).toBe(200);
    expect(voidedReceipt.body.data).toMatchObject({ status: 'VOID', voidReason: 'Cheque bounced' });
    expect(
      voidedReceipt.body.data.allocations.filter(
        (a: { reversesAllocationId: string | null }) => a.reversesAllocationId,
      ),
    ).toHaveLength(1);
    expect((await o.owner.get(`/sales/invoices/${invoice.id}`)).body.data.amountDue).toBe('500.00');
    expect(await balance(o, '1130')).toBe('500.00');
    expect(await balance(o, '1120')).toBe('0.00');

    // A second void, with the new version or the old one, is refused and changes nothing.
    const again = await o.owner.post(`/sales/receipts/${receipt.id}/void`, {
      version: voidedReceipt.body.data.version,
      reason: 'Again',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const stale = await o.owner.post(`/sales/receipts/${receipt.id}/void`, {
      version: receipt.version,
      reason: 'Again',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(await balance(o, '1120')).toBe('0.00');
    expect(await auditCount(o, 'receipt.voided', receipt.id)).toBe(1);

    // Now the invoice can be voided, once.
    const fresh = (await o.owner.get(`/sales/invoices/${invoice.id}`)).body.data;
    const voidedInvoice = await o.owner.post(`/sales/invoices/${invoice.id}/void`, {
      version: fresh.version,
      reason: 'Wrong customer',
    });
    expect(voidedInvoice.status, JSON.stringify(voidedInvoice.body)).toBe(200);
    expect(voidedInvoice.body.data.status).toBe('VOID');
    for (const code of ['1130', '1120', '4100']) expect(await balance(o, code), code).toBe('0.00');
    const second = await o.owner.post(`/sales/invoices/${invoice.id}/void`, {
      version: voidedInvoice.body.data.version,
      reason: 'Again',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/already void/);
    expect(await auditCount(o, 'invoice.voided', invoice.id)).toBe(1);
    // The AR aging has nothing left.
    const aging = await o.owner.get('/sales/reports/aging?asOf=2026-12-31');
    expect(aging.status, JSON.stringify(aging.body)).toBe(200);
    expect(aging.body.data.customers).toEqual([]);
  });

  it('is invisible and untouchable from another organization', async () => {
    const a = await world();
    const b = await world();
    const invoice = await issuedInvoice(a, '500.00');
    const receipt = await receiptFor(a, invoice.id, '300.00');
    expect(
      (
        await b.owner.post(`/sales/receipts/${receipt.id}/void`, {
          version: receipt.version,
          reason: 'Not mine',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await b.owner.post(`/sales/invoices/${invoice.id}/void`, {
          version: invoice.version,
          reason: 'Not mine',
        })
      ).status,
    ).toBe(404);
    expect((await a.owner.get(`/sales/receipts/${receipt.id}`)).body.data.status).toBe('RECORDED');
    expect(await balance(a, '1130')).toBe('200.00');
    expect(await balance(b, '1130')).toBe('0.00');
  });
});

describe('voiding a paid bill', () => {
  it('needs the vendor payment voided first, and every step reverses the ledger exactly', async () => {
    const o = await world();
    const bill = await postedBill(o, '800.00');
    const payment = await paymentFor(o, bill.id, '500.00');
    // Accounts payable is a credit balance: debit minus credit is negative.
    expect(await balance(o, '2110')).toBe('-300.00');
    expect(await balance(o, '1120')).toBe('-500.00');

    const refused = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: (await o.owner.get(`/purchases/bills/${bill.id}`)).body.data.version,
      reason: 'Duplicate',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(refused.body.error.message).toMatch(/payments or credits applied/);
    expect((await o.owner.get(`/purchases/bills/${bill.id}`)).body.data).toMatchObject({
      status: 'POSTED',
      amountDue: '300.00',
    });

    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (
        await member.client.post(`/purchases/payments/${payment.id}/void`, {
          version: payment.version,
          reason: 'Not allowed',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await member.client.post(`/purchases/bills/${bill.id}/void`, {
          version: bill.version,
          reason: 'Not allowed',
        })
      ).status,
    ).toBe(403);

    const voidedPayment = await o.owner.post(`/purchases/payments/${payment.id}/void`, {
      version: payment.version,
      reason: 'Paid the wrong vendor',
    });
    expect(voidedPayment.status, JSON.stringify(voidedPayment.body)).toBe(200);
    expect(voidedPayment.body.data.status).toBe('VOID');
    expect((await o.owner.get(`/purchases/bills/${bill.id}`)).body.data.amountDue).toBe('800.00');
    expect(await balance(o, '2110')).toBe('-800.00');
    expect(await balance(o, '1120')).toBe('0.00');

    const again = await o.owner.post(`/purchases/payments/${payment.id}/void`, {
      version: voidedPayment.body.data.version,
      reason: 'Again',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const stale = await o.owner.post(`/purchases/payments/${payment.id}/void`, {
      version: payment.version,
      reason: 'Again',
    });
    expect(stale.status).toBe(409);
    expect(await balance(o, '1120')).toBe('0.00');
    expect(await auditCount(o, 'vendor_payment.voided', payment.id)).toBe(1);

    const fresh = (await o.owner.get(`/purchases/bills/${bill.id}`)).body.data;
    const voidedBill = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: fresh.version,
      reason: 'Duplicate',
    });
    expect(voidedBill.status, JSON.stringify(voidedBill.body)).toBe(200);
    for (const code of ['2110', '1120', '5400']) expect(await balance(o, code), code).toBe('0.00');
    const second = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: voidedBill.body.data.version,
      reason: 'Again',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/already void/);
    expect(await auditCount(o, 'bill.voided', bill.id)).toBe(1);
    const aging = await o.owner.get('/purchases/reports/aging?asOf=2026-12-31');
    expect(aging.status, JSON.stringify(aging.body)).toBe(200);
    expect(aging.body.data.vendors).toEqual([]);
  });

  it('is invisible and untouchable from another organization', async () => {
    const a = await world();
    const b = await world();
    const bill = await postedBill(a, '800.00');
    const payment = await paymentFor(a, bill.id, '500.00');
    for (const [path, version] of [
      [`/purchases/payments/${payment.id}/void`, payment.version],
      [`/purchases/bills/${bill.id}/void`, bill.version],
    ] as const) {
      const res = await b.owner.post(path, { version, reason: 'Not mine' });
      expect(res.status, path).toBe(404);
    }
    expect((await a.owner.get(`/purchases/payments/${payment.id}`)).body.data.status).toBe(
      'RECORDED',
    );
    expect(await balance(a, '2110')).toBe('-300.00');
    expect(await balance(b, '2110')).toBe('0.00');
  });
});
