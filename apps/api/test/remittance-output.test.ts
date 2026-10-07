import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PdfkitRenderer } from '../src/infrastructure/pdf/pdf-renderer.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 4B-7 (ADR 0004 P4-46; decisions D1–D17): remittance advice PDF and email for vendor
 * payments. Output only: nothing here may create or change a journal, an accounting event, an
 * allocation or a balance. One advice per recorded payment; the content is frozen on the first
 * request; the PDF is generated on demand by a job, stored under legal hold and linked once.
 * Serial: drives the job worker.
 */

let ctx: TestContext;
let owner: pg.Client;
let app: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext();
  owner = await connectAs('owner');
  app = await connectAs('app');
});
afterAll(async () => {
  await app.end();
  await owner.end();
  await ctx.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const THAANA_NAME = 'ތިލަދުންމަތީ ސަޕްލައިސް';
const THAANA_ADDRESS = 'ހުޅުމާލެ';

interface Org extends AccountingOrg {
  vendorId: string;
}

async function purchasesOrg(
  options: { vendorEmail?: string | null; vendorName?: string } = {},
): Promise<Org> {
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
      displayName: options.vendorName ?? 'Island Supplies',
      ...(options.vendorEmail === null ? {} : { email: options.vendorEmail ?? 'ap@island.test' }),
      addresses: [
        {
          kind: 'billing',
          line1: 'Orchid Magu 4',
          city: 'Malé',
          countryCode: 'MV',
          isDefault: true,
        },
      ],
    },
  });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  return { ...org, vendorId: vendor.body.data.id };
}

async function rate(o: AccountingOrg, rateDate: string, value: string) {
  const res = await o.owner.post('/accounting/exchange-rates', {
    fromCurrency: 'USD',
    rateDate,
    rate: value,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

interface Doc {
  id: string;
  number: string;
  version: number;
}

async function bill(
  o: Org,
  amount: string,
  extra: Record<string, unknown> = {},
  vendorId = o.vendorId,
): Promise<Doc> {
  const created = await o.owner.post('/purchases/bills', {
    vendorId,
    billDate: '2026-03-10',
    vendorReference: `INV-${randomUUID().slice(0, 8)}`,
    lines: [{ description: 'Stock', quantity: '1', unitPrice: amount, taxCodeId: null }],
    ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const res = await o.owner.post(`/purchases/bills/${created.body.data.id}/post`, {
    version: created.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function pay(o: Org, body: Record<string, unknown>): Promise<Doc> {
  const draft = await o.owner.post('/purchases/payments', {
    vendorId: o.vendorId,
    paymentDate: '2026-03-20',
    allocations: [],
    ...body,
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const res = await o.owner.post(`/purchases/payments/${draft.body.data.id}/record`, {
    version: draft.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function voidPayment(o: AccountingOrg, id: string) {
  const current = await o.owner.get(`/purchases/payments/${id}`);
  const res = await o.owner.post(`/purchases/payments/${id}/void`, {
    version: current.body.data.version,
    reason: 'Entered in error',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
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

const path = (id: string) => `/purchases/payments/${id}/remittance`;

async function generate(o: Org, paymentId: string) {
  const res = await o.owner.post(path(paymentId), {});
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await runJobsUntil(async () => (await o.owner.get(path(paymentId))).body.data.status === 'ready');
  return (await o.owner.get(path(paymentId))).body.data as {
    status: string;
    fileId: string;
    download: { url: string };
  };
}

async function snapshotOf(paymentId: string) {
  const { rows } = await owner.query(
    `SELECT render_snapshot AS s, remittance_pdf_file_id AS f, version FROM purchases_payments WHERE id = $1`,
    [paymentId],
  );
  return rows[0] as { s: Record<string, any> | null; f: string | null; version: number };
}

/** Everything accounting owns, for the "output only" proofs. */
async function accountingState(o: AccountingOrg) {
  const { rows } = await owner.query(
    `SELECT
       (SELECT count(*) FROM accounting_journal_entries WHERE organization_id = $1)::int AS journals,
       (SELECT count(*) FROM accounting_events WHERE organization_id = $1)::int AS events,
       (SELECT count(*) FROM purchases_allocations WHERE organization_id = $1)::int AS allocations,
       (SELECT coalesce(sum(amount_due), 0) FROM purchases_bills WHERE organization_id = $1)::text AS bills_due,
       (SELECT coalesce(sum(base_due), 0) FROM purchases_bills WHERE organization_id = $1)::text AS bills_base,
       (SELECT coalesce(sum(amount) || '/' || coalesce(sum(amount_unallocated), 0), '0') FROM purchases_payments WHERE organization_id = $1) AS payments,
       (SELECT coalesce(sum(coalesce(l.base_credit,0) - coalesce(l.base_debit,0)), 0)::text
          FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id = l.account_id
         WHERE a.organization_id = $1 AND a.control_subledger = 'purchases') AS ap_gl`,
    [o.organizationId],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Renderer: the remittance layout (no database)
// ---------------------------------------------------------------------------

function remittanceFixture(lines: number, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    documentType: 'remittance_advice',
    number: 'PAY-00001',
    paymentDate: '2026-03-20',
    currencyCode: 'USD',
    amount: String(lines * 10 + 5),
    reference: 'WIRE-77',
    seller: {
      legalName: 'Atoll Trading Pvt Ltd',
      tradingName: null,
      tin: '1000234',
      gstRegistrationNumber: null,
      email: 'accounts@atoll.test',
      phone: null,
      logoFileId: null,
      address: {
        line1: 'Orchid Magu 4',
        line2: null,
        city: 'Malé',
        region: null,
        postalCode: null,
        countryCode: 'MV',
      },
    },
    vendor: {
      displayName: 'Island Supplies',
      companyName: null,
      email: 'ap@island.test',
      address: null,
    },
    lines: Array.from({ length: lines }, (_, i) => ({
      billNumber: `BILL-${String(i + 1).padStart(5, '0')}`,
      vendorReference: `SUP-${i + 1}`,
      billDate: '2026-03-01',
      billTotal: '100.00',
      amountPaid: '10.00',
    })),
    totals: { applied: String(lines * 10), advance: '5.00', total: String(lines * 10 + 5) },
    ...extra,
  } as Record<string, unknown>;
}

const pageCount = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;

describe('remittance renderer', () => {
  const renderer = new PdfkitRenderer();

  it('renders one bill, several bills, a partial payment and an advance-only payment', async () => {
    for (const lines of [0, 1, 3]) {
      const pdf = await renderer.render(remittanceFixture(lines));
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pageCount(pdf)).toBe(1);
    }
    // A foreign-currency payment prints its own currency and no base amounts.
    const usd = await renderer.render(remittanceFixture(2, { currencyCode: 'USD' }));
    expect(usd.length).toBeGreaterThan(1000);
  });

  it('is deterministic: the same snapshot renders the same bytes', async () => {
    const snapshot = remittanceFixture(12);
    const a = await renderer.render(snapshot);
    const b = await renderer.render(snapshot);
    expect(a.equals(b)).toBe(true);
    // And it differs when the content differs.
    expect((await renderer.render(remittanceFixture(13))).equals(a)).toBe(false);
  });

  it('renders 497 bills across several pages, repeating the header', async () => {
    const pdf = await renderer.render(remittanceFixture(497));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(10);
    expect(pageCount(pdf)).toBeLessThanOrEqual(14);
    expect((await renderer.render(remittanceFixture(497))).equals(pdf)).toBe(true);
  });

  it('renders Thaana and mixed-script names, addresses and references', async () => {
    const snapshot = remittanceFixture(3, {
      vendor: {
        displayName: `${THAANA_NAME} Atoll ސަޕްލައިސް`,
        companyName: THAANA_NAME,
        email: null,
        address: {
          line1: THAANA_ADDRESS,
          line2: 'Henveiru Magu',
          city: 'ހުޅުމާލެ',
          region: null,
          postalCode: null,
          countryCode: 'MV',
        },
      },
      reference: `ޗެކް ${THAANA_ADDRESS} 77`,
    });
    (snapshot.lines as { vendorReference: string }[])[0]!.vendorReference =
      `INV ${THAANA_ADDRESS} 1`;
    const pdf = await renderer.render(snapshot);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // The Thaana font is embedded.
    expect(pdf.toString('latin1')).toContain('NotoSansThaana');
    expect((await renderer.render(snapshot)).equals(pdf)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generation (D2–D6)
// ---------------------------------------------------------------------------

describe('remittance advice generation', () => {
  it('freezes the content on the first request and stores the PDF under legal hold', async () => {
    const o = await purchasesOrg({ vendorName: `Island ${THAANA_NAME}` });
    const b = await bill(o, '100');
    const p = await pay(o, {
      amount: '100',
      reference: 'WIRE-1',
      allocations: [{ billId: b.id, amount: '100' }],
    });
    const before = await snapshotOf(p.id);
    expect(before).toMatchObject({ s: null, f: null });
    expect((await o.owner.get(path(p.id))).body.data).toMatchObject({
      status: 'none',
      fileId: null,
    });
    const state = await accountingState(o);

    // Not generated automatically on record (D5); the first request freezes and queues.
    const res = await o.owner.post(path(p.id), {});
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'pending' });
    const frozen = await snapshotOf(p.id);
    expect(frozen.s).toMatchObject({
      documentType: 'remittance_advice',
      number: p.number,
      paymentDate: '2026-03-20',
      currencyCode: 'MVR',
      amount: '100.00',
      reference: 'WIRE-1',
      totals: { applied: '100.00', advance: '0.00', total: '100.00' },
      vendor: { displayName: `Island ${THAANA_NAME}`, email: 'ap@island.test' },
    });
    expect(frozen.s!.vendor.address).toMatchObject({ line1: 'Orchid Magu 4', city: 'Malé' });
    expect(frozen.s!.lines).toEqual([
      {
        billNumber: b.number,
        vendorReference: expect.stringMatching(/^INV-/),
        billDate: '2026-03-10',
        billTotal: '100.00',
        amountPaid: '100.00',
      },
    ]);
    // Output state is not an edit of the payment: its version is unchanged.
    expect(frozen.version).toBe(before.version);
    // D3/D17: no base amounts, FX, payment account or bank details in the frozen content.
    const text = JSON.stringify(frozen.s);
    for (const forbidden of [
      'baseAmount',
      'realizedFx',
      'exchangeRate',
      'paymentAccount',
      'bank',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    // A second request while the job is pending creates no second job.
    const again = await o.owner.post(path(p.id), {});
    expect(again.body.data).toMatchObject({ status: 'pending', jobId: res.body.data.jobId });

    await runJobsUntil(async () => (await o.owner.get(path(p.id))).body.data.status === 'ready');
    const ready = (await o.owner.get(path(p.id))).body.data;
    const content = await download(o.owner, ready.download.url);
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const { rows } = await owner.query(
      `SELECT f.legal_hold, f.original_name, l.link_type, l.link_id
         FROM files f JOIN file_links l ON l.file_id = f.id WHERE f.id = $1`,
      [ready.fileId],
    );
    expect(rows[0]).toEqual({
      legal_hold: true,
      original_name: `${p.number}-remittance.pdf`,
      link_type: 'vendor_payment',
      link_id: p.id,
    });
    // Legal hold and set-once: the PDF cannot be deleted, replaced or cleared.
    expect((await o.owner.delete(`/files/${ready.fileId}`)).status).toBe(409);
    await expect(
      owner.query(`UPDATE purchases_payments SET remittance_pdf_file_id = NULL WHERE id = $1`, [
        p.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    // Requesting again after it is ready is a no-op: no new job, same file, same snapshot.
    const done = await o.owner.post(path(p.id), {});
    expect(done.body.data).toMatchObject({ status: 'ready', jobId: null });
    expect((await snapshotOf(p.id)).f).toBe(ready.fileId);
    expect((await snapshotOf(p.id)).s).toEqual(frozen.s);
    // Audit: requested, then generated (system), without the vendor's address.
    const audit = await owner.query(
      `SELECT action, metadata FROM audit_events WHERE resource_id = $1 AND action LIKE 'vendor_payment.remittance_%' ORDER BY occurred_at, id`,
      [p.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'vendor_payment.remittance_requested',
      'vendor_payment.remittance_generated',
    ]);
    expect(audit.rows[1].metadata).toMatchObject({ fileId: ready.fileId, renderer: 'pdfkit' });
    // Output only: accounting is exactly as it was.
    expect(await accountingState(o)).toEqual(state);
  });

  it('shows the bills this payment settled: multi-bill, partial and advance', async () => {
    const o = await purchasesOrg();
    const b1 = await bill(o, '100');
    const b2 = await bill(o, '300');
    const b3 = await bill(o, '50');
    const p = await pay(o, {
      amount: '250',
      allocations: [
        { billId: b1.id, amount: '100' },
        { billId: b2.id, amount: '120' },
      ],
    });
    await generate(o, p.id);
    const { s } = await snapshotOf(p.id);
    expect(
      s!.lines.map((l: { billNumber: string; billTotal: string; amountPaid: string }) => [
        l.billNumber,
        l.billTotal,
        l.amountPaid,
      ]),
    ).toEqual([
      [b1.number, '100.00', '100.00'],
      [b2.number, '300.00', '120.00'],
    ]);
    // 30 of the 250 was not allocated when it was recorded: an advance.
    expect(s!.totals).toEqual({ applied: '220.00', advance: '30.00', total: '250.00' });
    expect(s!.lines.some((l: { billNumber: string }) => l.billNumber === b3.number)).toBe(false);
  });

  it('gives a prepayment (no bills) an advance and no invented bill row (D14)', async () => {
    const o = await purchasesOrg();
    const p = await pay(o, { amount: '400' });
    const ready = await generate(o, p.id);
    const { s } = await snapshotOf(p.id);
    expect(s!.lines).toEqual([]);
    expect(s!.totals).toEqual({ applied: '0.00', advance: '400.00', total: '400.00' });
    expect((await download(o.owner, ready.download.url)).rawPayload.subarray(0, 5).toString()).toBe(
      '%PDF-',
    );
  });

  it('leaves out later prepayment applications and refunds, and the base and FX (D3)', async () => {
    const o = await purchasesOrg();
    const b = await bill(o, '100');
    const b2 = await bill(o, '60');
    // 200: 100 to the bill now, 100 left as a prepayment that is applied and refunded afterwards.
    const p = await pay(o, { amount: '200', allocations: [{ billId: b.id, amount: '100' }] });
    const applied = await o.owner.post('/purchases/credit-applications', {
      sourceType: 'payment',
      sourceId: p.id,
      date: '2026-03-25',
      allocations: [{ billId: b2.id, amount: '60' }],
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const refund = await o.owner.post('/purchases/refunds', {
      sourceType: 'payment',
      sourceId: p.id,
      refundDate: '2026-03-26',
      amount: '10',
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    // The first request comes after both: the content is still the payment's own allocations.
    await generate(o, p.id);
    const { s } = await snapshotOf(p.id);
    expect(s!.lines).toHaveLength(1);
    expect(s!.lines[0]).toMatchObject({ billNumber: b.number, amountPaid: '100.00' });
    expect(s!.totals).toEqual({ applied: '100.00', advance: '100.00', total: '200.00' });
  });

  it('prints a foreign-currency payment in its own currency, without base or FX', async () => {
    const o = await purchasesOrg();
    await rate(o, '2026-03-01', '15.40');
    await rate(o, '2026-03-15', '15.50');
    const b = await bill(o, '100', { currencyCode: 'USD' });
    const p = await pay(o, {
      currencyCode: 'USD',
      paymentDate: '2026-03-16',
      amount: '60',
      allocations: [{ billId: b.id, amount: '60' }],
    });
    // The payment really realized FX; the advice must not show it.
    const fx = await owner.query(
      `SELECT sum(fx_difference)::text AS fx FROM purchases_allocations WHERE payment_id = $1`,
      [p.id],
    );
    expect(Number(fx.rows[0].fx)).not.toBe(0);
    await generate(o, p.id);
    const { s } = await snapshotOf(p.id);
    expect(s).toMatchObject({
      currencyCode: 'USD',
      amount: '60.00',
      totals: { applied: '60.00', advance: '0.00', total: '60.00' },
    });
    expect(s!.lines[0]).toMatchObject({ billTotal: '100.00', amountPaid: '60.00' });
    const text = JSON.stringify(s);
    for (const forbidden of [
      'baseAmount',
      'realizedFx',
      'fxDifference',
      'exchangeRate',
      '15.4',
      '15.5',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('gives a batch-created payment its own advice and no batch-level document (D2)', async () => {
    const o = await purchasesOrg();
    const other = await vendor(o, 'Blue Lagoon Imports');
    const b1 = await bill(o, '80');
    const b2 = await bill(o, '45', {}, other);
    const batch = await o.owner.post('/purchases/payment-batches', {
      paymentDate: '2026-03-20',
      bills: [
        { billId: b1.id, amount: '80' },
        { billId: b2.id, amount: '45' },
      ],
    });
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    const [first, second] = batch.body.data.payments as { id: string; vendorId: string }[];
    await generate(o, first!.id);
    // Each payment is addressed individually; the other batch payment has none yet.
    expect((await o.owner.get(path(second!.id))).body.data.status).toBe('none');
    expect((await snapshotOf(second!.id)).s).toBeNull();
    expect(
      (await o.owner.post(`/purchases/payment-batches/${batch.body.data.id}/remittance`, {}))
        .status,
    ).toBe(404);
    expect(
      (await o.owner.get(`/purchases/payment-batches/${batch.body.data.id}/remittance`)).status,
    ).toBe(404);
  });

  it('refuses a draft payment and a voided one; an existing PDF stays (D6)', async () => {
    const o = await purchasesOrg();
    const b = await bill(o, '100');
    // A draft is not recorded.
    const draft = await o.owner.post('/purchases/payments', {
      vendorId: o.vendorId,
      paymentDate: '2026-03-20',
      amount: '10',
      allocations: [],
    });
    expect((await o.owner.post(path(draft.body.data.id), {})).status).toBe(409);
    expect((await o.owner.post(`${path(draft.body.data.id)}/email`, {})).status).toBe(409);

    // A voided payment with no advice yet gets none and nothing is frozen.
    const unseen = await pay(o, { amount: '30', allocations: [{ billId: b.id, amount: '30' }] });
    await voidPayment(o, unseen.id);
    const refused = await o.owner.post(path(unseen.id), {});
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect((await o.owner.post(`${path(unseen.id)}/email`, {})).status).toBe(409);
    expect(await snapshotOf(unseen.id)).toMatchObject({ s: null, f: null });
    await expect(
      owner.query(`UPDATE purchases_payments SET render_snapshot = '{}'::jsonb WHERE id = $1`, [
        unseen.id,
      ]),
    ).rejects.toThrow();

    // A payment that has its advice keeps it after the void: downloadable, never regenerated.
    const seen = await pay(o, { amount: '40', allocations: [{ billId: b.id, amount: '40' }] });
    const ready = await generate(o, seen.id);
    const keptSnapshot = (await snapshotOf(seen.id)).s;
    await voidPayment(o, seen.id);
    const afterVoid = (await o.owner.get(path(seen.id))).body.data;
    expect(afterVoid).toMatchObject({ status: 'ready', fileId: ready.fileId });
    expect((await download(o.owner, afterVoid.download.url)).statusCode).toBe(200);
    expect((await o.owner.post(path(seen.id), {})).status).toBe(409);
    expect((await o.owner.post(`${path(seen.id)}/email`, {})).status).toBe(409);
    expect(await snapshotOf(seen.id)).toMatchObject({ f: ready.fileId, s: keptSnapshot });
    // The 0036 guard still makes a void payment wholly immutable.
    await expect(
      owner.query(`UPDATE purchases_payments SET remittance_pdf_file_id = NULL WHERE id = $1`, [
        seen.id,
      ]),
    ).rejects.toThrow();
  });

  it('retries a failed PDF job under the next deterministic key (failed state)', async () => {
    const o = await purchasesOrg();
    const b = await bill(o, '70');
    const p = await pay(o, { amount: '70', allocations: [{ billId: b.id, amount: '70' }] });
    const render = vi
      .spyOn(PdfkitRenderer.prototype, 'render')
      .mockRejectedValue(new Error('boom'));
    const requested = await o.owner.post(path(p.id), {});
    expect(requested.status).toBe(202);
    const frozen = (await snapshotOf(p.id)).s;
    // Exhaust the retries: bring each retry forward instead of waiting out the backoff.
    for (let i = 0; i < 8; i += 1) {
      await owner.query(`UPDATE jobs SET run_after = now() WHERE status = 'queued'`);
      await ctx.worker.runOnce();
      if ((await o.owner.get(path(p.id))).body.data.status === 'failed') break;
    }
    expect((await o.owner.get(path(p.id))).body.data.status).toBe('failed');
    expect(render).toHaveBeenCalled();
    // The frozen content is untouched and a new request retries.
    expect((await snapshotOf(p.id)).s).toEqual(frozen);
    vi.restoreAllMocks();
    const retry = await o.owner.post(path(p.id), {});
    expect(retry.body.data.status).toBe('pending');
    const keys = await owner.query(
      `SELECT job_key FROM jobs WHERE type = 'purchases.remittance_pdf' AND payload->>'paymentId' = $1 ORDER BY created_at`,
      [p.id],
    );
    expect(keys.rows.map((r) => r.job_key)).toEqual([`remittance:${p.id}`, `remittance:${p.id}:2`]);
    await runJobsUntil(async () => (await o.owner.get(path(p.id))).body.data.status === 'ready');
    expect((await snapshotOf(p.id)).s).toEqual(frozen);
  });
});

async function vendor(o: AccountingOrg, displayName: string) {
  const res = await o.owner.post('/vendors', {
    party: { kind: 'organization', displayName, email: `${randomUUID().slice(0, 6)}@vendor.test` },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

// ---------------------------------------------------------------------------
// Email (D8, D12, D13, D16)
// ---------------------------------------------------------------------------

describe('remittance advice email', () => {
  it('sends the PDF to the vendor, records the request and keeps addresses out of the audit', async () => {
    const o = await purchasesOrg();
    const b = await bill(o, '100');
    const p = await pay(o, { amount: '100', allocations: [{ billId: b.id, amount: '100' }] });
    const state = await accountingState(o);
    const requested = await o.owner.post(`${path(p.id)}/email`, { message: 'Paid by transfer.' });
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    // Asking for the email froze the content (D4), without generating a PDF first.
    expect((await snapshotOf(p.id)).s).not.toBeNull();
    await runJobsUntil(
      async () => (await o.owner.get(`${path(p.id)}/emails`)).body.data[0]?.status === 'sent',
    );
    const sent = ctx.email.lastTo('ap@island.test');
    const ready = (await o.owner.get(path(p.id))).body.data;
    expect(sent).toMatchObject({
      subject: `Remittance advice ${p.number}`,
      template: 'purchases.remittance_advice',
    });
    expect(sent!.text).toContain('Paid by transfer.');
    expect(sent!.attachments).toEqual([
      {
        fileId: ready.fileId,
        fileName: `${p.number}-remittance.pdf`,
        contentType: 'application/pdf',
      },
    ]);
    const list = (await o.owner.get(`${path(p.id)}/emails`)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ recipient: 'ap@island.test', status: 'sent' });
    // The address is on the email row only.
    const audit = await owner.query(
      `SELECT action, metadata::text AS metadata FROM audit_events WHERE resource_id = $1 AND action LIKE 'vendor_payment.remittance_%' ORDER BY occurred_at, id`,
      [p.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'vendor_payment.remittance_email_requested',
      'vendor_payment.remittance_generated',
      'vendor_payment.remittance_emailed',
    ]);
    for (const row of audit.rows) expect(row.metadata).not.toContain('ap@island.test');
    // Output only.
    expect(await accountingState(o)).toEqual(state);
  });

  it('prefills the vendor email, accepts a typed one, and rejects blank or invalid ones (D16)', async () => {
    const o = await purchasesOrg({ vendorEmail: null });
    const b = await bill(o, '100');
    const p = await pay(o, { amount: '100', allocations: [{ billId: b.id, amount: '100' }] });
    // A vendor without an email never blocks the advice itself.
    await generate(o, p.id);
    const none = await o.owner.post(`${path(p.id)}/email`, {});
    expect(none.status).toBe(400);
    expect(none.body.error.details.issues).toEqual([
      { path: 'to', message: 'Enter the email address to send to.' },
    ]);
    for (const to of ['', 'not-an-email', 'a@b', ' ']) {
      expect((await o.owner.post(`${path(p.id)}/email`, { to })).status, to).toBe(400);
    }
    // Strict bodies, subject and message limits.
    for (const body of [
      { to: 'x@y.test', extra: 1 },
      { to: 'x@y.test', subject: '' },
      { to: 'x@y.test', subject: 's'.repeat(201) },
      { to: 'x@y.test', message: 'm'.repeat(4001) },
      { to: ['a@b.test', 'c@d.test'] },
    ]) {
      expect(
        (await o.owner.post(`${path(p.id)}/email`, body)).status,
        JSON.stringify(body).slice(0, 40),
      ).toBe(400);
    }
    const ok = await o.owner.post(`${path(p.id)}/email`, {
      to: 'Accounts@Vendor.Test',
      subject: 'S'.repeat(200),
      message: 'm'.repeat(4000),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    await runJobsUntil(
      async () => (await o.owner.get(`${path(p.id)}/emails`)).body.data[0]?.status === 'sent',
    );
    expect(ctx.email.lastTo('accounts@vendor.test')).toBeDefined();
    // And a vendor with an email is prefilled.
    const withEmail = await purchasesOrg();
    const b2 = await bill(withEmail, '50');
    const p2 = await pay(withEmail, {
      amount: '50',
      allocations: [{ billId: b2.id, amount: '50' }],
    });
    const prefilled = await withEmail.owner.post(`${path(p2.id)}/email`, {});
    expect(prefilled.status).toBe(202);
    expect((await withEmail.owner.get(`${path(p2.id)}/emails`)).body.data[0].recipient).toBe(
      'ap@island.test',
    );
  });

  it('treats every explicit send as a new audited request (D13)', async () => {
    const o = await purchasesOrg();
    const b = await bill(o, '100');
    const p = await pay(o, { amount: '100', allocations: [{ billId: b.id, amount: '100' }] });
    const first = await o.owner.post(`${path(p.id)}/email`, { to: 'one@vendor.test' });
    const second = await o.owner.post(`${path(p.id)}/email`, { to: 'one@vendor.test' });
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(first.body.data.id).not.toBe(second.body.data.id);
    await runJobsUntil(async () => {
      const list = (await o.owner.get(`${path(p.id)}/emails`)).body.data as { status: string }[];
      return list.length === 2 && list.every((e) => e.status === 'sent');
    });
    expect(ctx.email.sent.filter((m) => m.to === 'one@vendor.test')).toHaveLength(2);
    // One PDF serves both: the file is linked once.
    const files = await owner.query(
      `SELECT count(*)::int AS n FROM file_links WHERE link_type = 'vendor_payment' AND link_id = $1`,
      [p.id],
    );
    expect(files.rows[0].n).toBe(1);
  });

  it('keeps the PDF when a send fails, retries, and never repeats accounting', async () => {
    const o = await purchasesOrg();
    const b = await bill(o, '100');
    const p = await pay(o, { amount: '100', allocations: [{ billId: b.id, amount: '100' }] });
    const ready = await generate(o, p.id);
    const state = await accountingState(o);
    const send = vi.spyOn(ctx.email, 'send').mockRejectedValueOnce(new Error('smtp down'));
    const requested = await o.owner.post(`${path(p.id)}/email`, { to: 'retry@vendor.test' });
    expect(requested.status).toBe(202);
    await ctx.worker.runOnce();
    // The first attempt failed: nothing was sent, the request is still queued, the PDF is intact.
    expect((await o.owner.get(`${path(p.id)}/emails`)).body.data[0].status).toBe('queued');
    expect((await o.owner.get(path(p.id))).body.data).toMatchObject({
      status: 'ready',
      fileId: ready.fileId,
    });
    expect(ctx.email.lastTo('retry@vendor.test')).toBeUndefined();
    // The retry (backoff brought forward) sends it with the same PDF.
    await owner.query(`UPDATE jobs SET run_after = now() WHERE status = 'queued'`);
    await runJobsUntil(
      async () => (await o.owner.get(`${path(p.id)}/emails`)).body.data[0]?.status === 'sent',
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(ctx.email.lastTo('retry@vendor.test')!.attachments![0]!.fileId).toBe(ready.fileId);
    expect((await snapshotOf(p.id)).f).toBe(ready.fileId);
    expect(await accountingState(o)).toEqual(state);
  });

  it('may leave a request queued when its job dies, with the PDF available (D12)', async () => {
    const o = await purchasesOrg();
    const b = await bill(o, '100');
    const p = await pay(o, { amount: '100', allocations: [{ billId: b.id, amount: '100' }] });
    const ready = await generate(o, p.id);
    vi.spyOn(ctx.email, 'send').mockRejectedValue(new Error('smtp down'));
    await o.owner.post(`${path(p.id)}/email`, { to: 'dead@vendor.test' });
    for (let i = 0; i < 8; i += 1) {
      await owner.query(`UPDATE jobs SET run_after = now() WHERE status = 'queued'`);
      await ctx.worker.runOnce();
    }
    const job = await owner.query(
      `SELECT status FROM jobs WHERE type = 'purchases.remittance_email' AND payload->>'paymentId' = $1`,
      [p.id],
    );
    expect(job.rows[0].status).toBe('dead');
    // The documented limitation: the row is still "queued"; the advice is still downloadable.
    expect((await o.owner.get(`${path(p.id)}/emails`)).body.data[0].status).toBe('queued');
    expect((await o.owner.get(path(p.id))).body.data).toMatchObject({
      status: 'ready',
      fileId: ready.fileId,
    });
  });

  it('does not send an email for a payment voided after the request (D6)', async () => {
    const o = await purchasesOrg();
    const b = await bill(o, '100');
    const p = await pay(o, { amount: '100', allocations: [{ billId: b.id, amount: '100' }] });
    expect((await o.owner.post(`${path(p.id)}/email`, { to: 'late@vendor.test' })).status).toBe(
      202,
    );
    await voidPayment(o, p.id);
    for (let i = 0; i < 5; i += 1) await ctx.worker.runOnce();
    expect((await o.owner.get(`${path(p.id)}/emails`)).body.data[0].status).toBe('failed');
    expect(ctx.email.lastTo('late@vendor.test')).toBeUndefined();
    expect((await snapshotOf(p.id)).f).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Permissions, tenants and the database (D7, D8, D9)
// ---------------------------------------------------------------------------

describe('remittance access and guards', () => {
  it('splits view from create, rechecks the permission when a job runs, and isolates tenants', async () => {
    const o = await purchasesOrg();
    const b = await bill(o, '100');
    const p = await pay(o, { amount: '100', allocations: [{ billId: b.id, amount: '100' }] });
    const ready = await generate(o, p.id);

    // Members hold vendor_payments.view: they see and download, but cannot generate or email.
    const member = await joinWithRole(ctx, o.owner, 'Member');
    const seen = await member.client.get(path(p.id));
    expect(seen.status).toBe(200);
    expect((await download(member.client, seen.body.data.download.url)).statusCode).toBe(200);
    expect((await member.client.get(`${path(p.id)}/emails`)).status).toBe(200);
    expect((await member.client.post(path(p.id), {})).status).toBe(403);
    expect((await member.client.post(`${path(p.id)}/email`, {})).status).toBe(403);

    // Without vendor_payments.view nothing is readable.
    const blind = await o.owner.post('/organizations/current/roles', {
      name: 'Bill viewer',
      permissionKeys: ['bills.view'],
    });
    expect(blind.status).toBe(201);
    const noView = await joinWithRole(ctx, o.owner, 'Bill viewer');
    expect((await noView.client.get(path(p.id))).status).toBe(403);
    expect((await noView.client.get(`${path(p.id)}/emails`)).status).toBe(403);
    expect((await noView.client.post(path(p.id), {})).status).toBe(403);
    expect((await noView.client.get(`/files/${ready.fileId}/download-url`)).status).toBe(403);

    // The job re-checks the requester's permission when it runs.
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Remittance clerk',
      permissionKeys: ['vendor_payments.view', 'vendor_payments.create'],
    });
    expect(role.status).toBe(201);
    const clerk = await joinWithRole(ctx, o.owner, 'Remittance clerk');
    const queued = await clerk.client.post(`${path(p.id)}/email`, { to: 'clerk@vendor.test' });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const updated = await o.owner.put(`/organizations/current/roles/${role.body.data.id}`, {
      name: 'Remittance clerk',
      permissionKeys: ['vendor_payments.view'],
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    for (let i = 0; i < 5; i += 1) await ctx.worker.runOnce();
    expect(ctx.email.lastTo('clerk@vendor.test')).toBeUndefined();
    expect((await o.owner.get(`${path(p.id)}/emails`)).body.data[0].status).toBe('failed');

    // Another tenant sees none of it.
    const other = await purchasesOrg();
    for (const [method, url] of [
      ['get', path(p.id)],
      ['get', `${path(p.id)}/emails`],
      ['post', path(p.id)],
      ['post', `${path(p.id)}/email`],
    ] as const) {
      const res = method === 'get' ? await other.owner.get(url) : await other.owner.post(url, {});
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    // A download link is bound to its tenant and user.
    const stolen = await download(other.owner, ready.download.url);
    expect(stolen.statusCode).not.toBe(200);
    expect((await other.owner.get(`/files/${ready.fileId}/download-url`)).status).toBe(404);

    // Strict generate body; unknown fields are refused.
    expect((await o.owner.post(path(p.id), { force: true })).status).toBe(400);
    // Uploads to a payment are not allowed: its only file is the generated PDF.
    const principal = (await ctx.services.auth.authenticate(o.owner.sessionToken!, {
      requestId: 'remittance-upload',
      ipAddress: null,
      userAgent: 'vitest',
    }))!;
    await expect(
      ctx.services.files.authorizeUpload(principal, 'vendor_payment', p.id),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('guards the output columns and the email table in the database', async () => {
    const o = await purchasesOrg();
    const b = await bill(o, '100');
    const p = await pay(o, { amount: '100', allocations: [{ billId: b.id, amount: '100' }] });
    const draft = await o.owner.post('/purchases/payments', {
      vendorId: o.vendorId,
      paymentDate: '2026-03-20',
      amount: '10',
      allocations: [],
    });
    // Only a recorded payment receives output; a draft is refused by the CHECK.
    await expect(
      owner.query(`UPDATE purchases_payments SET render_snapshot = '{}'::jsonb WHERE id = $1`, [
        draft.body.data.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    // A PDF needs its snapshot; the snapshot is set once and never changes.
    await generate(o, p.id);
    const frozen = (await snapshotOf(p.id)).s;
    await expect(
      owner.query(
        `UPDATE purchases_payments SET render_snapshot = '{"x":1}'::jsonb WHERE id = $1`,
        [p.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`UPDATE purchases_payments SET render_snapshot = NULL WHERE id = $1`, [p.id]),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await snapshotOf(p.id)).s).toEqual(frozen);
    const second = await pay(o, { amount: '20' });
    // A PDF needs its snapshot first (the CHECK) ...
    await expect(
      owner.query(
        `UPDATE purchases_payments SET remittance_pdf_file_id = gen_random_uuid() WHERE id = $1`,
        [second.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // ... and must be a file of the payment's own organization (the composite key).
    await owner.query(`UPDATE purchases_payments SET render_snapshot = '{}'::jsonb WHERE id = $1`, [
      second.id,
    ]);
    await expect(
      owner.query(
        `UPDATE purchases_payments SET remittance_pdf_file_id = gen_random_uuid() WHERE id = $1`,
        [second.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // The 0036 immutability of the payment itself is untouched.
    await expect(
      owner.query(`UPDATE purchases_payments SET amount = 1 WHERE id = $1`, [p.id]),
    ).rejects.toMatchObject({ code: '23514' });

    // The file belongs to the payment's own organization.
    const other = await purchasesOrg();
    const foreign = await owner.query(`SELECT id FROM files WHERE organization_id = $1 LIMIT 1`, [
      o.organizationId,
    ]);
    const otherPayment = await pay(other, { amount: '5' });
    await owner.query(`UPDATE purchases_payments SET render_snapshot = '{}'::jsonb WHERE id = $1`, [
      otherPayment.id,
    ]);
    await expect(
      owner.query(`UPDATE purchases_payments SET remittance_pdf_file_id = $1 WHERE id = $2`, [
        foreign.rows[0].id,
        otherPayment.id,
      ]),
    ).rejects.toMatchObject({ code: '23503' });

    // Email rows: kept, immutable once decided, never truncated, no PUBLIC or DELETE grants.
    expect((await o.owner.post(`${path(p.id)}/email`, { to: 'guard@vendor.test' })).status).toBe(
      202,
    );
    await runJobsUntil(
      async () => (await o.owner.get(`${path(p.id)}/emails`)).body.data[0]?.status === 'sent',
    );
    const row = await owner.query(
      `SELECT id FROM purchases_remittance_emails WHERE payment_id = $1`,
      [p.id],
    );
    const id = row.rows[0].id;
    await expect(
      owner.query(`UPDATE purchases_remittance_emails SET recipient = 'x@y.test' WHERE id = $1`, [
        id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(
        `UPDATE purchases_remittance_emails SET status = 'queued', sent_at = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`DELETE FROM purchases_remittance_emails WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(owner.query(`TRUNCATE purchases_remittance_emails`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      app.query(`DELETE FROM purchases_remittance_emails WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
    // An email cannot point at another organization's payment.
    const foreignPayment = await pay(other, { amount: '5' });
    await expect(
      owner.query(
        `INSERT INTO purchases_remittance_emails (organization_id, payment_id, recipient, subject, requested_by_user_id, requested_at)
         SELECT $1, $2, 'a@b.test', 's', created_by_user_id, now() FROM purchases_payments WHERE id = $3`,
        [o.organizationId, foreignPayment.id, p.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // RLS: another organization's context sees no rows.
    await app.query('BEGIN');
    try {
      await app.query(
        `SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', '', true)`,
        [other.organizationId],
      );
      const seen = await app.query(
        `SELECT count(*)::int AS n FROM purchases_remittance_emails WHERE id = $1`,
        [id],
      );
      expect(seen.rows[0].n).toBe(0);
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [o.organizationId]);
      const own = await app.query(
        `SELECT count(*)::int AS n FROM purchases_remittance_emails WHERE id = $1`,
        [id],
      );
      expect(own.rows[0].n).toBe(1);
    } finally {
      await app.query('ROLLBACK');
    }
  });
});

// ---------------------------------------------------------------------------
// Debit notes are unchanged (D1): regression coverage only
// ---------------------------------------------------------------------------

describe('debit-note output is unchanged', () => {
  it('still renders, downloads, emails and keeps its PDF through a void', async () => {
    const o = await purchasesOrg();
    const created = await o.owner.post('/purchases/vendor-credits', {
      origin: 'debit_note',
      vendorId: o.vendorId,
      creditDate: '2026-03-12',
      lines: [{ description: 'Short delivery', quantity: '2', unitPrice: '25' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const posted = await o.owner.post(`/purchases/vendor-credits/${created.body.data.id}/post`, {
      version: created.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const note = posted.body.data as { id: string; number: string };
    const base = `/purchases/vendor-credits/${note.id}`;
    await runJobsUntil(
      async () => (await o.owner.get(`${base}/pdf`)).body.data?.status === 'ready',
    );
    const pdf = (await o.owner.get(`${base}/pdf`)).body.data;
    expect((await download(o.owner, pdf.download.url)).rawPayload.subarray(0, 5).toString()).toBe(
      '%PDF-',
    );
    const hold = await owner.query(`SELECT legal_hold FROM files WHERE id = $1`, [pdf.fileId]);
    expect(hold.rows[0].legal_hold).toBe(true);
    expect((await o.owner.delete(`/files/${pdf.fileId}`)).status).toBe(409);
    expect((await o.owner.post(`${base}/email`, { message: 'Please credit us.' })).status).toBe(
      202,
    );
    await runJobsUntil(
      async () => (await o.owner.get(`${base}/emails`)).body.data[0]?.status === 'sent',
    );
    expect(ctx.email.lastTo('ap@island.test')).toMatchObject({
      subject: `Debit note ${note.number}`,
      template: 'purchases.debit_note',
    });
    // Void: the PDF stays downloadable; a voided note cannot be emailed.
    const current = await o.owner.get(base);
    const voided = await o.owner.post(`${base}/void`, {
      version: current.body.data.version,
      reason: 'Entered in error',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const after = (await o.owner.get(`${base}/pdf`)).body.data;
    expect(after).toMatchObject({ status: 'ready', fileId: pdf.fileId });
    expect((await download(o.owner, after.download.url)).statusCode).toBe(200);
    expect((await o.owner.post(`${base}/email`, {})).status).toBe(409);
  });
});
