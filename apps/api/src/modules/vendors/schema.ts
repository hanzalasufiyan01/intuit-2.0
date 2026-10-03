import { boolean, char, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Phase 4A-3: vendors on the shared Party master (migration 0029; ADR 0004 P4-03; R36). */

export const vendorStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type VendorStatus = (typeof vendorStatuses)[number];

export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  partyId: uuid('party_id').notNull(),
  /** Default currency of the vendor's bills (P4-20). */
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  /** NULL: the Purchases settings default applies (later stage). */
  paymentTermsDays: integer('payment_terms_days'),
  /** In the vendor currency; a warning only. */
  creditLimit: numeric('credit_limit', { precision: 28, scale: 4 }),
  /** The organization's account number with this vendor (brief §6). */
  accountNumber: text('account_number'),
  /** Vendor defaults for future bill lines (brief §6; P4-19 eligibility). */
  defaultExpenseAccountId: uuid('default_expense_account_id'),
  defaultTaxCodeId: uuid('default_tax_code_id'),
  /** Default tax recoverability of bill lines (P4-12, migration 0032); NULL = no default. */
  defaultTaxRecoverable: boolean('default_tax_recoverable'),
  status: text('status', { enum: vendorStatuses }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
  archivedByUserId: uuid('archived_by_user_id'),
  archivedAt: timestamptz('archived_at'),
});
