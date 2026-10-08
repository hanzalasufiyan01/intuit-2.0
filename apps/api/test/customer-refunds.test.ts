import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/**
 * Customer refunds (mirrors vendor refunds): a separate transaction paying back an unallocated
 * receipt or an unapplied credit note. Dr AR at the source's historical base / Cr bank or cash at
 * the refund rate / one net base-only realized-FX line (fx = base released − base paid, positive =
 * gain). AR subledger = AR control account throughout.
 */

let ctx: TestContext;
let owner: Awaited<ReturnType<typeof connectAs>>;
beforeAll(async () => {
  ctx = await createTestContext();
  owner = await connectAs('owner');
});
afterAll(async () => {
  await owner.end();
  await ctx.close();
});

interface SalesOrg extends AccountingOrg {
  customerId: string;
}

async function salesOrg(currencyCode = 'MVR'): Promise<SalesOrg> {
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
    party: { kind: 'organization', displayName: 'Lagoon Traders' },
    currencyCode,
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  return { ...org, customerId: customer.body.data.id };
}

async function invoice(o: SalesOrg, amount: string, invoiceDate = '2026-03-10') {
  const created = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate,
    lines: [{ description: 'Services', quantity: '1', unitPrice: amount }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const issued = await o.owner.post(`/sales/invoices/${created.body.data.id}/issue`, {
    version: created.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data as { id: string; number: string; version: number };
}

async function receive(o: SalesOrg, body: object) {
  const res = await o.owner.post('/sales/receipts', {
    customerId: o.customerId,
    receiptDate: '2026-03-10',
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; number: string; version: number; journalId: string };
}

async function issuedCredit(o: SalesOrg, amount = '40') {
  const note = await o.owner.post('/sales/credit-notes', {
    customerId: o.customerId,
    creditDate: '2026-03-12',
    lines: [{ description: 'Returned goods', quantity: '1', unitPrice: amount }],
  });
  expect(note.status, JSON.stringify(note.body)).toBe(201);
  const issued = await o.owner.post(`/sales/credit-notes/${note.body.data.id}/issue`, {
    version: note.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data as { id: string; number: string; version: number };
}

async function rate(o: AccountingOrg, rateDate: string, value: string) {
  const res = await o.owner.post('/accounting/exchange-rates', {
    fromCurrency: 'USD',
    rateDate,
    rate: value,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

const refundBody = (sourceId: string, overrides: Record<string, unknown> = {}) => ({
  sourceType: 'receipt',
  sourceId,
  refundDate: '2026-03-20',
  amount: '50',
  ...overrides,
});

function record(client: TestClient, body: object, headers: Record<string, string> = {}) {
  return client.post('/sales/refunds', body, headers);
}

async function refunded(client: TestClient, body: object) {
  const res = await record(client, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

function voidRefund(client: TestClient, refund: { id: string; version: number }, reason = 'x') {
  return client.post(`/sales/refunds/${refund.id}/void`, { version: refund.version, reason });
}

async function journal(o: AccountingOrg, journalId: string) {
  return (await o.owner.get(`/accounting/journals/${journalId}`)).body.data as {
    status: string;
    source: string;
    sourceType: string | null;
    sourceDocument: Record<string, unknown> | null;
    lines: {
      kind: string;
      accountId: string;
      debit: string | null;
      credit: string | null;
      baseDebit: string | null;
      baseCredit: string | null;
    }[];
  };
}

/** AR control (base, debit-positive) = invoices due − receipts unallocated − credit notes unapplied. */
async function expectReconciled(o: AccountingOrg, expected: string) {
  const { rows } = await owner.query(
    `SELECT
       (SELECT coalesce(sum(coalesce(l.base_debit,0) - coalesce(l.base_credit,0)), 0)::numeric(28,2)::text
          FROM accounting_journal_lines l JOIN accounting_journal_entries j ON j.id = l.journal_id
          JOIN accounting_accounts a ON a.id = l.account_id
         WHERE a.organization_id = $1 AND a.control_subledger = 'sales'
           AND j.status IN ('POSTED','REVERSED')) AS gl,
       ((SELECT coalesce(sum(base_due), 0) FROM sales_invoices WHERE organization_id = $1 AND status = 'ISSUED')
        - (SELECT coalesce(sum(base_unallocated), 0) FROM sales_receipts
            WHERE organization_id = $1 AND status = 'RECORDED')
        - (SELECT coalesce(sum(base_unapplied), 0) FROM sales_credit_notes
            WHERE organization_id = $1 AND status = 'ISSUED'))::numeric(28,2)::text AS subledger`,
    [o.organizationId],
  );
  expect(rows[0]).toEqual({ gl: expected, subledger: expected });
}

async function auditActions(o: AccountingOrg, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action, metadata FROM audit_events WHERE organization_id = $1 AND resource_id = $2
      ORDER BY occurred_at, id`,
    [o.organizationId, resourceId],
  );
  return rows as { action: string; metadata: Record<string, unknown> }[];
}

const issuesOf = (res: { body: { error?: { details?: { issues?: unknown[] } } } }) =>
  res.body.error?.details?.issues ?? [];

async function fxAccountOf(o: AccountingOrg) {
  const designations = (await o.owner.get('/accounting/designations')).body.data as {
    designation: string;
    accountId: string;
  }[];
  return designations.find((d) => d.designation === 'REALIZED_FX_GAIN_LOSS')!.accountId;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

describe('customer refund sources', () => {
  it('refunds a receipt partially and repeatedly, never beyond the credit', async () => {
    const o = await salesOrg();
    const receipt = await receive(o, { amount: '500', allocations: [] });
    await expectReconciled(o, '-500.00');
    const first = await refunded(
      o.owner,
      refundBody(receipt.id, { amount: '200', reference: 'R-1' }),
    );
    expect(first).toMatchObject({
      status: 'RECORDED',
      number: 'RF-00001',
      sourceType: 'receipt',
      sourceId: receipt.id,
      sourceNumber: receipt.number,
      amount: '200.00',
      exchangeRateSource: 'base',
      baseAmount: '200.0000',
      baseReleased: '200.0000',
      fxDifference: '0.0000',
      refundAccountId: o.accounts['1120'],
      refundAccountOverridden: false,
    });
    const j = await journal(o, first.journalId);
    expect(j).toMatchObject({ source: 'event', sourceType: 'refund' });
    expect(j.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      [o.accounts['1130'], '200.0000', null],
      [o.accounts['1120'], null, '200.0000'],
    ]);
    expect(j.sourceDocument).toMatchObject({
      documentType: 'refund',
      label: 'Refund RF-00001',
      path: `/sales/refunds/${first.id}`,
      relation: 'source',
    });
    expect((await o.owner.get(`/sales/receipts/${receipt.id}`)).body.data.amountUnallocated).toBe(
      '300.00',
    );
    await expectReconciled(o, '-300.00');
    const second = await refunded(o.owner, refundBody(receipt.id, { amount: '100' }));
    expect(second.number).toBe('RF-00002');
    const over = await record(o.owner, refundBody(receipt.id, { amount: '200.01' }));
    expect(issuesOf(over)).toEqual([
      { path: 'amount', message: 'Only 200.00 MVR is available to refund.' },
    ]);
    await expectReconciled(o, '-200.00');
    const list = await o.owner.get(`/sales/refunds?receiptId=${receipt.id}`);
    expect(list.body.data.items.map((r: { number: string }) => r.number).sort()).toEqual([
      'RF-00001',
      'RF-00002',
    ]);
    expect((await auditActions(o, first.id)).map((a) => a.action)).toEqual([
      'customer_refund.recorded',
    ]);
  });

  it('refunds only the unallocated part of a receipt and never touches invoices', async () => {
    const o = await salesOrg();
    const inv = await invoice(o, '100');
    const partly = await receive(o, {
      amount: '150',
      allocations: [{ invoiceId: inv.id, amount: '100' }],
    });
    const refund = await refunded(o.owner, refundBody(partly.id, { amount: '50' }));
    expect(refund.baseReleased).toBe('50.0000');
    expect((await o.owner.get(`/sales/invoices/${inv.id}`)).body.data.amountDue).toBe('0.00');
    expect(issuesOf(await record(o.owner, refundBody(partly.id, { amount: '1' })))).toContainEqual({
      path: 'sourceId',
      message: 'The receipt has no unallocated amount left to refund.',
    });
    await expectReconciled(o, '0.00');
  });

  it('refunds unapplied credit notes (needing credit_notes.view); invoices stay untouched', async () => {
    const o = await salesOrg();
    const note = await issuedCredit(o, '40');
    await expectReconciled(o, '-40.00');
    const refund = await refunded(
      o.owner,
      refundBody(note.id, { sourceType: 'credit_note', amount: '15' }),
    );
    expect(refund).toMatchObject({ sourceType: 'credit_note', sourceNumber: note.number });
    expect((await o.owner.get(`/sales/credit-notes/${note.id}`)).body.data.amountUnapplied).toBe(
      '25.00',
    );
    await expectReconciled(o, '-25.00');
    expect((await voidRefund(o.owner, refund)).status).toBe(200);
    expect((await o.owner.get(`/sales/credit-notes/${note.id}`)).body.data.amountUnapplied).toBe(
      '40.00',
    );
    await expectReconciled(o, '-40.00');
  });

  it('refuses void receipts, draft credit notes and unknown sources', async () => {
    const o = await salesOrg();
    const receipt = await receive(o, { amount: '10', allocations: [] });
    const voided = await o.owner.post(`/sales/receipts/${receipt.id}/void`, {
      version: receipt.version,
      reason: 'x',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(
      (await record(o.owner, refundBody(receipt.id, { amount: '1' }))).body.error.message,
    ).toBe('Only a recorded receipt can be refunded.');
    const draft = await o.owner.post('/sales/credit-notes', {
      customerId: o.customerId,
      creditDate: '2026-03-12',
      lines: [{ description: 'x', quantity: '1', unitPrice: '5' }],
    });
    expect(
      (
        await record(
          o.owner,
          refundBody(draft.body.data.id, { sourceType: 'credit_note', amount: '1' }),
        )
      ).body.error.code,
    ).toBe('INVALID_STATE_TRANSITION');
    expect((await record(o.owner, refundBody(randomUUID()))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// FX
// ---------------------------------------------------------------------------

describe('customer refund realized FX', () => {
  it('realizes a loss, a gain and no FX with one net base-only line', async () => {
    const o = await salesOrg('USD');
    await rate(o, '2026-03-01', '15.42');
    await rate(o, '2026-03-15', '15.50');
    const receipt = await receive(o, {
      receiptDate: '2026-03-01',
      currencyCode: 'USD',
      amount: '100', // 100 USD at 15.42 = 1,542.00
      allocations: [],
    });
    const fxAccount = await fxAccountOf(o);
    // Loss: 50 USD paid at 15.50 = 775.00; released 771.00 → −4.00.
    const loss = await refunded(o.owner, refundBody(receipt.id, { amount: '50' }));
    expect(loss).toMatchObject({
      exchangeRate: '15.5000000000',
      exchangeRateSource: 'table',
      baseAmount: '775.0000',
      baseReleased: '771.0000',
      fxDifference: '-4.0000',
    });
    const j = await journal(o, loss.journalId);
    expect(j).toMatchObject({ source: 'system', sourceType: 'realized_fx' });
    expect(
      j.lines.map((l) => [l.kind, l.accountId, l.debit, l.credit, l.baseDebit, l.baseCredit]),
    ).toEqual([
      ['normal', o.accounts['1130'], '50.0000', null, '771.0000', null],
      ['normal', o.accounts['1120'], null, '50.0000', null, '775.0000'],
      ['base_only', fxAccount, null, null, '4.0000', null],
    ]);
    expect(j.sourceDocument).toMatchObject({ documentType: 'refund', id: loss.id });
    // Gain: the rest at a manual 15.30 = 765.00; the final refund releases the remaining 771.00.
    const gain = await refunded(
      o.owner,
      refundBody(receipt.id, {
        amount: '50',
        rateOverride: '15.30',
        rateOverrideReason: 'Bank rate',
      }),
    );
    expect(gain).toMatchObject({
      exchangeRateSource: 'manual',
      tableRate: '15.5000000000',
      rateOverrideReason: 'Bank rate',
      baseAmount: '765.0000',
      baseReleased: '771.0000',
      fxDifference: '6.0000',
    });
    expect((await journal(o, gain.journalId)).lines.at(-1)).toMatchObject({
      kind: 'base_only',
      baseCredit: '6.0000',
    });
    expect(
      (await auditActions(o, gain.id)).find((a) => a.action === 'customer_refund.rate_overridden')
        ?.metadata,
    ).toMatchObject({ reason: 'Bank rate', tableRate: '15.5000000000' });
    // No FX at the source's own rate: an ordinary event journal.
    const second = await receive(o, {
      receiptDate: '2026-03-20',
      currencyCode: 'USD',
      amount: '10',
      allocations: [],
    });
    const flat = await refunded(o.owner, refundBody(second.id, { amount: '10' }));
    expect(flat.fxDifference).toBe('0.0000');
    expect((await journal(o, flat.journalId)).sourceType).toBe('refund');
    await expectReconciled(o, '0.00');
    // Realized-FX journals are never reversed generically.
    const manual = await o.owner.post(`/accounting/journals/${loss.journalId}/reverse`, {
      reason: 'Trying',
    });
    expect(manual.status).toBe(409);
  });

  it('needs a reason for a manual rate and refuses a rate on a base-currency refund', async () => {
    const o = await salesOrg('USD');
    await rate(o, '2026-03-01', '15.42');
    const receipt = await receive(o, {
      receiptDate: '2026-03-01',
      currencyCode: 'USD',
      amount: '100',
      allocations: [],
    });
    expect(
      issuesOf(await record(o.owner, refundBody(receipt.id, { rateOverride: '15.30' }))),
    ).toContainEqual({
      path: 'rateOverrideReason',
      message: 'Give a reason for overriding the rate.',
    });
    const base = await salesOrg();
    const baseReceipt = await receive(base, { amount: '100', allocations: [] });
    expect(
      issuesOf(
        await record(
          base.owner,
          refundBody(baseReceipt.id, { rateOverride: '2', rateOverrideReason: 'x' }),
        ),
      ),
    ).toContainEqual({
      path: 'rateOverride',
      message: 'A base-currency refund has no exchange rate to override.',
    });
  });
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

describe('customer refund accounts', () => {
  it('accepts bank and cash, refuses control, expense and unknown accounts', async () => {
    const o = await salesOrg();
    const receipt = await receive(o, { amount: '100', allocations: [] });
    const ok = await refunded(
      o.owner,
      refundBody(receipt.id, { amount: '10', refundAccountId: o.accounts['1110'] }),
    );
    expect(ok.refundAccountOverridden).toBe(true);
    expect((await auditActions(o, ok.id)).map((a) => a.action)).toContain(
      'customer_refund.account_overridden',
    );
    for (const accountId of [o.accounts['1130'], o.accounts['5400'], randomUUID()]) {
      const res = await record(
        o.owner,
        refundBody(receipt.id, { amount: '1', refundAccountId: accountId }),
      );
      expect(res.status).toBe(400);
      expect(issuesOf(res).map((i) => (i as { path: string }).path)).toContain('refundAccountId');
    }
  });
});

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

describe('customer refund void and receipt void', () => {
  it('blocks the receipt void while a refund exists, then voids both in order', async () => {
    const o = await salesOrg();
    const inv = await invoice(o, '100');
    const receipt = await receive(o, {
      amount: '300',
      allocations: [{ invoiceId: inv.id, amount: '100' }],
    });
    const refund = await refunded(o.owner, refundBody(receipt.id, { amount: '50' }));
    await expectReconciled(o, '-150.00');
    const current = (await o.owner.get(`/sales/receipts/${receipt.id}`)).body.data;
    const blocked = await o.owner.post(`/sales/receipts/${receipt.id}/void`, {
      version: current.version,
      reason: 'x',
    });
    expect(blocked.body.error).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      message: 'The receipt has recorded refunds; void them before the receipt.',
    });
    // The database backstop refuses the same transition.
    await expect(
      owner.query(
        `UPDATE sales_receipts SET status = 'VOID', voided_at = now(), void_reason = 'x',
                void_journal_id = journal_id, amount_unallocated = 0, base_unallocated = 0
          WHERE id = $1`,
        [receipt.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // The refund void needs a recent password.
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    expect((await voidRefund(o.owner, refund)).body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const voided = await voidRefund(o.owner, refund, 'Refund entered twice');
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'VOID', voidReason: 'Refund entered twice' });
    expect((await journal(o, refund.journalId)).status).toBe('REVERSED');
    expect((await journal(o, voided.body.data.voidJournalId)).sourceDocument).toMatchObject({
      documentType: 'refund',
      relation: 'reversal',
    });
    const restored = (await o.owner.get(`/sales/receipts/${receipt.id}`)).body.data;
    expect([restored.amountUnallocated, restored.baseUnallocated]).toEqual(['200.00', '200.0000']);
    await expectReconciled(o, '-200.00');
    expect((await voidRefund(o.owner, voided.body.data)).body.error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    const receiptVoid = await o.owner.post(`/sales/receipts/${receipt.id}/void`, {
      version: restored.version,
      reason: 'Wrong customer',
    });
    expect(receiptVoid.status, JSON.stringify(receiptVoid.body)).toBe(200);
    await expectReconciled(o, '100.00');
    expect((await auditActions(o, refund.id)).map((a) => a.action)).toEqual([
      'customer_refund.recorded',
      'customer_refund.voided',
    ]);
  });

  it('mirrors a realized-FX refund journal on void and restores the exact base', async () => {
    const o = await salesOrg('USD');
    await rate(o, '2026-03-01', '15.42');
    await rate(o, '2026-03-15', '15.50');
    const receipt = await receive(o, {
      receiptDate: '2026-03-01',
      currencyCode: 'USD',
      amount: '100',
      allocations: [],
    });
    const refund = await refunded(o.owner, refundBody(receipt.id, { amount: '30' }));
    expect(refund.fxDifference).toBe('-2.4000');
    const voided = await voidRefund(o.owner, refund);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const mirror = await journal(o, voided.body.data.voidJournalId);
    expect(mirror).toMatchObject({ source: 'system', sourceType: 'realized_fx' });
    expect(mirror.lines.at(-1)).toMatchObject({ kind: 'base_only', baseCredit: '2.4000' });
    const back = (await o.owner.get(`/sales/receipts/${receipt.id}`)).body.data;
    expect([back.amountUnallocated, back.baseUnallocated]).toEqual(['100.00', '1542.0000']);
    await expectReconciled(o, '-1542.00');
  });

  it('refuses recording or voiding in a closed period', async () => {
    const o = await salesOrg();
    const receipt = await receive(o, { amount: '100', allocations: [] });
    const refund = await refunded(o.owner, refundBody(receipt.id, { amount: '10' }));
    const march = o.periods.find((p) => p.startDate === '2026-03-01')!;
    expect((await o.owner.post(`/accounting/periods/${march.id}/close`)).status).toBe(200);
    expect((await voidRefund(o.owner, refund)).body.error.code).toBe('PERIOD_CLOSED');
    expect((await record(o.owner, refundBody(receipt.id, { amount: '10' }))).body.error.code).toBe(
      'PERIOD_CLOSED',
    );
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

describe('customer refunds in AR positions', () => {
  it('reduces open credit and appears on the customer statement', async () => {
    const o = await salesOrg();
    const receipt = await receive(o, { amount: '100', allocations: [] });
    const refund = await refunded(o.owner, refundBody(receipt.id, { amount: '30' }));
    const statement = (
      await o.owner.get(
        `/sales/reports/statement?customerId=${o.customerId}&from=2026-03-01&to=2026-03-31`,
      )
    ).body.data;
    const lines = statement.currencies[0].lines as {
      type: string;
      amount: string;
      balance: string;
    }[];
    expect(lines.map((l) => [l.type, l.amount, l.balance])).toEqual([
      ['receipt', '-100.00', '-100.00'],
      ['refund', '30.00', '-70.00'],
    ]);
    expect(statement.currencies[0].closingBalance).toBe('-70.00');
    await voidRefund(o.owner, refund);
    const after = (
      await o.owner.get(
        `/sales/reports/statement?customerId=${o.customerId}&from=2026-03-01&to=2026-03-31`,
      )
    ).body.data;
    expect(after.currencies[0].closingBalance).toBe('-100.00');
  });
});

// ---------------------------------------------------------------------------
// Idempotency, concurrency, security
// ---------------------------------------------------------------------------

describe('customer refund idempotency, concurrency and security', () => {
  it('replays under the same Idempotency-Key and records one event', async () => {
    const o = await salesOrg();
    const receipt = await receive(o, { amount: '100', allocations: [] });
    const key = randomUUID();
    const first = await record(o.owner, refundBody(receipt.id), { 'idempotency-key': key });
    const second = await record(o.owner, refundBody(receipt.id), { 'idempotency-key': key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_events WHERE event_key = $1`,
      [`customer-refund:${first.body.data.id}:recorded`],
    );
    expect(rows[0].n).toBe(1);
    expect((await o.owner.get(`/sales/receipts/${receipt.id}`)).body.data.amountUnallocated).toBe(
      '50.00',
    );
  });

  it('never over-draws a receipt when two refunds race', async () => {
    const o = await salesOrg();
    const receipt = await receive(o, { amount: '100', allocations: [] });
    const results = await Promise.all([
      record(o.owner, refundBody(receipt.id, { amount: '100' })),
      record(o.owner, refundBody(receipt.id, { amount: '100' })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect((await o.owner.get(`/sales/receipts/${receipt.id}`)).body.data.amountUnallocated).toBe(
      '0.00',
    );
    await expectReconciled(o, '0.00');
  });

  it('follows the receipt permissions, plus credit_notes.view for credit-note sources', async () => {
    const o = await salesOrg();
    const receipt = await receive(o, { amount: '100', allocations: [] });
    const note = await issuedCredit(o);
    const refund = await refunded(o.owner, refundBody(receipt.id, { amount: '10' }));
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/sales/refunds')).status).toBe(200);
    expect((await member.client.get(`/sales/refunds/${refund.id}`)).status).toBe(200);
    expect((await record(member.client, refundBody(receipt.id, { amount: '1' }))).status).toBe(403);
    expect((await voidRefund(member.client, refund)).status).toBe(403);
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Refund clerk',
      permissionKeys: ['receipts.view', 'receipts.create'],
    });
    expect(role.status).toBe(201);
    const clerk = await joinWithRole(ctx, o.owner, 'Refund clerk');
    expect((await record(clerk.client, refundBody(receipt.id, { amount: '1' }))).status).toBe(201);
    expect(
      (await record(clerk.client, refundBody(note.id, { sourceType: 'credit_note', amount: '1' })))
        .status,
    ).toBe(403);
    expect((await voidRefund(clerk.client, refund)).status).toBe(403);
    // Without credit_notes.view the list hides credit-note refunds.
    await refunded(o.owner, refundBody(note.id, { sourceType: 'credit_note', amount: '5' }));
    const seen = (await clerk.client.get('/sales/refunds')).body.data.items as {
      sourceType: string;
    }[];
    expect(seen.every((r) => r.sourceType === 'receipt')).toBe(true);
  });

  it('keeps refunds tenant-isolated (API and RLS) and immutable in the database', async () => {
    const a = await salesOrg();
    const b = await salesOrg();
    const receipt = await receive(a, { amount: '100', allocations: [] });
    const refund = await refunded(a.owner, refundBody(receipt.id, { amount: '10' }));
    expect((await b.owner.get(`/sales/refunds/${refund.id}`)).status).toBe(404);
    expect((await record(b.owner, refundBody(receipt.id, { amount: '1' }))).status).toBe(404);
    expect((await voidRefund(b.owner, refund)).status).toBe(404);
    expect((await b.owner.get(`/accounting/journals/${refund.journalId}`)).status).toBe(404);
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      expect((await app.query('SELECT id FROM sales_refunds')).rows).toEqual([]);
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
    await expect(
      owner.query(`UPDATE sales_refunds SET amount = 1 WHERE id = $1`, [refund.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`DELETE FROM sales_refunds WHERE id = $1`, [refund.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`UPDATE sales_refunds SET fx_difference = 1 WHERE id = $1`, [refund.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
