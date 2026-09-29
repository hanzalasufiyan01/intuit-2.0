import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import type { RevaluationExposure } from './revaluation.js';
import {
  accountingJournalEntries,
  accountingRevaluationLines,
  accountingRevaluationRunJournals,
  accountingRevaluationRuns,
  type RevaluationJournalRole,
  type RevaluationRunStatus,
} from './schema.js';

/**
 * Revaluation data access (S9): exposures from the ledger, runs, their lines and their journal
 * links. No posting happens here; the revaluation service posts through the journal engine.
 */

export type RevaluationRun = typeof accountingRevaluationRuns.$inferSelect;
export type RevaluationLine = typeof accountingRevaluationLines.$inferSelect;
export type RevaluationRunJournal = typeof accountingRevaluationRunJournals.$inferSelect;

/** Serializes revaluation runs of one organization for the rest of the transaction. */
export async function lockRevaluation(tx: Transaction, organizationId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('accounting.revaluation'), hashtext(${organizationId}))`,
  );
}

export interface AccountExposureRow extends RevaluationExposure {
  status: 'ACTIVE' | 'ARCHIVED';
}

/**
 * GL exposures at a date: leaf accounts in a foreign currency, explicitly monetary and not
 * control accounts, with their foreign balance F (normal lines only, Decision 71) and carrying
 * base amount B (all lines) from posted history up to and including the date. Accounts with
 * neither are left out. Archived accounts are returned too, so the caller can refuse them.
 */
export async function queryAccountExposures(
  tx: Transaction,
  input: { organizationId: string; baseCurrency: string; onDate: string },
): Promise<AccountExposureRow[]> {
  const result = await tx.execute<{
    id: string;
    code: string;
    name: string;
    status: 'ACTIVE' | 'ARCHIVED';
    currency_code: string;
    foreign_balance: string;
    carrying_base: string;
  }>(sql`
    SELECT a.id, a.code, a.name, a.status, a.currency_code,
           coalesce(sum(coalesce(l.debit, 0) - coalesce(l.credit, 0))
                    FILTER (WHERE l.line_kind = 'normal'), 0)::text AS foreign_balance,
           coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::text AS carrying_base
      FROM accounting_accounts a
      LEFT JOIN (
        SELECT l.account_id, l.line_kind, l.debit, l.credit, l.base_debit, l.base_credit
          FROM accounting_journal_lines l
          JOIN accounting_journal_entries j
            ON j.id = l.journal_id AND j.organization_id = l.organization_id
         WHERE l.organization_id = ${input.organizationId}
           AND j.status IN ('POSTED', 'REVERSED')
           AND j.entry_date <= ${input.onDate}::date
      ) l ON l.account_id = a.id
     WHERE a.organization_id = ${input.organizationId}
       AND a.currency_code <> ${input.baseCurrency}
       AND a.is_monetary
       AND NOT a.is_control_account
       AND NOT EXISTS (SELECT 1 FROM accounting_accounts c
                        WHERE c.parent_id = a.id AND c.organization_id = a.organization_id)
     GROUP BY a.id
    HAVING coalesce(sum(coalesce(l.debit, 0) - coalesce(l.credit, 0))
                    FILTER (WHERE l.line_kind = 'normal'), 0) <> 0
        OR coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0) <> 0
     ORDER BY a.currency_code, a.code`);
  return result.rows.map((r) => ({
    kind: 'ACCOUNT',
    accountId: r.id,
    accountCode: r.code,
    accountName: r.name,
    currency: r.currency_code,
    foreignBalance: r.foreign_balance,
    carryingBase: r.carrying_base,
    document: null,
    status: r.status,
  }));
}

export async function getRevaluationRun(
  tx: Transaction,
  organizationId: string,
  runId: string,
  options: { forUpdate?: boolean } = {},
): Promise<RevaluationRun | undefined> {
  const query = tx
    .select()
    .from(accountingRevaluationRuns)
    .where(
      and(
        eq(accountingRevaluationRuns.organizationId, organizationId),
        eq(accountingRevaluationRuns.id, runId),
      ),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

/** The active (not reversed) run for a date, if any. */
export async function findActiveRunForDate(
  tx: Transaction,
  organizationId: string,
  revaluationDate: string,
): Promise<RevaluationRun | undefined> {
  const [row] = await tx
    .select()
    .from(accountingRevaluationRuns)
    .where(
      and(
        eq(accountingRevaluationRuns.organizationId, organizationId),
        eq(accountingRevaluationRuns.revaluationDate, revaluationDate),
        inArray(accountingRevaluationRuns.status, ['DRAFT', 'PENDING_APPROVAL', 'POSTED']),
      ),
    );
  return row;
}

export async function findRunByKey(
  tx: Transaction,
  organizationId: string,
  runKey: string,
): Promise<RevaluationRun | undefined> {
  const [row] = await tx
    .select()
    .from(accountingRevaluationRuns)
    .where(
      and(
        eq(accountingRevaluationRuns.organizationId, organizationId),
        eq(accountingRevaluationRuns.runKey, runKey),
      ),
    );
  return row;
}

export async function listRevaluationRuns(
  tx: Transaction,
  organizationId: string,
  limit: number,
): Promise<RevaluationRun[]> {
  return tx
    .select()
    .from(accountingRevaluationRuns)
    .where(eq(accountingRevaluationRuns.organizationId, organizationId))
    .orderBy(
      desc(accountingRevaluationRuns.revaluationDate),
      desc(accountingRevaluationRuns.createdAt),
    )
    .limit(limit);
}

/** Inserts a DRAFT run (the database refuses any other initial status). */
export async function insertRevaluationRun(
  tx: Transaction,
  input: {
    organizationId: string;
    revaluationDate: string;
    reversalDate: string;
    baseCurrency: string;
    unrealizedAccountId: string;
    runKey: string | null;
    trigger: 'user' | 'job';
    jobId: string | null;
    userId: string;
    now: Date;
  },
): Promise<RevaluationRun> {
  const [row] = await tx
    .insert(accountingRevaluationRuns)
    .values({
      organizationId: input.organizationId,
      method: 'REVERSING',
      revaluationDate: input.revaluationDate,
      reversalDate: input.reversalDate,
      baseCurrency: input.baseCurrency,
      unrealizedAccountId: input.unrealizedAccountId,
      runKey: input.runKey,
      trigger: input.trigger,
      jobId: input.jobId,
      createdByUserId: input.userId,
      createdAt: input.now,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .returning();
  return row!;
}

/**
 * Updates a run only if it is still in `from` (and at `version`, when given), bumping the
 * version. Returns undefined when the run changed meanwhile.
 */
export async function updateRevaluationRun(
  tx: Transaction,
  input: {
    organizationId: string;
    runId: string;
    from: RevaluationRunStatus;
    version?: number;
    set: Partial<Omit<RevaluationRun, 'id' | 'organizationId' | 'version' | 'createdAt'>>;
  },
): Promise<RevaluationRun | undefined> {
  const conditions = [
    eq(accountingRevaluationRuns.organizationId, input.organizationId),
    eq(accountingRevaluationRuns.id, input.runId),
    eq(accountingRevaluationRuns.status, input.from),
  ];
  if (input.version !== undefined) {
    conditions.push(eq(accountingRevaluationRuns.version, input.version));
  }
  const [row] = await tx
    .update(accountingRevaluationRuns)
    .set({ ...input.set, version: sql`${accountingRevaluationRuns.version} + 1` })
    .where(and(...conditions))
    .returning();
  return row;
}

export async function insertRevaluationLines(
  tx: Transaction,
  rows: (typeof accountingRevaluationLines.$inferInsert)[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    await tx.insert(accountingRevaluationLines).values(rows.slice(i, i + 1000));
  }
}

export async function listRevaluationLines(
  tx: Transaction,
  organizationId: string,
  runId: string,
): Promise<RevaluationLine[]> {
  return tx
    .select()
    .from(accountingRevaluationLines)
    .where(
      and(
        eq(accountingRevaluationLines.organizationId, organizationId),
        eq(accountingRevaluationLines.runId, runId),
      ),
    )
    .orderBy(asc(accountingRevaluationLines.lineNumber));
}

export async function linkRevaluationJournal(
  tx: Transaction,
  input: {
    organizationId: string;
    runId: string;
    journalId: string;
    currency: string;
    role: RevaluationJournalRole;
  },
): Promise<void> {
  await tx.insert(accountingRevaluationRunJournals).values(input);
}

/** The run's journals with their role, in posting order. */
export async function listRevaluationJournals(
  tx: Transaction,
  organizationId: string,
  runId: string,
) {
  return tx
    .select({
      journalId: accountingRevaluationRunJournals.journalId,
      currency: accountingRevaluationRunJournals.currency,
      role: accountingRevaluationRunJournals.role,
      number: accountingJournalEntries.journalNumber,
      status: accountingJournalEntries.status,
      entryDate: accountingJournalEntries.entryDate,
      createdAt: accountingJournalEntries.createdAt,
    })
    .from(accountingRevaluationRunJournals)
    .innerJoin(
      accountingJournalEntries,
      and(
        eq(accountingJournalEntries.id, accountingRevaluationRunJournals.journalId),
        eq(
          accountingJournalEntries.organizationId,
          accountingRevaluationRunJournals.organizationId,
        ),
      ),
    )
    .where(
      and(
        eq(accountingRevaluationRunJournals.organizationId, organizationId),
        eq(accountingRevaluationRunJournals.runId, runId),
      ),
    )
    .orderBy(asc(accountingJournalEntries.journalNumber));
}
