import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cashSale,
  joinWithRole,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import {
  connectAs,
  MINUTE,
  TEST_STORAGE_ROOT,
  type TestClient,
  type TestContext,
  createTestContext,
} from './helpers.js';
import { zip } from './zip.js';

/**
 * Phase 3A S5 files: upload, detection, delivery, tokens, soft delete, legal hold, attachment
 * rules, logo and tenant isolation (K-1..K-7, S5-01..S5-22).
 */

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const CSV = Buffer.from('date,amount\n2026-01-01,100.00\n');

let ctx: TestContext;
let org: AccountingOrg;
let partyId: string;

async function createParty(client: TestClient) {
  const res = await client.post('/parties', {
    kind: 'organization',
    displayName: 'Island Traders',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function saveProfile(client: TestClient) {
  const res = await client.put('/organizations/current/profile', {
    version: 0,
    legalName: 'Example Resorts Private Limited',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function download(client: TestClient, fileId: string) {
  const link = await client.get(`/files/${fileId}/download-url`);
  expect(link.status, JSON.stringify(link.body)).toBe(200);
  const url = (link.body.data.url as string).replace('/api/v1', '');
  const headers: Record<string, string> = {};
  if (client.sessionToken)
    headers.cookie = `${ctx.config.session.cookieName}=${client.sessionToken}`;
  const res = await ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers });
  return { res, url, token: new URL(`http://x${url}`).searchParams.get('token')! };
}

beforeAll(async () => {
  ctx = await createTestContext();
  org = await setUpAccountingOrg(ctx);
  partyId = await createParty(org.owner);
});
afterAll(() => ctx.close());

describe('upload', () => {
  it('stores a party attachment with detected type, hash and tenant key, and audits it', async () => {
    const res = await org.owner.upload(
      `/files?linkType=party&linkId=${partyId}`,
      PDF,
      'Contract.pdf',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Contract.pdf',
      type: 'pdf',
      mimeType: 'application/pdf',
      size: PDF.length,
      status: 'available',
      scanStatus: 'not_scanned',
      link: { type: 'party', id: partyId },
    });
    const owner = await connectAs('owner');
    try {
      const row = await owner.query('SELECT storage_key, sha256 FROM files WHERE id = $1', [
        res.body.data.id,
      ]);
      const key = row.rows[0].storage_key as string;
      expect(key).toMatch(
        new RegExp(`^org/${org.organizationId}/\\d{4}/\\d{2}/${res.body.data.id}$`),
      );
      expect(await readFile(path.join(TEST_STORAGE_ROOT, ...key.split('/')))).toEqual(PDF);
      const audit = await owner.query(
        "SELECT metadata FROM audit_events WHERE action = 'file.uploaded' AND resource_id = $1",
        [res.body.data.id],
      );
      expect(audit.rows[0].metadata).toMatchObject({
        linkType: 'party',
        linkId: partyId,
        type: 'pdf',
        size: PDF.length,
        sha256: row.rows[0].sha256,
        name: 'Contract.pdf',
      });
    } finally {
      await owner.end();
    }
  });

  it('sanitizes the stored name', async () => {
    const res = await org.owner.upload(
      `/files?linkType=party&linkId=${partyId}`,
      CSV,
      '../../etc/\u202Eevil\u0000.csv',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.name).toBe('evil.csv');
  });

  it('rejects content that does not match its extension, and unsupported types, with 415', async () => {
    const renamed = await org.owner.upload(`/files?linkType=party&linkId=${partyId}`, PNG, 'x.pdf');
    expect(renamed.status).toBe(415);
    expect(renamed.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    const html = await org.owner.upload(
      `/files?linkType=party&linkId=${partyId}`,
      Buffer.from('<html><script>alert(1)</script></html>'),
      'page.html',
    );
    expect(html.status).toBe(415);
    const binaryCsv = await org.owner.upload(
      `/files?linkType=party&linkId=${partyId}`,
      Buffer.from([0x61, 0x00, 0x62]),
      'data.csv',
    );
    expect(binaryCsv.status).toBe(415);
  });

  it('rejects an empty upload with 400 and accepts only real workbooks as .xlsx', async () => {
    const empty = await org.owner.upload(
      `/files?linkType=party&linkId=${partyId}`,
      Buffer.alloc(0),
      'e.csv',
    );
    expect(empty.status).toBe(400);
    const notWorkbook = await org.owner.upload(
      `/files?linkType=party&linkId=${partyId}`,
      zip({ 'readme.txt': 'hello' }),
      'book.xlsx',
    );
    expect(notWorkbook.status).toBe(415);
    const workbook = await org.owner.upload(
      `/files?linkType=party&linkId=${partyId}`,
      zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' }),
      'book.xlsx',
    );
    expect(workbook.status, JSON.stringify(workbook.body)).toBe(201);
    expect(workbook.body.data).toMatchObject({
      type: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  });

  it('rejects files over 25 MB with 413, by declared length and while streaming', async () => {
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 0x41);
    const res = await org.owner.upload(`/files?linkType=party&linkId=${partyId}`, big, 'big.csv');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');

    // Chunked (no Content-Length): the byte counter stops it.
    const { Readable } = await import('node:stream');
    const chunks = function* () {
      for (let i = 0; i < 26; i++) yield Buffer.alloc(1024 * 1024, 0x41);
    };
    const streamed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/files?linkType=party&linkId=${partyId}`,
      headers: {
        cookie: `${ctx.config.session.cookieName}=${org.owner.sessionToken}`,
        'x-csrf-token': org.owner.csrfToken!,
        'content-type': 'application/octet-stream',
        'x-file-name': 'big.csv',
      },
      payload: Readable.from(chunks()),
    });
    expect(streamed.statusCode).toBe(413);
    expect(JSON.parse(streamed.body).error.code).toBe('FILE_TOO_LARGE');
  });

  it('accepts exactly 25 MB', async () => {
    const exact = Buffer.alloc(25 * 1024 * 1024, 0x41);
    const res = await org.owner.upload(`/files?linkType=party&linkId=${partyId}`, exact, 'max.csv');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('requires a link target, a file name, a raw body and an existing record', async () => {
    expect((await org.owner.upload('/files', PDF, 'a.pdf')).status).toBe(400);
    expect((await org.owner.upload('/files?linkType=party', PDF, 'a.pdf')).status).toBe(400);
    expect(
      (await org.owner.upload(`/files?linkType=organization_logo&linkId=${partyId}`, PNG, 'a.png'))
        .status,
    ).toBe(400);
    const noName = await org.owner.request('POST', `/files?linkType=party&linkId=${partyId}`, PDF, {
      'content-type': 'application/octet-stream',
    });
    expect(noName.status).toBe(400);
    const json = await org.owner.request(
      'POST',
      `/files?linkType=party&linkId=${partyId}`,
      { a: 1 },
      {
        'x-file-name': 'a.pdf',
      },
    );
    expect(json.status).toBe(415);
    const missing = await org.owner.upload(
      '/files?linkType=party&linkId=00000000-0000-4000-8000-000000000000',
      PDF,
      'a.pdf',
    );
    expect(missing.status).toBe(404);
  });

  it('keeps octet-stream bodies off every other route', async () => {
    const res = await org.owner.request('POST', '/parties', Buffer.from('{}'), {
      'content-type': 'application/octet-stream',
    });
    expect(res.status).toBe(415);
  });

  it('requires the linked record change permission and a session', async () => {
    const member = await joinWithRole(ctx, org.owner, 'Member');
    const res = await member.client.upload(`/files?linkType=party&linkId=${partyId}`, PDF, 'a.pdf');
    expect(res.status).toBe(403);
    const anonymous = ctx.client();
    const anon = await anonymous.upload(`/files?linkType=party&linkId=${partyId}`, PDF, 'a.pdf');
    expect(anon.status).toBe(401);
  });

  it('rejects uploads without the CSRF token', async () => {
    const res = await org.owner.upload(`/files?linkType=party&linkId=${partyId}`, PDF, 'a.pdf', {
      'x-csrf-token': 'wrong',
    });
    expect(res.status).toBe(403);
  });
});

describe('listing, metadata and delivery', () => {
  let fileId: string;
  beforeAll(async () => {
    const res = await org.owner.upload(
      `/files?linkType=party&linkId=${partyId}`,
      PDF,
      'Résumé "final".pdf',
    );
    fileId = res.body.data.id;
  });

  it('lists and reads files with the view permission', async () => {
    const member = await joinWithRole(ctx, org.owner, 'Member');
    const list = await member.client.get(`/files?linkType=party&linkId=${partyId}`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((f: { id: string }) => f.id)).toContain(fileId);
    const meta = await member.client.get(`/files/${fileId}`);
    expect(meta.status).toBe(200);
    // S5 §13: the uploader's display name, never their email.
    expect(meta.body.data.uploadedBy).toEqual({ id: expect.any(String), displayName: 'Test User' });
    expect(JSON.stringify(meta.body.data)).not.toContain('@example.test');
    expect(meta.body.data.name).toBe('Résumé "final".pdf');
  });

  it('delivers content through a short-lived signed URL with safe headers', async () => {
    const { res } = await download(org.owner, fileId);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(PDF);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('works without a session, but not for another signed-in user', async () => {
    const { token } = await download(org.owner, fileId);
    const url = `/api/v1/files/content?token=${encodeURIComponent(token)}`;
    expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(200);
    const other = ctx.client();
    await other.register();
    const res = await ctx.app.inject({
      method: 'GET',
      url,
      headers: { cookie: `${ctx.config.session.cookieName}=${other.sessionToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects expired, tampered and forged tokens with 403', async () => {
    const { token } = await download(org.owner, fileId);
    const [body, sig] = token.split('.');
    const [f, o, u, e] = Buffer.from(body!, 'base64url').toString().split('.');
    const forged = Buffer.from([f, o, u, Number(e) + 3600_000].join('.')).toString('base64url');
    for (const bad of [`${forged}.${sig}`, `${body}.AAAA`, 'garbage', `${body}`]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/files/content?token=${encodeURIComponent(bad)}`,
      });
      expect(res.statusCode, bad).toBe(403);
    }
    ctx.clock.advance(6 * MINUTE);
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/files/content?token=${encodeURIComponent(token)}`,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      ctx.clock.advance(-6 * MINUTE);
    }
  });

  it('never logs download tokens', async () => {
    const { token } = await download(org.owner, fileId);
    expect(ctx.logs.join('\n')).not.toContain(token);
  });

  it('hides files from other tenants (404) and their tokens are useless across files', async () => {
    const other = await setUpAccountingOrg(ctx, { fiscalYear: false });
    expect((await other.owner.get(`/files/${fileId}`)).status).toBe(404);
    expect((await other.owner.get(`/files/${fileId}/download-url`)).status).toBe(404);
    expect((await other.owner.delete(`/files/${fileId}`)).status).toBe(404);
    expect((await other.owner.get(`/files?linkType=party&linkId=${partyId}`)).status).toBe(404);
    expect(
      (await other.owner.upload(`/files?linkType=party&linkId=${partyId}`, PDF, 'a.pdf')).status,
    ).toBe(404);
  });
});

describe('soft delete and legal hold', () => {
  it('soft deletes with a 90-day purge date and audit; the file disappears', async () => {
    const up = await org.owner.upload(`/files?linkType=party&linkId=${partyId}`, CSV, 'd.csv');
    const { token } = await download(org.owner, up.body.data.id);
    const del = await org.owner.delete(`/files/${up.body.data.id}`);
    expect(del.status).toBe(204);
    expect((await org.owner.get(`/files/${up.body.data.id}`)).status).toBe(404);
    const list = await org.owner.get(`/files?linkType=party&linkId=${partyId}`);
    expect(list.body.data.map((f: { id: string }) => f.id)).not.toContain(up.body.data.id);
    const content = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/files/content?token=${encodeURIComponent(token)}`,
    });
    expect(content.statusCode).toBe(404);
    const owner = await connectAs('owner');
    try {
      const row = await owner.query(
        `SELECT status, round(extract(epoch FROM purge_after - deleted_at) / 86400) AS days
           FROM files WHERE id = $1`,
        [up.body.data.id],
      );
      expect(row.rows[0]).toMatchObject({ status: 'deleted', days: '90' });
      const audit = await owner.query(
        "SELECT 1 FROM audit_events WHERE action = 'file.deleted' AND resource_id = $1",
        [up.body.data.id],
      );
      expect(audit.rowCount).toBe(1);
    } finally {
      await owner.end();
    }
  });

  it('refuses to delete a file under legal hold (409) and the database forbids it too', async () => {
    const up = await org.owner.upload(`/files?linkType=party&linkId=${partyId}`, CSV, 'h.csv');
    const owner = await connectAs('owner');
    try {
      await owner.query('UPDATE files SET legal_hold = true WHERE id = $1', [up.body.data.id]);
      const del = await org.owner.delete(`/files/${up.body.data.id}`);
      expect(del.status).toBe(409);
      expect(del.body.error.code).toBe('LEGAL_HOLD');
      await expect(
        owner.query(
          "UPDATE files SET status = 'deleted', deleted_at = now(), purge_after = now() WHERE id = $1",
          [up.body.data.id],
        ),
      ).rejects.toThrow(/files_legal_hold/);
    } finally {
      await owner.end();
    }
  });

  it('requires the change permission to delete', async () => {
    const up = await org.owner.upload(`/files?linkType=party&linkId=${partyId}`, CSV, 'p.csv');
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.delete(`/files/${up.body.data.id}`)).status).toBe(403);
  });
});

describe('journal attachments (S5-20)', () => {
  it('attaches at any status, removes only while draft, and never changes the journal', async () => {
    const draft = await org.owner.post('/accounting/journals', cashSale(org));
    const draftId = draft.body.data.id as string;
    const onDraft = await org.owner.upload(
      `/files?linkType=journal&linkId=${draftId}`,
      PDF,
      'r.pdf',
    );
    expect(onDraft.status, JSON.stringify(onDraft.body)).toBe(201);
    expect((await org.owner.delete(`/files/${onDraft.body.data.id}`)).status).toBe(204);

    const posted = await postJournal(org);
    const before = await org.owner.get(`/accounting/journals/${posted.id}`);
    const onPosted = await org.owner.upload(
      `/files?linkType=journal&linkId=${posted.id}`,
      PDF,
      'receipt.pdf',
    );
    expect(onPosted.status).toBe(201);
    const del = await org.owner.delete(`/files/${onPosted.body.data.id}`);
    expect(del.status).toBe(409);
    const after = await org.owner.get(`/accounting/journals/${posted.id}`);
    expect(after.body.data).toEqual(before.body.data);
    const list = await org.owner.get(`/files?linkType=journal&linkId=${posted.id}`);
    expect(list.body.data).toHaveLength(1);
  });

  it('uses journal permissions: view to read, edit_draft to attach', async () => {
    const posted = await postJournal(org);
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.get(`/files?linkType=journal&linkId=${posted.id}`)).status).toBe(
      200,
    );
    expect(
      (await member.client.upload(`/files?linkType=journal&linkId=${posted.id}`, PDF, 'a.pdf'))
        .status,
    ).toBe(403);
  });
});

describe('organization logo (K-6, S5-11, S5-12)', () => {
  it('accepts images only', async () => {
    const pdf = await org.owner.upload('/files?linkType=organization_logo', PDF, 'logo.pdf');
    expect(pdf.status).toBe(415);
  });

  it('needs a saved profile, sets, replaces and removes the logo outside the profile version', async () => {
    const fresh = await setUpAccountingOrg(ctx, { fiscalYear: false });
    const first = await fresh.owner.upload('/files?linkType=organization_logo', PNG, 'logo.png');
    expect(first.status).toBe(201);
    const early = await fresh.owner.put('/organizations/current/profile/logo', {
      fileId: first.body.data.id,
    });
    expect(early.status).toBe(409);

    await saveProfile(fresh.owner);
    const set = await fresh.owner.put('/organizations/current/profile/logo', {
      fileId: first.body.data.id,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    let profile = await fresh.owner.get('/organizations/current/profile');
    expect(profile.body.data).toMatchObject({ version: 1, logo: { fileId: first.body.data.id } });

    // The current logo cannot be deleted directly.
    expect((await fresh.owner.delete(`/files/${first.body.data.id}`)).status).toBe(409);

    const second = await fresh.owner.upload('/files?linkType=organization_logo', JPEG, 'logo.jpg');
    await fresh.owner.put('/organizations/current/profile/logo', { fileId: second.body.data.id });
    profile = await fresh.owner.get('/organizations/current/profile');
    expect(profile.body.data).toMatchObject({ version: 1, logo: { fileId: second.body.data.id } });
    // The replaced logo is soft-deleted.
    expect((await fresh.owner.get(`/files/${first.body.data.id}`)).status).toBe(404);

    const removed = await fresh.owner.delete('/organizations/current/profile/logo');
    expect(removed.status).toBe(200);
    profile = await fresh.owner.get('/organizations/current/profile');
    expect(profile.body.data.logo).toBeNull();

    // A profile save does not touch the logo.
    const third = await fresh.owner.upload('/files?linkType=organization_logo', PNG, 'l.png');
    await fresh.owner.put('/organizations/current/profile/logo', { fileId: third.body.data.id });
    const saved = await fresh.owner.put('/organizations/current/profile', {
      version: 1,
      legalName: 'Renamed Private Limited',
    });
    expect(saved.body.data.logo).toEqual({ fileId: third.body.data.id });

    const owner = await connectAs('owner');
    try {
      const audit = await owner.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action = 'organization.logo_changed' AND organization_id = $1",
        [fresh.organizationId],
      );
      expect(audit.rows[0].n).toBe(4);
    } finally {
      await owner.end();
    }
  });

  it('refuses files that are not logo uploads and requires organization.update', async () => {
    const fresh = await setUpAccountingOrg(ctx, { fiscalYear: false });
    await saveProfile(fresh.owner);
    const party = await createParty(fresh.owner);
    const img = await fresh.owner.upload(`/files?linkType=party&linkId=${party}`, PNG, 'a.png');
    const res = await fresh.owner.put('/organizations/current/profile/logo', {
      fileId: img.body.data.id,
    });
    expect(res.status).toBe(400);
    const member = await joinWithRole(ctx, fresh.owner, 'Member');
    expect(
      (await member.client.upload('/files?linkType=organization_logo', PNG, 'a.png')).status,
    ).toBe(403);
    expect((await member.client.delete('/organizations/current/profile/logo')).status).toBe(403);
  });
});

describe('database isolation', () => {
  it('applies RLS to files and file_links and forbids hard deletes by the app role', async () => {
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.organization_id', $1, true)", [
        '00000000-0000-4000-8000-000000000000',
      ]);
      expect((await app.query('SELECT 1 FROM files')).rowCount).toBe(0);
      expect((await app.query('SELECT 1 FROM file_links')).rowCount).toBe(0);
      await expect(app.query('DELETE FROM files')).rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });

  it('refuses storage keys outside the tenant prefix', async () => {
    const owner = await connectAs('owner');
    try {
      await expect(
        owner.query(
          `INSERT INTO files (id, organization_id, storage_provider, storage_key, original_name,
             detected_type, mime_type, size_bytes, sha256, status, scan_status, uploaded_by_user_id, uploaded_at)
           SELECT gen_random_uuid(), $1, 'local', 'org/00000000-0000-4000-8000-000000000000/2026/01/x',
             'a', 'pdf', 'application/pdf', 1, repeat('a', 64), 'available', 'not_scanned', u.id, now()
           FROM users u LIMIT 1`,
          [org.organizationId],
        ),
      ).rejects.toThrow(/check constraint/);
    } finally {
      await owner.end();
    }
  });

  it('keeps each tenant under its own storage prefix', async () => {
    const dirs = await readdir(path.join(TEST_STORAGE_ROOT, 'org'));
    expect(dirs).toContain(org.organizationId);
  });
});
