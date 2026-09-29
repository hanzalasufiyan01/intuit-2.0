import { and, asc, count, desc, eq, inArray, lt, ne, or } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import type { JournalLineInput } from './rules.js';
import {
  accountingJournalEntries,
  accountingJournalLines,
  accountingJournalReversals,
  type JournalLineKind,
  type JournalSource,
  type JournalStatus,
} from './schema.js';
import { insertLineDimensions, type DimensionAssignmentInput } from './dimensions.js';
import type { SourceRef } from './system-journals.js';

/** A draft line. Base amounts and kinds are only ever set by the system-journal path. */
export interface DraftLineInput extends JournalLineInput {
  kind?: JournalLineKind;
  baseDebit?: string | null;
  baseCredit?: string | null;
  /** Line-level dimension assignments (validated by the caller). */
  dimensions?: readonly DimensionAssignmentInput[] | undefined;
}

export type JournalEntry = typeof accountingJournalEntries.$inferSelect;
export type JournalLine = typeof accountingJournalLines.$inferSelect;

export interface DraftFields {
  entryDate: string | null;
  description: string;
  reference: string;
  currency: string;
  exchangeRate: string | null;
}

export async function createDraftJournal(
  tx: Transaction,
  input: DraftFields & {
    organizationId: string;
    lines: readonly DraftLineInput[];
    userId: string | null;
    source: JournalSource;
    /** Decision 12: set at creation, never changed. */
    sourceRef?: SourceRef | null;
    accountingEventId?: string | null;
    /** Defaults to 'manual' when a rate is supplied. Reversals keep the original's source. */
    exchangeRateSource?: JournalEntry['exchangeRateSource'];
  },
): Promise<JournalEntry> {
  const [journal] = await tx
    .insert(accountingJournalEntries)
    .values({
      organizationId: input.organizationId,
      source: input.source,
      entryDate: input.entryDate,
      description: input.description.trim(),
      reference: input.reference.trim(),
      currency: input.currency,
      exchangeRate: input.exchangeRate,
      exchangeRateSource: input.exchangeRate ? (input.exchangeRateSource ?? 'manual') : null,
      accountingEventId: input.accountingEventId ?? null,
      sourceModule: input.sourceRef?.module ?? null,
      sourceType: input.sourceRef?.type ?? null,
      sourceId: input.sourceRef?.id ?? null,
      createdByUserId: input.userId,
      updatedByUserId: input.userId,
    })
    .returning();
  await insertLines(tx, input.organizationId, journal!.id, input.lines);
  return journal!;
}

async function insertLines(
  tx: Transaction,
  organizationId: string,
  journalId: string,
  lines: readonly DraftLineInput[],
) {
  if (lines.length === 0) return;
  const inserted = await tx
    .insert(accountingJournalLines)
    .values(
      lines.map((line, i) => ({
        organizationId,
        journalId,
        lineNumber: i + 1,
        lineKind: line.kind ?? 'normal',
        accountId: line.accountId,
        description: line.description.trim(),
        debit: line.debit,
        credit: line.credit,
        baseDebit: line.baseDebit ?? null,
        baseCredit: line.baseCredit ?? null,
      })),
    )
    .returning({ id: accountingJournalLines.id, lineNumber: accountingJournalLines.lineNumber });
  const idByNumber = new Map(inserted.map((r) => [r.lineNumber, r.id]));
  await insertLineDimensions(
    tx,
    organizationId,
    lines.flatMap((line, i) =>
      (line.dimensions ?? []).map((d) => ({ journalLineId: idByNumber.get(i + 1)!, ...d })),
    ),
  );
}

/** Replaces a draft's header and lines (database triggers reject this for non-drafts). */
export async function replaceDraftJournal(
  tx: Transaction,
  input: DraftFields & {
    organizationId: string;
    journalId: string;
    lines: readonly JournalLineInput[];
    userId: string;
  },
): Promise<JournalEntry | undefined> {
  const [journal] = await tx
    .update(accountingJournalEntries)
    .set({
      entryDate: input.entryDate,
      description: input.description.trim(),
      reference: input.reference.trim(),
      currency: input.currency,
      exchangeRate: input.exchangeRate,
      exchangeRateSource: input.exchangeRate ? 'manual' : null,
      updatedByUserId: input.userId,
    })
    .where(
      and(
        eq(accountingJournalEntries.organizationId, input.organizationId),
        eq(accountingJournalEntries.id, input.journalId),
        eq(accountingJournalEntries.status, 'DRAFT'),
      ),
    )
    .returning();
  if (!journal) return undefined;
  await tx
    .delete(accountingJournalLines)
    .where(
      and(
        eq(accountingJournalLines.organizationId, input.organizationId),
        eq(accountingJournalLines.journalId, input.journalId),
      ),
    );
  await insertLines(tx, input.organizationId, input.journalId, input.lines);
  return journal;
}

export async function getJournal(
  tx: Transaction,
  organizationId: string,
  journalId: string,
  options: { forUpdate?: boolean } = {},
): Promise<JournalEntry | undefined> {
  const query = tx
    .select()
    .from(accountingJournalEntries)
    .where(
      and(
        eq(accountingJournalEntries.organizationId, organizationId),
        eq(accountingJournalEntries.id, journalId),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getJournalLines(
  tx: Transaction,
  organizationId: string,
  journalIds: readonly string[],
): Promise<JournalLine[]> {
  if (journalIds.length === 0) return [];
  return tx
    .select()
    .from(accountingJournalLines)
    .where(
      and(
        eq(accountingJournalLines.organizationId, organizationId),
        inArray(accountingJournalLines.journalId, [...journalIds]),
      ),
    )
    .orderBy(asc(accountingJournalLines.journalId), asc(accountingJournalLines.lineNumber));
}

export async function listJournals(
  tx: Transaction,
  organizationId: string,
  filter: { statuses?: JournalStatus[] | undefined; limit: number; before?: Date | undefined },
): Promise<JournalEntry[]> {
  const conditions = [eq(accountingJournalEntries.organizationId, organizationId)];
  if (filter.statuses?.length)
    conditions.push(inArray(accountingJournalEntries.status, filter.statuses));
  // S6 (L-9): discarded imported drafts are listed only when asked for explicitly.
  else conditions.push(ne(accountingJournalEntries.status, 'DISCARDED'));
  if (filter.before) conditions.push(lt(accountingJournalEntries.createdAt, filter.before));
  return tx
    .select()
    .from(accountingJournalEntries)
    .where(and(...conditions))
    .orderBy(desc(accountingJournalEntries.createdAt), desc(accountingJournalEntries.id))
    .limit(filter.limit);
}

export async function countJournals(
  tx: Transaction,
  organizationId: string,
  statuses: JournalStatus[],
): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(accountingJournalEntries)
    .where(
      and(
        eq(accountingJournalEntries.organizationId, organizationId),
        inArray(accountingJournalEntries.status, statuses),
      ),
    );
  return row?.n ?? 0;
}

/** Applies a lifecycle transition, guarded by the expected current status. */
export async function transitionJournal(
  tx: Transaction,
  input: {
    organizationId: string;
    journalId: string;
    from: JournalStatus;
    set: Partial<typeof accountingJournalEntries.$inferInsert>;
  },
): Promise<JournalEntry | undefined> {
  const [row] = await tx
    .update(accountingJournalEntries)
    .set(input.set)
    .where(
      and(
        eq(accountingJournalEntries.organizationId, input.organizationId),
        eq(accountingJournalEntries.id, input.journalId),
        eq(accountingJournalEntries.status, input.from),
      ),
    )
    .returning();
  return row;
}

export async function writeBaseAmounts(
  tx: Transaction,
  organizationId: string,
  lines: readonly {
    journalId: string;
    lineNumber: number;
    baseDebit: string | null;
    baseCredit: string | null;
    roundingAdjustment: string;
  }[],
): Promise<void> {
  for (const line of lines) {
    await tx
      .update(accountingJournalLines)
      .set({
        baseDebit: line.baseDebit,
        baseCredit: line.baseCredit,
        roundingAdjustment: line.roundingAdjustment,
      })
      .where(
        and(
          eq(accountingJournalLines.organizationId, organizationId),
          eq(accountingJournalLines.journalId, line.journalId),
          eq(accountingJournalLines.lineNumber, line.lineNumber),
        ),
      );
  }
}

export async function recordReversal(
  tx: Transaction,
  input: {
    organizationId: string;
    originalJournalId: string;
    reversalJournalId: string;
    reason: string;
    userId: string;
    now: Date;
  },
): Promise<void> {
  await tx.insert(accountingJournalReversals).values({
    organizationId: input.organizationId,
    originalJournalId: input.originalJournalId,
    reversalJournalId: input.reversalJournalId,
    reason: input.reason.trim(),
    createdByUserId: input.userId,
    createdAt: input.now,
  });
}

export async function getReversalLinks(tx: Transaction, organizationId: string, journalId: string) {
  const rows = await tx
    .select()
    .from(accountingJournalReversals)
    .where(
      and(
        eq(accountingJournalReversals.organizationId, organizationId),
        or(
          eq(accountingJournalReversals.originalJournalId, journalId),
          eq(accountingJournalReversals.reversalJournalId, journalId),
        ),
      ),
    );
  return {
    reversedBy: rows.find((r) => r.originalJournalId === journalId),
    reverses: rows.find((r) => r.reversalJournalId === journalId),
  };
}
