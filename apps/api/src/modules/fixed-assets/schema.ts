import { boolean, date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Fixed asset tables (migration 0048). */

export const assetStatuses = ['ACTIVE', 'DISPOSED'] as const;
export type AssetStatus = (typeof assetStatuses)[number];
export const assetEntryKinds = [
  'acquisition',
  'depreciation',
  'depreciation_void',
  'disposal',
  'disposal_void',
] as const;
export type AssetEntryKind = (typeof assetEntryKinds)[number];

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });

export const fixedAssetSettings = pgTable('fixed_asset_settings', {
  organizationId: uuid('organization_id').primaryKey(),
  gainLossAccountId: uuid('gain_loss_account_id'),
  version: integer('version').notNull().default(1),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const fixedAssetNumberSequences = pgTable('fixed_asset_number_sequences', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['asset', 'run'] }).notNull(),
  prefix: text('prefix').notNull().default(''),
  minDigits: integer('min_digits').notNull().default(5),
  nextNumber: numeric('next_number', { precision: 20, scale: 0 }).notNull().default('1'),
});

export const fixedAssetCategories = pgTable('fixed_asset_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  name: text('name').notNull(),
  costAccountId: uuid('cost_account_id').notNull(),
  accumulatedAccountId: uuid('accumulated_account_id').notNull(),
  expenseAccountId: uuid('expense_account_id').notNull(),
  defaultLifeMonths: integer('default_life_months').notNull(),
  status: text('status', { enum: ['ACTIVE', 'ARCHIVED'] })
    .notNull()
    .default('ACTIVE'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const fixedAssets = pgTable('fixed_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  categoryId: uuid('category_id').notNull(),
  acquisitionDate: date('acquisition_date', { mode: 'string' }).notNull(),
  inServiceDate: date('in_service_date', { mode: 'string' }).notNull(),
  cost: money('cost').notNull(),
  salvageValue: money('salvage_value').notNull().default('0'),
  lifeMonths: integer('life_months').notNull(),
  accumulatedDepreciation: money('accumulated_depreciation').notNull().default('0'),
  status: text('status', { enum: assetStatuses }).notNull().default('ACTIVE'),
  location: text('location').notNull().default(''),
  custodian: text('custodian').notNull().default(''),
  serialNumber: text('serial_number').notNull().default(''),
  acquisitionJournalId: uuid('acquisition_journal_id'),
  inLedger: boolean('in_ledger').notNull().default(false),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const fixedAssetRuns = pgTable('fixed_asset_depreciation_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  monthEnd: date('month_end', { mode: 'string' }).notNull(),
  status: text('status', { enum: ['POSTED', 'VOID'] })
    .notNull()
    .default('POSTED'),
  totalAmount: money('total_amount').notNull(),
  assetCount: integer('asset_count').notNull(),
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

export const fixedAssetDisposals = pgTable('fixed_asset_disposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  assetId: uuid('asset_id').notNull(),
  disposalDate: date('disposal_date', { mode: 'string' }).notNull(),
  proceeds: money('proceeds').notNull().default('0'),
  proceedsAccountId: uuid('proceeds_account_id'),
  catchupDepreciation: money('catchup_depreciation').notNull().default('0'),
  cost: money('cost').notNull(),
  accumulatedDepreciation: money('accumulated_depreciation').notNull(),
  gainLoss: money('gain_loss').notNull(),
  memo: text('memo').notNull().default(''),
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

export const fixedAssetTransfers = pgTable('fixed_asset_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  assetId: uuid('asset_id').notNull(),
  transferDate: date('transfer_date', { mode: 'string' }).notNull(),
  fromCategoryId: uuid('from_category_id').notNull(),
  toCategoryId: uuid('to_category_id').notNull(),
  fromLocation: text('from_location').notNull().default(''),
  toLocation: text('to_location').notNull().default(''),
  cost: money('cost').notNull(),
  accumulatedDepreciation: money('accumulated_depreciation').notNull(),
  memo: text('memo').notNull().default(''),
  journalId: uuid('journal_id'),
  accountingEventId: uuid('accounting_event_id'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export const fixedAssetEntries = pgTable('fixed_asset_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  assetId: uuid('asset_id').notNull(),
  entryDate: date('entry_date', { mode: 'string' }).notNull(),
  kind: text('kind', { enum: assetEntryKinds }).notNull(),
  costChange: money('cost_change').notNull(),
  accumulatedChange: money('accumulated_change').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id').notNull(),
  journalId: uuid('journal_id'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});
