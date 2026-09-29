import { formatAmount } from '../../shared/money';

/** Conditional approvals (S10): shared types and wording for policies, requests and documents. */

export interface StepConditions {
  minBaseAmount: string | null;
  maxBaseAmount: string | null;
  transactionTypes: string[] | null;
  thresholdCurrency: string | null;
}

export interface ApprovalAction {
  actionKey: string;
  label: string;
  approverPermission: string;
  conditions: { amount: boolean; transactionTypes: string[] };
}

/** Facts the server derived for a document (never supplied by the browser). */
export interface ApprovalFacts {
  transactionType: string;
  baseAmount: string | null;
  baseCurrency: string | null;
}

export interface AppliedStep {
  order: number;
  name: string;
  requiredApprovals: number;
  conditions: StepConditions | null;
}

const TYPE_LABELS: Record<string, string> = {
  manual: 'Manual journals',
  imported: 'Imported journals',
  accounting_event: 'Accounting-event journals',
  opening_balance: 'Opening balances',
  period_reopen: 'Period reopening',
};

export function transactionTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

/** "Always", or the amount band and transaction types a step applies to. */
export function describeConditions(
  conditions: StepConditions | null | undefined,
  baseCurrency: string | null,
): string {
  if (!conditions) return 'Applies to every document.';
  const currency = conditions.thresholdCurrency ?? baseCurrency ?? '';
  const parts: string[] = [];
  const { minBaseAmount: min, maxBaseAmount: max } = conditions;
  if (min !== null && max !== null) {
    parts.push(
      `amount from ${formatAmount(min, currency)} up to (not including) ${formatAmount(max, currency)} ${currency}`,
    );
  } else if (min !== null) {
    parts.push(`amount of ${formatAmount(min, currency)} ${currency} or more`);
  } else if (max !== null) {
    parts.push(`amount under ${formatAmount(max, currency)} ${currency}`);
  }
  if (conditions.transactionTypes?.length) {
    parts.push(conditions.transactionTypes.map(transactionTypeLabel).join(' or '));
  }
  return parts.length ? `Applies to: ${parts.join('; ')}.` : 'Applies to every document.';
}

export function describeFacts(facts: ApprovalFacts | null | undefined): string {
  if (!facts) return '';
  const amount =
    facts.baseAmount !== null && facts.baseCurrency
      ? `${formatAmount(facts.baseAmount, facts.baseCurrency)} ${facts.baseCurrency}`
      : null;
  return [transactionTypeLabel(facts.transactionType), amount].filter(Boolean).join(' · ');
}

/** The steps that apply to a document, with what made them apply. */
export function AppliedSteps({
  steps,
  baseCurrency,
}: {
  steps: readonly AppliedStep[];
  baseCurrency: string | null;
}) {
  if (steps.length === 0) return null;
  return (
    <ul className="applied-steps">
      {steps.map((step) => (
        <li key={step.order}>
          Step {step.order} — {step.name} ({step.requiredApprovals} approval
          {step.requiredApprovals === 1 ? '' : 's'}):{' '}
          <span className="muted">{describeConditions(step.conditions, baseCurrency)}</span>
        </li>
      ))}
    </ul>
  );
}
