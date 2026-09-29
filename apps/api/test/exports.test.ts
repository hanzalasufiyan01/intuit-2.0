import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCsv } from '../src/modules/data-exchange/index.js';
import {
  cashSale,
  joinWithRole,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 3A S6 exports: every export domain, formula neutralization, the 25 MB cap (L-5),
 * access re-checks on every read and download (correction 3), expiry, audit (L-12), round trip.
 */

let ctx: TestContext;
let org: AccountingOrg;

async function ownerSql(text: string, params: unknown[] = []) {
  const owner = await connectAs('owner');
  try {
    return await owner.query(text, params);
  } finally {
    await owner.end();
  }
}

/** Creates an export, runs the worker until it is ready or failed, returns its view. */
async function runExport(client: TestClient, domain: string, params: Record<string, unknown> = {}) {
  const res = await client.post('/exports', { domain, params });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const id = res.body.data.export.id as string;
  for (let i = 0; i < 30; i++) {
    const view = (await client.get(`/exports/${id}`)).body.data;
    if (view && !['queued', 'running'].includes(view.status)) return view;
    await ctx.worker.runOnce();
  }
  return (await client.get(`/exports/${id}`)).body.data;
}

/** Downloads a ready export through its signed link and parses the CSV. */
async function download(client: TestClient, exportId: string) {
  const link = await client.get(`/exports/${exportId}/download-url`);
  expect(link.status, JSON.stringify(link.body)).toBe(200);
  const res = await ctx.app.inject({ method: 'GET', url: link.body.data.url });
  expect(res.statusCode).toBe(200);
  const text = res.body;
  const rows: string[][] = [];
  const source = (async function* () {
    yield text;
  })();
  for await (const r of readCsv(source, {
    delimiter: ',',
    maxColumns: 500,
    maxRecordChars: 1_000_000,
  })) {
    rows.push(r.cells);
  }
  return { text, rows, headers: res.headers };
}

/** A member whose custom role lacks accounting.dimensions.view. */
async function noDimensionsUser(permissionKeys: string[]) {
  const role = await org.owner.post('/organizations/current/roles', {
    name: `No dimensions ${randomUUID().slice(0, 6)}`,
    permissionKeys,
  });
  expect(role.status).toBe(201);
  return (await joinWithRole(ctx, org.owner, role.body.data.name)).client;
}

beforeAll(async () => {
  ctx = await createTestContext();
  org = await setUpAccountingOrg(ctx);
  await postJournal(org, cashSale(org, '100.00', '2026-03-15'));
  await postJournal(org, cashSale(org, '40.50', '2026-04-02'));
});
afterAll(() => ctx.close());

describe('list exports', () => {
  it('exports the chart of accounts with import-compatible columns, UTF-8 BOM and CRLF', async () => {
    const view = await runExport(org.owner, 'chart_of_accounts');
    expect(view).toMatchObject({
      status: 'ready',
      rowCount: expect.any(Number),
      fileId: expect.any(String),
    });
    const { text, rows, headers } = await download(org.owner, view.id);
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toContain('\r\n');
    expect(headers['content-disposition']).toMatch(/chart-of-accounts-\d{4}-\d{2}-\d{2}\.csv/);
    expect(rows[0]).toEqual([
      'code',
      'name',
      'type',
      'parent_code',
      'currency',
      'subtype',
      'is_monetary',
      'description',
      'status',
      'is_control_account',
    ]);
    const cash = rows.find((r) => r[0] === '1110')!;
    expect(cash.slice(0, 3)).toEqual(['1110', 'Cash on Hand', 'asset']);
    expect(rows.length - 1).toBe(view.rowCount);
  });

  it('round-trips: an exported chart imports into another organization', async () => {
    const view = await runExport(org.owner, 'chart_of_accounts');
    const { text } = await download(org.owner, view.id);
    const target = await setUpAccountingOrg(ctx, { templateKey: 'custom', fiscalYear: false });
    const created = await target.owner.post('/imports', { domain: 'chart_of_accounts' });
    const id = created.body.data.id;
    await target.owner.upload(
      `/files?linkType=import_batch&linkId=${id}`,
      Buffer.from(text),
      'coa.csv',
    );
    const inspected = await target.owner.post(`/imports/${id}/inspect`, {});
    expect(inspected.body.data.suggestedMapping).toMatchObject({
      code: 0,
      name: 1,
      type: 2,
      parent_code: 3,
    });
    await target.owner.put(`/imports/${id}/mapping`, {
      version: inspected.body.data.batch.version,
      mapping: inspected.body.data.suggestedMapping,
    });
    let batch = (await target.owner.get(`/imports/${id}`)).body.data;
    for (let i = 0; i < 20 && batch.status === 'validating'; i++) {
      await ctx.worker.runOnce();
      batch = (await target.owner.get(`/imports/${id}`)).body.data;
    }
    expect(batch.counts.error).toBe(0);
    await target.owner.post(`/imports/${id}/commit`, { version: batch.version });
    for (let i = 0; i < 20 && batch.status !== 'committed'; i++) {
      await ctx.worker.runOnce();
      batch = (await target.owner.get(`/imports/${id}`)).body.data;
    }
    expect(batch.status).toBe('committed');
    const source = (await org.owner.get('/accounting/accounts')).body.data as any[];
    const copied = (await target.owner.get('/accounting/accounts')).body.data as any[];
    const shape = (a: any, all: any[]) => [
      a.code,
      a.name,
      a.type,
      a.subtype,
      all.find((p) => p.id === a.parentId)?.code ?? null,
    ];
    expect(copied.map((a) => shape(a, copied)).sort()).toEqual(
      source.map((a) => shape(a, source)).sort(),
    );
  });

  it('neutralizes formulas in exported text (Decision 24) and exports contact persons', async () => {
    const party = await org.owner.post('/parties', {
      kind: 'organization',
      displayName: '=HYPERLINK("http://evil.test","Click")',
      reference: 'EVIL',
      contacts: [{ firstName: '@SUM(A1)', isPrimary: true }],
    });
    expect(party.status).toBe(201);
    const parties = await runExport(org.owner, 'parties');
    const { text, rows } = await download(org.owner, parties.id);
    expect(text).toContain(`"'=HYPERLINK(""http://evil.test"",""Click"")"`);
    const row = rows.find((r) => r[5] === 'EVIL')!;
    expect(row[1]).toBe(`'=HYPERLINK("http://evil.test","Click")`);
    const contacts = await runExport(org.owner, 'parties', { layout: 'contacts' });
    const contactRows = (await download(org.owner, contacts.id)).rows;
    expect(contactRows[0]).toEqual([
      'party_reference',
      'party_display_name',
      'first_name',
      'last_name',
      'job_title',
      'email',
      'phone',
      'mobile',
      'is_primary',
      'receives_documents',
    ]);
    expect(contactRows.find((r) => r[0] === 'EVIL')![2]).toBe(`'@SUM(A1)`);
  });

  it('exports journals, with dimension columns only when requested and permitted', async () => {
    const type = await org.owner.post('/accounting/dimensions', {
      code: 'DEPT',
      name: 'Department',
    });
    const value = await org.owner.post(`/accounting/dimensions/${type.body.data.id}/values`, {
      code: 'OPS',
      name: 'Operations',
    });
    const body = cashSale(org, '12.00', '2026-05-01');
    body.lines[0] = {
      ...body.lines[0]!,
      dimensions: [{ dimensionTypeId: type.body.data.id, dimensionValueId: value.body.data.id }],
    } as never;
    await postJournal(org, body);
    const plain = await runExport(org.owner, 'journals', { statuses: ['POSTED'] });
    const plainRows = (await download(org.owner, plain.id)).rows;
    expect(plainRows[0]).not.toContain('Department');
    const withDims = await runExport(org.owner, 'journals', {
      statuses: ['POSTED'],
      includeDimensions: true,
    });
    const dimRows = (await download(org.owner, withDims.id)).rows;
    const col = dimRows[0]!.indexOf('Department');
    expect(col).toBeGreaterThan(0);
    expect(dimRows.some((r) => r[col] === 'OPS')).toBe(true);
    // Without accounting.dimensions.view nobody can ask for dimension data (Decision 91).
    const reader = await noDimensionsUser(['accounting.journals.view']);
    const denied = await reader.post('/exports', {
      domain: 'journals',
      params: { includeDimensions: true },
    });
    expect(denied.status).toBe(403);
    expect((await reader.post('/exports', { domain: 'journals', params: {} })).status).toBe(202);
  });
});

describe('ledger and statements (report layout)', () => {
  it('exports an account ledger with opening balance, running balance and totals', async () => {
    const account = ((await org.owner.get('/accounting/accounts')).body.data as any[]).find(
      (a) => a.code === '1110',
    );
    const view = await runExport(org.owner, 'general_ledger', {
      accountId: account.id,
      fromDate: '2026-04-01',
      toDate: '2026-12-31',
    });
    expect(view.status).toBe('ready');
    const { rows } = await download(org.owner, view.id);
    expect(rows[0]).toEqual(['Organization', expect.any(String)]);
    expect(rows[1]).toEqual(['Report', 'General ledger']);
    const header = rows.findIndex((r) => r[0] === 'date');
    expect(rows[header]).toContain('running_balance');
    const opening = rows[header + 1]!;
    expect(opening[2]).toBe('Opening balance');
    expect(opening.at(-1)).toBe('100.0000');
    expect(opening[2]).toBe('Opening balance');
    const firstLine = rows[header + 2]!;
    expect(firstLine[0]).toBe('2026-04-02');
    expect(firstLine.at(-1)).toBe('140.5000');
  });

  it('exports the Trial Balance, P&L and Balance Sheet with preamble and totals', async () => {
    const retained = ((await org.owner.get('/accounting/accounts')).body.data as any[]).find(
      (a) => a.code === '3200',
    );
    const designated = await org.owner.put('/accounting/designations', {
      RETAINED_EARNINGS: retained.id,
    });
    expect(designated.status, JSON.stringify(designated.body)).toBe(200);
    const tb = await runExport(org.owner, 'trial_balance', {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    const tbRows = (await download(org.owner, tb.id)).rows;
    expect(tbRows[1]).toEqual(['Report', 'Trial Balance']);
    expect(tbRows.find((r) => r[0] === 'Period')).toEqual(['Period', '2026-01-01 to 2026-12-31']);
    const head = tbRows.findIndex((r) => r[0] === 'section');
    expect(tbRows[head]).toEqual([
      'section',
      'code',
      'name',
      'level',
      'Opening debit',
      'Opening credit',
      'Period debit',
      'Period credit',
      'Closing debit',
      'Closing credit',
    ]);
    const total = tbRows.find((r) => r[2] === 'Total')!;
    expect(total[6]).toBe(total[7]); // period debits = credits

    const pl = await runExport(org.owner, 'profit_and_loss', {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(pl.status).toBe('ready');
    const plRows = (await download(org.owner, pl.id)).rows;
    expect(plRows.some((r) => r[2] === 'Net Profit (Loss)')).toBe(true);

    const bs = await runExport(org.owner, 'balance_sheet', { asOf: '2026-12-31' });
    expect(bs.status).toBe('ready');
    const bsRows = (await download(org.owner, bs.id)).rows;
    expect(bsRows.find((r) => r[0] === 'As of')).toEqual(['As of', 'As of 2026-12-31']);

    // Without the designation the export fails with the report's own message (S3-06).
    await org.owner.put('/accounting/designations', { RETAINED_EARNINGS: null });
    const failed = await runExport(org.owner, 'balance_sheet', { asOf: '2026-12-31' });
    expect(failed).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/Retained Earnings/),
    });
    await org.owner.put('/accounting/designations', { RETAINED_EARNINGS: retained.id });
  });

  it('labels dimension-filtered statements as tagged activity only (Decision 4)', async () => {
    const dims = (await org.owner.get('/accounting/dimensions')).body.data as any[];
    const ops = dims.find((d) => d.code === 'DEPT').values.find((v: any) => v.code === 'OPS');
    const tb = await runExport(org.owner, 'trial_balance', {
      from: '2026-01-01',
      to: '2026-12-31',
      dimensionValueIds: ops.id,
    });
    const rows = (await download(org.owner, tb.id)).rows;
    expect(rows.find((r) => r[0] === 'Dimension filter')![1]).toBe(
      'Department: Operations (tagged activity only)',
    );
    // Filtering by dimension needs accounting.dimensions.view, at creation and on every access.
    const viewer = await noDimensionsUser(['accounting.reports.view']);
    const denied = await viewer.post('/exports', {
      domain: 'trial_balance',
      params: { dimensionValueIds: ops.id },
    });
    expect(denied.status).toBe(403);
  });
});

describe('limits, access and lifecycle', () => {
  it('fails an export beyond the size cap with a clear message (L-5)', async () => {
    const small = await createTestContext({ EXPORT_MAX_BYTES: '300' });
    try {
      const o = await setUpAccountingOrg(small, { fiscalYear: false });
      const res = await o.owner.post('/exports', { domain: 'chart_of_accounts', params: {} });
      let view = res.body.data.export;
      for (let i = 0; i < 20 && ['queued', 'running'].includes(view.status); i++) {
        await small.worker.runOnce();
        view = (await o.owner.get(`/exports/${view.id}`)).body.data;
      }
      expect(view).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/larger than/),
        fileId: null,
      });
    } finally {
      await small.close();
    }
  });

  it('re-checks the current permission on every read and download (correction 3)', async () => {
    const roles = await org.owner.post('/organizations/current/roles', {
      name: `Exporter ${randomUUID().slice(0, 6)}`,
      permissionKeys: ['accounting.accounts.view'],
    });
    const exporter = await joinWithRole(ctx, org.owner, roles.body.data.name);
    const view = await runExport(exporter.client, 'chart_of_accounts');
    expect(view.status).toBe('ready');
    const link = await exporter.client.get(`/exports/${view.id}/download-url`);
    expect(link.status).toBe(200);
    await org.owner.put(`/organizations/current/roles/${roles.body.data.id}`, {
      name: roles.body.data.name,
      permissionKeys: ['organization.read'],
    });
    expect((await exporter.client.get(`/exports/${view.id}`)).status).toBe(403);
    expect((await exporter.client.get(`/exports/${view.id}/download-url`)).status).toBe(403);
    expect((await exporter.client.get(`/files/${view.fileId}/download-url`)).status).toBe(403);
    expect(
      (await exporter.client.get('/exports')).body.data.some((e: any) => e.id === view.id),
    ).toBe(false);
    // Other tenants never see it.
    const other = await setUpAccountingOrg(ctx, { fiscalYear: false });
    expect((await other.owner.get(`/exports/${view.id}`)).status).toBe(404);
    expect((await other.owner.get(`/files/${view.fileId}/download-url`)).status).toBe(404);
  });

  it('audits generation but not downloads (L-12), and expires exports after their lifetime', async () => {
    const view = await runExport(org.owner, 'dimension_values');
    await download(org.owner, view.id);
    const audit = await ownerSql(
      `SELECT action, metadata FROM audit_events WHERE resource_id = $1 OR metadata->>'fileId' = $2`,
      [view.id, view.fileId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['export.generated']);
    expect(audit.rows[0].metadata).toMatchObject({
      domain: 'dimension_values',
      rows: view.rowCount,
    });
    await ownerSql("UPDATE exports SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      view.id,
    ]);
    await ctx.services.dataExchangeCleanup.schedule();
    for (let i = 0; i < 10; i++) await ctx.worker.runOnce();
    const expired = (await org.owner.get(`/exports/${view.id}`)).body.data;
    expect(expired).toMatchObject({ status: 'expired', fileId: null });
    expect((await org.owner.get(`/exports/${view.id}/download-url`)).status).toBe(409);
    const file = await ownerSql('SELECT status FROM files WHERE id = $1', [view.fileId]);
    expect(file.rows[0].status).toBe('deleted');
  });

  it('produces the import error report for the batch owner only', async () => {
    const created = await org.owner.post('/imports', { domain: 'chart_of_accounts' });
    const id = created.body.data.id;
    await org.owner.upload(
      `/files?linkType=import_batch&linkId=${id}`,
      Buffer.from('code,name,type\r\n1110,Dup,Asset\r\nER1,"=cmd",Asset\r\n'),
      'e.csv',
    );
    const inspected = await org.owner.post(`/imports/${id}/inspect`, {});
    await org.owner.put(`/imports/${id}/mapping`, {
      version: inspected.body.data.batch.version,
      mapping: inspected.body.data.suggestedMapping,
    });
    for (let i = 0; i < 10; i++) await ctx.worker.runOnce();
    const report = await org.owner.post(`/imports/${id}/error-report`, {});
    expect(report.status).toBe(202);
    let view = report.body.data.export;
    for (let i = 0; i < 20 && ['queued', 'running'].includes(view.status); i++) {
      await ctx.worker.runOnce();
      view = (await org.owner.get(`/exports/${view.id}`)).body.data;
    }
    const { rows } = await download(org.owner, view.id);
    expect(rows[0]).toEqual([
      'row',
      'status',
      'excluded',
      'field',
      'code',
      'message',
      'code',
      'name',
      'type',
    ]);
    expect(rows[1]).toEqual([
      '1',
      'error',
      'no',
      'code',
      'ALREADY_EXISTS',
      expect.any(String),
      '1110',
      'Dup',
      'Asset',
    ]);
    const other = await setUpAccountingOrg(ctx, { fiscalYear: false });
    expect((await other.owner.post(`/imports/${id}/error-report`, {})).status).toBe(404);
  });

  it('validates export parameters strictly', async () => {
    expect(
      (await org.owner.post('/exports', { domain: 'journals', params: { statuses: ['NOPE'] } }))
        .status,
    ).toBe(400);
    expect(
      (await org.owner.post('/exports', { domain: 'chart_of_accounts', params: { extra: 1 } }))
        .status,
    ).toBe(400);
    expect((await org.owner.post('/exports', { domain: 'nope', params: {} })).status).toBe(400);
  });
});
