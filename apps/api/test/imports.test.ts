import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cashSale, joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';
import { zip } from './zip.js';

/**
 * Phase 3A S6 imports: batch lifecycle, every domain, atomic commit, acting-user checks (L-6),
 * limits (Decision 61), duplicate files, draft discard (L-9), cleanup/redaction (L-11), RLS.
 */

let ctx: TestContext;
let org: AccountingOrg;

const csv = (...lines: string[]) => lines.join('\r\n') + '\r\n';

async function ownerSql(text: string, params: unknown[] = []) {
  const owner = await connectAs('owner');
  try {
    return await owner.query(text, params);
  } finally {
    await owner.end();
  }
}

/** Runs worker batches until the import leaves validating/committing. */
async function settle(client: TestClient, id: string) {
  for (let i = 0; i < 40; i++) {
    const res = await client.get(`/imports/${id}`);
    if (!['validating', 'committing'].includes(res.body.data.status)) return res.body.data;
    await ctx.worker.runOnce();
  }
  return (await client.get(`/imports/${id}`)).body.data;
}

interface Prepared {
  id: string;
  batch: Record<string, any>;
}

/** create → upload → inspect → map (suggested unless given) → validated batch. */
async function prepare(
  client: TestClient,
  domain: string,
  content: string | Buffer,
  options: {
    options?: Record<string, string>;
    mapping?: Record<string, number | null>;
    fileName?: string;
  } = {},
): Promise<Prepared> {
  const created = await client.post('/imports', { domain, options: options.options ?? {} });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  const up = await client.upload(
    `/files?linkType=import_batch&linkId=${id}`,
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    options.fileName ?? 'data.csv',
  );
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  const inspected = await client.post(`/imports/${id}/inspect`, {});
  expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
  const mapped = await client.put(`/imports/${id}/mapping`, {
    version: inspected.body.data.batch.version,
    mapping: options.mapping ?? inspected.body.data.suggestedMapping,
  });
  expect(mapped.status, JSON.stringify(mapped.body)).toBe(202);
  return { id, batch: await settle(client, id) };
}

async function commit(client: TestClient, prepared: Prepared, extra: Record<string, boolean> = {}) {
  const res = await client.post(`/imports/${prepared.id}/commit`, {
    version: prepared.batch.version,
    ...extra,
  });
  if (res.status !== 202) return { res, batch: null };
  return { res, batch: await settle(client, prepared.id) };
}

async function errorRows(client: TestClient, id: string) {
  const res = await client.get(`/imports/${id}/rows?status=error&limit=500`);
  return res.body.data.rows as { rowNumber: number; messages: { code: string; field: string }[] }[];
}

beforeAll(async () => {
  ctx = await createTestContext();
  org = await setUpAccountingOrg(ctx);
});
afterAll(() => ctx.close());

describe('chart of accounts import', () => {
  it('imports accounts with parents (in any order), through the account service, audited', async () => {
    const file = csv(
      'Account Code,Account Name,Type,Parent,Currency,Subtype,Description',
      'X1111,Petty cash front desk,Asset,X1100,,cash,"Cash, front desk"',
      `X1100,Cash floats,asset,,MVR,,Group`,
      `X4101,${"'=Tour revenue"},Income,,,operating revenue,`,
    );
    const prepared = await prepare(org.owner, 'chart_of_accounts', file);
    expect(prepared.batch).toMatchObject({
      status: 'validated',
      counts: { total: 3, valid: 3, warning: 0, error: 0, excluded: 0 },
      mapping: {
        code: 0,
        name: 1,
        type: 2,
        parent_code: 3,
        currency: 4,
        subtype: 5,
        description: 6,
      },
    });
    const { batch } = await commit(org.owner, prepared);
    expect(batch).toMatchObject({ status: 'committed', created: 3 });
    const accounts = (await org.owner.get('/accounting/accounts')).body.data as any[];
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    expect(byCode.get('X1111')).toMatchObject({
      type: 'ASSET',
      subtype: 'CASH',
      parentId: byCode.get('X1100').id,
      description: 'Cash, front desk',
    });
    // Our own export escape is undone on import; the value is stored as text.
    expect(byCode.get('X4101')).toMatchObject({
      name: '=Tour revenue',
      type: 'REVENUE',
      subtype: 'OPERATING_REVENUE',
    });
    const audit = await ownerSql(
      `SELECT action, actor_user_id IS NOT NULL AS by_user, request_id FROM audit_events
        WHERE organization_id = $1 AND request_id = $2 ORDER BY action`,
      [org.organizationId, `import:${prepared.id}`],
    );
    expect(audit.rows.filter((r) => r.action === 'account.created')).toHaveLength(3);
    expect(audit.rows.find((r) => r.action === 'import.committed')).toMatchObject({
      by_user: true,
    });
    // The source file is soft-deleted once the import ends (S5 retention applies).
    const file_ = await ownerSql('SELECT status FROM files WHERE id = $1', [prepared.batch.fileId]);
    expect(file_.rows[0].status).toBe('deleted');
  });

  it('reports every row problem and blocks the commit until they are fixed or excluded', async () => {
    const file = csv(
      'code,name,type,parent_code,subtype',
      'Y1,Dup,Asset,,', // duplicate in file
      'Y1,Dup again,Asset,,',
      '1110,Existing code,Asset,,', // exists in the template chart
      'Y2,Orphan,Asset,NOPE,', // unknown parent
      'Y3,Loop A,Asset,Y4,',
      'Y4,Loop B,Asset,Y3,', // cycle
      'Y5,Bad type,Planet,,',
      'Y6,Wrong subtype,Asset,,accounts payable',
      'Y7,Fine,Expense,,',
    );
    const prepared = await prepare(org.owner, 'chart_of_accounts', file);
    expect(prepared.batch.counts).toMatchObject({ total: 9, valid: 1, error: 8 });
    const codes = Object.fromEntries(
      (await errorRows(org.owner, prepared.id)).map((r) => [
        r.rowNumber,
        r.messages.map((m) => m.code),
      ]),
    );
    expect(codes[1]).toContain('DUPLICATE_IN_FILE');
    expect(codes[3]).toContain('ALREADY_EXISTS');
    expect(codes[4]).toContain('UNKNOWN_PARENT');
    expect(codes[5]).toContain('CYCLE');
    expect(codes[7]).toContain('INVALID_VALUE');
    expect(codes[8]).toContain('INVALID_VALUE');
    const blocked = await commit(org.owner, prepared);
    expect(blocked.res.status).toBe(422);
    expect(blocked.res.body.error.code).toBe('IMPORT_NOT_READY');

    const excluded = await org.owner.put(`/imports/${prepared.id}/exclusions`, {
      version: prepared.batch.version,
      exclude: [1, 2, 3, 4, 5, 6, 7, 8],
    });
    expect(excluded.status).toBe(202);
    const revalidated = await settle(org.owner, prepared.id);
    expect(revalidated.counts).toMatchObject({ valid: 1, error: 0, excluded: 8 });
    const done = await commit(org.owner, { id: prepared.id, batch: revalidated });
    expect(done.batch).toMatchObject({ status: 'committed', created: 1 });
  });

  it('rolls the whole commit back when data changed after validation (atomic, S6-12)', async () => {
    const before = (await org.owner.get('/accounting/accounts')).body.data.length;
    const prepared = await prepare(
      org.owner,
      'chart_of_accounts',
      csv('code,name,type', 'Z1,First,Asset', 'Z2,Second,Asset', 'Z3,Third,Asset'),
    );
    expect(prepared.batch.status).toBe('validated');
    // Someone creates Z3 before the commit runs.
    const race = await org.owner.post('/accounting/accounts', {
      code: 'Z3',
      name: 'Raced',
      type: 'ASSET',
    });
    expect(race.status).toBe(201);
    const { batch } = await commit(org.owner, prepared);
    expect(batch.status).toBe('needs_review');
    expect(batch.lastError).toMatch(/no longer valid/);
    const after = (await org.owner.get('/accounting/accounts')).body.data as any[];
    expect(after).toHaveLength(before + 1); // only the raced account; Z1/Z2 rolled back
    expect(after.some((a) => a.code === 'Z1')).toBe(false);
    expect((await errorRows(org.owner, prepared.id))[0]).toMatchObject({
      rowNumber: 3,
      messages: [expect.objectContaining({ code: 'ALREADY_EXISTS' })],
    });
  });
});

describe('parties and contact persons', () => {
  it('imports parties with contact and addresses; duplicate hints are warnings to acknowledge', async () => {
    const existing = await org.owner.post('/parties', {
      kind: 'organization',
      displayName: 'Coral Supplies',
      email: 'ap@coral.test',
    });
    expect(existing.status).toBe(201);
    const file = csv(
      'kind,display_name,reference,email,roles,contact_first_name,contact_email,billing_line1,billing_country,delivery_line1,delivery_country',
      'organization,Blue Lagoon Traders,P-001,info@lagoon.test,customer;vendor,Aisha,aisha@lagoon.test,Orchid Magu,mv,Harbour Rd,MV',
      'organization,Coral Supplies,P-002,,vendor,,,,,,',
      'individual,,P-003,,employee,,,,,,',
    );
    const prepared = await prepare(org.owner, 'parties', file);
    // Row 3: an individual needs a display name or first/last name.
    expect(prepared.batch.counts).toMatchObject({ valid: 1, warning: 1, error: 1 });
    const rows = (await org.owner.get(`/imports/${prepared.id}/rows?limit=10`)).body.data.rows;
    expect(rows[1].messages[0]).toMatchObject({ severity: 'warning', code: 'POSSIBLE_DUPLICATE' });
    expect(rows[2].messages[0]).toMatchObject({ code: 'REQUIRED', field: 'display_name' });
    const excluded = await org.owner.put(`/imports/${prepared.id}/exclusions`, {
      version: prepared.batch.version,
      exclude: [3],
    });
    expect(excluded.status).toBe(202);
    const revalidated = { id: prepared.id, batch: await settle(org.owner, prepared.id) };
    const unacknowledged = await commit(org.owner, revalidated);
    expect(unacknowledged.res.status).toBe(422);
    const { batch } = await commit(org.owner, revalidated, { acknowledgeWarnings: true });
    expect(batch).toMatchObject({ status: 'committed', created: 2 });
    const list = (await org.owner.get('/parties?search=Blue%20Lagoon')).body.data.items;
    const detail = (await org.owner.get(`/parties/${list[0].id}`)).body.data;
    expect(detail).toMatchObject({
      reference: 'P-001',
      roles: ['customer', 'vendor'],
      contacts: [expect.objectContaining({ firstName: 'Aisha', isPrimary: true })],
    });
    expect(detail.addresses.map((a: any) => [a.kind, a.countryCode])).toEqual([
      ['billing', 'MV'],
      ['delivery', 'MV'],
    ]);
  });

  it('rejects conflicting references, unknown countries and invalid emails', async () => {
    const prepared = await prepare(
      org.owner,
      'parties',
      csv(
        'kind,display_name,reference,email,billing_line1,billing_country',
        'organization,A,P-001,,,', // reference already exists (case-insensitive)
        'organization,B,dup,,,',
        'organization,C,DUP,,,', // duplicate within the file
        'organization,D,,not-an-email,,',
        'organization,E,,,Somewhere,ZZ',
      ),
    );
    const codes = (await errorRows(org.owner, prepared.id)).map((r) => r.messages[0]!.code);
    expect(codes).toEqual([
      'ALREADY_EXISTS',
      'DUPLICATE_IN_FILE',
      'DUPLICATE_IN_FILE',
      'INVALID_VALUE',
      'INVALID_VALUE',
    ]);
  });

  it('adds contact persons to existing parties by reference (parties.update)', async () => {
    const prepared = await prepare(
      org.owner,
      'party_contacts',
      csv(
        'party_reference,first_name,last_name,email,is_primary',
        'p-001,Hassan,Ali,hassan@lagoon.test,yes',
        'P-404,Nobody,,,',
      ),
    );
    expect(prepared.batch.counts).toMatchObject({ valid: 1, error: 1 });
    await org.owner.put(`/imports/${prepared.id}/exclusions`, {
      version: prepared.batch.version,
      exclude: [2],
    });
    const { batch } = await commit(org.owner, {
      id: prepared.id,
      batch: await settle(org.owner, prepared.id),
    });
    expect(batch.status).toBe('committed');
    const list = (await org.owner.get('/parties?search=Blue%20Lagoon')).body.data.items;
    const contacts = (await org.owner.get(`/parties/${list[0].id}`)).body.data.contacts;
    expect(contacts.map((c: any) => [c.firstName, c.isPrimary])).toEqual([
      ['Aisha', false],
      ['Hassan', true],
    ]);
  });
});

describe('dimension values and exchange rates', () => {
  it('creates values under existing active dimensions only', async () => {
    const type = await org.owner.post('/accounting/dimensions', { code: 'PROJ', name: 'Project' });
    expect(type.status).toBe(201);
    const prepared = await prepare(
      org.owner,
      'dimension_values',
      csv(
        'dimension,code,name',
        'PROJ,P-1,Renovation',
        'project,P-2,Extension',
        'NOPE,X,Y',
        'PROJ,P-1,Again',
      ),
    );
    const codes = (await errorRows(org.owner, prepared.id)).map((r) => [
      r.rowNumber,
      r.messages[0]!.code,
    ]);
    expect(codes).toEqual([
      [1, 'DUPLICATE_IN_FILE'],
      [3, 'UNKNOWN_DIMENSION'],
      [4, 'DUPLICATE_IN_FILE'],
    ]);
    await org.owner.put(`/imports/${prepared.id}/exclusions`, {
      version: prepared.batch.version,
      exclude: [3, 4],
    });
    const { batch } = await commit(org.owner, {
      id: prepared.id,
      batch: await settle(org.owner, prepared.id),
    });
    expect(batch).toMatchObject({ status: 'committed', created: 2 });
  });

  it('imports rates with a DD/MM/YYYY date format and a decimal comma', async () => {
    const prepared = await prepare(
      org.owner,
      'exchange_rates',
      csv(
        'currency;date;rate',
        'usd;31/01/2026;15,42',
        'EUR;01/02/2026;16,7501',
        'MVR;01/02/2026;1',
        'USD;31/01/2026;15,5',
      ),
      { options: { dateFormat: 'DD/MM/YYYY', decimalSeparator: ',' } },
    );
    expect(prepared.batch.options).toMatchObject({ delimiter: ';' });
    const codes = (await errorRows(org.owner, prepared.id)).map((r) => [
      r.rowNumber,
      r.messages[0]!.code,
    ]);
    expect(codes).toEqual([
      [1, 'DUPLICATE_IN_FILE'],
      [3, 'INVALID_VALUE'], // base currency
      [4, 'DUPLICATE_IN_FILE'],
    ]);
    await org.owner.put(`/imports/${prepared.id}/exclusions`, {
      version: prepared.batch.version,
      exclude: [3, 4],
    });
    const { batch } = await commit(org.owner, {
      id: prepared.id,
      batch: await settle(org.owner, prepared.id),
    });
    expect(batch.status).toBe('committed');
    const rates = (await org.owner.get('/accounting/exchange-rates')).body.data;
    expect(rates.map((r: any) => [r.fromCurrency, r.rateDate, r.rate]).sort()).toEqual([
      ['EUR', '2026-02-01', '16.7501000000'],
      ['USD', '2026-01-31', '15.4200000000'],
    ]);
  });
});

describe('draft manual journals (S6-15..S6-17, L-8, L-9)', () => {
  let batchId: string;
  let journalIds: string[];

  it('groups rows into balanced drafts carrying the batch as their source; nothing is posted', async () => {
    const file = csv(
      'journal_key,date,description,reference,account_code,debit,credit,Project',
      'JE-1,2026-03-10,Float,REF-1,1110,100.00,,Renovation',
      'JE-1,,,,4100,,100.00,',
      'JE-2,2026-03-11,Sale,REF-2,1110,250.00,,',
      'JE-2,2026-03-11,Sale,REF-2,4100,,250.00,',
      'JE-3,2026-03-12,Bad,,1110,10.00,,',
      'JE-3,2026-03-12,Bad,,4100,,9.00,', // unbalanced
      'JE-4,2026-03-13,Unknown,,9999,5.00,,',
      'JE-4,2026-03-13,Unknown,,4100,,5.00,', // unknown account (whole journal fails)
      'JE-5,2026-03-14,One line,,1110,5.00,,', // single line
    );
    const prepared = await prepare(org.owner, 'manual_journals', file);
    batchId = prepared.id;
    expect(prepared.batch.mapping).toMatchObject({ journal_key: 0, 'dimension:PROJ': 7 });
    const errors = await errorRows(org.owner, prepared.id);
    const byRow = Object.fromEntries(
      errors.map((r) => [r.rowNumber, r.messages.map((m) => m.code)]),
    );
    expect(byRow[5]).toContain('UNBALANCED_JOURNAL');
    expect(byRow[6]).toContain('UNBALANCED_JOURNAL');
    expect(byRow[7]).toContain('UNKNOWN_ACCOUNT');
    expect(byRow[8]).toContain('JOURNAL_HAS_ERRORS');
    expect(byRow[9]).toContain('NOT_ENOUGH_LINES');
    // Excluding one row excludes its whole journal.
    const ex = await org.owner.put(`/imports/${prepared.id}/exclusions`, {
      version: prepared.batch.version,
      exclude: [5, 7, 9],
    });
    expect(ex.status).toBe(202);
    const revalidated = await settle(org.owner, prepared.id);
    expect(revalidated.counts).toMatchObject({ valid: 4, error: 0, excluded: 5 });
    const { batch } = await commit(org.owner, { id: prepared.id, batch: revalidated });
    expect(batch).toMatchObject({ status: 'committed', created: 2 });

    const rows = (await org.owner.get(`/imports/${prepared.id}/rows?limit=10`)).body.data.rows;
    journalIds = [
      ...new Set<string>(rows.filter((r: any) => r.recordId).map((r: any) => r.recordId as string)),
    ];
    expect(journalIds).toHaveLength(2);
    for (const id of journalIds) {
      const journal = (await org.owner.get(`/accounting/journals/${id}`)).body.data;
      expect(journal).toMatchObject({
        status: 'DRAFT',
        source: 'manual',
        sourceModule: 'data_exchange',
        sourceType: 'import_batch',
        sourceId: prepared.id,
      });
    }
    const first = (await org.owner.get(`/accounting/journals/${journalIds[0]}`)).body.data;
    expect(first.lines[0].dimensions).toEqual([
      expect.objectContaining({ typeCode: 'PROJ', valueName: 'Renovation' }),
    ]);
  });

  it('applies the dimension permission (Decision 91) and archived-value rule (Decision 88)', async () => {
    const roles = await org.owner.post('/organizations/current/roles', {
      name: `Journal clerk ${randomUUID().slice(0, 6)}`,
      permissionKeys: [
        'accounting.journals.view',
        'accounting.journals.create',
        'accounting.accounts.view',
      ],
    });
    expect(roles.status).toBe(201);
    const clerk = await joinWithRole(ctx, org.owner, roles.body.data.name);
    const file = csv(
      'journal_key,date,account_code,debit,credit,Project',
      'J,2026-03-10,1110,1,,Renovation',
      'J,2026-03-10,4100,,1,',
    );
    const prepared = await prepare(clerk.client, 'manual_journals', file);
    const codes = (await errorRows(clerk.client, prepared.id)).flatMap((r) =>
      r.messages.map((m) => m.code),
    );
    expect(codes).toContain('DIMENSION_PERMISSION');

    const types = (await org.owner.get('/accounting/dimensions')).body.data as any[];
    const proj = types.find((t) => t.code === 'PROJ');
    const value = proj.values.find((v: any) => v.name === 'Extension');
    expect(
      (await org.owner.post(`/accounting/dimensions/${proj.id}/values/${value.id}/archive`)).status,
    ).toBe(200);
    const archived = await prepare(
      org.owner,
      'manual_journals',
      csv(
        'journal_key,date,account_code,debit,credit,Project',
        'J,2026-03-10,1110,1,,Extension',
        'J,2026-03-10,4100,,1,',
      ),
    );
    const archivedCodes = (await errorRows(org.owner, archived.id)).flatMap((r) =>
      r.messages.map((m) => m.code),
    );
    expect(archivedCodes).toContain('ARCHIVED_VALUE');
  });

  it('discards never-submitted imported drafts only, keeping them (L-9)', async () => {
    // Post one of the imported drafts through the normal workflow first.
    const posted = await org.owner.post(`/accounting/journals/${journalIds[0]}/post`, {});
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const res = await org.owner.post(`/imports/${batchId}/discard-drafts`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ discarded: 1, kept: 1 });
    const discarded = (await org.owner.get(`/accounting/journals/${journalIds[1]}`)).body.data;
    expect(discarded).toMatchObject({ status: 'DISCARDED', discardedAt: expect.any(String) });
    // Not listed by default; still listed when asked for; nothing was deleted.
    const listed = (await org.owner.get('/accounting/journals?limit=200')).body.data as any[];
    expect(listed.some((j) => j.id === journalIds[1])).toBe(false);
    const explicit = (await org.owner.get('/accounting/journals?status=DISCARDED&limit=200')).body
      .data as any[];
    expect(explicit.some((j) => j.id === journalIds[1])).toBe(true);
    const audit = await ownerSql(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'journal.discarded' AND resource_id = $1`,
      [journalIds[1]],
    );
    expect(audit.rows[0].n).toBe(1);
    // A discarded journal can never change again.
    expect((await org.owner.post(`/accounting/journals/${journalIds[1]}/submit`, {})).status).toBe(
      409,
    );
    expect(
      (await org.owner.patch(`/accounting/journals/${journalIds[1]}`, { description: 'x' })).status,
    ).toBe(409);
  });

  it('refuses to discard manual drafts that no import created, and the database enforces it', async () => {
    const manual = await org.owner.post('/accounting/journals', cashSale(org));
    expect(
      (await org.owner.post(`/accounting/journals/${manual.body.data.id}/discard`, {})).status,
    ).toBe(409);
    await expect(
      ownerSql(
        `UPDATE accounting_journal_entries SET status = 'DISCARDED', discarded_at = now(),
                discarded_by_user_id = created_by_user_id WHERE id = $1`,
        [manual.body.data.id],
      ),
    ).rejects.toThrow(/only never-submitted imported drafts/);
    // An imported draft that was ever submitted is not discardable either (guard on submitted_at).
    const prepared = await prepare(
      org.owner,
      'manual_journals',
      csv(
        'journal_key,date,account_code,debit,credit',
        'K,2026-03-20,1110,3,',
        'K,2026-03-20,4100,,3',
      ),
    );
    await commit(org.owner, prepared);
    const row = (await org.owner.get(`/imports/${prepared.id}/rows?limit=5`)).body.data.rows[0];
    await ownerSql('UPDATE accounting_journal_entries SET submitted_at = now() WHERE id = $1', [
      row.recordId,
    ]);
    expect((await org.owner.post(`/accounting/journals/${row.recordId}/discard`, {})).status).toBe(
      409,
    );
    await expect(
      ownerSql(
        `UPDATE accounting_journal_entries SET status = 'DISCARDED', discarded_at = now(),
                discarded_by_user_id = created_by_user_id WHERE id = $1`,
        [row.recordId],
      ),
    ).rejects.toThrow(/only never-submitted imported drafts/);
  });
});

describe('file, state and limit rules', () => {
  it('accepts one CSV file per import; XLSX waits for Decision 62 (L-3); exports take no uploads', async () => {
    const created = await org.owner.post('/imports', { domain: 'chart_of_accounts' });
    const id = created.body.data.id;
    const workbook = zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' });
    expect(
      (await org.owner.upload(`/files?linkType=import_batch&linkId=${id}`, workbook, 'coa.xlsx'))
        .status,
    ).toBe(415);
    expect(
      (
        await org.owner.upload(
          `/files?linkType=import_batch&linkId=${id}`,
          Buffer.from('code\n1\n'),
          'a.csv',
        )
      ).status,
    ).toBe(201);
    const second = await org.owner.upload(
      `/files?linkType=import_batch&linkId=${id}`,
      Buffer.from('code\n1\n'),
      'b.csv',
    );
    expect(second.status).toBe(409);
    const exp = await org.owner.upload(
      `/files?linkType=export&linkId=${randomUUID()}`,
      Buffer.from('a\n'),
      'x.csv',
    );
    expect([403, 404]).toContain(exp.status);
  });

  it('fails files beyond 25,000 rows, empty files and malformed CSV (failed_file, terminal)', async () => {
    const tooMany = csv(
      'code,name,type',
      ...Array.from({ length: 25_001 }, (_, i) => `L${i},Row ${i},Asset`),
    );
    const big = await prepare(org.owner, 'chart_of_accounts', tooMany);
    expect(big.batch).toMatchObject({
      status: 'failed_file',
      lastError: expect.stringMatching(/more than 25,000/),
    });
    const headerOnly = await org.owner.post('/imports', { domain: 'chart_of_accounts' });
    await org.owner.upload(
      `/files?linkType=import_batch&linkId=${headerOnly.body.data.id}`,
      Buffer.from('code,name,type\r\n'),
      'h.csv',
    );
    const inspected = await org.owner.post(`/imports/${headerOnly.body.data.id}/inspect`, {});
    await org.owner.put(`/imports/${headerOnly.body.data.id}/mapping`, {
      version: inspected.body.data.batch.version,
      mapping: inspected.body.data.suggestedMapping,
    });
    expect(await settle(org.owner, headerOnly.body.data.id)).toMatchObject({
      status: 'failed_file',
    });

    const broken = await org.owner.post('/imports', { domain: 'chart_of_accounts' });
    await org.owner.upload(
      `/files?linkType=import_batch&linkId=${broken.body.data.id}`,
      Buffer.from('code,name\r\n"unterminated,x\r\n'),
      'b.csv',
    );
    const brokenInspect = await org.owner.post(`/imports/${broken.body.data.id}/inspect`, {});
    expect(brokenInspect.status).toBe(400);
  });

  it('rejects blank or duplicate headers, and marks over-long cells and ragged rows', async () => {
    for (const header of ['code,,type', 'code,Code,type']) {
      const b = await org.owner.post('/imports', { domain: 'chart_of_accounts' });
      await org.owner.upload(
        `/files?linkType=import_batch&linkId=${b.body.data.id}`,
        Buffer.from(`${header}\r\n1,2,3\r\n`),
        'h.csv',
      );
      expect((await org.owner.post(`/imports/${b.body.data.id}/inspect`, {})).status).toBe(400);
    }
    const prepared = await prepare(
      org.owner,
      'chart_of_accounts',
      csv('code,name,type', `W1,${'x'.repeat(10_001)},Asset`, 'W2,Short,Asset,extra'),
    );
    const codes = (await errorRows(org.owner, prepared.id)).map((r) => r.messages[0]!.code);
    expect(codes).toEqual(['TOO_LONG', 'COLUMN_COUNT']);
  });

  it('previews at most 500 rows per page and validates every row (L-1)', async () => {
    const lines = Array.from({ length: 1_200 }, (_, i) => `PV${i},Preview ${i},Asset`);
    const prepared = await prepare(org.owner, 'chart_of_accounts', csv('code,name,type', ...lines));
    expect(prepared.batch.counts).toMatchObject({ total: 1_200, valid: 1_200 });
    expect((await org.owner.get(`/imports/${prepared.id}/rows?limit=501`)).status).toBe(400);
    const page = await org.owner.get(`/imports/${prepared.id}/rows?limit=500`);
    expect(page.body.data.rows).toHaveLength(500);
    expect(page.body.data.nextAfter).toBe(500);
  });

  it('requires the reviewed version and a validated batch; a second commit is refused', async () => {
    const prepared = await prepare(
      org.owner,
      'chart_of_accounts',
      csv('code,name,type', 'V1,Versioned,Asset'),
    );
    expect(
      (
        await org.owner.post(`/imports/${prepared.id}/commit`, {
          version: prepared.batch.version - 1,
        })
      ).status,
    ).toBe(409);
    const first = await org.owner.post(`/imports/${prepared.id}/commit`, {
      version: prepared.batch.version,
    });
    expect(first.status).toBe(202);
    const again = await org.owner.post(`/imports/${prepared.id}/commit`, {
      version: first.body.data.batch.version,
    });
    expect(again.status).toBe(409);
    expect(await settle(org.owner, prepared.id)).toMatchObject({ status: 'committed' });
  });

  it('warns when the same file content was already imported (S6-22)', async () => {
    const content = csv('code,name,type', 'D1,Duplicate file,Asset');
    const first = await prepare(org.owner, 'chart_of_accounts', content);
    await commit(org.owner, first);
    const second = await prepare(
      org.owner,
      'dimension_values',
      csv('dimension,code,name', 'PROJ,DUPF,Dup file'),
    );
    await commit(org.owner, second);
    // Same content, same domain: the account now exists anyway, so use another org's view of it.
    const again = await prepare(org.owner, 'chart_of_accounts', content);
    expect(again.batch.duplicateOfBatchId).toBe(first.id);
  });

  it('limits concurrent validations per organization (S6-35)', async () => {
    const limited = await createTestContext({ IMPORT_MAX_ACTIVE_PER_ORGANIZATION: '1' });
    try {
      const o = await setUpAccountingOrg(limited, { fiscalYear: false });
      const start = async () => {
        const b = await o.owner.post('/imports', { domain: 'chart_of_accounts' });
        await o.owner.upload(
          `/files?linkType=import_batch&linkId=${b.body.data.id}`,
          Buffer.from('code,name,type\r\nQ,Q,Asset\r\n'),
          'q.csv',
        );
        const i = await o.owner.post(`/imports/${b.body.data.id}/inspect`, {});
        return o.owner.put(`/imports/${b.body.data.id}/mapping`, {
          version: i.body.data.batch.version,
          mapping: i.body.data.suggestedMapping,
        });
      };
      expect((await start()).status).toBe(202);
      const second = await start();
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('IMPORT_LIMIT_REACHED');
    } finally {
      await limited.close();
    }
  });
});

describe('permissions, acting user (L-6) and isolation', () => {
  it('uses the target create permission; members cannot import accounts or parties', async () => {
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.post('/imports', { domain: 'chart_of_accounts' })).status).toBe(
      403,
    );
    expect((await member.client.post('/imports', { domain: 'parties' })).status).toBe(403);
    expect((await member.client.get('/imports/templates/parties')).status).toBe(403);
    const catalog = (await member.client.get('/imports/catalog')).body.data;
    expect(catalog).toEqual([]);
  });

  it('re-checks the requesting user when the commit runs', async () => {
    const roles = await org.owner.post('/organizations/current/roles', {
      name: `Importer ${randomUUID().slice(0, 6)}`,
      permissionKeys: ['accounting.accounts.view', 'accounting.accounts.create'],
    });
    const importer = await joinWithRole(ctx, org.owner, roles.body.data.name);
    const prepared = await prepare(
      importer.client,
      'chart_of_accounts',
      csv('code,name,type', 'AU1,Acting user,Asset'),
    );
    const started = await importer.client.post(`/imports/${prepared.id}/commit`, {
      version: prepared.batch.version,
    });
    expect(started.status).toBe(202);
    // Permission removed before the job runs.
    const update = await org.owner.put(`/organizations/current/roles/${roles.body.data.id}`, {
      name: roles.body.data.name,
      permissionKeys: ['accounting.accounts.view'],
    });
    expect([200, 204]).toContain(update.status);
    const batch = await settle(org.owner, prepared.id);
    expect(batch).toMatchObject({ status: 'needs_review' });
    const accounts = (await org.owner.get('/accounting/accounts')).body.data as any[];
    expect(accounts.some((a) => a.code === 'AU1')).toBe(false);
  });

  it("hides other tenants' imports (404) and applies RLS to the staging tables", async () => {
    const other = await setUpAccountingOrg(ctx, { fiscalYear: false });
    const mine = await prepare(
      org.owner,
      'chart_of_accounts',
      csv('code,name,type', 'T1,Tenant,Asset'),
    );
    expect((await other.owner.get(`/imports/${mine.id}`)).status).toBe(404);
    expect((await other.owner.get(`/imports/${mine.id}/rows`)).status).toBe(404);
    expect((await other.owner.post(`/imports/${mine.id}/cancel`, { version: 1 })).status).toBe(404);
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.organization_id', $1, true)", [other.organizationId]);
      for (const table of ['import_batches', 'import_rows', 'import_mappings', 'exports']) {
        const rows = await app.query(`SELECT 1 FROM ${table} WHERE organization_id = $1`, [
          org.organizationId,
        ]);
        expect(rows.rowCount, table).toBe(0);
      }
      await expect(app.query('DELETE FROM import_rows')).rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });
});

describe('templates, saved mappings, cancel', () => {
  it('serves a header-only CSV template with the field labels', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/imports/templates/chart_of_accounts',
      headers: { cookie: `${ctx.config.session.cookieName}=${org.owner.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/chart-of-accounts-template\.csv/);
    expect(res.body).toBe(
      '\uFEFF"Code","Name","Type","Parent code","Currency","Subtype","Monetary","Description"\r\n',
    );
  });

  it('saves, lists and deletes named mappings (unique names)', async () => {
    const body = {
      domain: 'chart_of_accounts',
      name: 'Legacy GL',
      mapping: { code: 'GL Code', name: 'Title' },
    };
    const saved = await org.owner.post('/import-mappings', body);
    expect(saved.status).toBe(201);
    expect((await org.owner.post('/import-mappings', body)).status).toBe(409);
    expect(
      (await org.owner.post('/import-mappings', { ...body, name: 'x', mapping: { nope: 'A' } }))
        .status,
    ).toBe(400);
    const listed = (await org.owner.get('/import-mappings?domain=chart_of_accounts')).body.data;
    expect(listed.map((m: any) => m.name)).toContain('Legacy GL');
    expect((await org.owner.delete(`/import-mappings/${saved.body.data.id}`)).status).toBe(204);
    expect((await org.owner.post('/import-mappings', body)).status).toBe(201);
  });

  it('cancels an open import and soft-deletes its file', async () => {
    const prepared = await prepare(
      org.owner,
      'chart_of_accounts',
      csv('code,name,type', 'C1,Cancel,Asset'),
    );
    const res = await org.owner.post(`/imports/${prepared.id}/cancel`, {
      version: prepared.batch.version,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
    const file = await ownerSql('SELECT status FROM files WHERE id = $1', [prepared.batch.fileId]);
    expect(file.rows[0].status).toBe('deleted');
    expect(
      (await org.owner.post(`/imports/${prepared.id}/commit`, { version: res.body.data.version }))
        .status,
    ).toBe(409);
  });
});

describe('housekeeping (S6-36, L-11)', () => {
  it('expires idle batches, redacts finished ones after 30 days and reconciles stuck work', async () => {
    const idle = await prepare(
      org.owner,
      'chart_of_accounts',
      csv('code,name,type', 'E1,Expire,Asset'),
    );
    const done = await prepare(
      org.owner,
      'chart_of_accounts',
      csv('code,name,type', 'E2,Redact,Asset'),
    );
    await commit(org.owner, done);
    const stuck = await prepare(
      org.owner,
      'chart_of_accounts',
      csv('code,name,type', 'E3,Stuck,Asset'),
    );
    await ownerSql(
      "UPDATE import_batches SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [idle.id],
    );
    await ownerSql(
      "UPDATE import_batches SET finished_at = now() - interval '31 days' WHERE id = $1",
      [done.id],
    );
    await ownerSql(
      "UPDATE import_batches SET status = 'validating', updated_at = now() - interval '20 minutes' WHERE id = $1",
      [stuck.id],
    );
    const scheduled = await ctx.services.dataExchangeCleanup.schedule();
    expect(scheduled).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 10; i++) await ctx.worker.runOnce();
    expect((await org.owner.get(`/imports/${idle.id}`)).body.data.status).toBe('expired');
    const redacted = (await org.owner.get(`/imports/${done.id}`)).body.data;
    expect(redacted.redacted).toBe(true);
    const rows = (await org.owner.get(`/imports/${done.id}/rows`)).body.data.rows;
    expect(rows[0]).toMatchObject({ cells: null, recordId: expect.any(String) });
    const raw = await ownerSql('SELECT raw, normalized FROM import_rows WHERE batch_id = $1', [
      done.id,
    ]);
    expect(raw.rows[0]).toEqual({ raw: null, normalized: null });
    // The stuck batch's validation job had succeeded long ago: it goes back to ready.
    expect((await org.owner.get(`/imports/${stuck.id}`)).body.data).toMatchObject({
      status: 'ready',
      lastError: expect.stringMatching(/could not be completed/),
    });
  });
});
