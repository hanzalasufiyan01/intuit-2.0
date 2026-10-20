import { Decimal } from 'decimal.js';
import { decimal } from '../../domain/money.js';

/**
 * Payslip calculation (FP-25, docs/design/payroll.md). Pure functions over decimals: no database,
 * no clock. Rates and amounts are data (pay components); nothing statutory is built in.
 *
 * Rules (the defaults of version 1, written down so they can be changed deliberately):
 *  - An employee is paid for a period if they were employed on any day of it.
 *  - Proration `calendar_days`: basic salary and fixed/percentage EARNINGS are multiplied by
 *    (employed calendar days in the period / calendar days in the period). `none` pays in full.
 *    Fixed deductions and fixed employer contributions are not prorated; percentage components
 *    follow their base.
 *  - `percent_of_basic` uses the (prorated) basic; `percent_of_gross` uses basic plus earnings.
 *  - Every line is rounded half-up to the currency's minor units; totals are sums of rounded lines,
 *    so a payslip always adds up exactly.
 *  - Zero lines are omitted. Deductions above gross make the payslip invalid (net must not be negative).
 */

export type ComponentKind = 'earning' | 'deduction' | 'employer_contribution';
export type ComponentCalculation = 'fixed' | 'percent_of_basic' | 'percent_of_gross';
export type Proration = 'calendar_days' | 'none';

export interface ComponentDefinition {
  id: string;
  code: string;
  name: string;
  kind: ComponentKind;
  calculation: ComponentCalculation;
  expenseAccountId: string | null;
  liabilityAccountId: string | null;
}

export interface EmployeeForPayroll {
  id: string;
  number: string;
  name: string;
  hireDate: string;
  terminationDate: string | null;
  basicSalary: string;
  /**
   * Effective-dated salary (ascending, one entry per effective date). With day-proration a change
   * inside the period is split by days; without it `basicSalary` is already the salary at period end.
   */
  salaryTimeline?: readonly { from: string; salary: string }[] | undefined;
  /** Assigned components with their value (the employee's own, or the component default). */
  components: readonly { component: ComponentDefinition; value: string }[];
}

export interface PayPeriod {
  start: string;
  end: string;
}

export interface PayslipLineResult {
  kind: 'basic' | ComponentKind;
  componentId: string | null;
  code: string;
  name: string;
  amount: string;
  expenseAccountId: string | null;
  liabilityAccountId: string | null;
}

export interface PayslipResult {
  employeeId: string;
  prorationFactor: string;
  basic: string;
  gross: string;
  deductions: string;
  net: string;
  employerCost: string;
  /** The salary periods used when the salary changed inside the period; otherwise null. */
  salarySegments: { from: string; to: string; salary: string; days: number }[] | null;
  lines: PayslipLineResult[];
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** Calendar days of the period, inclusive. */
export const daysInPeriod = (period: PayPeriod) => day(period.end) - day(period.start) + 1;

/** Days the employee was employed within the period (0 when not employed at all). */
export function employedDays(
  employee: Pick<EmployeeForPayroll, 'hireDate' | 'terminationDate'>,
  period: PayPeriod,
) {
  const from = Math.max(day(period.start), day(employee.hireDate));
  const to = Math.min(
    day(period.end),
    employee.terminationDate === null ? Number.POSITIVE_INFINITY : day(employee.terminationDate),
  );
  return Math.max(0, to - from + 1);
}

export class NegativeNetPay extends Error {
  constructor(
    readonly employeeId: string,
    readonly gross: string,
    readonly deductions: string,
  ) {
    super('Deductions exceed gross pay.');
  }
}

/** The payslip for one employee, or null when they were not employed during the period. */
export function calculatePayslip(
  employee: EmployeeForPayroll,
  period: PayPeriod,
  options: { proration: Proration; scale: number },
): PayslipResult | null {
  const employed = employedDays(employee, period);
  if (employed === 0) return null;
  const round = (value: Decimal) => value.toDecimalPlaces(options.scale, Decimal.ROUND_HALF_UP);
  const factor =
    options.proration === 'calendar_days'
      ? decimal(employed).div(daysInPeriod(period))
      : decimal(1);
  const lines: PayslipLineResult[] = [];
  let segments: { from: string; to: string; salary: string; days: number }[] | null = null;
  let basic = round(decimal(employee.basicSalary).times(factor));
  if (
    options.proration === 'calendar_days' &&
    employee.salaryTimeline &&
    employee.salaryTimeline.length > 1
  ) {
    const iso = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
    const first = Math.max(day(period.start), day(employee.hireDate));
    const last = Math.min(
      day(period.end),
      employee.terminationDate === null ? Number.POSITIVE_INFINITY : day(employee.terminationDate),
    );
    const found: { from: string; to: string; salary: string; days: number }[] = [];
    employee.salaryTimeline.forEach((entry, i) => {
      const next = employee.salaryTimeline![i + 1];
      const from = Math.max(first, i === 0 ? first : day(entry.from));
      const to = Math.min(last, next ? day(next.from) - 1 : last);
      if (to >= from) {
        found.push({ from: iso(from), to: iso(to), salary: entry.salary, days: to - from + 1 });
      }
    });
    if (found.length > 1) {
      segments = found;
      basic = round(
        found
          .reduce((sum, s) => sum.plus(decimal(s.salary).times(s.days)), decimal(0))
          .div(daysInPeriod(period)),
      );
    }
  }
  if (basic.gt(0)) {
    lines.push({
      kind: 'basic',
      componentId: null,
      code: 'BASIC',
      name: 'Basic salary',
      amount: basic.toFixed(options.scale),
      expenseAccountId: null,
      liabilityAccountId: null,
    });
  }
  const push = (entry: EmployeeForPayroll['components'][number], amount: Decimal) => {
    if (amount.lte(0)) return;
    lines.push({
      kind: entry.component.kind,
      componentId: entry.component.id,
      code: entry.component.code,
      name: entry.component.name,
      amount: amount.toFixed(options.scale),
      expenseAccountId: entry.component.expenseAccountId,
      liabilityAccountId: entry.component.liabilityAccountId,
    });
  };
  const ordered = [...employee.components].sort((a, b) =>
    a.component.code.localeCompare(b.component.code),
  );
  let earnings = decimal(0);
  for (const entry of ordered.filter((e) => e.component.kind === 'earning')) {
    const value = decimal(entry.value);
    const raw =
      entry.component.calculation === 'fixed' ? value.times(factor) : basic.times(value).div(100);
    const amount = round(raw);
    earnings = earnings.plus(amount);
    push(entry, amount);
  }
  const gross = basic.plus(earnings);
  let deductions = decimal(0);
  let employerCost = decimal(0);
  for (const kind of ['deduction', 'employer_contribution'] as const) {
    for (const entry of ordered.filter((e) => e.component.kind === kind)) {
      const value = decimal(entry.value);
      const base = entry.component.calculation === 'percent_of_gross' ? gross : basic;
      const amount = round(
        entry.component.calculation === 'fixed' ? value : base.times(value).div(100),
      );
      if (kind === 'deduction') deductions = deductions.plus(amount);
      else employerCost = employerCost.plus(amount);
      push(entry, amount);
    }
  }
  if (deductions.gt(gross)) {
    throw new NegativeNetPay(
      employee.id,
      gross.toFixed(options.scale),
      deductions.toFixed(options.scale),
    );
  }
  return {
    employeeId: employee.id,
    prorationFactor: factor.toFixed(8),
    basic: basic.toFixed(options.scale),
    gross: gross.toFixed(options.scale),
    deductions: deductions.toFixed(options.scale),
    net: gross.minus(deductions).toFixed(options.scale),
    employerCost: employerCost.toFixed(options.scale),
    salarySegments: segments,
    lines,
  };
}

/** The balanced journal lines of a set of payslips, aggregated by account. */
export interface PostingLine {
  accountId: string;
  debit: string | null;
  credit: string | null;
}

export function buildRunPosting(
  payslips: readonly PayslipResult[],
  accounts: { basicSalaryExpenseAccountId: string; netPayPayableAccountId: string },
  scale: number,
): PostingLine[] {
  const debits = new Map<string, Decimal>();
  const credits = new Map<string, Decimal>();
  const add = (map: Map<string, Decimal>, id: string, amount: Decimal) =>
    map.set(id, (map.get(id) ?? decimal(0)).plus(amount));
  let net = decimal(0);
  for (const slip of payslips) {
    net = net.plus(slip.net);
    for (const line of slip.lines) {
      const amount = decimal(line.amount);
      if (line.kind === 'basic') add(debits, accounts.basicSalaryExpenseAccountId, amount);
      else if (line.kind === 'earning') add(debits, line.expenseAccountId!, amount);
      else if (line.kind === 'deduction') add(credits, line.liabilityAccountId!, amount);
      else {
        add(debits, line.expenseAccountId!, amount);
        add(credits, line.liabilityAccountId!, amount);
      }
    }
  }
  add(credits, accounts.netPayPayableAccountId, net);
  const lines: PostingLine[] = [];
  for (const [accountId, amount] of [...debits].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push({ accountId, debit: amount.toFixed(scale), credit: null });
  }
  for (const [accountId, amount] of [...credits].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push({ accountId, debit: null, credit: amount.toFixed(scale) });
  }
  return lines;
}
