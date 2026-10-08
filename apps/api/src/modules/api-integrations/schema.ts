import { integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, timestamptz } from '../../database/column-types.js';

/** API integration tables (migration 0056). */

export const integrationStatuses = ['active', 'disabled', 'revoked'] as const;
export type IntegrationStatus = (typeof integrationStatuses)[number];

export const apiIntegrations = pgTable('api_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  status: text('status', { enum: integrationStatuses }).notNull().default('active'),
  serviceUserId: uuid('service_user_id').notNull(),
  serviceMembershipId: uuid('service_membership_id').notNull(),
  responsibleMembershipId: uuid('responsible_membership_id').notNull(),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
  disabledAt: timestamptz('disabled_at'),
  disabledByUserId: uuid('disabled_by_user_id'),
  revokedAt: timestamptz('revoked_at'),
  revokedByUserId: uuid('revoked_by_user_id'),
  revokeReason: text('revoke_reason'),
});

export const apiIntegrationScopes = pgTable(
  'api_integration_scopes',
  {
    integrationId: uuid('integration_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    scope: text('scope').notNull(),
    grantedByUserId: uuid('granted_by_user_id').notNull(),
    grantedAt: timestamptz('granted_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.integrationId, t.scope] })],
);

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  integrationId: uuid('integration_id').notNull(),
  publicId: text('public_id').notNull(),
  secretHash: bytea('secret_hash').notNull(),
  name: text('name').notNull(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  replacesTokenId: uuid('replaces_token_id'),
  lastUsedAt: timestamptz('last_used_at'),
  lastUsedIp: text('last_used_ip'),
  revokedAt: timestamptz('revoked_at'),
  revokedByUserId: uuid('revoked_by_user_id'),
  revokeReason: text('revoke_reason'),
});
