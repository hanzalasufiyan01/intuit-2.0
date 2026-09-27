import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, timestamptz } from '../../database/column-types.js';

export const userStatuses = ['active', 'disabled'] as const;
export type UserStatus = (typeof userStatuses)[number];

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  emailNormalized: text('email_normalized').notNull(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  status: text('status', { enum: userStatuses }).notNull().default('active'),
  emailVerifiedAt: timestamptz('email_verified_at'),
  passwordChangedAt: timestamptz('password_changed_at').notNull(),
  disabledAt: timestamptz('disabled_at'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const sessionRevocationReasons = [
  'logout',
  'user_revoked',
  'password_reset',
  'account_disabled',
  'expired',
] as const;
export type SessionRevocationReason = (typeof sessionRevocationReasons)[number];

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  activeOrganizationId: uuid('active_organization_id'),
  createdAt: timestamptz('created_at').notNull(),
  lastSeenAt: timestamptz('last_seen_at').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  reauthenticatedAt: timestamptz('reauthenticated_at').notNull(),
  revokedAt: timestamptz('revoked_at'),
  revokedReason: text('revoked_reason', { enum: sessionRevocationReasons }),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
});

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  usedAt: timestamptz('used_at'),
  requestedIp: text('requested_ip'),
});
