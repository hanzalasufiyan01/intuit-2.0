import { boolean, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Global permission catalog (seeded from module contributions). */
export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  module: text('module').notNull(),
  description: text('description').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const roleTemplates = pgTable('role_templates', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  isOwner: boolean('is_owner').notNull().default(false),
  sortOrder: integer('sort_order').notNull(),
});

export const roleTemplatePermissions = pgTable(
  'role_template_permissions',
  {
    templateKey: text('template_key').notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.templateKey, t.permissionKey] })],
);

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  templateKey: text('template_key'),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  isSystem: boolean('is_system').notNull().default(false),
  isOwner: boolean('is_owner').notNull().default(false),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    permissionKey: text('permission_key').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const membershipRoles = pgTable(
  'membership_roles',
  {
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    roleIsOwner: boolean('role_is_owner').notNull(),
    assignedByUserId: uuid('assigned_by_user_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.membershipId, t.roleId] })],
);
