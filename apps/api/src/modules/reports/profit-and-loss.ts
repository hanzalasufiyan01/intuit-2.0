import type { Decimal } from 'decimal.js';
import type { AccountSubtype, ReportAccount } from '../accounting/index.js';
import {
  check,
  d,
  fmt,
  integrityOf,
  isProfitAndLoss,
  natural,
  ZERO,
  type CurrencyView,
  type ExportRow,
  type ReportWarning,
} from './engine.js';
import {
  buildSections,
  sectionExportRows,
  sectionView,
  type SectionSpec,
  type StatementColumn,
} from './sections.js';

/**
 * Profit & Loss (S3-11). Sections follow each leaf's Decision 53 subtype (codes unchanged; the
 * labels are presentation only). Unclassified revenue/expense accounts (Decision 54) are never
 * guessed into a section: they get their own sections and a warning. Gross and operating profit
 * exclude them; net profit includes every revenue and expense account.
 */

export interface ProfitAndLossColumn extends StatementColumn {
  from: string;
  to: string;
}

export interface ProfitAndLossInput {
  columns: readonly ProfitAndLossColumn[];
  baseCurrency: string;
  includeZero: boolean;
  currencyView: CurrencyView;
  tagged: boolean;
}

const bySubtype =
  (type: 'REVENUE' | 'EXPENSE', subtype: AccountSubtype | null) => (a: ReportAccount) =>
    a.accountType === type && a.subtype === subtype;

export const PROFIT_AND_LOSS_SECTIONS: readonly SectionSpec[] = [
  {
    key: 'revenue',
    label: 'Revenue',
    includes: bySubtype('REVENUE', 'OPERATING_REVENUE'),
    alwaysShow: true,
  },
  {
    key: 'cost_of_goods_sold',
    label: 'Cost of Goods Sold',
    includes: bySubtype('EXPENSE', 'COST_OF_SALES'),
    alwaysShow: true,
  },
  {
    key: 'operating_expenses',
    label: 'Operating Expenses',
    includes: bySubtype('EXPENSE', 'OPERATING_EXPENSE'),
    alwaysShow: true,
  },
  {
    key: 'other_income',
    label: 'Other Income',
    includes: bySubtype('REVENUE', 'OTHER_INCOME'),
    alwaysShow: true,
  },
  {
    key: 'other_expenses',
    label: 'Other Expenses',
    includes: bySubtype('EXPENSE', 'OTHER_EXPENSE'),
    alwaysShow: true,
  },
  {
    key: 'unclassified_income',
    label: 'Unclassified Income',
    includes: bySubtype('REVENUE', null),
    alwaysShow: false,
  },
  {
    key: 'unclassified_expenses',
    label: 'Unclassified Expenses',
    includes: bySubtype('EXPENSE', null),
    alwaysShow: false,
  },
];

/** Natural-sign base movement of a P&L leaf within the column range. */
export const profitAndLossAmount = (a: ReportAccount) =>
  natural(a.accountType, d(a.balances.debitInRange).minus(d(a.balances.creditInRange)));

/** Net profit of a set of accounts (revenue minus expenses) over the queried range. */
export function netProfit(accounts: readonly ReportAccount[]): Decimal {
  return accounts
    .filter((a) => a.isLeaf && isProfitAndLoss(a.accountType))
    .reduce(
      (sum, a) =>
        a.accountType === 'REVENUE'
          ? sum.plus(profitAndLossAmount(a))
          : sum.minus(profitAndLossAmount(a)),
      ZERO,
    );
}

export function buildProfitAndLoss(input: ProfitAndLossInput) {
  const built = buildSections(PROFIT_AND_LOSS_SECTIONS, {
    columns: input.columns,
    baseCurrency: input.baseCurrency,
    includeZero: input.includeZero,
    currencyView: input.currencyView,
    leafAmount: profitAndLossAmount,
    leafTxnAmount: (a) => natural(a.accountType, d(a.balances.txnNetInRange)),
    drill: (a, i) => {
      const column = input.columns[i]!;
      return {
        kind: 'ledger',
        accountId: a.id,
        fromDate: column.from,
        toDate: column.to,
        openingBasis: 'fiscal_year',
      };
    },
  });
  const columnsCount = input.columns.length;
  const totalOf = (key: string) =>
    built.find((s) => s.spec.key === key)?.total ??
    Array.from({ length: columnsCount }, () => ZERO);
  const combine = (f: (i: number) => Decimal) =>
    Array.from({ length: columnsCount }, (_, i) => f(i));

  const revenue = totalOf('revenue');
  const cogs = totalOf('cost_of_goods_sold');
  const opex = totalOf('operating_expenses');
  const otherIncome = totalOf('other_income');
  const otherExpenses = totalOf('other_expenses');
  const unclassifiedIncome = totalOf('unclassified_income');
  const unclassifiedExpenses = totalOf('unclassified_expenses');
  const grossProfit = combine((i) => revenue[i]!.minus(cogs[i]!));
  const operatingProfit = combine((i) => grossProfit[i]!.minus(opex[i]!));
  const net = combine((i) =>
    operatingProfit[i]!.plus(otherIncome[i]!)
      .minus(otherExpenses[i]!)
      .plus(unclassifiedIncome[i]!)
      .minus(unclassifiedExpenses[i]!),
  );

  // Independent recomputation over every revenue/expense leaf (consistency, not balancing).
  const checks = input.columns.map((column, i) =>
    check(`${column.key}_net_profit_consistency`, net[i]!, netProfit(column.accounts)),
  );
  const warnings: ReportWarning[] = [];
  if (built.some((s) => s.spec.key.startsWith('unclassified_') && s.rows.length > 0)) {
    warnings.push({
      code: 'UNCLASSIFIED_ACCOUNTS',
      message:
        'Some revenue or expense accounts have no subtype. Gross and operating profit exclude them; net profit includes them. Classify them in the chart of accounts.',
    });
  }

  const sections = built.map(sectionView);
  const summary = {
    grossProfit: grossProfit.map(fmt),
    operatingProfit: operatingProfit.map(fmt),
    netProfit: net.map(fmt),
  };
  const columnKeys = input.columns.map((c) => c.key);
  const summaryValues = (amounts: string[]) =>
    Object.fromEntries(columnKeys.map((k, i) => [k, amounts[i] ?? null]));
  const exportRows: ExportRow[] = [
    ...sectionExportRows(sections, columnKeys),
    {
      rowType: 'total',
      section: null,
      level: 0,
      code: null,
      name: 'Gross Profit',
      values: summaryValues(summary.grossProfit),
    },
    {
      rowType: 'total',
      section: null,
      level: 0,
      code: null,
      name: 'Operating Profit',
      values: summaryValues(summary.operatingProfit),
    },
    {
      rowType: 'total',
      section: null,
      level: 0,
      code: null,
      name: 'Net Profit (Loss)',
      values: summaryValues(summary.netProfit),
    },
  ];
  return { sections, summary, integrity: integrityOf(checks), warnings, exportRows };
}
