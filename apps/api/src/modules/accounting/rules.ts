import type { Decimal } from 'decimal.js';
import type { AccountSubtype, AccountType } from './schema.js';
import {
  convertLinesToBase,
  decimal,
  isSupportedCurrency,
  parseAmount,
  toFixedString,
  type ConvertedLine,
} from '../../domain/money.js';

/** Pure double-entry rules for journals. No database access. */

export interface JournalLineInput {
  accountId: string | null;
  description: string;
  debit: string | null;
  credit: string | null;
}

export interface RuleIssue {
  path: string;
  message: string;
}

export interface AccountFacts {
  id: string;
  status: 'ACTIVE' | 'ARCHIVED';
  isLeaf: boolean;
  currencyCode?: string;
  isMonetary?: boolean;
  isControlAccount?: boolean;
  accountType?: AccountType;
  subtype?: AccountSubtype | null;
}

/**
 * Posting context for the Phase 3 account rules. Without it only the Phase 2 rules apply.
 * - Account currency (Decision 11): a line posts to an account in the journal currency or the
 *   base currency; a foreign-currency account accepts only its own currency.
 * - Control accounts (C3) are rejected in manual journals.
 */
export interface PostingContext {
  baseCurrency: string;
  manual: boolean;
}

/** Account-currency and control-account issues for one line's account. */
export function accountRuleIssue(
  account: AccountFacts,
  journalCurrency: string,
  context: PostingContext,
): string | null {
  if (context.manual && account.isControlAccount) {
    return 'Control accounts cannot be used in manual journals; they are maintained through their subledger.';
  }
  if (
    account.currencyCode !== undefined &&
    account.currencyCode !== journalCurrency &&
    account.currencyCode !== context.baseCurrency
  ) {
    return `This account is in ${account.currencyCode}; lines may post only to accounts in the journal currency (${journalCurrency}) or the base currency (${context.baseCurrency}).`;
  }
  return null;
}

/**
 * Validates line amounts while drafting: formats and currency precision are always
 * enforced, but drafts may be incomplete (missing accounts, one line, unbalanced).
 */
export function validateDraftLines(
  lines: readonly JournalLineInput[],
  currency: string,
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (!isSupportedCurrency(currency)) {
    issues.push({ path: 'currency', message: `Unsupported currency ${currency}.` });
    return issues;
  }
  lines.forEach((line, i) => {
    if (line.debit !== null && line.credit !== null) {
      issues.push({
        path: `lines.${i}`,
        message: 'A line has either a debit or a credit, never both.',
      });
    }
    for (const side of ['debit', 'credit'] as const) {
      const value = line[side];
      if (value === null) continue;
      const parsed = parseAmount(value, currency);
      if (!parsed.ok) {
        issues.push({
          path: `lines.${i}.${side}`,
          message:
            parsed.problem === 'not_positive'
              ? 'Amounts must be positive.'
              : parsed.problem === 'too_many_decimals'
                ? `${currency} amounts allow at most the currency's minor-unit decimals.`
                : 'Amounts must be decimal strings, e.g. "125.50".',
        });
      }
    }
  });
  return issues;
}

export interface PostableLine {
  lineNumber: number;
  accountId: string;
  side: 'debit' | 'credit';
  amount: Decimal;
}

/**
 * Full double-entry validation for submission and posting:
 * >= 2 lines, each line has an account and exactly one positive amount, all accounts
 * active leaf accounts of the organization, and total debits = total credits.
 */
export function validatePostableJournal(
  input: {
    currency: string;
    entryDate: string | null;
    lines: readonly (JournalLineInput & { lineNumber: number })[];
  },
  accounts: ReadonlyMap<string, AccountFacts>,
  context?: PostingContext,
): { ok: true; lines: PostableLine[]; total: Decimal } | { ok: false; issues: RuleIssue[] } {
  const issues = validateDraftLines(input.lines, input.currency);
  if (!input.entryDate) issues.push({ path: 'entryDate', message: 'A journal date is required.' });
  if (input.lines.length < 2) {
    issues.push({ path: 'lines', message: 'A journal needs at least two lines.' });
  }
  const postable: PostableLine[] = [];
  input.lines.forEach((line, i) => {
    if (!line.accountId) {
      issues.push({ path: `lines.${i}.accountId`, message: 'Every line needs an account.' });
    } else {
      const account = accounts.get(line.accountId);
      if (!account) issues.push({ path: `lines.${i}.accountId`, message: 'Unknown account.' });
      else if (account.status !== 'ACTIVE') {
        issues.push({
          path: `lines.${i}.accountId`,
          message: 'Archived accounts cannot receive postings.',
        });
      } else if (!account.isLeaf) {
        issues.push({
          path: `lines.${i}.accountId`,
          message: 'Only leaf accounts can receive postings; parent accounts are grouping nodes.',
        });
      } else if (context) {
        const problem = accountRuleIssue(account, input.currency, context);
        if (problem) issues.push({ path: `lines.${i}.accountId`, message: problem });
      }
    }
    if (line.debit === null && line.credit === null) {
      issues.push({ path: `lines.${i}`, message: 'Every line needs a debit or a credit amount.' });
    }
    const side = line.debit !== null ? 'debit' : 'credit';
    const raw = line.debit ?? line.credit;
    const parsed = raw === null ? null : parseAmount(raw, input.currency);
    if (line.accountId && parsed?.ok && !(line.debit !== null && line.credit !== null)) {
      postable.push({
        lineNumber: line.lineNumber,
        accountId: line.accountId,
        side,
        amount: parsed.value,
      });
    }
  });
  if (issues.length > 0) return { ok: false, issues: dedupe(issues) };

  const debit = postable
    .filter((l) => l.side === 'debit')
    .reduce((a, l) => a.plus(l.amount), decimal(0));
  const credit = postable
    .filter((l) => l.side === 'credit')
    .reduce((a, l) => a.plus(l.amount), decimal(0));
  if (!debit.eq(credit)) {
    return {
      ok: false,
      issues: [
        {
          path: 'lines',
          message: `Total debits (${debit.toFixed()}) must equal total credits (${credit.toFixed()}).`,
        },
      ],
    };
  }
  return { ok: true, lines: postable, total: debit };
}

function dedupe(issues: RuleIssue[]): RuleIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.path}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface BaseConversion {
  lines: (PostableLine & ConvertedLine)[];
  totalBase: Decimal;
}

/** Base-currency amounts with the approved rounding rule (see convertLinesToBase). */
export function convertJournalToBase(
  lines: readonly PostableLine[],
  rate: Decimal,
  baseCurrency: string,
): BaseConversion {
  const converted = convertLinesToBase(lines, rate, baseCurrency);
  const merged = lines.map((line, i) => ({ ...line, ...converted[i]! }));
  const totalBase = merged
    .filter((l) => l.side === 'debit')
    .reduce((a, l) => a.plus(l.baseAmount), decimal(0));
  return { lines: merged, totalBase };
}

export const AMOUNT_SCALE = 4;
export const fixedAmount = (value: Decimal) => toFixedString(value, AMOUNT_SCALE);

// ---------------------------------------------------------------------------
// Fiscal periods
// ---------------------------------------------------------------------------

export interface PeriodRange {
  startDate: string;
  endDate: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Same day-of-month `months` later, clamped to the last day of the target month. */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, day] = isoDate.split('-').map(Number) as [number, number, number];
  const targetMonthIndex = m - 1 + months;
  const year = y + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(year, month, Math.min(day, lastDay)));
  return d.toISOString().slice(0, 10);
}

/** Default monthly periods covering [start, end]; the last period may be partial. */
export function generateMonthlyPeriods(startDate: string, endDate: string): PeriodRange[] {
  const periods: PeriodRange[] = [];
  let cursor = startDate;
  for (let i = 1; cursor <= endDate; i += 1) {
    const nextStart = addMonths(startDate, i);
    const periodEnd = addDays(nextStart, -1);
    periods.push({ startDate: cursor, endDate: periodEnd < endDate ? periodEnd : endDate });
    cursor = nextStart;
    if (i > 1000) throw new Error('Too many periods');
  }
  return periods;
}

/** Custom periods must be contiguous, non-overlapping and cover the fiscal year exactly. */
export function validatePeriodLayout(
  fiscalYear: PeriodRange,
  periods: readonly PeriodRange[],
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (periods.length === 0)
    return [{ path: 'periods', message: 'At least one period is required.' }];
  periods.forEach((p, i) => {
    if (!isValidIsoDate(p.startDate) || !isValidIsoDate(p.endDate) || p.endDate < p.startDate) {
      issues.push({
        path: `periods.${i}`,
        message: 'Each period needs a valid start and end date.',
      });
    }
  });
  if (issues.length) return issues;
  if (periods[0]!.startDate !== fiscalYear.startDate) {
    issues.push({
      path: 'periods.0.startDate',
      message: 'The first period must start on the fiscal year start.',
    });
  }
  if (periods.at(-1)!.endDate !== fiscalYear.endDate) {
    issues.push({ path: 'periods', message: 'The last period must end on the fiscal year end.' });
  }
  for (let i = 1; i < periods.length; i += 1) {
    if (periods[i]!.startDate !== addDays(periods[i - 1]!.endDate, 1)) {
      issues.push({
        path: `periods.${i}.startDate`,
        message: 'Periods must be contiguous and non-overlapping.',
      });
    }
  }
  return issues;
}
