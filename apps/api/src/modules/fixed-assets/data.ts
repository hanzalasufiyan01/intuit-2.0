import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from '../catalog/index.js';
import {
  fixedAssetCategories,
  fixedAssetDisposals,
  fixedAssetEntries,
  fixedAssetNumberSequences,
  fixedAssetRuns,
  fixedAssetSettings,
  fixedAssetTransfers,
  fixedAssets,
  type AssetEntryKind,
  type AssetStatus,
} from './schema.js';

/** Fixed asset data access. Rules (depreciation, disposal, journals) live in the service. */

export type AssetCategory = typeof fixedAssetCategories.$inferSelect;
export type FixedAsset = typeof fixedAssets.$inferSelect;
export type DepreciationRun = typeof fixedAssetRuns.$inferSelect;
export type AssetDisposal = typeof fixedAssetDisposals.$inferSelect;
export type AssetTransfer = typeof fixedAssetTransfers.$inferSelect;
export type AssetEntry = typeof fixedAssetEntries.$inferSelect;
export type AssetSettings = typeof fixedAssetSettings.$inferSelect;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getAssetSettings(
  tx: Transaction,
  organizationId: string,
): Promise<AssetSettings | undefined> {
  const [row] = await tx
    .select()
    .from(fixedAssetSettings)
    .where(eq(fixedAssetSettings.organizationId, organizationId));
  return row;
}

export async function saveAssetSettings(
  tx: Transaction,
  input: {
    organizationId: string;
    version: number;
    gainLossAccountId: string | null;
    userId: string;
    at: Date;
  },
): Promise<AssetSettings | undefined> {
  if (input.version === 0) {
    const [row] = await tx
      .insert(fixedAssetSettings)
      .values({
        organizationId: input.organizationId,
        gainLossAccountId: input.gainLossAccountId,
        updatedByUserId: input.userId,
        updatedAt: input.at,
      })
      .onConflictDoNothing()
      .returning();
    return row;
  }
  const [row] = await tx
    .update(fixedAssetSettings)
    .set({
      gainLossAccountId: input.gainLossAccountId,
      updatedByUserId: input.userId,
      updatedAt: input.at,
      version: sql`${fixedAssetSettings.version} + 1`,
    })
    .where(
      and(
        eq(fixedAssetSettings.organizationId, input.organizationId),
        eq(fixedAssetSettings.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function takeNextAssetNumber(
  tx: Transaction,
  organizationId: string,
  documentType: 'asset' | 'run',
): Promise<string> {
  await tx
    .insert(fixedAssetNumberSequences)
    .values({ organizationId, documentType, prefix: documentType === 'asset' ? 'FA-' : 'DEP-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(fixedAssetNumberSequences)
    .set({ nextNumber: sql`${fixedAssetNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(fixedAssetNumberSequences.organizationId, organizationId),
        eq(fixedAssetNumberSequences.documentType, documentType),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function getCategory(
  tx: Transaction,
  organizationId: string,
  id: string,
): Promise<AssetCategory | undefined> {
  const [row] = await tx
    .select()
    .from(fixedAssetCategories)
    .where(
      and(eq(fixedAssetCategories.organizationId, organizationId), eq(fixedAssetCategories.id, id)),
    );
  return row;
}

export async function getCategories(
  tx: Transaction,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, AssetCategory>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await tx
    .select()
    .from(fixedAssetCategories)
    .where(
      and(
        eq(fixedAssetCategories.organizationId, organizationId),
        inArray(fixedAssetCategories.id, unique),
      ),
    );
  return new Map(rows.map((r) => [r.id, r]));
}

export async function listCategories(
  tx: Transaction,
  organizationId: string,
): Promise<AssetCategory[]> {
  return tx
    .select()
    .from(fixedAssetCategories)
    .where(eq(fixedAssetCategories.organizationId, organizationId))
    .orderBy(asc(sql`lower(${fixedAssetCategories.name})`), asc(fixedAssetCategories.id));
}

export async function findCategoryByName(
  tx: Transaction,
  organizationId: string,
  name: string,
  exceptId?: string,
): Promise<AssetCategory | undefined> {
  const [row] = await tx
    .select()
    .from(fixedAssetCategories)
    .where(
      and(
        eq(fixedAssetCategories.organizationId, organizationId),
        sql`lower(${fixedAssetCategories.name}) = lower(${name})`,
        exceptId ? sql`${fixedAssetCategories.id} <> ${exceptId}` : undefined,
      ),
    );
  return row;
}

export async function insertCategory(
  tx: Transaction,
  values: typeof fixedAssetCategories.$inferInsert,
): Promise<AssetCategory> {
  const [row] = await tx.insert(fixedAssetCategories).values(values).returning();
  return row!;
}

export async function updateCategory(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof fixedAssetCategories.$inferInsert>;
  },
): Promise<AssetCategory | undefined> {
  const [row] = await tx
    .update(fixedAssetCategories)
    .set({ ...input.set, version: sql`${fixedAssetCategories.version} + 1` })
    .where(
      and(
        eq(fixedAssetCategories.organizationId, input.organizationId),
        eq(fixedAssetCategories.id, input.id),
        eq(fixedAssetCategories.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function categoryHasAssets(
  tx: Transaction,
  organizationId: string,
  categoryId: string,
) {
  const [row] = await tx
    .select({ id: fixedAssets.id })
    .from(fixedAssets)
    .where(
      and(eq(fixedAssets.organizationId, organizationId), eq(fixedAssets.categoryId, categoryId)),
    )
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export async function getAsset(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<FixedAsset | undefined> {
  const query = tx
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.organizationId, organizationId), eq(fixedAssets.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function insertAsset(
  tx: Transaction,
  values: typeof fixedAssets.$inferInsert,
): Promise<FixedAsset> {
  const [row] = await tx.insert(fixedAssets).values(values).returning();
  return row!;
}

export async function updateAsset(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version?: number | undefined;
    set: Partial<typeof fixedAssets.$inferInsert>;
  },
): Promise<FixedAsset | undefined> {
  const [row] = await tx
    .update(fixedAssets)
    .set({ ...input.set, version: sql`${fixedAssets.version} + 1` })
    .where(
      and(
        eq(fixedAssets.organizationId, input.organizationId),
        eq(fixedAssets.id, input.id),
        input.version === undefined ? undefined : eq(fixedAssets.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function assetNumberExists(tx: Transaction, organizationId: string, number: string) {
  const [row] = await tx
    .select({ id: fixedAssets.id })
    .from(fixedAssets)
    .where(and(eq(fixedAssets.organizationId, organizationId), eq(fixedAssets.number, number)))
    .limit(1);
  return Boolean(row);
}

export async function listAssets(
  tx: Transaction,
  input: {
    organizationId: string;
    status?: AssetStatus | undefined;
    categoryId?: string | undefined;
    search?: string | undefined;
    limit: number;
    after?: { name: string; id: string } | undefined;
  },
): Promise<{ items: FixedAsset[]; hasMore: boolean }> {
  const t = fixedAssets;
  const conditions: (SQL | undefined)[] = [
    eq(t.organizationId, input.organizationId),
    input.status ? eq(t.status, input.status) : undefined,
    input.categoryId ? eq(t.categoryId, input.categoryId) : undefined,
    input.search
      ? or(
          ilike(t.name, likeContains(input.search)),
          ilike(t.number, likeContains(input.search)),
          ilike(t.serialNumber, likeContains(input.search)),
        )
      : undefined,
    input.after
      ? sql`(lower(${t.name}), ${t.id}) > (${input.after.name}, ${input.after.id}::uuid)`
      : undefined,
  ];
  const rows = await tx
    .select()
    .from(t)
    .where(and(...conditions))
    .orderBy(asc(sql`lower(${t.name})`), asc(t.id))
    .limit(input.limit + 1);
  return { items: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
}

/** Every active asset (the depreciation run reads them under lock, in a fixed order). */
export async function lockActiveAssets(
  tx: Transaction,
  organizationId: string,
): Promise<FixedAsset[]> {
  return tx
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.organizationId, organizationId), eq(fixedAssets.status, 'ACTIVE')))
    .orderBy(asc(fixedAssets.id))
    .for('update');
}

export async function lockAssets(
  tx: Transaction,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, FixedAsset>> {
  const unique = [...new Set(ids)].sort();
  if (!unique.length) return new Map();
  const rows = await tx
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.organizationId, organizationId), inArray(fixedAssets.id, unique)))
    .orderBy(asc(fixedAssets.id))
    .for('update');
  return new Map(rows.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export async function insertEntries(
  tx: Transaction,
  values: (typeof fixedAssetEntries.$inferInsert)[],
) {
  if (values.length) await tx.insert(fixedAssetEntries).values(values);
}

export async function listAssetEntries(
  tx: Transaction,
  organizationId: string,
  assetId: string,
): Promise<AssetEntry[]> {
  return tx
    .select()
    .from(fixedAssetEntries)
    .where(
      and(
        eq(fixedAssetEntries.organizationId, organizationId),
        eq(fixedAssetEntries.assetId, assetId),
      ),
    )
    .orderBy(
      asc(fixedAssetEntries.entryDate),
      asc(fixedAssetEntries.createdAt),
      asc(fixedAssetEntries.id),
    );
}

export async function listEntriesBySource(
  tx: Transaction,
  organizationId: string,
  sourceType: string,
  sourceId: string,
  kind?: AssetEntryKind,
): Promise<AssetEntry[]> {
  return tx
    .select()
    .from(fixedAssetEntries)
    .where(
      and(
        eq(fixedAssetEntries.organizationId, organizationId),
        eq(fixedAssetEntries.sourceType, sourceType),
        eq(fixedAssetEntries.sourceId, sourceId),
        kind ? eq(fixedAssetEntries.kind, kind) : undefined,
      ),
    )
    .orderBy(asc(fixedAssetEntries.assetId));
}

/** The register as of a date: per asset the cost and accumulated depreciation from the entries. */
export async function registerAsOf(tx: Transaction, organizationId: string, asOf: string) {
  const { rows } = await tx.execute<{
    asset_id: string;
    cost: string;
    accumulated: string;
  }>(sql`
    SELECT asset_id, sum(cost_change)::text AS cost, sum(accumulated_change)::text AS accumulated
      FROM fixed_asset_entries
     WHERE organization_id = ${organizationId} AND entry_date <= ${asOf}::date
     GROUP BY asset_id`);
  return new Map(rows.map((r) => [r.asset_id, { cost: r.cost, accumulated: r.accumulated }]));
}

/** The ledger balance (debit − credit) of an account in base, for the register reconciliation. */
export async function ledgerBalanceOf(
  tx: Transaction,
  organizationId: string,
  accountId: string,
  asOf: string,
): Promise<string> {
  const { rows } = await tx.execute<{ balance: string }>(sql`
    SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::text AS balance
      FROM accounting_journal_lines l
      JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
     WHERE l.organization_id = ${organizationId} AND l.account_id = ${accountId}
       AND j.status IN ('POSTED', 'REVERSED') AND j.entry_date <= ${asOf}::date`);
  return rows[0]!.balance;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function insertRun(
  tx: Transaction,
  values: typeof fixedAssetRuns.$inferInsert,
): Promise<DepreciationRun> {
  const [row] = await tx.insert(fixedAssetRuns).values(values).returning();
  return row!;
}

export async function getRun(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<DepreciationRun | undefined> {
  const query = tx
    .select()
    .from(fixedAssetRuns)
    .where(and(eq(fixedAssetRuns.organizationId, organizationId), eq(fixedAssetRuns.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listRuns(
  tx: Transaction,
  organizationId: string,
  limit: number,
): Promise<DepreciationRun[]> {
  return tx
    .select()
    .from(fixedAssetRuns)
    .where(eq(fixedAssetRuns.organizationId, organizationId))
    .orderBy(desc(fixedAssetRuns.monthEnd), desc(fixedAssetRuns.createdAt))
    .limit(limit);
}

export async function latestPostedRun(
  tx: Transaction,
  organizationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<DepreciationRun | undefined> {
  const query = tx
    .select()
    .from(fixedAssetRuns)
    .where(
      and(eq(fixedAssetRuns.organizationId, organizationId), eq(fixedAssetRuns.status, 'POSTED')),
    )
    .orderBy(desc(fixedAssetRuns.monthEnd))
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function updateRun(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof fixedAssetRuns.$inferInsert>;
  },
): Promise<DepreciationRun | undefined> {
  const [row] = await tx
    .update(fixedAssetRuns)
    .set({ ...input.set, version: sql`${fixedAssetRuns.version} + 1` })
    .where(
      and(
        eq(fixedAssetRuns.organizationId, input.organizationId),
        eq(fixedAssetRuns.id, input.id),
        eq(fixedAssetRuns.version, input.version),
        eq(fixedAssetRuns.status, 'POSTED'),
      ),
    )
    .returning();
  return row;
}

export async function runNumberExists(tx: Transaction, organizationId: string, number: string) {
  const [row] = await tx
    .select({ id: fixedAssetRuns.id })
    .from(fixedAssetRuns)
    .where(
      and(eq(fixedAssetRuns.organizationId, organizationId), eq(fixedAssetRuns.number, number)),
    )
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Disposals and transfers
// ---------------------------------------------------------------------------

export async function insertDisposal(
  tx: Transaction,
  values: typeof fixedAssetDisposals.$inferInsert,
): Promise<AssetDisposal> {
  const [row] = await tx.insert(fixedAssetDisposals).values(values).returning();
  return row!;
}

export async function getDisposal(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<AssetDisposal | undefined> {
  const query = tx
    .select()
    .from(fixedAssetDisposals)
    .where(
      and(eq(fixedAssetDisposals.organizationId, organizationId), eq(fixedAssetDisposals.id, id)),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listDisposals(
  tx: Transaction,
  organizationId: string,
  assetId: string | null,
  limit: number,
): Promise<AssetDisposal[]> {
  return tx
    .select()
    .from(fixedAssetDisposals)
    .where(
      and(
        eq(fixedAssetDisposals.organizationId, organizationId),
        assetId ? eq(fixedAssetDisposals.assetId, assetId) : undefined,
      ),
    )
    .orderBy(desc(fixedAssetDisposals.disposalDate), desc(fixedAssetDisposals.createdAt))
    .limit(limit);
}

export async function updateDisposal(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof fixedAssetDisposals.$inferInsert>;
  },
): Promise<AssetDisposal | undefined> {
  const [row] = await tx
    .update(fixedAssetDisposals)
    .set({ ...input.set, version: sql`${fixedAssetDisposals.version} + 1` })
    .where(
      and(
        eq(fixedAssetDisposals.organizationId, input.organizationId),
        eq(fixedAssetDisposals.id, input.id),
        eq(fixedAssetDisposals.version, input.version),
        eq(fixedAssetDisposals.status, 'POSTED'),
      ),
    )
    .returning();
  return row;
}

export async function insertTransfer(
  tx: Transaction,
  values: typeof fixedAssetTransfers.$inferInsert,
): Promise<AssetTransfer> {
  const [row] = await tx.insert(fixedAssetTransfers).values(values).returning();
  return row!;
}

export async function listTransfers(
  tx: Transaction,
  organizationId: string,
  assetId: string,
): Promise<AssetTransfer[]> {
  return tx
    .select()
    .from(fixedAssetTransfers)
    .where(
      and(
        eq(fixedAssetTransfers.organizationId, organizationId),
        eq(fixedAssetTransfers.assetId, assetId),
      ),
    )
    .orderBy(asc(fixedAssetTransfers.transferDate), asc(fixedAssetTransfers.createdAt));
}
