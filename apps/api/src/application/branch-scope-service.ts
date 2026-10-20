import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { getDimensionValuesByIds } from '../modules/accounting/index.js';
import {
  branchScopeOf,
  getEffectiveAccess,
  listBranchScopes,
  replaceBranchScope,
} from '../modules/access-control/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { findMembershipById, OrganizationPermissions } from '../modules/organizations/index.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Branch-scoped access (FP-24, migration 0084). An administrator limits a member to a set of
 * branches (dimension values): the database then shows that member only invoices and bills tagged
 * with them, and the member keeps only the permissions of the allow-list. Owners cannot be
 * limited, nobody can limit themself (they would lose the right to undo it), and a limited member
 * cannot change scopes (the permission is not on the allow-list).
 */

const MAX_BRANCHES = 50;

export class BranchScopeService {
  constructor(private readonly deps: AppDependencies) {}

  list(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersRead, readOnlySnapshot: true },
      async (tx, ctx) => {
        const rows = await listBranchScopes(tx, ctx.organizationId);
        const byMember = new Map<string, string[]>();
        for (const r of rows) {
          byMember.set(r.membershipId, [
            ...(byMember.get(r.membershipId) ?? []),
            r.dimensionValueId,
          ]);
        }
        const values = await getDimensionValuesByIds(
          tx,
          ctx.organizationId,
          rows.map((r) => r.dimensionValueId),
        );
        return [...byMember].map(([membershipId, ids]) => ({
          membershipId,
          branches: ids.map((id) => ({
            id,
            code: values.get(id)?.code ?? null,
            name: values.get(id)?.name ?? null,
          })),
        }));
      },
    );
  }

  get(principal: Principal, membershipId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersRead, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (!(await findMembershipById(tx, ctx.organizationId, membershipId))) {
          throw new NotFoundError('Member not found.');
        }
        const ids = await branchScopeOf(tx, ctx.organizationId, membershipId);
        const values = await getDimensionValuesByIds(tx, ctx.organizationId, ids);
        return {
          membershipId,
          restricted: ids.length > 0,
          branches: ids.map((id) => ({
            id,
            code: values.get(id)?.code ?? null,
            name: values.get(id)?.name ?? null,
          })),
        };
      },
    );
  }

  /** Replaces the branches of a member; an empty list lifts the restriction. */
  set(
    principal: Principal,
    membershipId: string,
    input: { dimensionValueIds: string[] },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersManage, sensitive: true },
      async (tx, ctx) => {
        const target = await findMembershipById(tx, ctx.organizationId, membershipId);
        if (!target) throw new NotFoundError('Member not found.');
        if (target.status !== 'active') {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            'Only an active member can be limited to branches.',
          );
        }
        if (target.id === ctx.membershipId) {
          throw new ConflictError('INVALID_STATE_TRANSITION', 'You cannot limit your own access.');
        }
        if ((await getEffectiveAccess(tx, ctx.organizationId, membershipId)).isOwner) {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            'The owner can never be limited to branches.',
          );
        }
        const ids = [...new Set(input.dimensionValueIds)];
        const issues: ValidationIssue[] = [];
        if (ids.length > MAX_BRANCHES)
          issues.push({ path: 'dimensionValueIds', message: `At most ${MAX_BRANCHES} branches.` });
        const values = await getDimensionValuesByIds(tx, ctx.organizationId, ids);
        ids.forEach((id, i) => {
          const value = values.get(id);
          if (!value || value.status !== 'ACTIVE' || value.typeStatus !== 'ACTIVE') {
            issues.push({
              path: `dimensionValueIds.${i}`,
              message: 'Choose an active dimension value (a branch).',
            });
          }
        });
        if (issues.length) throw new ValidationError(issues);
        const before = await branchScopeOf(tx, ctx.organizationId, membershipId);
        await replaceBranchScope(tx, {
          organizationId: ctx.organizationId,
          membershipId,
          dimensionValueIds: ids,
          userId: ctx.userId,
          at: this.deps.clock.now(),
        });
        await recordAuditEvent(tx, {
          occurredAt: this.deps.clock.now(),
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: ids.length ? 'member.branch_scope_set' : 'member.branch_scope_cleared',
          resourceType: 'membership',
          resourceId: membershipId,
          metadata: { before, after: ids },
          origin,
        });
        return {
          membershipId,
          restricted: ids.length > 0,
          branches: ids.map((id) => ({
            id,
            code: values.get(id)?.code ?? null,
            name: values.get(id)?.name ?? null,
          })),
        };
      },
    );
  }
}
