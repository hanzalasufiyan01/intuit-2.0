import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 3B step 18: Sales imports (customers, items, AR opening invoices as drafts) and exports
 * (customers, items, invoices, receipts, AR aging) through the S6 registries (Decisions 24, 65).
 * Runs in the serial project (job worker).
 */

let ctx: TestContext;
let org: AccountingOrg;

const csv = (...lines: string[]) => lines.join('\r\n') + '\r\n';

beforeAll(async () => {
  ctx = await createTestContext();
  org = await setUpAccountingOrg(ctx);
  const settings = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'no_tax',
    defaultPaymentTermsDays: 30,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
});
afterAll(() => ctx.close());

async function settle(client: TestClient, path: string, busy: string[]) {
  for (let i = 0; i < 400; i++) {
    const res = await client.get(path);
    if (!busy.includes(res.body.data.status)) return res.body.data;
    await ctx.worker.runOnce();
  }
  return (await client.get(path)).body.data;
}

async function importFile(client: TestClient, domain: string, content: string) {
  const created = await client.post('/imports', { domain, options: {} });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  const up = await client.upload(
    `/files?linkType=import_batch&linkId=${id}`,
    Buffer.from(content),
    'data.csv',
  );
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  const inspected = await client.post(`/imports/${id}/inspect`, {});
  expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
  const mapped = await client.put(`/imports/${id}/mapping`, {
    version: inspected.body.data.batch.version,
    mapping: inspected.body.data.suggestedMapping,
  });
  expect(mapped.status, JSON.stringify(mapped.body)).toBe(202);
  const batch = await settle(client, `/imports/${id}`, ['validating', 'committing']);
  return { id, batch };
}

/** Excludes the error rows (as a user would), revalidates, then commits. */
async function commit(client: TestClient, prepared: { id: string; batch: { version: number } }) {
  let batch = prepared.batch;
  const failing = await client.get(`/imports/${prepared.id}/rows?status=error&limit=500`);
  const rows = (failing.body.data.rows as { rowNumber: number }[]).map((r) => r.rowNumber);
  if (rows.length) {
    const excluded = await client.put(`/imports/${prepared.id}/exclusions`, {
      version: batch.version,
      exclude: rows,
    });
    expect(excluded.status, JSON.stringify(excluded.body)).toBe(202);
    batch = await settle(client, `/imports/${prepared.id}`, ['validating', 'committing']);
  }
  const res = await client.post(`/imports/${prepared.id}/commit`, { version: batch.version });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return settle(client, `/imports/${prepared.id}`, ['validating', 'committing']);
}

async function errors(client: TestClient, id: string) {
  const res = await client.get(`/imports/${id}/rows?status=error&limit=500`);
  return (
    res.body.data.rows as { rowNumber: number; messages: { code: string; field: string }[] }[]
  ).map((r) => [r.rowNumber, r.messages.map((m) => m.field)]);
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
  // The S6 writer quotes every field; the values used here contain no commas or quotes.
  return file.body
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.replace(/"/g, ''));
}

describe('Sales imports (step 18)', () => {
  it('imports customers on new parties, with currency, terms and credit limit', async () => {
    const prepared = await importFile(
      org.owner,
      'customers',
      csv(
        'Kind,Display name,Reference,Email,Currency,Payment terms,Credit limit,Billing line 1,Billing country',
        'organization,Atoll Adventures,CU-1,ops@atoll.test,USD,14,5000,Majeedhee Magu,MV',
        'organization,Lagoon Cafe,CU-2,,,,,,',
        'organization,Bad Terms,CU-3,,,400,,,',
        'organization,Bad Currency,CU-4,,XYZ,,,,',
      ),
    );
    expect(prepared.batch.counts).toMatchObject({ total: 4, valid: 2, error: 2 });
    expect(await errors(org.owner, prepared.id)).toEqual([
      [3, ['payment_terms_days']],
      [4, ['currency']],
    ]);
    const done = await commit(org.owner, prepared);
    expect(done.status).toBe('committed');
    const customers = (await org.owner.get('/customers?search=atoll')).body.data.items;
    expect(customers[0]).toMatchObject({
      displayName: 'Atoll Adventures',
      currencyCode: 'USD',
      paymentTermsDays: 14,
      creditLimit: '5000.00',
    });
    const cafe = (await org.owner.get('/customers?search=lagoon')).body.data.items[0];
    expect(cafe).toMatchObject({ currencyCode: 'MVR', paymentTermsDays: null });
  });

  it('imports items with accounts and tax codes by code', async () => {
    const prepared = await importFile(
      org.owner,
      'sales_items',
      csv(
        'SKU,Name,Type,Unit price,Revenue account,Tax code',
        'DV-1,Discovery dive,service,1200,4100,GST',
        'DV-1,Duplicate,service,10,,',
        'X-9,Bad account,product,5,1110,',
        'X-10,Bad code,product,5,,VAT',
        ',Mask rental,product,75.50,,',
      ),
    );
    expect(await errors(org.owner, prepared.id)).toEqual([
      [1, ['sku']],
      [2, ['sku']],
      [3, ['revenue_account']],
      [4, ['tax_code']],
    ]);
    const done = await commit(org.owner, prepared);
    expect(done.status).toBe('committed');
    const items = (await org.owner.get('/sales/items?search=mask')).body.data.items;
    expect(items[0]).toMatchObject({
      name: 'Mask rental',
      unitPrice: '75.50',
      itemType: 'product',
    });
  });

  it('imports AR opening invoices as drafts, never issued', async () => {
    const conversion = await org.owner.put('/accounting/settings/conversion-date', {
      conversionDate: '2026-01-02',
    });
    expect(conversion.status, JSON.stringify(conversion.body)).toBe(200);
    const prepared = await importFile(
      org.owner,
      'opening_invoices',
      csv(
        'Customer,Invoice date,Open amount,Original invoice number',
        'CU-2,2026-01-01,1250.00,OLD-1042',
        'Lagoon Cafe,2025-12-20,300,OLD-1043',
        'CU-2,2026-01-05,10,OLD-9',
        'Nobody,2026-01-01,10,OLD-10',
        'CU-2,2026-01-01,-5,OLD-11',
      ),
    );
    expect(await errors(org.owner, prepared.id)).toEqual([
      [3, ['invoice_date']],
      [4, ['customer']],
      [5, ['amount']],
    ]);
    const done = await commit(org.owner, prepared);
    expect(done.status).toBe('committed');
    const drafts = (await org.owner.get('/sales/invoices?status=DRAFT&search=OLD-104')).body.data
      .items;
    expect(
      drafts
        .map((d: { kind: string; total: string; reference: string }) => [
          d.kind,
          d.total,
          d.reference,
        ])
        .sort(),
    ).toEqual([
      ['opening', '1250.00', 'OLD-1042'],
      ['opening', '300.00', 'OLD-1043'],
    ]);
  });

  it('needs the target create permission', async () => {
    const member = await joinWithRole(ctx, org.owner, 'Member');
    for (const domain of ['customers', 'sales_items', 'opening_invoices']) {
      const res = await member.client.post('/imports', { domain, options: {} });
      expect(res.status, domain).toBe(403);
    }
  });
});

describe('Sales exports (step 18)', () => {
  it('exports customers, items, invoices, receipts and the AR aging as CSV', async () => {
    const customers = await exportCsv(org.owner, 'customers');
    expect(customers[0]).toBe(
      'kind,display_name,company_name,reference,tin,email,phone,currency,payment_terms_days,credit_limit,status',
    );
    expect(customers.some((l) => l.startsWith('organization,Atoll Adventures,,CU-1'))).toBe(true);
    const items = await exportCsv(org.owner, 'sales_items');
    // Both DV-1 rows were duplicates in the file and excluded; the mask rental was imported.
    expect(items.some((l) => l.startsWith('DV-1'))).toBe(false);
    expect(items.find((l) => l.includes('Mask rental'))).toMatch(
      /^,Mask rental,product,,75\.50*,,,active$/,
    );

    const cafe = (await org.owner.get('/customers?search=lagoon')).body.data.items[0];
    const draft = await org.owner.post('/sales/invoices', {
      customerId: cafe.id,
      invoiceDate: '2026-03-10',
      lines: [{ description: 'Coffee', quantity: '10', unitPrice: '25' }],
    });
    const issued = await org.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
      version: 1,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    await org.owner.post('/sales/receipts', {
      customerId: cafe.id,
      receiptDate: '2026-03-15',
      amount: '100',
      allocations: [{ invoiceId: draft.body.data.id, amount: '100' }],
    });
    const invoices = await exportCsv(org.owner, 'invoices', { status: 'ISSUED' });
    expect(invoices[0]).toContain('number,kind,status,customer');
    expect(invoices.find((l) => l.startsWith(issued.body.data.number))).toContain(
      ',issued,Lagoon Cafe,',
    );
    const receipts = await exportCsv(org.owner, 'receipts');
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toContain(',recorded,Lagoon Cafe,2026-03-15,MVR,100');
    const aging = await exportCsv(org.owner, 'ar_aging', { asOf: '2026-03-31' });
    expect(aging[0]).toBe(
      'customer,document_type,number,date,due_date,days_overdue,bucket,currency,open_amount,open_base',
    );
    expect(aging.find((l) => l.includes(issued.body.data.number))).toContain(',current,MVR,150');
  });

  it('needs the screen view permission', async () => {
    const role = await org.owner.post('/organizations/current/roles', {
      name: 'Customers viewer',
      permissionKeys: ['customers.view'],
    });
    expect(role.status).toBe(201);
    const viewer = await joinWithRole(ctx, org.owner, 'Customers viewer');
    expect((await viewer.client.post('/exports', { domain: 'customers', params: {} })).status).toBe(
      202,
    );
    expect((await viewer.client.post('/exports', { domain: 'invoices', params: {} })).status).toBe(
      403,
    );
    expect(
      (await viewer.client.post('/exports', { domain: 'ar_aging', params: { asOf: '2026-03-31' } }))
        .status,
    ).toBe(403);
  });
});
