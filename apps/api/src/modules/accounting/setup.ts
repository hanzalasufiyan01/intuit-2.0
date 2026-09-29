import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { ALWAYS_MONETARY_SUBTYPES } from './classification.js';
import {
  accountingAccounts,
  accountingCoaTemplateAccounts,
  accountingCoaTemplates,
  accountingDesignations,
  accountingJournalEntries,
  accountingSettings,
} from './schema.js';

export type AccountingSettings = typeof accountingSettings.$inferSelect;
export type CoaTemplate = typeof accountingCoaTemplates.$inferSelect;

export async function getAccountingSettings(
  tx: Transaction,
  organizationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<AccountingSettings | undefined> {
  const query = tx
    .select()
    .from(accountingSettings)
    .where(eq(accountingSettings.organizationId, organizationId))
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listCoaTemplates(tx: Transaction) {
  const templates = await tx
    .select()
    .from(accountingCoaTemplates)
    .orderBy(asc(accountingCoaTemplates.sortOrder));
  const counts = await tx
    .select({ key: accountingCoaTemplateAccounts.templateKey, n: sql<number>`count(*)::int` })
    .from(accountingCoaTemplateAccounts)
    .groupBy(accountingCoaTemplateAccounts.templateKey);
  return templates.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    accountCount: counts.find((c) => c.key === t.key)?.n ?? 0,
  }));
}

/**
 * One-time accounting setup: records the base currency and applies the chosen COA template.
 * Template accounts are created in the base currency with the template's classification, and
 * the template's designations (Decision 64) are applied.
 * Returns undefined if the organization is already set up or the template does not exist.
 */
export async function setUpAccounting(
  tx: Transaction,
  input: {
    organizationId: string;
    baseCurrency: string;
    templateKey: string;
    userId: string;
    now: Date;
  },
): Promise<
  { settings: AccountingSettings; accountsCreated: number } | 'already_set_up' | 'unknown_template'
> {
  const [template] = await tx
    .select()
    .from(accountingCoaTemplates)
    .where(eq(accountingCoaTemplates.key, input.templateKey));
  if (!template) return 'unknown_template';

  const [settings] = await tx
    .insert(accountingSettings)
    .values({
      organizationId: input.organizationId,
      baseCurrency: input.baseCurrency,
      coaTemplateKey: input.templateKey,
      setupByUserId: input.userId,
      setupAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  if (!settings) return 'already_set_up';

  const templateAccounts = await tx
    .select()
    .from(accountingCoaTemplateAccounts)
    .where(eq(accountingCoaTemplateAccounts.templateKey, input.templateKey))
    .orderBy(asc(accountingCoaTemplateAccounts.sortOrder));
  const idsByCode = new Map<string, string>();
  for (const account of templateAccounts) {
    const [row] = await tx
      .insert(accountingAccounts)
      .values({
        organizationId: input.organizationId,
        code: account.code,
        name: account.name,
        accountType: account.accountType,
        parentId: account.parentCode ? (idsByCode.get(account.parentCode) ?? null) : null,
        isSystem: true,
        currencyCode: input.baseCurrency,
        subtype: account.subtype,
        isMonetary: account.subtype !== null && ALWAYS_MONETARY_SUBTYPES.has(account.subtype),
        createdByUserId: input.userId,
      })
      .returning({ id: accountingAccounts.id });
    idsByCode.set(account.code, row!.id);
    if (account.designation) {
      await tx.insert(accountingDesignations).values({
        organizationId: input.organizationId,
        designation: account.designation,
        accountId: row!.id,
        updatedByUserId: input.userId,
        updatedAt: input.now,
      });
    }
  }
  return { settings, accountsCreated: templateAccounts.length };
}

export async function hasPostedJournals(tx: Transaction, organizationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: accountingJournalEntries.id })
    .from(accountingJournalEntries)
    .where(
      and(
        eq(accountingJournalEntries.organizationId, organizationId),
        inArray(accountingJournalEntries.status, ['POSTED', 'REVERSED']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Any journal beyond draft (pending approval, posted or reversed). */
export async function hasNonDraftJournals(
  tx: Transaction,
  organizationId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: accountingJournalEntries.id })
    .from(accountingJournalEntries)
    .where(
      and(
        eq(accountingJournalEntries.organizationId, organizationId),
        inArray(accountingJournalEntries.status, ['PENDING_APPROVAL', 'POSTED', 'REVERSED']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Changes the base currency before the first posting (Decision 26): accounts in the old base
 * currency follow the new base currency; explicitly foreign accounts are unchanged.
 */
export async function updateBaseCurrency(
  tx: Transaction,
  organizationId: string,
  baseCurrency: string,
): Promise<{ settings: AccountingSettings; accountsMoved: number } | undefined> {
  const [previous] = await tx
    .select({ baseCurrency: accountingSettings.baseCurrency })
    .from(accountingSettings)
    .where(eq(accountingSettings.organizationId, organizationId));
  if (!previous) return undefined;
  const [row] = await tx
    .update(accountingSettings)
    .set({ baseCurrency })
    .where(eq(accountingSettings.organizationId, organizationId))
    .returning();
  const moved = await tx
    .update(accountingAccounts)
    .set({ currencyCode: baseCurrency })
    .where(
      and(
        eq(accountingAccounts.organizationId, organizationId),
        eq(accountingAccounts.currencyCode, previous.baseCurrency),
      ),
    )
    .returning({ id: accountingAccounts.id });
  return { settings: row!, accountsMoved: moved.length };
}

/** Next journal number (assigned at posting; the settings row lock serializes numbering). */
export async function allocateJournalNumber(
  tx: Transaction,
  organizationId: string,
): Promise<number> {
  const [row] = await tx
    .update(accountingSettings)
    .set({ nextJournalNumber: sql`${accountingSettings.nextJournalNumber} + 1` })
    .where(eq(accountingSettings.organizationId, organizationId))
    .returning({ next: accountingSettings.nextJournalNumber });
  if (!row) throw new Error('Accounting settings missing');
  return row.next - 1;
}
