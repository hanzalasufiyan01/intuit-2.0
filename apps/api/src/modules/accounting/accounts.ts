import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import type { AccountFacts } from './rules.js';
import {
  accountingAccounts,
  accountingJournalEntries,
  accountingJournalLines,
  type AccountSubtype,
  type AccountType,
} from './schema.js';

export type Account = typeof accountingAccounts.$inferSelect;

export interface AccountWithFacts extends Account {
  isLeaf: boolean;
  /** Referenced by a posted/reversed journal line. */
  usedInPostedJournals: boolean;
}

export async function listAccounts(
  tx: Transaction,
  organizationId: string,
): Promise<AccountWithFacts[]> {
  const accounts = await tx
    .select()
    .from(accountingAccounts)
    .where(eq(accountingAccounts.organizationId, organizationId))
    .orderBy(asc(accountingAccounts.code));
  const used = await postedAccountIds(tx, organizationId);
  const parents = new Set(
    accounts.map((a) => a.parentId).filter((id): id is string => id !== null),
  );
  return accounts.map((a) => ({
    ...a,
    isLeaf: !parents.has(a.id),
    usedInPostedJournals: used.has(a.id),
  }));
}

async function postedAccountIds(tx: Transaction, organizationId: string, accountIds?: string[]) {
  const conditions = [
    eq(accountingJournalLines.organizationId, organizationId),
    inArray(accountingJournalEntries.status, ['POSTED', 'REVERSED']),
  ];
  if (accountIds) conditions.push(inArray(accountingJournalLines.accountId, accountIds));
  const rows = await tx
    .selectDistinct({ accountId: accountingJournalLines.accountId })
    .from(accountingJournalLines)
    .innerJoin(
      accountingJournalEntries,
      and(
        eq(accountingJournalEntries.id, accountingJournalLines.journalId),
        eq(accountingJournalEntries.organizationId, accountingJournalLines.organizationId),
      ),
    )
    .where(and(...conditions));
  return new Set(rows.map((r) => r.accountId).filter((id): id is string => id !== null));
}

export async function getAccount(
  tx: Transaction,
  organizationId: string,
  accountId: string,
  options: { forUpdate?: boolean } = {},
): Promise<AccountWithFacts | undefined> {
  const query = tx
    .select()
    .from(accountingAccounts)
    .where(
      and(
        eq(accountingAccounts.organizationId, organizationId),
        eq(accountingAccounts.id, accountId),
      ),
    )
    .limit(1);
  const [account] = options.forUpdate ? await query.for('update') : await query;
  if (!account) return undefined;
  const [child] = await tx
    .select({ id: accountingAccounts.id })
    .from(accountingAccounts)
    .where(
      and(
        eq(accountingAccounts.organizationId, organizationId),
        eq(accountingAccounts.parentId, accountId),
      ),
    )
    .limit(1);
  const used = await postedAccountIds(tx, organizationId, [accountId]);
  return { ...account, isLeaf: !child, usedInPostedJournals: used.has(accountId) };
}

/** Facts needed by the double-entry rules for a set of accounts. */
export async function getAccountFacts(
  tx: Transaction,
  organizationId: string,
  accountIds: readonly string[],
): Promise<Map<string, AccountFacts>> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: accountingAccounts.id,
      status: accountingAccounts.status,
      currencyCode: accountingAccounts.currencyCode,
      isMonetary: accountingAccounts.isMonetary,
      isControlAccount: accountingAccounts.isControlAccount,
      accountType: accountingAccounts.accountType,
      subtype: accountingAccounts.subtype,
    })
    .from(accountingAccounts)
    .where(
      and(
        eq(accountingAccounts.organizationId, organizationId),
        inArray(accountingAccounts.id, ids),
      ),
    );
  const parents = await tx
    .selectDistinct({ parentId: accountingAccounts.parentId })
    .from(accountingAccounts)
    .where(
      and(
        eq(accountingAccounts.organizationId, organizationId),
        inArray(accountingAccounts.parentId, ids),
      ),
    );
  const parentIds = new Set(parents.map((p) => p.parentId));
  return new Map(rows.map((r) => [r.id, { ...r, isLeaf: !parentIds.has(r.id) }]));
}

export async function findAccountByCode(tx: Transaction, organizationId: string, code: string) {
  const [row] = await tx
    .select()
    .from(accountingAccounts)
    .where(
      and(eq(accountingAccounts.organizationId, organizationId), eq(accountingAccounts.code, code)),
    )
    .limit(1);
  return row;
}

/** True if `candidateParentId` is `accountId` itself or one of its descendants. */
export async function wouldCreateCycle(
  tx: Transaction,
  organizationId: string,
  accountId: string,
  candidateParentId: string,
): Promise<boolean> {
  const result = await tx.execute<{ found: boolean }>(sql`
    WITH RECURSIVE descendants AS (
      SELECT id FROM accounting_accounts WHERE id = ${accountId} AND organization_id = ${organizationId}
      UNION ALL
      SELECT a.id FROM accounting_accounts a JOIN descendants d ON a.parent_id = d.id
      WHERE a.organization_id = ${organizationId}
    )
    SELECT EXISTS (SELECT 1 FROM descendants WHERE id = ${candidateParentId}) AS found`);
  return result.rows[0]?.found === true;
}

/** Account ids of an account and all its descendants (for parent/reporting ledger views). */
export async function descendantAccountIds(
  tx: Transaction,
  organizationId: string,
  accountId: string,
): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE descendants AS (
      SELECT id FROM accounting_accounts WHERE id = ${accountId} AND organization_id = ${organizationId}
      UNION ALL
      SELECT a.id FROM accounting_accounts a JOIN descendants d ON a.parent_id = d.id
      WHERE a.organization_id = ${organizationId}
    )
    SELECT id FROM descendants`);
  return result.rows.map((r) => r.id);
}

/** Referenced by any non-draft journal line (pending approval, posted or reversed). */
export async function isAccountReferencedOutsideDrafts(
  tx: Transaction,
  organizationId: string,
  accountId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: accountingJournalLines.id })
    .from(accountingJournalLines)
    .innerJoin(
      accountingJournalEntries,
      and(
        eq(accountingJournalEntries.id, accountingJournalLines.journalId),
        eq(accountingJournalEntries.organizationId, accountingJournalLines.organizationId),
      ),
    )
    .where(
      and(
        eq(accountingJournalLines.organizationId, organizationId),
        eq(accountingJournalLines.accountId, accountId),
        inArray(accountingJournalEntries.status, ['PENDING_APPROVAL', 'POSTED', 'REVERSED']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function isAccountReferencedByAnyLine(
  tx: Transaction,
  organizationId: string,
  accountId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: accountingJournalLines.id })
    .from(accountingJournalLines)
    .where(
      and(
        eq(accountingJournalLines.organizationId, organizationId),
        eq(accountingJournalLines.accountId, accountId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function createAccount(
  tx: Transaction,
  input: {
    organizationId: string;
    code: string;
    name: string;
    description: string;
    accountType: AccountType;
    parentId: string | null;
    currencyCode: string;
    subtype: AccountSubtype | null;
    isMonetary: boolean;
    userId: string;
  },
): Promise<Account | undefined> {
  const [row] = await tx
    .insert(accountingAccounts)
    .values({
      organizationId: input.organizationId,
      code: input.code,
      name: input.name.trim(),
      description: input.description.trim(),
      accountType: input.accountType,
      parentId: input.parentId,
      currencyCode: input.currencyCode,
      subtype: input.subtype,
      isMonetary: input.isMonetary,
      createdByUserId: input.userId,
    })
    .onConflictDoNothing({ target: [accountingAccounts.organizationId, accountingAccounts.code] })
    .returning();
  return row;
}

export type AccountChanges = Pick<
  Account,
  | 'code'
  | 'name'
  | 'description'
  | 'accountType'
  | 'parentId'
  | 'currencyCode'
  | 'subtype'
  | 'isMonetary'
>;

export async function updateAccount(
  tx: Transaction,
  input: {
    organizationId: string;
    accountId: string;
    changes: Partial<AccountChanges>;
    userId: string;
  },
): Promise<Account | undefined> {
  const [row] = await tx
    .update(accountingAccounts)
    .set({ ...input.changes, updatedByUserId: input.userId })
    .where(
      and(
        eq(accountingAccounts.organizationId, input.organizationId),
        eq(accountingAccounts.id, input.accountId),
      ),
    )
    .returning();
  return row;
}

export async function archiveAccount(
  tx: Transaction,
  input: { organizationId: string; accountId: string; userId: string; now: Date },
): Promise<Account | undefined> {
  const [row] = await tx
    .update(accountingAccounts)
    .set({
      status: 'ARCHIVED',
      archivedAt: input.now,
      archivedByUserId: input.userId,
      updatedByUserId: input.userId,
    })
    .where(
      and(
        eq(accountingAccounts.organizationId, input.organizationId),
        eq(accountingAccounts.id, input.accountId),
        eq(accountingAccounts.status, 'ACTIVE'),
      ),
    )
    .returning();
  return row;
}

/**
 * Deletes an account. Draft-only references do not prevent deletion: those draft lines
 * lose their account (drafts may be incomplete) before the account row is removed.
 */
export async function deleteAccount(
  tx: Transaction,
  organizationId: string,
  accountId: string,
): Promise<{ deleted: boolean; draftLinesCleared: number }> {
  const draftJournalIds = tx
    .select({ id: accountingJournalEntries.id })
    .from(accountingJournalEntries)
    .where(
      and(
        eq(accountingJournalEntries.organizationId, organizationId),
        eq(accountingJournalEntries.status, 'DRAFT'),
      ),
    );
  const cleared = await tx
    .update(accountingJournalLines)
    .set({ accountId: null })
    .where(
      and(
        eq(accountingJournalLines.organizationId, organizationId),
        eq(accountingJournalLines.accountId, accountId),
        inArray(accountingJournalLines.journalId, draftJournalIds),
      ),
    )
    .returning({ id: accountingJournalLines.id });
  const deleted = await tx
    .delete(accountingAccounts)
    .where(
      and(
        eq(accountingAccounts.organizationId, organizationId),
        eq(accountingAccounts.id, accountId),
      ),
    )
    .returning({ id: accountingAccounts.id });
  return { deleted: deleted.length > 0, draftLinesCleared: cleared.length };
}

export async function hasChildAccounts(tx: Transaction, organizationId: string, accountId: string) {
  const [row] = await tx
    .select({ id: accountingAccounts.id })
    .from(accountingAccounts)
    .where(
      and(
        eq(accountingAccounts.organizationId, organizationId),
        eq(accountingAccounts.parentId, accountId),
      ),
    )
    .limit(1);
  return row !== undefined;
}
