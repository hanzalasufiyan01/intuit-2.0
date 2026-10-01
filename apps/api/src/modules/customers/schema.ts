import { char, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Phase 3B: customers on the shared Party master (migration 0021; Decisions 8, 28, 48). */

export const customerStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type CustomerStatus = (typeof customerStatuses)[number];

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  partyId: uuid('party_id').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  paymentTermsDays: integer('payment_terms_days'),
  creditLimit: numeric('credit_limit', { precision: 28, scale: 4 }),
  status: text('status', { enum: customerStatuses }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
  archivedByUserId: uuid('archived_by_user_id'),
  archivedAt: timestamptz('archived_at'),
});
