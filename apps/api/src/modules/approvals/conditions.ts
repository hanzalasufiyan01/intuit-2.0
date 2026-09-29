import { Decimal } from 'decimal.js';
import type { ApprovalFacts, PolicySnapshotStep, StepConditions } from './schema.js';

/**
 * Conditional approvals (Decisions 22, 56, 77; S10-01 to S10-05). Pure rules, no database access.
 *
 * A step applies to a subject when every condition it sets holds:
 * - amount band: minBaseAmount <= baseAmount < maxBaseAmount (half-open; a missing bound is open);
 * - transaction type: the subject's type is one of the step's types.
 * A step with no condition always applies. Amount conditions fail closed: when the subject's
 * amount is unknown, or the step's threshold currency is not the current base currency, the step
 * applies (more approval, never less).
 */

export const NO_CONDITIONS: StepConditions = {
  minBaseAmount: null,
  maxBaseAmount: null,
  transactionTypes: null,
  thresholdCurrency: null,
};

export function hasAmountCondition(conditions: StepConditions | undefined): boolean {
  return Boolean(
    conditions && (conditions.minBaseAmount !== null || conditions.maxBaseAmount !== null),
  );
}

export function isUnconditional(conditions: StepConditions | undefined): boolean {
  return !conditions || (!hasAmountCondition(conditions) && conditions.transactionTypes === null);
}

export function stepApplies(conditions: StepConditions | undefined, facts: ApprovalFacts): boolean {
  if (!conditions) return true;
  if (
    conditions.transactionTypes !== null &&
    !conditions.transactionTypes.includes(facts.transactionType)
  ) {
    return false;
  }
  if (!hasAmountCondition(conditions)) return true;
  // Fail closed (S10-05).
  if (facts.baseAmount === null || facts.baseCurrency !== conditions.thresholdCurrency) return true;
  const amount = new Decimal(facts.baseAmount).abs();
  if (conditions.minBaseAmount !== null && amount.lt(conditions.minBaseAmount)) return false;
  if (conditions.maxBaseAmount !== null && amount.gte(conditions.maxBaseAmount)) return false;
  return true;
}

/** The steps that apply to the facts, keeping their policy step numbers (S10-04). */
export function matchingSteps(
  steps: readonly PolicySnapshotStep[],
  facts: ApprovalFacts,
): PolicySnapshotStep[] {
  return steps.filter((s) => stepApplies(s.conditions, facts)).map((s) => ({ ...s }));
}

/** What a registered action supports (S10-02). */
export interface ActionConditionSupport {
  amount: boolean;
  transactionTypes: readonly string[];
}

export interface ConditionInput {
  minBaseAmount?: string | null | undefined;
  maxBaseAmount?: string | null | undefined;
  transactionTypes?: string[] | null | undefined;
}

/**
 * Validates one step's conditions for an action and normalizes them. Amounts must fit the base
 * currency's minor units; the maximum must exceed the minimum; types must belong to the action.
 */
export function normalizeConditions(
  input: ConditionInput | undefined,
  support: ActionConditionSupport,
  context: { baseCurrency: string | null; minorUnits: number; path: string },
):
  { ok: true; value: StepConditions } | { ok: false; issues: { path: string; message: string }[] } {
  const issues: { path: string; message: string }[] = [];
  const amounts: Record<'minBaseAmount' | 'maxBaseAmount', string | null> = {
    minBaseAmount: null,
    maxBaseAmount: null,
  };
  for (const key of ['minBaseAmount', 'maxBaseAmount'] as const) {
    const raw = input?.[key] ?? null;
    if (raw === null) continue;
    const path = `${context.path}.${key}`;
    if (!support.amount) {
      issues.push({
        path,
        message: 'This action has no amount, so it cannot have amount conditions.',
      });
      continue;
    }
    if (context.baseCurrency === null) {
      issues.push({ path, message: 'Set up accounting before adding amount conditions.' });
      continue;
    }
    const value = new Decimal(raw);
    if (key === 'maxBaseAmount' ? value.lte(0) : value.lt(0)) {
      issues.push({
        path,
        message:
          key === 'maxBaseAmount'
            ? 'The maximum must be more than zero.'
            : 'The minimum cannot be negative.',
      });
    } else if (value.decimalPlaces() > context.minorUnits) {
      issues.push({
        path,
        message: `${context.baseCurrency} amounts have at most ${context.minorUnits} decimals.`,
      });
    } else {
      amounts[key] = value.toFixed();
    }
  }
  if (
    amounts.minBaseAmount !== null &&
    amounts.maxBaseAmount !== null &&
    new Decimal(amounts.maxBaseAmount).lte(amounts.minBaseAmount)
  ) {
    issues.push({
      path: `${context.path}.maxBaseAmount`,
      message: 'The maximum must be more than the minimum.',
    });
  }
  let transactionTypes: string[] | null = null;
  if (input?.transactionTypes !== undefined && input.transactionTypes !== null) {
    const unique = [...new Set(input.transactionTypes)];
    const unknown = unique.filter((t) => !support.transactionTypes.includes(t));
    if (unique.length === 0) {
      issues.push({
        path: `${context.path}.transactionTypes`,
        message: 'Choose at least one transaction type.',
      });
    } else if (unknown.length) {
      issues.push({
        path: `${context.path}.transactionTypes`,
        message: `Unknown transaction type for this action: ${unknown.join(', ')}.`,
      });
    } else {
      transactionTypes = [...unique].sort();
    }
  }
  if (issues.length) return { ok: false, issues };
  const withAmount = amounts.minBaseAmount !== null || amounts.maxBaseAmount !== null;
  return {
    ok: true,
    value: {
      ...amounts,
      transactionTypes,
      thresholdCurrency: withAmount ? context.baseCurrency : null,
    },
  };
}
