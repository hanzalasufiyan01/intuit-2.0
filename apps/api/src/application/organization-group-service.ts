import { AppError, ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { AccountingPermissions } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  addGroupMember,
  deleteGroup,
  getGroup,
  getOrganization,
  insertGroup,
  listGroupMembers,
  listGroups,
  removeGroupMember,
} from '../modules/organizations/index.js';
import type { Transaction } from '../database/client.js';
import {
  hasPermission,
  requireRecentAuthentication,
  resolveActingUserContext,
  type Principal,
} from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { ReportService } from './report-service.js';
import { inTransaction, setDbContext } from './unit-of-work.js';

/**
 * Groups of legal entities (FP-24, migration 0085). A legal entity is a separate organization; a
 * group links organizations that the SAME user owns so they can be read side by side. A group
 * moves no money and creates no entries: there is no consolidation, no intercompany elimination
 * and no currency translation (open decision, docs/open-decisions.md). Each organization's
 * figures are read under that organization's own security and permissions, and are never summed
 * across organizations.
 */

const MAX_GROUPS = 20;
const MAX_ORGANIZATIONS = 25;

export class OrganizationGroupService {
  private readonly reports: ReportService;
  constructor(private readonly deps: AppDependencies) {
    this.reports = new ReportService(deps);
  }

  private tx<T>(principal: Principal, work: (tx: Transaction) => Promise<T>, readOnly = false) {
    return inTransaction(this.deps.db, { userId: principal.user.id }, work, {
      readOnlySnapshot: readOnly,
    });
  }

  private reauth(principal: Principal) {
    requireRecentAuthentication(
      principal,
      this.deps.clock.now(),
      this.deps.config.session.reauthWindowMs,
    );
  }

  /** The user's current standing in one organization; null when they can no longer act there. */
  private async accessIn(tx: Transaction, userId: string, organizationId: string) {
    try {
      const ctx = await resolveActingUserContext(tx, userId, organizationId);
      const organization = await getOrganization(tx, organizationId);
      return { ctx, name: organization?.name ?? null, isOwner: ctx.isOwner };
    } catch (error) {
      if (error instanceof AppError) return null;
      throw error;
    }
  }

  private async describe(tx: Transaction, groupId: string, userId: string) {
    const members = await listGroupMembers(tx, groupId);
    const out = [];
    for (const m of members) {
      const access = await this.accessIn(tx, userId, m.organizationId);
      out.push({
        organizationId: m.organizationId,
        name: access ? access.name : null,
        isOwner: access?.isOwner ?? false,
        addedAt: m.addedAt.toISOString(),
      });
    }
    await setDbContext(tx, { userId });
    return out;
  }

  private async get(tx: Transaction, userId: string, groupId: string) {
    const group = await getGroup(tx, userId, groupId);
    if (!group) throw new NotFoundError('Group not found.');
    return {
      id: group.id,
      name: group.name,
      createdAt: group.createdAt.toISOString(),
      organizations: await this.describe(tx, groupId, userId),
    };
  }

  list(principal: Principal) {
    return this.tx(principal, async (tx) => {
      const out = [];
      for (const g of await listGroups(tx, principal.user.id)) {
        out.push(await this.get(tx, principal.user.id, g.id));
      }
      return out;
    });
  }

  create(principal: Principal, input: { name: string }, origin: EventOrigin) {
    return this.tx(principal, async (tx) => {
      const name = input.name.trim();
      if (!name) throw new ValidationError([{ path: 'name', message: 'Enter a name.' }]);
      if ((await listGroups(tx, principal.user.id)).length >= MAX_GROUPS) {
        throw new ConflictError('CONFLICT', `At most ${MAX_GROUPS} groups.`);
      }
      const at = this.deps.clock.now();
      const group = await insertGroup(tx, { name, ownerUserId: principal.user.id, at });
      await recordAuditEvent(tx, {
        occurredAt: at,
        organizationId: null,
        actorUserId: principal.user.id,
        action: 'organization_group.created',
        resourceType: 'organization_group',
        resourceId: group.id,
        metadata: { name },
        origin,
      });
      return { id: group.id, name: group.name, createdAt: at.toISOString(), organizations: [] };
    });
  }

  /** Adds an organization the caller OWNS. Another organization's existence is never revealed. */
  addOrganization(
    principal: Principal,
    groupId: string,
    input: { organizationId: string },
    origin: EventOrigin,
  ) {
    return this.tx(principal, async (tx) => {
      this.reauth(principal);
      const userId = principal.user.id;
      const group = await getGroup(tx, userId, groupId);
      if (!group) throw new NotFoundError('Group not found.');
      const access = await this.accessIn(tx, userId, input.organizationId);
      await setDbContext(tx, { userId });
      if (!access?.isOwner) throw new NotFoundError('Organization not found.');
      if ((await listGroupMembers(tx, groupId)).length >= MAX_ORGANIZATIONS) {
        throw new ConflictError('CONFLICT', `At most ${MAX_ORGANIZATIONS} organizations.`);
      }
      const at = this.deps.clock.now();
      const added = await addGroupMember(tx, {
        groupId,
        organizationId: input.organizationId,
        userId,
        at,
      });
      if (!added) {
        throw new ConflictError('CONFLICT', 'This organization already belongs to a group.');
      }
      await setDbContext(tx, { userId, organizationId: input.organizationId });
      await recordAuditEvent(tx, {
        occurredAt: at,
        organizationId: input.organizationId,
        actorUserId: userId,
        action: 'organization.group_joined',
        resourceType: 'organization_group',
        resourceId: groupId,
        metadata: { groupName: group.name },
        origin,
      });
      await setDbContext(tx, { userId });
      return this.get(tx, userId, groupId);
    });
  }

  removeOrganization(
    principal: Principal,
    groupId: string,
    organizationId: string,
    origin: EventOrigin,
  ) {
    return this.tx(principal, async (tx) => {
      this.reauth(principal);
      const userId = principal.user.id;
      const group = await getGroup(tx, userId, groupId);
      if (!group) throw new NotFoundError('Group not found.');
      if (!(await removeGroupMember(tx, groupId, organizationId))) {
        throw new NotFoundError('Organization is not in this group.');
      }
      await setDbContext(tx, { userId, organizationId });
      await recordAuditEvent(tx, {
        occurredAt: this.deps.clock.now(),
        organizationId,
        actorUserId: userId,
        action: 'organization.group_left',
        resourceType: 'organization_group',
        resourceId: groupId,
        metadata: { groupName: group.name },
        origin,
      });
      await setDbContext(tx, { userId });
      return this.get(tx, userId, groupId);
    });
  }

  delete(principal: Principal, groupId: string, origin: EventOrigin) {
    return this.tx(principal, async (tx) => {
      this.reauth(principal);
      const userId = principal.user.id;
      const group = await getGroup(tx, userId, groupId);
      if (!group) throw new NotFoundError('Group not found.');
      const members = await listGroupMembers(tx, groupId);
      await deleteGroup(tx, groupId);
      const at = this.deps.clock.now();
      for (const m of members) {
        await setDbContext(tx, { userId, organizationId: m.organizationId });
        await recordAuditEvent(tx, {
          occurredAt: at,
          organizationId: m.organizationId,
          actorUserId: userId,
          action: 'organization.group_left',
          resourceType: 'organization_group',
          resourceId: groupId,
          metadata: { groupName: group.name, groupDeleted: true },
          origin,
        });
      }
      await setDbContext(tx, { userId });
      await recordAuditEvent(tx, {
        occurredAt: at,
        organizationId: null,
        actorUserId: userId,
        action: 'organization_group.deleted',
        resourceType: 'organization_group',
        resourceId: groupId,
        metadata: { name: group.name },
        origin,
      });
      return { id: groupId, deleted: true };
    });
  }

  /**
   * Profit and loss of every organization of the group for the same period, side by side. Each
   * organization is read under the caller's own permissions there; one where they lack
   * accounting.reports.view (or are no longer a member) appears as no_access with no figures.
   * Figures are in each organization's own base currency and are NOT added together.
   */
  overview(principal: Principal, groupId: string, input: { from: string; to: string }) {
    return this.tx(
      principal,
      async (tx) => {
        const userId = principal.user.id;
        const group = await getGroup(tx, userId, groupId);
        if (!group) throw new NotFoundError('Group not found.');
        const members = await listGroupMembers(tx, groupId);
        const rows = [];
        for (const m of members) {
          const access = await this.accessIn(tx, userId, m.organizationId);
          if (!access || !hasPermission(access.ctx, AccountingPermissions.ReportsView)) {
            rows.push({
              organizationId: m.organizationId,
              name: access?.name ?? null,
              status: 'no_access' as const,
            });
            continue;
          }
          try {
            const pl = await this.reports.profitAndLossInTransaction(tx, access.ctx, {
              includeZero: false,
              currencyView: 'base',
              from: input.from,
              to: input.to,
            });
            rows.push({
              organizationId: m.organizationId,
              name: access.name,
              status: 'ok' as const,
              baseCurrency: pl.baseCurrency,
              grossProfit: pl.summary.grossProfit[0] ?? null,
              operatingProfit: pl.summary.operatingProfit[0] ?? null,
              netProfit: pl.summary.netProfit[0] ?? null,
              integrity: pl.integrity.status,
            });
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            rows.push({
              organizationId: m.organizationId,
              name: access.name,
              status: 'unavailable' as const,
              reason: error.message,
            });
          }
        }
        return {
          groupId,
          name: group.name,
          from: input.from,
          to: input.to,
          organizations: rows,
          note: 'Each organization is shown in its own base currency. Nothing is added together: consolidation, intercompany eliminations and currency translation are not performed.',
        };
      },
      true,
    );
  }
}
