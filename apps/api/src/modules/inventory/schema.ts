import { boolean, date, integer, jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Inventory tables (migration 0046). */

export const negativeStockPolicies = ['block', 'allow'] as const;
export type NegativeStockPolicy = (typeof negativeStockPolicies)[number];
export const movementKinds = [
  'purchase',
  'purchase_void',
  'sale',
  'sale_void',
  'adjustment',
  'adjustment_void',
  // Migration 0062: goods that came back with a credit note.
  'sales_return',
  'sales_return_void',
  // Migration 0063: goods returned to a supplier on a vendor credit.
  'purchase_return',
  'purchase_return_void',
  // Migration 0081: landed cost moves value without quantity.
  'landed_cost',
  'landed_cost_void',
] as const;
export type MovementKind = (typeof movementKinds)[number];

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });
const quantity = (name: string) => numeric(name, { precision: 28, scale: 6 });

export const inventorySettings = pgTable('inventory_settings', {
  organizationId: uuid('organization_id').primaryKey(),
  negativeStockPolicy: text('negative_stock_policy', { enum: negativeStockPolicies })
    .notNull()
    .default('block'),
  adjustmentAccountId: uuid('adjustment_account_id'),
  version: integer('version').notNull().default(1),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const inventoryNumberSequences = pgTable('inventory_number_sequences', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', {
    enum: ['adjustment', 'return', 'count', 'transfer', 'landed_cost'],
  }).notNull(),
  prefix: text('prefix').notNull().default(''),
  minDigits: integer('min_digits').notNull().default(5),
  nextNumber: numeric('next_number', { precision: 20, scale: 0 }).notNull().default('1'),
});

export const inventoryItems = pgTable('inventory_items', {
  organizationId: uuid('organization_id').notNull(),
  itemId: uuid('item_id').notNull(),
  inventoryAccountId: uuid('inventory_account_id').notNull(),
  cogsAccountId: uuid('cogs_account_id').notNull(),
  reorderPoint: quantity('reorder_point'),
  trackingMode: text('tracking_mode', { enum: ['none', 'lot', 'serial'] })
    .notNull()
    .default('none'),
  expiryTracked: boolean('expiry_tracked').notNull().default(false),
  baseUnit: text('base_unit').notNull().default('unit'),
  purchaseUnit: text('purchase_unit'),
  purchaseFactor: quantity('purchase_factor'),
  salesUnit: text('sales_unit'),
  salesFactor: quantity('sales_factor'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const inventoryBalances = pgTable('inventory_balances', {
  organizationId: uuid('organization_id').notNull(),
  itemId: uuid('item_id').notNull(),
  quantity: quantity('quantity').notNull().default('0'),
  value: money('value').notNull().default('0'),
  lastUnitCost: quantity('last_unit_cost').notNull().default('0'),
  negativeAllowed: boolean('negative_allowed').notNull().default(false),
  version: integer('version').notNull().default(1),
});

export const inventoryMovements = pgTable('inventory_movements', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  itemId: uuid('item_id').notNull(),
  movementDate: date('movement_date', { mode: 'string' }).notNull(),
  kind: text('kind', { enum: movementKinds }).notNull(),
  quantity: quantity('quantity').notNull(),
  value: money('value').notNull(),
  quantityAfter: quantity('quantity_after').notNull(),
  valueAfter: money('value_after').notNull(),
  sourceModule: text('source_module').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id').notNull(),
  reversesId: uuid('reverses_id'),
  journalId: uuid('journal_id'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export const inventoryAdjustments = pgTable('inventory_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  adjustmentDate: date('adjustment_date', { mode: 'string' }).notNull(),
  reason: text('reason').notNull(),
  memo: text('memo').notNull().default(''),
  adjustmentAccountId: uuid('adjustment_account_id').notNull(),
  warehouseId: uuid('warehouse_id'),
  status: text('status', { enum: ['POSTED', 'VOID'] })
    .notNull()
    .default('POSTED'),
  netValue: money('net_value').notNull(),
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

export const inventoryAdjustmentLines = pgTable('inventory_adjustment_lines', {
  organizationId: uuid('organization_id').notNull(),
  adjustmentId: uuid('adjustment_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id').notNull(),
  quantityChange: quantity('quantity_change').notNull(),
  unitCost: quantity('unit_cost'),
  value: money('value').notNull(),
  movementId: uuid('movement_id').notNull(),
  lots: jsonb('lots').$type<{ lotCode: string; quantity: string }[] | null>(),
});

/** Customer returns (migration 0062, ADR 0012): goods that came back against an issued credit note. */
export const inventoryReturns = pgTable('inventory_returns', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  returnDate: date('return_date', { mode: 'string' }).notNull(),
  creditNoteId: uuid('credit_note_id').notNull(),
  warehouseId: uuid('warehouse_id'),
  reason: text('reason').notNull(),
  memo: text('memo').notNull().default(''),
  status: text('status', { enum: ['POSTED', 'VOID'] })
    .notNull()
    .default('POSTED'),
  totalValue: money('total_value').notNull(),
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

export const inventoryReturnLines = pgTable('inventory_return_lines', {
  organizationId: uuid('organization_id').notNull(),
  returnId: uuid('return_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id').notNull(),
  quantity: quantity('quantity').notNull(),
  unitCost: quantity('unit_cost').notNull(),
  value: money('value').notNull(),
  movementId: uuid('movement_id').notNull(),
  lots: jsonb('lots').$type<{ lotCode: string; quantity: string }[] | null>(),
});
