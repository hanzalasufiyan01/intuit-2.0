import { boolean, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Import/export persistence (S6-02; migration 0014). */

export const importDomainKeys = [
  'chart_of_accounts',
  'parties',
  'party_contacts',
  'dimension_values',
  'exchange_rates',
  'manual_journals',
  // Phase 3A S8 (S8-16): fills the draft opening batch only; never posts.
  'opening_balances',
  // Phase 3B (step 18): Sales imports; opening invoices are created as drafts.
  'customers',
  'sales_items',
  'opening_invoices',
] as const;
export type ImportDomainKey = (typeof importDomainKeys)[number];

export const exportDomainKeys = [
  'chart_of_accounts',
  'parties',
  'dimension_values',
  'journals',
  'general_ledger',
  'trial_balance',
  'profit_and_loss',
  'balance_sheet',
  'import_errors',
  'opening_balances',
  // Phase 3B (step 18): Sales exports (CSV).
  'customers',
  'sales_items',
  'invoices',
  'receipts',
  'ar_aging',
] as const;
export type ExportDomainKey = (typeof exportDomainKeys)[number];

export const importStatuses = [
  'awaiting_file',
  'ready',
  'validating',
  'validated',
  'failed_file',
  'committing',
  'committed',
  'needs_review',
  'cancelled',
  'expired',
] as const;
export type ImportStatus = (typeof importStatuses)[number];

/** Statuses after which a batch never changes again (except redaction). */
export const finishedImportStatuses: readonly ImportStatus[] = [
  'committed',
  'cancelled',
  'expired',
  'failed_file',
];

export const importRowStatuses = ['pending', 'valid', 'warning', 'error'] as const;
export type ImportRowStatus = (typeof importRowStatuses)[number];

export const exportStatuses = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof exportStatuses)[number];

export interface ImportOptions {
  dateFormat: 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY';
  decimalSeparator: '.' | ',';
  delimiter: 'auto' | ',' | ';' | '\t';
}

export interface RowMessage {
  severity: 'error' | 'warning';
  code: string;
  field: string | null;
  message: string;
}

export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  domain: text('domain', { enum: importDomainKeys }).notNull(),
  format: text('format', { enum: ['csv'] })
    .notNull()
    .default('csv'),
  status: text('status', { enum: importStatuses }).notNull().default('awaiting_file'),
  version: integer('version').notNull().default(1),
  fileId: uuid('file_id'),
  options: jsonb('options').$type<ImportOptions>().notNull(),
  mapping: jsonb('mapping').$type<Record<string, number | null>>(),
  mappingVersion: integer('mapping_version').notNull().default(0),
  validatedMappingVersion: integer('validated_mapping_version'),
  columns: jsonb('columns').$type<string[]>(),
  rowCount: integer('row_count').notNull().default(0),
  validCount: integer('valid_count').notNull().default(0),
  warningCount: integer('warning_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  excludedCount: integer('excluded_count').notNull().default(0),
  summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
  fileSha256: text('file_sha256'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  committedByUserId: uuid('committed_by_user_id'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  committedAt: timestamptz('committed_at'),
  finishedAt: timestamptz('finished_at'),
  expiresAt: timestamptz('expires_at').notNull(),
  redactedAt: timestamptz('redacted_at'),
});

export const importRows = pgTable(
  'import_rows',
  {
    batchId: uuid('batch_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    groupKey: text('group_key'),
    raw: jsonb('raw').$type<string[]>(),
    normalized: jsonb('normalized').$type<Record<string, unknown>>(),
    status: text('status', { enum: importRowStatuses }).notNull().default('pending'),
    excluded: boolean('excluded').notNull().default(false),
    messages: jsonb('messages').$type<RowMessage[]>().notNull().default([]),
    recordId: uuid('record_id'),
  },
  (t) => [primaryKey({ columns: [t.batchId, t.rowNumber] })],
);

export const importMappings = pgTable('import_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  domain: text('domain', { enum: importDomainKeys }).notNull(),
  name: text('name').notNull(),
  mapping: jsonb('mapping').$type<Record<string, string>>().notNull(),
  options: jsonb('options').$type<Partial<ImportOptions>>().notNull().default({}),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  deletedAt: timestamptz('deleted_at'),
});

export const dataExports = pgTable('exports', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  domain: text('domain', { enum: exportDomainKeys }).notNull(),
  format: text('format', { enum: ['csv'] })
    .notNull()
    .default('csv'),
  status: text('status', { enum: exportStatuses }).notNull().default('queued'),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  requiredPermission: text('required_permission').notNull(),
  fileId: uuid('file_id'),
  rowCount: integer('row_count'),
  error: text('error'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  finishedAt: timestamptz('finished_at'),
  expiresAt: timestamptz('expires_at').notNull(),
});
