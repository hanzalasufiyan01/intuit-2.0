import {
  ConflictError,
  NotFoundError,
  ProtectedResourceError,
  ValidationError,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import {
  AccessControlPermissions,
  countRoleAssignments,
  createCustomRole,
  deleteRole,
  findUnknownPermissionKeys,
  getRole,
  getRolePermissionKeys,
  listPermissionCatalog,
  listRoles,
  replaceRolePermissions,
  updateRoleDetails,
  type Role,
} from '../modules/access-control/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { enqueueOutboxEvent } from '../modules/outbox/index.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

function toRoleView(role: Role, permissionKeys: string[], memberCount?: number) {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    templateKey: role.templateKey,
    isSystem: role.isSystem,
    isOwner: role.isOwner,
    permissionKeys,
    ...(memberCount === undefined ? {} : { memberCount }),
  };
}

/** Organization-scoped role management within the protected system constraints. */
export class RoleService {
  constructor(private readonly deps: AppDependencies) {}

  private async assertKnownPermissions(tx: Transaction, keys: readonly string[]) {
    const unknown = await findUnknownPermissionKeys(tx, keys);
    if (unknown.length > 0) {
      throw new ValidationError([
        { path: 'permissionKeys', message: `Unknown permissions: ${unknown.join(', ')}` },
      ]);
    }
  }

  listRoles(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccessControlPermissions.RolesRead },
      async (tx, ctx) => {
        const roles = await listRoles(tx, ctx.organizationId);
        return roles.map((r) => toRoleView(r, r.permissionKeys, r.memberCount));
      },
    );
  }

  listPermissionCatalog(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccessControlPermissions.RolesRead },
      async (tx) => {
        const catalog = await listPermissionCatalog(tx);
        return catalog.map((p) => ({ key: p.key, module: p.module, description: p.description }));
      },
    );
  }

  createRole(
    principal: Principal,
    input: { name: string; description: string; permissionKeys: string[] },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccessControlPermissions.RolesManage, sensitive: true },
      async (tx, ctx) => {
        await this.assertKnownPermissions(tx, input.permissionKeys);
        const role = await createCustomRole(tx, { organizationId: ctx.organizationId, ...input });
        if (!role) throw new ConflictError('CONFLICT', 'A role with this name already exists.');
        const keys = await getRolePermissionKeys(tx, ctx.organizationId, role.id);
        const now = this.deps.clock.now();
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'role.created',
          resourceType: 'role',
          resourceId: role.id,
          metadata: { name: role.name, permissionKeys: keys },
          origin,
        });
        await enqueueOutboxEvent(
          tx,
          {
            eventType: 'access_control.role_created',
            aggregateType: 'role',
            aggregateId: role.id,
            organizationId: ctx.organizationId,
            payload: { roleId: role.id },
          },
          now,
        );
        return toRoleView(role, keys);
      },
    );
  }

  /**
   * Updates a role. The Owner role is immutable. System (template) roles keep their name
   * but their permissions may be customized per organization.
   */
  updateRole(
    principal: Principal,
    input: { roleId: string; name: string; description: string; permissionKeys: string[] },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccessControlPermissions.RolesManage, sensitive: true },
      async (tx, ctx) => {
        const role = await getRole(tx, ctx.organizationId, input.roleId);
        if (!role) throw new NotFoundError('Role not found.');
        if (role.isOwner) throw new ProtectedResourceError('The Owner role cannot be modified.');
        if (role.isSystem && input.name.trim() !== role.name) {
          throw new ProtectedResourceError('System roles cannot be renamed.');
        }
        await this.assertKnownPermissions(tx, input.permissionKeys);
        const beforeKeys = await getRolePermissionKeys(tx, ctx.organizationId, role.id);
        const updated = await updateRoleDetails(tx, {
          organizationId: ctx.organizationId,
          roleId: role.id,
          name: input.name,
          description: input.description,
        });
        if (updated === 'name_taken') {
          throw new ConflictError('CONFLICT', 'A role with this name already exists.');
        }
        if (!updated) throw new NotFoundError('Role not found.');
        await replaceRolePermissions(tx, ctx.organizationId, role.id, input.permissionKeys);
        const afterKeys = await getRolePermissionKeys(tx, ctx.organizationId, role.id);
        const now = this.deps.clock.now();
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'role.updated',
          resourceType: 'role',
          resourceId: role.id,
          metadata: {
            name: { from: role.name, to: updated.name },
            permissionsAdded: afterKeys.filter((k) => !beforeKeys.includes(k)),
            permissionsRemoved: beforeKeys.filter((k) => !afterKeys.includes(k)),
          },
          origin,
        });
        await enqueueOutboxEvent(
          tx,
          {
            eventType: 'access_control.role_updated',
            aggregateType: 'role',
            aggregateId: role.id,
            organizationId: ctx.organizationId,
            payload: { roleId: role.id },
          },
          now,
        );
        return toRoleView(updated, afterKeys);
      },
    );
  }

  /** Deletes a custom role that is not assigned and not referenced by invitations. */
  deleteRole(principal: Principal, roleId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccessControlPermissions.RolesManage, sensitive: true },
      async (tx, ctx) => {
        const role = await getRole(tx, ctx.organizationId, roleId);
        if (!role) throw new NotFoundError('Role not found.');
        if (role.isSystem) throw new ProtectedResourceError('System roles cannot be deleted.');
        if ((await countRoleAssignments(tx, ctx.organizationId, role.id)) > 0) {
          throw new ConflictError(
            'CONFLICT',
            'Remove this role from all members before deleting it.',
          );
        }
        const permissionKeys = await getRolePermissionKeys(tx, ctx.organizationId, role.id);
        try {
          await tx.transaction(async (savepoint) => {
            await deleteRole(savepoint, ctx.organizationId, role.id);
          });
        } catch (error) {
          if (isForeignKeyViolation(error)) {
            throw new ConflictError(
              'CONFLICT',
              'This role is referenced by invitations or approval policies and cannot be deleted.',
            );
          }
          throw error;
        }
        const now = this.deps.clock.now();
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'role.deleted',
          resourceType: 'role',
          resourceId: role.id,
          metadata: { name: role.name, permissionKeys },
          origin,
        });
        await enqueueOutboxEvent(
          tx,
          {
            eventType: 'access_control.role_deleted',
            aggregateType: 'role',
            aggregateId: role.id,
            organizationId: ctx.organizationId,
            payload: { roleId: role.id },
          },
          now,
        );
      },
    );
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    if ((current as { code?: unknown }).code === '23503') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
