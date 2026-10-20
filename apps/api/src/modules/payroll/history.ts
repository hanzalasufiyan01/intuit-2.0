import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { date, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';

/** Effective-dated basic salary and payslip availability notices (migration 0083, FP-25). */

export const payrollSalaryHistory = pgTable('payroll_salary_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
  basicSalary: numeric('basic_salary', { precision: 28, scale: 4 }).notNull(),
  reason: text('reason').notNull().default(''),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamptz('created_at').notNull(),
});

export const payrollPayslipNotifications = pgTable('payroll_payslip_notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  payslipId: uuid('payslip_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  status: text('status', { enum: ['SENT', 'FAILED'] }).notNull(),
  error: text('error'),
  sentByUserId: uuid('sent_by_user_id'),
  createdAt: timestamptz('created_at').notNull(),
});

export type SalaryChange = typeof payrollSalaryHistory.$inferSelect;
export type SalarySegments = { from: string; to: string; salary: string; days: number }[];

export async function insertSalaryChange(
  tx: Transaction,
  values: typeof payrollSalaryHistory.$inferInsert,
) {
  const [row] = await tx.insert(payrollSalaryHistory).values(values).returning();
  return row!;
}

export async function salaryHistoryOf(
  tx: Transaction,
  organizationId: string,
  employeeIds: readonly string[],
) {
  if (!employeeIds.length) return [] as SalaryChange[];
  return tx
    .select()
    .from(payrollSalaryHistory)
    .where(
      and(
        eq(payrollSalaryHistory.organizationId, organizationId),
        inArray(payrollSalaryHistory.employeeId, [...employeeIds]),
      ),
    )
    .orderBy(
      asc(payrollSalaryHistory.employeeId),
      asc(payrollSalaryHistory.effectiveFrom),
      asc(payrollSalaryHistory.createdAt),
    );
}

export async function listSalaryHistory(
  tx: Transaction,
  organizationId: string,
  employeeId: string,
) {
  return tx
    .select()
    .from(payrollSalaryHistory)
    .where(
      and(
        eq(payrollSalaryHistory.organizationId, organizationId),
        eq(payrollSalaryHistory.employeeId, employeeId),
      ),
    )
    .orderBy(desc(payrollSalaryHistory.effectiveFrom), desc(payrollSalaryHistory.createdAt));
}

/** The end of the latest period of a POSTED or PAID pay run (history is closed up to it). */
export async function latestPostedPeriodEnd(tx: Transaction, organizationId: string) {
  const result = await tx.execute<{ d: string | null }>(
    sql`SELECT max(period_end)::text AS d FROM payroll_runs WHERE organization_id = ${organizationId} AND status IN ('POSTED', 'PAID')`,
  );
  return result.rows[0]?.d ?? null;
}

// Notifications -------------------------------------------------------------------

export async function sentNotificationFor(
  tx: Transaction,
  organizationId: string,
  payslipId: string,
) {
  const [row] = await tx
    .select({ id: payrollPayslipNotifications.id })
    .from(payrollPayslipNotifications)
    .where(
      and(
        eq(payrollPayslipNotifications.organizationId, organizationId),
        eq(payrollPayslipNotifications.payslipId, payslipId),
        eq(payrollPayslipNotifications.status, 'SENT'),
      ),
    );
  return row;
}

export async function insertNotification(
  tx: Transaction,
  values: typeof payrollPayslipNotifications.$inferInsert,
) {
  const [row] = await tx.insert(payrollPayslipNotifications).values(values).returning();
  return row!;
}

export async function notificationsOfPayslips(
  tx: Transaction,
  organizationId: string,
  payslipIds: readonly string[],
) {
  if (!payslipIds.length) return [];
  return tx
    .select()
    .from(payrollPayslipNotifications)
    .where(
      and(
        eq(payrollPayslipNotifications.organizationId, organizationId),
        inArray(payrollPayslipNotifications.payslipId, [...payslipIds]),
      ),
    )
    .orderBy(asc(payrollPayslipNotifications.createdAt));
}

// Salary on a date ------------------------------------------------------------------

/** The timeline of one employee: each distinct effective date with the latest decision for it. */
export function salaryTimeline(rows: readonly SalaryChange[]): { from: string; salary: string }[] {
  const byDate = new Map<string, SalaryChange>();
  for (const r of rows) {
    const existing = byDate.get(r.effectiveFrom);
    if (!existing || r.createdAt >= existing.createdAt) byDate.set(r.effectiveFrom, r);
  }
  return [...byDate.values()]
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
    .map((r) => ({ from: r.effectiveFrom, salary: r.basicSalary }));
}

/** The salary in effect on a date (the earliest decision if the date precedes all of them). */
export function salaryOn(timeline: readonly { from: string; salary: string }[], isoDate: string) {
  let current = timeline[0]?.salary ?? '0';
  for (const t of timeline) {
    if (t.from <= isoDate) current = t.salary;
  }
  return current;
}
