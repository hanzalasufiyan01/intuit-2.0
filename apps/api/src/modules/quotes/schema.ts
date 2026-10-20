import { date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Sales quote and recurring invoice tables (migration 0068, FP-28). */

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });
const qty = (name: string) => numeric(name, { precision: 28, scale: 6 });

export const quoteStatuses = [
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CONVERTED',
] as const;
export type QuoteStatus = (typeof quoteStatuses)[number];

export const quoteNumberSequences = pgTable('quote_number_sequences', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['quote'] }).notNull(),
  prefix: text('prefix').notNull().default(''),
  minDigits: integer('min_digits').notNull().default(5),
  nextNumber: numeric('next_number', { precision: 20, scale: 0 }).notNull().default('1'),
});

export const salesQuotes = pgTable('sales_quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  customerId: uuid('customer_id').notNull(),
  quoteDate: date('quote_date', { mode: 'string' }).notNull(),
  validUntil: date('valid_until', { mode: 'string' }).notNull(),
  status: text('status', { enum: quoteStatuses }).notNull().default('DRAFT'),
  reference: text('reference'),
  memo: text('memo').notNull().default(''),
  netTotal: money('net_total').notNull(),
  sentAt: timestamptz('sent_at'),
  decidedAt: timestamptz('decided_at'),
  declineReason: text('decline_reason'),
  invoiceId: uuid('invoice_id'),
  convertedAt: timestamptz('converted_at'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const salesQuoteLines = pgTable('sales_quote_lines', {
  organizationId: uuid('organization_id').notNull(),
  quoteId: uuid('quote_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id'),
  description: text('description').notNull(),
  quantity: qty('quantity').notNull(),
  unitPrice: qty('unit_price').notNull(),
  taxCodeId: uuid('tax_code_id'),
  netAmount: money('net_amount').notNull(),
});

export const scheduleStatuses = ['ACTIVE', 'PAUSED', 'ENDED'] as const;
export type ScheduleStatus = (typeof scheduleStatuses)[number];

export const recurringInvoiceSchedules = pgTable('recurring_invoice_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  name: text('name').notNull(),
  customerId: uuid('customer_id').notNull(),
  frequency: text('frequency', { enum: ['weekly', 'monthly', 'quarterly', 'yearly'] }).notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  nextRunDate: date('next_run_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }),
  status: text('status', { enum: scheduleStatuses }).notNull().default('ACTIVE'),
  reference: text('reference'),
  memo: text('memo').notNull().default(''),
  paymentTermsDays: integer('payment_terms_days'),
  actingUserId: uuid('acting_user_id').notNull(),
  runCount: integer('run_count').notNull().default(0),
  lastRunAt: timestamptz('last_run_at'),
  lastError: text('last_error'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const recurringInvoiceLines = pgTable('recurring_invoice_lines', {
  organizationId: uuid('organization_id').notNull(),
  scheduleId: uuid('schedule_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id'),
  description: text('description').notNull(),
  quantity: qty('quantity').notNull(),
  unitPrice: qty('unit_price').notNull(),
  taxCodeId: uuid('tax_code_id'),
});

export const recurringInvoiceRuns = pgTable('recurring_invoice_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  scheduleId: uuid('schedule_id').notNull(),
  runDate: date('run_date', { mode: 'string' }).notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});
