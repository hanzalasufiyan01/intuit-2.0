import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 4B-8: Purchases exports (vendors, bills, vendor credits, vendor payments, AP aging,
 * purchases by vendor, the full payment register) and Purchases search (ADR 0004 P4-48, PD2, PD8).
 * Runs in the serial project (job worker). Read-only: nothing here writes accounting.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

interface Org extends AccountingOrg {
  vendorId: string;
}

async function purchasesOrg(): Promise<Org> {
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
    party: {
      kind: 'organization',
      displayName: 'Reef Hardware',
      reference: 'VN-1',
      email: 'ap@reef.test',
      tin: '1234567',
    },
  });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  return { ...org, vendorId: vendor.body.data.id };
}

async function settle(client: TestClient, path: string, busy: string[]) {
  for (let i = 0; i < 400; i++) {
    const res = await client.get(path);
    if (!busy.includes(res.body.data.status)) return res.body.data;
    await ctx.worker.runOnce();
  }
  return (await client.get(path)).body.data;
}

async function exportCsv(client: TestClient, domain: string, params: object = {}) {
  const created = await client.post('/exports', { domain, params });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const id = created.body.data.export.id as string;
  const done = await settle(client, `/exports/${id}`, ['queued', 'running']);
  expect(done.status, JSON.stringify(done)).toBe('ready');
  const link = await client.get(`/exports/${id}/download-url`);
  expect(link.status, JSON.stringify(link.body)).toBe(200);
  const file = await ctx.app.inject({ method: 'GET', url: link.body.data.url });
  return file.body
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.replace(/"/g, ''));
}

async function postedBill(o: Org, amount: string, reference: string, billDate = '2026-03-10') {
  const bill = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate,
    vendorReference: reference,
    lines: [{ description: 'Hardware', quantity: '1', unitPrice: amount, taxCodeId: null }],
  });
  expect(bill.status, JSON.stringify(bill.body)).toBe(201);
  const res = await o.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
    version: bill.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; number: string };
}

async function postedCredit(o: Org, amount: string, reference: string) {
  const doc = await o.owner.post('/purchases/vendor-credits', {
    origin: 'supplier_credit_note',
    vendorId: o.vendorId,
    creditDate: '2026-03-12',
    vendorReference: reference,
    lines: [{ description: 'Returned', quantity: '1', unitPrice: amount, taxCodeId: null }],
  });
  expect(doc.status, JSON.stringify(doc.body)).toBe(201);
  const res = await o.owner.post(`/purchases/vendor-credits/${doc.body.data.id}/post`, {
    version: doc.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; number: string };
}

async function recordedPayment(o: Org, amount: string, allocations: object[] = []) {
  const draft = await o.owner.post('/purchases/payments', {
    vendorId: o.vendorId,
    paymentDate: '2026-03-20',
    amount,
    reference: `CHQ-${randomUUID().slice(0, 4)}`,
    allocations,
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const res = await o.owner.post(`/purchases/payments/${draft.body.data.id}/record`, {
    version: draft.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; number: string };
}

describe('Purchases exports (4B-8)', () => {
  it('exports vendors, bills, credits, payments, AP aging, purchases by vendor and the register', async () => {
    const o = await purchasesOrg();
    const bill = await postedBill(o, '100', 'SUP-100');
    const second = await postedBill(o, '60', 'SUP-060', '2026-03-12');
    const credit = await postedCredit(o, '20', 'CN-020');
    const paid = await recordedPayment(o, '150', [{ billId: bill.id, amount: '100' }]);
    const refund = await o.owner.post('/purchases/refunds', {
      sourceType: 'payment',
      sourceId: paid.id,
      refundDate: '2026-03-25',
      amount: '10',
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);

    const vendors = await exportCsv(o.owner, 'vendors');
    expect(vendors[0]).toBe(
      'kind,display_name,company_name,reference,tin,email,phone,currency,payment_terms_days,credit_limit,account_number,default_expense_account,default_tax_code,status',
    );
    expect(vendors.some((l) => l.startsWith('organization,Reef Hardware,,VN-1,1234567,'))).toBe(
      true,
    );
    expect(vendors).toHaveLength(2);

    const bills = await exportCsv(o.owner, 'bills', { status: 'POSTED' });
    expect(bills[0]).toContain('number,kind,status,vendor,vendor_reference,bill_date,due_date');
    expect(bills).toHaveLength(3);
    const row = bills.find((l) => l.startsWith(`${bill.number},`))!;
    expect(row).toContain(',standard,posted,Reef Hardware,SUP-100,2026-03-10,');
    expect(row).toContain(',MVR,100');

    const credits = await exportCsv(o.owner, 'vendor_credits');
    expect(credits).toHaveLength(2);
    expect(credits[1]).toContain(
      `${credit.number},supplier_credit_note,posted,Reef Hardware,CN-020`,
    );

    const payments = await exportCsv(o.owner, 'vendor_payments');
    expect(payments).toHaveLength(2);
    expect(payments[1]).toContain(`${paid.number},recorded,Reef Hardware,2026-03-20,MVR,150`);

    const aging = await exportCsv(o.owner, 'ap_aging', { asOf: '2026-03-31' });
    expect(aging[0]).toBe(
      'vendor,document_type,number,vendor_reference,date,due_date,days_overdue,bucket,currency,open_amount,open_base',
    );
    // Only the 60.00 bill is still open, and the 20.00 credit reduces what is owed.
    expect(aging.find((l) => l.includes(second.number))).toContain(',current,MVR,60');
    expect(aging.some((l) => l.includes(bill.number))).toBe(false);

    const byVendor = await exportCsv(o.owner, 'purchases_by_vendor', {
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(byVendor[0]).toBe(
      'vendor,bills,credits,net,recoverable_tax,non_recoverable_tax,cost,tax,total',
    );
    expect(byVendor[1]).toContain('Reef Hardware,2,1,140');

    const register = await exportCsv(o.owner, 'payment_register', {
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(register[0]).toContain('record,number,status,date,vendor,account_code');
    expect(register.some((l) => l.startsWith(`payment,${paid.number},recorded,2026-03-20`))).toBe(
      true,
    );
    expect(register.some((l) => l.startsWith('refund,') && l.includes(',MVR,10'))).toBe(true);
  });

  it('needs the screen view permission and re-checks it on download', async () => {
    const o = await purchasesOrg();
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Vendor viewer',
      permissionKeys: ['vendors.view'],
    });
    expect(role.status).toBe(201);
    const viewer = await joinWithRole(ctx, o.owner, 'Vendor viewer');
    expect((await viewer.client.post('/exports', { domain: 'vendors', params: {} })).status).toBe(
      202,
    );
    for (const [domain, params] of [
      ['bills', {}],
      ['vendor_credits', {}],
      ['vendor_payments', {}],
      ['ap_aging', { asOf: '2026-03-31' }],
      ['purchases_by_vendor', { from: '2026-03-01', to: '2026-03-31' }],
      ['payment_register', { from: '2026-03-01', to: '2026-03-31' }],
    ] as const) {
      expect((await viewer.client.post('/exports', { domain, params })).status, domain).toBe(403);
    }
  });

  it('rejects unknown or malformed parameters', async () => {
    const o = await purchasesOrg();
    expect(
      (await o.owner.post('/exports', { domain: 'ap_aging', params: { asOf: 'tomorrow' } })).status,
    ).toBe(400);
    expect(
      (
        await o.owner.post('/exports', {
          domain: 'bills',
          params: { status: 'POSTED', surprise: true },
        })
      ).status,
    ).toBe(400);
  });

  it('keeps exports tenant-isolated', async () => {
    const a = await purchasesOrg();
    const b = await purchasesOrg();
    await postedBill(a, '70', 'ONLY-A');
    const own = await exportCsv(b.owner, 'bills');
    expect(own).toHaveLength(1); // the header only: no bills in B
    const created = await a.owner.post('/exports', { domain: 'bills', params: {} });
    expect((await b.owner.get(`/exports/${created.body.data.export.id}`)).status).toBe(404);
  });
});

describe('Purchases search (4B-8)', () => {
  it('searches vendors, bills, credits and payments, and respects each section permission', async () => {
    const o = await purchasesOrg();
    const bill = await postedBill(o, '100', 'REEF-7788');
    await postedCredit(o, '10', 'REEF-CR-1');
    await recordedPayment(o, '100', [{ billId: bill.id, amount: '100' }]);

    const full = (await o.owner.get('/purchases/search?q=reef')).body.data;
    expect(full.vendors).toHaveLength(1);
    expect(full.vendors[0]).toMatchObject({ displayName: 'Reef Hardware', reference: 'VN-1' });
    expect(full.bills).toHaveLength(1);
    expect(full.bills[0]).toMatchObject({
      number: bill.number,
      vendorReference: 'REEF-7788',
      vendorName: 'Reef Hardware',
      total: '100.00',
    });
    expect(full.vendorCredits).toHaveLength(1);
    expect(full.payments).toHaveLength(1);

    const byRef = (await o.owner.get('/purchases/search?q=7788')).body.data;
    expect(byRef.bills).toHaveLength(1);
    expect(byRef.payments).toHaveLength(0);

    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Bills viewer',
      permissionKeys: ['bills.view'],
    });
    expect(role.status).toBe(201);
    const viewer = await joinWithRole(ctx, o.owner, 'Bills viewer');
    const partial = (await viewer.client.get('/purchases/search?q=reef')).body.data;
    expect(partial.bills).toHaveLength(1);
    expect(partial.vendors).toBeUndefined();
    expect(partial.vendorCredits).toBeUndefined();
    expect(partial.payments).toBeUndefined();
  });

  it('needs two characters, a limit in range, and keeps tenants apart', async () => {
    const a = await purchasesOrg();
    const b = await purchasesOrg();
    await postedBill(a, '10', 'SECRET-REF');
    expect((await a.owner.get('/purchases/search?q=x')).status).toBe(400);
    expect((await a.owner.get('/purchases/search?q=reef&limit=99')).status).toBe(400);
    expect((await a.owner.get('/purchases/search?q=secret')).body.data.bills).toHaveLength(1);
    expect((await b.owner.get('/purchases/search?q=secret')).body.data.bills).toHaveLength(0);
  });
});
