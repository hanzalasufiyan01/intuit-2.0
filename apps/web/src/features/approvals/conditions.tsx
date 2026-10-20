import { useT, type MessageKey, type Translate } from '../../i18n/i18n';
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

const TYPE_LABELS: Record<string, MessageKey> = {
  manual: 'approvals.conditions.type.manual',
  imported: 'approvals.conditions.type.imported',
  accounting_event: 'approvals.conditions.type.accounting_event',
  opening_balance: 'approvals.conditions.type.opening_balance',
  period_reopen: 'approvals.conditions.type.period_reopen',
};

/** The name of a transaction type; a type this screen does not know shows as sent. */
export function transactionTypeLabel(type: string, t: Translate): string {
  const key = TYPE_LABELS[type];
  return key ? t(key) : type;
}

/** "Always", or the amount band and transaction types a step applies to. */
export function describeConditions(
  conditions: StepConditions | null | undefined,
  baseCurrency: string | null,
  t: Translate,
): string {
  if (!conditions) return t('approvals.conditions.everyDocument');
  const currency = conditions.thresholdCurrency ?? baseCurrency ?? '';
  const parts: string[] = [];
  const { minBaseAmount: min, maxBaseAmount: max } = conditions;
  if (min !== null && max !== null) {
    parts.push(
      t('approvals.conditions.amountBetween', {
        min: formatAmount(min, currency),
        max: formatAmount(max, currency),
        currency,
      }),
    );
  } else if (min !== null) {
    parts.push(
      t('approvals.conditions.amountAtLeast', { min: formatAmount(min, currency), currency }),
    );
  } else if (max !== null) {
    parts.push(
      t('approvals.conditions.amountUnder', { max: formatAmount(max, currency), currency }),
    );
  }
  if (conditions.transactionTypes?.length) {
    parts.push(
      conditions.transactionTypes
        .map((type) => transactionTypeLabel(type, t))
        .join(t('approvals.conditions.typeSeparator')),
    );
  }
  return parts.length
    ? t('approvals.conditions.appliesTo', { parts: parts.join('; ') })
    : t('approvals.conditions.everyDocument');
}

export function describeFacts(facts: ApprovalFacts | null | undefined, t: Translate): string {
  if (!facts) return '';
  const amount =
    facts.baseAmount !== null && facts.baseCurrency
      ? `${formatAmount(facts.baseAmount, facts.baseCurrency)} ${facts.baseCurrency}`
      : null;
  return [transactionTypeLabel(facts.transactionType, t), amount].filter(Boolean).join(' · ');
}

/** The steps that apply to a document, with what made them apply. */
export function AppliedSteps({
  steps,
  baseCurrency,
}: {
  steps: readonly AppliedStep[];
  baseCurrency: string | null;
}) {
  const t = useT();
  if (steps.length === 0) return null;
  return (
    <ul className="applied-steps">
      {steps.map((step) => (
        <li key={step.order}>
          {t(
            step.requiredApprovals === 1
              ? 'approvals.conditions.stepOne'
              : 'approvals.conditions.stepMany',
            { order: step.order, name: step.name, count: step.requiredApprovals },
          )}{' '}
          <span className="muted">{describeConditions(step.conditions, baseCurrency, t)}</span>
        </li>
      ))}
    </ul>
  );
}
