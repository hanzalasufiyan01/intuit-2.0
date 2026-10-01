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
 * Phase 3B steps 8–11: receipts (D2, D3; Decisions 36, 37, 42), allocations and customer credit
 * (Decisions 38, 39), realized FX through `realized_fx` system journals (Decision 10, E1) and
 * receipt void through Sales (Decision 40, E2). AR subledger = AR control account throughout.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

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

async function invoice(o: SalesOrg, amount: string, invoiceDate = '2026-03-10', client = o.owner) {
  const created = await client.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate,
    lines: [{ description: 'Services', quantity: '1', unitPrice: amount }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const issued = await client.post(`/sales/invoices/${created.body.data.id}/issue`, {
    version: created.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data as { id: string; number: string; amountDue: string; baseDue: string };
}

async function receive(o: SalesOrg, body: object, client: TestClient = o.owner) {
  const res = await client.post('/sales/receipts', {
    customerId: o.customerId,
    receiptDate: '2026-03-20',
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function withOwnerDb<T>(work: (db: Awaited<ReturnType<typeof connectAs>>) => Promise<T>) {
  const db = await connectAs('owner');
  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

async function balance(organizationId: string, accountId: string) {
  return withOwnerDb(async (db) => {
    const { rows } = await db.query(
      `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
         FROM accounting_journal_lines l
         JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
        WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
      [organizationId, accountId],
    );
    return rows[0].b as string;
  });
}

/** The AR subledger: open invoices less unapplied customer credit, in base. */
async function subledger(organizationId: string) {
  return withOwnerDb(async (db) => {
    const { rows } = await db.query(
      `SELECT ((SELECT coalesce(sum(base_due), 0) FROM sales_invoices
                 WHERE organization_id = $1 AND status = 'ISSUED')
             - (SELECT coalesce(sum(base_unallocated), 0) FROM sales_receipts
                 WHERE organization_id = $1 AND status = 'RECORDED'))::numeric(28,2)::text AS b`,
      [organizationId],
    );
    return rows[0].b as string;
  });
}

async function expectReconciled(o: SalesOrg) {
  expect(await balance(o.organizationId, o.accounts['1130']!)).toBe(
    await subledger(o.organizationId),
  );
}

async function rate(o: SalesOrg, rateDate: string, value: string) {
  const res = await o.owner.post('/accounting/exchange-rates', {
    fromCurrency: 'USD',
    rateDate,
    rate: value,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

// ---------------------------------------------------------------------------

describe('base-currency receipts (Decisions 36, 38)', () => {
  it('pays invoices fully and partly, keeps the excess as customer credit', async () => {
    const o = await salesOrg();
    const a = await invoice(o, '540');
    const b = await invoice(o, '300');
    const receipt = await receive(o, {
      amount: '1000',
      reference: 'TT-7781',
      allocations: [
        { invoiceId: a.id, amount: '540' },
        { invoiceId: b.id, amount: '200' },
      ],
    });
    expect(receipt).toMatchObject({
      status: 'RECORDED',
      number: 'RCT-00001',
      amount: '1000.00',
      exchangeRateSource: 'base',
      depositAccountId: o.accounts['1120'],
      depositAccountOverridden: false,
      amountUnallocated: '260.00',
      baseAmount: '1000.0000',
    });
    expect(receipt.allocations).toHaveLength(2);
    const [paidA, paidB] = await Promise.all(
      [a.id, b.id].map(async (id) => (await o.owner.get(`/sales/invoices/${id}`)).body.data),
    );
    expect(paidA.amountDue).toBe('0.00');
    expect(paidB.amountDue).toBe('100.00');
    const journal = (await o.owner.get(`/accounting/journals/${receipt.journalId}`)).body.data;
    expect(journal).toMatchObject({
      source: 'event',
      sourceModule: 'sales',
      sourceType: 'receipt',
    });
    expect(await balance(o.organizationId, o.accounts['1120']!)).toBe('1000.00');
    // 840 invoiced - 740 received against invoices - 260 credit = -160 on the AR control.
    expect(await balance(o.organizationId, o.accounts['1130']!)).toBe('-160.00');
    await expectReconciled(o);
  });

  it('validates allocations, the deposit account (D3) and base-currency rates', async () => {
    const o = await salesOrg();
    const inv = await invoice(o, '500', '2026-03-10');
    const later = await invoice(o, '100', '2026-03-25');
    const other = await o.owner.post('/customers', {
      party: { kind: 'organization', displayName: 'Other Co' },
    });
    const expectIssue = async (body: object, path: string) => {
      const res = await o.owner.post('/sales/receipts', {
        customerId: o.customerId,
        receiptDate: '2026-03-20',
        amount: '100',
        ...body,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.details.issues.map((i: { path: string }) => i.path)).toContain(path);
    };
    await expectIssue(
      { amount: '600', allocations: [{ invoiceId: inv.id, amount: '600' }] },
      'allocations.0.amount',
    );
    await expectIssue({ allocations: [{ invoiceId: inv.id, amount: '150' }] }, 'allocations');
    await expectIssue(
      { allocations: [{ invoiceId: later.id, amount: '50' }] },
      'allocations.0.invoiceId',
    );
    await expectIssue(
      { customerId: other.body.data.id, allocations: [{ invoiceId: inv.id, amount: '50' }] },
      'allocations.0.invoiceId',
    );
    await expectIssue(
      {
        currencyCode: 'USD',
        exchangeRate: '15',
        rateOverrideReason: 'x',
        allocations: [{ invoiceId: inv.id, amount: '50' }],
      },
      'allocations.0.invoiceId',
    );
    await expectIssue({ exchangeRate: '1.1', rateOverrideReason: 'x' }, 'exchangeRate');
    await expectIssue({ depositAccountId: o.accounts['4100'] }, 'depositAccountId');
    await expectIssue({ amount: '10.001' }, 'amount');
    // D3: another eligible bank/cash account in the right currency is allowed, and audited.
    const cash = await receive(o, { amount: '100', depositAccountId: o.accounts['1110'] });
    expect(cash.depositAccountOverridden).toBe(true);
    await withOwnerDb(async (db) => {
      const { rows } = await db.query(
        `SELECT metadata FROM audit_events WHERE organization_id = $1 AND resource_id = $2 AND action = 'receipt.recorded'`,
        [o.organizationId, cash.id],
      );
      expect(rows[0].metadata).toMatchObject({
        depositAccountId: o.accounts['1110'],
        defaultDepositAccountId: o.accounts['1120'],
        depositAccountOverridden: true,
      });
    });
  });

  it('replays a receipt with the same Idempotency-Key', async () => {
    const o = await salesOrg();
    const key = randomUUID();
    const body = { customerId: o.customerId, receiptDate: '2026-03-20', amount: '50' };
    const first = await o.owner.post('/sales/receipts', body, { 'idempotency-key': key });
    const again = await o.owner.post('/sales/receipts', body, { 'idempotency-key': key });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data.id).toBe(first.body.data.id);
    expect((await o.owner.get('/sales/receipts')).body.data.items).toHaveLength(1);
  });

  it('serializes concurrent payments of the same invoice', async () => {
    const o = await salesOrg();
    const inv = await invoice(o, '500');
    const pay = () =>
      o.owner.post('/sales/receipts', {
        customerId: o.customerId,
        receiptDate: '2026-03-20',
        amount: '500',
        allocations: [{ invoiceId: inv.id, amount: '500' }],
      });
    const results = await Promise.all([pay(), pay(), pay()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400]);
    await expectReconciled(o);
  });
});

describe('foreign-currency receipts and realized FX (Decisions 10, 37; D2, E1)', () => {
  it('relieves AR at the historical base and posts the difference as realized FX', async () => {
    const o = await salesOrg('USD');
    await rate(o, '2026-03-01', '15.42');
    const inv = await invoice(o, '1000'); // USD 1000 -> MVR 15,420
    await rate(o, '2026-03-15', '15.50');
    const receipt = await receive(o, {
      amount: '1000',
      allocations: [{ invoiceId: inv.id, amount: '1000' }],
    });
    expect(receipt).toMatchObject({
      currencyCode: 'USD',
      exchangeRate: '15.5000000000',
      exchangeRateSource: 'table',
      baseAmount: '15500.0000',
    });
    expect(receipt.allocations[0]).toMatchObject({
      baseRelieved: '15420.0000',
      fxDifference: '80.0000',
    });
    const journal = (await o.owner.get(`/accounting/journals/${receipt.journalId}`)).body.data;
    expect(journal).toMatchObject({
      source: 'system',
      sourceModule: 'sales',
      sourceType: 'realized_fx',
    });
    const fxAccount = await fxAccountId(o);
    expect(await balance(o.organizationId, fxAccount)).toBe('-80.00'); // a gain
    expect(await balance(o.organizationId, o.accounts['1130']!)).toBe('0.00');
    expect(await balance(o.organizationId, o.accounts['1120']!)).toBe('15500.00');
    await expectReconciled(o);
  });

  it('clears the historical base exactly across partial payments at different rates', async () => {
    const o = await salesOrg('USD');
    await rate(o, '2026-03-01', '15.4237');
    const inv = await invoice(o, '999.99');
    await rate(o, '2026-03-15', '15.3111');
    await receive(o, { amount: '333.33', allocations: [{ invoiceId: inv.id, amount: '333.33' }] });
    await rate(o, '2026-03-18', '15.6789');
    await receive(o, {
      amount: '333.33',
      receiptDate: '2026-03-19',
      allocations: [{ invoiceId: inv.id, amount: '333.33' }],
    });
    const last = await receive(o, {
      amount: '333.33',
      receiptDate: '2026-03-21',
      allocations: [{ invoiceId: inv.id, amount: '333.33' }],
    });
    expect(last.allocations[0].fxDifference).not.toBe('0.0000');
    const settled = (await o.owner.get(`/sales/invoices/${inv.id}`)).body.data;
    expect(settled).toMatchObject({ amountDue: '0.00', baseDue: '0.0000' });
    expect(await balance(o.organizationId, o.accounts['1130']!)).toBe('0.00');
    await expectReconciled(o);
  });

  it('overrides the rate only with a reason and keeps the table rate (D2)', async () => {
    const o = await salesOrg('USD');
    await rate(o, '2026-03-01', '15.42');
    const inv = await invoice(o, '100');
    const noReason = await o.owner.post('/sales/receipts', {
      customerId: o.customerId,
      receiptDate: '2026-03-20',
      amount: '100',
      exchangeRate: '15.60',
      allocations: [{ invoiceId: inv.id, amount: '100' }],
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details.issues[0].path).toBe('rateOverrideReason');
    const receipt = await receive(o, {
      amount: '100',
      exchangeRate: '15.60',
      rateOverrideReason: 'Bank settlement rate',
      allocations: [{ invoiceId: inv.id, amount: '100' }],
    });
    expect(receipt).toMatchObject({
      exchangeRate: '15.6000000000',
      exchangeRateSource: 'manual',
      tableRate: '15.4200000000',
      rateOverrideReason: 'Bank settlement rate',
      baseAmount: '1560.0000',
    });
    expect(receipt.allocations[0].fxDifference).toBe('18.0000');
    await expectReconciled(o);
  });

  it('needs a rate and a Realized FX designation', async () => {
    const o = await salesOrg('USD');
    await rate(o, '2026-03-01', '15.42');
    const inv = await invoice(o, '100');
    const early = await o.owner.post('/sales/receipts', {
      customerId: o.customerId,
      receiptDate: '2026-02-20',
      amount: '100',
    });
    expect(early.body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
    await withOwnerDb((db) =>
      db.query(
        `DELETE FROM accounting_designations WHERE organization_id = $1 AND designation = 'REALIZED_FX_GAIN_LOSS'`,
        [o.organizationId],
      ),
    );
    await rate(o, '2026-03-15', '15.50');
    const noFx = await o.owner.post('/sales/receipts', {
      customerId: o.customerId,
      receiptDate: '2026-03-20',
      amount: '100',
      allocations: [{ invoiceId: inv.id, amount: '100' }],
    });
    expect(noFx.body.error.code).toBe('DESIGNATION_REQUIRED');
    // At the invoice's own rate there is no FX, so no designation is needed.
    await rate(o, '2026-03-16', '15.42');
    await receive(o, { amount: '100', allocations: [{ invoiceId: inv.id, amount: '100' }] });
    await expectReconciled(o);
  });
});

async function fxAccountId(o: SalesOrg) {
  const res = await o.owner.get('/accounting/designations');
  const rows = res.body.data as { designation: string; accountId: string | null }[];
  return rows.find((d) => d.designation === 'REALIZED_FX_GAIN_LOSS')!.accountId!;
}

describe('customer credit (Decisions 38, 39)', () => {
  it('applies a receipt excess to later invoices, with FX when bases differ', async () => {
    const o = await salesOrg('USD');
    await rate(o, '2026-03-01', '15.00');
    const receipt = await receive(o, { amount: '500', receiptDate: '2026-03-05' }); // all credit
    expect(receipt).toMatchObject({ amountUnallocated: '500.00', baseUnallocated: '7500.0000' });
    await rate(o, '2026-03-08', '15.40');
    const inv = await invoice(o, '300'); // 4,620 base
    const tooMuch = await o.owner.post('/sales/customer-credit/apply', {
      sourceType: 'receipt',
      sourceId: receipt.id,
      date: '2026-03-12',
      allocations: [{ invoiceId: inv.id, amount: '301' }],
    });
    expect(tooMuch.status).toBe(400);
    const applied = await o.owner.post('/sales/customer-credit/apply', {
      sourceType: 'receipt',
      sourceId: receipt.id,
      date: '2026-03-12',
      allocations: [{ invoiceId: inv.id, amount: '300' }],
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.data).toMatchObject({
      amountRemaining: '200.00',
      baseRemaining: '3000.0000',
    });
    const credit = applied.body.data.allocations.find((a: { mode: string }) => a.mode === 'credit');
    // Released at 15.00 (4,500) against 4,620 relieved: a 120 loss.
    expect(credit).toMatchObject({
      sourceBase: '4500.0000',
      baseRelieved: '4620.0000',
      fxDifference: '-120.0000',
    });
    expect((await o.owner.get(`/sales/invoices/${inv.id}`)).body.data.amountDue).toBe('0.00');
    expect(await balance(o.organizationId, await fxAccountId(o))).toBe('120.00');
    await expectReconciled(o);
  });

  it('applies base-currency credit without FX', async () => {
    const o = await salesOrg();
    const receipt = await receive(o, { amount: '400', receiptDate: '2026-03-05' });
    const inv = await invoice(o, '250');
    const applied = await o.owner.post('/sales/customer-credit/apply', {
      sourceType: 'receipt',
      sourceId: receipt.id,
      date: '2026-03-12',
      allocations: [{ invoiceId: inv.id, amount: '250' }],
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.data.amountRemaining).toBe('150.00');
    await expectReconciled(o);
  });
});

describe('receipt void (Decision 40, E2)', () => {
  it('reverses the receipt and its credit applications and restores the invoices', async () => {
    const o = await salesOrg('USD');
    await rate(o, '2026-03-01', '15.42');
    const a = await invoice(o, '600');
    const b = await invoice(o, '400', '2026-03-11');
    await rate(o, '2026-03-15', '15.50');
    const receipt = await receive(o, {
      amount: '1000',
      allocations: [{ invoiceId: a.id, amount: '600' }],
    });
    await o.owner.post('/sales/customer-credit/apply', {
      sourceType: 'receipt',
      sourceId: receipt.id,
      date: '2026-03-21',
      allocations: [{ invoiceId: b.id, amount: '250' }],
    });
    const before = (await o.owner.get(`/sales/receipts/${receipt.id}`)).body.data;

    // Generic reversal cannot touch Sales journals (E2).
    const manual = await o.owner.post(`/accounting/journals/${receipt.journalId}/reverse`, {
      reason: 'Manual attempt',
    });
    expect(manual.body.error.code).toBe('SYSTEM_JOURNAL');

    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (
        await member.client.post(`/sales/receipts/${receipt.id}/void`, {
          version: before.version,
          reason: 'Manual attempt',
        })
      ).status,
    ).toBe(403);
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await o.owner.post(`/sales/receipts/${receipt.id}/void`, {
      version: before.version,
      reason: 'Bounced',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await o.owner.reauthenticate();
    const voided = await o.owner.post(`/sales/receipts/${receipt.id}/void`, {
      version: before.version,
      reason: 'Bounced',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({
      status: 'VOID',
      amountUnallocated: '0.00',
      voidReason: 'Bounced',
    });
    expect(
      voided.body.data.allocations.filter(
        (x: { reversesAllocationId: string | null }) => x.reversesAllocationId,
      ),
    ).toHaveLength(2);
    for (const [id, due] of [
      [a.id, '600.00'],
      [b.id, '400.00'],
    ] as const) {
      expect((await o.owner.get(`/sales/invoices/${id}`)).body.data.amountDue).toBe(due);
    }
    const original = (await o.owner.get(`/accounting/journals/${receipt.journalId}`)).body.data;
    expect(original.status).toBe('REVERSED');
    expect(await balance(o.organizationId, await fxAccountId(o))).toBe('0.00');
    expect(await balance(o.organizationId, o.accounts['1120']!)).toBe('0.00');
    await expectReconciled(o);
    // The reversal journal is protected too.
    const reversal = await o.owner.post(
      `/accounting/journals/${voided.body.data.voidJournalId}/reverse`,
      { reason: 'Manual attempt' },
    );
    expect(reversal.body.error.code).toBe('SYSTEM_JOURNAL');
    const again = await o.owner.post(`/sales/receipts/${receipt.id}/void`, {
      version: voided.body.data.version,
      reason: 'Manual attempt',
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('protects receipts and allocations in the database', async () => {
    const o = await salesOrg();
    const inv = await invoice(o, '100');
    const receipt = await receive(o, {
      amount: '100',
      allocations: [{ invoiceId: inv.id, amount: '100' }],
    });
    const app = await connectAs('app');
    try {
      const inTenant = async (statement: string) => {
        await app.query('BEGIN');
        try {
          await app.query(`SELECT set_config('app.organization_id', $1, true)`, [o.organizationId]);
          return await app.query(statement);
        } finally {
          await app.query('ROLLBACK');
        }
      };
      await expect(
        inTenant(`UPDATE sales_receipts SET amount = 1 WHERE id = '${receipt.id}'`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        inTenant(`DELETE FROM sales_receipts WHERE id = '${receipt.id}'`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        inTenant(`UPDATE sales_allocations SET amount = 1 WHERE receipt_id = '${receipt.id}'`),
      ).rejects.toThrow();
      await expect(
        inTenant(`DELETE FROM sales_allocations WHERE receipt_id = '${receipt.id}'`),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.end();
    }
    // Generic reversal of an invoice journal is refused as well (E2).
    const invoiceJournal = (await o.owner.get(`/sales/invoices/${inv.id}`)).body.data.journalId;
    const refused = await o.owner.post(`/accounting/journals/${invoiceJournal}/reverse`, {
      reason: 'Manual attempt',
    });
    expect(refused.body.error.code).toBe('SYSTEM_JOURNAL');
  });
});
