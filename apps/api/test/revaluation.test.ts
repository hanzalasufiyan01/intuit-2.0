import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runDevRevaluation } from '../src/application/revaluation-dev-trigger.js';
import { setDbContext, inTransaction } from '../src/application/unit-of-work.js';
import {
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/**
 * Phase 3A S9: foreign-currency revaluation support. Runs post one base-only revaluation journal
 * per currency on D and its mirrored reversal on D + 1, atomically; cancellation, idempotency,
 * validation, exposure eligibility (including the N9 monetary assets), the resulting reports,
 * database protections, RLS, permissions, re-authentication, MFA and the development trigger.
 * S9 has no HTTP routes, so the service is called with a Principal resolved from a real session.
 */

let ctx: TestContext;
const origin = { requestId: 'revaluation-test', ipAddress: null, userAgent: 'vitest' };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const reval = () => ctx.services.revaluations;
const devDeps = () => ({ db: ctx.database.db, config: ctx.config });

async function principal(client: TestClient) {
  const found = await ctx.services.auth.authenticate(client.sessionToken!, origin);
  if (!found) throw new Error('no session');
  return found;
}

async function createAccount(o: AccountingOrg, body: Record<string, unknown>): Promise<string> {
  const res = await o.owner.post('/accounting/accounts', {
    type: 'ASSET',
    parentId: o.accounts['1100'],
    currencyCode: 'USD',
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id;
}

async function rate(o: AccountingOrg, fromCurrency: string, rateDate: string, value: string) {
  const res = await o.owner.post('/accounting/exchange-rates', {
    fromCurrency,
    rateDate,
    rate: value,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

interface Org extends AccountingOrg {
  usdBank: string;
}

/** FY2026; a USD bank holding 1,000 USD deposited on 2026-01-15 at 15.42; 15.50 on 2026-03-31. */
async function org(): Promise<Org> {
  const base = await setUpAccountingOrg(ctx);
  const usdBank = await createAccount(base, { code: '1125', name: 'Bank USD', subtype: 'BANK' });
  await rate(base, 'USD', '2026-01-01', '15.42');
  await postJournal(base, {
    entryDate: '2026-01-15',
    description: 'USD deposit',
    currency: 'USD',
    lines: [line(usdBank, 'debit', '1000.00'), line(base.accounts['4100']!, 'credit', '1000.00')],
  } as never);
  await rate(base, 'USD', '2026-03-31', '15.50');
  return { ...base, usdBank };
}

const post = async (o: AccountingOrg, revaluationDate: string, extra: object = {}) =>
  reval().post(await principal(o.owner), { revaluationDate, ...extra }, origin);

async function tbRow(client: TestClient, code: string, from: string, to: string) {
  const tb = await client.get(
    `/accounting/reports/trial-balance?from=${from}&to=${to}&currencyView=base_and_account&includeZero=true`,
  );
  expect(tb.status, JSON.stringify(tb.body)).toBe(200);
  return (tb.body.data.rows as any[]).find((r) => r.code === code);
}

async function auditEvents(client: TestClient) {
  const res = await client.get('/organizations/current/audit-events?limit=100');
  return res.body.data as { action: string; requestId: string; metadata: Record<string, any> }[];
}

async function asOwnerDb(work: (db: Awaited<ReturnType<typeof connectAs>>) => Promise<unknown>) {
  const db = await connectAs('owner');
  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

describe('posting a revaluation run', () => {
  it('posts one base-only journal on D and its mirrored reversal on D + 1', async () => {
    const o = await org();
    const run = await post(o, '2026-03-31');
    expect(run).toMatchObject({
      status: 'POSTED',
      method: 'REVERSING',
      revaluationDate: '2026-03-31',
      reversalDate: '2026-04-01',
      totalGain: '80',
      totalLoss: '0',
      netAdjustment: '80',
      lineCount: 1,
      journalCount: 1,
      trigger: 'user',
      replayed: false,
    });
    expect(run.lines).toEqual([
      expect.objectContaining({
        exposureKind: 'ACCOUNT',
        accountId: o.usdBank,
        currency: 'USD',
        foreignBalance: '1000',
        carryingBase: '15420',
        rate: '15.5',
        rateDate: '2026-03-31',
        rateSource: 'table',
        revaluedBase: '15500',
        adjustment: '80',
      }),
    ]);
    expect(run.journals.map((j) => [j.currency, j.role, j.entryDate, j.status])).toEqual([
      ['USD', 'REVALUATION', '2026-03-31', 'POSTED'],
      ['USD', 'SCHEDULED_REVERSAL', '2026-04-01', 'POSTED'],
    ]);

    const [revaluation, reversal] = run.journals;
    const detail = (await o.owner.get(`/accounting/journals/${revaluation!.journalId}`)).body.data;
    expect(detail).toMatchObject({
      source: 'system',
      sourceModule: 'accounting',
      sourceType: 'revaluation',
      sourceId: run.id,
      currency: 'USD',
      exchangeRateSource: 'table',
      totalDebit: '0.0000',
      totalBaseDebit: '80.0000',
    });
    expect(Number(detail.exchangeRate)).toBe(15.5);
    expect(detail.lines.map((l: any) => [l.accountId, l.kind, l.baseDebit, l.baseCredit])).toEqual([
      [o.usdBank, 'base_only', '80.0000', null],
      [o.accounts['4960'], 'base_only', null, '80.0000'],
    ]);
    const mirrored = (await o.owner.get(`/accounting/journals/${reversal!.journalId}`)).body.data;
    expect(mirrored).toMatchObject({ sourceType: 'revaluation_reversal', sourceId: run.id });
    expect(mirrored.lines.map((l: any) => [l.accountId, l.baseDebit, l.baseCredit])).toEqual([
      [o.usdBank, null, '80.0000'],
      [o.accounts['4960'], '80.0000', null],
    ]);

    // Reports: March carries the revaluation; the foreign balance never changes.
    const march = await tbRow(o.owner, '1125', '2026-03-01', '2026-03-31');
    expect(march).toMatchObject({ closingDebit: '15500.0000' });
    expect(march.accountCurrency).toMatchObject({ code: 'USD', closing: '1000.0000' });
    expect(await tbRow(o.owner, '4960', '2026-03-01', '2026-03-31')).toMatchObject({
      closingCredit: '80.0000',
    });
    const pl = await o.owner.get(
      '/accounting/reports/profit-and-loss?from=2026-03-01&to=2026-03-31',
    );
    expect(pl.body.data.summary.netProfit).toEqual(['80.0000']);
    const bs = await o.owner.get('/accounting/reports/balance-sheet?asOf=2026-03-31');
    expect(bs.body.data.integrity.status).toBe('BALANCED');
    // D + 1: the reversal restores the historical carrying amount.
    const april = await tbRow(o.owner, '1125', '2026-04-01', '2026-04-30');
    expect(april).toMatchObject({ closingDebit: '15420.0000' });
    expect(april.accountCurrency).toMatchObject({ closing: '1000.0000' });

    // Decision 80: only the S9 path reverses revaluation journals.
    for (const journal of run.journals) {
      const generic = await o.owner.post(`/accounting/journals/${journal.journalId}/reverse`, {
        reason: 'manual fix',
      });
      expect(generic.status).toBe(409);
      expect(generic.body.error.code).toBe('SYSTEM_JOURNAL');
    }

    const events = await auditEvents(o.owner);
    const posted = events.find((e) => e.action === 'revaluation.posted')!;
    expect(posted.metadata).toMatchObject({
      revaluationDate: '2026-03-31',
      method: 'REVERSING',
      currencies: ['USD'],
      lineCount: 1,
      journalCount: 1,
      totalGain: '80',
      totalLoss: '0',
      netAdjustment: '80',
    });
    expect(posted.metadata.journals).toHaveLength(1);
    expect(posted.metadata.reauthentication).toBe('session');
    expect(JSON.stringify(posted.metadata)).not.toContain(o.ownerEmail);
    expect(events.filter((e) => e.action === 'journal.posted').length).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent by run key and refuses a second run for the same date', async () => {
    const o = await org();
    const first = await post(o, '2026-03-31', { runKey: 'march-close' });
    const replay = await post(o, '2026-03-31', { runKey: 'march-close' });
    expect(replay).toMatchObject({ id: first.id, replayed: true });
    await expect(post(o, '2026-04-30', { runKey: 'march-close' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(post(o, '2026-03-31')).rejects.toMatchObject({ code: 'CONFLICT' });
    const runs = await reval().list(await principal(o.owner));
    expect(runs).toHaveLength(1);
    const journals = await o.owner.get('/accounting/journals?limit=100');
    expect((journals.body.data as any[]).filter((j) => j.sourceId === first.id).length).toBe(2);
  });

  it('records a zero-adjustment run without lines or journals (N7)', async () => {
    const o = await org();
    const run = await post(o, '2026-02-28');
    expect(run).toMatchObject({
      status: 'POSTED',
      lineCount: 0,
      journalCount: 0,
      totalGain: '0',
      totalLoss: '0',
      netAdjustment: '0',
      lines: [],
      journals: [],
    });
    const rows = (await asOwnerDb((db) =>
      db.query(`SELECT count(*)::int AS n FROM accounting_revaluation_lines WHERE run_id = $1`, [
        run.id,
      ]),
    )) as { rows: { n: number }[] };
    expect(rows.rows[0]!.n).toBe(0);
    const posted = (await auditEvents(o.owner)).find((e) => e.action === 'revaluation.posted')!;
    expect(posted.metadata).toMatchObject({ lineCount: 0, journalCount: 0, netAdjustment: '0' });
  });

  it('revalues several currencies, one journal pair each, in currency order', async () => {
    const o = await org();
    const eurBank = await createAccount(o, {
      code: '1126',
      name: 'Bank EUR',
      subtype: 'BANK',
      currencyCode: 'EUR',
    });
    await rate(o, 'EUR', '2026-01-01', '17.00');
    await postJournal(o, {
      entryDate: '2026-01-20',
      description: 'EUR deposit',
      currency: 'EUR',
      lines: [line(eurBank, 'debit', '200.00'), line(o.accounts['4100']!, 'credit', '200.00')],
    } as never);
    await rate(o, 'EUR', '2026-03-31', '16.90');
    const run = await post(o, '2026-03-31');
    expect(run.journals.map((j) => [j.currency, j.role])).toEqual([
      ['EUR', 'REVALUATION'],
      ['EUR', 'SCHEDULED_REVERSAL'],
      ['USD', 'REVALUATION'],
      ['USD', 'SCHEDULED_REVERSAL'],
    ]);
    // EUR: 200 x 16.90 = 3,380 against 3,400 -> loss 20; USD gain 80.
    expect(run).toMatchObject({ totalGain: '80', totalLoss: '20', netAdjustment: '60' });
    expect(await tbRow(o.owner, '4960', '2026-03-01', '2026-03-31')).toMatchObject({
      closingCredit: '60.0000',
    });
  });

  it('leaves realized FX on settlement computed from the historical carrying amount', async () => {
    const o = await org();
    await post(o, '2026-03-31');
    // After the D + 1 reversal, converting the 1,000 USD at 15.60 realizes 180 against 15,420.
    await inTransaction(ctx.database.db, { organizationId: o.organizationId }, async (tx) => {
      await setDbContext(tx, { organizationId: o.organizationId });
      return ctx.services.journals.postSystemJournal(
        tx,
        {
          organizationId: o.organizationId,
          userId: null,
          source: { module: 'banking', type: 'realized_fx', id: randomUUID() },
          entryDate: '2026-04-10',
          description: 'Conversion',
          reference: '',
          currency: 'USD',
          exchangeRate: '15.60',
          lines: [
            {
              accountId: o.accounts['1110']!,
              description: '',
              kind: 'normal',
              debit: '1000.00',
              credit: null,
              baseDebit: '15600.00',
              baseCredit: null,
            },
            {
              accountId: o.usdBank,
              description: '',
              kind: 'normal',
              debit: null,
              credit: '1000.00',
              baseDebit: null,
              baseCredit: '15420.00',
            },
            {
              accountId: o.accounts['4950']!,
              description: '',
              kind: 'base_only',
              debit: null,
              credit: null,
              baseDebit: null,
              baseCredit: '180.00',
            },
          ],
        },
        origin,
      );
    });
    const april = await tbRow(o.owner, '1125', '2026-04-01', '2026-04-30');
    expect(april).toMatchObject({ closingDebit: '0.0000', closingCredit: '0.0000' });
    expect(april.accountCurrency).toMatchObject({ closing: '0.0000' });
    // Nothing is left to revalue at the end of April.
    const next = await post(o, '2026-04-30');
    expect(next).toMatchObject({ lineCount: 0, journalCount: 0, netAdjustment: '0' });
  });
});

describe('cancellation and atomicity', () => {
  it('cancels a run by reversing each of its journals on its own date', async () => {
    const o = await org();
    const run = await post(o, '2026-03-31');
    const owner = await principal(o.owner);
    await expect(
      reval().cancel(owner, run.id, { version: run.version + 1, reason: 'Wrong rate' }, origin),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      reval().cancel(owner, run.id, { version: run.version, reason: ' x ' }, origin),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const cancelled = await reval().cancel(
      owner,
      run.id,
      { version: run.version, reason: 'Rate was entered wrongly' },
      origin,
    );
    expect(cancelled).toMatchObject({
      status: 'REVERSED',
      reversalReason: 'Rate was entered wrongly',
    });
    expect(cancelled.journals.map((j) => [j.role, j.entryDate, j.status])).toEqual([
      ['REVALUATION', '2026-03-31', 'REVERSED'],
      ['SCHEDULED_REVERSAL', '2026-04-01', 'REVERSED'],
      ['CANCELLATION', '2026-03-31', 'POSTED'],
      ['CANCELLATION', '2026-04-01', 'POSTED'],
    ]);
    expect(await tbRow(o.owner, '1125', '2026-03-01', '2026-03-31')).toMatchObject({
      closingDebit: '15420.0000',
    });
    expect(await tbRow(o.owner, '1125', '2026-04-01', '2026-04-30')).toMatchObject({
      closingDebit: '15420.0000',
    });
    const cancellation = cancelled.journals.find((j) => j.role === 'CANCELLATION')!;
    const generic = await o.owner.post(`/accounting/journals/${cancellation.journalId}/reverse`, {
      reason: 'undo',
    });
    expect(generic.body.error.code).toBe('SYSTEM_JOURNAL');
    await expect(
      reval().cancel(owner, run.id, { version: cancelled.version, reason: 'Again please' }, origin),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    // The date can be revalued again once its run is reversed.
    const again = await post(o, '2026-03-31');
    expect(again).toMatchObject({ status: 'POSTED', netAdjustment: '80' });
    const actions = (await auditEvents(o.owner)).map((e) => e.action);
    expect(actions).toContain('revaluation.reversed');
    expect(actions).toContain('journal.reversed');
  });

  it('rolls everything back when a step fails', async () => {
    const o = await org();
    const spy = vi
      .spyOn(ctx.services.journals, 'reverseRevaluationJournalInTransaction')
      .mockRejectedValueOnce(new Error('injected failure'));
    try {
      await expect(post(o, '2026-03-31')).rejects.toThrow('injected failure');
    } finally {
      spy.mockRestore();
    }
    const counts = (await asOwnerDb((db) =>
      db.query(
        `SELECT (SELECT count(*) FROM accounting_revaluation_runs WHERE organization_id = $1)::int AS runs,
                (SELECT count(*) FROM accounting_journal_entries
                  WHERE organization_id = $1 AND source_type LIKE 'revaluation%')::int AS journals`,
        [o.organizationId],
      ),
    )) as { rows: { runs: number; journals: number }[] };
    expect(counts.rows[0]).toEqual({ runs: 0, journals: 0 });
    expect((await post(o, '2026-03-31')).status).toBe('POSTED');
  });
});

describe('validation', () => {
  it('needs the Unrealized FX designation and open periods on D and D + 1', async () => {
    const o = await org();
    const designations = await o.owner.put('/accounting/designations', {
      UNREALIZED_FX_GAIN_LOSS: null,
    });
    expect(designations.status, JSON.stringify(designations.body)).toBe(200);
    await expect(post(o, '2026-03-31')).rejects.toMatchObject({ code: 'DESIGNATION_REQUIRED' });
    await o.owner.put('/accounting/designations', { UNREALIZED_FX_GAIN_LOSS: o.accounts['4960'] });

    await expect(post(o, '2025-12-31')).rejects.toMatchObject({ code: 'PERIOD_NOT_FOUND' });
    await expect(post(o, '2026-12-31')).rejects.toMatchObject({
      code: 'PERIOD_NOT_FOUND',
      message: expect.stringMatching(/2027-01-01/),
    });
    const period = (start: string) => o.periods.find((p: any) => p.startDate === start)!.id;
    expect((await o.owner.post(`/accounting/periods/${period('2026-04-01')}/close`)).status).toBe(
      200,
    );
    await expect(post(o, '2026-03-31')).rejects.toMatchObject({
      code: 'PERIOD_CLOSED',
      message: expect.stringMatching(/2026-04-01/),
    });
    expect((await o.owner.post(`/accounting/periods/${period('2026-03-01')}/close`)).status).toBe(
      200,
    );
    await expect(post(o, '2026-03-30')).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(await reval().list(await principal(o.owner))).toEqual([]);
  });

  it('needs a closing rate and warns about stale ones', async () => {
    const o = await setUpAccountingOrg(ctx);
    const gbp = await createAccount(o, {
      code: '1127',
      name: 'Bank GBP',
      subtype: 'BANK',
      currencyCode: 'GBP',
    });
    await postJournal(o, {
      entryDate: '2026-01-15',
      description: 'GBP deposit at an agreed rate',
      currency: 'GBP',
      exchangeRate: '19.50',
      lines: [line(gbp, 'debit', '10.00'), line(o.accounts['4100']!, 'credit', '10.00')],
    } as never);
    await expect(post(o, '2026-03-31')).rejects.toMatchObject({
      code: 'EXCHANGE_RATE_REQUIRED',
      message: expect.stringMatching(/No GBP to MVR rate/),
    });
    await rate(o, 'GBP', '2026-01-31', '19.70');
    const preview = await reval().preview(await principal(o.owner), {
      revaluationDate: '2026-03-31',
    });
    expect(preview.errors).toEqual([]);
    expect(preview.warnings[0]!.message).toMatch(/latest GBP rate is dated 2026-01-31/);
    expect(preview.lines[0]).toMatchObject({
      carryingBase: '195',
      revaluedBase: '197',
      adjustment: '2',
    });
  });

  it('blocks the whole run when an eligible account is archived (N8)', async () => {
    const o = await org();
    const archive = await o.owner.post(`/accounting/accounts/${o.usdBank}/archive`);
    expect(archive.status, JSON.stringify(archive.body)).toBe(200);
    await expect(post(o, '2026-03-31')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        issues: [expect.objectContaining({ message: expect.stringMatching(/1125 Bank USD/) })],
      },
    });
    expect(await reval().list(await principal(o.owner))).toEqual([]);
  });
});

describe('exposure eligibility', () => {
  it('revalues only foreign, explicitly monetary, non-control leaf accounts', async () => {
    const o = await org();
    const otherCurrent = await createAccount(o, {
      code: '1145',
      name: 'USD deposit',
      subtype: 'OTHER_CURRENT_ASSET',
      isMonetary: true,
    });
    const otherAsset = await createAccount(o, {
      code: '1146',
      name: 'USD loan receivable',
      subtype: 'OTHER_ASSET',
      isMonetary: true,
    });
    const nonMonetary = await createAccount(o, {
      code: '1147',
      name: 'USD prepaid',
      subtype: 'OTHER_CURRENT_ASSET',
    });
    const unclassified = await createAccount(o, { code: '1148', name: 'USD unclassified' });
    const receivable = await createAccount(o, {
      code: '1135',
      name: 'USD receivable',
      subtype: 'ACCOUNTS_RECEIVABLE',
    });
    const control = await createAccount(o, {
      code: '1136',
      name: 'USD control',
      subtype: 'ACCOUNTS_RECEIVABLE',
    });
    await postJournal(o, {
      entryDate: '2026-02-10',
      description: 'USD balances',
      currency: 'USD',
      lines: [
        line(otherCurrent, 'debit', '100.00'),
        line(otherAsset, 'debit', '50.00'),
        line(nonMonetary, 'debit', '70.00'),
        line(unclassified, 'debit', '20.00'),
        line(receivable, 'debit', '30.00'),
        line(control, 'debit', '10.00'),
        line(o.accounts['4100']!, 'credit', '280.00'),
      ],
    } as never);
    await asOwnerDb((db) =>
      db.query(
        `UPDATE accounting_accounts SET is_control_account = true, control_subledger = 'sales' WHERE id = $1`,
        [control],
      ),
    );
    const run = await post(o, '2026-03-31');
    const revalued = run.lines.map((l) => l.accountId).sort();
    expect(revalued).toEqual([o.usdBank, otherCurrent, otherAsset, receivable].sort());
    for (const excluded of [nonMonetary, unclassified, control, o.accounts['1130']]) {
      expect(revalued).not.toContain(excluded);
    }
    // (1,000 + 100 + 50 + 30) USD x 0.08 = 94.40.
    expect(run).toMatchObject({ totalGain: '94.4', netAdjustment: '94.4', journalCount: 1 });
  });
});

describe('security', () => {
  it('uses the journal permissions, re-authentication and tenant isolation', async () => {
    const o = await org();
    const member = await joinWithRole(ctx, o.owner, 'Member');
    const memberPrincipal = await principal(member.client);
    expect(
      (await reval().preview(memberPrincipal, { revaluationDate: '2026-03-31' })).lines,
    ).toHaveLength(1);
    await expect(
      reval().post(memberPrincipal, { revaluationDate: '2026-03-31' }, origin),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Poster',
      permissionKeys: ['organization.read', 'accounting.journals.view', 'accounting.journals.post'],
    });
    const poster = await joinWithRole(ctx, o.owner, 'Poster');
    expect(role.status).toBe(201);
    const run = await reval().post(
      await principal(poster.client),
      { revaluationDate: '2026-03-31' },
      origin,
    );
    await expect(
      reval().cancel(
        await principal(poster.client),
        run.id,
        { version: run.version, reason: 'Not mine' },
        origin,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    // Re-authentication: a stale confirmation is refused until the password is entered again,
    // for posting as well as for cancelling.
    ctx.clock.advance(16 * MINUTE);
    await expect(post(o, '2026-04-30')).rejects.toMatchObject({
      code: 'REAUTHENTICATION_REQUIRED',
    });
    await expect(
      reval().cancel(
        await principal(o.owner),
        run.id,
        { version: run.version, reason: 'Re-run' },
        origin,
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    await o.owner.reauthenticate();
    expect(
      (
        await reval().cancel(
          await principal(o.owner),
          run.id,
          { version: run.version, reason: 'Re-run' },
          origin,
        )
      ).status,
    ).toBe('REVERSED');

    const other = await org();
    await expect(reval().get(await principal(other.owner), run.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      reval().cancel(
        await principal(other.owner),
        run.id,
        { version: 1, reason: 'Other tenant' },
        origin,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('enforces MFA for privileged users (57a), for direct calls and the development trigger', async () => {
    const o = await org();
    const person = await joinWithRole(ctx, o.owner, 'Member');
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Setup poster',
      permissionKeys: [
        'organization.read',
        'accounting.setup',
        'accounting.journals.view',
        'accounting.journals.post',
      ],
    });
    await o.owner.put(`/organizations/current/members/${person.membershipId}/roles`, {
      roleIds: [role.body.data.id],
    });
    await expect(
      reval().post(await principal(person.client), { revaluationDate: '2026-03-31' }, origin),
    ).rejects.toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });
    await expect(
      runDevRevaluation(devDeps(), reval(), {
        email: person.email,
        action: { kind: 'post', revaluationDate: '2026-03-31' },
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^MFA_/) });
    expect(await reval().list(await principal(o.owner))).toEqual([]);
  });

  it('protects runs, lines and links in the database and isolates tenants under RLS', async () => {
    const o = await org();
    const run = await post(o, '2026-03-31');
    const manual = await postJournal(o);
    const other = await org();
    const app = await connectAs('app');
    try {
      const inTenant = async (organizationId: string, statement: string) => {
        await app.query('BEGIN');
        try {
          await app.query(`SELECT set_config('app.organization_id', $1, true)`, [organizationId]);
          return await app.query(statement);
        } finally {
          await app.query('ROLLBACK');
        }
      };
      for (const statement of [
        `UPDATE accounting_revaluation_lines SET adjustment = 0, revalued_base = carrying_base WHERE run_id = '${run.id}'`,
        `DELETE FROM accounting_revaluation_lines WHERE run_id = '${run.id}'`,
        `INSERT INTO accounting_revaluation_lines (organization_id, run_id, line_number, exposure_kind,
           account_id, currency_code, foreign_balance, carrying_base, rate, rate_date, rate_source,
           revalued_base, adjustment)
           VALUES ('${o.organizationId}', '${run.id}', 9, 'ACCOUNT', '${o.usdBank}', 'USD', 1, 1, 1,
                   '2026-03-31', 'table', 1, 0)`,
        `UPDATE accounting_revaluation_runs SET total_gain = 1, net_adjustment = 1 WHERE id = '${run.id}'`,
        `UPDATE accounting_revaluation_runs SET status = 'DRAFT' WHERE id = '${run.id}'`,
        `DELETE FROM accounting_revaluation_runs WHERE id = '${run.id}'`,
        `INSERT INTO accounting_revaluation_runs (organization_id, status, revaluation_date,
           reversal_date, base_currency, unrealized_account_id, created_by_user_id, created_at,
           updated_at, posted_by_user_id, posted_at)
           SELECT organization_id, 'POSTED', '2026-05-31', '2026-06-01', base_currency,
                  unrealized_account_id, created_by_user_id, now(), now(), created_by_user_id, now()
             FROM accounting_revaluation_runs WHERE id = '${run.id}'`,
        `INSERT INTO accounting_revaluation_run_journals (organization_id, run_id, journal_id, currency, role)
           VALUES ('${o.organizationId}', '${run.id}', '${manual.id}', 'MVR', 'CANCELLATION')`,
      ]) {
        await expect(inTenant(o.organizationId, statement), statement).rejects.toMatchObject({
          code: '23514',
        });
      }
      for (const statement of [
        `UPDATE accounting_revaluation_run_journals SET role = 'CANCELLATION' WHERE run_id = '${run.id}'`,
        `DELETE FROM accounting_revaluation_run_journals WHERE run_id = '${run.id}'`,
      ]) {
        await expect(inTenant(o.organizationId, statement)).rejects.toMatchObject({
          code: '42501',
        });
      }
      const hidden = await inTenant(
        other.organizationId,
        `SELECT (SELECT count(*) FROM accounting_revaluation_runs WHERE id = '${run.id}')::int
              + (SELECT count(*) FROM accounting_revaluation_lines WHERE run_id = '${run.id}')::int
              + (SELECT count(*) FROM accounting_revaluation_run_journals WHERE run_id = '${run.id}')::int AS n`,
      );
      expect(hidden.rows[0].n).toBe(0);
    } finally {
      await app.end();
    }
  });

  it('keeps base-only lines out of manual journals', async () => {
    const o = await org();
    const res = await o.owner.post('/accounting/journals', {
      entryDate: '2026-03-31',
      description: 'Sneaky',
      currency: 'MVR',
      lines: [
        { ...line(o.usdBank, 'debit', '1.00'), kind: 'base_only' },
        line(o.accounts['4960']!, 'credit', '1.00'),
      ],
    });
    expect(res.status).toBe(400);
  });
});

describe('development trigger (N6)', () => {
  it('posts and cancels as the named user in development/testing only', async () => {
    const o = await org();
    for (const appEnv of ['production', 'staging'] as const) {
      await expect(
        runDevRevaluation({ db: ctx.database.db, config: { ...ctx.config, appEnv } }, reval(), {
          email: o.ownerEmail,
          action: { kind: 'post', revaluationDate: '2026-03-31' },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await reval().list(await principal(o.owner))).toEqual([]);

    // The production service refuses the stale session; the development trigger has no session
    // and uses its test-only bypass (still with identity, permission and MFA checks).
    ctx.clock.advance(16 * MINUTE);
    await expect(post(o, '2026-03-31')).rejects.toMatchObject({
      code: 'REAUTHENTICATION_REQUIRED',
    });
    await o.owner.reauthenticate();
    ctx.clock.advance(16 * MINUTE);
    const run = await runDevRevaluation(devDeps(), reval(), {
      email: o.ownerEmail,
      action: { kind: 'post', revaluationDate: '2026-03-31', runKey: 'e2e' },
    });
    expect(run).toMatchObject({
      status: 'POSTED',
      createdByUserId: expect.any(String),
      netAdjustment: '80',
    });
    const member = await joinWithRole(ctx, o.owner, 'Member');
    await expect(
      runDevRevaluation(devDeps(), reval(), {
        email: member.email,
        organizationName: null,
        action: { kind: 'cancel', runId: run.id, version: run.version, reason: 'Not allowed' },
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const cancelled = await runDevRevaluation(devDeps(), reval(), {
      email: o.ownerEmail,
      action: { kind: 'cancel', runId: run.id, version: run.version, reason: 'E2E clean-up' },
    });
    expect(cancelled.status).toBe('REVERSED');
    // The test-only session re-authentication bypass is explicit in the audit trail.
    const events = await auditEvents(o.owner);
    for (const action of ['revaluation.posted', 'revaluation.reversed']) {
      const event = events.find((e) => e.action === action)!;
      expect(event.metadata.reauthentication).toBe('dev_trigger_bypass');
      expect(event.requestId).toMatch(/^dev-revaluation-/);
    }
    await expect(
      runDevRevaluation(devDeps(), reval(), {
        email: `nobody-${randomUUID()}@example.test`,
        action: { kind: 'post', revaluationDate: '2026-03-31' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
