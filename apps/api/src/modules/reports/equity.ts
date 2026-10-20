import type { Decimal } from 'decimal.js';
import type { ReportAccount } from '../accounting/index.js';
import { check, d, fmt, integrityOf, isProfitAndLoss, ZERO, type ReportWarning } from './engine.js';

/**
 * Statement of Changes in Equity (master context section 16; ADR 0012). Pure: the input is the
 * accounting module's aggregated balances for one range.
 *
 * Columns are the equity accounts with any balance or movement, plus one virtual column for
 * accumulated earnings. The ledger has no year-end closing entries (the Balance Sheet derives
 * retained earnings virtually), so earnings of every period before `from` are the opening of that
 * column and the profit of the range is its movement. Equity is credit-positive.
 *
 * The closing total must equal assets less liabilities at the end of the range (the accounting
 * equation); the integrity check proves that on the data and is not applicable to tagged
 * (dimension-filtered) activity.
 */

export interface EquityInput {
  accounts: readonly ReportAccount[];
  baseCurrency: string;
  includeZero: boolean;
  tagged: boolean;
}

export interface EquityColumn {
  key: string;
  label: string;
  accountId: string | null;
  opening: string;
  /** Profit for the range (earnings column only). */
  profit: string;
  /** Contributions, drawings and every other posting to the equity account. */
  otherMovements: string;
  closing: string;
}

const net = (a: ReportAccount) => d(a.balances.debitInRange).minus(a.balances.creditInRange);
const before = (a: ReportAccount) => d(a.balances.netBeforeFrom);

export function buildEquity(input: EquityInput) {
  const warnings: ReportWarning[] = [];
  let earningsOpening: Decimal = ZERO;
  let profit: Decimal = ZERO;
  let assets: Decimal = ZERO;
  let liabilities: Decimal = ZERO;
  for (const a of input.accounts) {
    if (isProfitAndLoss(a.accountType)) {
      earningsOpening = earningsOpening.minus(before(a));
      profit = profit.minus(net(a));
    } else if (a.accountType === 'ASSET') {
      assets = assets.plus(before(a)).plus(net(a));
    } else if (a.accountType === 'LIABILITY') {
      liabilities = liabilities.minus(before(a)).minus(net(a));
    }
  }

  const columns: EquityColumn[] = [];
  for (const a of input.accounts) {
    if (a.accountType !== 'EQUITY') continue;
    const opening = before(a).negated();
    const other = net(a).negated();
    if (opening.isZero() && other.isZero() && !input.includeZero) continue;
    columns.push({
      key: a.id,
      label: `${a.code} ${a.name}`,
      accountId: a.id,
      opening: fmt(opening),
      profit: fmt(ZERO),
      otherMovements: fmt(other),
      closing: fmt(opening.plus(other)),
    });
  }
  columns.sort((a, b) => a.label.localeCompare(b.label));
  columns.push({
    key: 'accumulated_earnings',
    label: 'Accumulated earnings (profit not yet closed to equity)',
    accountId: null,
    opening: fmt(earningsOpening),
    profit: fmt(profit),
    otherMovements: fmt(ZERO),
    closing: fmt(earningsOpening.plus(profit)),
  });

  const sum = (pick: (c: EquityColumn) => string) =>
    columns.reduce((total, c) => total.plus(pick(c)), ZERO);
  const totals = {
    opening: fmt(sum((c) => c.opening)),
    profit: fmt(sum((c) => c.profit)),
    otherMovements: fmt(sum((c) => c.otherMovements)),
    closing: fmt(sum((c) => c.closing)),
  };
  const closingEquity = d(totals.closing);
  const integrity = integrityOf([
    check('Closing equity = assets − liabilities', closingEquity, assets.minus(liabilities), {
      notApplicable: input.tagged,
    }),
  ]);
  if (
    input.accounts.some(
      (a) => (a.accountType === 'ASSET' || a.accountType === 'LIABILITY') && a.subtype === null,
    )
  ) {
    warnings.push({
      code: 'UNCLASSIFIED_ACCOUNTS',
      message: 'Some asset or liability accounts are unclassified; the totals still include them.',
    });
  }

  return {
    columns,
    totals,
    assets: fmt(assets),
    liabilities: fmt(liabilities),
    warnings,
    integrity,
    rows: [
      { name: 'Opening balance', ...pickRow(columns, totals.opening, 'opening') },
      { name: 'Profit for the period', ...pickRow(columns, totals.profit, 'profit') },
      {
        name: 'Contributions, drawings and other movements',
        ...pickRow(columns, totals.otherMovements, 'otherMovements'),
      },
      { name: 'Closing balance', ...pickRow(columns, totals.closing, 'closing') },
    ],
  };
}

function pickRow(
  columns: readonly EquityColumn[],
  total: string,
  field: 'opening' | 'profit' | 'otherMovements' | 'closing',
) {
  return {
    values: Object.fromEntries(columns.map((c) => [c.key, c[field]])) as Record<string, string>,
    total,
  };
}
