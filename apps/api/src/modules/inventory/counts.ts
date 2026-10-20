import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';
import { inventoryNumberSequences } from './schema.js';

/** Physical stock counts (migration 0071, FP-29 A5). */

export const countStatuses = ['DRAFT', 'POSTED', 'CANCELLED'] as const;
export type CountStatus = (typeof countStatuses)[number];

export const inventoryCounts = pgTable('inventory_counts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  countDate: date('count_date', { mode: 'string' }).notNull(),
  status: text('status', { enum: countStatuses }).notNull().default('DRAFT'),
  memo: text('memo').notNull().default(''),
  adjustmentId: uuid('adjustment_id'),
  warehouseId: uuid('warehouse_id'),
  postedAt: timestamptz('posted_at'),
  postedByUserId: uuid('posted_by_user_id'),
  cancelReason: text('cancel_reason'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const inventoryCountLines = pgTable('inventory_count_lines', {
  organizationId: uuid('organization_id').notNull(),
  countId: uuid('count_id').notNull(),
  itemId: uuid('item_id').notNull(),
  expectedQuantity: numeric('expected_quantity', { precision: 28, scale: 6 }).notNull(),
  countedQuantity: numeric('counted_quantity', { precision: 28, scale: 6 }),
});

export type StockCount = typeof inventoryCounts.$inferSelect;
export type StockCountLine = typeof inventoryCountLines.$inferSelect;

export async function takeNextCountNumber(tx: Transaction, organizationId: string) {
  await tx
    .insert(inventoryNumberSequences)
    .values({ organizationId, documentType: 'count', prefix: 'CNT-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(inventoryNumberSequences)
    .set({ nextNumber: sql`${inventoryNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(inventoryNumberSequences.organizationId, organizationId),
        eq(inventoryNumberSequences.documentType, 'count'),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

export async function insertCount(tx: Transaction, values: typeof inventoryCounts.$inferInsert) {
  const [row] = await tx.insert(inventoryCounts).values(values).returning();
  return row!;
}

export async function insertCountLines(
  tx: Transaction,
  values: (typeof inventoryCountLines.$inferInsert)[],
) {
  if (values.length) await tx.insert(inventoryCountLines).values(values);
}

export async function getCount(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(inventoryCounts)
    .where(and(eq(inventoryCounts.organizationId, organizationId), eq(inventoryCounts.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listCounts(tx: Transaction, organizationId: string, limit: number) {
  return tx
    .select()
    .from(inventoryCounts)
    .where(eq(inventoryCounts.organizationId, organizationId))
    .orderBy(desc(inventoryCounts.countDate), desc(inventoryCounts.id))
    .limit(limit);
}

export async function getCountLines(tx: Transaction, organizationId: string, countId: string) {
  return tx
    .select()
    .from(inventoryCountLines)
    .where(
      and(
        eq(inventoryCountLines.organizationId, organizationId),
        eq(inventoryCountLines.countId, countId),
      ),
    )
    .orderBy(asc(inventoryCountLines.itemId));
}

export async function setCountedQuantity(
  tx: Transaction,
  organizationId: string,
  countId: string,
  itemId: string,
  counted: string | null,
) {
  const rows = await tx
    .update(inventoryCountLines)
    .set({ countedQuantity: counted })
    .where(
      and(
        eq(inventoryCountLines.organizationId, organizationId),
        eq(inventoryCountLines.countId, countId),
        eq(inventoryCountLines.itemId, itemId),
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function updateCount(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof inventoryCounts.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(inventoryCounts)
    .set({ ...input.set, version: sql`${inventoryCounts.version} + 1` })
    .where(
      and(
        eq(inventoryCounts.organizationId, input.organizationId),
        eq(inventoryCounts.id, input.id),
        eq(inventoryCounts.version, input.version),
      ),
    )
    .returning();
  return row;
}
