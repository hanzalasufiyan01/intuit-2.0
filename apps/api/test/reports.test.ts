import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setDbContext } from '../src/application/unit-of-work.js';
import { readMigrationFiles } from '../src/database/migrator.js';
import { queryAccountBalances } from '../src/modules/accounting/index.js';
import {
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 3A S3 — financial statements (Decision 4; S3-01..S3-24) on real PostgreSQL.
 * FY2025 and FY2026 are calendar years; base currency MVR.
 */

let ctx: TestContext;
const origin = { requestId: null, ipAddress: null, userAgent: null };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function twoYearOrg(): Promise<AccountingOrg> {
  const org = await setUpAccountingOrg(ctx);
  const fy = await org.owner.post('/accounting/fiscal-years', {
    name: 'FY2025',
    startDate: '2025-01-01',
    endDate: '2025-12-31',
  });
  expect(fy.status, JSON.stringify(fy.body)).toBe(201);
  return org;
}

function journal(date: string, debit: string, credit: string, amount: string, extra: object = {}) {
  return {
    entryDate: date,
    description: `J ${date}`,
    currency: 'MVR',
    lines: [line(debit, 'debit', amount), line(credit, 'credit', amount)],
    ...extra,
  };
}

/** FY2025: revenue 1,000, rent 400. FY2026: revenue 300 (Feb) and a 100 dividend (Mar). */
async function standardOrg() {
  const org = await twoYearOrg();
  const a = org.accounts;
  await postJournal(org, journal('2025-03-10', a['1110']!, a['4100']!, '1000.00') as never);
  await postJournal(org, journal('2025-04-10', a['5300']!, a['1110']!, '400.00') as never);
  await postJournal(org, journal('2026-02-10', a['1110']!, a['4100']!, '300.00') as never);
  await postJournal(org, journal('2026-03-01', a['3200']!, a['1110']!, '100.00') as never);
  return org;
}

const get = (client: TestClient, path: string) => client.get(`/accounting/reports/${path}`);

type Row = { code: string | null; name: string; amounts?: string[]; [k: string]: unknown };
const flatRows = (report: { sections: { rows: Row[] }[] }) =>
  report.sections.flatMap((s) => s.rows);
const section = (
  report: { sections: { key: string; rows: Row[]; total: string[] }[] },
  key: string,
) => report.sections.find((s) => s.key === key)!;

describe('Balance Sheet (S3-06, S3-12)', () => {
  it('uses virtual year-end: Retained Earnings (with RE postings) + current-year earnings, balanced', async () => {
    const org = await standardOrg();
    const res = await get(org.owner, 'balance-sheet?asOf=2026-06-30');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bs = res.body.data;
    const equity = section(bs, 'equity');
    // The designated 3200 account is not listed again; its dividend is inside the RE line.
    expect(
      equity.rows.find((r) => r.code === '3200' && r.name !== 'Retained Earnings'),
    ).toBeUndefined();
    expect(equity.rows.find((r) => r.name === 'Retained Earnings')!.amounts).toEqual(['500.0000']);
    expect(equity.rows.find((r) => r.name === 'Current-Year Earnings')!.amounts).toEqual([
      '300.0000',
    ]);
    expect(section(bs, 'current_assets').total).toEqual(['800.0000']);
    expect(bs.totals).toMatchObject({
      totalAssets: ['800.0000'],
      totalLiabilities: ['0.0000'],
      totalEquity: ['800.0000'],
      totalLiabilitiesAndEquity: ['800.0000'],
    });
    expect(bs.integrity.status).toBe('BALANCED');
    expect(bs).toMatchObject({ taggedActivityOnly: false, baseCurrency: 'MVR' });
    expect(bs.exportRows.at(-1)).toMatchObject({
      rowType: 'total',
      values: { current: '800.0000' },
    });
  });

  it('compares with the previous year and the previous period', async () => {
    const org = await standardOrg();
    const prevYear = (await get(org.owner, 'balance-sheet?asOf=2026-06-30&compare=previous_year'))
      .body.data;
    expect(prevYear.columns.map((c: { asOf: string }) => c.asOf)).toEqual([
      '2026-06-30',
      '2025-06-30',
    ]);
    const equity = section(prevYear, 'equity');
    // At 2025-06-30 there are no prior years: RE 0, current-year earnings 600.
    expect(equity.rows.find((r) => r.name === 'Retained Earnings')!.amounts).toEqual([
      '500.0000',
      '0.0000',
    ]);
    expect(equity.rows.find((r) => r.name === 'Current-Year Earnings')!.amounts).toEqual([
      '300.0000',
      '600.0000',
    ]);
    expect(prevYear.integrity.status).toBe('BALANCED');

    const prevPeriod = (
      await get(org.owner, 'balance-sheet?asOf=2026-03-15&compare=previous_period')
    ).body.data;
    expect(prevPeriod.columns.map((c: { asOf: string }) => c.asOf)).toEqual([
      '2026-03-15',
      '2026-02-28',
    ]);
    const custom = await get(
      org.owner,
      'balance-sheet?asOf=2026-03-15&compare=custom&compareAsOf=2025-12-31',
    );
    expect(custom.body.data.columns[1].asOf).toBe('2025-12-31');
  });

  it('requires an as-of date inside a fiscal year and a valid Retained Earnings designation', async () => {
    const org = await standardOrg();
    const gap = await get(org.owner, 'balance-sheet?asOf=2027-01-15');
    expect(gap.status).toBe(409);
    expect(gap.body.error.code).toBe('FISCAL_YEAR_NOT_FOUND');
    expect(
      (await get(org.owner, 'balance-sheet?asOf=2026-06-30&compare=custom&compareAsOf=2024-06-30'))
        .status,
    ).toBe(409);

    await org.owner.put('/accounting/designations', { RETAINED_EARNINGS: null });
    const bs = await get(org.owner, 'balance-sheet?asOf=2026-06-30');
    expect(bs.status).toBe(409);
    expect(bs.body.error.code).toBe('DESIGNATION_REQUIRED');
    // P&L still works; the TB works with a warning and a computed prior-years row.
    expect((await get(org.owner, 'profit-and-loss?from=2026-01-01&to=2026-06-30')).status).toBe(
      200,
    );
    const tb = (await get(org.owner, 'trial-balance?from=2026-01-01&to=2026-06-30')).body.data;
    expect(tb.warnings.map((w: { code: string }) => w.code)).toContain(
      'RETAINED_EARNINGS_NOT_DESIGNATED',
    );
    expect(tb.rows.find((r: Row) => r.rowType === 'computed')).toMatchObject({
      openingCredit: '600.0000',
      drill: { kind: 'profit_and_loss', from: null, to: '2025-12-31' },
    });
    expect(tb.integrity.status).toBe('BALANCED');
  });
});

describe('Trial Balance (S3-08, S3-09)', () => {
  it('presents opening, movement and closing after the virtual year-end, balanced', async () => {
    const org = await standardOrg();
    const tb = (await get(org.owner, 'trial-balance?from=2026-01-01&to=2026-06-30')).body.data;
    const byCode = Object.fromEntries(tb.rows.map((r: Row) => [r.code, r]));
    expect(byCode['1110']).toMatchObject({
      openingDebit: '600.0000',
      periodDebit: '300.0000',
      periodCredit: '100.0000',
      closingDebit: '800.0000',
      netBalance: '800.0000',
    });
    expect(byCode['3200']).toMatchObject({
      openingCredit: '600.0000',
      periodDebit: '100.0000',
      closingCredit: '500.0000',
      includesPriorYearEarnings: true,
    });
    // P&L accounts restart at the fiscal-year start.
    expect(byCode['4100']).toMatchObject({ openingCredit: '0.0000', periodCredit: '300.0000' });
    expect(byCode['5300']).toBeUndefined(); // zero in FY2026: hidden
    expect(byCode['4000']).toMatchObject({ isLeaf: false, periodCredit: '300.0000' }); // parent roll-up
    expect(tb.totals).toMatchObject({
      openingDebit: '600.0000',
      openingCredit: '600.0000',
      closingDebit: '800.0000',
      closingCredit: '800.0000',
    });
    expect(tb.integrity.status).toBe('BALANCED');
    expect(tb.fiscalYear.name).toBe('FY2026');
  });

  it('uses the fiscal year to date for P&L openings mid-year and rejects cross-year ranges', async () => {
    const org = await standardOrg();
    const tb = (await get(org.owner, 'trial-balance?from=2026-03-01&to=2026-06-30')).body.data;
    const revenue = tb.rows.find((r: Row) => r.code === '4100');
    expect(revenue).toMatchObject({
      openingCredit: '300.0000',
      periodCredit: '0.0000',
      closingCredit: '300.0000',
    });
    expect(tb.integrity.status).toBe('BALANCED');
    const cross = await get(org.owner, 'trial-balance?from=2025-12-01&to=2026-01-31');
    expect(cross.status).toBe(409); // S3-07
    expect(cross.body.error.code).toBe('FISCAL_YEAR_NOT_FOUND');
    expect((await get(org.owner, 'trial-balance?from=2027-01-01&to=2027-01-31')).status).toBe(409);
    // Period filter and zero rows.
    const period = (
      await get(org.owner, `trial-balance?periodId=${org.periods[1]!.id}&includeZero=true`)
    ).body.data;
    expect(period).toMatchObject({ from: '2026-02-01', to: '2026-02-28', includeZero: true });
    expect(period.rows.length).toBeGreaterThan(30);
  });

  it('reconciles with the ledger on a fiscal-year opening basis (S3-19)', async () => {
    const org = await standardOrg();
    const tb = (await get(org.owner, 'trial-balance?from=2026-03-01&to=2026-06-30')).body.data;
    const row = tb.rows.find((r: Row) => r.code === '4100');
    expect(row.drill).toEqual({
      kind: 'ledger',
      accountId: org.accounts['4100'],
      fromDate: '2026-03-01',
      toDate: '2026-06-30',
      openingBasis: 'fiscal_year',
    });
    const fiscal = (
      await org.owner.get(
        `/accounting/ledger?accountId=${org.accounts['4100']}&fromDate=2026-03-01&toDate=2026-06-30&openingBasis=fiscal_year`,
      )
    ).body.data;
    expect(fiscal.openingBasis).toBe('fiscal_year');
    // Ledger opening is debit-positive: -300 = TB opening credit 300.
    expect(Number(fiscal.openingBalance)).toBe(-300);
    const cumulative = (
      await org.owner.get(
        `/accounting/ledger?accountId=${org.accounts['4100']}&fromDate=2026-03-01&toDate=2026-06-30`,
      )
    ).body.data;
    expect(Number(cumulative.openingBalance)).toBe(-1300);
    // Cash (balance-sheet account) movement reconciles with its ledger totals.
    const cashRow = tb.rows.find((r: Row) => r.code === '1110');
    const cashLedger = (
      await org.owner.get(
        `/accounting/ledger?accountId=${org.accounts['1110']}&fromDate=2026-03-01&toDate=2026-06-30`,
      )
    ).body.data;
    expect(Number(cashLedger.totals.baseCredit)).toBe(Number(cashRow.periodCredit));
    expect(Number(cashLedger.openingBalance)).toBe(Number(cashRow.openingDebit));
  });
});

describe('Profit & Loss (S3-11, S3-18)', () => {
  it('uses Decision 53 subtype sections, subtotals and section-partial parents', async () => {
    const org = await standardOrg();
    const pl = (await get(org.owner, 'profit-and-loss?fiscalYearId=' + (await fyId(org, 'FY2025'))))
      .body.data;
    expect(section(pl, 'revenue').total).toEqual(['1000.0000']);
    expect(section(pl, 'operating_expenses').total).toEqual(['400.0000']);
    expect(pl.summary).toEqual({
      grossProfit: ['1000.0000'],
      operatingProfit: ['600.0000'],
      netProfit: ['600.0000'],
    });
    const parent = section(pl, 'revenue').rows.find((r) => r.code === '4000');
    expect(parent).toMatchObject({ partial: true, amounts: ['1000.0000'] });
    expect(pl.sections.map((s: { key: string }) => s.key)).toEqual([
      'revenue',
      'cost_of_goods_sold',
      'operating_expenses',
      'other_income',
      'other_expenses',
    ]);
    // A range may span fiscal years.
    const span = (await get(org.owner, 'profit-and-loss?from=2025-01-01&to=2026-12-31')).body.data;
    expect(span.summary.netProfit).toEqual(['900.0000']);
  });

  it('compares previous period, previous year and a custom range', async () => {
    const org = await standardOrg();
    const prevYear = (
      await get(org.owner, 'profit-and-loss?from=2026-01-01&to=2026-12-31&compare=previous_year')
    ).body.data;
    expect(prevYear.columns.map((c: { from: string }) => c.from)).toEqual([
      '2026-01-01',
      '2025-01-01',
    ]);
    expect(prevYear.summary.netProfit).toEqual(['300.0000', '600.0000']);
    // Rent had no FY2026 activity but appears because of the comparison column.
    expect(
      section(prevYear, 'operating_expenses').rows.find((r) => r.code === '5300')!.amounts,
    ).toEqual(['0.0000', '400.0000']);
    const prevPeriod = (
      await get(org.owner, 'profit-and-loss?from=2026-02-01&to=2026-02-28&compare=previous_period')
    ).body.data;
    expect(prevPeriod.columns[1]).toMatchObject({ from: '2026-01-04', to: '2026-01-31' });
    const custom = (
      await get(
        org.owner,
        'profit-and-loss?from=2026-01-01&to=2026-12-31&compare=custom&compareFrom=2025-03-01&compareTo=2025-03-31',
      )
    ).body.data;
    expect(custom.summary.netProfit[1]).toBe('1000.0000');
    expect(
      (await get(org.owner, 'profit-and-loss?from=2026-01-01&to=2026-12-31&compareFrom=2025-01-01'))
        .status,
    ).toBe(400);
  });

  it('keeps unclassified accounts out of gross and operating profit, with a warning', async () => {
    const org = await twoYearOrg();
    const misc = await org.owner.post('/accounting/accounts', {
      code: '4990',
      name: 'Misc income',
      type: 'REVENUE',
    });
    await postJournal(
      org,
      journal('2026-02-01', org.accounts['1110']!, misc.body.data.id, '50.00') as never,
    );
    const pl = (await get(org.owner, 'profit-and-loss?from=2026-01-01&to=2026-12-31')).body.data;
    expect(section(pl, 'unclassified_income').total).toEqual(['50.0000']);
    expect(pl.summary).toMatchObject({ grossProfit: ['0.0000'], netProfit: ['50.0000'] });
    expect(pl.warnings.map((w: { code: string }) => w.code)).toEqual(['UNCLASSIFIED_ACCOUNTS']);
  });

  it('places reversals in the fiscal year of their own date', async () => {
    const org = await twoYearOrg();
    const posted = await postJournal(
      org,
      journal('2025-12-20', org.accounts['5300']!, org.accounts['1110']!, '50.00') as never,
    );
    const reversed = await org.owner.post(`/accounting/journals/${posted.id}/reverse`, {
      reason: 'wrong year',
      reversalDate: '2026-01-05',
    });
    expect(reversed.status).toBe(200);
    const fy25 = (await get(org.owner, 'profit-and-loss?from=2025-01-01&to=2025-12-31')).body.data;
    const fy26 = (await get(org.owner, 'profit-and-loss?from=2026-01-01&to=2026-12-31')).body.data;
    expect(fy25.summary.netProfit).toEqual(['-50.0000']);
    expect(fy26.summary.netProfit).toEqual(['50.0000']);
    expect(
      (await get(org.owner, 'trial-balance?from=2026-01-01&to=2026-12-31')).body.data.integrity
        .status,
    ).toBe('BALANCED');
  });
});

async function fyId(org: AccountingOrg, name: string) {
  const years = (await org.owner.get('/accounting/fiscal-years')).body.data as {
    id: string;
    name: string;
  }[];
  return years.find((y) => y.name === name)!.id;
}

describe('currency presentation (S3-15, S3-22)', () => {
  it('reports base amounts; account-currency columns exclude base-only revaluation lines', async () => {
    const org = await twoYearOrg();
    const usd = (
      await org.owner.post('/accounting/accounts', {
        code: '1126',
        name: 'USD bank',
        type: 'ASSET',
        subtype: 'BANK',
        currencyCode: 'USD',
        parentId: org.accounts['1100'],
      })
    ).body.data.id as string;
    await postJournal(org, {
      entryDate: '2026-02-01',
      description: 'USD capital',
      currency: 'USD',
      exchangeRate: '15.42',
      lines: [line(usd, 'debit', '100.00'), line(org.accounts['3100']!, 'credit', '100.00')],
    } as never);
    // Three-line journal whose per-line conversion needs the approved rounding adjustment.
    await postJournal(org, {
      entryDate: '2026-02-02',
      description: 'USD split',
      currency: 'USD',
      exchangeRate: '15.4237',
      lines: [
        line(usd, 'debit', '33.33'),
        line(usd, 'debit', '33.33'),
        line(usd, 'debit', '33.34'),
        line(org.accounts['3100']!, 'credit', '100.00'),
      ],
    } as never);
    await inTransaction(ctx.database.db, { organizationId: org.organizationId }, async (tx) => {
      await setDbContext(tx, { organizationId: org.organizationId });
      await ctx.services.journals.postSystemJournal(
        tx,
        {
          organizationId: org.organizationId,
          userId: null,
          source: { module: 'accounting', type: 'revaluation', id: randomUUID() },
          entryDate: '2026-03-31',
          description: 'Revaluation',
          reference: '',
          currency: 'MVR',
          exchangeRate: null,
          lines: [
            {
              accountId: usd,
              description: '',
              kind: 'base_only',
              debit: null,
              credit: null,
              baseDebit: '12.35',
              baseCredit: null,
            },
            {
              accountId: org.accounts['4960']!,
              description: '',
              kind: 'base_only',
              debit: null,
              credit: null,
              baseDebit: null,
              baseCredit: '12.35',
            },
          ],
        },
        origin,
      );
    });
    const bs = (await get(org.owner, 'balance-sheet?asOf=2026-06-30&currencyView=base_and_account'))
      .body.data;
    const bank = section(bs, 'current_assets').rows.find((r) => r.code === '1126')!;
    // 1542.00 + 1542.37 (per-line rounded, reconciled to the journal total) + 12.35 revaluation.
    expect(bank.amounts).toEqual(['3096.7200']);
    expect(bank.accountCurrency).toEqual({ code: 'USD', amounts: ['200.0000'] });
    // Parents never roll up foreign amounts.
    expect(
      section(bs, 'current_assets').rows.find((r) => r.code === '1100')!.accountCurrency,
    ).toBeNull();
    expect(bs.integrity.status).toBe('BALANCED');
    const pl = (await get(org.owner, 'profit-and-loss?from=2026-01-01&to=2026-12-31')).body.data;
    expect(section(pl, 'other_income').rows.find((r) => r.code === '4960')!.amounts).toEqual([
      '12.3500',
    ]);
    const tb = (
      await get(
        org.owner,
        'trial-balance?from=2026-01-01&to=2026-06-30&currencyView=base_and_account',
      )
    ).body.data;
    expect(tb.rows.find((r: Row) => r.code === '1126').accountCurrency).toMatchObject({
      closing: '200.0000',
    });
    expect(tb.integrity.status).toBe('BALANCED');
  });
});

describe('dimension filters (S3-03, S3-16)', () => {
  async function tagged() {
    const org = await twoYearOrg();
    const type = (
      await org.owner.post('/accounting/dimensions', { code: 'DEPT', name: 'Department' })
    ).body.data;
    const sales = (
      await org.owner.post(`/accounting/dimensions/${type.id}/values`, { code: 'S', name: 'Sales' })
    ).body.data.id as string;
    const ops = (
      await org.owner.post(`/accounting/dimensions/${type.id}/values`, { code: 'O', name: 'Ops' })
    ).body.data.id as string;
    await postJournal(org, {
      entryDate: '2026-02-01',
      description: 'tagged',
      currency: 'MVR',
      lines: [
        line(org.accounts['1110']!, 'debit', '30.00'),
        {
          ...line(org.accounts['4100']!, 'credit', '30.00'),
          dimensions: [{ dimensionTypeId: type.id, dimensionValueId: sales }],
        },
      ],
    } as never);
    await postJournal(
      org,
      journal('2026-02-02', org.accounts['1110']!, org.accounts['4100']!, '5.00') as never,
    );
    return { org, sales, ops };
  }

  it('reports tagged activity only, with balancing checks not applicable', async () => {
    const { org, sales } = await tagged();
    const pl = (
      await get(
        org.owner,
        `profit-and-loss?from=2026-01-01&to=2026-12-31&dimensionValueIds=${sales}`,
      )
    ).body.data;
    expect(pl).toMatchObject({ taggedActivityOnly: true, summary: { netProfit: ['30.0000'] } });
    expect(pl.dimensionFilter).toEqual([
      expect.objectContaining({ typeName: 'Department', valueName: 'Sales' }),
    ]);
    const bs = (await get(org.owner, `balance-sheet?asOf=2026-06-30&dimensionValueIds=${sales}`))
      .body.data;
    expect(bs.taggedActivityOnly).toBe(true);
    expect(bs.integrity.status).toBe('NOT_APPLICABLE');
    // Current-year earnings use the same tagged P&L activity.
    expect(
      section(bs, 'equity').rows.find((r) => r.name === 'Current-Year Earnings')!.amounts,
    ).toEqual(['30.0000']);
    const tb = (
      await get(org.owner, `trial-balance?from=2026-01-01&to=2026-06-30&dimensionValueIds=${sales}`)
    ).body.data;
    expect(tb.integrity.status).toBe('NOT_APPLICABLE');
    // Unfiltered: all activity, balanced.
    const all = (await get(org.owner, 'balance-sheet?asOf=2026-06-30')).body.data;
    expect(all).toMatchObject({ taggedActivityOnly: false, integrity: { status: 'BALANCED' } });
  });

  it('requires dimensions.view, one value per type and values of the organization', async () => {
    const { org, sales, ops } = await tagged();
    await org.owner.post('/organizations/current/roles', {
      name: 'Report reader',
      permissionKeys: ['accounting.reports.view'],
    });
    const reader = (await joinWithRole(ctx, org.owner, 'Report reader')).client;
    for (const path of [
      `profit-and-loss?dimensionValueIds=${sales}`,
      `balance-sheet?dimensionValueIds=${sales}`,
      `trial-balance?dimensionValueIds=${sales}`,
    ]) {
      const denied = await get(reader, path);
      expect(denied.status, path).toBe(403);
      expect(JSON.stringify(denied.body)).not.toContain('Sales');
    }
    expect((await get(reader, 'profit-and-loss')).status).toBe(200);
    expect((await get(org.owner, `profit-and-loss?dimensionValueIds=${sales},${ops}`)).status).toBe(
      400,
    );
    const other = await tagged();
    expect((await get(org.owner, `profit-and-loss?dimensionValueIds=${other.sales}`)).status).toBe(
      400,
    );
  });
});

describe('accounts in reports (S3-14, S3-24)', () => {
  it('shows archived accounts with balances (flagged), hides zero rows unless requested', async () => {
    const org = await twoYearOrg();
    await postJournal(
      org,
      journal('2026-02-01', org.accounts['1150']!, org.accounts['1110']!, '20.00') as never,
    );
    await org.owner.post(`/accounting/accounts/${org.accounts['1150']}/archive`);
    const bs = (await get(org.owner, 'balance-sheet?asOf=2026-06-30')).body.data;
    const prepaid = flatRows(bs).find((r) => r.code === '1150')!;
    expect(prepaid).toMatchObject({ archived: true, amounts: ['20.0000'] });
    expect(flatRows(bs).find((r) => r.code === '1140')).toBeUndefined();
    const withZero = (await get(org.owner, 'balance-sheet?asOf=2026-06-30&includeZero=true')).body
      .data;
    expect(flatRows(withZero).find((r) => r.code === '1140')).toMatchObject({
      amounts: ['0.0000'],
    });
    // Cash is negative (overdrawn): shown with its natural sign, not reclassified.
    expect(flatRows(bs).find((r) => r.code === '1110')!.amounts).toEqual(['-20.0000']);
  });

  it('includes opening-balance system journals and closed periods', async () => {
    const org = await twoYearOrg();
    await inTransaction(ctx.database.db, { organizationId: org.organizationId }, async (tx) => {
      await setDbContext(tx, { organizationId: org.organizationId });
      await ctx.services.journals.postSystemJournal(
        tx,
        {
          organizationId: org.organizationId,
          userId: null,
          source: { module: 'accounting', type: 'opening_balance', id: randomUUID() },
          entryDate: '2026-01-01',
          description: 'Opening',
          reference: '',
          currency: 'MVR',
          exchangeRate: null,
          lines: [
            {
              accountId: org.accounts['1110']!,
              description: '',
              kind: 'normal',
              debit: '75.00',
              credit: null,
              baseDebit: null,
              baseCredit: null,
            },
            {
              accountId: org.accounts['3900']!,
              description: '',
              kind: 'normal',
              debit: null,
              credit: '75.00',
              baseDebit: null,
              baseCredit: null,
            },
          ],
        },
        origin,
      );
    });
    expect((await org.owner.post(`/accounting/periods/${org.periods[0]!.id}/close`)).status).toBe(
      200,
    );
    const bs = (await get(org.owner, 'balance-sheet?asOf=2026-01-31')).body.data;
    expect(section(bs, 'equity').rows.find((r) => r.code === '3900')!.amounts).toEqual(['75.0000']);
    expect(bs.integrity.status).toBe('BALANCED');
  });
});

describe('report API contract and security', () => {
  it('requires accounting.reports.view; Member has it; strict query validation', async () => {
    const org = await standardOrg();
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await get(member.client, 'trial-balance')).status).toBe(200);
    await org.owner.post('/organizations/current/roles', {
      name: 'Ledger only',
      permissionKeys: ['accounting.ledger.view'],
    });
    const ledgerOnly = (await joinWithRole(ctx, org.owner, 'Ledger only')).client;
    for (const path of ['trial-balance', 'profit-and-loss', 'balance-sheet']) {
      expect((await get(ledgerOnly, path)).status, path).toBe(403);
    }
    expect((await get(org.owner, 'profit-and-loss?format=csv')).status).toBe(400);
    expect(
      (await get(org.owner, 'profit-and-loss?from=2026-02-01&periodId=' + org.periods[0]!.id))
        .status,
    ).toBe(400);
    expect((await get(org.owner, 'profit-and-loss?from=2026-03-01&to=2026-02-01')).status).toBe(
      400,
    );
  });

  it('isolates tenants: no cross-organization figures, periods or fiscal years', async () => {
    const a = await standardOrg();
    const b = await twoYearOrg();
    await postJournal(
      b,
      journal('2026-02-01', b.accounts['1110']!, b.accounts['4100']!, '777.00') as never,
    );
    const aPl = (await get(a.owner, 'profit-and-loss?from=2026-01-01&to=2026-12-31')).body.data;
    expect(aPl.summary.netProfit).toEqual(['300.0000']);
    // The other tenant's amount as rendered; a bare '777' can also occur in a random UUID.
    expect(JSON.stringify(aPl)).not.toContain('777.0000');
    expect((await get(a.owner, `trial-balance?periodId=${b.periods[0]!.id}`)).status).toBe(400);
    expect(
      (await get(a.owner, `balance-sheet?fiscalYearId=${await fyId(b, 'FY2026')}`)).status,
    ).toBe(400);
  });
});

describe('aggregation layer security and ledger opening basis', () => {
  it('row-level security hides another organization even if its id is passed to the aggregation', async () => {
    const a = await standardOrg();
    const b = await standardOrg();
    const rows = await inTransaction(ctx.database.db, { organizationId: a.organizationId }, (tx) =>
      queryAccountBalances(tx, {
        organizationId: b.organizationId,
        fiscalYearStart: '2026-01-01',
        from: '2026-01-01',
        to: '2026-12-31',
        dimensionValueIds: null,
      }),
    );
    expect(rows).toEqual([]);
  });

  it('keeps balance-sheet accounts cumulative and needs a fiscal year for the fiscal-year basis', async () => {
    const org = await standardOrg();
    const cash = (
      await org.owner.get(
        `/accounting/ledger?accountId=${org.accounts['1110']}&fromDate=2026-03-01&toDate=2026-06-30&openingBasis=fiscal_year`,
      )
    ).body.data;
    expect(cash.openingBasis).toBe('cumulative');
    expect(Number(cash.openingBalance)).toBe(900);
    const outside = await org.owner.get(
      `/accounting/ledger?accountId=${org.accounts['4100']}&fromDate=2027-03-01&toDate=2027-06-30&openingBasis=fiscal_year`,
    );
    expect(outside.status).toBe(409);
    expect(outside.body.error.code).toBe('FISCAL_YEAR_NOT_FOUND');
  });
});

describe('reports permission backfill (S3-02, migration 0009)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    owner = await connectAs('owner');
  });
  afterAll(async () => {
    await owner.end();
  });

  it('adds accounting.reports.view to Owner, Administrator and Member additively and audited', async () => {
    const sqlText = readMigrationFiles().find(
      (m) => m.version === '0009_reports_permission_backfill',
    )!.sql;
    const client = ctx.client();
    const orgId = (await client.register()).session.activeOrganization.id;
    await client.post('/organizations/current/roles', {
      name: 'Custom',
      permissionKeys: ['accounting.ledger.view'],
    });
    await owner.query('BEGIN');
    try {
      await owner.query(
        `DELETE FROM role_permissions WHERE organization_id = $1 AND permission_key = 'accounting.reports.view'`,
        [orgId],
      );
      await owner.query(sqlText);
      await owner.query('DROP TABLE s3_reports_backfill_grants, s3_reports_backfilled');
      await owner.query(sqlText);
      const { rows } = await owner.query(
        `SELECT r.name, bool_or(rp.permission_key = 'accounting.reports.view') AS has_reports,
                array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.organization_id = $1 GROUP BY r.name`,
        [orgId],
      );
      const byRole = Object.fromEntries(rows.map((r) => [r.name, r]));
      expect(byRole.Owner.has_reports).toBe(true);
      expect(byRole.Administrator.has_reports).toBe(true);
      expect(byRole.Member.has_reports).toBe(true);
      expect(byRole.Custom.keys).toEqual(['accounting.ledger.view']);
      const audit = await owner.query(
        `SELECT metadata->>'roleName' AS role FROM audit_events
          WHERE organization_id = $1 AND request_id = 'migration:0009_reports_permission_backfill'`,
        [orgId],
      );
      expect(audit.rows.map((r) => r.role).sort()).toEqual(['Administrator', 'Member', 'Owner']);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
