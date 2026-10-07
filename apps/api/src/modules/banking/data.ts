import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from '../catalog/index.js';
import {
  bankingAccounts,
  bankingEntries,
  bankingMatches,
  bankingNumberSequences,
  bankingReconciliationItems,
  bankingReconciliations,
  bankingRules,
  bankingStatementImports,
  bankingTransactions,
  bankingTransfers,
  type BankTransactionStatus,
} from './schema.js';

/** Banking data access. Rules live in the application services (ledger tables are never written). */

export type BankingAccount = typeof bankingAccounts.$inferSelect;
export type BankTransaction = typeof bankingTransactions.$inferSelect;
export type BankMatch = typeof bankingMatches.$inferSelect;
export type BankEntry = typeof bankingEntries.$inferSelect;
export type BankTransfer = typeof bankingTransfers.$inferSelect;
export type BankReconciliation = typeof bankingReconciliations.$inferSelect;
export type BankRule = typeof bankingRules.$inferSelect;
export type StatementImport = typeof bankingStatementImports.$inferSelect;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export async function getBankingAccount(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<BankingAccount | undefined> {
  const query = tx
    .select()
    .from(bankingAccounts)
    .where(and(eq(bankingAccounts.organizationId, organizationId), eq(bankingAccounts.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getBankingAccountByLedgerAccount(
  tx: Transaction,
  organizationId: string,
  accountId: string,
): Promise<BankingAccount | undefined> {
  const [row] = await tx
    .select()
    .from(bankingAccounts)
    .where(
      and(
        eq(bankingAccounts.organizationId, organizationId),
        eq(bankingAccounts.accountId, accountId),
      ),
    );
  return row;
}

export async function listBankingAccounts(
  tx: Transaction,
  organizationId: string,
): Promise<BankingAccount[]> {
  return tx
    .select()
    .from(bankingAccounts)
    .where(eq(bankingAccounts.organizationId, organizationId))
    .orderBy(asc(bankingAccounts.name), asc(bankingAccounts.id));
}

export async function insertBankingAccount(
  tx: Transaction,
  values: typeof bankingAccounts.$inferInsert,
): Promise<BankingAccount> {
  const [row] = await tx.insert(bankingAccounts).values(values).returning();
  return row!;
}

export async function updateBankingAccount(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof bankingAccounts.$inferInsert>;
  },
): Promise<BankingAccount | undefined> {
  const [row] = await tx
    .update(bankingAccounts)
    .set({ ...input.set, version: sql`${bankingAccounts.version} + 1` })
    .where(
      and(
        eq(bankingAccounts.organizationId, input.organizationId),
        eq(bankingAccounts.id, input.id),
        eq(bankingAccounts.version, input.version),
      ),
    )
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Statement imports and transactions
// ---------------------------------------------------------------------------

export async function insertStatementImport(
  tx: Transaction,
  values: typeof bankingStatementImports.$inferInsert,
): Promise<StatementImport> {
  const [row] = await tx.insert(bankingStatementImports).values(values).returning();
  return row!;
}

export async function listStatementImports(
  tx: Transaction,
  organizationId: string,
  bankingAccountId: string,
  limit: number,
): Promise<StatementImport[]> {
  return tx
    .select()
    .from(bankingStatementImports)
    .where(
      and(
        eq(bankingStatementImports.organizationId, organizationId),
        eq(bankingStatementImports.bankingAccountId, bankingAccountId),
      ),
    )
    .orderBy(desc(bankingStatementImports.createdAt))
    .limit(limit);
}

export async function updateStatementImportCounts(
  tx: Transaction,
  organizationId: string,
  id: string,
  counts: { transactionCount: number; duplicateCount: number },
) {
  await tx
    .update(bankingStatementImports)
    .set(counts)
    .where(
      and(
        eq(bankingStatementImports.organizationId, organizationId),
        eq(bankingStatementImports.id, id),
      ),
    );
}

/**
 * Inserts parsed transactions, skipping the ones the account already holds (same fingerprint or
 * same bank transaction id). Returns the rows that were new.
 */
export async function insertBankTransactions(
  tx: Transaction,
  values: (typeof bankingTransactions.$inferInsert)[],
): Promise<BankTransaction[]> {
  if (!values.length) return [];
  const inserted: BankTransaction[] = [];
  for (let i = 0; i < values.length; i += 500) {
    inserted.push(
      ...(await tx
        .insert(bankingTransactions)
        .values(values.slice(i, i + 500))
        .onConflictDoNothing()
        .returning()),
    );
  }
  return inserted;
}

export async function getBankTransaction(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<BankTransaction | undefined> {
  const query = tx
    .select()
    .from(bankingTransactions)
    .where(
      and(eq(bankingTransactions.organizationId, organizationId), eq(bankingTransactions.id, id)),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listBankTransactions(
  tx: Transaction,
  input: {
    organizationId: string;
    bankingAccountId: string;
    status?: BankTransactionStatus | undefined;
    search?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    after?: { date: string; id: string } | undefined;
    limit: number;
  },
): Promise<BankTransaction[]> {
  const conditions: (SQL | undefined)[] = [
    eq(bankingTransactions.organizationId, input.organizationId),
    eq(bankingTransactions.bankingAccountId, input.bankingAccountId),
    input.status ? eq(bankingTransactions.status, input.status) : undefined,
    input.from ? sql`${bankingTransactions.txnDate} >= ${input.from}::date` : undefined,
    input.to ? sql`${bankingTransactions.txnDate} <= ${input.to}::date` : undefined,
    input.search
      ? sql`(${bankingTransactions.description} ILIKE ${likeContains(input.search)} OR ${bankingTransactions.reference} ILIKE ${likeContains(input.search)})`
      : undefined,
    input.after
      ? sql`(${bankingTransactions.txnDate}, ${bankingTransactions.id}) < (${input.after.date}::date, ${input.after.id}::uuid)`
      : undefined,
  ];
  return tx
    .select()
    .from(bankingTransactions)
    .where(and(...conditions))
    .orderBy(desc(bankingTransactions.txnDate), desc(bankingTransactions.id))
    .limit(input.limit);
}

export async function setBankTransactionStatus(
  tx: Transaction,
  organizationId: string,
  id: string,
  from: BankTransactionStatus,
  set: Partial<typeof bankingTransactions.$inferInsert>,
): Promise<BankTransaction | undefined> {
  const [row] = await tx
    .update(bankingTransactions)
    .set(set)
    .where(
      and(
        eq(bankingTransactions.organizationId, organizationId),
        eq(bankingTransactions.id, id),
        eq(bankingTransactions.status, from),
      ),
    )
    .returning();
  return row;
}

export async function countBankTransactionsByStatus(
  tx: Transaction,
  organizationId: string,
  bankingAccountId: string,
) {
  const rows = await tx
    .select({ status: bankingTransactions.status, count: sql<number>`count(*)::int` })
    .from(bankingTransactions)
    .where(
      and(
        eq(bankingTransactions.organizationId, organizationId),
        eq(bankingTransactions.bankingAccountId, bankingAccountId),
      ),
    )
    .groupBy(bankingTransactions.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count])) as Partial<
    Record<BankTransactionStatus, number>
  >;
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export async function insertBankMatch(
  tx: Transaction,
  values: typeof bankingMatches.$inferInsert,
): Promise<BankMatch> {
  const [row] = await tx.insert(bankingMatches).values(values).returning();
  return row!;
}

export async function getActiveMatches(
  tx: Transaction,
  organizationId: string,
  transactionIds: readonly string[],
): Promise<BankMatch[]> {
  if (!transactionIds.length) return [];
  return tx
    .select()
    .from(bankingMatches)
    .where(
      and(
        eq(bankingMatches.organizationId, organizationId),
        inArray(bankingMatches.bankingTransactionId, [...transactionIds]),
        isNull(bankingMatches.unmatchedAt),
      ),
    );
}

export async function getActiveMatchesByJournal(
  tx: Transaction,
  organizationId: string,
  journalId: string,
): Promise<BankMatch[]> {
  return tx
    .select()
    .from(bankingMatches)
    .where(
      and(
        eq(bankingMatches.organizationId, organizationId),
        eq(bankingMatches.journalId, journalId),
        isNull(bankingMatches.unmatchedAt),
      ),
    );
}

export async function endMatch(
  tx: Transaction,
  organizationId: string,
  id: string,
  userId: string,
  at: Date,
) {
  await tx
    .update(bankingMatches)
    .set({ unmatchedAt: at, unmatchedByUserId: userId })
    .where(and(eq(bankingMatches.organizationId, organizationId), eq(bankingMatches.id, id)));
}

export interface JournalLineCandidate {
  lineId: string;
  journalId: string;
  journalNumber: number;
  entryDate: string;
  description: string;
  reference: string;
  sourceModule: string | null;
  sourceType: string | null;
  sourceId: string | null;
  amount: string;
}

const SIGNED = (baseCurrency: boolean) =>
  baseCurrency
    ? sql`(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0))`
    : sql`(coalesce(l.debit, 0) - coalesce(l.credit, 0))`;

/** Unmatched journal lines of the bank ledger account with exactly the transaction amount. */
export async function findMatchCandidates(
  tx: Transaction,
  input: {
    organizationId: string;
    ledgerAccountId: string;
    amount: string;
    inBase: boolean;
    around: string;
    windowDays: number;
    limit: number;
  },
): Promise<JournalLineCandidate[]> {
  const { rows } = await tx.execute<{
    line_id: string;
    journal_id: string;
    journal_number: string;
    entry_date: string;
    description: string;
    reference: string;
    source_module: string | null;
    source_type: string | null;
    source_id: string | null;
    amount: string;
  }>(sql`
    SELECT l.id AS line_id, j.id AS journal_id, j.journal_number::text, j.entry_date::text,
           j.description, j.reference, j.source_module, j.source_type, j.source_id::text,
           ${SIGNED(input.inBase)}::text AS amount
      FROM accounting_journal_lines l
      JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
     WHERE l.organization_id = ${input.organizationId}
       AND l.account_id = ${input.ledgerAccountId}
       AND j.status IN ('POSTED', 'REVERSED')
       AND ${SIGNED(input.inBase)} = ${input.amount}::numeric
       AND j.entry_date BETWEEN (${input.around}::date - ${input.windowDays}::int)
                            AND (${input.around}::date + ${input.windowDays}::int)
       AND NOT EXISTS (SELECT 1 FROM banking_matches m
                        WHERE m.journal_line_id = l.id AND m.unmatched_at IS NULL)
     ORDER BY abs(j.entry_date - ${input.around}::date), j.journal_number
     LIMIT ${input.limit}`);
  return rows.map((r) => ({
    lineId: r.line_id,
    journalId: r.journal_id,
    journalNumber: Number(r.journal_number),
    entryDate: r.entry_date,
    description: r.description,
    reference: r.reference,
    sourceModule: r.source_module,
    sourceType: r.source_type,
    sourceId: r.source_id,
    amount: r.amount,
  }));
}

/** A journal line of the bank ledger account, for the register and for manual matching. */
export interface RegisterLine extends JournalLineCandidate {
  runningBalance: string;
  matchedTransactionId: string | null;
}

export async function listRegisterLines(
  tx: Transaction,
  input: {
    organizationId: string;
    ledgerAccountId: string;
    inBase: boolean;
    from?: string | undefined;
    to?: string | undefined;
    unmatchedOnly?: boolean | undefined;
    limit: number;
    offset: number;
  },
): Promise<RegisterLine[]> {
  const { rows } = await tx.execute<{
    line_id: string;
    journal_id: string;
    journal_number: string;
    entry_date: string;
    description: string;
    reference: string;
    source_module: string | null;
    source_type: string | null;
    source_id: string | null;
    amount: string;
    running: string;
    matched_transaction_id: string | null;
  }>(sql`
    SELECT * FROM (
      SELECT l.id AS line_id, j.id AS journal_id, j.journal_number::text, j.entry_date::text,
             j.description, j.reference, j.source_module, j.source_type, j.source_id::text,
             ${SIGNED(input.inBase)}::text AS amount,
             sum(${SIGNED(input.inBase)}) OVER (ORDER BY j.entry_date, j.journal_number, l.line_number)::text AS running,
             m.banking_transaction_id::text AS matched_transaction_id,
             j.entry_date AS sort_date, j.journal_number AS sort_no, l.line_number AS sort_line
        FROM accounting_journal_lines l
        JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
        LEFT JOIN banking_matches m ON m.journal_line_id = l.id AND m.unmatched_at IS NULL
       WHERE l.organization_id = ${input.organizationId}
         AND l.account_id = ${input.ledgerAccountId}
         AND j.status IN ('POSTED', 'REVERSED')
    ) r
     WHERE (${input.from ?? null}::date IS NULL OR r.sort_date >= ${input.from ?? null}::date)
       AND (${input.to ?? null}::date IS NULL OR r.sort_date <= ${input.to ?? null}::date)
       AND (NOT ${input.unmatchedOnly ?? false}::boolean OR r.matched_transaction_id IS NULL)
     ORDER BY r.sort_date DESC, r.sort_no DESC, r.sort_line DESC
     LIMIT ${input.limit} OFFSET ${input.offset}`);
  return rows.map((r) => ({
    lineId: r.line_id,
    journalId: r.journal_id,
    journalNumber: Number(r.journal_number),
    entryDate: r.entry_date,
    description: r.description,
    reference: r.reference,
    sourceModule: r.source_module,
    sourceType: r.source_type,
    sourceId: r.source_id,
    amount: r.amount,
    runningBalance: r.running,
    matchedTransactionId: r.matched_transaction_id,
  }));
}

/** The ledger balance of the bank account (own currency or base) up to a date. */
export async function ledgerBalance(
  tx: Transaction,
  input: { organizationId: string; ledgerAccountId: string; inBase: boolean; upTo: string },
): Promise<string> {
  const { rows } = await tx.execute<{ balance: string }>(sql`
    SELECT coalesce(sum(${SIGNED(input.inBase)}), 0)::text AS balance
      FROM accounting_journal_lines l
      JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
     WHERE l.organization_id = ${input.organizationId}
       AND l.account_id = ${input.ledgerAccountId}
       AND j.status IN ('POSTED', 'REVERSED')
       AND j.entry_date <= ${input.upTo}::date`);
  return rows[0]!.balance;
}

export async function getJournalLineFacts(
  tx: Transaction,
  organizationId: string,
  lineId: string,
): Promise<{ lineId: string; journalId: string; accountId: string | null } | undefined> {
  const { rows } = await tx.execute<{
    id: string;
    journal_id: string;
    account_id: string | null;
  }>(sql`
    SELECT id, journal_id, account_id FROM accounting_journal_lines
     WHERE organization_id = ${organizationId} AND id = ${lineId}`);
  const row = rows[0];
  return row && { lineId: row.id, journalId: row.journal_id, accountId: row.account_id };
}

// ---------------------------------------------------------------------------
// Entries and transfers
// ---------------------------------------------------------------------------

export async function insertBankEntry(
  tx: Transaction,
  values: typeof bankingEntries.$inferInsert,
): Promise<BankEntry> {
  const [row] = await tx.insert(bankingEntries).values(values).returning();
  return row!;
}

export async function getBankEntry(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<BankEntry | undefined> {
  const query = tx
    .select()
    .from(bankingEntries)
    .where(and(eq(bankingEntries.organizationId, organizationId), eq(bankingEntries.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getBankEntryByTransaction(
  tx: Transaction,
  organizationId: string,
  transactionId: string,
): Promise<BankEntry | undefined> {
  const [row] = await tx
    .select()
    .from(bankingEntries)
    .where(
      and(
        eq(bankingEntries.organizationId, organizationId),
        eq(bankingEntries.bankingTransactionId, transactionId),
        eq(bankingEntries.status, 'POSTED'),
      ),
    );
  return row;
}

export async function updateBankEntry(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof bankingEntries.$inferInsert>;
  },
): Promise<BankEntry | undefined> {
  const [row] = await tx
    .update(bankingEntries)
    .set({ ...input.set, version: sql`${bankingEntries.version} + 1` })
    .where(
      and(
        eq(bankingEntries.organizationId, input.organizationId),
        eq(bankingEntries.id, input.id),
        eq(bankingEntries.version, input.version),
        eq(bankingEntries.status, 'POSTED'),
      ),
    )
    .returning();
  return row;
}

export async function bankEntryNumberExists(
  tx: Transaction,
  organizationId: string,
  number: string,
) {
  const [row] = await tx
    .select({ id: bankingEntries.id })
    .from(bankingEntries)
    .where(
      and(eq(bankingEntries.organizationId, organizationId), eq(bankingEntries.number, number)),
    )
    .limit(1);
  return Boolean(row);
}

export async function listBankEntries(
  tx: Transaction,
  organizationId: string,
  input: { bankingAccountId?: string | undefined; limit: number },
): Promise<BankEntry[]> {
  return tx
    .select()
    .from(bankingEntries)
    .where(
      and(
        eq(bankingEntries.organizationId, organizationId),
        input.bankingAccountId
          ? eq(bankingEntries.bankingAccountId, input.bankingAccountId)
          : undefined,
      ),
    )
    .orderBy(desc(bankingEntries.entryDate), desc(bankingEntries.id))
    .limit(input.limit);
}

export async function insertBankTransfer(
  tx: Transaction,
  values: typeof bankingTransfers.$inferInsert,
): Promise<BankTransfer> {
  const [row] = await tx.insert(bankingTransfers).values(values).returning();
  return row!;
}

export async function getBankTransfer(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<BankTransfer | undefined> {
  const query = tx
    .select()
    .from(bankingTransfers)
    .where(and(eq(bankingTransfers.organizationId, organizationId), eq(bankingTransfers.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function updateBankTransfer(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof bankingTransfers.$inferInsert>;
  },
): Promise<BankTransfer | undefined> {
  const [row] = await tx
    .update(bankingTransfers)
    .set({ ...input.set, version: sql`${bankingTransfers.version} + 1` })
    .where(
      and(
        eq(bankingTransfers.organizationId, input.organizationId),
        eq(bankingTransfers.id, input.id),
        eq(bankingTransfers.version, input.version),
        eq(bankingTransfers.status, 'POSTED'),
      ),
    )
    .returning();
  return row;
}

export async function bankTransferNumberExists(
  tx: Transaction,
  organizationId: string,
  number: string,
) {
  const [row] = await tx
    .select({ id: bankingTransfers.id })
    .from(bankingTransfers)
    .where(
      and(eq(bankingTransfers.organizationId, organizationId), eq(bankingTransfers.number, number)),
    )
    .limit(1);
  return Boolean(row);
}

export async function listBankTransfers(
  tx: Transaction,
  organizationId: string,
  input: { bankingAccountId?: string | undefined; limit: number },
): Promise<BankTransfer[]> {
  return tx
    .select()
    .from(bankingTransfers)
    .where(
      and(
        eq(bankingTransfers.organizationId, organizationId),
        input.bankingAccountId
          ? sql`(${bankingTransfers.fromBankingAccountId} = ${input.bankingAccountId} OR ${bankingTransfers.toBankingAccountId} = ${input.bankingAccountId})`
          : undefined,
      ),
    )
    .orderBy(desc(bankingTransfers.transferDate), desc(bankingTransfers.id))
    .limit(input.limit);
}

/** The next BE-/TR- number; the sequence row is created with its defaults on first use. */
export async function takeNextBankingNumber(
  tx: Transaction,
  organizationId: string,
  documentType: 'bank_entry' | 'bank_transfer',
): Promise<string> {
  await tx
    .insert(bankingNumberSequences)
    .values({
      organizationId,
      documentType,
      prefix: documentType === 'bank_entry' ? 'BE-' : 'TR-',
    })
    .onConflictDoNothing();
  const [row] = await tx
    .update(bankingNumberSequences)
    .set({ nextNumber: sql`${bankingNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(bankingNumberSequences.organizationId, organizationId),
        eq(bankingNumberSequences.documentType, documentType),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Matched transactions up to a date that no reconciliation counts yet. */
export async function listClearableTransactions(
  tx: Transaction,
  organizationId: string,
  bankingAccountId: string,
  upTo: string,
): Promise<BankTransaction[]> {
  return tx
    .select()
    .from(bankingTransactions)
    .where(
      and(
        eq(bankingTransactions.organizationId, organizationId),
        eq(bankingTransactions.bankingAccountId, bankingAccountId),
        eq(bankingTransactions.status, 'MATCHED'),
        sql`${bankingTransactions.txnDate} <= ${upTo}::date`,
        sql`NOT EXISTS (SELECT 1 FROM banking_reconciliation_items i
                         WHERE i.banking_transaction_id = ${bankingTransactions.id} AND i.counted)`,
      ),
    )
    .orderBy(asc(bankingTransactions.txnDate), asc(bankingTransactions.id));
}

export async function countUnmatchedUpTo(
  tx: Transaction,
  organizationId: string,
  bankingAccountId: string,
  upTo: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(bankingTransactions)
    .where(
      and(
        eq(bankingTransactions.organizationId, organizationId),
        eq(bankingTransactions.bankingAccountId, bankingAccountId),
        eq(bankingTransactions.status, 'UNMATCHED'),
        sql`${bankingTransactions.txnDate} <= ${upTo}::date`,
      ),
    );
  return row?.count ?? 0;
}

export async function getLatestReconciliation(
  tx: Transaction,
  organizationId: string,
  bankingAccountId: string,
  options: { forUpdate?: boolean } = {},
): Promise<BankReconciliation | undefined> {
  const query = tx
    .select()
    .from(bankingReconciliations)
    .where(
      and(
        eq(bankingReconciliations.organizationId, organizationId),
        eq(bankingReconciliations.bankingAccountId, bankingAccountId),
        eq(bankingReconciliations.status, 'COMPLETED'),
      ),
    )
    .orderBy(desc(bankingReconciliations.statementDate), desc(bankingReconciliations.completedAt))
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getReconciliation(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<BankReconciliation | undefined> {
  const query = tx
    .select()
    .from(bankingReconciliations)
    .where(
      and(
        eq(bankingReconciliations.organizationId, organizationId),
        eq(bankingReconciliations.id, id),
      ),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listReconciliations(
  tx: Transaction,
  organizationId: string,
  bankingAccountId: string,
  limit: number,
): Promise<BankReconciliation[]> {
  return tx
    .select()
    .from(bankingReconciliations)
    .where(
      and(
        eq(bankingReconciliations.organizationId, organizationId),
        eq(bankingReconciliations.bankingAccountId, bankingAccountId),
      ),
    )
    .orderBy(desc(bankingReconciliations.statementDate), desc(bankingReconciliations.completedAt))
    .limit(limit);
}

export async function insertReconciliation(
  tx: Transaction,
  values: typeof bankingReconciliations.$inferInsert,
  items: readonly { transactionId: string; amount: string }[],
): Promise<BankReconciliation> {
  const [row] = await tx.insert(bankingReconciliations).values(values).returning();
  for (let i = 0; i < items.length; i += 500) {
    await tx.insert(bankingReconciliationItems).values(
      items.slice(i, i + 500).map((item) => ({
        organizationId: values.organizationId,
        reconciliationId: row!.id,
        bankingTransactionId: item.transactionId,
        amount: item.amount,
      })),
    );
  }
  return row!;
}

export async function reopenReconciliation(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    userId: string;
    reason: string;
    at: Date;
  },
): Promise<BankReconciliation | undefined> {
  const [row] = await tx
    .update(bankingReconciliations)
    .set({
      status: 'REOPENED',
      reopenedByUserId: input.userId,
      reopenedAt: input.at,
      reopenReason: input.reason,
      version: sql`${bankingReconciliations.version} + 1`,
    })
    .where(
      and(
        eq(bankingReconciliations.organizationId, input.organizationId),
        eq(bankingReconciliations.id, input.id),
        eq(bankingReconciliations.version, input.version),
        eq(bankingReconciliations.status, 'COMPLETED'),
      ),
    )
    .returning();
  if (!row) return undefined;
  await tx
    .update(bankingReconciliationItems)
    .set({ counted: false })
    .where(
      and(
        eq(bankingReconciliationItems.organizationId, input.organizationId),
        eq(bankingReconciliationItems.reconciliationId, input.id),
      ),
    );
  return row;
}

export async function listReconciliationItems(
  tx: Transaction,
  organizationId: string,
  reconciliationId: string,
) {
  return tx
    .select({
      transactionId: bankingReconciliationItems.bankingTransactionId,
      amount: bankingReconciliationItems.amount,
      counted: bankingReconciliationItems.counted,
      txnDate: bankingTransactions.txnDate,
      description: bankingTransactions.description,
    })
    .from(bankingReconciliationItems)
    .innerJoin(
      bankingTransactions,
      and(
        eq(bankingTransactions.id, bankingReconciliationItems.bankingTransactionId),
        eq(bankingTransactions.organizationId, bankingReconciliationItems.organizationId),
      ),
    )
    .where(
      and(
        eq(bankingReconciliationItems.organizationId, organizationId),
        eq(bankingReconciliationItems.reconciliationId, reconciliationId),
      ),
    )
    .orderBy(asc(bankingTransactions.txnDate), asc(bankingTransactions.id));
}

/** Whether a reconciliation counts the transaction (so its match cannot be undone). */
export async function isReconciled(
  tx: Transaction,
  organizationId: string,
  transactionId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: bankingReconciliationItems.reconciliationId })
    .from(bankingReconciliationItems)
    .where(
      and(
        eq(bankingReconciliationItems.organizationId, organizationId),
        eq(bankingReconciliationItems.bankingTransactionId, transactionId),
        eq(bankingReconciliationItems.counted, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export async function insertBankRule(
  tx: Transaction,
  values: typeof bankingRules.$inferInsert,
): Promise<BankRule> {
  const [row] = await tx.insert(bankingRules).values(values).returning();
  return row!;
}

export async function getBankRule(
  tx: Transaction,
  organizationId: string,
  id: string,
): Promise<BankRule | undefined> {
  const [row] = await tx
    .select()
    .from(bankingRules)
    .where(and(eq(bankingRules.organizationId, organizationId), eq(bankingRules.id, id)));
  return row;
}

export async function listBankRules(
  tx: Transaction,
  organizationId: string,
  options: { activeOnly?: boolean } = {},
): Promise<BankRule[]> {
  return tx
    .select()
    .from(bankingRules)
    .where(
      and(
        eq(bankingRules.organizationId, organizationId),
        options.activeOnly ? eq(bankingRules.status, 'ACTIVE') : undefined,
      ),
    )
    .orderBy(asc(bankingRules.priority), asc(bankingRules.id));
}

export async function updateBankRule(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof bankingRules.$inferInsert>;
  },
): Promise<BankRule | undefined> {
  const [row] = await tx
    .update(bankingRules)
    .set({ ...input.set, version: sql`${bankingRules.version} + 1` })
    .where(
      and(
        eq(bankingRules.organizationId, input.organizationId),
        eq(bankingRules.id, input.id),
        eq(bankingRules.version, input.version),
      ),
    )
    .returning();
  return row;
}
