import {
  boolean,
  char,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
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

// ---------------------------------------------------------------------------
// Phase 3A S4: organization legal profile (Decision 17) and country reference data (S4-05)
// ---------------------------------------------------------------------------

export const countries = pgTable('countries', {
  code: char('code', { length: 2 }).primaryKey(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
});

export interface ProfileIdentifier {
  scheme: string;
  value: string;
}

export const organizationProfiles = pgTable('organization_profiles', {
  organizationId: uuid('organization_id').primaryKey(),
  legalName: text('legal_name').notNull(),
  tradingName: text('trading_name'),
  tin: text('tin'),
  gstRegistered: boolean('gst_registered').notNull().default(false),
  gstRegistrationNumber: text('gst_registration_number'),
  gstRegisteredFrom: date('gst_registered_from', { mode: 'string' }),
  email: text('email'),
  phone: text('phone'),
  website: text('website'),
  identifiers: jsonb('identifiers').$type<ProfileIdentifier[]>().notNull().default([]),
  /** S4-03 / S5-11: the organization logo (a file linked as organization_logo). */
  logoFileId: uuid('logo_file_id'),
  version: integer('version').notNull().default(1),
  updatedByUserId: uuid('updated_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const organizationAddressKinds = ['registered', 'business'] as const;
export type OrganizationAddressKind = (typeof organizationAddressKinds)[number];

export const organizationAddresses = pgTable(
  'organization_addresses',
  {
    organizationId: uuid('organization_id').notNull(),
    kind: text('kind', { enum: organizationAddressKinds }).notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    countryCode: char('country_code', { length: 2 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.kind] })],
);

/** Phase 3A S7 (S7-29, S7-36). A missing row means the defaults (not required; devices allowed). */
export const organizationSecurityPolicies = pgTable('organization_security_policies', {
  organizationId: uuid('organization_id').primaryKey(),
  requireMfaForAllMembers: boolean('require_mfa_for_all_members').notNull().default(false),
  allowTrustedDevices: boolean('allow_trusted_devices').notNull().default(true),
  version: integer('version').notNull().default(1),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});
