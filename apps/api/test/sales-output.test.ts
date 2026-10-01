import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 3B steps 14–15: issued-document PDFs rendered from the frozen snapshot with PDFKit and
 * stored under legal hold (Decisions 21, 29, 43; D14), document email with the PDF attached by
 * file id (E4), and attachments on Sales documents. Runs in the serial project (job worker).
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

interface SalesOrg extends AccountingOrg {
  customerId: string;
}

async function salesOrg(): Promise<SalesOrg> {
  const org = await setUpAccountingOrg(ctx);
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
  const customer = await org.owner.post('/customers', {
    party: {
      kind: 'organization',
      displayName: 'ދިވެހި ރިސޯޓް Resort',
      email: 'accounts@resort.test',
      addresses: [{ kind: 'billing', line1: 'Orchid Magu', countryCode: 'MV' }],
    },
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  return { ...org, customerId: customer.body.data.id };
}

async function issuedInvoice(o: SalesOrg) {
  const created = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate: '2026-03-10',
    memo: 'ޝުކުރިއްޔާ — thank you',
    lines: [{ description: 'Snorkel trip ފަތަރު', quantity: '2', unitPrice: '750' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const issued = await o.owner.post(`/sales/invoices/${created.body.data.id}/issue`, {
    version: created.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data as { id: string; number: string; version: number };
}

/**
 * Runs the worker until `done` holds. Other test files leave queued jobs behind (the worker
 * claims across organizations, oldest first), so this never relies on an empty queue.
 */
async function runJobsUntil(done: () => Promise<boolean>) {
  for (let i = 0; i < 400; i += 1) {
    if (await done()) return;
    await ctx.worker.runOnce();
  }
  throw new Error('The jobs did not complete.');
}

const pdfReady = (client: TestClient, path: string) => async () =>
  (await client.get(`${path}/pdf`)).body.data?.status === 'ready';

async function download(client: TestClient, url: string) {
  const headers: Record<string, string> = {};
  if (client.sessionToken)
    headers.cookie = `${ctx.config.session.cookieName}=${client.sessionToken}`;
  return ctx.app.inject({ method: 'GET', url, headers });
}

async function withOwnerDb<T>(work: (db: Awaited<ReturnType<typeof connectAs>>) => Promise<T>) {
  const db = await connectAs('owner');
  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

describe('issued document PDFs (Decisions 21, 29; D14)', () => {
  it('renders the PDF from the snapshot after issue and keeps it under legal hold', async () => {
    const o = await salesOrg();
    const logo = await o.owner.upload('/files?linkType=organization_logo', PNG, 'logo.png');
    expect(logo.status, JSON.stringify(logo.body)).toBe(201);
    const inv = await issuedInvoice(o);
    const pending = await o.owner.get(`/sales/invoices/${inv.id}/pdf`);
    expect(pending.status, JSON.stringify(pending.body)).toBe(200);
    expect(pending.body.data).toMatchObject({ status: 'pending', fileId: null });

    await runJobsUntil(pdfReady(o.owner, `/sales/invoices/${inv.id}`));
    const ready = await o.owner.get(`/sales/invoices/${inv.id}/pdf`);
    expect(ready.body.data).toMatchObject({ status: 'ready' });
    const fileId = ready.body.data.fileId as string;
    const content = await download(o.owner, ready.body.data.download.url);
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(content.rawPayload.toString('latin1')).toContain('NotoSansThaana');

    // Legal hold: the issued PDF cannot be deleted, and it cannot be replaced.
    const del = await o.owner.delete(`/files/${fileId}`);
    expect(del.status).toBe(409);
    await withOwnerDb(async (db) => {
      const { rows } = await db.query(`SELECT legal_hold FROM files WHERE id = $1`, [fileId]);
      expect(rows[0].legal_hold).toBe(true);
      await expect(
        db.query(`UPDATE sales_invoices SET pdf_file_id = $2 WHERE id = $1`, [
          inv.id,
          logo.body.data.id,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      const audit = await db.query(
        `SELECT metadata FROM audit_events WHERE resource_id = $1 AND action = 'invoice.pdf_generated'`,
        [inv.id],
      );
      expect(audit.rows[0].metadata).toMatchObject({ fileId, renderer: 'pdfkit' });
    });
    // The job is idempotent: running it again does not create a second PDF.
    await ctx.worker.runOnce();
    expect((await o.owner.get(`/sales/invoices/${inv.id}/pdf`)).body.data.fileId).toBe(fileId);
    // The PDF is listed among the invoice's files.
    const files = await o.owner.get(`/files?linkType=invoice&linkId=${inv.id}`);
    expect(files.body.data.map((f: { id: string }) => f.id)).toContain(fileId);
  });

  it('produces PDFs only for issued documents, including credit notes', async () => {
    const o = await salesOrg();
    const draft = await o.owner.post('/sales/invoices', {
      customerId: o.customerId,
      invoiceDate: '2026-03-10',
      lines: [{ description: 'x', quantity: '1', unitPrice: '10' }],
    });
    expect((await o.owner.get(`/sales/invoices/${draft.body.data.id}/pdf`)).status).toBe(409);
    const note = await o.owner.post('/sales/credit-notes', {
      customerId: o.customerId,
      creditDate: '2026-03-12',
      lines: [{ description: 'Goodwill', quantity: '1', unitPrice: '25' }],
    });
    const issued = await o.owner.post(`/sales/credit-notes/${note.body.data.id}/issue`, {
      version: note.body.data.version,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    await runJobsUntil(pdfReady(o.owner, `/sales/credit-notes/${note.body.data.id}`));
    const pdf = await o.owner.get(`/sales/credit-notes/${note.body.data.id}/pdf`);
    expect(pdf.body.data.status).toBe('ready');
  });
});

describe('document email (step 15, E4)', () => {
  it('emails the issued PDF to the customer through the provider', async () => {
    const o = await salesOrg();
    const inv = await issuedInvoice(o);
    const requested = await o.owner.post(`/sales/invoices/${inv.id}/email`, {
      message: 'Your invoice for March.',
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    await runJobsUntil(
      async () =>
        (await o.owner.get(`/sales/invoices/${inv.id}/emails`)).body.data[0]?.status === 'sent',
    );
    const sent = ctx.email.lastTo('accounts@resort.test');
    expect(sent).toMatchObject({
      subject: `Invoice ${inv.number}`,
      template: 'sales.invoice',
    });
    const pdf = (await o.owner.get(`/sales/invoices/${inv.id}/pdf`)).body.data;
    expect(sent!.attachments).toEqual([
      { fileId: pdf.fileId, fileName: `${inv.number}.pdf`, contentType: 'application/pdf' },
    ]);
    const log = (await o.owner.get(`/sales/invoices/${inv.id}/emails`)).body.data;
    expect(log).toMatchObject([{ recipient: 'accounts@resort.test', status: 'sent' }]);
  });

  it('needs an issued document, an address and invoices.issue', async () => {
    const o = await salesOrg();
    const draft = await o.owner.post('/sales/invoices', {
      customerId: o.customerId,
      invoiceDate: '2026-03-10',
      lines: [{ description: 'x', quantity: '1', unitPrice: '10' }],
    });
    expect((await o.owner.post(`/sales/invoices/${draft.body.data.id}/email`, {})).status).toBe(
      409,
    );
    const inv = await issuedInvoice(o);
    expect(
      (await o.owner.post(`/sales/invoices/${inv.id}/email`, { to: 'not-an-email' })).status,
    ).toBe(400);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get(`/sales/invoices/${inv.id}/pdf`)).status).toBe(200);
    expect((await member.client.post(`/sales/invoices/${inv.id}/email`, {})).status).toBe(403);
  });
});

describe('attachments on Sales documents', () => {
  it('attaches files to drafts and keeps them once issued', async () => {
    const o = await salesOrg();
    const draft = await o.owner.post('/sales/invoices', {
      customerId: o.customerId,
      invoiceDate: '2026-03-10',
      lines: [{ description: 'x', quantity: '1', unitPrice: '10' }],
    });
    const id = draft.body.data.id as string;
    const removable = await o.owner.upload(`/files?linkType=invoice&linkId=${id}`, PNG, 'po.png');
    expect(removable.status, JSON.stringify(removable.body)).toBe(201);
    expect((await o.owner.delete(`/files/${removable.body.data.id}`)).status).toBe(204);
    const kept = await o.owner.upload(`/files?linkType=invoice&linkId=${id}`, PNG, 'po2.png');
    await o.owner.post(`/sales/invoices/${id}/issue`, { version: draft.body.data.version });
    expect((await o.owner.delete(`/files/${kept.body.data.id}`)).status).toBe(409);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (await member.client.upload(`/files?linkType=invoice&linkId=${id}`, PNG, 'm.png')).status,
    ).toBe(403);
  });
});
