import { describe, expect, it } from 'vitest';
import {
  buildRunPosting,
  calculatePayslip,
  daysInPeriod,
  employedDays,
  NegativeNetPay,
  type ComponentDefinition,
  type EmployeeForPayroll,
} from '../src/modules/payroll/index.js';

/**
 * The pure payslip calculation (FP-25): proration, percentage bases, rounding, exact totals,
 * negative net pay and the balanced posting. No database.
 */

const MARCH = { start: '2026-03-01', end: '2026-03-31' };
const opts = { proration: 'calendar_days' as const, scale: 2 };

const component = (
  code: string,
  kind: ComponentDefinition['kind'],
  calculation: ComponentDefinition['calculation'],
): ComponentDefinition => ({
  id: `c-${code}`,
  code,
  name: code,
  kind,
  calculation,
  expenseAccountId: kind === 'deduction' ? null : `exp-${code}`,
  liabilityAccountId: kind === 'earning' ? null : `lia-${code}`,
});

const employee = (
  overrides: Partial<EmployeeForPayroll> = {},
  components: EmployeeForPayroll['components'] = [],
): EmployeeForPayroll => ({
  id: 'e1',
  number: 'EMP-00001',
  name: 'Aisha',
  hireDate: '2025-01-01',
  terminationDate: null,
  basicSalary: '10000',
  components,
  ...overrides,
});

describe('calculatePayslip', () => {
  it('computes earnings, percentage deductions, employer contributions and net pay', () => {
    const slip = calculatePayslip(
      employee({}, [
        { component: component('ALLOW', 'earning', 'fixed'), value: '500' },
        { component: component('BONUS', 'earning', 'percent_of_basic'), value: '10' },
        { component: component('PENS', 'deduction', 'percent_of_gross'), value: '5' },
        { component: component('LOAN', 'deduction', 'fixed'), value: '250' },
        { component: component('EPENS', 'employer_contribution', 'percent_of_basic'), value: '7' },
      ]),
      MARCH,
      opts,
    )!;
    expect(slip.basic).toBe('10000.00');
    expect(slip.gross).toBe('11500.00'); // 10000 + 500 + 1000
    expect(slip.deductions).toBe('825.00'); // 5% of gross = 575, plus 250
    expect(slip.net).toBe('10675.00');
    expect(slip.employerCost).toBe('700.00');
    expect(slip.prorationFactor).toBe('1.00000000');
    const sum = slip.lines
      .filter((l) => l.kind === 'basic' || l.kind === 'earning')
      .reduce((s, l) => s + Number(l.amount), 0);
    expect(sum).toBe(11500);
  });

  it('prorates basic and earnings by calendar days for a part month, but not fixed deductions', () => {
    const slip = calculatePayslip(
      employee({ hireDate: '2026-03-16' }, [
        { component: component('ALLOW', 'earning', 'fixed'), value: '310' },
        { component: component('LOAN', 'deduction', 'fixed'), value: '100' },
      ]),
      MARCH,
      opts,
    )!;
    // 16 of 31 days.
    expect(slip.prorationFactor).toBe('0.51612903');
    expect(slip.basic).toBe('5161.29'); // 10000 * 16 / 31 = 5161.2903
    expect(slip.lines.find((l) => l.code === 'ALLOW')!.amount).toBe('160.00');
    expect(slip.lines.find((l) => l.code === 'LOAN')!.amount).toBe('100.00');
    expect(slip.net).toBe('5221.29');
  });

  it('prorates for a termination inside the period, and pays in full with proration off', () => {
    const left = employee({ terminationDate: '2026-03-10' });
    expect(calculatePayslip(left, MARCH, opts)!.basic).toBe('3225.81'); // 10 of 31
    expect(calculatePayslip(left, MARCH, { ...opts, proration: 'none' })!.basic).toBe('10000.00');
  });

  it('skips employees who were not employed during the period', () => {
    expect(calculatePayslip(employee({ hireDate: '2026-04-01' }), MARCH, opts)).toBeNull();
    expect(calculatePayslip(employee({ terminationDate: '2026-02-28' }), MARCH, opts)).toBeNull();
    expect(calculatePayslip(employee({ terminationDate: '2026-03-01' }), MARCH, opts)!.basic).toBe(
      '322.58', // one day
    );
  });

  it('counts days inclusively', () => {
    expect(daysInPeriod(MARCH)).toBe(31);
    expect(employedDays(employee({ hireDate: '2026-03-31' }), MARCH)).toBe(1);
    expect(employedDays(employee({ hireDate: '2026-04-01' }), MARCH)).toBe(0);
  });

  it('rounds every line half up, so the payslip always adds up exactly', () => {
    const slip = calculatePayslip(
      employee({ basicSalary: '1234.56' }, [
        { component: component('A', 'earning', 'percent_of_basic'), value: '3.333' },
        { component: component('B', 'deduction', 'percent_of_basic'), value: '2.5' },
      ]),
      MARCH,
      opts,
    )!;
    const a = slip.lines.find((l) => l.code === 'A')!.amount;
    const b = slip.lines.find((l) => l.code === 'B')!.amount;
    expect(a).toBe('41.15'); // 1234.56 * 0.03333 = 41.1493…
    expect(b).toBe('30.86'); // 30.864
    expect(Number(slip.gross)).toBeCloseTo(1234.56 + 41.15, 6);
    expect(Number(slip.net)).toBeCloseTo(Number(slip.gross) - 30.86, 6);
  });

  it('omits zero lines and refuses deductions above gross pay', () => {
    const slip = calculatePayslip(
      employee({}, [{ component: component('ZERO', 'earning', 'fixed'), value: '0' }]),
      MARCH,
      opts,
    )!;
    expect(slip.lines.map((l) => l.code)).toEqual(['BASIC']);
    expect(() =>
      calculatePayslip(
        employee({ basicSalary: '100' }, [
          { component: component('BIG', 'deduction', 'fixed'), value: '150' },
        ]),
        MARCH,
        opts,
      ),
    ).toThrow(NegativeNetPay);
  });

  it('supports a currency without minor units', () => {
    const slip = calculatePayslip(
      employee({ basicSalary: '1000' }, [
        { component: component('D', 'deduction', 'percent_of_basic'), value: '3.5' },
      ]),
      MARCH,
      { proration: 'calendar_days', scale: 0 },
    )!;
    expect(slip.lines.find((l) => l.code === 'D')!.amount).toBe('35');
    expect(slip.net).toBe('965');
  });
});

describe('buildRunPosting', () => {
  it('produces a balanced journal aggregated by account', () => {
    const slips = [
      calculatePayslip(
        employee({}, [
          { component: component('ALLOW', 'earning', 'fixed'), value: '500' },
          { component: component('PENS', 'deduction', 'percent_of_basic'), value: '7' },
          {
            component: component('EPENS', 'employer_contribution', 'percent_of_basic'),
            value: '7',
          },
        ]),
        MARCH,
        opts,
      )!,
      calculatePayslip(
        employee({ id: 'e2', number: 'EMP-00002', basicSalary: '8000.50' }, [
          { component: component('ALLOW', 'earning', 'fixed'), value: '500' },
          { component: component('PENS', 'deduction', 'percent_of_basic'), value: '7' },
          {
            component: component('EPENS', 'employer_contribution', 'percent_of_basic'),
            value: '7',
          },
        ]),
        MARCH,
        opts,
      )!,
    ];
    const lines = buildRunPosting(
      slips,
      { basicSalaryExpenseAccountId: 'basic', netPayPayableAccountId: 'net' },
      2,
    );
    const debit = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credit = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(debit).toBeCloseTo(credit, 6);
    // One line per account.
    expect(new Set(lines.map((l) => l.accountId)).size).toBe(lines.length);
    expect(lines.find((l) => l.accountId === 'basic')!.debit).toBe('18000.50');
    expect(lines.find((l) => l.accountId === 'exp-ALLOW')!.debit).toBe('1000.00');
    expect(lines.find((l) => l.accountId === 'lia-PENS')!.credit).toBe('1260.04'); // 700 + 560.04
    expect(lines.find((l) => l.accountId === 'exp-EPENS')!.debit).toBe('1260.04');
    expect(lines.find((l) => l.accountId === 'lia-EPENS')!.credit).toBe('1260.04');
    const net = slips.reduce((s, p) => s + Number(p.net), 0);
    expect(Number(lines.find((l) => l.accountId === 'net')!.credit)).toBeCloseTo(net, 6);
  });
});
