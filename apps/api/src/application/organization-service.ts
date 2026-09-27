import { NotFoundError, ProtectedResourceError, ValidationError } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import {
  AccessControlPermissions,
  getEffectiveAccess,
  getRolesByIds,
  listMembershipRoleAssignments,
  replaceMembershipRoles,
} from '../modules/access-control/index.js';
import {
  AuditPermissions,
  listAuditEvents,
  recordAuditEvent,
  type EventOrigin,
} from '../modules/audit/index.js';
import { getUserProfiles, setSessionActiveOrganization } from '../modules/identity/index.js';
import {
  findMembershipById,
  getOrganization,
  listOrganizationMemberships,
  listUserOrganizations,
  OrganizationPermissions,
  renameOrganization,
  setMembershipStatus,
  type MembershipStatus,
} from '../modules/organizations/index.js';
import { enqueueOutboxEvent } from '../modules/outbox/index.js';
import {
  requirePermission,
  requireRecentAuthentication,
  resolveAuthorizationContext,
  type AuthorizationContext,
  type Principal,
} from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { createOrganizationWithOwner } from './organization-provisioning.js';
import { inTransaction } from './unit-of-work.js';

export interface OperationOptions {
  permission?: string;
  /** Sensitive action: requires re-authentication within the configured window. */
  sensitive?: boolean;
}

/**
 * Runs an organization-scoped operation in one transaction:
 * authentication (principal) -> membership -> roles -> permission -> [recent re-auth],
 * with the RLS context bound to the session's active organization.
 */
export async function withOrganization<T>(
  deps: AppDependencies,
  principal: Principal,
  options: OperationOptions,
  work: (tx: Transaction, context: AuthorizationContext) => Promise<T>,
): Promise<T> {
  return inTransaction(deps.db, { userId: principal.user.id }, async (tx) => {
    const context = await resolveAuthorizationContext(tx, principal);
    if (options.permission) requirePermission(context, options.permission);
    if (options.sensitive) {
      requireRecentAuthentication(principal, deps.clock.now(), deps.config.session.reauthWindowMs);
    }
    return work(tx, context);
  });
}

export class OrganizationService {
  constructor(private readonly deps: AppDependencies) {}

  listMyOrganizations(principal: Principal) {
    return inTransaction(this.deps.db, { userId: principal.user.id }, async (tx) => {
      const organizations = await listUserOrganizations(tx, principal.user.id);
      return organizations.map((o) => ({
        id: o.organizationId,
        name: o.organizationName,
        membershipId: o.membershipId,
        active: o.organizationId === principal.session.activeOrganizationId,
      }));
    });
  }

  /** Creates an additional organization owned by the caller and makes it active. */
  async createOrganization(principal: Principal, name: string, origin: EventOrigin) {
    const now = this.deps.clock.now();
    return inTransaction(this.deps.db, { userId: principal.user.id }, async (tx) => {
      const { organization } = await createOrganizationWithOwner(tx, {
        name,
        ownerUserId: principal.user.id,
        now,
        origin,
      });
      await setSessionActiveOrganization(tx, principal.session.id, organization.id);
      return { id: organization.id, name: organization.name };
    });
  }

  getCurrent(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.OrganizationRead },
      async (tx, ctx) => {
        const organization = await getOrganization(tx, ctx.organizationId);
        if (!organization) throw new NotFoundError();
        return {
          id: organization.id,
          name: organization.name,
          status: organization.status,
          createdAt: organization.createdAt.toISOString(),
        };
      },
    );
  }

  updateCurrent(principal: Principal, input: { name: string }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.OrganizationUpdate },
      async (tx, ctx) => {
        const before = await getOrganization(tx, ctx.organizationId);
        const updated = await renameOrganization(tx, ctx.organizationId, input.name);
        if (!before || !updated) throw new NotFoundError();
        const now = this.deps.clock.now();
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'organization.updated',
          resourceType: 'organization',
          resourceId: ctx.organizationId,
          metadata: { changes: { name: { from: before.name, to: updated.name } } },
          origin,
        });
        return { id: updated.id, name: updated.name, status: updated.status };
      },
    );
  }

  listMembers(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersRead },
      async (tx, ctx) => {
        const memberships = await listOrganizationMemberships(tx, ctx.organizationId);
        const users = await getUserProfiles(
          tx,
          memberships.map((m) => m.userId),
        );
        const roles = await listMembershipRoleAssignments(tx, ctx.organizationId);
        return memberships.map((m) => {
          const user = users.get(m.userId);
          const assigned = roles.get(m.id) ?? [];
          return {
            membershipId: m.id,
            userId: m.userId,
            email: user?.email ?? null,
            displayName: user?.displayName ?? null,
            status: m.status,
            isOwner: assigned.some((r) => r.isOwner),
            roles: assigned,
            joinedAt: m.createdAt.toISOString(),
          };
        });
      },
    );
  }

  /** Replaces a member's roles. The Owner role and the Owner's membership are protected. */
  setMemberRoles(
    principal: Principal,
    input: { membershipId: string; roleIds: string[] },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersManage, sensitive: true },
      async (tx, ctx) => {
        const membership = await findMembershipById(tx, ctx.organizationId, input.membershipId);
        if (!membership) throw new NotFoundError('Member not found.');
        const current = await getEffectiveAccess(tx, ctx.organizationId, membership.id);
        if (current.isOwner) {
          throw new ProtectedResourceError(
            "The Owner's roles cannot be changed; ownership changes use the ownership-transfer workflow.",
          );
        }
        const uniqueIds = [...new Set(input.roleIds)];
        const roles = await getRolesByIds(tx, ctx.organizationId, uniqueIds);
        if (roles.length !== uniqueIds.length) {
          throw new ValidationError([
            { path: 'roleIds', message: 'One or more roles do not exist.' },
          ]);
        }
        if (roles.some((role) => role.isOwner)) {
          throw new ProtectedResourceError('The Owner role cannot be assigned.');
        }
        await replaceMembershipRoles(tx, {
          organizationId: ctx.organizationId,
          membershipId: membership.id,
          roles,
          assignedByUserId: ctx.userId,
        });
        const now = this.deps.clock.now();
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'membership.roles_changed',
          resourceType: 'membership',
          resourceId: membership.id,
          metadata: {
            userId: membership.userId,
            fromRoleIds: current.roleIds,
            toRoleIds: roles.map((r) => r.id),
            toRoleNames: roles.map((r) => r.name),
          },
          origin,
        });
        await enqueueOutboxEvent(
          tx,
          {
            eventType: 'organizations.membership_roles_changed',
            aggregateType: 'membership',
            aggregateId: membership.id,
            organizationId: ctx.organizationId,
            payload: { membershipId: membership.id, roleIds: roles.map((r) => r.id) },
          },
          now,
        );
        return { membershipId: membership.id, roleIds: roles.map((r) => r.id) };
      },
    );
  }

  /** Disables or re-enables a membership. The Owner's membership is protected. */
  setMemberStatus(
    principal: Principal,
    input: { membershipId: string; status: MembershipStatus },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersManage, sensitive: true },
      async (tx, ctx) => {
        const membership = await findMembershipById(tx, ctx.organizationId, input.membershipId);
        if (!membership) throw new NotFoundError('Member not found.');
        const access = await getEffectiveAccess(tx, ctx.organizationId, membership.id);
        if (access.isOwner) {
          throw new ProtectedResourceError("The Owner's membership cannot be disabled.");
        }
        if (membership.status === input.status) {
          return { membershipId: membership.id, status: membership.status };
        }
        const now = this.deps.clock.now();
        const updated = await setMembershipStatus(tx, {
          organizationId: ctx.organizationId,
          membershipId: membership.id,
          status: input.status,
          now,
        });
        if (!updated) throw new NotFoundError('Member not found.');
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: input.status === 'disabled' ? 'membership.disabled' : 'membership.enabled',
          resourceType: 'membership',
          resourceId: membership.id,
          metadata: { userId: membership.userId, from: membership.status, to: input.status },
          origin,
        });
        await enqueueOutboxEvent(
          tx,
          {
            eventType: 'organizations.membership_status_changed',
            aggregateType: 'membership',
            aggregateId: membership.id,
            organizationId: ctx.organizationId,
            payload: { membershipId: membership.id, status: input.status },
          },
          now,
        );
        return { membershipId: updated.id, status: updated.status };
      },
    );
  }

  listAuditEvents(principal: Principal, options: { limit: number; before?: Date | undefined }) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AuditPermissions.AuditRead },
      async (tx, ctx) => {
        const events = await listAuditEvents(tx, ctx.organizationId, options);
        return events.map((e) => ({
          id: e.id,
          occurredAt: e.occurredAt.toISOString(),
          actorType: e.actorType,
          actorUserId: e.actorUserId,
          action: e.action,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          requestId: e.requestId,
          metadata: e.metadata,
        }));
      },
    );
  }
}

/** Re-exported for routes that need catalog permission constants in one place. */
export const Permissions = {
  ...OrganizationPermissions,
  ...AccessControlPermissions,
  ...AuditPermissions,
} as const;
