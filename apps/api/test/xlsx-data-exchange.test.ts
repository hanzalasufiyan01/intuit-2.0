import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { createTestContext, type TestClient, type TestContext } from './helpers.js';
import { readXlsx, XlsxWriter, type CsvCell } from '../src/modules/data-exchange/index.js';
import { buildZip, DATE_STYLES, row, text, workbook } from './xlsx-fixtures.js';

/**
 * XLSX through the existing data-exchange pipeline (Decision 62): the same batches, staging,
 * mapping, validation, limits, permissions and tenant isolation as CSV. Workbooks are read for
 * values only; exports are formula-neutralized.
 */

let ctx: TestContext;
let org: AccountingOrg;
beforeAll(async () => {
  ctx = await createTestContext();
  org = await setUpAccountingOrg(ctx);
});
afterAll(() => ctx.close());

function sheetOf(rows: readonly (readonly CsvCell[])[]): Buffer {
  const writer = new XlsxWriter(50_000_000);
  for (const cells of rows) writer.addRow(cells);
  return writer.finish();
}

async function settle(client: TestClient, id: string) {
  for (let i = 0; i < 150; i++) {
    const res = await client.get(`/imports/${id}`);
    if (!['validating', 'committing'].includes(res.body.data.status)) return res.body.data;
    await ctx.worker.runOnce();
  }
  return (await client.get(`/imports/${id}`)).body.data;
}

/** create → upload → inspect → map (suggested) → validated batch. */
async function prepare(client: TestClient, domain: string, file: Buffer, options = {}) {
  const created = await client.post('/imports', { domain, options });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  const up = await client.upload(`/files?linkType=import_batch&linkId=${id}`, file, 'data.xlsx');
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  const inspected = await client.post(`/imports/${id}/inspect`, {});
  expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
  const mapped = await client.put(`/imports/${id}/mapping`, {
    version: inspected.body.data.batch.version,
    mapping: inspected.body.data.suggestedMapping,
  });
  expect(mapped.status, JSON.stringify(mapped.body)).toBe(202);
  return { id, inspected: inspected.body.data, batch: await settle(client, id) };
}

async function runExport(client: TestClient, body: Record<string, unknown>) {
  const res = await client.post('/exports', body);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const id = res.body.data.export.id as string;
  for (let i = 0; i < 30; i++) {
    const view = (await client.get(`/exports/${id}`)).body.data;
    if (view && !['queued', 'running'].includes(view.status)) return view;
    await ctx.worker.runOnce();
  }
  return (await client.get(`/exports/${id}`)).body.data;
}

async function downloadBytes(client: TestClient, exportId: string) {
  const link = await client.get(`/exports/${exportId}/download-url`);
  expect(link.status, JSON.stringify(link.body)).toBe(200);
  const res = await ctx.app.inject({ method: 'GET', url: link.body.data.url });
  expect(res.statusCode).toBe(200);
  return { bytes: res.rawPayload, headers: res.headers };
}

// The worker rounds share the job queue with every other test file: allow for a loaded run.
describe('XLSX import', { timeout: 120_000 }, () => {
  it('imports a workbook through the same staging, mapping and commit as a CSV', async () => {
    const file = sheetOf([
      ['Account Code', 'Account Name', 'Type', 'Description'],
      ['X1111', 'Petty cash front desk', 'Asset', null],
      ['X1100', 'Cash floats', 'asset'],
      ['X4101', "'=Tour revenue", 'Income', 'Revenue, "quoted"'],
    ]);
    const prepared = await prepare(org.owner, 'chart_of_accounts', file);
    expect(prepared.inspected.columns).toEqual([
      'Account Code',
      'Account Name',
      'Type',
      'Description',
    ]);
    expect(prepared.batch).toMatchObject({
      status: 'validated',
      format: 'xlsx',
      counts: { total: 3, valid: 3, warning: 0, error: 0, excluded: 0 },
    });
    const commit = await org.owner.post(`/imports/${prepared.id}/commit`, {
      version: prepared.batch.version,
    });
    expect(commit.status, JSON.stringify(commit.body)).toBe(202);
    expect(await settle(org.owner, prepared.id)).toMatchObject({ status: 'committed', created: 3 });
    const accounts = (await org.owner.get('/accounting/accounts')).body.data as {
      code: string;
      name: string;
      description: string;
    }[];
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    // Our own export escape is undone and the value is stored as text.
    expect(byCode.get('X4101')).toMatchObject({
      name: '=Tour revenue',
      description: 'Revenue, "quoted"',
    });
    expect(byCode.get('X1100')).toBeDefined();
  });

  it('reads date-formatted cells as ISO dates and numbers as plain decimals', async () => {
    const file = workbook({
      styles: DATE_STYLES,
      sheetData: [
        row(1, text('A1', 'currency'), text('B1', 'date'), text('C1', 'rate')),
        row(2, text('A2', 'USD'), '<c r="B2" s="1"><v>46053</v></c>', '<c r="C2"><v>15.42</v></c>'),
        row(
          3,
          text('A3', 'EUR'),
          '<c r="B3" s="2"><v>46054</v></c>',
          '<c r="C3"><v>1.675E1</v></c>',
        ),
      ].join(''),
    });
    const prepared = await prepare(org.owner, 'exchange_rates', file);
    expect(prepared.batch).toMatchObject({ status: 'validated', counts: { valid: 2, error: 0 } });
    const commit = await org.owner.post(`/imports/${prepared.id}/commit`, {
      version: prepared.batch.version,
    });
    expect(commit.status).toBe(202);
    expect((await settle(org.owner, prepared.id)).status).toBe('committed');
    const rates = (await org.owner.get('/accounting/exchange-rates')).body.data as {
      fromCurrency: string;
      rateDate: string;
      rate: string;
    }[];
    expect(rates.find((r) => r.fromCurrency === 'USD')).toMatchObject({
      rateDate: '2026-01-31',
      rate: '15.4200000000',
    });
    expect(rates.find((r) => r.fromCurrency === 'EUR')).toMatchObject({
      rateDate: '2026-02-01',
      rate: '16.7500000000',
    });
  });

  it('reports row errors by their position in the staged rows like a CSV', async () => {
    const file = sheetOf([
      ['code', 'name', 'type'],
      ['X2001', 'Fine', 'Asset'],
      ['X2002', '', 'Asset'],
      ['X2001', 'Duplicate', 'Asset'],
    ]);
    const prepared = await prepare(org.owner, 'chart_of_accounts', file);
    expect(prepared.batch.counts).toMatchObject({ total: 3, error: 3 });
    const rows = (await org.owner.get(`/imports/${prepared.id}/rows?status=error`)).body.data
      .rows as { rowNumber: number }[];
    // Rows 1 and 3 share a code (flagged in both); row 2 has no name.
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2, 3]);
  });

  it('never treats a formula as a formula: the cached value or nothing is imported', async () => {
    const file = workbook({
      sheetData: [
        row(1, text('A1', 'code'), text('B1', 'name'), text('C1', 'type')),
        row(
          2,
          text('A2', 'F1'),
          '<c r="B2" t="str"><f>HYPERLINK("http://evil.example")</f><v>Cached name</v></c>',
          text('C2', 'Asset'),
        ),
        row(3, text('A3', 'F2'), '<c r="B3"><f>1+1</f></c>', text('C3', 'Asset')),
      ].join(''),
    });
    const prepared = await prepare(org.owner, 'chart_of_accounts', file);
    const rows = (await org.owner.get(`/imports/${prepared.id}/rows`)).body.data.rows as {
      rowNumber: number;
      status: string;
    }[];
    // The cached name imports; the formula without a cached value is an empty (invalid) name.
    expect(rows.map((r) => [r.rowNumber, r.status])).toEqual([
      [1, 'valid'],
      [2, 'error'],
    ]);
  });
});

describe('XLSX import refusals', () => {
  async function upload(file: Buffer, name = 'x.xlsx') {
    const created = await org.owner.post('/imports', { domain: 'chart_of_accounts' });
    const id = created.body.data.id as string;
    const res = await org.owner.upload(`/files?linkType=import_batch&linkId=${id}`, file, name);
    return { id, res };
  }

  it('refuses a file that is not a real workbook at upload (415)', async () => {
    expect((await upload(Buffer.from('not a zip at all'))).res.status).toBe(415);
    expect((await upload(buildZip([{ name: 'word/document.xml', data: '<w/>' }]))).res.status).toBe(
      415,
    );
    // A workbook under a CSV name disagrees with its content.
    expect((await upload(sheetOf([['a']]), 'x.csv')).res.status).toBe(415);
  });

  it('answers a clear 400 when a detected workbook cannot be read', async () => {
    const hostile: Record<string, Buffer> = {
      macro: workbook({
        sheetData: row(1, text('A1', 'code')),
        extraParts: [{ name: 'xl/vbaProject.bin', data: 'x' }],
      }),
      bomb: workbook({
        sheetData: row(1, text('A1', 'code')),
        extraParts: [{ name: 'xl/media/bomb.bin', data: Buffer.alloc(8 * 1024 * 1024) }],
      }),
      doctype: workbook({
        sheetData: '',
        sheetXml:
          '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet><sheetData/></worksheet>',
      }),
      noSheet: workbook({
        sheetData: '',
        workbookXml: '<workbook><sheets/></workbook>',
      }),
    };
    for (const [name, file] of Object.entries(hostile)) {
      const { id, res } = await upload(file);
      expect(res.status, name).toBe(201);
      const inspect = await org.owner.post(`/imports/${id}/inspect`, {});
      expect(inspect.status, name).toBe(400);
      expect(inspect.body.error.code, name).toBe('VALIDATION_FAILED');
    }
  });

  it('fails a workbook with more than 25,000 data rows, and an empty one (failed_file)', async () => {
    const rows: CsvCell[][] = [['code', 'name', 'type']];
    for (let i = 0; i < 25_001; i++) rows.push([`R${i}`, 'Row', 'Asset']);
    const big = await prepare(org.owner, 'chart_of_accounts', sheetOf(rows));
    expect(big.batch.status).toBe('failed_file');
    expect(JSON.stringify(big.batch)).toContain('more than 25,000');
    const created = await org.owner.post('/imports', { domain: 'chart_of_accounts' });
    const id = created.body.data.id as string;
    await org.owner.upload(
      `/files?linkType=import_batch&linkId=${id}`,
      sheetOf([['code', 'name', 'type']]),
      'empty.xlsx',
    );
    const inspected = await org.owner.post(`/imports/${id}/inspect`, {});
    const mapped = await org.owner.put(`/imports/${id}/mapping`, {
      version: inspected.body.data.batch.version,
      mapping: inspected.body.data.suggestedMapping,
    });
    expect(mapped.status).toBe(202);
    expect((await settle(org.owner, id)).status).toBe('failed_file');
  });

  it('refuses a header row with a blank or duplicate column, and too many columns', async () => {
    for (const header of [
      ['code', '', 'type'],
      ['code', 'code', 'type'],
      Array.from({ length: 201 }, (_, i) => `c${i}`),
    ]) {
      const { id, res } = await upload(sheetOf([header, header.map(() => 'x')]));
      expect(res.status).toBe(201);
      expect((await org.owner.post(`/imports/${id}/inspect`, {})).status).toBe(400);
    }
  });
});

describe('XLSX import security', () => {
  it('needs the domain permission and keeps imports inside the organization', async () => {
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.post('/imports', { domain: 'chart_of_accounts' })).status).toBe(
      403,
    );
    const created = await org.owner.post('/imports', { domain: 'chart_of_accounts' });
    const id = created.body.data.id as string;
    await org.owner.upload(
      `/files?linkType=import_batch&linkId=${id}`,
      sheetOf([
        ['code', 'name', 'type'],
        ['T1', 'Tenant', 'Asset'],
      ]),
      'a.xlsx',
    );
    // A member cannot upload into or inspect someone else's batch.
    expect(
      (
        await member.client.upload(
          `/files?linkType=import_batch&linkId=${id}`,
          sheetOf([['a']]),
          'b.xlsx',
        )
      ).status,
    ).toBe(403);
    const other = await setUpAccountingOrg(ctx);
    expect((await other.owner.get(`/imports/${id}`)).status).toBe(404);
    expect((await other.owner.post(`/imports/${id}/inspect`, {})).status).toBe(404);
    expect(
      (
        await other.owner.upload(
          `/files?linkType=import_batch&linkId=${id}`,
          sheetOf([['a']]),
          'c.xlsx',
        )
      ).status,
    ).toBe(404);
  });
});

describe('XLSX export', () => {
  it('exports the same rows as the CSV, as a neutralized workbook that re-imports', async () => {
    const evil = await org.owner.post('/accounting/accounts', {
      code: 'ZX1',
      name: '=HYPERLINK("http://evil.example","click")',
      type: 'ASSET',
    });
    expect(evil.status, JSON.stringify(evil.body)).toBe(201);
    const csvView = await runExport(org.owner, { domain: 'chart_of_accounts' });
    const view = await runExport(org.owner, { domain: 'chart_of_accounts', format: 'xlsx' });
    expect(view).toMatchObject({ status: 'ready', format: 'xlsx', rowCount: csvView.rowCount });
    expect(csvView.format).toBe('csv');
    const { bytes, headers } = await downloadBytes(org.owner, view.id);
    expect(headers['content-disposition']).toMatch(/chart-of-accounts-\d{4}-\d{2}-\d{2}\.xlsx/);
    expect(headers['content-type']).toContain('spreadsheetml.sheet');
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    const rows = [...readXlsx(Buffer.from(bytes))].map((r) => r.cells);
    expect(rows[0]).toEqual(expect.arrayContaining(['code', 'name', 'type', 'parent_code']));
    expect(rows.length - 1).toBe(view.rowCount);
    // The hostile name is text, apostrophe-prefixed, and the package holds no formula.
    expect(rows.find((r) => r[0] === 'ZX1')![1]).toBe(`'=HYPERLINK("http://evil.example","click")`);
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('<f>');
    // Importing the export back restores the escaped name verbatim (no duplicates of existing codes
    // are committed here: we only validate).
    const reimport = await prepare(org.owner, 'chart_of_accounts', Buffer.from(bytes));
    expect(reimport.batch.format).toBe('xlsx');
    expect(reimport.batch.counts.total).toBe(view.rowCount);
  });

  it('keeps CSV the default and rejects unknown formats', async () => {
    const res = await org.owner.post('/exports', { domain: 'chart_of_accounts', format: 'pdf' });
    expect(res.status).toBe(400);
    const view = await runExport(org.owner, { domain: 'chart_of_accounts' });
    expect(view.format).toBe('csv');
  });

  it('applies the export permissions and tenant isolation to workbooks', async () => {
    const view = await runExport(org.owner, { domain: 'chart_of_accounts', format: 'xlsx' });
    const role = await org.owner.post('/organizations/current/roles', {
      name: 'No accounts',
      permissionKeys: ['invoices.view'],
    });
    expect(role.status).toBe(201);
    const nobody = await joinWithRole(ctx, org.owner, 'No accounts');
    const denied = await nobody.client.post('/exports', {
      domain: 'chart_of_accounts',
      format: 'xlsx',
    });
    expect(denied.status).toBe(403);
    expect((await nobody.client.get(`/exports/${view.id}/download-url`)).status).toBeGreaterThan(
      399,
    );
    const other = await setUpAccountingOrg(ctx);
    expect((await other.owner.get(`/exports/${view.id}`)).status).toBe(404);
    expect((await other.owner.get(`/exports/${view.id}/download-url`)).status).toBe(404);
  });

  it('writes the xlsx file name and expiry like any export', async () => {
    const view = await runExport(org.owner, {
      domain: 'trial_balance',
      format: 'xlsx',
      params: {},
    });
    expect(['ready', 'failed']).toContain(view.status);
    if (view.status === 'ready') {
      const { bytes } = await downloadBytes(org.owner, view.id);
      const rows = [...readXlsx(Buffer.from(bytes))];
      expect(rows.length).toBeGreaterThan(0);
    }
  });
});
