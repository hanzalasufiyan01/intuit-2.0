import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  membershipRoles,
  permissions,
  rolePermissions,
  roleTemplatePermissions,
  roleTemplates,
  roles,
} from './schema.js';

export type Role = typeof roles.$inferSelect;
export type Permission = typeof permissions.$inferSelect;

export interface RoleWithPermissions extends Role {
  permissionKeys: string[];
  memberCount: number;
}

/**
 * Creates the organization's roles from the system role templates (with their permissions).
 * Returns role ids keyed by template key.
 */
export async function provisionOrganizationRoles(
  tx: Transaction,
  organizationId: string,
): Promise<Map<string, Role>> {
  const templates = await tx.select().from(roleTemplates).orderBy(asc(roleTemplates.sortOrder));
  if (templates.length === 0) {
    throw new Error('Role templates are not seeded; run the database seed');
  }
  const created = new Map<string, Role>();
  for (const template of templates) {
    const [role] = await tx
      .insert(roles)
      .values({
        organizationId,
        templateKey: template.key,
        name: template.name,
        description: template.description,
        isSystem: true,
        isOwner: template.isOwner,
      })
      .returning();
    if (!role) throw new Error('Role insert returned no row');
    const templatePermissions = await tx
      .select({ key: roleTemplatePermissions.permissionKey })
      .from(roleTemplatePermissions)
      .where(eq(roleTemplatePermissions.templateKey, template.key));
    if (templatePermissions.length > 0) {
      await tx.insert(rolePermissions).values(
        templatePermissions.map((p) => ({
          roleId: role.id,
          organizationId,
          permissionKey: p.key,
        })),
      );
    }
    created.set(template.key, role);
  }
  return created;
}

export async function listPermissionCatalog(tx: Transaction): Promise<Permission[]> {
  return tx.select().from(permissions).orderBy(asc(permissions.key));
}

/** Returns the subset of keys that are not in the catalog. */
export async function findUnknownPermissionKeys(
  tx: Transaction,
  keys: readonly string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await tx
    .select({ key: permissions.key })
    .from(permissions)
    .where(inArray(permissions.key, [...keys]));
  const known = new Set(rows.map((row) => row.key));
  return keys.filter((key) => !known.has(key));
}

export async function getRole(
  tx: Transaction,
  organizationId: string,
  roleId: string,
): Promise<Role | undefined> {
  const [row] = await tx
    .select()
    .from(roles)
    .where(and(eq(roles.organizationId, organizationId), eq(roles.id, roleId)))
    .limit(1);
  return row;
}

export async function getRolesByIds(
  tx: Transaction,
  organizationId: string,
  roleIds: readonly string[],
): Promise<Role[]> {
  if (roleIds.length === 0) return [];
  return tx
    .select()
    .from(roles)
    .where(and(eq(roles.organizationId, organizationId), inArray(roles.id, [...roleIds])));
}

export async function listRoles(
  tx: Transaction,
  organizationId: string,
): Promise<RoleWithPermissions[]> {
  const roleRows = await tx
    .select()
    .from(roles)
    .where(eq(roles.organizationId, organizationId))
    .orderBy(asc(roles.createdAt), asc(roles.name));
  const permissionRows = await tx
    .select({ roleId: rolePermissions.roleId, key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.organizationId, organizationId));
  const counts = await tx
    .select({ roleId: membershipRoles.roleId, count: sql<number>`count(*)::int` })
    .from(membershipRoles)
    .where(eq(membershipRoles.organizationId, organizationId))
    .groupBy(membershipRoles.roleId);

  const permissionsByRole = new Map<string, string[]>();
  for (const row of permissionRows) {
    const list = permissionsByRole.get(row.roleId) ?? [];
    list.push(row.key);
    permissionsByRole.set(row.roleId, list);
  }
  const countByRole = new Map(counts.map((row) => [row.roleId, row.count]));
  return roleRows.map((role) => ({
    ...role,
    permissionKeys: (permissionsByRole.get(role.id) ?? []).sort(),
    memberCount: countByRole.get(role.id) ?? 0,
  }));
}

/** Returns undefined when a role with the same name exists in the organization. */
export async function createCustomRole(
  tx: Transaction,
  input: { organizationId: string; name: string; description: string; permissionKeys: string[] },
): Promise<Role | undefined> {
  const [role] = await tx
    .insert(roles)
    .values({
      organizationId: input.organizationId,
      name: input.name.trim(),
      description: input.description.trim(),
    })
    .onConflictDoNothing()
    .returning();
  if (!role) return undefined;
  await replaceRolePermissions(tx, input.organizationId, role.id, input.permissionKeys);
  return role;
}

/** Updates a role's name/description; returns undefined on a name clash. */
export async function updateRoleDetails(
  tx: Transaction,
  input: { organizationId: string; roleId: string; name: string; description: string },
): Promise<Role | undefined | 'name_taken'> {
  const clash = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        eq(roles.organizationId, input.organizationId),
        sql`lower(${roles.name}) = lower(${input.name.trim()})`,
        sql`${roles.id} <> ${input.roleId}`,
      ),
    )
    .limit(1);
  if (clash.length > 0) return 'name_taken';
  const [role] = await tx
    .update(roles)
    .set({ name: input.name.trim(), description: input.description.trim() })
    .where(and(eq(roles.organizationId, input.organizationId), eq(roles.id, input.roleId)))
    .returning();
  return role;
}

export async function replaceRolePermissions(
  tx: Transaction,
  organizationId: string,
  roleId: string,
  permissionKeys: readonly string[],
): Promise<void> {
  await tx
    .delete(rolePermissions)
    .where(
      and(eq(rolePermissions.organizationId, organizationId), eq(rolePermissions.roleId, roleId)),
    );
  const unique = [...new Set(permissionKeys)];
  if (unique.length > 0) {
    await tx
      .insert(rolePermissions)
      .values(unique.map((permissionKey) => ({ roleId, organizationId, permissionKey })));
  }
}

export async function getRolePermissionKeys(
  tx: Transaction,
  organizationId: string,
  roleId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(
      and(eq(rolePermissions.organizationId, organizationId), eq(rolePermissions.roleId, roleId)),
    );
  return rows.map((row) => row.key).sort();
}

export async function countRoleAssignments(
  tx: Transaction,
  organizationId: string,
  roleId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(membershipRoles)
    .where(
      and(eq(membershipRoles.organizationId, organizationId), eq(membershipRoles.roleId, roleId)),
    );
  return row?.count ?? 0;
}

export async function deleteRole(
  tx: Transaction,
  organizationId: string,
  roleId: string,
): Promise<boolean> {
  const rows = await tx
    .delete(roles)
    .where(
      and(
        eq(roles.organizationId, organizationId),
        eq(roles.id, roleId),
        eq(roles.isSystem, false),
      ),
    )
    .returning({ id: roles.id });
  return rows.length > 0;
}
