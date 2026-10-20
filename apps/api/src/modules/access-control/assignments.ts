import { and, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { membershipRoles, rolePermissions, roles } from './schema.js';
import type { Role } from './roles.js';

export interface EffectiveAccess {
  roleIds: string[];
  isOwner: boolean;
  permissions: Set<string>;
}

/** Membership -> roles -> permissions, scoped to one organization. */
export async function getEffectiveAccess(
  tx: Transaction,
  organizationId: string,
  membershipId: string,
): Promise<EffectiveAccess> {
  const assigned = await tx
    .select({ roleId: membershipRoles.roleId, isOwner: membershipRoles.roleIsOwner })
    .from(membershipRoles)
    .where(
      and(
        eq(membershipRoles.organizationId, organizationId),
        eq(membershipRoles.membershipId, membershipId),
      ),
    );
  const roleIds = assigned.map((row) => row.roleId);
  const permissionRows =
    roleIds.length === 0
      ? []
      : await tx
          .selectDistinct({ key: rolePermissions.permissionKey })
          .from(rolePermissions)
          .where(
            and(
              eq(rolePermissions.organizationId, organizationId),
              inArray(rolePermissions.roleId, roleIds),
            ),
          );
  return {
    roleIds,
    isOwner: assigned.some((row) => row.isOwner),
    permissions: new Set(permissionRows.map((row) => row.key)),
  };
}

/**
 * Grants the protected Owner role. Only the organization-creation workflow (and, later,
 * the controlled ownership-transfer workflow) may call this. The unique index
 * membership_roles_single_owner_idx guarantees at most one Owner per organization.
 */
export async function assignOwnerRole(
  tx: Transaction,
  input: {
    organizationId: string;
    membershipId: string;
    ownerRole: Role;
    assignedByUserId: string;
  },
): Promise<void> {
  if (!input.ownerRole.isOwner || input.ownerRole.organizationId !== input.organizationId) {
    throw new Error('assignOwnerRole requires the Owner role of the same organization');
  }
  await tx.insert(membershipRoles).values({
    membershipId: input.membershipId,
    roleId: input.ownerRole.id,
    organizationId: input.organizationId,
    roleIsOwner: true,
    assignedByUserId: input.assignedByUserId,
  });
}

/**
 * The ownership change of a completed transfer (ADR 0012): the Owner role moves from one
 * membership to another and the previous owner receives the replacement role, in the caller's
 * transaction. The unique index `membership_roles_single_owner_idx` keeps exactly one Owner; the
 * previous owner's other (non-owner) roles are replaced by the replacement role.
 */
export async function transferOwnerRole(
  tx: Transaction,
  input: {
    organizationId: string;
    fromMembershipId: string;
    toMembershipId: string;
    ownerRole: Role;
    replacementRole: Role;
    assignedByUserId: string;
  },
): Promise<void> {
  if (!input.ownerRole.isOwner || input.ownerRole.organizationId !== input.organizationId) {
    throw new Error('transferOwnerRole requires the Owner role of the same organization');
  }
  if (
    input.replacementRole.isOwner ||
    input.replacementRole.organizationId !== input.organizationId
  ) {
    throw new Error('transferOwnerRole requires a non-owner replacement role of the organization');
  }
  const removed = await tx
    .delete(membershipRoles)
    .where(
      and(
        eq(membershipRoles.organizationId, input.organizationId),
        eq(membershipRoles.membershipId, input.fromMembershipId),
        eq(membershipRoles.roleIsOwner, true),
      ),
    )
    .returning({ roleId: membershipRoles.roleId });
  if (removed.length !== 1) {
    throw new Error('The previous owner does not hold the Owner role');
  }
  await assignOwnerRole(tx, {
    organizationId: input.organizationId,
    membershipId: input.toMembershipId,
    ownerRole: input.ownerRole,
    assignedByUserId: input.assignedByUserId,
  });
  await replaceMembershipRoles(tx, {
    organizationId: input.organizationId,
    membershipId: input.fromMembershipId,
    roles: [input.replacementRole],
    assignedByUserId: input.assignedByUserId,
  });
}

/**
 * Replaces a membership's non-owner roles. Never grants or removes the Owner role:
 * callers must reject owner roles and owner memberships before calling.
 */
export async function replaceMembershipRoles(
  tx: Transaction,
  input: {
    organizationId: string;
    membershipId: string;
    roles: readonly Role[];
    assignedByUserId: string;
  },
): Promise<void> {
  if (input.roles.some((role) => role.isOwner || role.organizationId !== input.organizationId)) {
    throw new Error('replaceMembershipRoles cannot assign the Owner role or foreign roles');
  }
  await tx
    .delete(membershipRoles)
    .where(
      and(
        eq(membershipRoles.organizationId, input.organizationId),
        eq(membershipRoles.membershipId, input.membershipId),
        eq(membershipRoles.roleIsOwner, false),
      ),
    );
  if (input.roles.length > 0) {
    await tx.insert(membershipRoles).values(
      input.roles.map((role) => ({
        membershipId: input.membershipId,
        roleId: role.id,
        organizationId: input.organizationId,
        roleIsOwner: false,
        assignedByUserId: input.assignedByUserId,
      })),
    );
  }
}

/** Role assignments for every membership in the organization. */
export async function listMembershipRoleAssignments(
  tx: Transaction,
  organizationId: string,
): Promise<Map<string, { id: string; name: string; isOwner: boolean }[]>> {
  const rows = await tx
    .select({
      membershipId: membershipRoles.membershipId,
      roleId: roles.id,
      roleName: roles.name,
      isOwner: roles.isOwner,
    })
    .from(membershipRoles)
    .innerJoin(
      roles,
      and(
        eq(roles.id, membershipRoles.roleId),
        eq(roles.organizationId, membershipRoles.organizationId),
      ),
    )
    .where(eq(membershipRoles.organizationId, organizationId));
  const result = new Map<string, { id: string; name: string; isOwner: boolean }[]>();
  for (const row of rows) {
    const list = result.get(row.membershipId) ?? [];
    list.push({ id: row.roleId, name: row.roleName, isOwner: row.isOwner });
    result.set(row.membershipId, list);
  }
  return result;
}
