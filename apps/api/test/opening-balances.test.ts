import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCsv } from '../src/modules/data-exchange/index.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/**
 * Phase 3A S8: opening balances. Lifecycle with and without approval, re-authentication,
 * validation rules (S8-04 to S8-09, S8-19), posting through system journals (S8-10), batch-only
 * reversal (S8-14), DB protections, RLS, permissions, import/export and attachments, and the
 * resulting reports. Runs in the serial project (it drives the job worker for import/export).
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const csv = (...lines: string[]) => lines.join('\r\n') + '\r\n';
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

interface Org extends AccountingOrg {
  usdBank: string;
}

/** An organization with FY2026, a USD bank account and a USD rate before the opening date. */
async function org(): Promise<Org> {
  const base = await setUpAccountingOrg(ctx);
  const usd = await base.owner.post('/accounting/accounts', {
    code: '1125',
    name: 'Bank USD',
    type: 'ASSET',
    parentId: base.accounts['1100'],
    currencyCode: 'USD',
    subtype: 'BANK',
  });
  expect(usd.status, JSON.stringify(usd.body)).toBe(201);
  const rate = await base.owner.post('/accounting/exchange-rates', {
    fromCurrency: 'USD',
    rateDate: '2026-03-01',
    rate: '15.42',
  });
  expect(rate.status, JSON.stringify(rate.body)).toBe(201);
  return { ...base, usdBank: usd.body.data.id };
}

const side = (accountId: string, s: 'debit' | 'credit', amount: string, extra = {}) => ({
  accountId,
  debit: s === 'debit' ? amount : null,
  credit: s === 'credit' ? amount : null,
  ...extra,
});

async function draft(client: TestClient, conversionDate = '2026-04-01') {
  const set = await client.put('/accounting/settings/conversion-date', { conversionDate });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const created = await client.post('/accounting/opening-balances', { notes: 'From prior system' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data as { id: string; version: number };
}

async function save(client: TestClient, batchId: string, lines: unknown[]) {
  const current = (await client.get(`/accounting/opening-balances/${batchId}`)).body.data;
  return client.put(`/accounting/opening-balances/${batchId}/lines`, {
    version: current.version,
    lines,
  });
}

async function version(client: TestClient, batchId: string): Promise<number> {
  return (await client.get(`/accounting/opening-balances/${batchId}`)).body.data.version;
}

async function tbRow(client: TestClient, code: string, from = '2026-04-01', to = '2026-04-30') {
  const tb = await client.get(
    `/accounting/reports/trial-balance?from=${from}&to=${to}&currencyView=base_and_account&includeZero=true`,
  );
  expect(tb.status, JSON.stringify(tb.body)).toBe(200);
  return (tb.body.data.rows as any[]).find((r) => r.code === code);
}

async function auditActions(client: TestClient): Promise<string[]> {
  const res = await client.get('/organizations/current/audit-events?limit=100');
  return (res.body.data as { action: string }[]).map((e) => e.action);
}

describe('conversion date (S8-04, S8-12, S8-13)', () => {
  it('is set with accounting.setup and re-authentication, and audited', async () => {
    const o = await org();
    expect((await o.owner.get('/accounting/settings/conversion-date')).body.data).toEqual({
      conversionDate: null,
      openingDate: null,
    });
    ctx.clock.advance(16 * MINUTE);
    const stale = await o.owner.put('/accounting/settings/conversion-date', {
      conversionDate: '2026-04-01',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await o.owner.reauthenticate();
    const set = await o.owner.put('/accounting/settings/conversion-date', {
      conversionDate: '2026-04-01',
    });
    expect(set.body.data).toEqual({ conversionDate: '2026-04-01', openingDate: '2026-03-31' });
    expect(
      (await o.owner.put('/accounting/settings/conversion-date', { conversionDate: '2026-02-30' }))
        .status,
    ).toBe(400);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/accounting/settings/conversion-date')).status).toBe(200);
    expect(
      (
        await member.client.put('/accounting/settings/conversion-date', {
          conversionDate: '2026-05-01',
        })
      ).status,
    ).toBe(403);
    expect(await auditActions(o.owner)).toContain('accounting.conversion_date_changed');
  });
});

describe('posting without an approval policy (S8-10)', () => {
  it('posts one system journal per currency balanced to OBE, visible in the reports', async () => {
    const o = await org();
    const batch = await draft(o.owner);
    const saved = await save(o.owner, batch.id, [
      side(o.accounts['1110']!, 'debit', '50000.00', { description: 'Cash' }),
      side(o.accounts['3100']!, 'credit', '20000.00'),
      side(o.usdBank, 'debit', '1000.00'),
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.totals).toEqual([
      expect.objectContaining({
        currency: 'MVR',
        openingBalanceEquity: { side: 'credit', amount: '30000' },
      }),
      expect.objectContaining({
        currency: 'USD',
        openingBalanceEquity: { side: 'credit', amount: '1000' },
      }),
    ]);

    const preview = await o.owner.post(`/accounting/opening-balances/${batch.id}/preview`, {});
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.errors).toEqual([]);
    expect(preview.body.data.journals.map((j: any) => [j.currency, j.rateSource, j.rate])).toEqual([
      ['MVR', 'base', '1'],
      ['USD', 'table', '15.42'],
    ]);
    expect(preview.body.data.approval).toMatchObject({ required: false, readyToPost: true });

    const posted = await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
      version: await version(o.owner, batch.id),
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data.status).toBe('POSTED');
    const journals = posted.body.data.journals as any[];
    expect(journals.map((j) => [j.currency, j.status, j.entryDate, j.exchangeRateSource])).toEqual([
      ['MVR', 'POSTED', '2026-03-31', 'base'],
      ['USD', 'POSTED', '2026-03-31', 'table'],
    ]);
    expect(journals[1]).toMatchObject({ totalBaseDebit: '15420.0000' });

    // Drill-down: journal -> source reference -> opening batch.
    const detail = (await o.owner.get(`/accounting/journals/${journals[0].id}`)).body.data;
    expect(detail).toMatchObject({
      source: 'system',
      sourceModule: 'accounting',
      sourceType: 'opening_balance',
      sourceId: batch.id,
    });

    // Trial Balance for April: the balances are openings.
    expect(await tbRow(o.owner, '1110')).toMatchObject({ openingDebit: '50000.0000' });
    expect(await tbRow(o.owner, '3100')).toMatchObject({ openingCredit: '20000.0000' });
    expect(await tbRow(o.owner, '3900')).toMatchObject({ openingCredit: '45420.0000' });
    const usdRow = await tbRow(o.owner, '1125');
    expect(usdRow).toMatchObject({ openingDebit: '15420.0000' });
    expect(usdRow.accountCurrency).toMatchObject({ code: 'USD', opening: '1000.0000' });
    const bs = await o.owner.get('/accounting/reports/balance-sheet?asOf=2026-03-31');
    expect(bs.status, JSON.stringify(bs.body)).toBe(200);
    expect(bs.body.data.integrity.status).toBe('BALANCED');

    // Base currency and account currencies are now fixed (Decisions 26/81, 70).
    expect((await o.owner.patch('/accounting/settings', { baseCurrency: 'USD' })).status).toBe(409);
    expect(
      (await o.owner.patch(`/accounting/accounts/${o.usdBank}`, { currencyCode: 'EUR' })).status,
    ).toBe(409);

    // Posted history is immutable.
    expect((await save(o.owner, batch.id, [])).status).toBe(409);
    expect((await o.owner.delete(`/accounting/opening-balances/${batch.id}`)).status).toBe(409);
    expect((await o.owner.post('/accounting/opening-balances', {})).status).toBe(409);
    expect(
      (await o.owner.put('/accounting/settings/conversion-date', { conversionDate: '2026-05-01' }))
        .body.error.code,
    ).toBe('INVALID_STATE_TRANSITION');
    // S8-14: never generic reversal of one opening journal.
    const generic = await o.owner.post(`/accounting/journals/${journals[0].id}/reverse`, {
      reason: 'fix',
    });
    expect(generic.status).toBe(409);
    expect(generic.body.error.code).toBe('SYSTEM_JOURNAL');

    const actions = await auditActions(o.owner);
    for (const a of [
      'opening_balance.created',
      'opening_balance.lines_updated',
      'opening_balance.posted',
      'journal.posted',
    ]) {
      expect(actions).toContain(a);
    }
  });

  it('reverses the whole batch atomically, then accepts a revised batch', async () => {
    const o = await org();
    const batch = await draft(o.owner);
    await save(o.owner, batch.id, [
      side(o.accounts['1110']!, 'debit', '800.00'),
      side(o.usdBank, 'debit', '10.00'),
    ]);
    const posted = await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
      version: await version(o.owner, batch.id),
    });
    expect(posted.status).toBe(200);
    ctx.clock.advance(16 * MINUTE);
    const stale = await o.owner.post(`/accounting/opening-balances/${batch.id}/reverse`, {
      reason: 'Wrong cash figure',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await o.owner.reauthenticate();
    const reversed = await o.owner.post(`/accounting/opening-balances/${batch.id}/reverse`, {
      reason: 'Wrong cash figure',
    });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body.data).toMatchObject({
      status: 'REVERSED',
      reversalReason: 'Wrong cash figure',
    });
    expect((reversed.body.data.journals as any[]).every((j) => j.status === 'REVERSED')).toBe(true);
    expect(await tbRow(o.owner, '1110')).toMatchObject({
      openingDebit: '0.0000',
      openingCredit: '0.0000',
    });
    expect(await tbRow(o.owner, '3900')).toMatchObject({
      openingDebit: '0.0000',
      openingCredit: '0.0000',
    });
    expect(
      (await o.owner.post(`/accounting/opening-balances/${batch.id}/reverse`, { reason: 'again' }))
        .status,
    ).toBe(409);

    // The conversion date can change again, and a new batch is posted.
    const revised = await draft(o.owner, '2026-04-01');
    expect(revised.id).not.toBe(batch.id);
    await save(o.owner, revised.id, [side(o.accounts['1110']!, 'debit', '900.00')]);
    const again = await o.owner.post(`/accounting/opening-balances/${revised.id}/post`, {
      version: await version(o.owner, revised.id),
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await tbRow(o.owner, '1110')).toMatchObject({ openingDebit: '900.0000' });
    const list = (await o.owner.get('/accounting/opening-balances')).body.data;
    expect(list.batches.map((b: any) => b.status)).toEqual(['POSTED', 'REVERSED']);
    expect(await auditActions(o.owner)).toContain('opening_balance.reversed');
  });

  it('rolls back everything when one currency cannot post', async () => {
    const o = await org();
    const batch = await draft(o.owner);
    await save(o.owner, batch.id, [
      side(o.accounts['1110']!, 'debit', '100.00'),
      side(o.usdBank, 'debit', '5.00'),
    ]);
    // A rate that only exists after the opening date does not help (rate table: on or before).
    const db = await connectAs('owner');
    try {
      await db.query(
        `DELETE FROM accounting_exchange_rates WHERE organization_id = $1 AND from_currency = 'USD'`,
        [o.organizationId],
      );
    } finally {
      await db.end();
    }
    const failed = await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
      version: await version(o.owner, batch.id),
    });
    expect(failed.status).toBe(400);
    expect(JSON.stringify(failed.body)).toMatch(/No USD rate is recorded on or before 2026-03-31/);
    const after = (await o.owner.get(`/accounting/opening-balances/${batch.id}`)).body.data;
    expect(after.status).toBe('DRAFT');
    expect(after.journals).toEqual([]);
  });
});

describe('approval (S8-11)', () => {
  it('requires approval when a policy exists, forbids self-approval, and supports reject and withdraw', async () => {
    const o = await org();
    const admin = await joinWithRole(ctx, o.owner, 'Administrator');
    const roles = (await o.owner.get('/organizations/current/roles')).body.data as any[];
    const policy = await o.owner.put('/approvals/policies/accounting.opening_balance.post', {
      steps: [
        {
          name: 'Admin review',
          requiredApprovals: 1,
          roleIds: [roles.find((r) => r.name === 'Administrator').id],
          membershipIds: [],
        },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const batch = await draft(o.owner);
    await save(o.owner, batch.id, [side(o.accounts['1110']!, 'debit', '250.00')]);

    const direct = await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
      version: await version(o.owner, batch.id),
    });
    expect(direct.body.error.code).toBe('APPROVAL_REQUIRED');

    const submit = async () => {
      const res = await o.owner.post(`/accounting/opening-balances/${batch.id}/submit`, {
        version: await version(o.owner, batch.id),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.data;
    };
    // Withdraw returns it to draft.
    let submitted = await submit();
    expect(submitted.status).toBe('PENDING_APPROVAL');
    expect((await save(o.owner, batch.id, [])).status).toBe(409);
    expect(
      (await o.owner.put('/accounting/settings/conversion-date', { conversionDate: '2026-05-01' }))
        .status,
    ).toBe(409);
    const withdrawn = await o.owner.post(`/accounting/opening-balances/${batch.id}/withdraw`, {});
    expect(withdrawn.body.data.status).toBe('DRAFT');

    // Rejection returns it to draft too.
    submitted = await submit();
    const rejected = await admin.client.post(
      `/approvals/requests/${submitted.approval.requestId}/reject`,
      { comment: 'Check capital' },
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await o.owner.get(`/accounting/opening-balances/${batch.id}`)).body.data.status).toBe(
      'DRAFT',
    );

    // Approve and post.
    submitted = await submit();
    const self = await o.owner.post(
      `/approvals/requests/${submitted.approval.requestId}/approve`,
      {},
    );
    expect(self.body.error.code).toBe('SELF_APPROVAL_PROHIBITED');
    expect(
      (
        await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
          version: await version(o.owner, batch.id),
        })
      ).body.error.code,
    ).toBe('APPROVAL_REQUIRED');
    const approved = await admin.client.post(
      `/approvals/requests/${submitted.approval.requestId}/approve`,
      {},
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const ready = (await o.owner.get(`/accounting/opening-balances/${batch.id}`)).body.data;
    expect(ready).toMatchObject({
      status: 'PENDING_APPROVAL',
      approval: { requestStatus: 'approved', readyToPost: true },
    });
    const posted = await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
      version: ready.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data.status).toBe('POSTED');
    const actions = await auditActions(o.owner);
    for (const a of [
      'opening_balance.submitted',
      'opening_balance.withdrawn',
      'opening_balance.rejected',
      'opening_balance.approved',
      'opening_balance.posted',
    ]) {
      expect(actions).toContain(a);
    }
  });
});

describe('validation rules (S8-04 to S8-09, S8-19)', () => {
  it('rejects receivables, control-like, OBE, parent and archived accounts at save', async () => {
    const o = await org();
    const batch = await draft(o.owner);
    const ar = await save(o.owner, batch.id, [side(o.accounts['1130']!, 'debit', '10.00')]);
    expect(ar.status).toBe(400);
    expect(JSON.stringify(ar.body)).toMatch(/opening invoices/);
    for (const code of ['3900', '1100']) {
      expect(
        (await save(o.owner, batch.id, [side(o.accounts[code]!, 'debit', '1.00')])).status,
      ).toBe(400);
    }
    // S8-07 final ruling: an unclassified account is refused; nothing is inferred.
    const unclassified = await o.owner.post('/accounting/accounts', {
      code: '1190',
      name: 'Old suspense',
      type: 'ASSET',
      parentId: o.accounts['1100'],
    });
    expect(unclassified.status, JSON.stringify(unclassified.body)).toBe(201);
    expect(unclassified.body.data.subtype).toBeNull();
    const refused = await save(o.owner, batch.id, [
      side(unclassified.body.data.id, 'debit', '5.00'),
    ]);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/has no subtype/);
    const stale = await o.owner.put(`/accounting/opening-balances/${batch.id}/lines`, {
      version: 99,
      lines: [],
    });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const empty = await o.owner.post(`/accounting/opening-balances/${batch.id}/preview`, {});
    expect(empty.body.data.errors[0].message).toBe('Enter at least one opening balance.');
  });

  it('needs a fiscal year, refuses P&L at a year end, checks the period and the designation', async () => {
    const o = await org();
    const batch = await draft(o.owner, '2026-01-01');
    await save(o.owner, batch.id, [side(o.accounts['1110']!, 'debit', '10.00')]);
    let preview = (await o.owner.post(`/accounting/opening-balances/${batch.id}/preview`, {})).body
      .data;
    expect(JSON.stringify(preview.errors)).toMatch(
      /No fiscal year covers the opening date 2025-12-31/,
    );
    const fy = await o.owner.post('/accounting/fiscal-years', {
      name: 'FY2025',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
    expect(fy.status).toBe(201);
    const pnl = await save(o.owner, batch.id, [
      side(o.accounts['1110']!, 'debit', '10.00'),
      side(o.accounts['4100']!, 'credit', '10.00'),
    ]);
    expect(pnl.status).toBe(400);
    expect(JSON.stringify(pnl.body)).toMatch(/belong in Retained Earnings/);
    preview = (await o.owner.post(`/accounting/opening-balances/${batch.id}/preview`, {})).body
      .data;
    expect(preview.errors).toEqual([]);

    // A closed period blocks.
    const dec = (fy.body.data.periods as any[]).find((p) => p.endDate === '2025-12-31');
    expect((await o.owner.post(`/accounting/periods/${dec.id}/close`, {})).status).toBe(200);
    preview = (await o.owner.post(`/accounting/opening-balances/${batch.id}/preview`, {})).body
      .data;
    expect(JSON.stringify(preview.errors)).toMatch(/is closed/);
    await o.owner.post(`/accounting/periods/${dec.id}/reopen`, { reason: 'Opening balances' });

    // A missing Opening Balance Equity designation blocks.
    await o.owner.put('/accounting/designations', { OPENING_BALANCE_EQUITY: null });
    preview = (await o.owner.post(`/accounting/opening-balances/${batch.id}/preview`, {})).body
      .data;
    expect(JSON.stringify(preview.errors)).toMatch(/Designate an Opening Balance Equity account/);
    await o.owner.put('/accounting/designations', { OPENING_BALANCE_EQUITY: o.accounts['3900'] });

    // P&L allowed mid-year.
    await o.owner.put('/accounting/settings/conversion-date', { conversionDate: '2026-04-01' });
    const midYear = await save(o.owner, batch.id, [
      side(o.accounts['1110']!, 'debit', '10.00'),
      side(o.accounts['4100']!, 'credit', '10.00'),
    ]);
    expect(midYear.status, JSON.stringify(midYear.body)).toBe(200);
    expect(midYear.body.data.openingDate).toBe('2026-03-31');
  });

  it('blocks missing required applicable dimensions and accepts them once assigned (S8-09)', async () => {
    const o = await org();
    const type = await o.owner.post('/accounting/dimensions', {
      code: 'BR',
      name: 'Branch',
      isRequired: true,
      scope: { accountTypes: ['ASSET'], accountSubtypes: [] },
    });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const value = await o.owner.post(`/accounting/dimensions/${type.body.data.id}/values`, {
      code: 'MLE',
      name: 'Male',
    });
    expect(value.status).toBe(201);
    const batch = await draft(o.owner);
    await save(o.owner, batch.id, [
      side(o.accounts['1110']!, 'debit', '10.00'),
      side(o.accounts['3100']!, 'credit', '10.00'),
    ]);
    const missing = (await o.owner.post(`/accounting/opening-balances/${batch.id}/preview`, {}))
      .body.data;
    expect(missing.errors).toEqual([
      expect.objectContaining({ message: 'Branch is required for this account.' }),
    ]);
    expect(
      (
        await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
          version: await version(o.owner, batch.id),
        })
      ).status,
    ).toBe(400);
    const dims = [{ dimensionTypeId: type.body.data.id, dimensionValueId: value.body.data.id }];
    await save(o.owner, batch.id, [
      side(o.accounts['1110']!, 'debit', '10.00', { dimensions: dims }),
      side(o.accounts['3100']!, 'credit', '10.00'),
    ]);
    const posted = await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
      version: await version(o.owner, batch.id),
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const journal = (await o.owner.get(`/accounting/journals/${posted.body.data.journals[0].id}`))
      .body.data;
    expect(journal.lines[0].dimensions).toEqual([
      expect.objectContaining({ dimensionValueId: value.body.data.id }),
    ]);
  });

  it('posts explicit carrying values and refuses too many lines for one currency', async () => {
    const o = await org();
    const batch = await draft(o.owner);
    await save(o.owner, batch.id, [side(o.usdBank, 'debit', '100.00', { baseAmount: '1500.00' })]);
    const posted = await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
      version: await version(o.owner, batch.id),
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data.journals[0]).toMatchObject({
      currency: 'USD',
      totalBaseDebit: '1500.0000',
      exchangeRateSource: 'manual',
      exchangeRate: '15.0000000000',
    });

    const other = await org();
    const big = await draft(other.owner);
    const lines = Array.from({ length: 500 }, () => side(other.accounts['1110']!, 'debit', '1.00'));
    expect((await save(other.owner, big.id, lines)).status).toBe(200);
    const preview = (await other.owner.post(`/accounting/opening-balances/${big.id}/preview`, {}))
      .body.data;
    expect(JSON.stringify(preview.errors)).toMatch(
      /MVR has 500 opening lines; one opening journal holds at most 499/,
    );
  });
});

describe('protections, permissions and isolation', () => {
  it('lets members read but not write, and keeps other tenants out', async () => {
    const o = await org();
    const batch = await draft(o.owner);
    await save(o.owner, batch.id, [side(o.accounts['1110']!, 'debit', '10.00')]);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/accounting/opening-balances')).status).toBe(200);
    expect((await member.client.get(`/accounting/opening-balances/${batch.id}`)).status).toBe(200);
    for (const res of [
      await member.client.post('/accounting/opening-balances', {}),
      await member.client.put(`/accounting/opening-balances/${batch.id}/lines`, {
        version: 1,
        lines: [],
      }),
      await member.client.post(`/accounting/opening-balances/${batch.id}/preview`, {}),
      await member.client.post(`/accounting/opening-balances/${batch.id}/post`, { version: 1 }),
      await member.client.delete(`/accounting/opening-balances/${batch.id}`),
    ]) {
      expect(res.status).toBe(403);
    }
    const other = await org();
    expect((await other.owner.get(`/accounting/opening-balances/${batch.id}`)).status).toBe(404);
    expect(
      (await other.owner.post(`/accounting/opening-balances/${batch.id}/post`, { version: 1 }))
        .status,
    ).toBe(404);

    // Drafts can be deleted (audited).
    expect((await o.owner.delete(`/accounting/opening-balances/${batch.id}`)).status).toBe(204);
    expect((await o.owner.get(`/accounting/opening-balances/${batch.id}`)).status).toBe(404);
    expect(await auditActions(o.owner)).toContain('opening_balance.deleted');
  });

  it('protects posted history in the database and isolates tenants under RLS', async () => {
    const o = await org();
    const batch = await draft(o.owner);
    await save(o.owner, batch.id, [side(o.accounts['1110']!, 'debit', '10.00')]);
    await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
      version: await version(o.owner, batch.id),
    });
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
        `UPDATE accounting_opening_balance_lines SET debit = 1 WHERE batch_id = '${batch.id}'`,
        `DELETE FROM accounting_opening_balance_lines WHERE batch_id = '${batch.id}'`,
        `INSERT INTO accounting_opening_balance_lines (organization_id, batch_id, line_number, account_id, debit)
           VALUES ('${o.organizationId}', '${batch.id}', 99, '${o.accounts['1110']}', 1)`,
        `UPDATE accounting_opening_balance_batches SET notes = 'x' WHERE id = '${batch.id}'`,
        `UPDATE accounting_opening_balance_batches SET status = 'DRAFT' WHERE id = '${batch.id}'`,
        `DELETE FROM accounting_opening_balance_batches WHERE id = '${batch.id}'`,
      ]) {
        await expect(inTenant(o.organizationId, statement)).rejects.toMatchObject({
          code: '23514',
        });
      }
      // S8-07 in the database: a draft line needs a classified, non-receivable, non-control account.
      const draftBatch = await draft(other.owner);
      const otherUnclassified = await other.owner.post('/accounting/accounts', {
        code: '1190',
        name: 'Old suspense',
        type: 'ASSET',
        parentId: other.accounts['1100'],
      });
      for (const accountId of [otherUnclassified.body.data.id, other.accounts['1130']]) {
        await expect(
          inTenant(
            other.organizationId,
            `INSERT INTO accounting_opening_balance_lines (organization_id, batch_id, line_number, account_id, debit)
               VALUES ('${other.organizationId}', '${draftBatch.id}', 1, '${accountId}', 1)`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
      const hidden = await inTenant(
        other.organizationId,
        `SELECT count(*)::int AS n FROM accounting_opening_balance_batches WHERE id = '${batch.id}'`,
      );
      expect(hidden.rows[0].n).toBe(0);
    } finally {
      await app.end();
    }
  });

  it('requires MFA of accounting.setup holders (57a) before any opening-balance write', async () => {
    const o = await org();
    const person = await joinWithRole(ctx, o.owner, 'Member');
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Setup clerk',
      permissionKeys: ['organization.read', 'accounting.setup', 'accounting.journals.view'],
    });
    await o.owner.put(`/organizations/current/members/${person.membershipId}/roles`, {
      roleIds: [role.body.data.id],
    });
    person.client.autoMfa = false;
    const blocked = await person.client.get('/accounting/opening-balances');
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
  });
});

describe('import, export and attachments (S8-16, S8-17)', () => {
  async function settle(client: TestClient, id: string) {
    for (let i = 0; i < 40; i++) {
      const res = await client.get(`/imports/${id}`);
      if (!['validating', 'committing'].includes(res.body.data.status)) return res.body.data;
      await ctx.worker.runOnce();
    }
    return (await client.get(`/imports/${id}`)).body.data;
  }
  async function importFile(client: TestClient, content: string) {
    const created = await client.post('/imports', { domain: 'opening_balances', options: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const up = await client.upload(
      `/files?linkType=import_batch&linkId=${id}`,
      Buffer.from(content),
      'ob.csv',
    );
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const inspected = await client.post(`/imports/${id}/inspect`, {});
    const mapped = await client.put(`/imports/${id}/mapping`, {
      version: inspected.body.data.batch.version,
      mapping: inspected.body.data.suggestedMapping,
    });
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(202);
    return { id, batch: await settle(client, id) };
  }

  it('imports into the draft batch only, never posting; exports round-trip', async () => {
    const o = await org();
    await o.owner.put('/accounting/settings/conversion-date', { conversionDate: '2026-04-01' });
    const bad = await importFile(
      o.owner,
      csv('Account,Debit,Credit,Base amount,Description', '1130,10.00,,,Receivables'),
    );
    expect(bad.batch.counts).toMatchObject({ error: 1 });
    const errors = await o.owner.get(`/imports/${bad.id}/rows?status=error&limit=10`);
    expect(JSON.stringify(errors.body)).toMatch(/opening invoices/);

    const good = await importFile(
      o.owner,
      csv(
        'Account,Debit,Credit,Base amount,Description',
        '1110,"1,250.00",,,Cash',
        '1125,100.00,,1540.00,USD bank',
        '3100,,500.00,,Capital',
      ),
    );
    expect(good.batch).toMatchObject({ status: 'validated', counts: { valid: 3, error: 0 } });
    const committed = await o.owner.post(`/imports/${good.id}/commit`, {
      version: good.batch.version,
    });
    expect(committed.status, JSON.stringify(committed.body)).toBe(202);
    expect((await settle(o.owner, good.id)).status).toBe('committed');
    const list = (await o.owner.get('/accounting/opening-balances')).body.data;
    expect(list.batches).toHaveLength(1);
    const batch = (await o.owner.get(`/accounting/opening-balances/${list.batches[0].id}`)).body
      .data;
    expect(batch.status).toBe('DRAFT');
    expect(batch.journals).toEqual([]);
    expect(batch.lines.map((l: any) => [l.accountCode, l.debit, l.credit, l.baseAmount])).toEqual([
      ['1110', '1250', null, null],
      ['1125', '100', null, '1540'],
      ['3100', null, '500', null],
    ]);

    // Export (the import's columns).
    const started = await o.owner.post('/exports', { domain: 'opening_balances', params: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const exportId = started.body.data.export.id;
    for (let i = 0; i < 20; i++) {
      const view = (await o.owner.get(`/exports/${exportId}`)).body.data;
      if (view.status === 'ready') break;
      await ctx.worker.runOnce();
    }
    const link = await o.owner.get(`/exports/${exportId}/download-url`);
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const file = await ctx.app.inject({ method: 'GET', url: link.body.data.url });
    const rows: string[][] = [];
    for await (const r of readCsv(
      (async function* () {
        yield file.body;
      })(),
      { delimiter: ',', maxColumns: 50, maxRecordChars: 100_000 },
    )) {
      rows.push(r.cells);
    }
    expect(rows[0]).toEqual([
      'Account',
      'Account name',
      'Currency',
      'Debit',
      'Credit',
      'Base amount',
      'Description',
    ]);
    expect(rows.slice(1).map((r) => [r[0], r[3], r[5]])).toEqual([
      ['1110', '1250.0000', ''],
      ['1125', '100.0000', '1540.0000'],
      ['3100', '', ''],
    ]);

    // Attachments: only while the batch is a draft; posted evidence is immutable.
    const up = await o.owner.upload(
      `/files?linkType=opening_balance_batch&linkId=${batch.id}`,
      pdf,
      'prior-tb.pdf',
    );
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (await member.client.get(`/files?linkType=opening_balance_batch&linkId=${batch.id}`)).status,
    ).toBe(200);
    expect(
      (
        await member.client.upload(
          `/files?linkType=opening_balance_batch&linkId=${batch.id}`,
          pdf,
          'x.pdf',
        )
      ).status,
    ).toBe(403);
    const posted = await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
      version: batch.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const late = await o.owner.upload(
      `/files?linkType=opening_balance_batch&linkId=${batch.id}`,
      pdf,
      'late.pdf',
    );
    expect(late.status).toBe(409);
    expect((await o.owner.delete(`/files/${up.body.data.id}`)).status).toBe(409);

    // Importing while posted is refused row by row.
    const blocked = await importFile(o.owner, csv('Account,Debit', '1110,1.00'));
    const blockedRows = await o.owner.get(`/imports/${blocked.id}/rows?status=error&limit=10`);
    expect(JSON.stringify(blockedRows.body)).toMatch(/already posted/);
  });
});
