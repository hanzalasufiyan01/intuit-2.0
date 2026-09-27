import { and, asc, eq } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { memberships, organizations, type MembershipStatus } from './schema.js';

export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;

export async function createOrganization(
  tx: Transaction,
  input: { id: string; name: string; createdByUserId: string },
): Promise<Organization> {
  const [row] = await tx
    .insert(organizations)
    .values({ id: input.id, name: input.name.trim(), createdByUserId: input.createdByUserId })
    .returning();
  if (!row) throw new Error('Organization insert returned no row');
  return row;
}

export async function getOrganization(
  tx: Transaction,
  organizationId: string,
): Promise<Organization | undefined> {
  const [row] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row;
}

export async function renameOrganization(
  tx: Transaction,
  organizationId: string,
  name: string,
): Promise<Organization | undefined> {
  const [row] = await tx
    .update(organizations)
    .set({ name: name.trim() })
    .where(eq(organizations.id, organizationId))
    .returning();
  return row;
}

export async function createMembership(
  tx: Transaction,
  input: { organizationId: string; userId: string },
): Promise<Membership | undefined> {
  const [row] = await tx
    .insert(memberships)
    .values({ organizationId: input.organizationId, userId: input.userId })
    .onConflictDoNothing({ target: [memberships.organizationId, memberships.userId] })
    .returning();
  return row;
}

export async function findMembership(
  tx: Transaction,
  organizationId: string,
  userId: string,
): Promise<Membership | undefined> {
  const [row] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)))
    .limit(1);
  return row;
}

export async function findMembershipById(
  tx: Transaction,
  organizationId: string,
  membershipId: string,
): Promise<Membership | undefined> {
  const [row] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.id, membershipId)))
    .limit(1);
  return row;
}

export async function listOrganizationMemberships(
  tx: Transaction,
  organizationId: string,
): Promise<Membership[]> {
  return tx
    .select()
    .from(memberships)
    .where(eq(memberships.organizationId, organizationId))
    .orderBy(asc(memberships.createdAt));
}

export interface UserOrganization {
  organizationId: string;
  organizationName: string;
  membershipId: string;
}

/** Organizations in which the user has an active membership. */
export async function listUserOrganizations(
  tx: Transaction,
  userId: string,
): Promise<UserOrganization[]> {
  return tx
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      membershipId: memberships.id,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .orderBy(asc(memberships.createdAt));
}

export async function setMembershipStatus(
  tx: Transaction,
  input: { organizationId: string; membershipId: string; status: MembershipStatus; now: Date },
): Promise<Membership | undefined> {
  const [row] = await tx
    .update(memberships)
    .set({ status: input.status, disabledAt: input.status === 'disabled' ? input.now : null })
    .where(
      and(
        eq(memberships.organizationId, input.organizationId),
        eq(memberships.id, input.membershipId),
      ),
    )
    .returning();
  return row;
}
