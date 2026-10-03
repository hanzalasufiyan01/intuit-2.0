import { bigint, boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';
import type { DetectedType } from './detect.js';

/** File metadata and links (S5-01, S5-04). Contents live in the storage provider. */

export const fileStatuses = ['available', 'quarantined', 'deleted', 'purged'] as const;
export type FileStatus = (typeof fileStatuses)[number];
// S6 adds import batches and exports (S5-04).
export const fileLinkTypes = [
  'organization_logo',
  'party',
  'journal',
  'import_batch',
  'export',
  // Phase 3A S8 (S8-17): supporting evidence for an opening batch.
  'opening_balance_batch',
  // Phase 3B: Sales documents (attachments; issued PDFs under legal hold).
  'invoice',
  'credit_note',
  'receipt',
  // Phase 4A-5: bill evidence (ADR 0004 P4-22).
  'bill',
] as const;
export type FileLinkType = (typeof fileLinkTypes)[number];

export const files = pgTable('files', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  storageProvider: text('storage_provider', { enum: ['local'] }).notNull(),
  storageKey: text('storage_key').notNull(),
  originalName: text('original_name').notNull(),
  detectedType: text('detected_type').$type<DetectedType>().notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  status: text('status', { enum: fileStatuses }).notNull().default('available'),
  scanStatus: text('scan_status', { enum: ['not_scanned', 'clean', 'infected'] })
    .notNull()
    .default('not_scanned'),
  legalHold: boolean('legal_hold').notNull().default(false),
  uploadedByUserId: uuid('uploaded_by_user_id').notNull(),
  uploadedAt: timestamptz('uploaded_at').notNull(),
  deletedByUserId: uuid('deleted_by_user_id'),
  deletedAt: timestamptz('deleted_at'),
  purgeAfter: timestamptz('purge_after'),
  purgedAt: timestamptz('purged_at'),
});

export const fileLinks = pgTable('file_links', {
  fileId: uuid('file_id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  linkType: text('link_type', { enum: fileLinkTypes }).notNull(),
  linkId: uuid('link_id'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});
