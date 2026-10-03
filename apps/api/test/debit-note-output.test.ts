import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 4B-1 (ADR 0004 P4-23, P4-46): a posted debit note gets an immutable PDF rendered from its
 * frozen snapshot by the shared PDF provider and stored under legal hold, and can be emailed to the
 * vendor through the email provider with the PDF attached. Supplier credit notes are received
 * documents and get no generated PDF. Serial: drives the job worker.
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

interface Org extends AccountingOrg {
  vendorId: string;
}

async function purchasesOrg(): Promise<Org> {
  const org = await setUpAccountingOrg(ctx);
  const settings = await org.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: org.accounts['2110'],
    defaultExpenseAccountId: org.accounts['5400'],
    defaultPaymentAccountId: null,
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'no_tax',
    defaultPaymentTermsDays: 30,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const vendor = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Supplies', email: 'ap@island.test' },
  });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  return { ...org, vendorId: vendor.body.data.id };
}

async function postedCredit(o: Org, origin: 'debit_note' | 'supplier_credit_note') {
  const created = await o.owner.post('/purchases/vendor-credits', {
    origin,
    vendorId: o.vendorId,
    creditDate: '2026-03-12',
    ...(origin === 'supplier_credit_note'
      ? { vendorReference: `CN-${randomUUID().slice(0, 6)}` }
      : {}),
    lines: [{ description: 'Short delivery', quantity: '2', unitPrice: '25' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const posted = await o.owner.post(`/purchases/vendor-credits/${created.body.data.id}/post`, {
    version: created.body.data.version,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return posted.body.data as { id: string; number: string; version: number };
}

/** Runs the worker until `done` holds (other files may leave queued jobs behind). */
async function runJobsUntil(done: () => Promise<boolean>) {
  for (let i = 0; i < 400; i += 1) {
    if (await done()) return;
    await ctx.worker.runOnce();
  }
  throw new Error('The jobs did not complete.');
}

async function download(client: TestClient, url: string) {
  const headers: Record<string, string> = {};
  if (client.sessionToken) {
    headers.cookie = `${ctx.config.session.cookieName}=${client.sessionToken}`;
  }
  return ctx.app.inject({ method: 'GET', url, headers });
}

describe('debit-note PDF and email (P4-46)', () => {
  it('renders the debit note from its frozen snapshot under legal hold', async () => {
    const o = await purchasesOrg();
    const note = await postedCredit(o, 'debit_note');
    expect(note.number).toBe('DN-00001');
    const path = `/purchases/vendor-credits/${note.id}`;
    expect((await o.owner.get(`${path}/pdf`)).body.data).toMatchObject({ status: 'pending' });
    await runJobsUntil(
      async () => (await o.owner.get(`${path}/pdf`)).body.data?.status === 'ready',
    );
    const ready = (await o.owner.get(`${path}/pdf`)).body.data;
    const content = await download(o.owner, ready.download.url);
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const { rows } = await owner.query(
      `SELECT f.legal_hold, v.render_snapshot->>'documentType' AS type,
              v.render_snapshot->'customer'->>'displayName' AS addressee
         FROM files f JOIN purchases_vendor_credits v ON v.pdf_file_id = f.id WHERE v.id = $1`,
      [note.id],
    );
    expect(rows[0]).toEqual({ legal_hold: true, type: 'debit_note', addressee: 'Island Supplies' });
    // Legal hold: the PDF cannot be deleted or replaced.
    expect((await o.owner.delete(`/files/${ready.fileId}`)).status).toBe(409);
    await expect(
      owner.query(`UPDATE purchases_vendor_credits SET pdf_file_id = NULL WHERE id = $1`, [
        note.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const audit = await owner.query(
      `SELECT metadata FROM audit_events WHERE resource_id = $1 AND action = 'debit_note.pdf_generated'`,
      [note.id],
    );
    expect(audit.rows[0].metadata).toMatchObject({ fileId: ready.fileId, renderer: 'pdfkit' });
  });

  it('emails the debit note to the vendor with the PDF attached', async () => {
    const o = await purchasesOrg();
    const note = await postedCredit(o, 'debit_note');
    const path = `/purchases/vendor-credits/${note.id}`;
    const requested = await o.owner.post(`${path}/email`, {
      message: 'Please credit our account.',
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    await runJobsUntil(
      async () => (await o.owner.get(`${path}/emails`)).body.data[0]?.status === 'sent',
    );
    const sent = ctx.email.lastTo('ap@island.test');
    expect(sent).toMatchObject({
      subject: `Debit note ${note.number}`,
      template: 'purchases.debit_note',
    });
    const pdf = (await o.owner.get(`${path}/pdf`)).body.data;
    expect(sent!.attachments).toEqual([
      { fileId: pdf.fileId, fileName: `${note.number}.pdf`, contentType: 'application/pdf' },
    ]);
    // Sending needs vendor_credits.post; Members only view.
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get(`${path}/emails`)).status).toBe(200);
    expect((await member.client.post(`${path}/email`, {})).status).toBe(403);
  });

  it('gives supplier credit notes no generated PDF', async () => {
    const o = await purchasesOrg();
    const credit = await postedCredit(o, 'supplier_credit_note');
    expect(credit.number).toBe('VC-00001');
    expect((await o.owner.get(`/purchases/vendor-credits/${credit.id}/pdf`)).status).toBe(404);
    expect(
      (await o.owner.post(`/purchases/vendor-credits/${credit.id}/email`, { to: 'x@y.test' }))
        .status,
    ).toBe(404);
  });
});
