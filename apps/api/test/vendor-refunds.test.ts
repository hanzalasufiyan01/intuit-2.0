import { randomUUID } from 'node:crypto';
import type pg from 'pg';
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
 * Phase 4B-3: vendor refunds (ADR 0004 P4-24, P4-30, P4-33, P4-34, P4-42, P4-51; decisions of
 * 2026-10-05). A refund is a separate transaction from a prepayment or an unapplied vendor credit:
 * Dr bank/cash / Cr AP at the source's historical base / one net realized-FX line
 * (fx = base received − base released, positive = gain). Bank or cash accounts only.
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

async function purchasesOrg(options: { vendor?: Record<string, unknown> } = {}): Promise<Org> {
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
    party: { kind: 'organization', displayName: 'Island Supplies' },
    ...options.vendor,
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

async function postedBill(o: Org, overrides: Record<string, unknown> = {}, amount = '100') {
  const bill = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: '2026-03-10',
    vendorReference: `INV-${randomUUID().slice(0, 8)}`,
    lines: [{ description: 'Stock', quantity: '1', unitPrice: amount, taxCodeId: null }],
    ...overrides,
  });
  expect(bill.status, JSON.stringify(bill.body)).toBe(201);
  const res = await o.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
    version: bill.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; number: string; version: number; amountDue: string };
}

async function postedCredit(o: Org, overrides: Record<string, unknown> = {}, amount = '40') {
  const doc = await o.owner.post('/purchases/vendor-credits', {
    origin: 'supplier_credit_note',
    vendorId: o.vendorId,
    creditDate: '2026-03-12',
    vendorReference: `CN-${randomUUID().slice(0, 8)}`,
    lines: [{ description: 'Returned goods', quantity: '1', unitPrice: amount, taxCodeId: null }],
    ...overrides,
  });
  expect(doc.status, JSON.stringify(doc.body)).toBe(201);
  const res = await o.owner.post(`/purchases/vendor-credits/${doc.body.data.id}/post`, {
    version: doc.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

/** A recorded payment; with `bills` it settles them, the rest is a prepayment. */
async function payment(o: Org, body: Record<string, unknown>) {
  const draft = await o.owner.post('/purchases/payments', {
    vendorId: o.vendorId,
    paymentDate: '2026-03-10',
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

const refundBody = (sourceId: string, overrides: Record<string, unknown> = {}) => ({
  sourceType: 'payment',
  sourceId,
  refundDate: '2026-03-20',
  amount: '50',
  ...overrides,
});

function record(client: TestClient, body: object, headers: Record<string, string> = {}) {
  return client.post('/purchases/refunds', body, headers);
}

async function refunded(client: TestClient, body: object) {
  const res = await record(client, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

function voidRefund(client: TestClient, refund: { id: string; version: number }, reason = 'x') {
  return client.post(`/purchases/refunds/${refund.id}/void`, { version: refund.version, reason });
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

/** I-1: AP control = bills due − credits unapplied − payments unallocated (base). */
async function expectReconciled(o: AccountingOrg, gl: string) {
  const { rows } = await owner.query(
    `SELECT
       (SELECT coalesce(sum(coalesce(l.base_credit,0) - coalesce(l.base_debit,0)), 0)::numeric(28,2)::text
          FROM accounting_journal_lines l JOIN accounting_journal_entries j ON j.id = l.journal_id
          JOIN accounting_accounts a ON a.id = l.account_id
         WHERE a.organization_id = $1 AND a.control_subledger = 'purchases'
           AND j.status IN ('POSTED','REVERSED')) AS gl,
       ((SELECT coalesce(sum(base_due), 0) FROM purchases_bills WHERE organization_id = $1 AND status = 'POSTED')
        - (SELECT coalesce(sum(base_unapplied), 0) FROM purchases_vendor_credits
            WHERE organization_id = $1 AND status = 'POSTED')
        - (SELECT coalesce(sum(base_unallocated), 0) FROM purchases_payments
            WHERE organization_id = $1 AND status = 'RECORDED'))::numeric(28,2)::text AS subledger`,
    [o.organizationId],
  );
  expect(rows[0]).toEqual({ gl, subledger: gl });
}

async function auditActions(o: AccountingOrg, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action, metadata FROM audit_events WHERE organization_id = $1 AND resource_id = $2
      ORDER BY occurred_at, id`,
    [o.organizationId, resourceId],
  );
  return rows as { action: string; metadata: Record<string, unknown> }[];
}

async function account(o: AccountingOrg, body: Record<string, unknown>) {
  const res = await o.owner.post('/accounting/accounts', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
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

describe('refund sources (P4-30)', () => {
  it('refunds a prepayment partially and repeatedly, never beyond the balance', async () => {
    const o = await purchasesOrg();
    const pay = await payment(o, { amount: '500' });
    await expectReconciled(o, '-500.00');
    const first = await refunded(o.owner, refundBody(pay.id, { amount: '200', reference: 'R-1' }));
    expect(first).toMatchObject({
      status: 'RECORDED',
      number: 'VR-00001',
      sourceType: 'payment',
      sourceId: pay.id,
      sourceNumber: pay.number,
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
      [o.accounts['1120'], '200.0000', null],
      [o.accounts['2110'], null, '200.0000'],
    ]);
    expect(j.sourceDocument).toMatchObject({
      documentType: 'refund',
      label: 'Refund VR-00001',
      path: `/purchases/refunds/${first.id}`,
      relation: 'source',
    });
    expect((await o.owner.get(`/purchases/payments/${pay.id}`)).body.data.amountUnallocated).toBe(
      '300.00',
    );
    await expectReconciled(o, '-300.00');
    const second = await refunded(o.owner, refundBody(pay.id, { amount: '100' }));
    expect(second.number).toBe('VR-00002');
    const over = await record(o.owner, refundBody(pay.id, { amount: '200.01' }));
    expect(issuesOf(over)).toEqual([
      { path: 'amount', message: 'Only 200.00 MVR is available to refund.' },
    ]);
    await expectReconciled(o, '-200.00');
    const list = await o.owner.get(`/purchases/refunds?paymentId=${pay.id}`);
    // Same refund date: the list order then follows the id, so compare without order.
    expect(list.body.data.items.map((r: { number: string }) => r.number).sort()).toEqual([
      'VR-00001',
      'VR-00002',
    ]);
    expect((await auditActions(o, first.id)).map((a) => a.action)).toEqual([
      'vendor_refund.recorded',
    ]);
  });

  it('refunds only the unallocated part of a payment and never touches bills', async () => {
    const o = await purchasesOrg();
    const bill = await postedBill(o, {}, '100');
    const partly = await payment(o, {
      amount: '150',
      allocations: [{ billId: bill.id, amount: '100' }],
    });
    const refund = await refunded(o.owner, refundBody(partly.id, { amount: '50' }));
    expect(refund.baseReleased).toBe('50.0000');
    expect((await o.owner.get(`/purchases/bills/${bill.id}`)).body.data.amountDue).toBe('0.00');
    const again = await record(o.owner, refundBody(partly.id, { amount: '1' }));
    expect(issuesOf(again)).toContainEqual({
      path: 'sourceId',
      message: 'The payment has no prepayment left to refund.',
    });
    const bill2 = await postedBill(o, {}, '80');
    const full = await payment(o, {
      amount: '80',
      allocations: [{ billId: bill2.id, amount: '80' }],
    });
    expect(issuesOf(await record(o.owner, refundBody(full.id, { amount: '1' })))).toContainEqual({
      path: 'sourceId',
      message: 'The payment has no prepayment left to refund.',
    });
    await expectReconciled(o, '0.00');
  });

  it('refunds unapplied vendor credits; a refunded credit cannot be voided until the refund is', async () => {
    const o = await purchasesOrg();
    const credit = await postedCredit(o, {}, '40');
    const refund = await refunded(
      o.owner,
      refundBody(credit.id, { sourceType: 'vendor_credit', amount: '15' }),
    );
    expect(refund).toMatchObject({ sourceType: 'vendor_credit', sourceNumber: credit.number });
    const after = (await o.owner.get(`/purchases/vendor-credits/${credit.id}`)).body.data;
    expect(after.amountUnapplied).toBe('25.00');
    await expectReconciled(o, '-25.00');
    const blocked = await o.owner.post(`/purchases/vendor-credits/${credit.id}/void`, {
      version: after.version,
      reason: 'x',
    });
    expect(blocked.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await voidRefund(o.owner, refund)).status).toBe(200);
    const restored = (await o.owner.get(`/purchases/vendor-credits/${credit.id}`)).body.data;
    expect(restored.amountUnapplied).toBe('40.00');
    const voided = await o.owner.post(`/purchases/vendor-credits/${credit.id}/void`, {
      version: restored.version,
      reason: 'Entered twice',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    await expectReconciled(o, '0.00');
  });

  it('refuses void, draft and unknown sources', async () => {
    const o = await purchasesOrg();
    const draft = await o.owner.post('/purchases/payments', {
      vendorId: o.vendorId,
      paymentDate: '2026-03-10',
      amount: '10',
      allocations: [],
    });
    expect((await record(o.owner, refundBody(draft.body.data.id))).body.error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    const paid = await payment(o, { amount: '10' });
    const voidedPayment = await o.owner.post(`/purchases/payments/${paid.id}/void`, {
      version: paid.version,
      reason: 'x',
    });
    expect(voidedPayment.status).toBe(200);
    expect((await record(o.owner, refundBody(paid.id, { amount: '1' }))).body.error.message).toBe(
      'Only a recorded payment can be refunded.',
    );
    const credit = await postedCredit(o, {}, '5');
    await o.owner.post(`/purchases/vendor-credits/${credit.id}/void`, {
      version: credit.version,
      reason: 'x',
    });
    expect(
      (await record(o.owner, refundBody(credit.id, { sourceType: 'vendor_credit', amount: '1' })))
        .body.error.message,
    ).toBe('Only a posted vendor credit can be refunded.');
    expect((await record(o.owner, refundBody(randomUUID()))).status).toBe(404);
    expect((await record(o.owner, { ...refundBody(paid.id), billId: randomUUID() })).status).toBe(
      400,
    );
  });
});

// ---------------------------------------------------------------------------
// FX and rates
// ---------------------------------------------------------------------------

describe('refund realized FX', () => {
  it('realizes a gain, a loss and no FX with one net base-only line', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await rate(o, '2026-03-01', '15.42');
    await rate(o, '2026-03-15', '15.50');
    const pay = await payment(o, { amount: '100' }); // 100 USD at 15.42 = 1,542.00
    const fxAccount = await fxAccountOf(o);
    // Gain: 50 USD received at 15.50 = 775.00; released 771.00 → +4.00.
    const gain = await refunded(o.owner, refundBody(pay.id, { amount: '50' }));
    expect(gain).toMatchObject({
      exchangeRate: '15.5000000000',
      exchangeRateSource: 'table',
      baseAmount: '775.0000',
      baseReleased: '771.0000',
      fxDifference: '4.0000',
    });
    const j = await journal(o, gain.journalId);
    expect(j).toMatchObject({ source: 'system', sourceType: 'realized_fx' });
    expect(
      j.lines.map((l) => [l.kind, l.accountId, l.debit, l.credit, l.baseDebit, l.baseCredit]),
    ).toEqual([
      ['normal', o.accounts['1120'], '50.0000', null, '775.0000', null],
      ['normal', o.accounts['2110'], null, '50.0000', null, '771.0000'],
      ['base_only', fxAccount, null, null, null, '4.0000'],
    ]);
    expect(j.sourceDocument).toMatchObject({ documentType: 'refund', id: gain.id });
    // Loss: the rest at a manual 15.30 = 765.00; the final refund releases the remaining 771.00.
    const loss = await refunded(
      o.owner,
      refundBody(pay.id, { amount: '50', rateOverride: '15.30', rateOverrideReason: 'Bank rate' }),
    );
    expect(loss).toMatchObject({
      exchangeRateSource: 'manual',
      tableRate: '15.5000000000',
      rateOverrideReason: 'Bank rate',
      baseAmount: '765.0000',
      baseReleased: '771.0000',
      fxDifference: '-6.0000',
    });
    expect((await journal(o, loss.journalId)).lines.at(-1)).toMatchObject({
      kind: 'base_only',
      baseDebit: '6.0000',
    });
    expect(
      (await auditActions(o, loss.id)).find((a) => a.action === 'vendor_refund.rate_overridden')
        ?.metadata,
    ).toMatchObject({ reason: 'Bank rate', tableRate: '15.5000000000' });
    // No FX at the source's own rate: an ordinary event journal.
    const second = await payment(o, { amount: '10', paymentDate: '2026-03-20' }); // at 15.50
    const flat = await refunded(o.owner, refundBody(second.id, { amount: '10' }));
    expect(flat.fxDifference).toBe('0.0000');
    expect((await journal(o, flat.journalId)).sourceType).toBe('refund');
    await expectReconciled(o, '0.00');
    // Realized-FX journals are never reversed generically.
    const manual = await o.owner.post(`/accounting/journals/${gain.journalId}/reverse`, {
      reason: 'Trying',
    });
    expect(manual.status).toBe(409);
  });

  it('follows the linked credit at the bill rate and needs a rate, a reason and the FX designation', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await rate(o, '2026-03-01', '15.42');
    const bill = await postedBill(o, { rateOverride: '15.60', rateOverrideReason: 'Bank' });
    const credit = await postedCredit(o, { billId: bill.id }, '20'); // 20 USD at 15.60 = 312.00
    const refund = await refunded(
      o.owner,
      refundBody(credit.id, { sourceType: 'vendor_credit', amount: '20' }),
    );
    // Received at the table 15.42 = 308.40; released 312.00 → a loss of 3.60.
    expect(refund).toMatchObject({ baseReleased: '312.0000', fxDifference: '-3.6000' });
    const noReason = await record(o.owner, {
      ...refundBody(credit.id, { sourceType: 'vendor_credit', amount: '1' }),
      rateOverride: '15.5',
    });
    expect(issuesOf(noReason)).toContainEqual({
      path: 'rateOverrideReason',
      message: 'Give a reason for overriding the rate.',
    });
    const pay = await payment(o, { amount: '30' });
    const early = await record(o.owner, refundBody(pay.id, { refundDate: '2026-02-20' }));
    expect(issuesOf(early)).toContainEqual({
      path: 'refundDate',
      message: 'A refund cannot be dated before the payment or credit it refunds.',
    });
    await owner.query(
      `DELETE FROM accounting_designations WHERE organization_id = $1 AND designation = 'REALIZED_FX_GAIN_LOSS'`,
      [o.organizationId],
    );
    await rate(o, '2026-03-15', '15.50');
    expect((await record(o.owner, refundBody(pay.id, { amount: '10' }))).body.error.code).toBe(
      'DESIGNATION_REQUIRED',
    );
    // At the payment's own rate there is no FX, so no designation is needed.
    await refunded(
      o.owner,
      refundBody(pay.id, { amount: '10', rateOverride: '15.42', rateOverrideReason: 'Same rate' }),
    );
    const local = await o.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Local Supplier' },
    });
    const mvr = await payment({ ...o, vendorId: local.body.data.id }, { amount: '10' });
    expect(
      issuesOf(
        await record(
          o.owner,
          refundBody(mvr.id, { amount: '5', rateOverride: '2', rateOverrideReason: 'x' }),
        ),
      )[0],
    ).toMatchObject({ message: 'A base-currency refund has no exchange rate to override.' });
  });
});

// ---------------------------------------------------------------------------
// Refund accounts (amendment: bank or cash only)
// ---------------------------------------------------------------------------

describe('refund accounts', () => {
  it('accepts bank and cash, refuses credit cards and ineligible accounts', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await rate(o, '2026-03-01', '15.42');
    const card = await account(o, {
      code: '2140',
      name: 'Company card',
      type: 'LIABILITY',
      parentId: o.accounts['2100'],
      subtype: 'CREDIT_CARD',
    });
    const usdBank = await account(o, {
      code: '1125',
      name: 'USD bank',
      type: 'ASSET',
      parentId: o.accounts['1100'],
      subtype: 'BANK',
      currencyCode: 'USD',
    });
    const eurBank = await account(o, {
      code: '1126',
      name: 'EUR bank',
      type: 'ASSET',
      parentId: o.accounts['1100'],
      subtype: 'BANK',
      currencyCode: 'EUR',
    });
    const archived = await account(o, {
      code: '1127',
      name: 'Old bank',
      type: 'ASSET',
      parentId: o.accounts['1100'],
      subtype: 'BANK',
    });
    expect((await o.owner.post(`/accounting/accounts/${archived}/archive`)).status).toBe(200);
    // Payments may still use the card (P4-26); refunds may not (4B-3 amendment).
    const pay = await payment(o, { amount: '100', paymentAccountId: card });
    expect(pay.paymentAccountId).toBe(card);
    const refused = async (refundAccountId: string) =>
      issuesOf(await record(o.owner, refundBody(pay.id, { amount: '1', refundAccountId })));
    expect(await refused(card)).toEqual([
      {
        path: 'refundAccountId',
        message:
          'Choose a bank or cash account; vendor refunds cannot go to a credit card account.',
      },
    ]);
    expect(await refused(eurBank)).toEqual([
      { path: 'refundAccountId', message: 'The refund account must be in USD or MVR.' },
    ]);
    expect((await refused(o.accounts['1100']!))[0]).toMatchObject({
      message: 'Choose a posting (leaf) account.',
    });
    expect((await refused(o.accounts['2110']!))[0]).toMatchObject({
      message: 'A control account cannot be used here.',
    });
    expect((await refused(o.accounts['5400']!))[0]).toMatchObject({
      message: 'Choose a bank or cash account; vendor refunds cannot go to a credit card account.',
    });
    expect((await refused(archived))[0]).toMatchObject({ message: 'Choose an active account.' });
    const cash = await refunded(
      o.owner,
      refundBody(pay.id, { amount: '10', refundAccountId: o.accounts['1110'] }),
    );
    expect(cash).toMatchObject({
      refundAccountId: o.accounts['1110'],
      refundAccountOverridden: true,
    });
    expect((await auditActions(o, cash.id)).map((a) => a.action)).toContain(
      'vendor_refund.account_overridden',
    );
    const usd = await refunded(
      o.owner,
      refundBody(pay.id, { amount: '10', refundAccountId: usdBank }),
    );
    expect(usd.refundAccountId).toBe(usdBank);
    // A credit-card default payment account is not a refund destination.
    const settings = (await o.owner.get('/purchases/settings')).body.data;
    const changed = await o.owner.put('/purchases/settings', {
      version: settings.version,
      apAccountId: o.accounts['2110'],
      defaultExpenseAccountId: o.accounts['5400'],
      defaultPaymentAccountId: card,
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(issuesOf(await record(o.owner, refundBody(pay.id, { amount: '1' })))[0]).toMatchObject({
      path: 'refundAccountId',
      message: 'Choose a bank or cash account; vendor refunds cannot go to a credit card account.',
    });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: void and the payment void (P4-33)
// ---------------------------------------------------------------------------

describe('refund void and payment void', () => {
  it('blocks the payment void while a refund exists, then voids both in order', async () => {
    const o = await purchasesOrg();
    const bill = await postedBill(o, {}, '100');
    const pay = await payment(o, {
      amount: '300',
      allocations: [{ billId: bill.id, amount: '100' }],
    });
    const refund = await refunded(o.owner, refundBody(pay.id, { amount: '50' }));
    await expectReconciled(o, '-150.00');
    const current = (await o.owner.get(`/purchases/payments/${pay.id}`)).body.data;
    const blocked = await o.owner.post(`/purchases/payments/${pay.id}/void`, {
      version: current.version,
      reason: 'x',
    });
    expect(blocked.body.error).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      message: 'This payment has active refunds. Void the refunds taken from this payment first.',
    });
    // The database backstop refuses the same transition.
    await expect(
      owner.query(
        `UPDATE purchases_payments SET status = 'VOID', voided_at = now(), void_reason = 'x',
                void_journal_id = journal_id, amount_unallocated = 0, base_unallocated = 0
          WHERE id = $1`,
        [pay.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // The refund void needs a recent password (P4-42).
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
    const restored = (await o.owner.get(`/purchases/payments/${pay.id}`)).body.data;
    expect([restored.amountUnallocated, restored.baseUnallocated]).toEqual(['200.00', '200.0000']);
    await expectReconciled(o, '-200.00');
    expect((await voidRefund(o.owner, voided.body.data)).body.error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    const payVoid = await o.owner.post(`/purchases/payments/${pay.id}/void`, {
      version: restored.version,
      reason: 'Wrong vendor',
    });
    expect(payVoid.status, JSON.stringify(payVoid.body)).toBe(200);
    await expectReconciled(o, '100.00');
    expect((await auditActions(o, refund.id)).map((a) => a.action)).toEqual([
      'vendor_refund.recorded',
      'vendor_refund.voided',
    ]);
  });

  it('mirrors a realized-FX refund journal on void and restores the exact base', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await rate(o, '2026-03-01', '15.42');
    await rate(o, '2026-03-15', '15.50');
    const pay = await payment(o, { amount: '100' });
    const refund = await refunded(o.owner, refundBody(pay.id, { amount: '30' }));
    expect(refund.fxDifference).toBe('2.4000');
    const voided = await voidRefund(o.owner, refund);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const mirror = await journal(o, voided.body.data.voidJournalId);
    expect(mirror).toMatchObject({ source: 'system', sourceType: 'realized_fx' });
    expect(mirror.lines.at(-1)).toMatchObject({ kind: 'base_only', baseDebit: '2.4000' });
    const back = (await o.owner.get(`/purchases/payments/${pay.id}`)).body.data;
    expect([back.amountUnallocated, back.baseUnallocated]).toEqual(['100.00', '1542.0000']);
    await expectReconciled(o, '-1542.00');
  });

  it('refuses recording or voiding in a closed period', async () => {
    const o = await purchasesOrg();
    const pay = await payment(o, { amount: '100' });
    const refund = await refunded(o.owner, refundBody(pay.id, { amount: '10' }));
    const march = o.periods.find((p) => p.startDate === '2026-03-01')!;
    expect((await o.owner.post(`/accounting/periods/${march.id}/close`)).status).toBe(200);
    expect((await voidRefund(o.owner, refund)).body.error.code).toBe('PERIOD_CLOSED');
    expect((await record(o.owner, refundBody(pay.id, { amount: '10' }))).body.error.code).toBe(
      'PERIOD_CLOSED',
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotency, concurrency, security
// ---------------------------------------------------------------------------

describe('refund idempotency, concurrency and security', () => {
  it('replays under the same Idempotency-Key and records one event', async () => {
    const o = await purchasesOrg();
    const pay = await payment(o, { amount: '100' });
    const key = randomUUID();
    const first = await record(o.owner, refundBody(pay.id), { 'idempotency-key': key });
    const second = await record(o.owner, refundBody(pay.id), { 'idempotency-key': key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_events WHERE event_key = $1`,
      [`refund:${first.body.data.id}:recorded`],
    );
    expect(rows[0].n).toBe(1);
    expect((await o.owner.get(`/purchases/payments/${pay.id}`)).body.data.amountUnallocated).toBe(
      '50.00',
    );
  });

  it('never over-draws a prepayment when a refund races an application', async () => {
    const o = await purchasesOrg();
    const bill = await postedBill(o, {}, '100');
    const pay = await payment(o, { amount: '100' });
    const results = await Promise.all([
      record(o.owner, refundBody(pay.id, { amount: '100' })),
      o.owner.post('/purchases/credit-applications', {
        sourceType: 'payment',
        sourceId: pay.id,
        date: '2026-03-20',
        allocations: [{ billId: bill.id, amount: '100' }],
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect((await o.owner.get(`/purchases/payments/${pay.id}`)).body.data.amountUnallocated).toBe(
      '0.00',
    );
  });

  it('follows the payment permissions, plus vendor-credit view for credit sources', async () => {
    const o = await purchasesOrg();
    const pay = await payment(o, { amount: '100' });
    const credit = await postedCredit(o);
    const refund = await refunded(o.owner, refundBody(pay.id, { amount: '10' }));
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/purchases/refunds')).status).toBe(200);
    expect((await member.client.get(`/purchases/refunds/${refund.id}`)).status).toBe(200);
    expect((await record(member.client, refundBody(pay.id, { amount: '1' }))).status).toBe(403);
    expect((await voidRefund(member.client, refund)).status).toBe(403);
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Refund clerk',
      permissionKeys: ['vendor_payments.view', 'vendor_payments.create'],
    });
    expect(role.status).toBe(201);
    const clerk = await joinWithRole(ctx, o.owner, 'Refund clerk');
    expect((await record(clerk.client, refundBody(pay.id, { amount: '1' }))).status).toBe(201);
    expect(
      (
        await record(
          clerk.client,
          refundBody(credit.id, { sourceType: 'vendor_credit', amount: '1' }),
        )
      ).status,
    ).toBe(403);
    expect((await voidRefund(clerk.client, refund)).status).toBe(403);
    // Without vendor_credits.view the list hides credit-source refunds.
    await refunded(o.owner, refundBody(credit.id, { sourceType: 'vendor_credit', amount: '5' }));
    const seen = (await clerk.client.get('/purchases/refunds')).body.data.items as {
      sourceType: string;
    }[];
    expect(seen.every((r) => r.sourceType === 'payment')).toBe(true);
  });

  it('keeps refunds tenant-isolated (API and RLS) and immutable in the database', async () => {
    const a = await purchasesOrg();
    const b = await purchasesOrg();
    const pay = await payment(a, { amount: '100' });
    const refund = await refunded(a.owner, refundBody(pay.id, { amount: '10' }));
    expect((await b.owner.get(`/purchases/refunds/${refund.id}`)).status).toBe(404);
    expect((await record(b.owner, refundBody(pay.id, { amount: '1' }))).status).toBe(404);
    expect((await voidRefund(b.owner, refund)).status).toBe(404);
    expect((await b.owner.get(`/accounting/journals/${refund.journalId}`)).status).toBe(404);
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      expect((await app.query('SELECT id FROM purchases_refunds')).rows).toEqual([]);
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
    await expect(
      owner.query(`UPDATE purchases_refunds SET amount = 1 WHERE id = $1`, [refund.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`DELETE FROM purchases_refunds WHERE id = $1`, [refund.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`UPDATE purchases_refunds SET fx_difference = 1 WHERE id = $1`, [refund.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
