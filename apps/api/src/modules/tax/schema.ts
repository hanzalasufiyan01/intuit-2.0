import { integer, numeric, pgTable, text, uuid, date } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Phase 3B step 1: tax codes and their effective-dated rate versions (Decision 15). */

export const taxCodeStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type TaxCodeStatus = (typeof taxCodeStatuses)[number];

export const taxCodes = pgTable('tax_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  taxAccountId: uuid('tax_account_id').notNull(),
  /** Recoverable purchase tax posts here (ADR 0004 P4-11, migration 0032); NULL until mapped. */
  inputTaxAccountId: uuid('input_tax_account_id'),
  status: text('status', { enum: taxCodeStatuses }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const taxCodeRates = pgTable('tax_code_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  taxCodeId: uuid('tax_code_id').notNull(),
  rate: numeric('rate', { precision: 7, scale: 4 }).notNull(),
  effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
  verificationNote: text('verification_note'),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamptz('created_at').notNull(),
});
