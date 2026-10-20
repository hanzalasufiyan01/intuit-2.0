import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  AppliedSteps,
  describeConditions,
  describeFacts,
  transactionTypeLabel,
} from '../src/features/approvals/conditions';
import { LocaleProvider, translate, type MessageKey, type MessageParams } from '../src/i18n/i18n';

/**
 * The English wording of conditional approvals, shared by the policy editor, the approval queue,
 * journals and opening balances. Written before the wording moved to the message catalog and kept
 * as the guard after: these sentences must read exactly the same in English.
 */
const t = (key: MessageKey, params?: MessageParams) => translate('en', key, params);

describe('approval condition wording (English)', () => {
  it('names the transaction types, and falls back to the raw type', () => {
    expect(transactionTypeLabel('manual', t)).toBe('Manual journals');
    expect(transactionTypeLabel('imported', t)).toBe('Imported journals');
    expect(transactionTypeLabel('accounting_event', t)).toBe('Accounting-event journals');
    expect(transactionTypeLabel('opening_balance', t)).toBe('Opening balances');
    expect(transactionTypeLabel('period_reopen', t)).toBe('Period reopening');
    expect(transactionTypeLabel('something_new', t)).toBe('something_new');
  });

  it('describes every amount band and type combination', () => {
    const c = (
      min: string | null,
      max: string | null,
      types: string[] | null,
      cur: string | null = null,
    ) => ({
      minBaseAmount: min,
      maxBaseAmount: max,
      transactionTypes: types,
      thresholdCurrency: cur,
    });
    expect(describeConditions(null, 'MVR', t)).toBe('Applies to every document.');
    expect(describeConditions(c(null, null, null), 'MVR', t)).toBe('Applies to every document.');
    expect(describeConditions(c('1000', '5000', null), 'MVR', t)).toBe(
      'Applies to: amount from 1,000.00 up to (not including) 5,000.00 MVR.',
    );
    expect(describeConditions(c('1000', null, null, 'USD'), 'MVR', t)).toBe(
      'Applies to: amount of 1,000.00 USD or more.',
    );
    expect(describeConditions(c(null, '500', ['manual', 'imported']), 'MVR', t)).toBe(
      'Applies to: amount under 500.00 MVR; Manual journals or Imported journals.',
    );
    expect(describeConditions(c(null, null, ['period_reopen']), null, t)).toBe(
      'Applies to: Period reopening.',
    );
  });

  it('describes the facts of a document', () => {
    expect(describeFacts(null, t)).toBe('');
    expect(
      describeFacts({ transactionType: 'manual', baseAmount: '20000', baseCurrency: 'MVR' }, t),
    ).toBe('Manual journals · 20,000.00 MVR');
    expect(
      describeFacts({ transactionType: 'period_reopen', baseAmount: null, baseCurrency: null }, t),
    ).toBe('Period reopening');
  });

  it('lists the applied steps with singular and plural approvals', () => {
    const { container } = render(
      <LocaleProvider locale="en">
        <AppliedSteps
          baseCurrency="MVR"
          steps={[
            { order: 1, name: 'Supervisor', requiredApprovals: 1, conditions: null },
            {
              order: 2,
              name: 'Finance',
              requiredApprovals: 2,
              conditions: {
                minBaseAmount: '50000',
                maxBaseAmount: null,
                transactionTypes: null,
                thresholdCurrency: null,
              },
            },
          ]}
        />
      </LocaleProvider>,
    );
    expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Step 1 — Supervisor (1 approval): Applies to every document.',
      'Step 2 — Finance (2 approvals): Applies to: amount of 50,000.00 MVR or more.',
    ]);
  });
});
