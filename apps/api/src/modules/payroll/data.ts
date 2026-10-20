import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  payrollComponents,
  payrollEmployeeComponents,
  payrollEmployees,
  payrollNumberSequences,
  payrollPayslipLines,
  payrollPayslips,
  payrollRuns,
  payrollSettings,
} from './schema.js';

export type PayrollSettings = typeof payrollSettings.$inferSelect;
export type PayrollEmployee = typeof payrollEmployees.$inferSelect;
export type PayrollComponent = typeof payrollComponents.$inferSelect;
export type PayrollRun = typeof payrollRuns.$inferSelect;
export type Payslip = typeof payrollPayslips.$inferSelect;
export type PayslipLine = typeof payrollPayslipLines.$inferSelect;
export type EmployeeComponent = typeof payrollEmployeeComponents.$inferSelect;

// ---------------------------------------------------------------------------
// Settings and numbering
// ---------------------------------------------------------------------------

export async function getPayrollSettings(tx: Transaction, organizationId: string) {
  const [row] = await tx
    .select()
    .from(payrollSettings)
    .where(eq(payrollSettings.organizationId, organizationId));
  return row;
}

export async function savePayrollSettings(
  tx: Transaction,
  input: {
    organizationId: string;
    version: number;
    values: Omit<typeof payrollSettings.$inferInsert, 'organizationId' | 'version'>;
  },
): Promise<PayrollSettings | undefined> {
  if (input.version === 0) {
    const [row] = await tx
      .insert(payrollSettings)
      .values({ organizationId: input.organizationId, ...input.values })
      .onConflictDoNothing()
      .returning();
    return row;
  }
  const [row] = await tx
    .update(payrollSettings)
    .set({ ...input.values, version: sql`${payrollSettings.version} + 1` })
    .where(
      and(
        eq(payrollSettings.organizationId, input.organizationId),
        eq(payrollSettings.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function takeNextPayrollNumber(
  tx: Transaction,
  organizationId: string,
  documentType: 'employee' | 'run' | 'advance',
): Promise<string> {
  await tx
    .insert(payrollNumberSequences)
    .values({
      organizationId,
      documentType,
      prefix: documentType === 'employee' ? 'EMP-' : documentType === 'run' ? 'PAY-' : 'ADV-',
    })
    .onConflictDoNothing();
  const [row] = await tx
    .update(payrollNumberSequences)
    .set({ nextNumber: sql`${payrollNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(payrollNumberSequences.organizationId, organizationId),
        eq(payrollNumberSequences.documentType, documentType),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export async function insertEmployee(
  tx: Transaction,
  values: typeof payrollEmployees.$inferInsert,
) {
  const [row] = await tx.insert(payrollEmployees).values(values).returning();
  return row!;
}

export async function getEmployee(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(payrollEmployees)
    .where(and(eq(payrollEmployees.organizationId, organizationId), eq(payrollEmployees.id, id)));
  return row;
}

export async function listEmployees(tx: Transaction, organizationId: string) {
  return tx
    .select()
    .from(payrollEmployees)
    .where(eq(payrollEmployees.organizationId, organizationId))
    .orderBy(asc(payrollEmployees.number));
}

export async function updateEmployee(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof payrollEmployees.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(payrollEmployees)
    .set({ ...input.set, version: sql`${payrollEmployees.version} + 1` })
    .where(
      and(
        eq(payrollEmployees.organizationId, input.organizationId),
        eq(payrollEmployees.id, input.id),
        eq(payrollEmployees.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function employeeByUser(tx: Transaction, organizationId: string, userId: string) {
  const [row] = await tx
    .select()
    .from(payrollEmployees)
    .where(
      and(eq(payrollEmployees.organizationId, organizationId), eq(payrollEmployees.userId, userId)),
    );
  return row;
}

export async function listEmployeeComponents(
  tx: Transaction,
  organizationId: string,
  employeeIds: readonly string[],
): Promise<EmployeeComponent[]> {
  if (!employeeIds.length) return [];
  return tx
    .select()
    .from(payrollEmployeeComponents)
    .where(
      and(
        eq(payrollEmployeeComponents.organizationId, organizationId),
        inArray(payrollEmployeeComponents.employeeId, [...employeeIds]),
      ),
    );
}

export async function replaceEmployeeComponents(
  tx: Transaction,
  organizationId: string,
  employeeId: string,
  assignments: readonly { componentId: string; value: string | null }[],
) {
  await tx
    .delete(payrollEmployeeComponents)
    .where(
      and(
        eq(payrollEmployeeComponents.organizationId, organizationId),
        eq(payrollEmployeeComponents.employeeId, employeeId),
      ),
    );
  if (assignments.length) {
    await tx
      .insert(payrollEmployeeComponents)
      .values(assignments.map((a) => ({ organizationId, employeeId, ...a })));
  }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export async function insertComponent(
  tx: Transaction,
  values: typeof payrollComponents.$inferInsert,
) {
  const [row] = await tx.insert(payrollComponents).values(values).returning();
  return row!;
}

export async function componentCodeExists(tx: Transaction, organizationId: string, code: string) {
  const [row] = await tx
    .select({ id: payrollComponents.id })
    .from(payrollComponents)
    .where(
      and(eq(payrollComponents.organizationId, organizationId), eq(payrollComponents.code, code)),
    )
    .limit(1);
  return Boolean(row);
}

export async function getComponent(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(payrollComponents)
    .where(and(eq(payrollComponents.organizationId, organizationId), eq(payrollComponents.id, id)));
  return row;
}

export async function listComponents(tx: Transaction, organizationId: string) {
  return tx
    .select()
    .from(payrollComponents)
    .where(eq(payrollComponents.organizationId, organizationId))
    .orderBy(asc(payrollComponents.code));
}

export async function updateComponent(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof payrollComponents.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(payrollComponents)
    .set({ ...input.set, version: sql`${payrollComponents.version} + 1` })
    .where(
      and(
        eq(payrollComponents.organizationId, input.organizationId),
        eq(payrollComponents.id, input.id),
        eq(payrollComponents.version, input.version),
      ),
    )
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Runs and payslips
// ---------------------------------------------------------------------------

export async function insertRun(tx: Transaction, values: typeof payrollRuns.$inferInsert) {
  const [row] = await tx.insert(payrollRuns).values(values).returning();
  return row!;
}

export async function getRun(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.organizationId, organizationId), eq(payrollRuns.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listRuns(tx: Transaction, organizationId: string, limit: number) {
  return tx
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.organizationId, organizationId))
    .orderBy(desc(payrollRuns.periodEnd), desc(payrollRuns.id))
    .limit(limit);
}

/** A live (not void) run whose period overlaps the given one. */
export async function overlappingRun(
  tx: Transaction,
  organizationId: string,
  period: { start: string; end: string },
  excludeId?: string,
) {
  const [row] = await tx
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.organizationId, organizationId),
        ne(payrollRuns.status, 'VOID'),
        sql`${payrollRuns.periodStart} <= ${period.end}::date`,
        sql`${payrollRuns.periodEnd} >= ${period.start}::date`,
        excludeId ? ne(payrollRuns.id, excludeId) : sql`true`,
      ),
    )
    .limit(1);
  return row;
}

export async function updateRun(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof payrollRuns.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(payrollRuns)
    .set({ ...input.set, version: sql`${payrollRuns.version} + 1` })
    .where(
      and(
        eq(payrollRuns.organizationId, input.organizationId),
        eq(payrollRuns.id, input.id),
        eq(payrollRuns.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function deleteRunPayslips(tx: Transaction, organizationId: string, runId: string) {
  const ids = (
    await tx
      .select({ id: payrollPayslips.id })
      .from(payrollPayslips)
      .where(
        and(eq(payrollPayslips.organizationId, organizationId), eq(payrollPayslips.runId, runId)),
      )
  ).map((r) => r.id);
  if (!ids.length) return;
  await tx
    .delete(payrollPayslipLines)
    .where(
      and(
        eq(payrollPayslipLines.organizationId, organizationId),
        inArray(payrollPayslipLines.payslipId, ids),
      ),
    );
  await tx
    .delete(payrollPayslips)
    .where(
      and(eq(payrollPayslips.organizationId, organizationId), eq(payrollPayslips.runId, runId)),
    );
}

export async function insertPayslip(tx: Transaction, values: typeof payrollPayslips.$inferInsert) {
  const [row] = await tx.insert(payrollPayslips).values(values).returning();
  return row!;
}

export async function insertPayslipLines(
  tx: Transaction,
  values: (typeof payrollPayslipLines.$inferInsert)[],
) {
  if (values.length) await tx.insert(payrollPayslipLines).values(values);
}

export async function listPayslips(tx: Transaction, organizationId: string, runId: string) {
  return tx
    .select()
    .from(payrollPayslips)
    .where(
      and(eq(payrollPayslips.organizationId, organizationId), eq(payrollPayslips.runId, runId)),
    )
    .orderBy(asc(payrollPayslips.employeeNumber));
}

export async function getPayslip(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(payrollPayslips)
    .where(and(eq(payrollPayslips.organizationId, organizationId), eq(payrollPayslips.id, id)));
  return row;
}

export async function listPayslipLines(
  tx: Transaction,
  organizationId: string,
  payslipIds: readonly string[],
) {
  if (!payslipIds.length) return [];
  return tx
    .select()
    .from(payrollPayslipLines)
    .where(
      and(
        eq(payrollPayslipLines.organizationId, organizationId),
        inArray(payrollPayslipLines.payslipId, [...payslipIds]),
      ),
    )
    .orderBy(asc(payrollPayslipLines.payslipId), asc(payrollPayslipLines.lineNo));
}

/** The payslips of one user across POSTED and PAID runs, newest first. */
export async function listPayslipsOfUser(tx: Transaction, organizationId: string, userId: string) {
  return tx
    .select({ payslip: payrollPayslips, run: payrollRuns })
    .from(payrollPayslips)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.id, payrollPayslips.runId),
        eq(payrollRuns.organizationId, payrollPayslips.organizationId),
      ),
    )
    .where(
      and(
        eq(payrollPayslips.organizationId, organizationId),
        eq(payrollPayslips.employeeUserId, userId),
        inArray(payrollRuns.status, ['POSTED', 'PAID']),
      ),
    )
    .orderBy(desc(payrollRuns.periodEnd));
}
