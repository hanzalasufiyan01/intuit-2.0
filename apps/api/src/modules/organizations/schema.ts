import { boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, timestamptz } from '../../database/column-types.js';

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  status: text('status', { enum: ['active'] })
    .notNull()
    .default('active'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const membershipStatuses = ['active', 'disabled'] as const;
export type MembershipStatus = (typeof membershipStatuses)[number];

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  userId: uuid('user_id').notNull(),
  status: text('status', { enum: membershipStatuses }).notNull().default('active'),
  disabledAt: timestamptz('disabled_at'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const invitationStatuses = ['pending', 'accepted', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof invitationStatuses)[number];

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  email: text('email').notNull(),
  emailNormalized: text('email_normalized').notNull(),
  roleId: uuid('role_id').notNull(),
  roleIsOwner: boolean('role_is_owner').notNull().default(false),
  invitedByUserId: uuid('invited_by_user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  status: text('status', { enum: invitationStatuses }).notNull().default('pending'),
  createdAt: timestamptz('created_at').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  acceptedAt: timestamptz('accepted_at'),
  acceptedByUserId: uuid('accepted_by_user_id'),
  revokedAt: timestamptz('revoked_at'),
  revokedByUserId: uuid('revoked_by_user_id'),
});

export const ownershipTransferStatuses = [
  'initiated',
  'verified',
  'accepted',
  'completed',
  'cancelled',
  'expired',
] as const;

/**
 * Data model for the controlled ownership-transfer workflow
 * (initiate -> security verification -> acceptance -> completion). Not built in Phase 1.
 */
export const ownershipTransfers = pgTable('ownership_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  fromMembershipId: uuid('from_membership_id').notNull(),
  toMembershipId: uuid('to_membership_id').notNull(),
  replacementRoleId: uuid('replacement_role_id').notNull(),
  initiatedByUserId: uuid('initiated_by_user_id').notNull(),
  status: text('status', { enum: ownershipTransferStatuses }).notNull().default('initiated'),
  initiatedAt: timestamptz('initiated_at').notNull(),
  verifiedAt: timestamptz('verified_at'),
  acceptedAt: timestamptz('accepted_at'),
  completedAt: timestamptz('completed_at'),
  cancelledAt: timestamptz('cancelled_at'),
  expiresAt: timestamptz('expires_at').notNull(),
});
