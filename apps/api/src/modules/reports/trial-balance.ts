import type { Decimal } from 'decimal.js';
import type { AccountSubtype, AccountType, ReportAccount } from '../accounting/index.js';
import {
  buildChart,
  check,
  d,
  fmt,
  integrityOf,
  isProfitAndLoss,
  pruneAndRollUp,
  ZERO,
  type CurrencyView,
  type Drill,
  type ExportRow,
  type Integrity,
  type ReportWarning,
} from './engine.js';

/**
 * Trial Balance (S3-08, S3-09) after the virtual year-end (Decision 18, S3-06), over a range
 * inside one fiscal year:
 *  - opening: balance-sheet accounts use all history before `from`; profit-and-loss accounts
 *    use the fiscal year from its start to the day before `from`; the net of all P&L activity
 *    before the fiscal-year start is folded into the designated Retained Earnings account (or
 *    shown as a computed row when none is designated, S3-13);
 *  - period debit/credit: gross movements within [from, to];
 *  - opening and closing are net, presented one-sided by sign.
 */

export interface TrialBalanceInput {
  from: string;
  to: string;
  fiscalYearStart: string;
  accounts: readonly ReportAccount[];
  retainedEarningsAccountId: string | null;
  baseCurrency: string;
  includeZero: boolean;
  currencyView: CurrencyView;
  tagged: boolean;
}

export interface TrialBalanceRow {
  rowType: 'account' | 'computed';
  key: string;
  accountId: string | null;
  code: string | null;
  name: string;
  accountType: AccountType | null;
  subtype: AccountSubtype | null;
  level: number;
  isLeaf: boolean;
  archived: boolean;
  includesPriorYearEarnings: boolean;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
  netBalance: string;
  /** Account-currency nets (normal lines only) for foreign-currency leaves (S3-15). */
  accountCurrency: { code: string; opening: string; movement: string; closing: string } | null;
  drill: Drill | null;
}

interface Figures {
  opening: Decimal;
  debit: Decimal;
  credit: Decimal;
}

const add = (a: Figures, b: Figures): Figures => ({
  opening: a.opening.plus(b.opening),
  debit: a.debit.plus(b.debit),
  credit: a.credit.plus(b.credit),
});

const debitSide = (net: Decimal) => (net.gt(0) ? net : ZERO);
const creditSide = (net: Decimal) => (net.lt(0) ? net.negated() : ZERO);

export function buildTrialBalance(input: TrialBalanceInput) {
  const priorYears = input.accounts
    .filter((a) => a.isLeaf && isProfitAndLoss(a.accountType))
    .reduce((sum, a) => sum.plus(d(a.balances.netBeforeFiscalYear)), ZERO);
  const re = input.retainedEarningsAccountId
    ? input.accounts.find((a) => a.id === input.retainedEarningsAccountId && a.isLeaf)
    : undefined;

  const leafFigures = (a: ReportAccount): Figures => {
    const opening = isProfitAndLoss(a.accountType)
      ? d(a.balances.netFiscalYearBeforeFrom)
      : d(a.balances.netBeforeFrom);
    return {
      opening: a.id === re?.id ? opening.plus(priorYears) : opening,
      debit: d(a.balances.debitInRange),
      credit: d(a.balances.creditInRange),
    };
  };
  const leaves = input.accounts.filter((a) => a.isLeaf);
  const visible = new Set(
    leaves
      .filter((a) => {
        if (input.includeZero) return true;
        const f = leafFigures(a);
        return !f.opening.isZero() || !f.debit.isZero() || !f.credit.isZero();
      })
      .map((a) => a.id),
  );

  const rows: TrialBalanceRow[] = pruneAndRollUp(
    buildChart(input.accounts),
    visible,
    leafFigures,
    add,
  ).map(({ node, value }) => {
    const a = node.account;
    const closing = value.opening.plus(value.debit).minus(value.credit);
    const pl = isProfitAndLoss(a.accountType);
    const foreign =
      input.currencyView === 'base_and_account' &&
      a.isLeaf &&
      a.currencyCode !== input.baseCurrency;
    const txnOpening = d(pl ? a.balances.txnNetFiscalYearBeforeFrom : a.balances.txnNetBeforeFrom);
    const txnMovement = d(a.balances.txnNetInRange);
    return {
      rowType: 'account',
      key: a.id,
      accountId: a.id,
      code: a.code,
      name: a.name,
      accountType: a.accountType,
      subtype: a.subtype,
      level: node.depth,
      isLeaf: a.isLeaf,
      archived: a.status === 'ARCHIVED',
      includesPriorYearEarnings: a.id === re?.id && !priorYears.isZero(),
      openingDebit: fmt(debitSide(value.opening)),
      openingCredit: fmt(creditSide(value.opening)),
      periodDebit: fmt(value.debit),
      periodCredit: fmt(value.credit),
      closingDebit: fmt(debitSide(closing)),
      closingCredit: fmt(creditSide(closing)),
      netBalance: fmt(closing),
      accountCurrency: foreign
        ? {
            code: a.currencyCode,
            opening: fmt(txnOpening),
            movement: fmt(txnMovement),
            closing: fmt(txnOpening.plus(txnMovement)),
          }
        : null,
      drill: {
        kind: 'ledger',
        accountId: a.id,
        fromDate: input.from,
        toDate: input.to,
        openingBasis: pl ? 'fiscal_year' : 'cumulative',
      },
    };
  });

  const warnings: ReportWarning[] = [];
  let computedLeaf: Figures | null = null;
  if (!re) {
    warnings.push({
      code: 'RETAINED_EARNINGS_NOT_DESIGNATED',
      message:
        'No Retained Earnings account is designated. Prior-year earnings are shown as a computed row instead of being included in an account.',
    });
    if (!priorYears.isZero() || input.includeZero) {
      computedLeaf = { opening: priorYears, debit: ZERO, credit: ZERO };
      rows.push({
        rowType: 'computed',
        key: 'retained_earnings_prior_years',
        accountId: null,
        code: null,
        name: 'Retained earnings (prior years, computed)',
        accountType: 'EQUITY',
        subtype: null,
        level: 0,
        isLeaf: true,
        archived: false,
        includesPriorYearEarnings: true,
        openingDebit: fmt(debitSide(priorYears)),
        openingCredit: fmt(creditSide(priorYears)),
        periodDebit: fmt(ZERO),
        periodCredit: fmt(ZERO),
        closingDebit: fmt(debitSide(priorYears)),
        closingCredit: fmt(creditSide(priorYears)),
        netBalance: fmt(priorYears),
        accountCurrency: null,
        drill: { kind: 'profit_and_loss', from: null, to: dayBefore(input.fiscalYearStart) },
      });
    }
  }

  // Totals come from leaves (and the computed row) only, never from parent subtotals.
  const leafTotals = leaves
    .filter((a) => visible.has(a.id))
    .map(leafFigures)
    .concat(computedLeaf ? [computedLeaf] : []);
  const sum = (pick: (f: Figures) => Decimal) =>
    leafTotals.reduce((acc, f) => acc.plus(pick(f)), ZERO);
  const totals = {
    openingDebit: sum((f) => debitSide(f.opening)),
    openingCredit: sum((f) => creditSide(f.opening)),
    periodDebit: sum((f) => f.debit),
    periodCredit: sum((f) => f.credit),
    closingDebit: sum((f) => debitSide(f.opening.plus(f.debit).minus(f.credit))),
    closingCredit: sum((f) => creditSide(f.opening.plus(f.debit).minus(f.credit))),
  };
  const na = { notApplicable: input.tagged };
  const integrity: Integrity = integrityOf([
    check('opening_debits_equal_credits', totals.openingDebit, totals.openingCredit, na),
    check('period_debits_equal_credits', totals.periodDebit, totals.periodCredit, na),
    check('closing_debits_equal_credits', totals.closingDebit, totals.closingCredit, na),
  ]);
  const unclassified = leaves.filter((a) => visible.has(a.id) && a.subtype === null).length;
  if (unclassified > 0) {
    warnings.push({
      code: 'UNCLASSIFIED_ACCOUNTS',
      message: `${unclassified} account(s) with balances have no subtype (Decision 54).`,
    });
  }

  const fixedTotals = Object.fromEntries(
    Object.entries(totals).map(([k, v]) => [k, fmt(v)]),
  ) as Record<keyof typeof totals, string>;
  const exportRows: ExportRow[] = [
    ...rows.map((r) => ({
      rowType: r.rowType,
      section: null,
      level: r.level,
      code: r.code,
      name: r.name,
      values: {
        openingDebit: r.openingDebit,
        openingCredit: r.openingCredit,
        periodDebit: r.periodDebit,
        periodCredit: r.periodCredit,
        closingDebit: r.closingDebit,
        closingCredit: r.closingCredit,
      },
    })),
    {
      rowType: 'total' as const,
      section: null,
      level: 0,
      code: null,
      name: 'Total',
      values: fixedTotals,
    },
  ];
  return { rows, totals: fixedTotals, integrity, warnings, exportRows };
}

export function dayBefore(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
