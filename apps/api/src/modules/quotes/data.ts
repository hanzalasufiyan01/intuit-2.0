import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  quoteNumberSequences,
  recurringInvoiceLines,
  recurringInvoiceRuns,
  recurringInvoiceSchedules,
  salesQuoteLines,
  salesQuotes,
  type QuoteStatus,
  type ScheduleStatus,
} from './schema.js';

export type Quote = typeof salesQuotes.$inferSelect;
export type QuoteLine = typeof salesQuoteLines.$inferSelect;
export type Schedule = typeof recurringInvoiceSchedules.$inferSelect;
export type ScheduleLine = typeof recurringInvoiceLines.$inferSelect;

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export async function takeNextQuoteNumber(tx: Transaction, organizationId: string) {
  await tx
    .insert(quoteNumberSequences)
    .values({ organizationId, documentType: 'quote', prefix: 'QUO-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(quoteNumberSequences)
    .set({ nextNumber: sql`${quoteNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(quoteNumberSequences.organizationId, organizationId),
        eq(quoteNumberSequences.documentType, 'quote'),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

export async function insertQuote(tx: Transaction, values: typeof salesQuotes.$inferInsert) {
  const [row] = await tx.insert(salesQuotes).values(values).returning();
  return row!;
}

export async function getQuote(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(salesQuotes)
    .where(and(eq(salesQuotes.organizationId, organizationId), eq(salesQuotes.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listQuotes(
  tx: Transaction,
  organizationId: string,
  filter: { status?: QuoteStatus | undefined; customerId?: string | undefined; limit: number },
) {
  return tx
    .select()
    .from(salesQuotes)
    .where(
      and(
        eq(salesQuotes.organizationId, organizationId),
        filter.status ? eq(salesQuotes.status, filter.status) : sql`true`,
        filter.customerId ? eq(salesQuotes.customerId, filter.customerId) : sql`true`,
      ),
    )
    .orderBy(desc(salesQuotes.quoteDate), desc(salesQuotes.id))
    .limit(filter.limit);
}

export async function updateQuote(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof salesQuotes.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(salesQuotes)
    .set({ ...input.set, version: sql`${salesQuotes.version} + 1` })
    .where(
      and(
        eq(salesQuotes.organizationId, input.organizationId),
        eq(salesQuotes.id, input.id),
        eq(salesQuotes.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function deleteQuote(tx: Transaction, organizationId: string, id: string) {
  await tx
    .delete(salesQuoteLines)
    .where(
      and(eq(salesQuoteLines.organizationId, organizationId), eq(salesQuoteLines.quoteId, id)),
    );
  await tx
    .delete(salesQuotes)
    .where(and(eq(salesQuotes.organizationId, organizationId), eq(salesQuotes.id, id)));
}

export async function replaceQuoteLines(
  tx: Transaction,
  organizationId: string,
  quoteId: string,
  lines: readonly Omit<
    typeof salesQuoteLines.$inferInsert,
    'organizationId' | 'quoteId' | 'lineNo'
  >[],
) {
  await tx
    .delete(salesQuoteLines)
    .where(
      and(eq(salesQuoteLines.organizationId, organizationId), eq(salesQuoteLines.quoteId, quoteId)),
    );
  if (lines.length) {
    await tx
      .insert(salesQuoteLines)
      .values(lines.map((l, i) => ({ organizationId, quoteId, lineNo: i + 1, ...l })));
  }
}

export async function getQuoteLines(tx: Transaction, organizationId: string, quoteId: string) {
  return tx
    .select()
    .from(salesQuoteLines)
    .where(
      and(eq(salesQuoteLines.organizationId, organizationId), eq(salesQuoteLines.quoteId, quoteId)),
    )
    .orderBy(asc(salesQuoteLines.lineNo));
}

// ---------------------------------------------------------------------------
// Recurring schedules
// ---------------------------------------------------------------------------

export async function insertSchedule(
  tx: Transaction,
  values: typeof recurringInvoiceSchedules.$inferInsert,
) {
  const [row] = await tx.insert(recurringInvoiceSchedules).values(values).returning();
  return row!;
}

export async function getSchedule(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(recurringInvoiceSchedules)
    .where(
      and(
        eq(recurringInvoiceSchedules.organizationId, organizationId),
        eq(recurringInvoiceSchedules.id, id),
      ),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listSchedules(
  tx: Transaction,
  organizationId: string,
  filter: { status?: ScheduleStatus | undefined } = {},
) {
  return tx
    .select()
    .from(recurringInvoiceSchedules)
    .where(
      and(
        eq(recurringInvoiceSchedules.organizationId, organizationId),
        filter.status ? eq(recurringInvoiceSchedules.status, filter.status) : sql`true`,
      ),
    )
    .orderBy(asc(recurringInvoiceSchedules.nextRunDate), asc(recurringInvoiceSchedules.id));
}

export async function updateSchedule(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof recurringInvoiceSchedules.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(recurringInvoiceSchedules)
    .set({ ...input.set, version: sql`${recurringInvoiceSchedules.version} + 1` })
    .where(
      and(
        eq(recurringInvoiceSchedules.organizationId, input.organizationId),
        eq(recurringInvoiceSchedules.id, input.id),
        eq(recurringInvoiceSchedules.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function replaceScheduleLines(
  tx: Transaction,
  organizationId: string,
  scheduleId: string,
  lines: readonly Omit<
    typeof recurringInvoiceLines.$inferInsert,
    'organizationId' | 'scheduleId' | 'lineNo'
  >[],
) {
  await tx
    .delete(recurringInvoiceLines)
    .where(
      and(
        eq(recurringInvoiceLines.organizationId, organizationId),
        eq(recurringInvoiceLines.scheduleId, scheduleId),
      ),
    );
  if (lines.length) {
    await tx
      .insert(recurringInvoiceLines)
      .values(lines.map((l, i) => ({ organizationId, scheduleId, lineNo: i + 1, ...l })));
  }
}

export async function getScheduleLines(
  tx: Transaction,
  organizationId: string,
  scheduleId: string,
) {
  return tx
    .select()
    .from(recurringInvoiceLines)
    .where(
      and(
        eq(recurringInvoiceLines.organizationId, organizationId),
        eq(recurringInvoiceLines.scheduleId, scheduleId),
      ),
    )
    .orderBy(asc(recurringInvoiceLines.lineNo));
}

export async function findRun(
  tx: Transaction,
  organizationId: string,
  scheduleId: string,
  runDate: string,
) {
  const [row] = await tx
    .select()
    .from(recurringInvoiceRuns)
    .where(
      and(
        eq(recurringInvoiceRuns.organizationId, organizationId),
        eq(recurringInvoiceRuns.scheduleId, scheduleId),
        eq(recurringInvoiceRuns.runDate, runDate),
      ),
    );
  return row;
}

export async function insertRun(tx: Transaction, values: typeof recurringInvoiceRuns.$inferInsert) {
  const [row] = await tx.insert(recurringInvoiceRuns).values(values).returning();
  return row!;
}

export async function listRuns(tx: Transaction, organizationId: string, scheduleId: string) {
  return tx
    .select()
    .from(recurringInvoiceRuns)
    .where(
      and(
        eq(recurringInvoiceRuns.organizationId, organizationId),
        eq(recurringInvoiceRuns.scheduleId, scheduleId),
      ),
    )
    .orderBy(desc(recurringInvoiceRuns.runDate));
}

/** Schedules due on or before a date, across organizations (ids only; SECURITY DEFINER). */
export async function dueSchedules(tx: Transaction, asOf: string, batch: number) {
  const result = await tx.execute<{
    organization_id: string;
    schedule_id: string;
    acting_user_id: string;
  }>(
    sql`SELECT organization_id, schedule_id, acting_user_id FROM app_due_recurring_schedules(${asOf}::date, ${batch})`,
  );
  return result.rows.map((r) => ({
    organizationId: r.organization_id,
    scheduleId: r.schedule_id,
    actingUserId: r.acting_user_id,
  }));
}
