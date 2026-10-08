import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

export type EventMetadata = Record<string, unknown>;

export const auditActorTypes = ['user', 'system', 'anonymous', 'api_token'] as const;
export type AuditActorType = (typeof auditActorTypes)[number];

/** Append-only: UPDATE/DELETE/TRUNCATE are rejected by database triggers and grants. */
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamptz('occurred_at').notNull(),
  organizationId: uuid('organization_id'),
  actorType: text('actor_type', { enum: auditActorTypes }).notNull(),
  actorUserId: uuid('actor_user_id'),
  /** api_token actors: the integration and (optionally) the token behind the service principal. */
  actorIntegrationId: uuid('actor_integration_id'),
  actorTokenId: uuid('actor_token_id'),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  requestId: text('request_id'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  metadata: jsonb('metadata').$type<EventMetadata>().notNull().default({}),
});

/** Append-only: UPDATE/DELETE/TRUNCATE are rejected by database triggers and grants. */
export const securityEvents = pgTable('security_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamptz('occurred_at').notNull(),
  eventType: text('event_type').notNull(),
  userId: uuid('user_id'),
  organizationId: uuid('organization_id'),
  emailNormalized: text('email_normalized'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  requestId: text('request_id'),
  metadata: jsonb('metadata').$type<EventMetadata>().notNull().default({}),
});
