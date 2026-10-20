import { integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Online payment gateway tables (migration 0075). */

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });

export const gatewayModes = ['disabled', 'mock', 'live'] as const;
export type GatewayMode = (typeof gatewayModes)[number];

export const paymentGatewaySettings = pgTable('payment_gateway_settings', {
  organizationId: uuid('organization_id').primaryKey(),
  mode: text('mode', { enum: gatewayModes }).notNull().default('disabled'),
  actingUserId: uuid('acting_user_id').notNull(),
  intentTtlMinutes: integer('intent_ttl_minutes').notNull().default(60),
  version: integer('version').notNull().default(1),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const intentStatuses = [
  'CREATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'REQUIRES_REVIEW',
] as const;
export type IntentStatus = (typeof intentStatuses)[number];

export const paymentIntents = pgTable('payment_intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  amount: money('amount').notNull(),
  currencyCode: text('currency_code').notNull(),
  provider: text('provider', { enum: ['mock'] }).notNull(),
  mode: text('mode', { enum: ['mock', 'live'] }).notNull(),
  providerRef: text('provider_ref'),
  checkoutUrl: text('checkout_url'),
  status: text('status', { enum: intentStatuses }).notNull().default('CREATED'),
  failureCode: text('failure_code'),
  receiptId: uuid('receipt_id'),
  shareLinkId: uuid('share_link_id'),
  createdByUserId: uuid('created_by_user_id'),
  expiresAt: timestamptz('expires_at').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamptz('created_at').notNull(),
  updatedAt: timestamptz('updated_at').notNull(),
  completedAt: timestamptz('completed_at'),
});

export const paymentEvents = pgTable('payment_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  intentId: uuid('intent_id').notNull(),
  provider: text('provider').notNull(),
  providerEventId: text('provider_event_id').notNull(),
  eventType: text('event_type').notNull(),
  source: text('source', { enum: ['webhook', 'reconcile', 'sweep'] }).notNull(),
  amount: money('amount'),
  currencyCode: text('currency_code'),
  outcome: text('outcome', { enum: ['applied', 'ignored', 'rejected', 'failed'] }).notNull(),
  detail: text('detail'),
  payloadHash: text('payload_hash').notNull(),
  receivedAt: timestamptz('received_at').notNull(),
});
