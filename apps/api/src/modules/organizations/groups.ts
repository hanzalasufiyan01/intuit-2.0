import { and, asc, eq } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';

/**
 * Groups of organizations (legal entities, migration 0085). A group only links organizations one
 * user owns; it holds no accounting data and implies no consolidation.
 */

export const organizationGroups = pgTable('organization_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ownerUserId: uuid('owner_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export const organizationGroupMembers = pgTable('organization_group_members', {
  groupId: uuid('group_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  addedByUserId: uuid('added_by_user_id').notNull(),
  addedAt: timestamptz('added_at').notNull(),
});

export type OrganizationGroup = typeof organizationGroups.$inferSelect;

export async function insertGroup(
  tx: Transaction,
  input: { name: string; ownerUserId: string; at: Date },
) {
  const [row] = await tx
    .insert(organizationGroups)
    .values({ name: input.name, ownerUserId: input.ownerUserId, createdAt: input.at })
    .returning();
  return row!;
}

export async function listGroups(tx: Transaction, ownerUserId: string) {
  return tx
    .select()
    .from(organizationGroups)
    .where(eq(organizationGroups.ownerUserId, ownerUserId))
    .orderBy(asc(organizationGroups.name), asc(organizationGroups.id));
}

export async function getGroup(tx: Transaction, ownerUserId: string, id: string) {
  const [row] = await tx
    .select()
    .from(organizationGroups)
    .where(and(eq(organizationGroups.id, id), eq(organizationGroups.ownerUserId, ownerUserId)));
  return row;
}

export async function listGroupMembers(tx: Transaction, groupId: string) {
  return tx
    .select()
    .from(organizationGroupMembers)
    .where(eq(organizationGroupMembers.groupId, groupId))
    .orderBy(asc(organizationGroupMembers.addedAt), asc(organizationGroupMembers.organizationId));
}

export async function findGroupOf(tx: Transaction, organizationId: string) {
  const [row] = await tx
    .select()
    .from(organizationGroupMembers)
    .where(eq(organizationGroupMembers.organizationId, organizationId));
  return row;
}

export async function addGroupMember(
  tx: Transaction,
  input: { groupId: string; organizationId: string; userId: string; at: Date },
) {
  const rows = await tx
    .insert(organizationGroupMembers)
    .values({
      groupId: input.groupId,
      organizationId: input.organizationId,
      addedByUserId: input.userId,
      addedAt: input.at,
    })
    .onConflictDoNothing()
    .returning();
  return rows.length > 0;
}

export async function removeGroupMember(tx: Transaction, groupId: string, organizationId: string) {
  const rows = await tx
    .delete(organizationGroupMembers)
    .where(
      and(
        eq(organizationGroupMembers.groupId, groupId),
        eq(organizationGroupMembers.organizationId, organizationId),
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function deleteGroup(tx: Transaction, id: string) {
  await tx.delete(organizationGroupMembers).where(eq(organizationGroupMembers.groupId, id));
  await tx.delete(organizationGroups).where(eq(organizationGroups.id, id));
}
