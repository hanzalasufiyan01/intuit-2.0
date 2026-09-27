import { integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

export const outboxStatuses = ['pending', 'processing', 'processed', 'failed'] as const;
export type OutboxStatus = (typeof outboxStatuses)[number];

export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventType: text('event_type').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  organizationId: uuid('organization_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status', { enum: outboxStatuses }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(10),
  availableAt: timestamptz('available_at').notNull(),
  lockedAt: timestamptz('locked_at'),
  lockedBy: text('locked_by'),
  lastError: text('last_error'),
  createdAt: timestamptz('created_at').notNull(),
  processedAt: timestamptz('processed_at'),
});
