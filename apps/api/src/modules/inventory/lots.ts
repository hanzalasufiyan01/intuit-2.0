import { and, asc, eq, sql } from 'drizzle-orm';
import { date, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';

/** Lots, serials and expiry (migration 0079, ADR 0014 AI-07). Lots carry quantities; cost stays per item. */

export const inventoryLots = pgTable('inventory_lots', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  itemId: uuid('item_id').notNull(),
  code: text('code').notNull(),
  expiryDate: date('expiry_date', { mode: 'string' }),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamptz('created_at').notNull(),
});

export const inventoryLotLevels = pgTable('inventory_lot_levels', {
  organizationId: uuid('organization_id').notNull(),
  itemId: uuid('item_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  lotId: uuid('lot_id').notNull(),
  quantity: numeric('quantity', { precision: 28, scale: 6 }).notNull().default('0'),
});

export const inventoryDocumentLots = pgTable('inventory_document_lots', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['bill', 'vendor_credit'] }).notNull(),
  documentId: uuid('document_id').notNull(),
  itemId: uuid('item_id').notNull(),
  lotCode: text('lot_code').notNull(),
  expiryDate: date('expiry_date', { mode: 'string' }),
  quantity: numeric('quantity', { precision: 28, scale: 6 }).notNull(),
});

export type Lot = typeof inventoryLots.$inferSelect;
export type DocumentLot = typeof inventoryDocumentLots.$inferSelect;
export type LotDocumentType = 'bill' | 'vendor_credit';

export interface LotLevelRow {
  lotId: string;
  code: string;
  expiryDate: string | null;
  createdAt: Date;
  warehouseId: string;
  quantity: string;
}

export async function findLotByCode(
  tx: Transaction,
  organizationId: string,
  itemId: string,
  code: string,
) {
  const [row] = await tx
    .select()
    .from(inventoryLots)
    .where(
      and(
        eq(inventoryLots.organizationId, organizationId),
        eq(inventoryLots.itemId, itemId),
        sql`lower(${inventoryLots.code}) = lower(${code})`,
      ),
    );
  return row;
}

export async function insertLot(tx: Transaction, values: typeof inventoryLots.$inferInsert) {
  const [row] = await tx.insert(inventoryLots).values(values).returning();
  return row!;
}

/** Every lot of an item with its quantity per warehouse (zero levels included). */
export async function lotLevelsOfItem(
  tx: Transaction,
  organizationId: string,
  itemId: string,
): Promise<LotLevelRow[]> {
  const result = await tx.execute<{
    lot_id: string;
    code: string;
    expiry_date: string | null;
    created_at: Date;
    warehouse_id: string;
    quantity: string;
  }>(sql`
    SELECT l.id AS lot_id, l.code, l.expiry_date::text AS expiry_date, l.created_at,
           v.warehouse_id, v.quantity::text AS quantity
      FROM inventory_lots l
      JOIN inventory_lot_levels v ON v.lot_id = l.id AND v.organization_id = l.organization_id
     WHERE l.organization_id = ${organizationId} AND l.item_id = ${itemId}
     ORDER BY l.expiry_date NULLS LAST, l.created_at, l.code, v.warehouse_id`);
  return result.rows.map((r) => ({
    lotId: r.lot_id,
    code: r.code,
    expiryDate: r.expiry_date,
    createdAt: new Date(r.created_at),
    warehouseId: r.warehouse_id,
    quantity: r.quantity,
  }));
}

/** All lots of an item, including ones with no stock. */
export async function listLotsOfItem(tx: Transaction, organizationId: string, itemId: string) {
  return tx
    .select()
    .from(inventoryLots)
    .where(and(eq(inventoryLots.organizationId, organizationId), eq(inventoryLots.itemId, itemId)))
    .orderBy(asc(inventoryLots.createdAt), asc(inventoryLots.code));
}

/** Lots with stock that expire on or before `through` (expired ones included), soonest first. */
export async function expiringLots(tx: Transaction, organizationId: string, through: string) {
  const result = await tx.execute<{
    lot_id: string;
    item_id: string;
    code: string;
    expiry_date: string;
    warehouse_id: string;
    quantity: string;
  }>(sql`
    SELECT l.id AS lot_id, l.item_id, l.code, l.expiry_date::text AS expiry_date,
           v.warehouse_id, v.quantity::text AS quantity
      FROM inventory_lots l
      JOIN inventory_lot_levels v ON v.lot_id = l.id AND v.organization_id = l.organization_id
     WHERE l.organization_id = ${organizationId} AND l.expiry_date IS NOT NULL
       AND l.expiry_date <= ${through}::date AND v.quantity > 0
     ORDER BY l.expiry_date, l.code, v.warehouse_id`);
  return result.rows.map((r) => ({
    lotId: r.lot_id,
    itemId: r.item_id,
    code: r.code,
    expiryDate: r.expiry_date,
    warehouseId: r.warehouse_id,
    quantity: r.quantity,
  }));
}

export async function documentLotsOf(
  tx: Transaction,
  organizationId: string,
  type: LotDocumentType,
  documentId: string,
) {
  return tx
    .select()
    .from(inventoryDocumentLots)
    .where(
      and(
        eq(inventoryDocumentLots.organizationId, organizationId),
        eq(inventoryDocumentLots.documentType, type),
        eq(inventoryDocumentLots.documentId, documentId),
      ),
    )
    .orderBy(asc(inventoryDocumentLots.itemId), asc(inventoryDocumentLots.lotCode));
}

export async function replaceDocumentLots(
  tx: Transaction,
  organizationId: string,
  type: LotDocumentType,
  documentId: string,
  rows: readonly {
    itemId: string;
    lotCode: string;
    expiryDate: string | null;
    quantity: string;
  }[],
) {
  await tx
    .delete(inventoryDocumentLots)
    .where(
      and(
        eq(inventoryDocumentLots.organizationId, organizationId),
        eq(inventoryDocumentLots.documentType, type),
        eq(inventoryDocumentLots.documentId, documentId),
      ),
    );
  if (rows.length) {
    await tx
      .insert(inventoryDocumentLots)
      .values(rows.map((r) => ({ organizationId, documentType: type, documentId, ...r })));
  }
}

/** The lots a movement moved (code and signed quantity), for the record kept on document lines. */
export async function lotsOfMovement(tx: Transaction, organizationId: string, movementId: string) {
  const result = await tx.execute<{ code: string; quantity: string }>(sql`
    SELECT l.code, sum(e.quantity)::text AS quantity
      FROM inventory_stock_entries e
      JOIN inventory_lots l ON l.id = e.lot_id AND l.organization_id = e.organization_id
     WHERE e.organization_id = ${organizationId} AND e.movement_id = ${movementId}
     GROUP BY l.code ORDER BY l.code`);
  return result.rows.map((r) => ({ lotCode: r.code, quantity: r.quantity }));
}
