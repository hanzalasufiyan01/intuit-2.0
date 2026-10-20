import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  projectMembers,
  projectNumberSequences,
  projectTasks,
  projects,
  projectTimeEntries,
  type ProjectStatus,
  type TimeEntryStatus,
} from './schema.js';

export type Project = typeof projects.$inferSelect;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type TimeEntry = typeof projectTimeEntries.$inferSelect;
export type ProjectTask = typeof projectTasks.$inferSelect;

export async function takeNextProjectNumber(tx: Transaction, organizationId: string) {
  await tx
    .insert(projectNumberSequences)
    .values({ organizationId, documentType: 'project', prefix: 'PRJ-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(projectNumberSequences)
    .set({ nextNumber: sql`${projectNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(projectNumberSequences.organizationId, organizationId),
        eq(projectNumberSequences.documentType, 'project'),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

export async function insertProject(tx: Transaction, values: typeof projects.$inferInsert) {
  const [row] = await tx.insert(projects).values(values).returning();
  return row!;
}

export async function getProject(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listProjects(
  tx: Transaction,
  organizationId: string,
  filter: { status?: ProjectStatus | undefined } = {},
) {
  return tx
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        filter.status ? eq(projects.status, filter.status) : sql`true`,
      ),
    )
    .orderBy(desc(projects.createdAt), desc(projects.id));
}

export async function updateProject(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof projects.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(projects)
    .set({ ...input.set, version: sql`${projects.version} + 1` })
    .where(
      and(
        eq(projects.organizationId, input.organizationId),
        eq(projects.id, input.id),
        eq(projects.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function listMembers(tx: Transaction, organizationId: string, projectId: string) {
  return tx
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, organizationId),
        eq(projectMembers.projectId, projectId),
      ),
    );
}

export async function getMember(
  tx: Transaction,
  organizationId: string,
  projectId: string,
  userId: string,
) {
  const [row] = await tx
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, organizationId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    );
  return row;
}

export async function replaceMembers(
  tx: Transaction,
  organizationId: string,
  projectId: string,
  members: readonly { userId: string; billRate: string | null; costRate: string }[],
) {
  await tx
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, organizationId),
        eq(projectMembers.projectId, projectId),
      ),
    );
  if (members.length) {
    await tx
      .insert(projectMembers)
      .values(members.map((m) => ({ organizationId, projectId, ...m })));
  }
}

export async function insertTimeEntry(
  tx: Transaction,
  values: typeof projectTimeEntries.$inferInsert,
) {
  const [row] = await tx.insert(projectTimeEntries).values(values).returning();
  return row!;
}

export async function getTimeEntry(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(projectTimeEntries)
    .where(
      and(eq(projectTimeEntries.organizationId, organizationId), eq(projectTimeEntries.id, id)),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listTimeEntries(
  tx: Transaction,
  organizationId: string,
  filter: {
    projectId?: string | undefined;
    userId?: string | undefined;
    status?: TimeEntryStatus | undefined;
    from?: string | undefined;
    to?: string | undefined;
    limit: number;
  },
) {
  return tx
    .select()
    .from(projectTimeEntries)
    .where(
      and(
        eq(projectTimeEntries.organizationId, organizationId),
        filter.projectId ? eq(projectTimeEntries.projectId, filter.projectId) : sql`true`,
        filter.userId ? eq(projectTimeEntries.userId, filter.userId) : sql`true`,
        filter.status ? eq(projectTimeEntries.status, filter.status) : sql`true`,
        filter.from ? sql`${projectTimeEntries.workDate} >= ${filter.from}::date` : sql`true`,
        filter.to ? sql`${projectTimeEntries.workDate} <= ${filter.to}::date` : sql`true`,
      ),
    )
    .orderBy(desc(projectTimeEntries.workDate), desc(projectTimeEntries.id))
    .limit(filter.limit);
}

export async function updateTimeEntry(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof projectTimeEntries.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(projectTimeEntries)
    .set({ ...input.set, version: sql`${projectTimeEntries.version} + 1` })
    .where(
      and(
        eq(projectTimeEntries.organizationId, input.organizationId),
        eq(projectTimeEntries.id, input.id),
        eq(projectTimeEntries.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function deleteTimeEntry(tx: Transaction, organizationId: string, id: string) {
  await tx
    .delete(projectTimeEntries)
    .where(
      and(eq(projectTimeEntries.organizationId, organizationId), eq(projectTimeEntries.id, id)),
    );
}

/** Hours the user already logged on a date (excluding one entry when editing). */
export async function hoursLoggedOn(
  tx: Transaction,
  organizationId: string,
  userId: string,
  workDate: string,
  excludeId?: string,
): Promise<string> {
  const [row] = await tx
    .select({ hours: sql<string>`coalesce(sum(${projectTimeEntries.hours}), 0)::text` })
    .from(projectTimeEntries)
    .where(
      and(
        eq(projectTimeEntries.organizationId, organizationId),
        eq(projectTimeEntries.userId, userId),
        eq(projectTimeEntries.workDate, workDate),
        excludeId ? sql`${projectTimeEntries.id} <> ${excludeId}` : sql`true`,
      ),
    );
  return row!.hours;
}

export async function billableApprovedEntries(
  tx: Transaction,
  organizationId: string,
  projectId: string,
  upTo: string,
) {
  return tx
    .select()
    .from(projectTimeEntries)
    .where(
      and(
        eq(projectTimeEntries.organizationId, organizationId),
        eq(projectTimeEntries.projectId, projectId),
        eq(projectTimeEntries.status, 'APPROVED'),
        eq(projectTimeEntries.billable, true),
        sql`${projectTimeEntries.workDate} <= ${upTo}::date`,
      ),
    )
    .orderBy(asc(projectTimeEntries.workDate), asc(projectTimeEntries.id))
    .for('update');
}

export async function entriesOfInvoice(tx: Transaction, organizationId: string, invoiceId: string) {
  return tx
    .select()
    .from(projectTimeEntries)
    .where(
      and(
        eq(projectTimeEntries.organizationId, organizationId),
        eq(projectTimeEntries.invoiceId, invoiceId),
      ),
    );
}

export async function entriesByIds(
  tx: Transaction,
  organizationId: string,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return tx
    .select()
    .from(projectTimeEntries)
    .where(
      and(
        eq(projectTimeEntries.organizationId, organizationId),
        inArray(projectTimeEntries.id, [...ids]),
      ),
    );
}

/** Hours and amounts per project and status, for the summary report. */
export async function timeTotals(tx: Transaction, organizationId: string, projectId?: string) {
  const result = await tx.execute<{
    project_id: string;
    status: TimeEntryStatus;
    billable: boolean;
    hours: string;
    bill_amount: string;
    cost_amount: string;
  }>(sql`
    SELECT project_id, status, billable, sum(hours)::text AS hours,
           sum(hours * bill_rate)::text AS bill_amount, sum(hours * cost_rate)::text AS cost_amount
      FROM project_time_entries
     WHERE organization_id = ${organizationId}
       ${projectId ? sql`AND project_id = ${projectId}` : sql``}
     GROUP BY project_id, status, billable`);
  return result.rows;
}

/** Revenue and cost on the books for dimension values: posted journal lines tagged with them. */
export async function ledgerResult(
  tx: Transaction,
  organizationId: string,
  dimensionValueIds: readonly string[],
) {
  if (!dimensionValueIds.length) return [];
  const result = await tx.execute<{
    dimension_value_id: string;
    revenue: string;
    cost: string;
  }>(sql`
    SELECT d.dimension_value_id,
           coalesce(sum(CASE WHEN a.account_type = 'REVENUE'
                             THEN coalesce(l.base_credit, 0) - coalesce(l.base_debit, 0) END), 0)::text AS revenue,
           coalesce(sum(CASE WHEN a.account_type = 'EXPENSE'
                             THEN coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0) END), 0)::text AS cost
      FROM accounting_journal_line_dimensions d
      JOIN accounting_journal_lines l ON l.id = d.journal_line_id AND l.organization_id = d.organization_id
      JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      JOIN accounting_accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
     WHERE d.organization_id = ${organizationId}
       AND d.dimension_value_id IN (${sql.join(
         dimensionValueIds.map((id) => sql`${id}`),
         sql`, `,
       )})
       AND j.status IN ('POSTED', 'REVERSED')
     GROUP BY d.dimension_value_id`);
  return result.rows;
}

// Tasks (migration 0072) ---------------------------------------------------------

export async function insertTask(tx: Transaction, values: typeof projectTasks.$inferInsert) {
  const [row] = await tx.insert(projectTasks).values(values).returning();
  return row!;
}

export async function getTask(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(projectTasks)
    .where(and(eq(projectTasks.organizationId, organizationId), eq(projectTasks.id, id)));
  return row;
}

export async function listTasks(tx: Transaction, organizationId: string, projectId: string) {
  return tx
    .select()
    .from(projectTasks)
    .where(
      and(eq(projectTasks.organizationId, organizationId), eq(projectTasks.projectId, projectId)),
    )
    .orderBy(asc(projectTasks.name), asc(projectTasks.id));
}

export async function taskNameExists(
  tx: Transaction,
  organizationId: string,
  projectId: string,
  name: string,
  excludeId?: string,
) {
  const [row] = await tx
    .select({ id: projectTasks.id })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.organizationId, organizationId),
        eq(projectTasks.projectId, projectId),
        sql`lower(${projectTasks.name}) = lower(${name})`,
        excludeId ? sql`${projectTasks.id} <> ${excludeId}` : sql`true`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function updateTask(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof projectTasks.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(projectTasks)
    .set({ ...input.set, version: sql`${projectTasks.version} + 1` })
    .where(
      and(
        eq(projectTasks.organizationId, input.organizationId),
        eq(projectTasks.id, input.id),
        eq(projectTasks.version, input.version),
      ),
    )
    .returning();
  return row;
}

/** Hours counted against budgets (approved and billed) per task of a project; null is "no task". */
export async function taskHours(tx: Transaction, organizationId: string, projectId: string) {
  const result = await tx.execute<{ task_id: string | null; hours: string }>(sql`
    SELECT task_id, sum(hours)::text AS hours
      FROM project_time_entries
     WHERE organization_id = ${organizationId} AND project_id = ${projectId}
       AND status IN ('APPROVED', 'BILLED')
     GROUP BY task_id`);
  return new Map(result.rows.map((r) => [r.task_id, r.hours]));
}
