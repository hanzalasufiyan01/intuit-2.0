import { boolean, date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Payment reminders, sales orders and invoice share links (migration 0070, FP-28). */

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });
const qty = (name: string) => numeric(name, { precision: 28, scale: 6 });

export const paymentReminderSettings = pgTable('payment_reminder_settings', {
  organizationId: uuid('organization_id').primaryKey(),
  autoEnabled: boolean('auto_enabled').notNull().default(false),
  firstAfterDays: integer('first_after_days').notNull().default(3),
  repeatEveryDays: integer('repeat_every_days').notNull().default(7),
  maxReminders: integer('max_reminders').notNull().default(3),
  version: integer('version').notNull().default(1),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const paymentReminders = pgTable('payment_reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  kind: text('kind', { enum: ['manual', 'auto'] }).notNull(),
  stage: integer('stage'),
  recipient: text('recipient').notNull(),
  openAmount: money('open_amount').notNull(),
  currencyCode: text('currency_code').notNull(),
  daysOverdue: integer('days_overdue').notNull(),
  sentByUserId: uuid('sent_by_user_id'),
  sentAt: timestamptz('sent_at').notNull(),
});

export const salesOrderNumberSequences = pgTable('sales_order_number_sequences', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['order'] }).notNull(),
  prefix: text('prefix').notNull().default(''),
  minDigits: integer('min_digits').notNull().default(5),
  nextNumber: numeric('next_number', { precision: 20, scale: 0 }).notNull().default('1'),
});

export const orderStatuses = ['DRAFT', 'CONFIRMED', 'CANCELLED'] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export const salesOrders = pgTable('sales_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  customerId: uuid('customer_id').notNull(),
  orderDate: date('order_date', { mode: 'string' }).notNull(),
  expectedDate: date('expected_date', { mode: 'string' }),
  status: text('status', { enum: orderStatuses }).notNull().default('DRAFT'),
  reference: text('reference'),
  memo: text('memo').notNull().default(''),
  netTotal: money('net_total').notNull(),
  cancelReason: text('cancel_reason'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const salesOrderLines = pgTable('sales_order_lines', {
  organizationId: uuid('organization_id').notNull(),
  orderId: uuid('order_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id'),
  description: text('description').notNull(),
  quantity: qty('quantity').notNull(),
  unitPrice: qty('unit_price').notNull(),
  taxCodeId: uuid('tax_code_id'),
  netAmount: money('net_amount').notNull(),
});

export const salesOrderInvoiceLines = pgTable('sales_order_invoice_lines', {
  organizationId: uuid('organization_id').notNull(),
  orderId: uuid('order_id').notNull(),
  lineNo: integer('line_no').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  quantity: qty('quantity').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export const customerStatementLinks = pgTable('customer_statement_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  revokedAt: timestamptz('revoked_at'),
  revokedByUserId: uuid('revoked_by_user_id'),
  viewCount: integer('view_count').notNull().default(0),
  lastViewedAt: timestamptz('last_viewed_at'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export const invoiceShareLinks = pgTable('invoice_share_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  revokedAt: timestamptz('revoked_at'),
  revokedByUserId: uuid('revoked_by_user_id'),
  viewCount: integer('view_count').notNull().default(0),
  lastViewedAt: timestamptz('last_viewed_at'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});
