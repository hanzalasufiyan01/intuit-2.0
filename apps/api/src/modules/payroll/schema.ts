import { jsonb, boolean, date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Payroll tables (migration 0066, FP-25). */

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });

export const payrollSettings = pgTable('payroll_settings', {
  organizationId: uuid('organization_id').primaryKey(),
  basicSalaryExpenseAccountId: uuid('basic_salary_expense_account_id'),
  netPayPayableAccountId: uuid('net_pay_payable_account_id'),
  advancesAccountId: uuid('advances_account_id'),
  proration: text('proration', { enum: ['calendar_days', 'none'] })
    .notNull()
    .default('calendar_days'),
  requireSeparateApprover: boolean('require_separate_approver').notNull().default(true),
  version: integer('version').notNull().default(1),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const payrollNumberSequences = pgTable('payroll_number_sequences', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['employee', 'run', 'advance'] }).notNull(),
  prefix: text('prefix').notNull().default(''),
  minDigits: integer('min_digits').notNull().default(5),
  nextNumber: numeric('next_number', { precision: 20, scale: 0 }).notNull().default('1'),
});

export const payrollEmployees = pgTable('payroll_employees', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  displayName: text('display_name').notNull(),
  email: text('email'),
  nationalId: text('national_id'),
  userId: uuid('user_id'),
  hireDate: date('hire_date', { mode: 'string' }).notNull(),
  terminationDate: date('termination_date', { mode: 'string' }),
  basicSalary: money('basic_salary').notNull(),
  bankAccountRef: text('bank_account_ref'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const payrollComponents = pgTable('payroll_components', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['earning', 'deduction', 'employer_contribution'] }).notNull(),
  calculation: text('calculation', {
    enum: ['fixed', 'percent_of_basic', 'percent_of_gross'],
  }).notNull(),
  defaultValue: numeric('default_value', { precision: 28, scale: 6 }).notNull().default('0'),
  expenseAccountId: uuid('expense_account_id'),
  liabilityAccountId: uuid('liability_account_id'),
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const payrollEmployeeComponents = pgTable('payroll_employee_components', {
  organizationId: uuid('organization_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  componentId: uuid('component_id').notNull(),
  value: numeric('value', { precision: 28, scale: 6 }),
});

export const payrollRunStatuses = ['DRAFT', 'APPROVED', 'POSTED', 'PAID', 'VOID'] as const;
export type PayrollRunStatus = (typeof payrollRunStatuses)[number];

export const payrollRuns = pgTable('payroll_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  periodStart: date('period_start', { mode: 'string' }).notNull(),
  periodEnd: date('period_end', { mode: 'string' }).notNull(),
  payDate: date('pay_date', { mode: 'string' }).notNull(),
  status: text('status', { enum: payrollRunStatuses }).notNull().default('DRAFT'),
  employeeCount: integer('employee_count').notNull(),
  grossTotal: money('gross_total').notNull(),
  deductionsTotal: money('deductions_total').notNull(),
  netTotal: money('net_total').notNull(),
  employerCostTotal: money('employer_cost_total').notNull(),
  approvedByUserId: uuid('approved_by_user_id'),
  approvedAt: timestamptz('approved_at'),
  journalId: uuid('journal_id'),
  accountingEventId: uuid('accounting_event_id'),
  postedByUserId: uuid('posted_by_user_id'),
  postedAt: timestamptz('posted_at'),
  paymentAccountId: uuid('payment_account_id'),
  paymentDate: date('payment_date', { mode: 'string' }),
  paymentJournalId: uuid('payment_journal_id'),
  paymentEventId: uuid('payment_event_id'),
  paidByUserId: uuid('paid_by_user_id'),
  paidAt: timestamptz('paid_at'),
  voidedByUserId: uuid('voided_by_user_id'),
  voidedAt: timestamptz('voided_at'),
  voidReason: text('void_reason'),
  voidJournalId: uuid('void_journal_id'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const payrollPayslips = pgTable('payroll_payslips', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  runId: uuid('run_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  employeeNumber: text('employee_number').notNull(),
  employeeName: text('employee_name').notNull(),
  employeeUserId: uuid('employee_user_id'),
  basicSalary: money('basic_salary').notNull(),
  prorationFactor: numeric('proration_factor', { precision: 12, scale: 8 }).notNull(),
  gross: money('gross').notNull(),
  deductions: money('deductions').notNull(),
  net: money('net').notNull(),
  employerCost: money('employer_cost').notNull(),
  /** The salary periods a mid-period change was split into (null when the salary was constant). */
  salarySegments: jsonb('salary_segments').$type<
    { from: string; to: string; salary: string; days: number }[] | null
  >(),
});

export const payrollPayslipLines = pgTable('payroll_payslip_lines', {
  organizationId: uuid('organization_id').notNull(),
  payslipId: uuid('payslip_id').notNull(),
  lineNo: integer('line_no').notNull(),
  componentId: uuid('component_id'),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind', {
    enum: ['basic', 'earning', 'deduction', 'employer_contribution'],
  }).notNull(),
  amount: money('amount').notNull(),
  expenseAccountId: uuid('expense_account_id'),
  liabilityAccountId: uuid('liability_account_id'),
});
