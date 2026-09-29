import { describe, expect, it } from 'vitest';
import type { AccountBalances, ReportAccount } from '../src/modules/accounting/index.js';
import {
  buildBalanceSheet,
  buildChart,
  buildProfitAndLoss,
  buildTrialBalance,
  natural,
  pruneAndRollUp,
} from '../src/modules/reports/index.js';
import { decimal } from '../src/domain/money.js';

/** Pure reporting engine (S3-04): no database. */

const zero: AccountBalances = {
  netBeforeFiscalYear: '0',
  netFiscalYearBeforeFrom: '0',
  netBeforeFrom: '0',
  debitInRange: '0',
  creditInRange: '0',
  txnNetBeforeFrom: '0',
  txnNetFiscalYearBeforeFrom: '0',
  txnNetInRange: '0',
};

function account(
  id: string,
  code: string,
  type: ReportAccount['accountType'],
  subtype: ReportAccount['subtype'],
  balances: Partial<AccountBalances> = {},
  extra: Partial<ReportAccount> = {},
): ReportAccount {
  return {
    id,
    code,
    name: code,
    accountType: type,
    subtype,
    parentId: null,
    status: 'ACTIVE',
    currencyCode: 'MVR',
    isLeaf: true,
    balances: { ...zero, ...balances },
    ...extra,
  };
}

describe('natural sign (S3-10)', () => {
  it('shows assets/expenses debit-positive and the others credit-positive, contra stays negative', () => {
    expect(natural('ASSET', decimal(5)).toFixed()).toBe('5');
    expect(natural('EXPENSE', decimal(5)).toFixed()).toBe('5');
    expect(natural('LIABILITY', decimal(-5)).toFixed()).toBe('5');
    expect(natural('EQUITY', decimal(-5)).toFixed()).toBe('5');
    expect(natural('REVENUE', decimal(-5)).toFixed()).toBe('5');
    // Accumulated depreciation (credit balance on an asset) stays negative.
    expect(natural('ASSET', decimal(-3)).toFixed()).toBe('-3');
  });
});

describe('hierarchy roll-up (S3-24)', () => {
  it('rolls selected leaves up to parents, flags section-partial parents and prunes empty branches', () => {
    const parent = account('p', '4000', 'REVENUE', null, {}, { isLeaf: false });
    const sales = account('s', '4100', 'REVENUE', 'OPERATING_REVENUE', {}, { parentId: 'p' });
    const other = account('o', '4900', 'REVENUE', 'OTHER_INCOME', {}, { parentId: 'p' });
    const lonely = account('x', '4800', 'REVENUE', 'OPERATING_REVENUE');
    const values: Record<string, number> = { s: 7, o: 3, x: 0 };
    const rows = pruneAndRollUp(
      buildChart([parent, sales, other, lonely]),
      new Set(['s']),
      (a) => values[a.id]!,
      (a, b) => a + b,
    );
    expect(rows.map((r) => [r.node.account.code, r.value, r.partial])).toEqual([
      ['4000', 7, true],
      ['4100', 7, false],
    ]);
  });
});

describe('section-partial flag', () => {
  it('ignores hidden zero siblings of the same section; flags only other-section descendants', () => {
    const parent = account('p', '1100', 'ASSET', null, {}, { isLeaf: false });
    const cash = account('c', '1110', 'ASSET', 'CASH', {}, { parentId: 'p' });
    const prepaid = account('pp', '1150', 'ASSET', 'OTHER_CURRENT_ASSET', {}, { parentId: 'p' });
    const rows = pruneAndRollUp(
      buildChart([parent, cash, prepaid]),
      new Set(['c']), // prepaid is hidden (zero) but in the same section
      () => 1,
      (a, b) => a + b,
      new Set(['c', 'pp']),
    );
    expect(rows.map((r) => [r.node.account.code, r.partial])).toEqual([
      ['1100', false],
      ['1110', false],
    ]);
  });
});

describe('trial balance composition', () => {
  it('folds prior-year earnings into Retained Earnings and balances', () => {
    const accounts = [
      account('cash', '1110', 'ASSET', 'CASH', { netBeforeFrom: '600', debitInRange: '300' }),
      account('re', '3200', 'EQUITY', 'EQUITY'),
      account('rev', '4100', 'REVENUE', 'OPERATING_REVENUE', {
        netBeforeFiscalYear: '-1000',
        netBeforeFrom: '-1000',
        creditInRange: '300',
      }),
      account('exp', '5300', 'EXPENSE', 'OPERATING_EXPENSE', {
        netBeforeFiscalYear: '400',
        netBeforeFrom: '400',
      }),
    ];
    const tb = buildTrialBalance({
      from: '2026-01-01',
      to: '2026-06-30',
      fiscalYearStart: '2026-01-01',
      accounts,
      retainedEarningsAccountId: 're',
      baseCurrency: 'MVR',
      includeZero: false,
      currencyView: 'base',
      tagged: false,
    });
    const byCode = Object.fromEntries(tb.rows.map((r) => [r.code, r]));
    expect(byCode['3200']).toMatchObject({
      openingCredit: '600.0000',
      includesPriorYearEarnings: true,
    });
    expect(byCode['4100']).toMatchObject({ openingCredit: '0.0000', periodCredit: '300.0000' });
    expect(byCode['5300']).toBeUndefined(); // zero this year: hidden
    expect(tb.integrity.status).toBe('BALANCED');
    expect(tb.totals).toMatchObject({ closingDebit: '900.0000', closingCredit: '900.0000' });
  });

  it('reports OUT_OF_BALANCE (never auto-corrects) when figures do not balance — fault injection', () => {
    const tb = buildTrialBalance({
      from: '2026-01-01',
      to: '2026-01-31',
      fiscalYearStart: '2026-01-01',
      accounts: [account('cash', '1110', 'ASSET', 'CASH', { debitInRange: '10' })],
      retainedEarningsAccountId: null,
      baseCurrency: 'MVR',
      includeZero: false,
      currencyView: 'base',
      tagged: false,
    });
    expect(tb.integrity.status).toBe('OUT_OF_BALANCE');
    expect(tb.integrity.checks.find((c) => c.name === 'period_debits_equal_credits')).toMatchObject(
      {
        status: 'FAIL',
        difference: '10.0000',
      },
    );
    expect(tb.rows[0]).toMatchObject({ periodDebit: '10.0000' }); // data shown unchanged
  });

  it('marks balancing checks NOT_APPLICABLE for tagged activity (S3-16)', () => {
    const tb = buildTrialBalance({
      from: '2026-01-01',
      to: '2026-01-31',
      fiscalYearStart: '2026-01-01',
      accounts: [account('cash', '1110', 'ASSET', 'CASH', { debitInRange: '10' })],
      retainedEarningsAccountId: null,
      baseCurrency: 'MVR',
      includeZero: false,
      currencyView: 'base',
      tagged: true,
    });
    expect(tb.integrity.status).toBe('NOT_APPLICABLE');
  });
});

describe('profit and loss composition (S3-11)', () => {
  it('builds Decision 53 sections, subtotals and an unclassified section without guessing', () => {
    const accounts = [
      account('rev', '4100', 'REVENUE', 'OPERATING_REVENUE', { creditInRange: '1000' }),
      account('cogs', '5100', 'EXPENSE', 'COST_OF_SALES', { debitInRange: '300' }),
      account('opex', '5300', 'EXPENSE', 'OPERATING_EXPENSE', { debitInRange: '200' }),
      account('oi', '4950', 'REVENUE', 'OTHER_INCOME', { creditInRange: '50' }),
      account('oe', '5950', 'EXPENSE', 'OTHER_EXPENSE', { debitInRange: '20' }),
      account('uc', '4990', 'REVENUE', null, { creditInRange: '10' }),
    ];
    const pl = buildProfitAndLoss({
      columns: [{ key: 'current', label: 'c', from: '2026-01-01', to: '2026-12-31', accounts }],
      baseCurrency: 'MVR',
      includeZero: false,
      currencyView: 'base',
      tagged: false,
    });
    expect(pl.sections.map((s) => [s.key, s.total[0]])).toEqual([
      ['revenue', '1000.0000'],
      ['cost_of_goods_sold', '300.0000'],
      ['operating_expenses', '200.0000'],
      ['other_income', '50.0000'],
      ['other_expenses', '20.0000'],
      ['unclassified_income', '10.0000'],
    ]);
    expect(pl.summary).toEqual({
      grossProfit: ['700.0000'],
      operatingProfit: ['500.0000'],
      netProfit: ['540.0000'],
    });
    expect(pl.warnings.map((w) => w.code)).toEqual(['UNCLASSIFIED_ACCOUNTS']);
    expect(pl.integrity.status).toBe('BALANCED');
  });
});

describe('balance sheet composition (S3-12)', () => {
  it('shows one Retained Earnings line and current-year earnings, and balances', () => {
    const accounts = [
      account('cash', '1110', 'ASSET', 'CASH', {
        netBeforeFrom: '600',
        debitInRange: '300',
        creditInRange: '100',
      }),
      account('re', '3200', 'EQUITY', 'EQUITY', { debitInRange: '100' }),
      account('rev', '4100', 'REVENUE', 'OPERATING_REVENUE', {
        netBeforeFrom: '-1000',
        creditInRange: '300',
      }),
      account('exp', '5300', 'EXPENSE', 'OPERATING_EXPENSE', { netBeforeFrom: '400' }),
    ];
    const bs = buildBalanceSheet({
      columns: [
        { key: 'current', label: 'c', asOf: '2026-06-30', fiscalYearStart: '2026-01-01', accounts },
      ],
      retainedEarningsAccountId: 're',
      baseCurrency: 'MVR',
      includeZero: false,
      currencyView: 'base',
      tagged: false,
    });
    const equity = bs.sections.find((s) => s.key === 'equity')!;
    expect(equity.rows.map((r) => [r.name, r.amounts[0]])).toEqual([
      ['Retained Earnings', '500.0000'],
      ['Current-Year Earnings', '300.0000'],
    ]);
    expect(bs.totals).toMatchObject({
      totalAssets: ['800.0000'],
      totalLiabilitiesAndEquity: ['800.0000'],
    });
    expect(bs.integrity.status).toBe('BALANCED');
  });
});
