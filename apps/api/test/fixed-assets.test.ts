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
 * Fixed assets: categories, acquisition and capitalization, the register, straight-line
 * depreciation runs by month (with catch-up), disposal with gain or loss, category transfers,
 * voids, the register against the ledger, and security. Every posting goes through an accounting
 * event; the ledger and the asset entries stay in step.
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

interface AssetOrg extends AccountingOrg {
  categoryId: string;
}

async function assetOrg(options: { settings?: boolean } = {}): Promise<AssetOrg> {
  const org = await setUpAccountingOrg(ctx);
  const category = await org.owner.post('/fixed-assets/categories', {
    name: 'Equipment',
    costAccountId: org.accounts['1510'],
    accumulatedAccountId: org.accounts['1520'],
    expenseAccountId: org.accounts['5500'],
    defaultLifeMonths: 60,
  });
  expect(category.status, JSON.stringify(category.body)).toBe(201);
  if (options.settings !== false) {
    const settings = await org.owner.put('/fixed-assets/settings', {
      version: 0,
      gainLossAccountId: org.accounts['5400'],
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  }
  return { ...org, categoryId: category.body.data.id as string };
}

const assetBody = (o: AssetOrg, overrides: Record<string, unknown> = {}) => ({
  name: 'Dive compressor',
  categoryId: o.categoryId,
  acquisitionDate: '2026-01-15',
  cost: '12000.00',
  lifeMonths: 12,
  creditAccountId: o.accounts['1120'],
  ...overrides,
});

async function register(o: AssetOrg, overrides: Record<string, unknown> = {}) {
  const res = await o.owner.post('/fixed-assets/assets', assetBody(o, overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as {
    id: string;
    number: string;
    version: number;
    accumulatedDepreciation: string;
    acquisitionJournalId: string | null;
  };
}

async function runDepreciation(o: AssetOrg, monthEnd: string) {
  return o.owner.post('/fixed-assets/depreciation/runs', { monthEnd });
}

async function glBalance(organizationId: string, accountId: string) {
  const { rows } = await owner.query(
    `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
    [organizationId, accountId],
  );
  return rows[0].b as string;
}

async function journalOf(o: AccountingOrg, journalId: string) {
  return (await o.owner.get(`/accounting/journals/${journalId}`)).body.data as {
    status: string;
    sourceDocument: { documentType: string; number: string } | null;
    lines: { accountId: string; debit: string | null; credit: string | null }[];
  };
}

async function reauth(client: TestClient) {
  ctx.clock.advance(16 * MINUTE);
  await client.get('/auth/session');
  expect((await client.reauthenticate()).status).toBe(200);
}

async function auditActions(o: AccountingOrg, resourceType: string, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action FROM audit_events
      WHERE organization_id = $1 AND resource_type = $2 AND resource_id = $3 ORDER BY occurred_at, id`,
    [o.organizationId, resourceType, resourceId],
  );
  return (rows as { action: string }[]).map((r) => r.action);
}

// ---------------------------------------------------------------------------
// Categories and settings
// ---------------------------------------------------------------------------

describe('categories and settings', () => {
  it('needs asset, asset and expense accounts, all different, with a unique name', async () => {
    const o = await assetOrg();
    const base = {
      name: 'Vehicles',
      costAccountId: o.accounts['1510'],
      accumulatedAccountId: o.accounts['1520'],
      expenseAccountId: o.accounts['5500'],
      defaultLifeMonths: 96,
    };
    const duplicate = await o.owner.post('/fixed-assets/categories', {
      ...base,
      name: 'equipment',
    });
    expect(duplicate.body.error.details.issues[0].path).toBe('name');
    const wrongType = await o.owner.post('/fixed-assets/categories', {
      ...base,
      name: 'Boats',
      expenseAccountId: o.accounts['4100'],
    });
    expect(wrongType.body.error.details.issues[0].path).toBe('expenseAccountId');
    const same = await o.owner.post('/fixed-assets/categories', {
      ...base,
      name: 'Boats',
      accumulatedAccountId: o.accounts['1510'],
    });
    expect(same.status).toBe(400);
    // A category with assets keeps its accounts, and can be archived.
    await register(o);
    const moved = await o.owner.patch(`/fixed-assets/categories/${o.categoryId}`, {
      version: 1,
      expenseAccountId: o.accounts['5400'],
    });
    expect(moved.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const renamed = await o.owner.patch(`/fixed-assets/categories/${o.categoryId}`, {
      version: 1,
      name: 'Equipment and tools',
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const archived = await o.owner.post(`/fixed-assets/categories/${o.categoryId}/archive`, {
      version: renamed.body.data.version,
    });
    expect(archived.body.data.status).toBe('ARCHIVED');
    const refused = await o.owner.post('/fixed-assets/assets', assetBody(o));
    expect(refused.body.error.details.issues[0].path).toBe('categoryId');
  });

  it('keeps the gain/loss account to a revenue or expense posting account', async () => {
    const o = await assetOrg({ settings: false });
    const bank = await o.owner.put('/fixed-assets/settings', {
      version: 0,
      gainLossAccountId: o.accounts['1120'],
    });
    expect(bank.status).toBe(400);
    const ok = await o.owner.put('/fixed-assets/settings', {
      version: 0,
      gainLossAccountId: o.accounts['5400'],
    });
    expect(ok.body.data).toMatchObject({ gainLossAccountId: o.accounts['5400'], version: 1 });
    const stale = await o.owner.put('/fixed-assets/settings', {
      version: 0,
      gainLossAccountId: null,
    });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

describe('acquisition and the register', () => {
  it('capitalizes an asset: Dr cost / Cr the funding account through the accounting event', async () => {
    const o = await assetOrg();
    const asset = await register(o, { serialNumber: 'CMP-77', location: 'Dive shop' });
    expect(asset).toMatchObject({ number: 'FA-00001', accumulatedDepreciation: '0.00' });
    const journal = await journalOf(o, asset.acquisitionJournalId!);
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: o.accounts['1510'], debit: '12000.0000' }),
        expect.objectContaining({ accountId: o.accounts['1120'], credit: '12000.0000' }),
      ]),
    );
    expect(journal.sourceDocument).toMatchObject({ documentType: 'asset', number: 'FA-00001' });
    const detail = (await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data;
    expect(detail.schedule).toHaveLength(12);
    expect(detail.schedule[0]).toMatchObject({
      monthEnd: '2026-01-31',
      amount: '1000.00',
      booked: false,
    });
    expect(detail.entries).toHaveLength(1);
    expect(await auditActions(o, 'fixed_asset', asset.id)).toContain('fixed_asset.registered');
  });

  it('validates the dates, amounts, category and funding account', async () => {
    const o = await assetOrg();
    const post = (overrides: Record<string, unknown>) =>
      o.owner.post('/fixed-assets/assets', assetBody(o, overrides));
    expect((await post({ inServiceDate: '2026-01-01' })).body.error.details.issues[0].path).toBe(
      'inServiceDate',
    );
    expect((await post({ salvageValue: '13000.00' })).body.error.details.issues[0].path).toBe(
      'salvageValue',
    );
    expect((await post({ cost: '100.123' })).body.error.details.issues[0].path).toBe('cost');
    expect((await post({ creditAccountId: undefined })).body.error.details.issues[0].path).toBe(
      'creditAccountId',
    );
    expect(
      (await post({ creditAccountId: o.accounts['1510'] })).body.error.details.issues[0].path,
    ).toBe('creditAccountId');
    expect((await post({ categoryId: randomUUID() })).body.error.details.issues[0].path).toBe(
      'categoryId',
    );
    const period = o.periods.find((p) => p.startDate <= '2026-01-15' && p.endDate >= '2026-01-15')!;
    expect((await o.owner.post(`/accounting/periods/${period.id}/close`)).status).toBe(200);
    expect((await post({})).body.error.code).toBe('PERIOD_CLOSED');
  });

  it('registers an asset already in the ledger without posting, and the reconciliation shows the gap', async () => {
    const o = await assetOrg();
    const asset = await register(o, { alreadyInLedger: true, creditAccountId: undefined });
    expect(asset.acquisitionJournalId).toBeNull();
    const reconciliation = (
      await o.owner.get('/fixed-assets/reports/reconciliation?asOf=2026-03-31')
    ).body.data;
    const cost = reconciliation.accounts.find((a: { kind: string }) => a.kind === 'cost');
    expect(cost).toMatchObject({ register: '12000.00', ledger: '0.00', difference: '-12000.00' });
  });

  it('replays an idempotent registration', async () => {
    const o = await assetOrg();
    const key = randomUUID();
    const first = await o.owner.post('/fixed-assets/assets', assetBody(o), {
      'Idempotency-Key': key,
    });
    const replay = await o.owner.post('/fixed-assets/assets', assetBody(o), {
      'Idempotency-Key': key,
    });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect((await o.owner.get('/fixed-assets/assets')).body.data.items).toHaveLength(1);
  });

  it('edits only the descriptive fields', async () => {
    const o = await assetOrg();
    const asset = await register(o);
    const edited = await o.owner.patch(`/fixed-assets/assets/${asset.id}`, {
      version: asset.version,
      name: 'Compressor 2',
      custodian: 'Ahmed',
    });
    expect(edited.body.data).toMatchObject({
      name: 'Compressor 2',
      custodian: 'Ahmed',
      cost: '12000.00',
    });
    await expect(
      owner.query(`UPDATE fixed_assets SET cost = 1 WHERE id = $1`, [asset.id]),
    ).rejects.toThrow(/fixed once capitalized/);
    await expect(owner.query(`DELETE FROM fixed_assets WHERE id = $1`, [asset.id])).rejects.toThrow(
      /never deleted/,
    );
  });
});

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

describe('depreciation runs', () => {
  it('books the schedule to a month end, with catch-up, in one journal by category', async () => {
    const o = await assetOrg();
    const asset = await register(o);
    const preview = await o.owner.get('/fixed-assets/depreciation/preview?monthEnd=2026-03-31');
    expect(preview.body.data).toMatchObject({ total: '3000.00', canRun: true });
    expect(preview.body.data.lines[0]).toMatchObject({
      amount: '3000.00',
      bookValueAfter: '9000.00',
    });
    const first = await runDepreciation(o, '2026-03-31');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({
      number: 'DEP-00001',
      total: '3000.00',
      assetCount: 1,
      status: 'POSTED',
    });
    const journal = await journalOf(o, first.body.data.journalId);
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: o.accounts['5500'], debit: '3000.0000' }),
        expect.objectContaining({ accountId: o.accounts['1520'], credit: '3000.0000' }),
      ]),
    );
    expect(journal.sourceDocument).toMatchObject({
      documentType: 'depreciation_run',
      number: 'DEP-00001',
    });
    // The same or an earlier month is refused; a later month catches up everything owing.
    expect((await runDepreciation(o, '2026-03-31')).body.error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    const later = await runDepreciation(o, '2026-06-30');
    expect(later.body.data).toMatchObject({ total: '3000.00' });
    expect((await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data).toMatchObject({
      accumulatedDepreciation: '6000.00',
      bookValue: '6000.00',
    });
    expect(await glBalance(o.organizationId, o.accounts['1520']!)).toBe('-6000.00');
    expect(await glBalance(o.organizationId, o.accounts['5500']!)).toBe('6000.00');
    // Nothing more is owing at the same month end.
    expect((await runDepreciation(o, '2026-06-30')).body.error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('depreciates the whole life exactly and then stops', async () => {
    const o = await assetOrg();
    await register(o, { cost: '1000.00', lifeMonths: 7, acquisitionDate: '2026-01-01' });
    const done = await runDepreciation(o, '2026-09-30');
    expect(done.body.data.total).toBe('1000.00');
    const after = await o.owner.get('/fixed-assets/depreciation/preview?monthEnd=2026-09-30');
    expect(after.body.data.lines).toEqual([]);
  });

  it('refuses a month that is not a month end, a future month and a closed period', async () => {
    const o = await assetOrg();
    await register(o);
    expect((await runDepreciation(o, '2026-03-30')).body.error.details.issues[0].path).toBe(
      'monthEnd',
    );
    expect((await runDepreciation(o, '2099-12-31')).status).toBe(400);
    const period = o.periods.find((p) => p.startDate <= '2026-03-31' && p.endDate >= '2026-03-31')!;
    expect((await o.owner.post(`/accounting/periods/${period.id}/close`)).status).toBe(200);
    expect((await runDepreciation(o, '2026-03-31')).body.error.code).toBe('PERIOD_CLOSED');
  });

  it('voids only the latest run, with re-authentication, restoring the asset', async () => {
    const o = await assetOrg();
    const asset = await register(o);
    const first = (await runDepreciation(o, '2026-02-28')).body.data;
    const second = (await runDepreciation(o, '2026-04-30')).body.data;
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await o.owner.post(`/fixed-assets/depreciation/runs/${second.id}/void`, {
      version: second.version,
      reason: 'Wrong',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const notLatest = await o.owner.post(`/fixed-assets/depreciation/runs/${first.id}/void`, {
      version: first.version,
      reason: 'Wrong',
    });
    expect(notLatest.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const voided = await o.owner.post(`/fixed-assets/depreciation/runs/${second.id}/void`, {
      version: second.version,
      reason: 'Wrong month',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'VOID', voidReason: 'Wrong month' });
    expect((await journalOf(o, second.journalId)).status).toBe('REVERSED');
    expect(
      (await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data.accumulatedDepreciation,
    ).toBe('2000.00');
    expect(await glBalance(o.organizationId, o.accounts['1520']!)).toBe('-2000.00');
    // The month can be run again after the void.
    expect((await runDepreciation(o, '2026-04-30')).status).toBe(201);
    expect(await auditActions(o, 'fixed_asset_run', second.id)).toEqual(
      expect.arrayContaining(['fixed_asset_run.posted', 'fixed_asset_run.voided']),
    );
  });

  it('replays an idempotent run', async () => {
    const o = await assetOrg();
    await register(o);
    const key = randomUUID();
    const first = await o.owner.post(
      '/fixed-assets/depreciation/runs',
      { monthEnd: '2026-02-28' },
      { 'Idempotency-Key': key },
    );
    const replay = await o.owner.post(
      '/fixed-assets/depreciation/runs',
      { monthEnd: '2026-02-28' },
      { 'Idempotency-Key': key },
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect((await o.owner.get('/fixed-assets/depreciation/runs')).body.data.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

describe('disposal', () => {
  async function disposable() {
    const o = await assetOrg();
    const asset = await register(o);
    await runDepreciation(o, '2026-03-31');
    return { o, asset };
  }

  it('catches up depreciation, removes cost and accumulated depreciation and books the loss', async () => {
    const { o, asset } = await disposable();
    const res = await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
      version: 2,
      disposalDate: '2026-07-10',
      proceeds: '5000.00',
      proceedsAccountId: o.accounts['1120'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // 6 months to the end of June = 6000; 3000 booked, 3000 caught up; book value 6000; proceeds 5000.
    expect(res.body.data).toMatchObject({
      catchupDepreciation: '3000.0000',
      accumulatedDepreciation: '6000.0000',
      gainLoss: '-1000.0000',
      status: 'POSTED',
    });
    const journal = await journalOf(o, res.body.data.journalId);
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: o.accounts['1510'], credit: '12000.0000' }),
        expect.objectContaining({ accountId: o.accounts['1520'], debit: '3000.0000' }),
        expect.objectContaining({ accountId: o.accounts['5500'], debit: '3000.0000' }),
        expect.objectContaining({ accountId: o.accounts['1120'], debit: '5000.0000' }),
        expect.objectContaining({ accountId: o.accounts['5400'], debit: '1000.0000' }),
      ]),
    );
    expect(await glBalance(o.organizationId, o.accounts['1510']!)).toBe('0.00');
    expect(await glBalance(o.organizationId, o.accounts['1520']!)).toBe('0.00');
    const after = (await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data;
    expect(after.status).toBe('DISPOSED');
    // A disposed asset is out of the register as of a later date and out of later runs.
    const register = (await o.owner.get('/fixed-assets/reports/register?asOf=2026-08-31')).body
      .data;
    expect(register.items).toEqual([]);
    expect(
      (await o.owner.get('/fixed-assets/reports/register?asOf=2026-05-31')).body.data.totals.cost,
    ).toBe('12000.00');
    expect((await runDepreciation(o, '2026-08-31')).body.error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    const again = await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
      version: after.version,
      disposalDate: '2026-07-11',
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await auditActions(o, 'fixed_asset_disposal', res.body.data.id)).toContain(
      'fixed_asset.disposed',
    );
  });

  it('books a gain when the proceeds exceed the book value', async () => {
    const { o, asset } = await disposable();
    const res = await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
      version: 2,
      disposalDate: '2026-07-10',
      proceeds: '8000.00',
      proceedsAccountId: o.accounts['1120'],
    });
    expect(res.body.data.gainLoss).toBe('2000.0000');
    const journal = await journalOf(o, res.body.data.journalId);
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: o.accounts['5400'], credit: '2000.0000' }),
      ]),
    );
  });

  it('disposes without proceeds (a write-off) and needs the settings, an account for proceeds and sound dates', async () => {
    const noSettings = await assetOrg({ settings: false });
    const a = await register(noSettings);
    const blocked = await noSettings.owner.post(`/fixed-assets/assets/${a.id}/dispose`, {
      version: 1,
      disposalDate: '2026-07-10',
    });
    expect(blocked.body.error.details.issues[0].path).toBe('gainLossAccountId');
    const { o, asset } = await disposable();
    const noAccount = await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
      version: 2,
      disposalDate: '2026-07-10',
      proceeds: '10.00',
    });
    expect(noAccount.body.error.details.issues[0].path).toBe('proceedsAccountId');
    const early = await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
      version: 2,
      disposalDate: '2025-12-31',
    });
    expect(early.body.error.details.issues[0].path).toBe('disposalDate');
    const writeOff = await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
      version: 2,
      disposalDate: '2026-07-10',
    });
    expect(writeOff.body.data).toMatchObject({ proceeds: '0.0000', gainLoss: '-6000.0000' });
  });

  it('refuses a disposal before depreciation that was already booked beyond it', async () => {
    const o = await assetOrg();
    const asset = await register(o);
    await runDepreciation(o, '2026-08-31');
    const res = await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
      version: 2,
      disposalDate: '2026-03-10',
    });
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('voids a disposal with re-authentication, restoring the asset and its depreciation', async () => {
    const { o, asset } = await disposable();
    const disposal = (
      await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
        version: 2,
        disposalDate: '2026-07-10',
        proceeds: '5000.00',
        proceedsAccountId: o.accounts['1120'],
      })
    ).body.data;
    await reauth(o.owner);
    const voided = await o.owner.post(`/fixed-assets/disposals/${disposal.id}/void`, {
      version: disposal.version,
      reason: 'Sale fell through',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.status).toBe('VOID');
    const restored = (await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data;
    expect(restored).toMatchObject({ status: 'ACTIVE', accumulatedDepreciation: '3000.00' });
    expect(await glBalance(o.organizationId, o.accounts['1510']!)).toBe('12000.00');
    expect(await glBalance(o.organizationId, o.accounts['1520']!)).toBe('-3000.00');
    expect((await journalOf(o, disposal.journalId)).status).toBe('REVERSED');
    const register = (await o.owner.get('/fixed-assets/reports/register?asOf=2026-08-31')).body
      .data;
    expect(register.totals).toMatchObject({ cost: '12000.00', accumulatedDepreciation: '3000.00' });
    // It can be disposed of again.
    expect(
      (
        await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
          version: restored.version,
          disposalDate: '2026-07-10',
        })
      ).status,
    ).toBe(201);
  });

  it('blocks voiding a run of a disposed asset', async () => {
    const o = await assetOrg();
    const asset = await register(o);
    const run = (await runDepreciation(o, '2026-03-31')).body.data;
    await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
      version: 2,
      disposalDate: '2026-07-10',
    });
    await reauth(o.owner);
    const res = await o.owner.post(`/fixed-assets/depreciation/runs/${run.id}/void`, {
      version: run.version,
      reason: 'x',
    });
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// Straight-line characterization (M2 step 0, locked before R-11)
// ---------------------------------------------------------------------------

/**
 * The current straight-line behavior through the real API and ledger, with amounts that do not
 * divide evenly. Expected values were computed from the schedule functions and independently from
 * ADR 0008 (FA-04 to FA-06); they must not change when other methods are added.
 * Asset: cost 1000.00, salvage 100.03, 7 months in service from 2026-03-20; monthly charges
 * 128.57, 128.56, 128.57, 128.57, 128.57, 128.56, 128.57 (accumulated 899.97).
 */
describe('straight-line characterization (locked before R-11)', () => {
  const uneven = {
    cost: '1000.00',
    salvageValue: '100.03',
    lifeMonths: 7,
    acquisitionDate: '2026-03-20',
  };

  it('books uneven runs with catch-up to the exact depreciable amount and reconciles', async () => {
    const o = await assetOrg();
    const asset = await register(o, uneven);
    expect((await runDepreciation(o, '2026-04-30')).body.data.total).toBe('257.13');
    // Catch-up of months 3 to 6 in one run.
    expect((await runDepreciation(o, '2026-08-31')).body.data.total).toBe('514.27');
    // The last month of the life.
    expect((await runDepreciation(o, '2026-09-30')).body.data.total).toBe('128.57');
    expect((await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data).toMatchObject({
      accumulatedDepreciation: '899.97',
      bookValue: '100.03',
    });
    expect(await glBalance(o.organizationId, o.accounts['1520']!)).toBe('-899.97');
    expect(await glBalance(o.organizationId, o.accounts['5500']!)).toBe('899.97');
    const after = await o.owner.get('/fixed-assets/depreciation/preview?monthEnd=2026-09-30');
    expect(after.body.data.lines).toEqual([]);
    const reconciliation = (
      await o.owner.get('/fixed-assets/reports/reconciliation?asOf=2026-09-30')
    ).body.data;
    expect(reconciliation.accounts.map((a: { difference: string }) => a.difference)).toEqual([
      '0.00',
      '0.00',
    ]);
  });

  it('starts in the in-service month, not the acquisition month, and ends a one-month life at salvage', async () => {
    const o = await assetOrg();
    const asset = await register(o, {
      cost: '999.99',
      salvageValue: '0.99',
      lifeMonths: 1,
      acquisitionDate: '2026-04-25',
      inServiceDate: '2026-05-17',
    });
    const before = await o.owner.get('/fixed-assets/depreciation/preview?monthEnd=2026-04-30');
    expect(before.body.data.lines).toEqual([]);
    expect((await runDepreciation(o, '2026-05-31')).body.data.total).toBe('999.00');
    expect((await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data).toMatchObject({
      accumulatedDepreciation: '999.00',
      bookValue: '0.99',
    });
    const later = await o.owner.get('/fixed-assets/depreciation/preview?monthEnd=2026-06-30');
    expect(later.body.data.lines).toEqual([]);
  });

  it('disposes mid-life: catches up to the month before, removes the asset and books the gain', async () => {
    const o = await assetOrg();
    const asset = await register(o, uneven);
    expect((await runDepreciation(o, '2026-04-30')).body.data.total).toBe('257.13');
    const { version } = (await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data;
    const res = await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
      version,
      disposalDate: '2026-07-10',
      proceeds: '600.00',
      proceedsAccountId: o.accounts['1120'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // To the end of June: 514.27 accumulated, 257.14 of it caught up; book value 485.73.
    expect(res.body.data).toMatchObject({
      catchupDepreciation: '257.1400',
      accumulatedDepreciation: '514.2700',
      gainLoss: '114.2700',
    });
    expect(await glBalance(o.organizationId, o.accounts['1510']!)).toBe('0.00');
    expect(await glBalance(o.organizationId, o.accounts['1520']!)).toBe('0.00');
    expect(await glBalance(o.organizationId, o.accounts['5500']!)).toBe('514.27');
    expect(await glBalance(o.organizationId, o.accounts['5400']!)).toBe('-114.27');
  });

  it('re-runs a voided month to exactly the same amount', async () => {
    const o = await assetOrg();
    const asset = await register(o, uneven);
    expect((await runDepreciation(o, '2026-04-30')).body.data.total).toBe('257.13');
    const second = (await runDepreciation(o, '2026-06-30')).body.data;
    expect(second.total).toBe('257.14');
    await reauth(o.owner);
    const voided = await o.owner.post(`/fixed-assets/depreciation/runs/${second.id}/void`, {
      version: second.version,
      reason: 'Re-run',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(
      (await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data.accumulatedDepreciation,
    ).toBe('257.13');
    const again = await runDepreciation(o, '2026-06-30');
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.total).toBe('257.14');
    expect(
      (await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data.accumulatedDepreciation,
    ).toBe('514.27');
    expect(await glBalance(o.organizationId, o.accounts['1520']!)).toBe('-514.27');
  });
});

// ---------------------------------------------------------------------------
// Declining-balance methods (R-11; ADR 0008 FA-12)
// ---------------------------------------------------------------------------

describe('declining-balance methods (R-11)', () => {
  // Expected values from an independent month-by-month model in exact fractions. Year 1 is
  // 45.5% of 1,000.00 = 455.00 (more than straight line, 359.99), 37.9166... a month.
  const declining = {
    cost: '1000.00',
    salvageValue: '100.03',
    lifeMonths: 30,
    acquisitionDate: '2026-03-20',
    depreciationMethod: 'declining_balance',
    decliningRate: '45.5',
  };

  it('registers the method and rate, books runs with catch-up and reconciles', async () => {
    const o = await assetOrg();
    const asset = await register(o, declining);
    const detail = (await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data;
    expect(detail).toMatchObject({
      depreciationMethod: 'declining_balance',
      decliningRate: '45.5000',
      doubleDecliningRate: null,
    });
    expect(detail.schedule).toHaveLength(30);
    expect(detail.schedule.slice(0, 2).map((r: { amount: string }) => r.amount)).toEqual([
      '37.92',
      '37.91',
    ]);
    expect(detail.schedule.at(-1)).toMatchObject({ accumulated: '899.97', bookValue: '100.03' });
    const { rows } = await owner.query(
      `SELECT metadata FROM audit_events
        WHERE organization_id = $1 AND resource_id = $2 AND action = 'fixed_asset.registered'`,
      [o.organizationId, asset.id],
    );
    expect(rows[0].metadata).toMatchObject({
      depreciationMethod: 'declining_balance',
      decliningRate: '45.5000',
    });
    const preview = await o.owner.get('/fixed-assets/depreciation/preview?monthEnd=2026-04-30');
    expect(preview.body.data.total).toBe('75.83');
    expect((await runDepreciation(o, '2026-04-30')).body.data.total).toBe('75.83');
    // Catch-up of months 3 to 6 in one run, then month 7.
    expect((await runDepreciation(o, '2026-08-31')).body.data.total).toBe('151.67');
    expect((await runDepreciation(o, '2026-09-30')).body.data.total).toBe('37.92');
    expect((await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data).toMatchObject({
      accumulatedDepreciation: '265.42',
      bookValue: '734.58',
    });
    expect(await glBalance(o.organizationId, o.accounts['1520']!)).toBe('-265.42');
    expect(await glBalance(o.organizationId, o.accounts['5500']!)).toBe('265.42');
    const reconciliation = (
      await o.owner.get('/fixed-assets/reports/reconciliation?asOf=2026-09-30')
    ).body.data;
    expect(reconciliation.accounts.map((a: { difference: string }) => a.difference)).toEqual([
      '0.00',
      '0.00',
    ]);
  });

  it('disposes mid-life with catch-up, and re-runs a voided month to the same amount', async () => {
    const o = await assetOrg();
    const asset = await register(o, declining);
    expect((await runDepreciation(o, '2026-04-30')).body.data.total).toBe('75.83');
    const second = (await runDepreciation(o, '2026-06-30')).body.data;
    expect(second.total).toBe('75.84');
    await reauth(o.owner);
    const voided = await o.owner.post(`/fixed-assets/depreciation/runs/${second.id}/void`, {
      version: second.version,
      reason: 'Re-run',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    // Disposal catches up to the end of June: 151.67 accumulated, 75.84 of it caught up.
    const { version } = (await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data;
    const res = await o.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
      version,
      disposalDate: '2026-07-10',
      proceeds: '900.00',
      proceedsAccountId: o.accounts['1120'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      catchupDepreciation: '75.8400',
      accumulatedDepreciation: '151.6700',
      gainLoss: '51.6700',
    });
    expect(await glBalance(o.organizationId, o.accounts['1520']!)).toBe('0.00');
    expect(await glBalance(o.organizationId, o.accounts['5500']!)).toBe('151.67');
    expect(await glBalance(o.organizationId, o.accounts['5400']!)).toBe('-51.67');
  });

  it('double-declining stores no rate, shows the derived one, and survives a transfer', async () => {
    const o = await assetOrg();
    // Life 48: 50% a year, 4,800.00 in year 1, 400.00 a month.
    const asset = await register(o, {
      cost: '9600.00',
      lifeMonths: 48,
      depreciationMethod: 'double_declining_balance',
    });
    expect((await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data).toMatchObject({
      depreciationMethod: 'double_declining_balance',
      decliningRate: null,
      doubleDecliningRate: '50.0000',
    });
    const { rows } = await owner.query(`SELECT declining_rate FROM fixed_assets WHERE id = $1`, [
      asset.id,
    ]);
    expect(rows[0].declining_rate).toBeNull();
    expect((await runDepreciation(o, '2026-03-31')).body.data.total).toBe('1200.00');
    const other = await o.owner.post('/fixed-assets/categories', {
      name: 'Boats',
      costAccountId: o.accounts['1140'],
      accumulatedAccountId: o.accounts['1150'],
      expenseAccountId: o.accounts['5400'],
      defaultLifeMonths: 120,
    });
    const moved = await o.owner.post(`/fixed-assets/assets/${asset.id}/transfer`, {
      version: 2,
      transferDate: '2026-04-05',
      toCategoryId: other.body.data.id,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await glBalance(o.organizationId, o.accounts['1150']!)).toBe('-1200.00');
    // The schedule is the asset's, not the category's: the transfer does not change it.
    expect((await runDepreciation(o, '2026-04-30')).body.data.total).toBe('400.00');
    expect((await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data).toMatchObject({
      depreciationMethod: 'double_declining_balance',
      lifeMonths: 48,
      accumulatedDepreciation: '1600.00',
    });
  });

  it('validates the method and the rate', async () => {
    const o = await assetOrg();
    const post = (overrides: Record<string, unknown>) =>
      o.owner.post('/fixed-assets/assets', assetBody(o, overrides));
    const issue = async (overrides: Record<string, unknown>) =>
      (await post(overrides)).body.error.details.issues[0].path as string;
    expect(await issue({ depreciationMethod: 'declining_balance' })).toBe('decliningRate');
    expect(await issue({ depreciationMethod: 'declining_balance', decliningRate: '0' })).toBe(
      'decliningRate',
    );
    expect(
      await issue({ depreciationMethod: 'declining_balance', decliningRate: '100.0001' }),
    ).toBe('decliningRate');
    expect(
      await issue({ depreciationMethod: 'declining_balance', decliningRate: '12.34567' }),
    ).toBe('decliningRate');
    expect(await issue({ decliningRate: '20' })).toBe('decliningRate');
    expect(
      await issue({ depreciationMethod: 'double_declining_balance', decliningRate: '20' }),
    ).toBe('decliningRate');
    expect(await issue({ depreciationMethod: 'sum_of_years' })).toBe('depreciationMethod');
    // The bounds themselves are accepted.
    const top = await register(o, {
      depreciationMethod: 'declining_balance',
      decliningRate: '100',
    });
    const low = await register(o, {
      depreciationMethod: 'declining_balance',
      decliningRate: '0.0001',
    });
    expect(top.id).not.toBe(low.id);
    expect((await o.owner.get('/fixed-assets/assets')).body.data.items).toHaveLength(2);
  });

  it('previews the schedule and its warnings without saving anything', async () => {
    const o = await assetOrg();
    const preview = (overrides: Record<string, unknown>) =>
      o.owner.post('/fixed-assets/assets/schedule-preview', {
        categoryId: o.categoryId,
        acquisitionDate: '2026-01-15',
        cost: '5000.00',
        salvageValue: '200.00',
        lifeMonths: 30,
        ...overrides,
      });
    const db = await preview({ depreciationMethod: 'declining_balance', decliningRate: '45.5' });
    expect(db.status, JSON.stringify(db.body)).toBe(200);
    expect(db.body.data).toMatchObject({ depreciationMethod: 'declining_balance', warnings: [] });
    expect(db.body.data.schedule).toHaveLength(30);
    expect(db.body.data.schedule.at(-1)).toMatchObject({ accumulated: '4800.00' });
    // 30% over 30 months: straight line already gives more in year 1, so it is straight line.
    const same = await preview({ depreciationMethod: 'declining_balance', decliningRate: '30' });
    expect(same.body.data.warnings).toEqual(['STRAIGHT_LINE_EQUIVALENT']);
    const nothing = await preview({
      depreciationMethod: 'double_declining_balance',
      salvageValue: '5000.00',
    });
    expect(nothing.body.data.warnings).toEqual(['NOTHING_TO_DEPRECIATE']);
    const plain = await preview({ salvageValue: '5000.00' });
    expect(plain.body.data).toMatchObject({ depreciationMethod: 'straight_line', warnings: [] });
    // The category's default life applies when none is given.
    expect((await preview({ lifeMonths: undefined })).body.data.lifeMonths).toBe(60);
    expect(
      (await preview({ depreciationMethod: 'declining_balance' })).body.error.details.issues[0]
        .path,
    ).toBe('decliningRate');
    // The same date and amount checks as registration.
    const issuePath = async (overrides: Record<string, unknown>) =>
      (await preview(overrides)).body.error.details.issues[0].path as string;
    expect(await issuePath({ acquisitionDate: '2026-02-30' })).toBe('acquisitionDate');
    expect(await issuePath({ inServiceDate: '2026-01-01' })).toBe('inServiceDate');
    expect(await issuePath({ cost: '100.123' })).toBe('cost');
    expect(await issuePath({ salvageValue: '6000.00' })).toBe('salvageValue');
    const register_ = (overrides: Record<string, unknown>) =>
      o.owner.post('/fixed-assets/assets', assetBody(o, overrides));
    expect(
      (await register_({ inServiceDate: '2026-01-01' })).body.error.details.issues[0].path,
    ).toBe('inServiceDate');
    expect(
      (await register_({ acquisitionDate: '2026-02-30' })).body.error.details.issues[0].path,
    ).toBe('acquisitionDate');
    // A warning never blocks registration.
    await register(o, {
      cost: '5000.00',
      salvageValue: '200.00',
      lifeMonths: 30,
      depreciationMethod: 'declining_balance',
      decliningRate: '30',
    });
    expect((await o.owner.get('/fixed-assets/assets')).body.data.items).toHaveLength(1);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (
        await member.client.post('/fixed-assets/assets/schedule-preview', {
          categoryId: o.categoryId,
          acquisitionDate: '2026-01-15',
          cost: '5000.00',
        })
      ).status,
    ).toBe(403);
  });

  it('keeps existing assets straight line and fixes the method once capitalized', async () => {
    const o = await assetOrg();
    const plain = await register(o);
    const detail = (await o.owner.get(`/fixed-assets/assets/${plain.id}`)).body.data;
    expect(detail).toMatchObject({ depreciationMethod: 'straight_line', decliningRate: null });
    expect(detail.schedule[0]).toMatchObject({ amount: '1000.00' });
    const db = await register(o, declining);
    await expect(
      owner.query(
        `UPDATE fixed_assets SET depreciation_method = 'double_declining_balance', declining_rate = NULL WHERE id = $1`,
        [db.id],
      ),
    ).rejects.toThrow(/fixed once capitalized/);
    await expect(
      owner.query(`UPDATE fixed_assets SET declining_rate = 20 WHERE id = $1`, [db.id]),
    ).rejects.toThrow(/fixed once capitalized/);
    await expect(
      owner.query(
        `UPDATE fixed_assets SET depreciation_method = 'declining_balance', declining_rate = 20 WHERE id = $1`,
        [plain.id],
      ),
    ).rejects.toThrow(/fixed once capitalized/);
    // The method is not among the descriptive fields an edit may change.
    const edit = await o.owner.patch(`/fixed-assets/assets/${plain.id}`, {
      version: plain.version,
      depreciationMethod: 'declining_balance',
    });
    expect(edit.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

describe('transfers', () => {
  it('re-classes an asset to another category, moving cost and accumulated depreciation', async () => {
    const o = await assetOrg();
    const asset = await register(o);
    await runDepreciation(o, '2026-03-31');
    const other = await o.owner.post('/fixed-assets/categories', {
      name: 'Boats',
      costAccountId: o.accounts['1140'],
      accumulatedAccountId: o.accounts['1150'],
      expenseAccountId: o.accounts['5400'],
      defaultLifeMonths: 120,
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const res = await o.owner.post(`/fixed-assets/assets/${asset.id}/transfer`, {
      version: 2,
      transferDate: '2026-04-05',
      toCategoryId: other.body.data.id,
      toLocation: 'Marina',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ categoryId: other.body.data.id, location: 'Marina' });
    expect(await glBalance(o.organizationId, o.accounts['1510']!)).toBe('0.00');
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('12000.00');
    expect(await glBalance(o.organizationId, o.accounts['1520']!)).toBe('0.00');
    expect(await glBalance(o.organizationId, o.accounts['1150']!)).toBe('-3000.00');
    // Depreciation now goes to the new category.
    const run = await runDepreciation(o, '2026-04-30');
    const journal = await journalOf(o, run.body.data.journalId);
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: o.accounts['5400'], debit: '1000.0000' }),
        expect.objectContaining({ accountId: o.accounts['1150'], credit: '1000.0000' }),
      ]),
    );
    const detail = (await o.owner.get(`/fixed-assets/assets/${asset.id}`)).body.data;
    expect(detail.transfers).toHaveLength(1);
    expect(detail.transfers[0].journalId).not.toBeNull();
  });

  it('moves only the location when the category stays, posting nothing', async () => {
    const o = await assetOrg();
    const asset = await register(o);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
      [o.organizationId],
    );
    const res = await o.owner.post(`/fixed-assets/assets/${asset.id}/transfer`, {
      version: 1,
      transferDate: '2026-02-01',
      toLocation: 'Head office',
    });
    expect(res.body.data.location).toBe('Head office');
    const after = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(after.rows[0].n).toBe(rows[0].n);
    const nothing = await o.owner.post(`/fixed-assets/assets/${asset.id}/transfer`, {
      version: 2,
      transferDate: '2026-02-02',
      toLocation: 'Head office',
    });
    expect(nothing.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Reports and security
// ---------------------------------------------------------------------------

describe('reports and security', () => {
  it('reconciles the register with the ledger and reads as of any date', async () => {
    const o = await assetOrg();
    await register(o);
    await register(o, {
      name: 'Generator',
      cost: '6000.00',
      lifeMonths: 24,
      acquisitionDate: '2026-02-10',
    });
    await runDepreciation(o, '2026-03-31');
    const register_ = (await o.owner.get('/fixed-assets/reports/register?asOf=2026-03-31')).body
      .data;
    expect(register_.totals).toMatchObject({
      cost: '18000.00',
      accumulatedDepreciation: '3500.00',
      bookValue: '14500.00',
    });
    const earlier = (await o.owner.get('/fixed-assets/reports/register?asOf=2026-01-31')).body.data;
    expect(earlier.totals).toMatchObject({ cost: '12000.00', accumulatedDepreciation: '0.00' });
    const reconciliation = (
      await o.owner.get('/fixed-assets/reports/reconciliation?asOf=2026-03-31')
    ).body.data;
    expect(reconciliation.accounts.map((a: { difference: string }) => a.difference)).toEqual([
      '0.00',
      '0.00',
    ]);
  });

  it('is permissioned and tenant-isolated', async () => {
    const a = await assetOrg();
    const b = await assetOrg();
    const asset = await register(a);
    expect((await b.owner.get(`/fixed-assets/assets/${asset.id}`)).status).toBe(404);
    expect(
      (
        await b.owner.post(`/fixed-assets/assets/${asset.id}/dispose`, {
          version: 1,
          disposalDate: '2026-07-10',
        })
      ).status,
    ).toBe(404);
    expect((await b.owner.get('/fixed-assets/assets')).body.data.items).toEqual([]);
    const member = await joinWithRole(ctx, a.owner, 'Member');
    expect((await member.client.get('/fixed-assets/assets')).status).toBe(200);
    expect((await member.client.get('/fixed-assets/reports/register?asOf=2026-03-31')).status).toBe(
      200,
    );
    expect((await member.client.post('/fixed-assets/assets', assetBody(a))).status).toBe(403);
    expect(
      (await member.client.post('/fixed-assets/depreciation/runs', { monthEnd: '2026-03-31' }))
        .status,
    ).toBe(403);
    expect(
      (
        await member.client.post(`/fixed-assets/assets/${asset.id}/dispose`, {
          version: 1,
          disposalDate: '2026-07-10',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await member.client.post('/fixed-assets/categories', {
          name: 'X',
          costAccountId: a.accounts['1510'],
          accumulatedAccountId: a.accounts['1520'],
          expenseAccountId: a.accounts['5500'],
          defaultLifeMonths: 12,
        })
      ).status,
    ).toBe(403);
    const client = await connectAs('app');
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      for (const table of ['fixed_assets', 'fixed_asset_categories', 'fixed_asset_entries']) {
        const { rows } = await client.query(`SELECT organization_id FROM ${table}`);
        expect(
          rows.every((r: { organization_id: string }) => r.organization_id === b.organizationId),
          table,
        ).toBe(true);
      }
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('keeps the asset ledger immutable and refuses a generic reversal of an asset journal', async () => {
    const o = await assetOrg();
    const asset = await register(o);
    const { rows } = await owner.query(`SELECT id FROM fixed_asset_entries WHERE asset_id = $1`, [
      asset.id,
    ]);
    await expect(
      owner.query(`UPDATE fixed_asset_entries SET cost_change = 1 WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.query(`DELETE FROM fixed_asset_entries WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/append-only/);
    const generic = await o.owner.post(
      `/accounting/journals/${asset.acquisitionJournalId}/reverse`,
      { reason: 'Reverse it' },
    );
    expect(generic.body.error.code).toBe('SYSTEM_JOURNAL');
  });
});
