import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cashSale, line, postJournal, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, MINUTE, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('accounting setup', () => {
  it('requires setup before any accounting operation', async () => {
    const owner = ctx.client();
    await owner.register();
    const accounts = await owner.get('/accounting/accounts');
    expect(accounts.status).toBe(409);
    expect(accounts.body.error.code).toBe('ACCOUNTING_NOT_SET_UP');
    const setup = await owner.get('/accounting/setup');
    expect(setup.body.data.isSetUp).toBe(false);
    expect(setup.body.data.templates.map((t: { key: string }) => t.key)).toEqual([
      'maldives',
      'india',
      'uae',
      'uk',
      'custom',
    ]);
  });

  it('applies the selected COA template once, with the chosen base currency', async () => {
    const org = await setUpAccountingOrg(ctx);
    const accounts = (await org.owner.get('/accounting/accounts')).body.data;
    // 31 Phase 2 template accounts + 3900/4950/4960/5950 (Decision 64) + 1160 GST Input Tax
    // Recoverable (ADR 0004 P4-13, Maldives template).
    expect(accounts).toHaveLength(36);
    const cash = accounts.find((a: { code: string }) => a.code === '1110');
    expect(cash).toMatchObject({ type: 'ASSET', isSystem: true, isLeaf: true, status: 'ACTIVE' });
    expect(accounts.find((a: { code: string }) => a.code === '1000').isLeaf).toBe(false);
    const again = await org.owner.post('/accounting/setup', {
      baseCurrency: 'USD',
      templateKey: 'uk',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ACCOUNTING_ALREADY_SET_UP');
    const setup = await org.owner.get('/accounting/setup');
    expect(setup.body.data.settings).toMatchObject({
      baseCurrency: 'MVR',
      coaTemplateKey: 'maldives',
    });
  });

  it('starts empty with the Custom template and rejects unsupported currencies', async () => {
    const owner = ctx.client();
    await owner.register();
    const bad = await owner.post('/accounting/setup', {
      baseCurrency: 'XYZ',
      templateKey: 'custom',
    });
    expect(bad.status).toBe(400);
    expect(
      (await owner.post('/accounting/setup', { baseCurrency: 'GBP', templateKey: 'custom' }))
        .status,
    ).toBe(201);
    expect((await owner.get('/accounting/accounts')).body.data).toEqual([]);
  });

  it('locks the base currency once a journal is posted', async () => {
    const org = await setUpAccountingOrg(ctx);
    expect((await org.owner.patch('/accounting/settings', { baseCurrency: 'USD' })).status).toBe(
      200,
    );
    expect((await org.owner.patch('/accounting/settings', { baseCurrency: 'MVR' })).status).toBe(
      200,
    );
    await postJournal(org);
    const locked = await org.owner.patch('/accounting/settings', { baseCurrency: 'USD' });
    expect(locked.status).toBe(409);
  });
});

describe('chart of accounts', () => {
  it('creates, updates and archives accounts with an audit trail', async () => {
    const org = await setUpAccountingOrg(ctx);
    const created = await org.owner.post('/accounting/accounts', {
      code: '1125',
      name: 'Petty Cash',
      type: 'ASSET',
      parentId: org.accounts['1100'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      code: '1125',
      isSystem: false,
      parentId: org.accounts['1100'],
    });
    const id = created.body.data.id;

    const updated = await org.owner.patch(`/accounting/accounts/${id}`, {
      name: 'Petty Cash Float',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.name).toBe('Petty Cash Float');

    const archived = await org.owner.post(`/accounting/accounts/${id}/archive`);
    expect(archived.body.data.status).toBe('ARCHIVED');
    expect((await org.owner.post(`/accounting/accounts/${id}/archive`)).status).toBe(409);

    const actions = (await org.owner.get('/organizations/current/audit-events')).body.data.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['account.created', 'account.updated', 'account.archived']),
    );
  });

  it('enforces unique codes, same-type parents and no cycles', async () => {
    const org = await setUpAccountingOrg(ctx);
    const duplicate = await org.owner.post('/accounting/accounts', {
      code: '1110',
      name: 'Dup',
      type: 'ASSET',
    });
    expect(duplicate.status).toBe(409);
    const wrongType = await org.owner.post('/accounting/accounts', {
      code: '9999',
      name: 'Bad parent',
      type: 'EXPENSE',
      parentId: org.accounts['1100'],
    });
    expect(wrongType.status).toBe(400);
    const cycle = await org.owner.patch(`/accounting/accounts/${org.accounts['1000']}`, {
      parentId: org.accounts['1110'],
    });
    expect(cycle.status).toBe(400);
  });

  it('deletes unused accounts, clearing draft-only references', async () => {
    const org = await setUpAccountingOrg(ctx);
    const account = await org.owner.post('/accounting/accounts', {
      code: '5970',
      name: 'Misc',
      type: 'EXPENSE',
    });
    const id = account.body.data.id;
    const draft = await org.owner.post('/accounting/journals', {
      entryDate: '2026-02-01',
      currency: 'MVR',
      lines: [line(id, 'debit', '5.00'), line(org.accounts['1110']!, 'credit', '5.00')],
    });
    expect(draft.status).toBe(201);
    const deleted = await org.owner.delete(`/accounting/accounts/${id}`);
    expect(deleted.status).toBe(204);
    const after = await org.owner.get(`/accounting/journals/${draft.body.data.id}`);
    expect(after.body.data.lines[0].accountId).toBeNull();
    expect(after.body.data.status).toBe('DRAFT');
    expect((await org.owner.get(`/accounting/accounts/${id}`)).status).toBe(404);
  });

  it('rejects deleting accounts used by posted journals, which can only be archived', async () => {
    const org = await setUpAccountingOrg(ctx);
    await postJournal(org);
    const response = await org.owner.delete(`/accounting/accounts/${org.accounts['1110']}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ACCOUNT_IN_USE');
    expect(
      (await org.owner.post(`/accounting/accounts/${org.accounts['1110']}/archive`)).status,
    ).toBe(200);
  });

  it('does not let a used account become a parent', async () => {
    const org = await setUpAccountingOrg(ctx);
    await postJournal(org);
    const child = await org.owner.post('/accounting/accounts', {
      code: '1111',
      name: 'Sub cash',
      type: 'ASSET',
      parentId: org.accounts['1110'],
    });
    expect(child.status).toBe(409);
    expect(child.body.error.code).toBe('ACCOUNT_IN_USE');
  });
});

describe('fiscal years and periods', () => {
  it('creates monthly periods by default for non-calendar fiscal years', async () => {
    const org = await setUpAccountingOrg(ctx, { fiscalYear: false });
    const fy = await org.owner.post('/accounting/fiscal-years', {
      name: 'FY2026-27',
      startDate: '2026-04-01',
      endDate: '2027-03-31',
    });
    expect(fy.status).toBe(201);
    const periods = fy.body.data.periods;
    expect(periods).toHaveLength(12);
    expect(periods[0]).toMatchObject({
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      status: 'OPEN',
    });
    expect(periods[10]).toMatchObject({ startDate: '2027-02-01', endDate: '2027-02-28' });
    expect(periods[11]).toMatchObject({ startDate: '2027-03-01', endDate: '2027-03-31' });
  });

  it('supports configurable contiguous periods and rejects gaps and overlaps', async () => {
    const org = await setUpAccountingOrg(ctx, { fiscalYear: false });
    const gap = await org.owner.post('/accounting/fiscal-years', {
      name: 'Gap',
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      periods: [
        { startDate: '2026-01-01', endDate: '2026-02-28' },
        { startDate: '2026-03-02', endDate: '2026-06-30' },
      ],
    });
    expect(gap.status).toBe(400);
    const quarters = await org.owner.post('/accounting/fiscal-years', {
      name: 'H1 2026',
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      periods: [
        { name: 'Q1', startDate: '2026-01-01', endDate: '2026-03-31' },
        { name: 'Q2', startDate: '2026-04-01', endDate: '2026-06-30' },
      ],
    });
    expect(quarters.status).toBe(201);
    expect(quarters.body.data.periods.map((p: { name: string }) => p.name)).toEqual(['Q1', 'Q2']);

    const overlapping = await org.owner.post('/accounting/fiscal-years', {
      name: 'Overlap',
      startDate: '2026-06-01',
      endDate: '2026-12-31',
    });
    expect(overlapping.status).toBe(400);
    const nonContiguous = await org.owner.post('/accounting/fiscal-years', {
      name: 'Later',
      startDate: '2026-08-01',
      endDate: '2027-07-31',
    });
    expect(nonContiguous.status).toBe(400);
    const next = await org.owner.post('/accounting/fiscal-years', {
      name: 'H2 2026',
      startDate: '2026-07-01',
      endDate: '2026-12-31',
    });
    expect(next.status).toBe(201);
    expect((await org.owner.get('/accounting/fiscal-years')).body.data).toHaveLength(2);
  });
});

describe('journal validation', () => {
  let org: AccountingOrg;
  beforeAll(async () => {
    org = await setUpAccountingOrg(ctx);
  });

  const createAndPost = async (body: object) => {
    const created = await org.owner.post('/accounting/journals', body);
    if (created.status !== 201) return created;
    return org.owner.post(`/accounting/journals/${created.body.data.id}/post`);
  };

  it('saves incomplete drafts but refuses to post a one-line journal', async () => {
    const response = await createAndPost({
      entryDate: '2026-03-01',
      currency: 'MVR',
      lines: [line(org.accounts['1110']!, 'debit', '10.00')],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body)).toContain('at least two lines');
  });

  it('rejects unbalanced journals', async () => {
    const response = await createAndPost({
      entryDate: '2026-03-01',
      currency: 'MVR',
      lines: [
        line(org.accounts['1110']!, 'debit', '10.00'),
        line(org.accounts['4100']!, 'credit', '9.99'),
      ],
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('must equal total credits');
  });

  it('rejects negative, zero and float-typed amounts, and debit+credit on one line', async () => {
    const base = { entryDate: '2026-03-01', currency: 'MVR' };
    for (const lines of [
      [
        line(org.accounts['1110']!, 'debit', '-10.00'),
        line(org.accounts['4100']!, 'credit', '-10.00'),
      ],
      [line(org.accounts['1110']!, 'debit', '0'), line(org.accounts['4100']!, 'credit', '0')],
      [
        { accountId: org.accounts['1110'], debit: '10.00', credit: '10.00' },
        line(org.accounts['4100']!, 'credit', '10.00'),
      ],
    ]) {
      const response = await org.owner.post('/accounting/journals', { ...base, lines });
      expect(response.status).toBe(400);
    }
    const numeric = await org.owner.post('/accounting/journals', {
      ...base,
      lines: [
        { accountId: org.accounts['1110'], debit: 10.1 },
        line(org.accounts['4100']!, 'credit', '10.10'),
      ],
    });
    expect(numeric.status).toBe(400);
  });

  it('enforces currency validity and minor-unit precision', async () => {
    const tooPrecise = await org.owner.post('/accounting/journals', cashSale(org, '10.005'));
    expect(tooPrecise.status).toBe(400);
    const unknownCurrency = await org.owner.post('/accounting/journals', {
      ...cashSale(org),
      currency: 'ABC',
    });
    expect(unknownCurrency.status).toBe(400);
    // KWD allows three decimals.
    const kwd = await org.owner.post(
      '/accounting/journals',
      cashSale(org, '10.005', '2026-03-01', 'KWD'),
    );
    expect(kwd.status).toBe(201);
  });

  it('rejects postings to parent and archived accounts', async () => {
    const toParent = await createAndPost({
      entryDate: '2026-03-01',
      currency: 'MVR',
      lines: [
        line(org.accounts['1100']!, 'debit', '10.00'),
        line(org.accounts['4100']!, 'credit', '10.00'),
      ],
    });
    expect(toParent.status).toBe(400);
    expect(JSON.stringify(toParent.body)).toContain('leaf accounts');
  });

  it('accepts a valid balanced journal and posts it with a number', async () => {
    const posted = await postJournal(org, {
      entryDate: '2026-03-20',
      description: 'Multi-line sale',
      currency: 'MVR',
      lines: [
        line(org.accounts['1110']!, 'debit', '60.00'),
        line(org.accounts['1120']!, 'debit', '40.00'),
        line(org.accounts['4100']!, 'credit', '100.00'),
      ],
    });
    expect(posted).toMatchObject({
      status: 'POSTED',
      totalDebit: '100.0000',
      totalCredit: '100.0000',
      totalBaseDebit: '100.0000',
      exchangeRate: '1.0000000000',
      exchangeRateSource: 'base',
      baseCurrency: 'MVR',
    });
    expect(posted.number).toEqual(expect.any(Number));
    expect(posted.periodId).toBe(org.periods[2]!.id);
  });
});

describe('journal lifecycle without an approval policy', () => {
  it('lets an authorized user create, submit and post; drafts consume no numbers', async () => {
    const org = await setUpAccountingOrg(ctx);
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    expect(draft.number).toBeNull();
    const edited = await org.owner.patch(`/accounting/journals/${draft.id}`, {
      description: 'Edited',
    });
    expect(edited.body.data.description).toBe('Edited');

    const submitted = await org.owner.post(`/accounting/journals/${draft.id}/submit`);
    expect(submitted.body.data.status).toBe('PENDING_APPROVAL');
    expect(
      (await org.owner.patch(`/accounting/journals/${draft.id}`, { description: 'x' })).status,
    ).toBe(409);

    const posted = await org.owner.post(`/accounting/journals/${draft.id}/post`);
    expect(posted.body.data.status).toBe('POSTED');
    expect(posted.body.data.number).toBe(1);
    const second = await postJournal(org);
    expect(second.number).toBe(2);

    const actions = (await org.owner.get('/organizations/current/audit-events')).body.data.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'journal.created',
        'journal.updated',
        'journal.submitted',
        'journal.posted',
      ]),
    );
  });

  it('rejects invalid state transitions', async () => {
    const org = await setUpAccountingOrg(ctx);
    const posted = await postJournal(org);
    for (const actionName of ['submit', 'post', 'withdraw', 'approve']) {
      const response = await org.owner.post(`/accounting/journals/${posted.id}/${actionName}`);
      expect(response.status, actionName).toBe(409);
    }
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    expect(
      (await org.owner.post(`/accounting/journals/${draft.id}/reverse`, { reason: 'nope' })).status,
    ).toBe(409);
    expect((await org.owner.post(`/accounting/journals/${draft.id}/withdraw`)).status).toBe(409);
  });

  it('withdrawn journals return to draft', async () => {
    const org = await setUpAccountingOrg(ctx);
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    await org.owner.post(`/accounting/journals/${draft.id}/submit`);
    const withdrawn = await org.owner.post(`/accounting/journals/${draft.id}/withdraw`);
    expect(withdrawn.body.data.status).toBe('DRAFT');
  });

  it('requires re-authentication to post', async () => {
    const org = await setUpAccountingOrg(ctx);
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    ctx.clock.advance(16 * MINUTE);
    await org.owner.get('/auth/session');
    const stale = await org.owner.post(`/accounting/journals/${draft.id}/post`);
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await org.owner.reauthenticate();
    expect((await org.owner.post(`/accounting/journals/${draft.id}/post`)).status).toBe(200);
  });
});

describe('periods and posting', () => {
  it('open periods accept postings; closed periods reject them', async () => {
    const org = await setUpAccountingOrg(ctx);
    const march = org.periods[2]!;
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    const closed = await org.owner.post(`/accounting/periods/${march.id}/close`);
    expect(closed.body.data.status).toBe('CLOSED');
    const rejected = await org.owner.post(`/accounting/journals/${draft.id}/post`);
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('PERIOD_CLOSED');
    // Atomic: the failed posting left no trace.
    const after = (await org.owner.get(`/accounting/journals/${draft.id}`)).body.data;
    expect(after).toMatchObject({ status: 'DRAFT', number: null });
    expect(after.lines[0].baseDebit).toBeNull();

    const noPeriod = await org.owner.post(
      '/accounting/journals',
      cashSale(org, '5.00', '2027-05-01'),
    );
    const noPeriodPost = await org.owner.post(`/accounting/journals/${noPeriod.body.data.id}/post`);
    expect(noPeriodPost.body.error.code).toBe('PERIOD_NOT_FOUND');
  });

  it('reopening requires permission, re-authentication, a reason and is audited', async () => {
    const org = await setUpAccountingOrg(ctx);
    const march = org.periods[2]!;
    await org.owner.post(`/accounting/periods/${march.id}/close`);
    expect((await org.owner.post(`/accounting/periods/${march.id}/reopen`, {})).status).toBe(400);

    ctx.clock.advance(16 * MINUTE);
    await org.owner.get('/auth/session');
    const stale = await org.owner.post(`/accounting/periods/${march.id}/reopen`, {
      reason: 'Late invoice',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await org.owner.reauthenticate();

    const reopened = await org.owner.post(`/accounting/periods/${march.id}/reopen`, {
      reason: 'Late invoice',
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.status).toBe('REOPENED');
    expect(reopened.body.data.period).toMatchObject({
      status: 'OPEN',
      reopenReason: 'Late invoice',
    });

    const audit = (await org.owner.get('/organizations/current/audit-events')).body.data;
    const event = audit.find((e: { action: string }) => e.action === 'period.reopened');
    expect(event.metadata.reason).toBe('Late invoice');
    expect(audit.map((e: { action: string }) => e.action)).toContain('period.closed');
  });
});

describe('posted journal immutability and reversal', () => {
  it('rejects edits of posted journals and has no delete endpoint', async () => {
    const org = await setUpAccountingOrg(ctx);
    const posted = await postJournal(org);
    const edit = await org.owner.patch(`/accounting/journals/${posted.id}`, {
      description: 'tamper',
    });
    expect(edit.status).toBe(409);
    const del = await org.owner.delete(`/accounting/journals/${posted.id}`);
    expect(del.status).toBe(404);
  });

  it('reverses with a new journal and preserves history', async () => {
    const org = await setUpAccountingOrg(ctx);
    const posted = await postJournal(org, cashSale(org, '250.00', '2026-04-10'));
    const reversed = await org.owner.post(`/accounting/journals/${posted.id}/reverse`, {
      reason: 'Entered twice',
    });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    const { original, reversal } = reversed.body.data;
    expect(original).toMatchObject({ id: posted.id, status: 'REVERSED', number: posted.number });
    expect(original.totalDebit).toBe(posted.totalDebit);
    expect(reversal).toMatchObject({
      status: 'POSTED',
      source: 'reversal',
      entryDate: '2026-04-10',
    });
    expect(reversal.lines[0]).toMatchObject({
      debit: null,
      credit: '250.0000',
      baseCredit: '250.0000',
    });
    expect(reversal.lines[1]).toMatchObject({
      debit: '250.0000',
      credit: null,
      baseDebit: '250.0000',
    });

    const detail = (await org.owner.get(`/accounting/journals/${posted.id}`)).body.data;
    expect(detail.reversedByJournalId).toBe(reversal.id);
    expect(detail.reversalReason).toBe('Entered twice');
    expect(
      (await org.owner.post(`/accounting/journals/${posted.id}/reverse`, { reason: 'again' }))
        .status,
    ).toBe(409);

    // The GL nets to zero for the cash account.
    const ledger = await org.owner.get(`/accounting/ledger?accountId=${org.accounts['1110']}`);
    expect(ledger.body.data.totals).toEqual({ baseDebit: '250.0000', baseCredit: '250.0000' });
    expect(ledger.body.data.rows.at(-1).runningBalance).toBe('0.0000');

    const audit = (await org.owner.get('/organizations/current/audit-events')).body.data;
    const event = audit.find((e: { action: string }) => e.action === 'journal.reversed');
    expect(event.metadata).toMatchObject({
      reason: 'Entered twice',
      reversalJournalId: reversal.id,
    });
  });

  it('requires an open period for the reversal date', async () => {
    const org = await setUpAccountingOrg(ctx);
    const posted = await postJournal(org, cashSale(org, '10.00', '2026-01-10'));
    await org.owner.post(`/accounting/periods/${org.periods[0]!.id}/close`);
    const defaulted = await org.owner.post(`/accounting/journals/${posted.id}/reverse`, {
      reason: 'Correction',
    });
    expect(defaulted.status).toBe(409);
    expect(defaulted.body.error.code).toBe('PERIOD_CLOSED');
    const chosen = await org.owner.post(`/accounting/journals/${posted.id}/reverse`, {
      reason: 'Correction',
      reversalDate: '2026-02-01',
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.data.reversal.periodId).toBe(org.periods[1]!.id);
  });
});

describe('multi-currency', () => {
  it('converts to the base currency with preserved rates and the largest-line rounding rule', async () => {
    const org = await setUpAccountingOrg(ctx);
    // No rate available yet.
    const usd = {
      entryDate: '2026-05-10',
      currency: 'USD',
      lines: [
        line(org.accounts['1120']!, 'debit', '0.01'),
        line(org.accounts['1120']!, 'debit', '0.01'),
        line(org.accounts['1120']!, 'debit', '0.01'),
        line(org.accounts['4100']!, 'credit', '0.03'),
      ],
    };
    const draft = (await org.owner.post('/accounting/journals', usd)).body.data;
    const missing = await org.owner.post(`/accounting/journals/${draft.id}/post`);
    expect(missing.body.error.code).toBe('EXCHANGE_RATE_REQUIRED');

    // Rate table: the latest rate on or before the journal date applies.
    await org.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-05-01',
      rate: '15.42',
    });
    await org.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-05-20',
      rate: '99',
    });
    const posted = await org.owner.post(`/accounting/journals/${draft.id}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const journal = posted.body.data;
    expect(journal).toMatchObject({
      exchangeRate: '15.4200000000',
      exchangeRateSource: 'table',
      baseCurrency: 'MVR',
    });
    // 0.01 * 15.42 = 0.1542 -> 0.15 (x3 = 0.45) while 0.03 * 15.42 = 0.4626 -> 0.46.
    // The 0.01 difference goes to the largest line (the credit, 0.03), making it 0.45.
    expect(
      journal.lines.map(
        (l: { baseDebit: string | null; baseCredit: string | null }) => l.baseDebit ?? l.baseCredit,
      ),
    ).toEqual(['0.1500', '0.1500', '0.1500', '0.4500']);
    expect(journal.lines[3].roundingAdjustment).toBe('-0.0100');
    expect(journal.totalBaseDebit).toBe(journal.totalBaseCredit);

    // A later rate never changes the posted journal.
    await org.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-05-11',
      rate: '20',
    });
    const reread = (await org.owner.get(`/accounting/journals/${draft.id}`)).body.data;
    expect(reread.exchangeRate).toBe('15.4200000000');
  });

  it('uses a manually entered rate and rejects a non-1 rate in the base currency', async () => {
    const org = await setUpAccountingOrg(ctx);
    const manual = await postJournal(org, {
      ...cashSale(org, '100.00', '2026-06-01', 'EUR'),
      exchangeRate: '16.6789',
    } as never);
    expect(manual).toMatchObject({ exchangeRateSource: 'manual', totalBaseDebit: '1667.8900' });
    const bad = await org.owner.post('/accounting/journals', {
      ...cashSale(org),
      exchangeRate: '2',
    });
    expect(bad.status).toBe(400);
  });

  it('keeps exact decimal totals for amounts that break floating point', async () => {
    const org = await setUpAccountingOrg(ctx);
    const posted = await postJournal(org, {
      entryDate: '2026-06-02',
      currency: 'MVR',
      lines: [
        line(org.accounts['1110']!, 'debit', '0.10'),
        line(org.accounts['1110']!, 'debit', '0.20'),
        line(org.accounts['4100']!, 'credit', '0.30'),
      ],
    } as never);
    expect(posted.totalDebit).toBe('0.3000');
    const big = await postJournal(org, cashSale(org, '99999999999999.99', '2026-06-03'));
    expect(big.totalBaseDebit).toBe('99999999999999.9900');
  });
});

describe('general ledger', () => {
  it('derives only from posted journals with running balances and parent roll-up', async () => {
    const org = await setUpAccountingOrg(ctx);
    await postJournal(org, cashSale(org, '100.00', '2026-01-15'));
    await postJournal(org, cashSale(org, '50.00', '2026-02-15'));
    await org.owner.post('/accounting/journals', cashSale(org, '999.00', '2026-02-20')); // draft: excluded
    const draftSubmitted = (
      await org.owner.post('/accounting/journals', cashSale(org, '777.00', '2026-02-21'))
    ).body.data;
    await org.owner.post(`/accounting/journals/${draftSubmitted.id}/submit`); // pending: excluded

    const cash = await org.owner.get(
      `/accounting/ledger?accountId=${org.accounts['1110']}&fromDate=2026-02-01&toDate=2026-12-31`,
    );
    expect(cash.status).toBe(200);
    expect(cash.body.data.openingBalance).toBe('100.0000');
    expect(cash.body.data.rows).toHaveLength(1);
    expect(cash.body.data.rows[0]).toMatchObject({
      baseDebit: '50.0000',
      runningBalance: '150.0000',
    });

    // Parent account 1000 (Assets) rolls up its descendants.
    const assets = await org.owner.get(`/accounting/ledger?accountId=${org.accounts['1000']}`);
    expect(assets.body.data.totals.baseDebit).toBe('150.0000');

    const all = await org.owner.get('/accounting/ledger');
    expect(all.body.data.rows).toHaveLength(4);
    expect(all.body.data.totals.baseDebit).toBe(all.body.data.totals.baseCredit);
  });
});

describe('dashboard', () => {
  it('summarizes periods and journals', async () => {
    const org = await setUpAccountingOrg(ctx);
    await postJournal(org);
    await org.owner.post('/accounting/journals', cashSale(org));
    const dashboard = await org.owner.get('/accounting/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data).toMatchObject({ isSetUp: true, baseCurrency: 'MVR' });
    expect(dashboard.body.data.journals).toMatchObject({ draftCount: 1, pendingApprovalCount: 0 });
    expect(dashboard.body.data.journals.recentPosted).toHaveLength(1);
  });
});

describe('database-level accounting integrity', () => {
  it('triggers reject modification or deletion of posted journals and their lines', async () => {
    const org = await setUpAccountingOrg(ctx);
    const posted = await postJournal(org);
    const db = await connectAs('owner');
    try {
      const attempts = [
        db.query(`UPDATE accounting_journal_entries SET description = 'x' WHERE id = $1`, [
          posted.id,
        ]),
        db.query(`UPDATE accounting_journal_entries SET entry_date = '2026-01-01' WHERE id = $1`, [
          posted.id,
        ]),
        db.query(`UPDATE accounting_journal_entries SET exchange_rate = 2 WHERE id = $1`, [
          posted.id,
        ]),
        db.query(`DELETE FROM accounting_journal_entries WHERE id = $1`, [posted.id]),
        db.query(
          `UPDATE accounting_journal_lines SET debit = 1 WHERE journal_id = $1 AND debit IS NOT NULL`,
          [posted.id],
        ),
        db.query(`DELETE FROM accounting_journal_lines WHERE journal_id = $1`, [posted.id]),
        db.query(
          `INSERT INTO accounting_journal_lines (organization_id, journal_id, line_number, account_id, debit)
                  VALUES ($1, $2, 99, $3, 1)`,
          [org.organizationId, posted.id, org.accounts['1110']],
        ),
        db.query('TRUNCATE accounting_journal_lines'),
      ];
      for (const attempt of attempts) {
        await expect(attempt).rejects.toMatchObject({
          // TRUNCATE is refused before the trigger (0A000) since journal lines are referenced
          // by the Phase 3A dimension assignments; it remains impossible.
          code: expect.stringMatching(/^(42501|23514|0A000)$/),
        });
      }
    } finally {
      await db.end();
    }
  });

  it('refuses to mark an unbalanced journal as posted even when bypassing the application', async () => {
    const org = await setUpAccountingOrg(ctx);
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    const db = await connectAs('owner');
    try {
      await db.query(
        `UPDATE accounting_journal_lines SET base_debit = debit, base_credit = credit + 1 WHERE journal_id = $1`,
        [draft.id],
      );
      await expect(
        db.query(
          `UPDATE accounting_journal_entries SET status = 'POSTED', journal_number = 999999, posted_at = now(),
             period_id = $2, exchange_rate = 1, base_currency = 'MVR', total_debit = 100, total_credit = 100,
             total_base_debit = 100, total_base_credit = 100 WHERE id = $1`,
          [draft.id, org.periods[2]!.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await db.end();
    }
  });
});
