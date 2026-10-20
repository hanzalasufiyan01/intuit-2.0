import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { boolean, date, integer, jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';
import { inventoryNumberSequences } from './schema.js';

/** Warehouses, the stock placement ledger and transfers (migration 0078, ADR 0014). */

const quantity = (name: string) => numeric(name, { precision: 28, scale: 6 });

export const inventoryWarehouses = pgTable('inventory_warehouses', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  status: text('status', { enum: ['ACTIVE', 'ARCHIVED'] })
    .notNull()
    .default('ACTIVE'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const inventoryTransfers = pgTable('inventory_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  transferDate: date('transfer_date', { mode: 'string' }).notNull(),
  fromWarehouseId: uuid('from_warehouse_id').notNull(),
  toWarehouseId: uuid('to_warehouse_id').notNull(),
  memo: text('memo').notNull().default(''),
  status: text('status', { enum: ['POSTED', 'VOID'] })
    .notNull()
    .default('POSTED'),
  voidedByUserId: uuid('voided_by_user_id'),
  voidedAt: timestamptz('voided_at'),
  voidReason: text('void_reason'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export const inventoryTransferLines = pgTable('inventory_transfer_lines', {
  organizationId: uuid('organization_id').notNull(),
  transferId: uuid('transfer_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id').notNull(),
  quantity: quantity('quantity').notNull(),
  lots: jsonb('lots').$type<{ lotId: string; quantity: string }[] | null>(),
});

export const inventoryStockEntries = pgTable('inventory_stock_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  itemId: uuid('item_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  quantity: quantity('quantity').notNull(),
  entryKind: text('entry_kind', { enum: ['movement', 'transfer', 'backfill'] }).notNull(),
  movementId: uuid('movement_id'),
  transferId: uuid('transfer_id'),
  lotId: uuid('lot_id'),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamptz('created_at').notNull(),
});

export const inventoryStockLevels = pgTable('inventory_stock_levels', {
  organizationId: uuid('organization_id').notNull(),
  itemId: uuid('item_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  quantity: quantity('quantity').notNull().default('0'),
});

export const inventoryDocumentLocations = pgTable('inventory_document_locations', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['invoice', 'bill', 'vendor_credit'] }).notNull(),
  documentId: uuid('document_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  setByUserId: uuid('set_by_user_id'),
  setAt: timestamptz('set_at').notNull(),
});

export type Warehouse = typeof inventoryWarehouses.$inferSelect;
export type Transfer = typeof inventoryTransfers.$inferSelect;
export type TransferLine = typeof inventoryTransferLines.$inferSelect;
export type StockEntry = typeof inventoryStockEntries.$inferSelect;
export type StockLevel = typeof inventoryStockLevels.$inferSelect;
export type DocumentLocationType = 'invoice' | 'bill' | 'vendor_credit';

// Warehouses ------------------------------------------------------------------

/** The default warehouse, created on first use. Safe under concurrency (unique default index). */
export async function ensureDefaultWarehouse(
  tx: Transaction,
  organizationId: string,
  at: Date,
): Promise<Warehouse> {
  const find = () =>
    tx
      .select()
      .from(inventoryWarehouses)
      .where(
        and(
          eq(inventoryWarehouses.organizationId, organizationId),
          eq(inventoryWarehouses.isDefault, true),
        ),
      );
  const [existing] = await find();
  if (existing) return existing;
  await tx
    .insert(inventoryWarehouses)
    .values({
      organizationId,
      code: 'MAIN',
      name: 'Main warehouse',
      isDefault: true,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing();
  const [created] = await find();
  return created!;
}

export async function listWarehouses(tx: Transaction, organizationId: string) {
  return tx
    .select()
    .from(inventoryWarehouses)
    .where(eq(inventoryWarehouses.organizationId, organizationId))
    .orderBy(desc(inventoryWarehouses.isDefault), asc(sql`lower(${inventoryWarehouses.code})`));
}

export async function getWarehouse(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(inventoryWarehouses)
    .where(
      and(eq(inventoryWarehouses.organizationId, organizationId), eq(inventoryWarehouses.id, id)),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function insertWarehouse(
  tx: Transaction,
  values: typeof inventoryWarehouses.$inferInsert,
) {
  const [row] = await tx.insert(inventoryWarehouses).values(values).returning();
  return row!;
}

export async function updateWarehouse(
  tx: Transaction,
  organizationId: string,
  id: string,
  version: number,
  set: Partial<Pick<Warehouse, 'name' | 'status' | 'isDefault' | 'updatedAt' | 'updatedByUserId'>>,
) {
  const [row] = await tx
    .update(inventoryWarehouses)
    .set({ ...set, version: sql`${inventoryWarehouses.version} + 1` })
    .where(
      and(
        eq(inventoryWarehouses.organizationId, organizationId),
        eq(inventoryWarehouses.id, id),
        eq(inventoryWarehouses.version, version),
      ),
    )
    .returning();
  return row;
}

export async function warehouseCodeExists(tx: Transaction, organizationId: string, code: string) {
  const result = await tx.execute<{ n: number }>(
    sql`SELECT 1 AS n FROM inventory_warehouses WHERE organization_id = ${organizationId} AND lower(code) = lower(${code}) LIMIT 1`,
  );
  return result.rows.length > 0;
}

// Levels and entries ------------------------------------------------------------

/** Quantity per warehouse of the given items (items without stock are absent). */
export async function levelsOfItems(
  tx: Transaction,
  organizationId: string,
  itemIds: readonly string[],
) {
  if (!itemIds.length) return [] as StockLevel[];
  return tx
    .select()
    .from(inventoryStockLevels)
    .where(
      and(
        eq(inventoryStockLevels.organizationId, organizationId),
        inArray(inventoryStockLevels.itemId, [...new Set(itemIds)]),
      ),
    );
}

export async function levelsOfWarehouse(
  tx: Transaction,
  organizationId: string,
  warehouseId: string,
) {
  return tx
    .select()
    .from(inventoryStockLevels)
    .where(
      and(
        eq(inventoryStockLevels.organizationId, organizationId),
        eq(inventoryStockLevels.warehouseId, warehouseId),
      ),
    );
}

export async function insertStockEntries(
  tx: Transaction,
  values: (typeof inventoryStockEntries.$inferInsert)[],
) {
  if (values.length) await tx.insert(inventoryStockEntries).values(values);
}

export async function entriesOfMovement(
  tx: Transaction,
  organizationId: string,
  movementId: string,
) {
  return tx
    .select()
    .from(inventoryStockEntries)
    .where(
      and(
        eq(inventoryStockEntries.organizationId, organizationId),
        eq(inventoryStockEntries.movementId, movementId),
      ),
    )
    .orderBy(asc(inventoryStockEntries.createdAt), asc(inventoryStockEntries.id));
}

export async function entriesOfTransfer(
  tx: Transaction,
  organizationId: string,
  transferId: string,
) {
  return tx
    .select()
    .from(inventoryStockEntries)
    .where(
      and(
        eq(inventoryStockEntries.organizationId, organizationId),
        eq(inventoryStockEntries.transferId, transferId),
      ),
    )
    .orderBy(asc(inventoryStockEntries.createdAt), asc(inventoryStockEntries.id));
}

// Document locations --------------------------------------------------------------

export async function getDocumentLocation(
  tx: Transaction,
  organizationId: string,
  type: DocumentLocationType,
  documentId: string,
) {
  const [row] = await tx
    .select()
    .from(inventoryDocumentLocations)
    .where(
      and(
        eq(inventoryDocumentLocations.organizationId, organizationId),
        eq(inventoryDocumentLocations.documentType, type),
        eq(inventoryDocumentLocations.documentId, documentId),
      ),
    );
  return row;
}

export async function setDocumentLocation(
  tx: Transaction,
  values: typeof inventoryDocumentLocations.$inferInsert,
) {
  await tx
    .insert(inventoryDocumentLocations)
    .values(values)
    .onConflictDoUpdate({
      target: [inventoryDocumentLocations.documentType, inventoryDocumentLocations.documentId],
      set: {
        warehouseId: values.warehouseId,
        setByUserId: values.setByUserId,
        setAt: values.setAt,
      },
    });
}

export async function clearDocumentLocation(
  tx: Transaction,
  organizationId: string,
  type: DocumentLocationType,
  documentId: string,
) {
  await tx
    .delete(inventoryDocumentLocations)
    .where(
      and(
        eq(inventoryDocumentLocations.organizationId, organizationId),
        eq(inventoryDocumentLocations.documentType, type),
        eq(inventoryDocumentLocations.documentId, documentId),
      ),
    );
}

// Transfers -----------------------------------------------------------------------

export async function takeNextTransferNumber(tx: Transaction, organizationId: string) {
  await tx
    .insert(inventoryNumberSequences)
    .values({ organizationId, documentType: 'transfer', prefix: 'TRF-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(inventoryNumberSequences)
    .set({ nextNumber: sql`${inventoryNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(inventoryNumberSequences.organizationId, organizationId),
        eq(inventoryNumberSequences.documentType, 'transfer'),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

export async function insertTransfer(
  tx: Transaction,
  values: typeof inventoryTransfers.$inferInsert,
) {
  const [row] = await tx.insert(inventoryTransfers).values(values).returning();
  return row!;
}

export async function insertTransferLines(
  tx: Transaction,
  values: (typeof inventoryTransferLines.$inferInsert)[],
) {
  if (values.length) await tx.insert(inventoryTransferLines).values(values);
}

export async function getTransfer(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(inventoryTransfers)
    .where(
      and(eq(inventoryTransfers.organizationId, organizationId), eq(inventoryTransfers.id, id)),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getTransferLines(
  tx: Transaction,
  organizationId: string,
  transferId: string,
) {
  return tx
    .select()
    .from(inventoryTransferLines)
    .where(
      and(
        eq(inventoryTransferLines.organizationId, organizationId),
        eq(inventoryTransferLines.transferId, transferId),
      ),
    )
    .orderBy(asc(inventoryTransferLines.lineNo));
}

export async function listTransfers(tx: Transaction, organizationId: string, limit: number) {
  return tx
    .select()
    .from(inventoryTransfers)
    .where(eq(inventoryTransfers.organizationId, organizationId))
    .orderBy(desc(inventoryTransfers.transferDate), desc(inventoryTransfers.id))
    .limit(limit);
}

export async function markTransferVoid(
  tx: Transaction,
  organizationId: string,
  id: string,
  version: number,
  by: { userId: string; at: Date; reason: string },
) {
  const [row] = await tx
    .update(inventoryTransfers)
    .set({
      status: 'VOID',
      voidedByUserId: by.userId,
      voidedAt: by.at,
      voidReason: by.reason,
      version: sql`${inventoryTransfers.version} + 1`,
    })
    .where(
      and(
        eq(inventoryTransfers.organizationId, organizationId),
        eq(inventoryTransfers.id, id),
        eq(inventoryTransfers.version, version),
        eq(inventoryTransfers.status, 'POSTED'),
      ),
    )
    .returning();
  return row;
}
