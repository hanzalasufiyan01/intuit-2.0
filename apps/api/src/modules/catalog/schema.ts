import { boolean, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/**
 * The shared items catalog (ADR 0004 P4-05): products and services sold and/or purchased. The
 * table keeps its Phase 3B name `sales_items` (migration 0021; purchase columns in 0030). No
 * inventory.
 */

export const salesItemTypes = ['service', 'product'] as const;
export type SalesItemType = (typeof salesItemTypes)[number];
export const salesItemStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type SalesItemStatus = (typeof salesItemStatuses)[number];

export const salesItems = pgTable('sales_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  sku: text('sku'),
  name: text('name').notNull(),
  itemType: text('item_type', { enum: salesItemTypes }).notNull(),
  description: text('description').notNull().default(''),
  unitPrice: numeric('unit_price', { precision: 28, scale: 4 }),
  revenueAccountId: uuid('revenue_account_id'),
  taxCodeId: uuid('tax_code_id'),
  // Purchase side (ADR 0004 P4-05, migration 0030). Every existing item is sold, not purchased.
  isSold: boolean('is_sold').notNull().default(true),
  isPurchased: boolean('is_purchased').notNull().default(false),
  purchaseDescription: text('purchase_description').notNull().default(''),
  /** Default purchase cost in the base currency. */
  purchaseUnitCost: numeric('purchase_unit_cost', { precision: 28, scale: 4 }),
  expenseAccountId: uuid('expense_account_id'),
  purchaseTaxCodeId: uuid('purchase_tax_code_id'),
  /** Default tax recoverability on purchase lines (P4-12, migration 0032); NULL = no default. */
  purchaseTaxRecoverable: boolean('purchase_tax_recoverable'),
  status: text('status', { enum: salesItemStatuses }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
  archivedByUserId: uuid('archived_by_user_id'),
  archivedAt: timestamptz('archived_at'),
});
