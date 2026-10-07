import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 4B (P4-47): Purchases imports through the S6 registries: vendors, the purchase columns of
 * the shared catalog, and AP opening bills and opening vendor credits as drafts that are never
 * posted; plus the direct-expense export and search (Decisions 24, 65). Runs in the serial
 * project (job worker).
 */

let ctx: TestContext;
let org: AccountingOrg;

const csv = (...lines: string[]) => lines.join('\r\n') + '\r\n';

beforeAll(async () => {
  ctx = await createTestContext();
  org = await setUpAccountingOrg(ctx);
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
  return file.body
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.replace(/"/g, ''));
}

describe('Purchases imports (P4-47)', () => {
  it('imports vendors on new parties, with currency, terms, credit limit and account number', async () => {
    const prepared = await importFile(
      org.owner,
      'vendors',
      csv(
        'Kind,Display name,Reference,Email,Currency,Payment terms,Credit limit,Our account number,Billing line 1,Billing country',
        'organization,Reef Hardware,VN-1,ap@reef.test,,14,5000,ACC-9,Majeedhee Magu,MV',
        'organization,Atoll Marine,VN-2,,USD,,,,,',
        'organization,Bad Terms,VN-3,,,400,,,,',
        'organization,Bad Currency,VN-4,,XYZ,,,,,',
      ),
    );
    expect(prepared.batch.counts).toMatchObject({ total: 4, valid: 2, error: 2 });
    expect(await errors(org.owner, prepared.id)).toEqual([
      [3, ['payment_terms_days']],
      [4, ['currency']],
    ]);
    const done = await commit(org.owner, prepared);
    expect(done.status).toBe('committed');
    const reef = (await org.owner.get('/vendors?search=reef')).body.data.items[0];
    expect(reef).toMatchObject({
      displayName: 'Reef Hardware',
      currencyCode: 'MVR',
      paymentTermsDays: 14,
      creditLimit: '5000.00',
      accountNumber: 'ACC-9',
    });
    const marine = (await org.owner.get('/vendors?search=marine')).body.data.items[0];
    expect(marine).toMatchObject({ currencyCode: 'USD', paymentTermsDays: null });
  });

  it('imports the purchase columns of the shared catalog', async () => {
    const prepared = await importFile(
      org.owner,
      'sales_items',
      csv(
        'SKU,Name,Type,Unit price,Purchased,Purchase cost,Expense account,Purchase tax code,Purchase tax recoverable',
        'HW-1,Marine paint,product,90,yes,55.50,5400,GST,yes',
        'HW-2,Sales only,product,10,,,,,',
        'HW-3,Bad account,product,5,yes,3,1110,,',
        'HW-4,Bad flag,product,5,maybe,,,,',
      ),
    );
    expect(await errors(org.owner, prepared.id)).toEqual([
      [3, ['expense_account']],
      [4, ['is_purchased']],
    ]);
    const done = await commit(org.owner, prepared);
    expect(done.status).toBe('committed');
    const paint = (await org.owner.get('/sales/items?search=paint')).body.data.items[0];
    expect(paint).toMatchObject({
      name: 'Marine paint',
      isPurchased: true,
      purchaseUnitCost: '55.50',
      purchaseTaxRecoverable: true,
    });
    const salesOnly = (await org.owner.get('/sales/items?search=sales%20only')).body.data.items[0];
    expect(salesOnly).toMatchObject({ isPurchased: false });
  });

  it('imports AP opening bills and credits as drafts, never posted', async () => {
    const conversion = await org.owner.put('/accounting/settings/conversion-date', {
      conversionDate: '2026-01-02',
    });
    expect(conversion.status, JSON.stringify(conversion.body)).toBe(200);
    const bills = await importFile(
      org.owner,
      'opening_bills',
      csv(
        'Vendor,Bill date,Open amount,Supplier invoice number,Carrying value',
        'VN-1,2026-01-01,1250.00,OLD-1042,',
        'Reef Hardware,2025-12-20,300,OLD-1043,',
        'VN-1,2026-01-05,10,OLD-9,',
        'Nobody,2026-01-01,10,OLD-10,',
        'VN-1,2026-01-01,-5,OLD-11,',
        'VN-2,2025-12-31,1000,OLD-12,15400',
        'VN-1,2026-01-01,10,OLD-13,99',
      ),
    );
    expect(await errors(org.owner, bills.id)).toEqual([
      [3, ['date']],
      [4, ['vendor']],
      [5, ['amount']],
      [7, ['carrying_value']],
    ]);
    const done = await commit(org.owner, bills);
    expect(done.status).toBe('committed');
    const drafts = (await org.owner.get('/purchases/bills?status=DRAFT&limit=50')).body.data.items;
    expect(
      drafts
        .map((d: { kind: string; total: string; vendorReference: string }) => [
          d.kind,
          d.total,
          d.vendorReference,
        ])
        .sort(),
    ).toEqual([
      ['opening', '1000.00', 'OLD-12'],
      ['opening', '1250.00', 'OLD-1042'],
      ['opening', '300.00', 'OLD-1043'],
    ]);
    const foreign = drafts.find((d: { vendorReference: string }) => d.vendorReference === 'OLD-12');
    const detail = (await org.owner.get(`/purchases/bills/${foreign.id}`)).body.data;
    expect(detail).toMatchObject({ currencyCode: 'USD', openingBaseTotal: '15400.0000' });

    const credits = await importFile(
      org.owner,
      'opening_vendor_credits',
      csv(
        'Vendor,Credit date,Credit amount,Supplier credit-note number',
        'VN-1,2025-12-31,75.00,CN-77',
        'VN-1,2026-03-01,5,CN-78',
      ),
    );
    expect(await errors(org.owner, credits.id)).toEqual([[2, ['date']]]);
    expect((await commit(org.owner, credits)).status).toBe('committed');
    const draftCredits = (await org.owner.get('/purchases/vendor-credits?status=DRAFT')).body.data
      .items;
    expect(draftCredits).toHaveLength(1);
    expect(draftCredits[0]).toMatchObject({
      kind: 'opening',
      origin: 'supplier_credit_note',
      total: '75.00',
      status: 'DRAFT',
    });
    // Nothing was posted: no AP journal exists.
    const posted = (await org.owner.get('/purchases/bills?status=POSTED')).body.data.items;
    expect(posted).toHaveLength(0);
  });

  it('needs the target create permission', async () => {
    const member = await joinWithRole(ctx, org.owner, 'Member');
    for (const domain of ['vendors', 'opening_bills', 'opening_vendor_credits']) {
      const res = await member.client.post('/imports', { domain, options: {} });
      expect(res.status, domain).toBe(403);
    }
  });
});

describe('Expenses export and search', () => {
  it('exports expenses and finds them in the Purchases search', async () => {
    const vendor = (await org.owner.get('/vendors?search=reef')).body.data.items[0];
    const draft = await org.owner.post('/purchases/expenses', {
      vendorId: vendor.id,
      expenseDate: '2026-03-10',
      vendorReference: 'RCPT-88',
      lines: [{ description: 'Taxi', quantity: '1', unitPrice: '40', taxCodeId: null }],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const posted = await org.owner.post(`/purchases/expenses/${draft.body.data.id}/post`, {
      version: draft.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const rows = await exportCsv(org.owner, 'expenses');
    expect(rows[0]).toContain('number,status,payee,receipt_number,expense_date,currency');
    expect(rows[1]).toContain('EXP-00001,posted,Reef Hardware,RCPT-88,2026-03-10,MVR,40');
    expect(rows[1]).toContain(',1120,');
    const found = (await org.owner.get('/purchases/search?q=RCPT-88')).body.data;
    expect(found.expenses).toHaveLength(1);
    expect(found.expenses[0]).toMatchObject({ number: 'EXP-00001', total: '40.00' });
    const viewer = await joinWithRole(ctx, org.owner, 'Member');
    // Members hold expenses.view (P4-40): the section and the export are theirs to see.
    expect(
      (await viewer.client.get('/purchases/search?q=RCPT-88')).body.data.expenses,
    ).toHaveLength(1);
    expect((await viewer.client.post('/exports', { domain: 'expenses', params: {} })).status).toBe(
      202,
    );
  });
});
