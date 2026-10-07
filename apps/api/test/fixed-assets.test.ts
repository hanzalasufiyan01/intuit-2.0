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
