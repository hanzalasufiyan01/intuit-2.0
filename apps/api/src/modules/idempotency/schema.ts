import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Phase 3B (Decision 23): the reusable request-idempotency store. */
export const idempotencyKeys = pgTable('idempotency_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  userId: uuid('user_id').notNull(),
  scope: text('scope').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  response: jsonb('response'),
  createdAt: timestamptz('created_at').notNull(),
  completedAt: timestamptz('completed_at'),
  expiresAt: timestamptz('expires_at').notNull(),
});
