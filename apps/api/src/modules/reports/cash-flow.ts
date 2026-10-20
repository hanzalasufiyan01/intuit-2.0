import type { Decimal } from 'decimal.js';
import type { ReportAccount } from '../accounting/index.js';
import { check, d, fmt, integrityOf, isProfitAndLoss, ZERO, type ReportWarning } from './engine.js';

/**
 * Statement of Cash Flows, indirect method (master context section 16; ADR 0012). Pure: the input
 * is the accounting module's aggregated balances for one range.
 *
 * Cash is every account with subtype BANK or CASH. Everything else is classified by the account's
 * Decision 53 subtype (the safe, reversible default; nothing is guessed from names):
 *
 *   Operating  net profit, accumulated depreciation of fixed-asset categories (add-back), accounts
 *              receivable, other current assets, accounts payable, credit cards, other current
 *              liabilities
 *   Investing  fixed assets (cost), other (non-current) assets
 *   Financing  long-term liabilities, equity
 *
 * An account without a subtype is never guessed: it is placed with the working capital of its
 * nature (assets and liabilities) or financing (equity) and reported in a warning, and cash
 * accounts that are not classified as Bank/Cash cannot be recognised as cash.
 *
 * The three sections add up to the change in cash by construction (every journal balances, so
 * the movements of all accounts sum to zero); the integrity check proves that on the data.
 */

export interface CashFlowInput {
  accounts: readonly ReportAccount[];
  /** Accumulated-depreciation accounts of the fixed-asset categories (shown as an add-back). */
  depreciationAccountIds: ReadonlySet<string>;
  baseCurrency: string;
  includeZero: boolean;
  tagged: boolean;
}

export interface CashFlowLine {
  accountId: string;
  code: string;
  name: string;
  /** The effect on cash: positive is an inflow. */
  amount: string;
}

export interface CashFlowGroup {
  key: string;
  label: string;
  lines: CashFlowLine[];
  total: string;
}

export interface CashFlowSection {
  key: 'operating' | 'investing' | 'financing';
  label: string;
  groups: CashFlowGroup[];
  total: string;
}

const net = (a: ReportAccount) => d(a.balances.debitInRange).minus(a.balances.creditInRange);

type Bucket = {
  section: 'operating' | 'investing' | 'financing';
  group: string;
  label: string;
};

const WORKING_CAPITAL: Record<string, Bucket> = {
  ACCOUNTS_RECEIVABLE: { section: 'operating', group: 'receivables', label: 'Accounts receivable' },
  OTHER_CURRENT_ASSET: {
    section: 'operating',
    group: 'other_current_assets',
    label: 'Other current assets',
  },
  ACCOUNTS_PAYABLE: { section: 'operating', group: 'payables', label: 'Accounts payable' },
  CREDIT_CARD: { section: 'operating', group: 'credit_cards', label: 'Credit cards' },
  OTHER_CURRENT_LIABILITY: {
    section: 'operating',
    group: 'other_current_liabilities',
    label: 'Other current liabilities',
  },
  FIXED_ASSET: { section: 'investing', group: 'fixed_assets', label: 'Fixed assets' },
  OTHER_ASSET: { section: 'investing', group: 'other_assets', label: 'Other non-current assets' },
  LONG_TERM_LIABILITY: {
    section: 'financing',
    group: 'long_term_liabilities',
    label: 'Long-term liabilities',
  },
  EQUITY: { section: 'financing', group: 'equity', label: 'Equity' },
};

/** Where an account without a usable subtype goes (never guessed beyond its nature). */
function fallback(account: ReportAccount): Bucket {
  if (account.accountType === 'EQUITY') return WORKING_CAPITAL.EQUITY!;
  if (account.accountType === 'ASSET') {
    return {
      section: 'operating',
      group: 'unclassified_assets',
      label: 'Unclassified assets',
    };
  }
  return {
    section: 'operating',
    group: 'unclassified_liabilities',
    label: 'Unclassified liabilities',
  };
}

const SECTION_LABELS = {
  operating: 'Cash flows from operating activities',
  investing: 'Cash flows from investing activities',
  financing: 'Cash flows from financing activities',
} as const;

export function buildCashFlow(input: CashFlowInput) {
  const warnings: ReportWarning[] = [];
  const cashAccounts = input.accounts.filter(
    (a) => a.accountType === 'ASSET' && (a.subtype === 'BANK' || a.subtype === 'CASH'),
  );
  if (cashAccounts.length === 0) {
    warnings.push({
      code: 'NO_CASH_ACCOUNTS',
      message:
        'No account is classified as Bank or Cash, so no cash is recognised. Classify the bank and cash accounts (Chart of accounts) to see cash flows.',
    });
  }

  let netIncome: Decimal = ZERO;
  for (const a of input.accounts) {
    if (isProfitAndLoss(a.accountType)) netIncome = netIncome.minus(net(a));
  }

  const groups = new Map<string, CashFlowGroup & { sum: Decimal; section: Bucket['section'] }>();
  const unclassified: string[] = [];
  for (const a of input.accounts) {
    if (isProfitAndLoss(a.accountType)) continue;
    if (cashAccounts.includes(a)) continue;
    const movement = net(a);
    let bucket: Bucket;
    if (input.depreciationAccountIds.has(a.id)) {
      bucket = {
        section: 'operating',
        group: 'depreciation',
        label: 'Depreciation and amortization (non-cash)',
      };
    } else if (a.subtype && WORKING_CAPITAL[a.subtype]) {
      bucket = WORKING_CAPITAL[a.subtype]!;
    } else {
      bucket = fallback(a);
      if (!movement.isZero()) unclassified.push(`${a.code} ${a.name}`);
    }
    if (movement.isZero() && !input.includeZero) continue;
    const effect = movement.negated(); // more assets use cash; more liabilities/equity provide it
    const key = `${bucket.section}:${bucket.group}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key: bucket.group,
        label: bucket.label,
        lines: [],
        total: fmt(ZERO),
        sum: ZERO,
        section: bucket.section,
      };
      groups.set(key, group);
    }
    group.lines.push({ accountId: a.id, code: a.code, name: a.name, amount: fmt(effect) });
    group.sum = group.sum.plus(effect);
  }
  if (unclassified.length > 0) {
    warnings.push({
      code: 'UNCLASSIFIED_ACCOUNTS',
      message: `Accounts without a subtype were placed by nature, not guessed further: ${unclassified.join(', ')}.`,
    });
  }

  const order = ['operating', 'investing', 'financing'] as const;
  const sections: CashFlowSection[] = order.map((key) => {
    const own = [...groups.values()]
      .filter((g) => g.section === key)
      .sort((a, b) => a.label.localeCompare(b.label));
    const total = own.reduce((sum, g) => sum.plus(g.sum), key === 'operating' ? netIncome : ZERO);
    return {
      key,
      label: SECTION_LABELS[key],
      groups: own.map((g) => ({
        key: g.key,
        label: g.label,
        lines: g.lines.sort((a, b) => a.code.localeCompare(b.code)),
        total: fmt(g.sum),
      })),
      total: fmt(total),
    };
  });

  const opening = cashAccounts.reduce((sum, a) => sum.plus(a.balances.netBeforeFrom), ZERO);
  const movement = cashAccounts.reduce((sum, a) => sum.plus(net(a)), ZERO);
  const sectionTotal = sections.reduce((sum, s) => sum.plus(s.total), ZERO);
  const integrity = integrityOf([
    check('Operating + investing + financing = change in cash', sectionTotal, movement, {
      notApplicable: input.tagged,
    }),
    check('Opening cash + change = closing cash', opening.plus(movement), opening.plus(movement), {
      notApplicable: input.tagged,
    }),
  ]);

  return {
    netIncome: fmt(netIncome),
    sections,
    cash: {
      opening: fmt(opening),
      netChange: fmt(movement),
      closing: fmt(opening.plus(movement)),
      accounts: cashAccounts
        .map((a) => ({
          accountId: a.id,
          code: a.code,
          name: a.name,
          opening: fmt(d(a.balances.netBeforeFrom)),
          closing: fmt(d(a.balances.netBeforeFrom).plus(net(a))),
        }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    },
    warnings,
    integrity,
    rows: cashFlowRows(netIncome, sections, opening, movement),
  };
}

/** Flat rows for the UI and future exports. */
function cashFlowRows(
  netIncome: Decimal,
  sections: readonly CashFlowSection[],
  opening: Decimal,
  movement: Decimal,
) {
  const rows: {
    rowType: 'section' | 'account' | 'subtotal' | 'total' | 'computed';
    section: string | null;
    level: number;
    code: string | null;
    name: string;
    values: Record<string, string | null>;
  }[] = [];
  for (const section of sections) {
    rows.push({
      rowType: 'section',
      section: section.key,
      level: 0,
      code: null,
      name: section.label,
      values: { amount: null },
    });
    if (section.key === 'operating') {
      rows.push({
        rowType: 'computed',
        section: section.key,
        level: 1,
        code: null,
        name: 'Net profit',
        values: { amount: fmt(netIncome) },
      });
    }
    for (const group of section.groups) {
      rows.push({
        rowType: 'subtotal',
        section: section.key,
        level: 1,
        code: null,
        name: group.label,
        values: { amount: group.total },
      });
      for (const line of group.lines) {
        rows.push({
          rowType: 'account',
          section: section.key,
          level: 2,
          code: line.code,
          name: line.name,
          values: { amount: line.amount },
        });
      }
    }
    rows.push({
      rowType: 'total',
      section: section.key,
      level: 0,
      code: null,
      name: `Net cash from ${section.key} activities`,
      values: { amount: section.total },
    });
  }
  rows.push(
    {
      rowType: 'total',
      section: null,
      level: 0,
      code: null,
      name: 'Net change in cash',
      values: { amount: fmt(movement) },
    },
    {
      rowType: 'computed',
      section: null,
      level: 0,
      code: null,
      name: 'Opening cash',
      values: { amount: fmt(opening) },
    },
    {
      rowType: 'total',
      section: null,
      level: 0,
      code: null,
      name: 'Closing cash',
      values: { amount: fmt(opening.plus(movement)) },
    },
  );
  return rows;
}
