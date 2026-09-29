import type { Decimal } from 'decimal.js';
import { convertToBase, decimal } from '../../domain/money.js';
import type { RuleIssue } from './rules.js';
import type { SystemJournalLineInput } from './system-journals.js';

/**
 * Foreign-currency revaluation (Decision 9, S9). Pure rules: the calculation of each exposure's
 * adjustment and the plan of one base-only revaluation journal per currency. No database access.
 *
 * Signs: balances are debit-positive (debit minus credit). For every exposure,
 *   F = foreign-currency balance (normal lines only; Decision 71),
 *   B = carrying base amount (all lines),
 *   T = round(F x closing rate) to base minor units, half-up,
 *   A = T - B.
 * A positive A debits the exposure's account and is a gain; a negative A credits it and is a loss.
 */

/** Journal source of revaluation journals and their reversals (Decision 12, S9). */
export const REVALUATION_SOURCE = { module: 'accounting', type: 'revaluation' } as const;
export const REVALUATION_REVERSAL_TYPE = 'revaluation_reversal';

export interface DocumentRef {
  module: string;
  type: string;
  id: string;
}

export interface RevaluationExposure {
  kind: 'ACCOUNT' | 'DOCUMENT';
  /** The account the adjustment posts to (for a document, its control account). */
  accountId: string;
  accountCode: string;
  accountName: string;
  currency: string;
  foreignBalance: string;
  carryingBase: string;
  document: DocumentRef | null;
}

export interface ClosingRate {
  rate: string;
  rateDate: string;
  source: 'table' | 'manual';
}

export interface CalculatedLine {
  lineNumber: number;
  exposure: RevaluationExposure;
  rate: ClosingRate;
  revaluedBase: string;
  adjustment: string;
}

export interface PlannedRevaluationJournal {
  currency: string;
  rate: ClosingRate;
  /** Base-only lines: one per account with a non-zero adjustment, then the net offset line. */
  lines: SystemJournalLineInput[];
  gain: string;
  loss: string;
}

export interface RevaluationPlan {
  issues: RuleIssue[];
  warnings: RuleIssue[];
  lines: CalculatedLine[];
  journals: PlannedRevaluationJournal[];
  totals: { gain: string; loss: string; net: string };
}

/**
 * Calculates every exposure and plans the journals. Exposures with neither a foreign balance nor
 * a carrying base amount are ignored. Exposures whose adjustment is zero produce no line at all
 * (neither a run line nor a journal line); a currency whose adjustments are all zero gets no
 * journal, and a run whose adjustments are all zero has no lines and no journals (N7).
 */
export function planRevaluation(input: {
  baseCurrency: string;
  exposures: readonly RevaluationExposure[];
  rates: ReadonlyMap<string, ClosingRate | undefined>;
  unrealizedAccountId: string;
  /** Warn when a rate is dated before this day (the start of the revaluation date's period). */
  staleBefore: string | null;
  /** The journal line cap; one line is kept for the Unrealized FX offset (S8-19 precedent). */
  maxLines: number;
}): RevaluationPlan {
  const issues: RuleIssue[] = [];
  const warnings: RuleIssue[] = [];
  const active = input.exposures.filter(
    (e) => !decimal(e.foreignBalance).isZero() || !decimal(e.carryingBase).isZero(),
  );
  const currencies = [...new Set(active.map((e) => e.currency))].sort();

  for (const currency of currencies) {
    const rate = input.rates.get(currency);
    if (!rate) {
      issues.push({
        path: `rates.${currency}`,
        message: `No ${currency} to ${input.baseCurrency} rate is recorded on or before the revaluation date.`,
      });
    } else if (input.staleBefore !== null && rate.rateDate < input.staleBefore) {
      warnings.push({
        path: `rates.${currency}`,
        message: `The latest ${currency} rate is dated ${rate.rateDate}, before this period began.`,
      });
    }
  }

  const lines: CalculatedLine[] = [];
  const ordered = [...active].sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) ||
      a.accountCode.localeCompare(b.accountCode) ||
      documentKey(a).localeCompare(documentKey(b)),
  );
  for (const exposure of ordered) {
    const rate = input.rates.get(exposure.currency);
    if (!rate) continue;
    const foreign = decimal(exposure.foreignBalance);
    const target = convertToBase(foreign, decimal(rate.rate), input.baseCurrency);
    const adjustment = target.minus(decimal(exposure.carryingBase));
    if (adjustment.isZero()) continue;
    if (foreign.isZero() && !decimal(exposure.carryingBase).isZero()) {
      warnings.push({
        path: `accounts.${exposure.accountCode}`,
        message:
          `${exposure.accountCode} has no ${exposure.currency} balance but carries ` +
          `${exposure.carryingBase} ${input.baseCurrency}; revaluation clears it. Check for an unrecorded realized FX difference.`,
      });
    }
    lines.push({
      lineNumber: lines.length + 1,
      exposure,
      rate,
      revaluedBase: target.toFixed(),
      adjustment: adjustment.toFixed(),
    });
  }

  const journals: PlannedRevaluationJournal[] = [];
  let gain = decimal(0);
  let loss = decimal(0);
  if (issues.length === 0) {
    for (const currency of currencies) {
      const byAccount = new Map<string, { code: string; name: string; amount: Decimal }>();
      for (const line of lines.filter((l) => l.exposure.currency === currency)) {
        const current = byAccount.get(line.exposure.accountId);
        const amount = decimal(line.adjustment);
        if (current) current.amount = current.amount.plus(amount);
        else
          byAccount.set(line.exposure.accountId, {
            code: line.exposure.accountCode,
            name: line.exposure.accountName,
            amount,
          });
      }
      const accountLines = [...byAccount.entries()]
        .filter(([, v]) => !v.amount.isZero())
        .sort(([, a], [, b]) => a.code.localeCompare(b.code));
      if (accountLines.length === 0) continue;
      if (accountLines.length > input.maxLines - 1) {
        issues.push({
          path: `currencies.${currency}`,
          message:
            `${currency} has ${accountLines.length} accounts to revalue; one revaluation journal ` +
            `holds at most ${input.maxLines - 1} plus the Unrealized FX line.`,
        });
        continue;
      }
      const net = accountLines.reduce((acc, [, v]) => acc.plus(v.amount), decimal(0));
      const currencyGain = accountLines
        .filter(([, v]) => v.amount.gt(0))
        .reduce((acc, [, v]) => acc.plus(v.amount), decimal(0));
      const currencyLoss = accountLines
        .filter(([, v]) => v.amount.lt(0))
        .reduce((acc, [, v]) => acc.plus(v.amount.abs()), decimal(0));
      gain = gain.plus(currencyGain);
      loss = loss.plus(currencyLoss);
      const journalLines: SystemJournalLineInput[] = accountLines.map(([accountId, v]) =>
        baseOnlyLine(accountId, `Revaluation of ${v.code} ${v.name} (${currency})`, v.amount),
      );
      if (!net.isZero()) {
        journalLines.push(
          baseOnlyLine(input.unrealizedAccountId, `Unrealized FX on ${currency}`, net.negated()),
        );
      }
      journals.push({
        currency,
        rate: input.rates.get(currency)!,
        lines: journalLines,
        gain: currencyGain.toFixed(),
        loss: currencyLoss.toFixed(),
      });
    }
  }
  return {
    issues,
    warnings,
    lines,
    journals: issues.length === 0 ? journals : [],
    totals: { gain: gain.toFixed(), loss: loss.toFixed(), net: gain.minus(loss).toFixed() },
  };
}

/** A base-only line for a signed, debit-positive base amount. */
function baseOnlyLine(
  accountId: string,
  description: string,
  amount: Decimal,
): SystemJournalLineInput {
  return {
    accountId,
    description,
    kind: 'base_only',
    debit: null,
    credit: null,
    baseDebit: amount.gt(0) ? amount.toFixed() : null,
    baseCredit: amount.lt(0) ? amount.abs().toFixed() : null,
    dimensions: [],
  };
}

function documentKey(e: RevaluationExposure): string {
  return e.document ? `${e.document.module}:${e.document.type}:${e.document.id}` : '';
}

/**
 * The mirror of posted journal lines (S9 reversal): every debit becomes a credit and every base
 * debit a base credit, line by line, so the reversal restores the previous carrying amounts.
 */
export function mirrorJournalLines(
  lines: readonly {
    accountId: string;
    description: string;
    kind: SystemJournalLineInput['kind'];
    debit: string | null;
    credit: string | null;
    baseDebit: string | null;
    baseCredit: string | null;
  }[],
): SystemJournalLineInput[] {
  return lines.map((l) => ({
    accountId: l.accountId,
    description: l.description,
    kind: l.kind,
    debit: l.credit,
    credit: l.debit,
    baseDebit: l.baseCredit,
    baseCredit: l.baseDebit,
    dimensions: [],
  }));
}
