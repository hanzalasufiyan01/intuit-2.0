import { boolean, char, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Unified Party/Contact master (Decisions 8, 28; S4-01, S4-08..S4-11). */

export const partyKinds = ['organization', 'individual'] as const;
export type PartyKind = (typeof partyKinds)[number];
export const partyRoles = ['customer', 'vendor', 'employee', 'other'] as const;
export type PartyRole = (typeof partyRoles)[number];
export const partyStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type PartyStatus = (typeof partyStatuses)[number];
export const partyAddressKinds = ['billing', 'delivery'] as const;
export type PartyAddressKind = (typeof partyAddressKinds)[number];

export const parties = pgTable('parties', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  kind: text('kind', { enum: partyKinds }).notNull(),
  displayName: text('display_name').notNull(),
  companyName: text('company_name'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  reference: text('reference'),
  tin: text('tin'),
  email: text('email'),
  phone: text('phone'),
  website: text('website'),
  notes: text('notes'),
  status: text('status', { enum: partyStatuses }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  archivedByUserId: uuid('archived_by_user_id'),
  archivedAt: timestamptz('archived_at'),
});

export const partyRolesTable = pgTable(
  'party_roles',
  {
    partyId: uuid('party_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    role: text('role', { enum: partyRoles }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.partyId, t.role] })],
);

export const partyContacts = pgTable('party_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  partyId: uuid('party_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  jobTitle: text('job_title'),
  email: text('email'),
  phone: text('phone'),
  mobile: text('mobile'),
  isPrimary: boolean('is_primary').notNull().default(false),
  receivesDocuments: boolean('receives_documents').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const partyAddresses = pgTable('party_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  partyId: uuid('party_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  kind: text('kind', { enum: partyAddressKinds }).notNull(),
  label: text('label'),
  line1: text('line1').notNull(),
  line2: text('line2'),
  city: text('city'),
  region: text('region'),
  postalCode: text('postal_code'),
  countryCode: char('country_code', { length: 2 }).notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});
