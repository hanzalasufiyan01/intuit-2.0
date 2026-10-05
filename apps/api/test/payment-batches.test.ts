import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 4B-4: batch "Pay bills" (ADR 0004 P4-32, P4-50; decisions D1-D9 of 2026-10-05). One
 * payment per vendor and currency through the 4B-2 pipeline, all-or-nothing in one transaction
 * under one idempotency key; approval stays per payment and refuses the whole batch.
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
  vendorA: string;
  vendorB: string;
}

async function payOrg(): Promise<Org> {
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
  const a = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Atoll Supplies' },
  });
  const b = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Blue Lagoon Imports' },
    currencyCode: 'USD',
  });
  expect([a.status, b.status]).toEqual([201, 201]);
  for (const [rateDate, rate] of [
    ['2026-03-01', '15.42'],
    ['2026-03-15', '15.50'],
  ]) {
    await org.owner.post('/accounting/exchange-rates', { fromCurrency: 'USD', rateDate, rate });
  }
  return { ...org, vendorA: a.body.data.id, vendorB: b.body.data.id };
}

async function postedBill(
  o: Org,
  vendorId: string,
  amount: string,
  overrides: Record<string, unknown> = {},
) {
  const bill = await o.owner.post('/purchases/bills', {
    vendorId,
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
  return res.body.data as { id: string; number: string; version: number };
}

function batch(client: TestClient, body: object, headers: Record<string, string> = {}) {
  return client.post('/purchases/payment-batches', body, headers);
}

async function recordedBatch(client: TestClient, body: object) {
  const res = await batch(client, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function usdBank(o: AccountingOrg) {
  const res = await o.owner.post('/accounting/accounts', {
    code: '1125',
    name: 'USD bank',
    type: 'ASSET',
    parentId: o.accounts['1100'],
    subtype: 'BANK',
    currencyCode: 'USD',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function journal(o: AccountingOrg, journalId: string) {
  return (await o.owner.get(`/accounting/journals/${journalId}`)).body.data as {
    sourceType: string;
    sourceDocument: Record<string, unknown> | null;
    lines: {
      kind: string;
      accountId: string;
      baseDebit: string | null;
      baseCredit: string | null;
    }[];
  };
}

async function counts(o: AccountingOrg) {
  const { rows } = await owner.query(
    `SELECT (SELECT count(*)::int FROM purchases_payments WHERE organization_id = $1) AS payments,
            (SELECT count(*)::int FROM purchases_payment_batches WHERE organization_id = $1) AS batches,
            (SELECT count(*)::int FROM accounting_events WHERE organization_id = $1
               AND event_type = 'purchases.payment_recorded') AS events`,
    [o.organizationId],
  );
  return rows[0] as { payments: number; batches: number; events: number };
}

async function dueOf(o: AccountingOrg, billId: string) {
  return (await o.owner.get(`/purchases/bills/${billId}`)).body.data.amountDue as string;
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

const issuesOf = (res: { body: { error?: { details?: { issues?: unknown[] } } } }) =>
  res.body.error?.details?.issues ?? [];

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

describe('batch Pay bills (P4-32)', () => {
  it('records one payment per vendor and currency, full and partial, with C1 FX per payment', async () => {
    const o = await payOrg();
    const usd = await usdBank(o);
    const a1 = await postedBill(o, o.vendorA, '100');
    const a2 = await postedBill(o, o.vendorA, '200');
    const au = await postedBill(o, o.vendorA, '100', { currencyCode: 'USD' }); // 1,542.00
    const b1 = await postedBill(o, o.vendorB, '50'); // 771.00
    const b2 = await postedBill(o, o.vendorB, '50', {
      rateOverride: '15.60',
      rateOverrideReason: 'x',
    }); // 780.00
    await expectReconciled(o, '3393.00');
    const result = await recordedBatch(o.owner, {
      paymentDate: '2026-03-20',
      accounts: [{ currencyCode: 'USD', paymentAccountId: usd }],
      reference: 'RUN-1',
      bills: [
        { billId: a1.id, amount: '100' },
        { billId: a2.id, amount: '150' },
        { billId: au.id, amount: '100' },
        { billId: b1.id, amount: '50' },
        { billId: b2.id, amount: '50' },
      ],
    });
    expect(result).toMatchObject({
      paymentDate: '2026-03-20',
      paymentCount: 3,
      billCount: 5,
      reference: 'RUN-1',
      totals: [
        { currencyCode: 'MVR', amount: '250.00', payments: 1 },
        { currencyCode: 'USD', amount: '200.00', payments: 2 },
      ],
    });
    const payments = result.payments as {
      id: string;
      number: string;
      status: string;
      vendorId: string;
      currencyCode: string;
      amount: string;
      exchangeRateSource: string;
      paymentAccountId: string;
      journalId: string;
    }[];
    expect(payments.map((p) => [p.number, p.vendorId, p.currencyCode, p.amount])).toEqual([
      ['PAY-00001', o.vendorA, 'MVR', '250.00'],
      ['PAY-00002', o.vendorA, 'USD', '100.00'],
      ['PAY-00003', o.vendorB, 'USD', '100.00'],
    ]);
    expect(payments.map((p) => p.paymentAccountId)).toEqual([o.accounts['1120'], usd, usd]);
    // Each payment is an ordinary 4B-2 payment linked to the batch, with no excess (D7).
    for (const p of payments) {
      const detail = (await o.owner.get(`/purchases/payments/${p.id}`)).body.data;
      expect(detail).toMatchObject({
        status: 'RECORDED',
        paymentBatchId: result.id,
        amountUnallocated: '0.00',
      });
    }
    expect((await journal(o, payments[0]!.journalId)).sourceType).toBe('payment');
    // A/USD: 1,542 relieved − 1,550 paid = −8 (loss); B/USD: −4 + 5 = +1 (gain), one line each.
    const fxA = (await journal(o, payments[1]!.journalId)).lines.filter(
      (l) => l.kind === 'base_only',
    );
    const fxB = (await journal(o, payments[2]!.journalId)).lines.filter(
      (l) => l.kind === 'base_only',
    );
    expect(fxA).toEqual([expect.objectContaining({ baseDebit: '8.0000', baseCredit: null })]);
    expect(fxB).toEqual([expect.objectContaining({ baseDebit: null, baseCredit: '1.0000' })]);
    expect((await journal(o, payments[2]!.journalId)).sourceDocument).toMatchObject({
      documentType: 'payment',
      id: payments[2]!.id,
    });
    expect(await dueOf(o, a1.id)).toBe('0.00');
    expect(await dueOf(o, a2.id)).toBe('50.00');
    await expectReconciled(o, '50.00');
    expect(await counts(o)).toEqual({ payments: 3, batches: 1, events: 3 });
    const list = (await o.owner.get('/purchases/payment-batches')).body.data.items;
    expect(list.map((b: { id: string }) => b.id)).toEqual([result.id]);
    const { rows } = await owner.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND resource_id = $2`,
      [o.organizationId, result.id],
    );
    expect(rows.map((r: { action: string }) => r.action)).toEqual([
      'vendor_payment_batch.recorded',
    ]);
  });

  it('applies a manual rate per currency with its reason and keeps the table rate', async () => {
    const o = await payOrg();
    const b1 = await postedBill(o, o.vendorB, '100');
    const result = await recordedBatch(o.owner, {
      paymentDate: '2026-03-20',
      rateOverrides: [{ currencyCode: 'USD', rate: '15.60', reason: 'Bank deal' }],
      bills: [{ billId: b1.id, amount: '100' }],
    });
    const payment = (await o.owner.get(`/purchases/payments/${result.payments[0].id}`)).body.data;
    expect(payment).toMatchObject({
      exchangeRate: '15.6000000000',
      exchangeRateSource: 'manual',
      tableRate: '15.5000000000',
      rateOverrideReason: 'Bank deal',
    });
    const { rows } = await owner.query(
      `SELECT metadata FROM audit_events WHERE resource_id = $1 AND action = 'vendor_payment.rate_overridden'`,
      [payment.id],
    );
    expect(rows[0].metadata).toMatchObject({ reason: 'Bank deal', tableRate: '15.5000000000' });
    const noReason = await batch(o.owner, {
      paymentDate: '2026-03-21',
      rateOverrides: [{ currencyCode: 'USD', rate: '15.6', reason: '' }],
      bills: [{ billId: b1.id, amount: '1' }],
    });
    expect(noReason.status).toBe(400);
    const local = await batch(o.owner, {
      paymentDate: '2026-03-20',
      rateOverrides: [{ currencyCode: 'MVR', rate: '2', reason: 'x' }],
      bills: [{ billId: (await postedBill(o, o.vendorA, '10')).id, amount: '10' }],
    });
    expect(issuesOf(local)).toEqual([
      {
        path: 'rateOverrides.MVR',
        message: 'A base-currency payment has no exchange rate to override.',
      },
    ]);
  });

  it('refuses invalid selections before recording anything', async () => {
    const o = await payOrg();
    const a1 = await postedBill(o, o.vendorA, '100');
    const later = await postedBill(o, o.vendorA, '30', { billDate: '2026-03-25' });
    const draft = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorA,
      billDate: '2026-03-10',
      lines: [{ description: 'x', quantity: '1', unitPrice: '10' }],
    });
    const base = { paymentDate: '2026-03-20' };
    const check = async (body: Record<string, unknown>) =>
      issuesOf(await batch(o.owner, { ...base, ...body }));
    expect(await check({ bills: [{ billId: a1.id, amount: '100.01' }] })).toEqual([
      { path: 'bills.0.amount', message: 'The bill has 100.00 outstanding.' },
    ]);
    expect(await check({ bills: [{ billId: a1.id, amount: '0' }] })).toEqual([
      { path: 'bills.0.amount', message: 'Enter an amount greater than zero.' },
    ]);
    expect(
      await check({
        bills: [
          { billId: a1.id, amount: '10' },
          { billId: a1.id, amount: '10' },
        ],
      }),
    ).toEqual([{ path: 'bills.1.billId', message: 'Choose each bill once.' }]);
    expect(await check({ bills: [{ billId: randomUUID(), amount: '1' }] })).toEqual([
      { path: 'bills.0.billId', message: 'Bill not found.' },
    ]);
    expect(await check({ bills: [{ billId: draft.body.data.id, amount: '1' }] })).toEqual([
      { path: 'bills.0.billId', message: 'Only posted bills can be settled.' },
    ]);
    expect(
      await check({
        bills: [
          { billId: a1.id, amount: '10' },
          { billId: later.id, amount: '10' },
        ],
      }),
    ).toEqual([{ path: 'bills.1.billId', message: 'The bill is dated after this payment.' }]);
    expect(
      await check({
        accounts: [{ currencyCode: 'MVR', paymentAccountId: o.accounts['5400'] }],
        bills: [{ billId: a1.id, amount: '10' }],
      }),
    ).toEqual([
      {
        path: 'accounts.MVR',
        message: 'Choose a bank, cash or credit card account (Decision 42, P4-26).',
      },
    ]);
    expect(
      await check({
        accounts: [{ currencyCode: 'EUR', paymentAccountId: o.accounts['1120'] }],
        bills: [{ billId: a1.id, amount: '10' }],
      }),
    ).toEqual([{ path: 'accounts.0.currencyCode', message: 'No selected bill is in EUR.' }]);
    // D5: at most 2,000 bills (the schema refuses before any lookup).
    const tooMany = await batch(o.owner, {
      ...base,
      bills: Array.from({ length: 2001 }, () => ({ billId: randomUUID(), amount: '1' })),
    });
    expect(tooMany.status).toBe(400);
    expect((await batch(o.owner, { ...base, bills: [] })).status).toBe(400);
    expect(
      (await batch(o.owner, { ...base, bills: [{ billId: a1.id, amount: '1' }], extra: 1 })).status,
    ).toBe(400);
    expect(await counts(o)).toEqual({ payments: 0, batches: 0, events: 0 });
    expect(await dueOf(o, a1.id)).toBe('100.00');
  });

  it('rolls everything back when any payment fails (designation, closed period)', async () => {
    const o = await payOrg();
    const a1 = await postedBill(o, o.vendorA, '100');
    const b1 = await postedBill(o, o.vendorB, '100'); // carried at 15.42, paid at 15.50: FX
    await owner.query(
      `DELETE FROM accounting_designations WHERE organization_id = $1 AND designation = 'REALIZED_FX_GAIN_LOSS'`,
      [o.organizationId],
    );
    const fx = await batch(o.owner, {
      paymentDate: '2026-03-20',
      bills: [
        { billId: a1.id, amount: '100' },
        { billId: b1.id, amount: '100' },
      ],
    });
    expect(fx.body.error.code).toBe('DESIGNATION_REQUIRED');
    expect(await counts(o)).toEqual({ payments: 0, batches: 0, events: 0 });
    expect(await dueOf(o, a1.id)).toBe('100.00');
    const march = o.periods.find((p) => p.startDate === '2026-03-01')!;
    expect((await o.owner.post(`/accounting/periods/${march.id}/close`)).status).toBe(200);
    const closed = await batch(o.owner, {
      paymentDate: '2026-03-20',
      bills: [{ billId: a1.id, amount: '100' }],
    });
    expect(closed.body.error.code).toBe('PERIOD_CLOSED');
    expect(await counts(o)).toEqual({ payments: 0, batches: 0, events: 0 });
  });

  it('refuses the whole batch when any payment needs approval, naming the groups (D3)', async () => {
    const o = await payOrg();
    const roles = (await o.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    const policy = await o.owner.put('/approvals/policies/purchases.payment.record', {
      steps: [
        {
          name: 'AP supervisor',
          requiredApprovals: 1,
          roleIds: [roles.find((r) => r.name === 'Administrator')!.id],
          membershipIds: [],
          conditions: { minBaseAmount: '1000', transactionTypes: ['payment'] },
        },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const small = await postedBill(o, o.vendorA, '100');
    const big = await postedBill(o, o.vendorB, '100'); // 1,550.00 base at 15.50
    const refused = await batch(o.owner, {
      paymentDate: '2026-03-20',
      bills: [
        { billId: small.id, amount: '100' },
        { billId: big.id, amount: '100' },
      ],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('APPROVAL_REQUIRED');
    expect(issuesOf(refused)).toEqual([
      {
        path: 'groups.1',
        message: 'Blue Lagoon Imports: 100.00 USD (1550.00 MVR) needs approval.',
      },
    ]);
    expect(await counts(o)).toEqual({ payments: 0, batches: 0, events: 0 });
    const ok = await recordedBatch(o.owner, {
      paymentDate: '2026-03-20',
      bills: [{ billId: small.id, amount: '100' }],
    });
    expect(ok.paymentCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency and concurrency
// ---------------------------------------------------------------------------

describe('Pay bills idempotency and concurrency', () => {
  it('replays the same batch under the same Idempotency-Key', async () => {
    const o = await payOrg();
    const a1 = await postedBill(o, o.vendorA, '100');
    const b1 = await postedBill(o, o.vendorB, '10');
    const body = {
      paymentDate: '2026-03-20',
      bills: [
        { billId: a1.id, amount: '100' },
        { billId: b1.id, amount: '10' },
      ],
    };
    const key = randomUUID();
    const first = await batch(o.owner, body, { 'idempotency-key': key });
    const second = await batch(o.owner, body, { 'idempotency-key': key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.payments.map((p: { id: string }) => p.id)).toEqual(
      first.body.data.payments.map((p: { id: string }) => p.id),
    );
    expect(await counts(o)).toEqual({ payments: 2, batches: 1, events: 2 });
    // A new key on the same bills: nothing left to pay.
    const again = await batch(o.owner, body, { 'idempotency-key': randomUUID() });
    expect(issuesOf(again)).toContainEqual({
      path: 'bills.0.billId',
      message: 'The bill is already settled.',
    });
  });

  it('settles a bill once when batches or a single payment race for it', async () => {
    const o = await payOrg();
    const a1 = await postedBill(o, o.vendorA, '100');
    const body = { paymentDate: '2026-03-20', bills: [{ billId: a1.id, amount: '100' }] };
    const pair = await Promise.all([batch(o.owner, body), batch(o.owner, body)]);
    expect(pair.map((r) => r.status).sort()).toEqual([201, 400]);
    const a2 = await postedBill(o, o.vendorA, '50');
    const single = await o.owner.post('/purchases/payments', {
      vendorId: o.vendorA,
      paymentDate: '2026-03-20',
      amount: '50',
      allocations: [{ billId: a2.id, amount: '50' }],
    });
    const race = await Promise.all([
      batch(o.owner, { paymentDate: '2026-03-20', bills: [{ billId: a2.id, amount: '50' }] }),
      o.owner.post(`/purchases/payments/${single.body.data.id}/record`, {
        version: single.body.data.version,
      }),
    ]);
    // One succeeds (201 batch or 200 record), the other is refused cleanly.
    const statuses = race.map((r) => r.status);
    expect(statuses.filter((s) => s >= 400)).toEqual([400]);
    expect(statuses.filter((s) => s < 300)).toHaveLength(1);
    expect(await dueOf(o, a2.id)).toBe('0.00');
    await expectReconciled(o, '0.00');
  });
});

// ---------------------------------------------------------------------------
// Security, guards and the life of batch payments
// ---------------------------------------------------------------------------

describe('Pay bills security and guards', () => {
  it('needs vendor_payments.create to record and view to read; stays tenant-isolated', async () => {
    const o = await payOrg();
    const a1 = await postedBill(o, o.vendorA, '100');
    const result = await recordedBatch(o.owner, {
      paymentDate: '2026-03-20',
      bills: [{ billId: a1.id, amount: '40' }],
    });
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/purchases/payment-batches')).status).toBe(200);
    expect((await member.client.get(`/purchases/payment-batches/${result.id}`)).status).toBe(200);
    expect(
      (
        await batch(member.client, {
          paymentDate: '2026-03-20',
          bills: [{ billId: a1.id, amount: '1' }],
        })
      ).status,
    ).toBe(403);
    expect((await member.client.get('/purchases/pay-bills/open-bills')).status).toBe(403);
    const other = await payOrg();
    expect((await other.owner.get(`/purchases/payment-batches/${result.id}`)).status).toBe(404);
    const cross = await batch(other.owner, {
      paymentDate: '2026-03-20',
      bills: [{ billId: a1.id, amount: '1' }],
    });
    expect(issuesOf(cross)).toEqual([{ path: 'bills.0.billId', message: 'Bill not found.' }]);
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [other.organizationId]);
      expect((await app.query('SELECT id FROM purchases_payment_batches')).rows).toEqual([]);
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
  });

  it('keeps the batch immutable and the payment link set once (database)', async () => {
    const o = await payOrg();
    const a1 = await postedBill(o, o.vendorA, '100');
    const result = await recordedBatch(o.owner, {
      paymentDate: '2026-03-20',
      bills: [{ billId: a1.id, amount: '60' }],
    });
    await expect(
      owner.query(`UPDATE purchases_payment_batches SET memo = 'x' WHERE id = $1`, [result.id]),
    ).rejects.toThrow();
    await expect(
      owner.query(`DELETE FROM purchases_payment_batches WHERE id = $1`, [result.id]),
    ).rejects.toThrow();
    await expect(
      owner.query(`UPDATE purchases_payments SET payment_batch_id = NULL WHERE id = $1`, [
        result.payments[0].id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    // A recorded payment outside a batch cannot be attached to one later.
    const single = await o.owner.post('/purchases/payments', {
      vendorId: o.vendorA,
      paymentDate: '2026-03-20',
      amount: '10',
      allocations: [],
    });
    await o.owner.post(`/purchases/payments/${single.body.data.id}/record`, {
      version: single.body.data.version,
    });
    await expect(
      owner.query(`UPDATE purchases_payments SET payment_batch_id = $2 WHERE id = $1`, [
        single.body.data.id,
        result.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('voids a batch payment on its own; the batch detail follows the payments', async () => {
    const o = await payOrg();
    const a1 = await postedBill(o, o.vendorA, '100');
    const b1 = await postedBill(o, o.vendorB, '10');
    const result = await recordedBatch(o.owner, {
      paymentDate: '2026-03-20',
      bills: [
        { billId: a1.id, amount: '100' },
        { billId: b1.id, amount: '10' },
      ],
    });
    const first = (await o.owner.get(`/purchases/payments/${result.payments[0].id}`)).body.data;
    const voided = await o.owner.post(`/purchases/payments/${first.id}/void`, {
      version: first.version,
      reason: 'Paid in error',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const detail = (await o.owner.get(`/purchases/payment-batches/${result.id}`)).body.data;
    expect(detail.payments.map((p: { status: string }) => p.status)).toEqual(['VOID', 'RECORDED']);
    expect(await dueOf(o, a1.id)).toBe('100.00');
    expect(await dueOf(o, b1.id)).toBe('0.00');
    await expectReconciled(o, '100.00');
  });

  it('lists open bills across vendors with vendor, currency and due-date filters', async () => {
    const o = await payOrg();
    await postedBill(o, o.vendorA, '100'); // due 2026-04-09
    await postedBill(o, o.vendorB, '10', { dueDate: '2026-03-31' });
    const all = (await o.owner.get('/purchases/pay-bills/open-bills')).body.data as {
      vendorName: string;
      currencyCode: string;
      dueDate: string;
    }[];
    expect(all.map((b) => [b.vendorName, b.currencyCode, b.dueDate])).toEqual([
      ['Blue Lagoon Imports', 'USD', '2026-03-31'],
      ['Atoll Supplies', 'MVR', '2026-04-09'],
    ]);
    expect(
      (await o.owner.get('/purchases/pay-bills/open-bills?currencyCode=MVR')).body.data,
    ).toHaveLength(1);
    expect(
      (await o.owner.get(`/purchases/pay-bills/open-bills?vendorId=${o.vendorB}`)).body.data,
    ).toHaveLength(1);
    expect(
      (await o.owner.get('/purchases/pay-bills/open-bills?dueBefore=2026-04-01')).body.data,
    ).toHaveLength(1);
  });
});
