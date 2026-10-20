import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { salesItems } from '../catalog/index.js';
import {
  inventoryAdjustmentLines,
  inventoryAdjustments,
  inventoryBalances,
  inventoryItems,
  inventoryMovements,
  inventoryNumberSequences,
  inventoryReturnLines,
  inventoryReturns,
  inventorySettings,
  type MovementKind,
} from './schema.js';

/** Inventory data access. The rules (costing, negative stock, journals) live in the service. */

export type InventorySettings = typeof inventorySettings.$inferSelect;
export type TrackedItem = typeof inventoryItems.$inferSelect;
export type StockBalance = typeof inventoryBalances.$inferSelect;
export type StockMovement = typeof inventoryMovements.$inferSelect;
export type StockAdjustment = typeof inventoryAdjustments.$inferSelect;
export type StockAdjustmentLine = typeof inventoryAdjustmentLines.$inferSelect;
export type StockReturn = typeof inventoryReturns.$inferSelect;
export type StockReturnLine = typeof inventoryReturnLines.$inferSelect;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getInventorySettings(
  tx: Transaction,
  organizationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<InventorySettings | undefined> {
  const query = tx
    .select()
    .from(inventorySettings)
    .where(eq(inventorySettings.organizationId, organizationId));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function saveInventorySettings(
  tx: Transaction,
  input: {
    organizationId: string;
    version: number;
    negativeStockPolicy: 'block' | 'allow';
    adjustmentAccountId: string | null;
    userId: string;
    at: Date;
  },
): Promise<InventorySettings | undefined> {
  if (input.version === 0) {
    const [row] = await tx
      .insert(inventorySettings)
      .values({
        organizationId: input.organizationId,
        negativeStockPolicy: input.negativeStockPolicy,
        adjustmentAccountId: input.adjustmentAccountId,
        updatedByUserId: input.userId,
        updatedAt: input.at,
      })
      .onConflictDoNothing()
      .returning();
    return row;
  }
  const [row] = await tx
    .update(inventorySettings)
    .set({
      negativeStockPolicy: input.negativeStockPolicy,
      adjustmentAccountId: input.adjustmentAccountId,
      updatedByUserId: input.userId,
      updatedAt: input.at,
      version: sql`${inventorySettings.version} + 1`,
    })
    .where(
      and(
        eq(inventorySettings.organizationId, input.organizationId),
        eq(inventorySettings.version, input.version),
      ),
    )
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Tracked items and balances
// ---------------------------------------------------------------------------

export async function getTrackedItem(
  tx: Transaction,
  organizationId: string,
  itemId: string,
): Promise<TrackedItem | undefined> {
  const [row] = await tx
    .select()
    .from(inventoryItems)
    .where(
      and(eq(inventoryItems.organizationId, organizationId), eq(inventoryItems.itemId, itemId)),
    );
  return row;
}

export async function getTrackedItems(
  tx: Transaction,
  organizationId: string,
  itemIds: readonly string[],
): Promise<Map<string, TrackedItem>> {
  const unique = [...new Set(itemIds)];
  if (!unique.length) return new Map();
  const rows = await tx
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.organizationId, organizationId),
        inArray(inventoryItems.itemId, unique),
      ),
    );
  return new Map(rows.map((r) => [r.itemId, r]));
}

/** Account ids that are some tracked item's inventory account. */
export async function inventoryAccountIds(
  tx: Transaction,
  organizationId: string,
): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ id: inventoryItems.inventoryAccountId })
    .from(inventoryItems)
    .where(eq(inventoryItems.organizationId, organizationId));
  return new Set(rows.map((r) => r.id));
}

export async function insertTrackedItem(
  tx: Transaction,
  values: typeof inventoryItems.$inferInsert,
  negativeAllowed: boolean,
): Promise<TrackedItem> {
  const [row] = await tx.insert(inventoryItems).values(values).returning();
  await tx.insert(inventoryBalances).values({
    organizationId: values.organizationId,
    itemId: values.itemId,
    negativeAllowed,
  });
  return row!;
}

export async function updateTrackedItem(
  tx: Transaction,
  input: {
    organizationId: string;
    itemId: string;
    version: number;
    set: Partial<typeof inventoryItems.$inferInsert>;
  },
): Promise<TrackedItem | undefined> {
  const [row] = await tx
    .update(inventoryItems)
    .set({ ...input.set, version: sql`${inventoryItems.version} + 1` })
    .where(
      and(
        eq(inventoryItems.organizationId, input.organizationId),
        eq(inventoryItems.itemId, input.itemId),
        eq(inventoryItems.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function deleteTrackedItem(tx: Transaction, organizationId: string, itemId: string) {
  await tx
    .delete(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.organizationId, organizationId),
        eq(inventoryBalances.itemId, itemId),
      ),
    );
  await tx
    .delete(inventoryItems)
    .where(
      and(eq(inventoryItems.organizationId, organizationId), eq(inventoryItems.itemId, itemId)),
    );
}

export interface TrackedItemRow {
  itemId: string;
  sku: string | null;
  name: string;
  inventoryAccountId: string;
  cogsAccountId: string;
  reorderPoint: string | null;
  trackingMode: 'none' | 'lot' | 'serial';
  expiryTracked: boolean;
  baseUnit: string;
  purchaseUnit: string | null;
  purchaseFactor: string | null;
  salesUnit: string | null;
  salesFactor: string | null;
  quantity: string;
  value: string;
  lastUnitCost: string;
  version: number;
}

export async function listTrackedItems(
  tx: Transaction,
  organizationId: string,
): Promise<TrackedItemRow[]> {
  return tx
    .select({
      itemId: inventoryItems.itemId,
      sku: salesItems.sku,
      name: salesItems.name,
      inventoryAccountId: inventoryItems.inventoryAccountId,
      cogsAccountId: inventoryItems.cogsAccountId,
      reorderPoint: inventoryItems.reorderPoint,
      trackingMode: inventoryItems.trackingMode,
      expiryTracked: inventoryItems.expiryTracked,
      baseUnit: inventoryItems.baseUnit,
      purchaseUnit: inventoryItems.purchaseUnit,
      purchaseFactor: inventoryItems.purchaseFactor,
      salesUnit: inventoryItems.salesUnit,
      salesFactor: inventoryItems.salesFactor,
      quantity: inventoryBalances.quantity,
      value: inventoryBalances.value,
      lastUnitCost: inventoryBalances.lastUnitCost,
      version: inventoryItems.version,
    })
    .from(inventoryItems)
    .innerJoin(
      salesItems,
      and(
        eq(salesItems.id, inventoryItems.itemId),
        eq(salesItems.organizationId, inventoryItems.organizationId),
      ),
    )
    .innerJoin(
      inventoryBalances,
      and(
        eq(inventoryBalances.itemId, inventoryItems.itemId),
        eq(inventoryBalances.organizationId, inventoryItems.organizationId),
      ),
    )
    .where(eq(inventoryItems.organizationId, organizationId))
    .orderBy(asc(sql`lower(${salesItems.name})`), asc(salesItems.id));
}

/** Locks the balances of the items in a fixed order (no deadlock between two documents). */
export async function lockBalances(
  tx: Transaction,
  organizationId: string,
  itemIds: readonly string[],
): Promise<Map<string, StockBalance>> {
  const unique = [...new Set(itemIds)].sort();
  if (!unique.length) return new Map();
  const rows = await tx
    .select()
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.organizationId, organizationId),
        inArray(inventoryBalances.itemId, unique),
      ),
    )
    .orderBy(asc(inventoryBalances.itemId))
    .for('update');
  return new Map(rows.map((r) => [r.itemId, r]));
}

export async function getBalance(
  tx: Transaction,
  organizationId: string,
  itemId: string,
): Promise<StockBalance | undefined> {
  const [row] = await tx
    .select()
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.organizationId, organizationId),
        eq(inventoryBalances.itemId, itemId),
      ),
    );
  return row;
}

export async function writeBalance(
  tx: Transaction,
  input: {
    organizationId: string;
    itemId: string;
    quantity: string;
    value: string;
    lastUnitCost: string;
    negativeAllowed: boolean;
  },
) {
  await tx
    .update(inventoryBalances)
    .set({
      quantity: input.quantity,
      value: input.value,
      lastUnitCost: input.lastUnitCost,
      negativeAllowed: input.negativeAllowed,
      version: sql`${inventoryBalances.version} + 1`,
    })
    .where(
      and(
        eq(inventoryBalances.organizationId, input.organizationId),
        eq(inventoryBalances.itemId, input.itemId),
      ),
    );
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

export async function insertMovement(
  tx: Transaction,
  values: typeof inventoryMovements.$inferInsert,
): Promise<StockMovement> {
  const [row] = await tx.insert(inventoryMovements).values(values).returning();
  return row!;
}

export async function getMovementsBySource(
  tx: Transaction,
  organizationId: string,
  input: { sourceType: string; sourceId: string; kind: MovementKind },
): Promise<StockMovement[]> {
  return tx
    .select()
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, organizationId),
        eq(inventoryMovements.sourceType, input.sourceType),
        eq(inventoryMovements.sourceId, input.sourceId),
        eq(inventoryMovements.kind, input.kind),
      ),
    )
    .orderBy(asc(inventoryMovements.itemId));
}

export async function listMovements(
  tx: Transaction,
  input: {
    organizationId: string;
    itemId: string;
    after?: { createdAt: Date; id: string } | undefined;
    limit: number;
  },
): Promise<StockMovement[]> {
  return tx
    .select()
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, input.organizationId),
        eq(inventoryMovements.itemId, input.itemId),
        input.after
          ? sql`(${inventoryMovements.createdAt}, ${inventoryMovements.id}) < (${input.after.createdAt.toISOString()}::timestamptz, ${input.after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(inventoryMovements.createdAt), desc(inventoryMovements.id))
    .limit(input.limit);
}

/** Stock value per inventory account and the GL balance of the same account (base currency). */
export async function valuationByAccount(tx: Transaction, organizationId: string) {
  const { rows } = await tx.execute<{
    account_id: string;
    stock_value: string;
    gl_balance: string;
  }>(sql`
    SELECT a.account_id,
           a.stock_value::text,
           coalesce((SELECT sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0))
                       FROM accounting_journal_lines l
                       JOIN accounting_journal_entries j
                         ON j.id = l.journal_id AND j.organization_id = l.organization_id
                      WHERE l.organization_id = ${organizationId}
                        AND l.account_id = a.account_id
                        AND j.status IN ('POSTED', 'REVERSED')), 0)::text AS gl_balance
      FROM (SELECT i.inventory_account_id AS account_id, sum(b.value) AS stock_value
              FROM inventory_items i
              JOIN inventory_balances b
                ON b.item_id = i.item_id AND b.organization_id = i.organization_id
             WHERE i.organization_id = ${organizationId}
             GROUP BY i.inventory_account_id) a`);
  return rows.map((r) => ({
    accountId: r.account_id,
    stockValue: r.stock_value,
    glBalance: r.gl_balance,
  }));
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

export async function insertAdjustment(
  tx: Transaction,
  values: typeof inventoryAdjustments.$inferInsert,
): Promise<StockAdjustment> {
  const [row] = await tx.insert(inventoryAdjustments).values(values).returning();
  return row!;
}

export async function insertAdjustmentLines(
  tx: Transaction,
  values: (typeof inventoryAdjustmentLines.$inferInsert)[],
) {
  if (values.length) await tx.insert(inventoryAdjustmentLines).values(values);
}

export async function getAdjustment(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<StockAdjustment | undefined> {
  const query = tx
    .select()
    .from(inventoryAdjustments)
    .where(
      and(eq(inventoryAdjustments.organizationId, organizationId), eq(inventoryAdjustments.id, id)),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getAdjustmentLines(
  tx: Transaction,
  organizationId: string,
  adjustmentId: string,
): Promise<StockAdjustmentLine[]> {
  return tx
    .select()
    .from(inventoryAdjustmentLines)
    .where(
      and(
        eq(inventoryAdjustmentLines.organizationId, organizationId),
        eq(inventoryAdjustmentLines.adjustmentId, adjustmentId),
      ),
    )
    .orderBy(asc(inventoryAdjustmentLines.lineNo));
}

export async function listAdjustments(
  tx: Transaction,
  organizationId: string,
  limit: number,
): Promise<StockAdjustment[]> {
  return tx
    .select()
    .from(inventoryAdjustments)
    .where(eq(inventoryAdjustments.organizationId, organizationId))
    .orderBy(desc(inventoryAdjustments.adjustmentDate), desc(inventoryAdjustments.id))
    .limit(limit);
}

export async function updateAdjustment(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof inventoryAdjustments.$inferInsert>;
  },
): Promise<StockAdjustment | undefined> {
  const [row] = await tx
    .update(inventoryAdjustments)
    .set({ ...input.set, version: sql`${inventoryAdjustments.version} + 1` })
    .where(
      and(
        eq(inventoryAdjustments.organizationId, input.organizationId),
        eq(inventoryAdjustments.id, input.id),
        eq(inventoryAdjustments.version, input.version),
        eq(inventoryAdjustments.status, 'POSTED'),
      ),
    )
    .returning();
  return row;
}

export async function adjustmentNumberExists(
  tx: Transaction,
  organizationId: string,
  number: string,
) {
  const [row] = await tx
    .select({ id: inventoryAdjustments.id })
    .from(inventoryAdjustments)
    .where(
      and(
        eq(inventoryAdjustments.organizationId, organizationId),
        eq(inventoryAdjustments.number, number),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function takeNextAdjustmentNumber(
  tx: Transaction,
  organizationId: string,
): Promise<string> {
  await tx
    .insert(inventoryNumberSequences)
    .values({ organizationId, documentType: 'adjustment', prefix: 'ADJ-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(inventoryNumberSequences)
    .set({ nextNumber: sql`${inventoryNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(inventoryNumberSequences.organizationId, organizationId),
        eq(inventoryNumberSequences.documentType, 'adjustment'),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

// ---------------------------------------------------------------------------
// Customer returns (migration 0062)
// ---------------------------------------------------------------------------

export async function insertReturn(
  tx: Transaction,
  values: typeof inventoryReturns.$inferInsert,
): Promise<StockReturn> {
  const [row] = await tx.insert(inventoryReturns).values(values).returning();
  return row!;
}

export async function insertReturnLines(
  tx: Transaction,
  values: (typeof inventoryReturnLines.$inferInsert)[],
) {
  if (values.length) await tx.insert(inventoryReturnLines).values(values);
}

export async function getReturn(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<StockReturn | undefined> {
  const query = tx
    .select()
    .from(inventoryReturns)
    .where(and(eq(inventoryReturns.organizationId, organizationId), eq(inventoryReturns.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getReturnLines(
  tx: Transaction,
  organizationId: string,
  returnId: string,
): Promise<StockReturnLine[]> {
  return tx
    .select()
    .from(inventoryReturnLines)
    .where(
      and(
        eq(inventoryReturnLines.organizationId, organizationId),
        eq(inventoryReturnLines.returnId, returnId),
      ),
    )
    .orderBy(asc(inventoryReturnLines.lineNo));
}

export async function listReturns(
  tx: Transaction,
  organizationId: string,
  limit: number,
): Promise<StockReturn[]> {
  return tx
    .select()
    .from(inventoryReturns)
    .where(eq(inventoryReturns.organizationId, organizationId))
    .orderBy(desc(inventoryReturns.returnDate), desc(inventoryReturns.id))
    .limit(limit);
}

export async function updateReturn(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof inventoryReturns.$inferInsert>;
  },
): Promise<StockReturn | undefined> {
  const [row] = await tx
    .update(inventoryReturns)
    .set({ ...input.set, version: sql`${inventoryReturns.version} + 1` })
    .where(
      and(
        eq(inventoryReturns.organizationId, input.organizationId),
        eq(inventoryReturns.id, input.id),
        eq(inventoryReturns.version, input.version),
        eq(inventoryReturns.status, 'POSTED'),
      ),
    )
    .returning();
  return row;
}

export async function returnNumberExists(tx: Transaction, organizationId: string, number: string) {
  const [row] = await tx
    .select({ id: inventoryReturns.id })
    .from(inventoryReturns)
    .where(
      and(eq(inventoryReturns.organizationId, organizationId), eq(inventoryReturns.number, number)),
    )
    .limit(1);
  return Boolean(row);
}

export async function takeNextReturnNumber(
  tx: Transaction,
  organizationId: string,
): Promise<string> {
  await tx
    .insert(inventoryNumberSequences)
    .values({ organizationId, documentType: 'return', prefix: 'RET-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(inventoryNumberSequences)
    .set({ nextNumber: sql`${inventoryNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(inventoryNumberSequences.organizationId, organizationId),
        eq(inventoryNumberSequences.documentType, 'return'),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

/** Quantity already returned per item against a credit note, by returns that are not void. */
export async function returnedQuantities(
  tx: Transaction,
  organizationId: string,
  creditNoteId: string,
): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      itemId: inventoryReturnLines.itemId,
      quantity: sql<string>`sum(${inventoryReturnLines.quantity})::text`,
    })
    .from(inventoryReturnLines)
    .innerJoin(
      inventoryReturns,
      and(
        eq(inventoryReturns.id, inventoryReturnLines.returnId),
        eq(inventoryReturns.organizationId, inventoryReturnLines.organizationId),
      ),
    )
    .where(
      and(
        eq(inventoryReturns.organizationId, organizationId),
        eq(inventoryReturns.creditNoteId, creditNoteId),
        eq(inventoryReturns.status, 'POSTED'),
      ),
    )
    .groupBy(inventoryReturnLines.itemId);
  return new Map(rows.map((r) => [r.itemId, r.quantity]));
}
