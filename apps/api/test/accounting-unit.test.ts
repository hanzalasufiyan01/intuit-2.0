import { describe, expect, it } from 'vitest';
import {
  convertLinesToBase,
  convertToBase,
  decimal,
  isSupportedCurrency,
  minorUnits,
  parseAmount,
  parseRate,
} from '../src/domain/money.js';
import { hashPayload } from '../src/modules/accounting/events.js';
import {
  addMonths,
  generateMonthlyPeriods,
  validatePeriodLayout,
  validatePostableJournal,
} from '../src/modules/accounting/rules.js';
import { evaluateApprovals, selectApprovalStep } from '../src/modules/approvals/approvals.js';

describe('exact money arithmetic', () => {
  it('never uses floating point', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the problem being avoided
    expect(decimal('0.1').plus('0.2').toFixed()).toBe('0.3');
    expect(decimal('99999999999999.99').plus('0.01').toFixed()).toBe('100000000000000');
  });

  it('parses amounts with currency-aware precision', () => {
    expect(minorUnits('MVR')).toBe(2);
    expect(minorUnits('JPY')).toBe(0);
    expect(minorUnits('KWD')).toBe(3);
    expect(parseAmount('10.25', 'MVR')).toMatchObject({ ok: true });
    expect(parseAmount('10.255', 'MVR')).toEqual({ ok: false, problem: 'too_many_decimals' });
    expect(parseAmount('10.5', 'JPY')).toEqual({ ok: false, problem: 'too_many_decimals' });
    expect(parseAmount('10.255', 'KWD')).toMatchObject({ ok: true });
    expect(parseAmount('-1', 'MVR')).toEqual({ ok: false, problem: 'format' });
    expect(parseAmount('0.00', 'MVR')).toEqual({ ok: false, problem: 'not_positive' });
    expect(parseAmount('1e3', 'MVR')).toEqual({ ok: false, problem: 'format' });
    expect(isSupportedCurrency('MVR')).toBe(true);
    expect(isSupportedCurrency('XXX')).toBe(false);
    expect(parseRate('15.4200000001').ok).toBe(true);
    expect(parseRate('15.42000000001').ok).toBe(false);
  });

  it('converts half-up to the base minor unit', () => {
    expect(convertToBase(decimal('1.00'), decimal('15.425'), 'MVR').toFixed()).toBe('15.43');
    expect(convertToBase(decimal('1.00'), decimal('15.424'), 'MVR').toFixed()).toBe('15.42');
    expect(convertToBase(decimal('100'), decimal('0.0067'), 'JPY').toFixed()).toBe('1');
  });

  it('applies the base rounding difference to the largest eligible line', () => {
    const lines = [
      { side: 'debit' as const, amount: decimal('0.01') },
      { side: 'debit' as const, amount: decimal('0.01') },
      { side: 'debit' as const, amount: decimal('0.01') },
      { side: 'credit' as const, amount: decimal('0.03') },
    ];
    const converted = convertLinesToBase(lines, decimal('15.42'), 'MVR');
    expect(converted.map((l) => l.baseAmount.toFixed(2))).toEqual(['0.15', '0.15', '0.15', '0.45']);
    expect(converted[3]!.roundingAdjustment.toFixed(2)).toBe('-0.01');
    const debits = converted
      .filter((l) => l.side === 'debit')
      .reduce((a, l) => a.plus(l.baseAmount), decimal(0));
    const credits = converted
      .filter((l) => l.side === 'credit')
      .reduce((a, l) => a.plus(l.baseAmount), decimal(0));
    expect(debits.eq(credits)).toBe(true);
  });

  it('breaks ties by the first line and leaves exact conversions untouched', () => {
    // Line 1 (debit 0.03) and line 4 (credit 0.03) tie as the largest; the first one wins.
    const tie = convertLinesToBase(
      [
        { side: 'debit', amount: decimal('0.03') },
        { side: 'debit', amount: decimal('0.01') },
        { side: 'debit', amount: decimal('0.01') },
        { side: 'credit', amount: decimal('0.03') },
        { side: 'credit', amount: decimal('0.02') },
      ],
      decimal('15.42'),
      'MVR',
    );
    expect(tie.map((l) => l.baseAmount.toFixed(2))).toEqual([
      '0.47',
      '0.15',
      '0.15',
      '0.46',
      '0.31',
    ]);
    expect(tie.map((l) => l.roundingAdjustment.toFixed(2))).toEqual([
      '0.01',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
    ]);
    const exact = convertLinesToBase(
      [
        { side: 'debit', amount: decimal('10.00') },
        { side: 'credit', amount: decimal('10.00') },
      ],
      decimal('2'),
      'USD',
    );
    expect(exact.every((l) => l.roundingAdjustment.isZero())).toBe(true);
  });
});

describe('double-entry rules', () => {
  const facts = new Map([
    ['a', { id: 'a', status: 'ACTIVE' as const, isLeaf: true }],
    ['b', { id: 'b', status: 'ACTIVE' as const, isLeaf: true }],
    ['p', { id: 'p', status: 'ACTIVE' as const, isLeaf: false }],
    ['x', { id: 'x', status: 'ARCHIVED' as const, isLeaf: true }],
  ]);
  const journal = (
    lines: { accountId: string | null; debit: string | null; credit: string | null }[],
  ) => ({
    currency: 'MVR',
    entryDate: '2026-01-01',
    lines: lines.map((l, i) => ({ ...l, description: '', lineNumber: i + 1 })),
  });

  it('accepts a balanced journal and rejects each rule violation', () => {
    expect(
      validatePostableJournal(
        journal([
          { accountId: 'a', debit: '5', credit: null },
          { accountId: 'b', debit: null, credit: '5' },
        ]),
        facts,
      ).ok,
    ).toBe(true);
    const cases = [
      [{ accountId: 'a', debit: '5', credit: null }],
      [
        { accountId: 'a', debit: '5', credit: null },
        { accountId: 'b', debit: null, credit: '4' },
      ],
      [
        { accountId: 'a', debit: '5', credit: '5' },
        { accountId: 'b', debit: null, credit: '5' },
      ],
      [
        { accountId: 'p', debit: '5', credit: null },
        { accountId: 'b', debit: null, credit: '5' },
      ],
      [
        { accountId: 'x', debit: '5', credit: null },
        { accountId: 'b', debit: null, credit: '5' },
      ],
      [
        { accountId: null, debit: '5', credit: null },
        { accountId: 'b', debit: null, credit: '5' },
      ],
      [
        { accountId: 'zzz', debit: '5', credit: null },
        { accountId: 'b', debit: null, credit: '5' },
      ],
    ];
    for (const lines of cases)
      expect(validatePostableJournal(journal(lines), facts).ok).toBe(false);
  });
});

describe('fiscal periods', () => {
  it('generates monthly periods for any start month and clamps month ends', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(generateMonthlyPeriods('2026-07-01', '2027-06-30')).toHaveLength(12);
    const partial = generateMonthlyPeriods('2026-01-15', '2026-03-31');
    expect(partial).toEqual([
      { startDate: '2026-01-15', endDate: '2026-02-14' },
      { startDate: '2026-02-15', endDate: '2026-03-14' },
      { startDate: '2026-03-15', endDate: '2026-03-31' },
    ]);
    expect(
      validatePeriodLayout({ startDate: '2026-01-15', endDate: '2026-03-31' }, partial),
    ).toEqual([]);
  });
});

describe('approval evaluation', () => {
  const snapshot = {
    steps: [
      { order: 1, name: 'FM', requiredApprovals: 1, roleIds: ['fm'], membershipIds: [] },
      { order: 2, name: 'CFO', requiredApprovals: 1, roleIds: ['cfo'], membershipIds: [] },
    ],
  };
  const request = {
    policySnapshot: snapshot,
    excludedUserIds: ['creator'],
    requestedByUserId: 'submitter',
  };

  it('requires every step and routes approvers to their first unsatisfied eligible step', () => {
    expect(evaluateApprovals(snapshot, []).satisfied).toBe(false);
    const fm = selectApprovalStep(request, [], {
      userId: 'u1',
      membershipId: 'm1',
      roleIds: ['fm'],
    });
    expect(fm).toEqual({ ok: true, stepOrder: 1 });
    const decisions = [{ stepOrder: 1, decision: 'approved' as const, approverMembershipId: 'm1' }];
    expect(evaluateApprovals(snapshot, decisions).satisfied).toBe(false);
    expect(
      selectApprovalStep(request, decisions, { userId: 'u3', membershipId: 'm3', roleIds: ['fm'] }),
    ).toEqual({
      ok: false,
      problem: 'not_eligible',
    });
    const done = [
      ...decisions,
      { stepOrder: 2, decision: 'approved' as const, approverMembershipId: 'm2' },
    ];
    expect(evaluateApprovals(snapshot, done).satisfied).toBe(true);
  });

  it('prohibits self-approval and double decisions', () => {
    expect(
      selectApprovalStep(request, [], { userId: 'submitter', membershipId: 'm', roleIds: ['fm'] }),
    ).toEqual({
      ok: false,
      problem: 'self_approval',
    });
    expect(
      selectApprovalStep(request, [], { userId: 'creator', membershipId: 'm', roleIds: ['fm'] }),
    ).toEqual({
      ok: false,
      problem: 'self_approval',
    });
    expect(
      selectApprovalStep(
        request,
        [{ stepOrder: 1, decision: 'approved', approverMembershipId: 'm1' }],
        {
          userId: 'u1',
          membershipId: 'm1',
          roleIds: ['fm', 'cfo'],
        },
      ),
    ).toEqual({ ok: false, problem: 'already_decided' });
  });
});

describe('accounting event idempotency keys', () => {
  it('hashes payloads canonically', () => {
    expect(hashPayload({ a: 1, b: { c: '2', d: [1, 2] } })).toBe(
      hashPayload({ b: { d: [1, 2], c: '2' }, a: 1 }),
    );
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });
});
