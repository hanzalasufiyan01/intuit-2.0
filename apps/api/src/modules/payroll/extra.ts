import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { boolean, date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';

/** Payroll leave and salary advances (migration 0073). */

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });

export const leaveStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof leaveStatuses)[number];

export const payrollLeaveTypes = pgTable('payroll_leave_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  daysPerYear: numeric('days_per_year', { precision: 8, scale: 2 }).notNull(),
  allowNegative: boolean('allow_negative').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const payrollLeaveRequests = pgTable('payroll_leave_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  leaveTypeId: uuid('leave_type_id').notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  days: numeric('days', { precision: 8, scale: 2 }).notNull(),
  reason: text('reason').notNull().default(''),
  status: text('status', { enum: leaveStatuses }).notNull().default('PENDING'),
  decidedByUserId: uuid('decided_by_user_id'),
  decidedAt: timestamptz('decided_at'),
  decisionNote: text('decision_note'),
  requestedByUserId: uuid('requested_by_user_id').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamptz('created_at').notNull(),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const payrollAdvances = pgTable('payroll_advances', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  employeeId: uuid('employee_id').notNull(),
  grantedDate: date('granted_date', { mode: 'string' }).notNull(),
  principal: money('principal').notNull(),
  installment: money('installment').notNull(),
  note: text('note').notNull().default(''),
  status: text('status', { enum: ['ACTIVE', 'CANCELLED'] })
    .notNull()
    .default('ACTIVE'),
  bankAccountId: uuid('bank_account_id').notNull(),
  journalId: uuid('journal_id').notNull(),
  accountingEventId: uuid('accounting_event_id').notNull(),
  cancelReason: text('cancel_reason'),
  cancelJournalId: uuid('cancel_journal_id'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const payrollAdvanceRepayments = pgTable('payroll_advance_repayments', {
  organizationId: uuid('organization_id').notNull(),
  advanceId: uuid('advance_id').notNull(),
  runId: uuid('run_id').notNull(),
  payslipId: uuid('payslip_id').notNull(),
  amount: money('amount').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export type LeaveType = typeof payrollLeaveTypes.$inferSelect;
export type LeaveRequest = typeof payrollLeaveRequests.$inferSelect;
export type Advance = typeof payrollAdvances.$inferSelect;

// Leave ------------------------------------------------------------------------

export async function insertLeaveType(
  tx: Transaction,
  values: typeof payrollLeaveTypes.$inferInsert,
) {
  const [row] = await tx.insert(payrollLeaveTypes).values(values).returning();
  return row!;
}

export async function getLeaveType(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(payrollLeaveTypes)
    .where(and(eq(payrollLeaveTypes.organizationId, organizationId), eq(payrollLeaveTypes.id, id)));
  return row;
}

export async function leaveTypeCodeExists(tx: Transaction, organizationId: string, code: string) {
  const [row] = await tx
    .select({ id: payrollLeaveTypes.id })
    .from(payrollLeaveTypes)
    .where(
      and(eq(payrollLeaveTypes.organizationId, organizationId), eq(payrollLeaveTypes.code, code)),
    )
    .limit(1);
  return Boolean(row);
}

export async function listLeaveTypes(tx: Transaction, organizationId: string) {
  return tx
    .select()
    .from(payrollLeaveTypes)
    .where(eq(payrollLeaveTypes.organizationId, organizationId))
    .orderBy(asc(payrollLeaveTypes.code));
}

export async function updateLeaveType(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof payrollLeaveTypes.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(payrollLeaveTypes)
    .set({ ...input.set, version: sql`${payrollLeaveTypes.version} + 1` })
    .where(
      and(
        eq(payrollLeaveTypes.organizationId, input.organizationId),
        eq(payrollLeaveTypes.id, input.id),
        eq(payrollLeaveTypes.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function insertLeaveRequest(
  tx: Transaction,
  values: typeof payrollLeaveRequests.$inferInsert,
) {
  const [row] = await tx.insert(payrollLeaveRequests).values(values).returning();
  return row!;
}

export async function getLeaveRequest(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(payrollLeaveRequests)
    .where(
      and(eq(payrollLeaveRequests.organizationId, organizationId), eq(payrollLeaveRequests.id, id)),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listLeaveRequests(
  tx: Transaction,
  organizationId: string,
  filter: { employeeId?: string | undefined; status?: LeaveStatus | undefined; limit: number },
) {
  return tx
    .select()
    .from(payrollLeaveRequests)
    .where(
      and(
        eq(payrollLeaveRequests.organizationId, organizationId),
        filter.employeeId ? eq(payrollLeaveRequests.employeeId, filter.employeeId) : sql`true`,
        filter.status ? eq(payrollLeaveRequests.status, filter.status) : sql`true`,
      ),
    )
    .orderBy(desc(payrollLeaveRequests.startDate), desc(payrollLeaveRequests.id))
    .limit(filter.limit);
}

export async function updateLeaveRequest(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof payrollLeaveRequests.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(payrollLeaveRequests)
    .set({ ...input.set, version: sql`${payrollLeaveRequests.version} + 1` })
    .where(
      and(
        eq(payrollLeaveRequests.organizationId, input.organizationId),
        eq(payrollLeaveRequests.id, input.id),
        eq(payrollLeaveRequests.version, input.version),
      ),
    )
    .returning();
  return row;
}

/** Another live (pending or approved) request of the employee overlapping the dates. */
export async function overlappingLeave(
  tx: Transaction,
  input: {
    organizationId: string;
    employeeId: string;
    startDate: string;
    endDate: string;
    excludeId?: string;
  },
) {
  const [row] = await tx
    .select({ id: payrollLeaveRequests.id })
    .from(payrollLeaveRequests)
    .where(
      and(
        eq(payrollLeaveRequests.organizationId, input.organizationId),
        eq(payrollLeaveRequests.employeeId, input.employeeId),
        sql`${payrollLeaveRequests.status} IN ('PENDING', 'APPROVED')`,
        sql`${payrollLeaveRequests.startDate} <= ${input.endDate}::date`,
        sql`${payrollLeaveRequests.endDate} >= ${input.startDate}::date`,
        input.excludeId ? sql`${payrollLeaveRequests.id} <> ${input.excludeId}` : sql`true`,
      ),
    )
    .limit(1);
  return row;
}

/** Days taken (approved) and waiting (pending) per leave type in a calendar year, by start date. */
export async function leaveUsage(
  tx: Transaction,
  organizationId: string,
  employeeId: string,
  year: number,
) {
  const result = await tx.execute<{ leave_type_id: string; status: string; days: string }>(sql`
    SELECT leave_type_id, status, sum(days)::text AS days
      FROM payroll_leave_requests
     WHERE organization_id = ${organizationId} AND employee_id = ${employeeId}
       AND status IN ('PENDING', 'APPROVED')
       AND extract(year FROM start_date) = ${year}
     GROUP BY leave_type_id, status`);
  return result.rows;
}

// Advances ----------------------------------------------------------------------

export async function insertAdvance(tx: Transaction, values: typeof payrollAdvances.$inferInsert) {
  const [row] = await tx.insert(payrollAdvances).values(values).returning();
  return row!;
}

export async function getAdvance(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(payrollAdvances)
    .where(and(eq(payrollAdvances.organizationId, organizationId), eq(payrollAdvances.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listAdvances(
  tx: Transaction,
  organizationId: string,
  filter: { employeeId?: string | undefined; limit: number },
) {
  return tx
    .select()
    .from(payrollAdvances)
    .where(
      and(
        eq(payrollAdvances.organizationId, organizationId),
        filter.employeeId ? eq(payrollAdvances.employeeId, filter.employeeId) : sql`true`,
      ),
    )
    .orderBy(desc(payrollAdvances.grantedDate), desc(payrollAdvances.id))
    .limit(filter.limit);
}

export async function updateAdvance(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof payrollAdvances.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(payrollAdvances)
    .set({ ...input.set, version: sql`${payrollAdvances.version} + 1` })
    .where(
      and(
        eq(payrollAdvances.organizationId, input.organizationId),
        eq(payrollAdvances.id, input.id),
        eq(payrollAdvances.version, input.version),
      ),
    )
    .returning();
  return row;
}

/** Repaid amount per advance: instalments of runs that are posted or paid (a void run gives it back). */
export async function repaidAmounts(
  tx: Transaction,
  organizationId: string,
  advanceIds?: readonly string[],
) {
  const filter = advanceIds?.length
    ? sql`AND r.advance_id IN (${sql.join(
        advanceIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  const result = await tx.execute<{ advance_id: string; repaid: string }>(sql`
    SELECT r.advance_id, sum(r.amount)::text AS repaid
      FROM payroll_advance_repayments r
      JOIN payroll_runs p ON p.id = r.run_id AND p.organization_id = r.organization_id
     WHERE r.organization_id = ${organizationId} AND p.status IN ('POSTED', 'PAID') ${filter}
     GROUP BY r.advance_id`);
  return new Map(result.rows.map((r) => [r.advance_id, r.repaid]));
}

export async function repaymentsOfAdvance(
  tx: Transaction,
  organizationId: string,
  advanceId: string,
) {
  const result = await tx.execute<{
    run_id: string;
    number: string;
    status: string;
    amount: string;
  }>(sql`
    SELECT r.run_id, p.number, p.status, r.amount::text AS amount
      FROM payroll_advance_repayments r
      JOIN payroll_runs p ON p.id = r.run_id AND p.organization_id = r.organization_id
     WHERE r.organization_id = ${organizationId} AND r.advance_id = ${advanceId}
     ORDER BY p.period_end`);
  return result.rows.map((r) => ({
    runId: r.run_id,
    runNumber: r.number,
    runStatus: r.status,
    amount: r.amount,
  }));
}

export async function insertRepayments(
  tx: Transaction,
  values: (typeof payrollAdvanceRepayments.$inferInsert)[],
) {
  if (values.length) await tx.insert(payrollAdvanceRepayments).values(values);
}

/** Active advances of employees granted on or before a date, for the pay-run calculation. */
export async function activeAdvancesFor(
  tx: Transaction,
  organizationId: string,
  employeeIds: readonly string[],
  onOrBefore: string,
) {
  if (!employeeIds.length) return [];
  return tx
    .select()
    .from(payrollAdvances)
    .where(
      and(
        eq(payrollAdvances.organizationId, organizationId),
        eq(payrollAdvances.status, 'ACTIVE'),
        sql`${payrollAdvances.employeeId} IN (${sql.join(
          employeeIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
        sql`${payrollAdvances.grantedDate} <= ${onOrBefore}::date`,
      ),
    )
    .orderBy(asc(payrollAdvances.grantedDate), asc(payrollAdvances.number));
}
