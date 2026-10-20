import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';
import { inventoryNumberSequences } from './schema.js';

/** Landed cost (migration 0081, ADR 0014 AI-08). */

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });

export const inventoryLandedCosts = pgTable('inventory_landed_costs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  costDate: date('cost_date', { mode: 'string' }).notNull(),
  billId: uuid('bill_id').notNull(),
  description: text('description').notNull(),
  amount: money('amount').notNull(),
  basis: text('basis', { enum: ['value', 'quantity'] }).notNull(),
  creditAccountId: uuid('credit_account_id').notNull(),
  status: text('status', { enum: ['POSTED', 'VOID'] })
    .notNull()
    .default('POSTED'),
  journalId: uuid('journal_id'),
  accountingEventId: uuid('accounting_event_id'),
  voidedByUserId: uuid('voided_by_user_id'),
  voidedAt: timestamptz('voided_at'),
  voidReason: text('void_reason'),
  voidJournalId: uuid('void_journal_id'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const inventoryLandedCostLines = pgTable('inventory_landed_cost_lines', {
  organizationId: uuid('organization_id').notNull(),
  landedCostId: uuid('landed_cost_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id').notNull(),
  allocated: money('allocated').notNull(),
  toInventory: money('to_inventory').notNull(),
  toCogs: money('to_cogs').notNull(),
  movementId: uuid('movement_id'),
});

export type LandedCost = typeof inventoryLandedCosts.$inferSelect;
export type LandedCostLine = typeof inventoryLandedCostLines.$inferSelect;

export async function takeNextLandedCostNumber(tx: Transaction, organizationId: string) {
  await tx
    .insert(inventoryNumberSequences)
    .values({ organizationId, documentType: 'landed_cost', prefix: 'LC-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(inventoryNumberSequences)
    .set({ nextNumber: sql`${inventoryNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(inventoryNumberSequences.organizationId, organizationId),
        eq(inventoryNumberSequences.documentType, 'landed_cost'),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

export async function insertLandedCost(
  tx: Transaction,
  values: typeof inventoryLandedCosts.$inferInsert,
) {
  const [row] = await tx.insert(inventoryLandedCosts).values(values).returning();
  return row!;
}

export async function insertLandedCostLines(
  tx: Transaction,
  values: (typeof inventoryLandedCostLines.$inferInsert)[],
) {
  if (values.length) await tx.insert(inventoryLandedCostLines).values(values);
}

export async function getLandedCost(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(inventoryLandedCosts)
    .where(
      and(eq(inventoryLandedCosts.organizationId, organizationId), eq(inventoryLandedCosts.id, id)),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getLandedCostLines(tx: Transaction, organizationId: string, id: string) {
  return tx
    .select()
    .from(inventoryLandedCostLines)
    .where(
      and(
        eq(inventoryLandedCostLines.organizationId, organizationId),
        eq(inventoryLandedCostLines.landedCostId, id),
      ),
    )
    .orderBy(asc(inventoryLandedCostLines.lineNo));
}

export async function listLandedCosts(
  tx: Transaction,
  organizationId: string,
  filter: { billId?: string | undefined; limit: number },
) {
  return tx
    .select()
    .from(inventoryLandedCosts)
    .where(
      and(
        eq(inventoryLandedCosts.organizationId, organizationId),
        filter.billId ? eq(inventoryLandedCosts.billId, filter.billId) : undefined,
      ),
    )
    .orderBy(desc(inventoryLandedCosts.costDate), desc(inventoryLandedCosts.id))
    .limit(filter.limit);
}

export async function markLandedCostVoid(
  tx: Transaction,
  organizationId: string,
  id: string,
  version: number,
  by: { userId: string; at: Date; reason: string; journalId: string },
) {
  const [row] = await tx
    .update(inventoryLandedCosts)
    .set({
      status: 'VOID',
      voidedByUserId: by.userId,
      voidedAt: by.at,
      voidReason: by.reason,
      voidJournalId: by.journalId,
      updatedByUserId: by.userId,
      updatedAt: by.at,
      version: sql`${inventoryLandedCosts.version} + 1`,
    })
    .where(
      and(
        eq(inventoryLandedCosts.organizationId, organizationId),
        eq(inventoryLandedCosts.id, id),
        eq(inventoryLandedCosts.version, version),
        eq(inventoryLandedCosts.status, 'POSTED'),
      ),
    )
    .returning();
  return row;
}
