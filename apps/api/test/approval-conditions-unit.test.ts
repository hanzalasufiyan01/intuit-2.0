import { describe, expect, it } from 'vitest';
import { openingApprovalAmount } from '../src/application/opening-balance-service.js';
import {
  planOpeningJournals,
  type OpeningAccount,
  type PlanLine,
} from '../src/modules/accounting/index.js';
import {
  evaluateApprovals,
  matchingSteps,
  normalizeConditions,
  selectApprovalStep,
  snapshotPolicy,
  stepApplies,
  type ApprovalFacts,
  type PolicySnapshotStep,
  type StepConditions,
} from '../src/modules/approvals/index.js';

/** Phase 3A S10: conditional approvals, pure rules (Decisions 22, 56, 77; S10-01 to S10-05). */

const band = (
  min: string | null,
  max: string | null,
  types: string[] | null = null,
): StepConditions => ({
  minBaseAmount: min,
  maxBaseAmount: max,
  transactionTypes: types,
  thresholdCurrency: min !== null || max !== null ? 'MVR' : null,
});
const facts = (
  baseAmount: string | null,
  transactionType = 'manual',
  baseCurrency = 'MVR',
): ApprovalFacts => ({
  transactionType,
  baseAmount,
  baseCurrency,
});

describe('step conditions (S10-01)', () => {
  it('treats the minimum as inclusive and the maximum as exclusive', () => {
    const c = band('10000', '50000');
    expect(stepApplies(c, facts('9999.99'))).toBe(false);
    expect(stepApplies(c, facts('10000'))).toBe(true);
    expect(stepApplies(c, facts('49999.99'))).toBe(true);
    expect(stepApplies(c, facts('50000'))).toBe(false);
  });

  it('supports open-ended bands and unconditional steps', () => {
    expect(stepApplies(band('50000', null), facts('1000000'))).toBe(true);
    expect(stepApplies(band('50000', null), facts('49999'))).toBe(false);
    expect(stepApplies(band(null, '100'), facts('0'))).toBe(true);
    expect(stepApplies(band(null, '100'), facts('100'))).toBe(false);
    expect(stepApplies(undefined, facts('5'))).toBe(true);
    expect(stepApplies(band(null, null), facts('5'))).toBe(true);
  });

  it('matches transaction types, and needs every condition to hold (AND)', () => {
    const importedOnly = band(null, null, ['imported']);
    expect(stepApplies(importedOnly, facts('5', 'imported'))).toBe(true);
    expect(stepApplies(importedOnly, facts('5', 'manual'))).toBe(false);
    const bigImports = band('1000', null, ['imported']);
    expect(stepApplies(bigImports, facts('5000', 'imported'))).toBe(true);
    expect(stepApplies(bigImports, facts('500', 'imported'))).toBe(false);
    expect(stepApplies(bigImports, facts('5000', 'manual'))).toBe(false);
  });

  it('fails closed when the amount is unknown or the threshold currency changed (S10-05)', () => {
    expect(stepApplies(band('10000', null), facts(null))).toBe(true);
    expect(stepApplies(band(null, '10000'), facts(null))).toBe(true);
    expect(stepApplies(band('10000', null), facts('5', 'manual', 'USD'))).toBe(true);
    // Transaction types still decide, even when the amount is unknown.
    expect(stepApplies(band('10000', null, ['imported']), facts(null, 'manual'))).toBe(false);
  });
});

describe('matching steps and snapshots (Decision 77, S10-04)', () => {
  const step = (order: number, conditions: StepConditions): PolicySnapshotStep => ({
    order,
    name: `Step ${order}`,
    requiredApprovals: 1,
    roleIds: ['role'],
    membershipIds: [],
    conditions,
  });
  const policy = {
    id: 'p',
    actionKey: 'accounting.journal.post',
    updatedAt: new Date('2026-09-29T10:00:00Z'),
    steps: [
      step(1, band('10000', null)),
      step(2, band('50000', null)),
      step(3, band(null, null, ['imported'])),
    ],
  };

  it('keeps only the matching steps, with their policy numbers, and the facts', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const snapshot = snapshotPolicy(policy, facts('60000'), now);
    expect(snapshot.steps.map((s) => s.order)).toEqual([1, 2]);
    expect(snapshot).toMatchObject({
      facts: facts('60000'),
      evaluatedAt: now.toISOString(),
      policyUpdatedAt: policy.updatedAt.toISOString(),
    });
    expect(matchingSteps(policy.steps, facts('20000', 'imported')).map((s) => s.order)).toEqual([
      1, 3,
    ]);
  });

  it('matches nothing below every band: no request, direct action', () => {
    expect(snapshotPolicy(policy, facts('9999'), new Date()).steps).toEqual([]);
    expect(snapshotPolicy(undefined, facts('9999'), new Date()).steps).toEqual([]);
  });

  it('evaluates and selects steps by their policy numbers, with gaps', () => {
    const snapshot = snapshotPolicy(policy, facts('20000', 'imported'), new Date());
    const request = {
      policySnapshot: snapshot,
      excludedUserIds: ['preparer'],
      requestedByUserId: 'submitter',
    };
    const approver = { userId: 'a', membershipId: 'm-a', roleIds: ['role'] };
    expect(selectApprovalStep(request, [], approver)).toEqual({ ok: true, stepOrder: 1 });
    const decisions = [
      { stepOrder: 1, decision: 'approved' as const, approverMembershipId: 'm-a' },
    ];
    expect(
      selectApprovalStep(request, decisions, {
        userId: 'b',
        membershipId: 'm-b',
        roleIds: ['role'],
      }),
    ).toEqual({ ok: true, stepOrder: 3 });
    expect(evaluateApprovals(snapshot, decisions).satisfied).toBe(false);
    expect(
      evaluateApprovals(snapshot, [...decisions, { stepOrder: 3, decision: 'approved' }]).satisfied,
    ).toBe(true);
    expect(
      selectApprovalStep(request, [], {
        userId: 'submitter',
        membershipId: 'x',
        roleIds: ['role'],
      }),
    ).toEqual({
      ok: false,
      problem: 'self_approval',
    });
  });
});

describe('condition validation (S10-01, S10-02)', () => {
  const journals = { amount: true, transactionTypes: ['manual', 'imported', 'accounting_event'] };
  const reopen = { amount: false, transactionTypes: ['period_reopen'] };
  const context = { baseCurrency: 'MVR', minorUnits: 2, path: 'steps.0.conditions' };
  const messages = (result: ReturnType<typeof normalizeConditions>) =>
    result.ok ? [] : result.issues.map((i) => i.message);

  it('normalizes valid conditions and records the threshold currency with amounts only', () => {
    expect(
      normalizeConditions(
        {
          minBaseAmount: '10000.50',
          maxBaseAmount: null,
          transactionTypes: ['manual', 'imported', 'manual'],
        },
        journals,
        context,
      ),
    ).toEqual({
      ok: true,
      value: {
        minBaseAmount: '10000.5',
        maxBaseAmount: null,
        transactionTypes: ['imported', 'manual'],
        thresholdCurrency: 'MVR',
      },
    });
    expect(normalizeConditions({ transactionTypes: ['period_reopen'] }, reopen, context)).toEqual({
      ok: true,
      value: {
        minBaseAmount: null,
        maxBaseAmount: null,
        transactionTypes: ['period_reopen'],
        thresholdCurrency: null,
      },
    });
    expect(normalizeConditions(undefined, journals, context)).toMatchObject({ ok: true });
  });

  it('refuses bad bands, precision, unsupported amounts and unknown types', () => {
    expect(
      messages(
        normalizeConditions({ minBaseAmount: '100', maxBaseAmount: '100' }, journals, context),
      ),
    ).toEqual(['The maximum must be more than the minimum.']);
    expect(messages(normalizeConditions({ maxBaseAmount: '0' }, journals, context))).toEqual([
      'The maximum must be more than zero.',
    ]);
    expect(messages(normalizeConditions({ minBaseAmount: '1.005' }, journals, context))[0]).toMatch(
      /at most 2 decimals/,
    );
    expect(messages(normalizeConditions({ minBaseAmount: '1' }, reopen, context))[0]).toMatch(
      /no amount/,
    );
    expect(
      messages(normalizeConditions({ transactionTypes: ['invoice'] }, journals, context))[0],
    ).toMatch(/Unknown transaction type for this action: invoice/);
    expect(messages(normalizeConditions({ transactionTypes: [] }, journals, context))[0]).toMatch(
      /at least one/,
    );
    expect(
      messages(
        normalizeConditions({ minBaseAmount: '1' }, journals, { ...context, baseCurrency: null }),
      )[0],
    ).toMatch(/Set up accounting/);
  });
});

describe('opening-balance approval amount (S10-03, final amendment)', () => {
  const account = (id: string, overrides: Partial<OpeningAccount> = {}): OpeningAccount => ({
    id,
    code: id,
    name: id,
    status: 'ACTIVE',
    isLeaf: true,
    currencyCode: 'MVR',
    isControlAccount: false,
    accountType: 'ASSET',
    subtype: 'BANK',
    ...overrides,
  });
  const accounts = new Map(
    [
      account('cash'),
      account('loan', { accountType: 'LIABILITY', subtype: 'LONG_TERM_LIABILITY' }),
      account('usd', { currencyCode: 'USD' }),
      account('eur', { currencyCode: 'EUR' }),
      account('obe', { accountType: 'EQUITY', subtype: 'EQUITY' }),
    ].map((a) => [a.id, a]),
  );
  let n = 0;
  const line = (
    accountId: string,
    side: 'debit' | 'credit',
    amount: string,
    baseAmount: string | null = null,
  ): PlanLine => ({
    lineNumber: ++n,
    accountId,
    description: '',
    debit: side === 'debit' ? amount : null,
    credit: side === 'credit' ? amount : null,
    baseAmount,
    dimensions: [],
  });

  it('sums each currency journal once, never adding the OBE line on top', () => {
    const plan = planOpeningJournals({
      baseCurrency: 'MVR',
      lines: [
        line('cash', 'debit', '25000'),
        line('loan', 'credit', '10000'),
        line('usd', 'debit', '1000'),
        line('eur', 'debit', '10', '180'),
      ],
      accounts,
      obeAccountId: 'obe',
      tableRates: new Map([['USD', '15.42']]),
      openingDate: '2026-03-31',
      maxLines: 500,
    });
    expect(plan.issues).toEqual([]);
    // MVR: 25,000 Dr vs 10,000 Cr + 15,000 OBE Cr -> 25,000 (not 25,000 + 15,000).
    // USD: 1,000 x 15.42 = 15,420. EUR: explicit carrying value 180.
    expect(openingApprovalAmount(plan.journals, 'MVR')).toBe('40600');
  });

  it('uses the larger side when credits exceed debits (OBE on the debit side)', () => {
    const plan = planOpeningJournals({
      baseCurrency: 'MVR',
      lines: [line('cash', 'debit', '200'), line('loan', 'credit', '700')],
      accounts,
      obeAccountId: 'obe',
      tableRates: new Map(),
      openingDate: '2026-03-31',
      maxLines: 500,
    });
    expect(openingApprovalAmount(plan.journals, 'MVR')).toBe('700');
  });
});
