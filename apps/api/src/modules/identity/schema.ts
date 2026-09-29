import { bigint, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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
  // Phase 3A S7
  'mfa_failed',
  'mfa_reset',
] as const;
export type SessionRevocationReason = (typeof sessionRevocationReasons)[number];

export const sessionMfaMethods = ['totp', 'recovery_code', 'trusted_device'] as const;
export type SessionMfaMethod = (typeof sessionMfaMethods)[number];

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
  // Phase 3A S7 (S7-03): MFA-pending state and how the session satisfied MFA.
  mfaPendingUntil: timestamptz('mfa_pending_until'),
  mfaMethod: text('mfa_method', { enum: sessionMfaMethods }),
  mfaVerifiedAt: timestamptz('mfa_verified_at'),
  mfaFailedAttempts: integer('mfa_failed_attempts').notNull().default(0),
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

// ---------------------------------------------------------------------------
// Phase 3A S7: MFA credentials (user-scoped, user-keyed RLS; S7-02, S7-04, S7-05)
// ---------------------------------------------------------------------------

export const mfaFactorTypes = ['totp'] as const;
export const mfaFactorStatuses = ['pending', 'active', 'revoked'] as const;
export const mfaFactorRevocationReasons = [
  'replaced',
  'user_disabled',
  'admin_reset',
  'superseded',
  'enrollment_failed',
] as const;

export const mfaFactors = pgTable('mfa_factors', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  type: text('type', { enum: mfaFactorTypes }).notNull(),
  status: text('status', { enum: mfaFactorStatuses }).notNull(),
  label: text('label'),
  secretCiphertext: bytea('secret_ciphertext'),
  secretIv: bytea('secret_iv'),
  secretTag: bytea('secret_tag'),
  keyId: text('key_id'),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  pendingExpiresAt: timestamptz('pending_expires_at'),
  createdAt: timestamptz('created_at').notNull(),
  activatedAt: timestamptz('activated_at'),
  lastUsedAt: timestamptz('last_used_at'),
  revokedAt: timestamptz('revoked_at'),
  revokedReason: text('revoked_reason', { enum: mfaFactorRevocationReasons }),
});

export const mfaRecoveryCodes = pgTable('mfa_recovery_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  setId: uuid('set_id').notNull(),
  lookupId: text('lookup_id').notNull(),
  codeHash: text('code_hash').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  usedAt: timestamptz('used_at'),
  revokedAt: timestamptz('revoked_at'),
});

export const trustedDeviceRevocationReasons = [
  'user_revoked',
  'password_reset',
  'mfa_disabled',
  'mfa_replaced',
  'mfa_reset',
  'reuse_detected',
  'limit_exceeded',
] as const;
export type TrustedDeviceRevocationReason = (typeof trustedDeviceRevocationReasons)[number];

export const trustedDevices = pgTable('trusted_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  previousTokenHash: bytea('previous_token_hash'),
  createdAt: timestamptz('created_at').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  lastUsedAt: timestamptz('last_used_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  revokedAt: timestamptz('revoked_at'),
  revokedReason: text('revoked_reason', { enum: trustedDeviceRevocationReasons }),
});
