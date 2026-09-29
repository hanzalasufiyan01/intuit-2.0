import type { Decimal } from 'decimal.js';
import type { AccountSubtype, AccountType, ReportAccount } from '../accounting/index.js';
import {
  check,
  d,
  fmt,
  integrityOf,
  isProfitAndLoss,
  natural,
  ZERO,
  type CurrencyView,
  type Drill,
  type ExportRow,
  type ReportWarning,
} from './engine.js';
import { netProfit } from './profit-and-loss.js';
import {
  buildSections,
  sectionExportRows,
  sectionView,
  type SectionSpec,
  type StatementColumn,
  type StatementRow,
  type StatementSection,
} from './sections.js';
import { dayBefore } from './trial-balance.js';

/**
 * Balance Sheet (S3-12) as of a date inside a fiscal year, with the virtual year-end (S3-06):
 *  - Retained earnings = the designated Retained Earnings account + the net of all P&L activity
 *    dated before the fiscal-year start (one line; the account is not listed again);
 *  - Current-year earnings = P&L net from the fiscal-year start to the as-of date.
 * Each column is queried with from = fiscal-year start and to = as-of date, so balance-sheet
 * accounts close at netBeforeFrom + range movement.
 */

export interface BalanceSheetColumn extends StatementColumn {
  asOf: string;
  fiscalYearStart: string;
}

export interface BalanceSheetInput {
  columns: readonly BalanceSheetColumn[];
  retainedEarningsAccountId: string;
  baseCurrency: string;
  includeZero: boolean;
  currencyView: CurrencyView;
  tagged: boolean;
}

const closingNet = (a: ReportAccount) =>
  d(a.balances.netBeforeFrom).plus(d(a.balances.debitInRange)).minus(d(a.balances.creditInRange));
const closingTxn = (a: ReportAccount) =>
  d(a.balances.txnNetBeforeFrom).plus(d(a.balances.txnNetInRange));

const of =
  (type: AccountType, subtypes: readonly (AccountSubtype | null)[]) => (a: ReportAccount) =>
    a.accountType === type && subtypes.includes(a.subtype);

export function balanceSheetSections(retainedEarningsAccountId: string): SectionSpec[] {
  return [
    {
      key: 'current_assets',
      label: 'Current Assets',
      includes: of('ASSET', ['BANK', 'CASH', 'ACCOUNTS_RECEIVABLE', 'OTHER_CURRENT_ASSET']),
      alwaysShow: true,
    },
    {
      key: 'non_current_assets',
      label: 'Non-Current Assets',
      includes: of('ASSET', ['FIXED_ASSET', 'OTHER_ASSET']),
      alwaysShow: true,
    },
    {
      key: 'unclassified_assets',
      label: 'Unclassified Assets',
      includes: of('ASSET', [null]),
      alwaysShow: false,
    },
    {
      key: 'current_liabilities',
      label: 'Current Liabilities',
      includes: of('LIABILITY', ['ACCOUNTS_PAYABLE', 'CREDIT_CARD', 'OTHER_CURRENT_LIABILITY']),
      alwaysShow: true,
    },
    {
      key: 'non_current_liabilities',
      label: 'Non-Current Liabilities',
      includes: of('LIABILITY', ['LONG_TERM_LIABILITY']),
      alwaysShow: true,
    },
    {
      key: 'unclassified_liabilities',
      label: 'Unclassified Liabilities',
      includes: of('LIABILITY', [null]),
      alwaysShow: false,
    },
    {
      key: 'equity',
      label: 'Equity',
      includes: (a) => a.accountType === 'EQUITY' && a.id !== retainedEarningsAccountId,
      alwaysShow: true,
    },
  ];
}

const ASSET_SECTIONS = ['current_assets', 'non_current_assets', 'unclassified_assets'];
const LIABILITY_SECTIONS = [
  'current_liabilities',
  'non_current_liabilities',
  'unclassified_liabilities',
];

export function buildBalanceSheet(input: BalanceSheetInput) {
  const built = buildSections(balanceSheetSections(input.retainedEarningsAccountId), {
    columns: input.columns,
    baseCurrency: input.baseCurrency,
    includeZero: input.includeZero,
    currencyView: input.currencyView,
    leafAmount: (a) => natural(a.accountType, closingNet(a)),
    leafTxnAmount: (a) => natural(a.accountType, closingTxn(a)),
    drill: (a, i): Drill => ({
      kind: 'ledger',
      accountId: a.id,
      fromDate: null,
      toDate: input.columns[i]!.asOf,
      openingBasis: 'cumulative',
    }),
  });
  const sections: StatementSection[] = built.map(sectionView);

  // Virtual year-end lines (credit-positive equity amounts).
  const reAccount = (column: BalanceSheetColumn) =>
    column.accounts.find((a) => a.id === input.retainedEarningsAccountId);
  const priorYearsNet = (column: BalanceSheetColumn) =>
    column.accounts
      .filter((a) => a.isLeaf && isProfitAndLoss(a.accountType))
      .reduce((sum, a) => sum.plus(d(a.balances.netBeforeFrom)), ZERO);
  const retainedEarnings = input.columns.map((column) => {
    const re = reAccount(column);
    return (re ? natural('EQUITY', closingNet(re)) : ZERO).plus(priorYearsNet(column).negated());
  });
  const currentYearEarnings = input.columns.map((column) => netProfit(column.accounts));
  const reRef = input.columns[0]!.accounts.find((a) => a.id === input.retainedEarningsAccountId);
  const computedRows: StatementRow[] = [
    {
      rowType: 'computed',
      key: 'equity:retained_earnings',
      accountId: input.retainedEarningsAccountId,
      code: reRef?.code ?? null,
      name: 'Retained Earnings',
      accountType: 'EQUITY',
      subtype: reRef?.subtype ?? null,
      level: 0,
      isLeaf: true,
      archived: false,
      partial: false,
      amounts: retainedEarnings.map(fmt),
      accountCurrency: null,
      drills: input.columns.map((c) => ({
        kind: 'profit_and_loss',
        from: null,
        to: dayBefore(c.fiscalYearStart),
      })),
    },
    {
      rowType: 'computed',
      key: 'equity:current_year_earnings',
      accountId: null,
      code: null,
      name: 'Current-Year Earnings',
      accountType: 'EQUITY',
      subtype: null,
      level: 0,
      isLeaf: true,
      archived: false,
      partial: false,
      amounts: currentYearEarnings.map(fmt),
      accountCurrency: null,
      drills: input.columns.map((c) => ({
        kind: 'profit_and_loss',
        from: c.fiscalYearStart,
        to: c.asOf,
      })),
    },
  ];
  const equity = sections.find((s) => s.key === 'equity')!;
  equity.rows.push(...computedRows);
  const equityTotals = built
    .find((s) => s.spec.key === 'equity')!
    .total.map((t, i) => t.plus(retainedEarnings[i]!).plus(currentYearEarnings[i]!));
  equity.total = equityTotals.map(fmt);

  const sumSections = (keys: string[]) =>
    input.columns.map((_, i) =>
      built
        .filter((s) => keys.includes(s.spec.key))
        .reduce((acc, s) => acc.plus(s.total[i]!), ZERO as Decimal),
    );
  const totalAssets = sumSections(ASSET_SECTIONS);
  const totalLiabilities = sumSections(LIABILITY_SECTIONS);
  const liabilitiesAndEquity = totalLiabilities.map((l, i) => l.plus(equityTotals[i]!));

  const checks = input.columns.flatMap((column, i) => [
    check(
      `${column.key}_assets_equal_liabilities_plus_equity`,
      totalAssets[i]!,
      liabilitiesAndEquity[i]!,
      {
        notApplicable: input.tagged,
      },
    ),
    // Current-year earnings must equal the P&L net profit for fiscal-year start..as-of.
    check(
      `${column.key}_current_year_earnings_equal_profit`,
      currentYearEarnings[i]!,
      netProfitBySections(column),
    ),
  ]);

  const warnings: ReportWarning[] = [];
  if (built.some((s) => s.spec.key.startsWith('unclassified_') && s.rows.length > 0)) {
    warnings.push({
      code: 'UNCLASSIFIED_ACCOUNTS',
      message:
        'Some asset or liability accounts have no subtype, so they cannot be split into current and non-current. Classify them in the chart of accounts.',
    });
  }

  const totals = {
    totalAssets: totalAssets.map(fmt),
    totalLiabilities: totalLiabilities.map(fmt),
    totalEquity: equityTotals.map(fmt),
    totalLiabilitiesAndEquity: liabilitiesAndEquity.map(fmt),
  };
  const columnKeys = input.columns.map((c) => c.key);
  const values = (amounts: string[]) =>
    Object.fromEntries(columnKeys.map((k, i) => [k, amounts[i] ?? null]));
  const exportRows: ExportRow[] = [
    ...sectionExportRows(sections, columnKeys),
    {
      rowType: 'total',
      section: null,
      level: 0,
      code: null,
      name: 'Total Assets',
      values: values(totals.totalAssets),
    },
    {
      rowType: 'total',
      section: null,
      level: 0,
      code: null,
      name: 'Total Liabilities',
      values: values(totals.totalLiabilities),
    },
    {
      rowType: 'total',
      section: null,
      level: 0,
      code: null,
      name: 'Total Equity',
      values: values(totals.totalEquity),
    },
    {
      rowType: 'total',
      section: null,
      level: 0,
      code: null,
      name: 'Total Liabilities and Equity',
      values: values(totals.totalLiabilitiesAndEquity),
    },
  ];
  return { sections, totals, integrity: integrityOf(checks), warnings, exportRows };
}

/** P&L net for the column range computed through the P&L sections' natural signs. */
function netProfitBySections(column: BalanceSheetColumn): Decimal {
  return column.accounts
    .filter((a) => a.isLeaf && isProfitAndLoss(a.accountType))
    .reduce((sum, a) => {
      const movement = d(a.balances.debitInRange).minus(d(a.balances.creditInRange));
      return sum.minus(movement);
    }, ZERO);
}
