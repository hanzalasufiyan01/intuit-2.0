import { and, asc, eq } from 'drizzle-orm';
import { numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';

/**
 * One-off pay-run amounts (migration 0089, master specification section 17): bonuses,
 * commissions, overtime pay. An amount entered by payroll staff for one employee in one DRAFT
 * run, using an existing fixed-amount pay component. No hours, rate or statutory rule is applied.
 */

export const payrollRunAdjustments = pgTable('payroll_run_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  runId: uuid('run_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  componentId: uuid('component_id').notNull(),
  amount: numeric('amount', { precision: 28, scale: 4 }).notNull(),
  note: text('note').notNull().default(''),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export type RunAdjustment = typeof payrollRunAdjustments.$inferSelect;

export async function listRunAdjustments(tx: Transaction, organizationId: string, runId: string) {
  return tx
    .select()
    .from(payrollRunAdjustments)
    .where(
      and(
        eq(payrollRunAdjustments.organizationId, organizationId),
        eq(payrollRunAdjustments.runId, runId),
      ),
    )
    .orderBy(asc(payrollRunAdjustments.createdAt), asc(payrollRunAdjustments.id));
}

export async function insertRunAdjustment(
  tx: Transaction,
  values: typeof payrollRunAdjustments.$inferInsert,
) {
  const [row] = await tx.insert(payrollRunAdjustments).values(values).returning();
  return row!;
}

export async function deleteRunAdjustment(
  tx: Transaction,
  organizationId: string,
  runId: string,
  id: string,
) {
  const rows = await tx
    .delete(payrollRunAdjustments)
    .where(
      and(
        eq(payrollRunAdjustments.organizationId, organizationId),
        eq(payrollRunAdjustments.runId, runId),
        eq(payrollRunAdjustments.id, id),
      ),
    )
    .returning();
  return rows[0];
}
