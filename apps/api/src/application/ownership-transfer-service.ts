import { sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ProtectedResourceError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import {
  getEffectiveAccess,
  getOwnerRole,
  getRole,
  transferOwnerRole,
} from '../modules/access-control/index.js';
import { recordAuditEvent, recordSecurityEvent, type EventOrigin } from '../modules/audit/index.js';
import { getUserProfiles, hasActiveFactor } from '../modules/identity/index.js';
import {
  findMembershipById,
  findOpenOwnershipTransfer,
  getOrganization,
  listMemberMfaEnrollment,
  getOwnershipTransfer,
  insertOwnershipTransfer,
  listOwnershipTransfers,
  OPEN_TRANSFER_STATUSES,
  OrganizationPermissions,
  updateOwnershipTransfer,
  type OwnershipTransfer,
} from '../modules/organizations/index.js';
import { enqueueOutboxEvent } from '../modules/outbox/index.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * The controlled ownership-transfer workflow (master context section 8, ADR 0001, ADR 0012):
 *
 *   the Owner initiates  -> security verification (password re-authentication and MFA step-up)
 *   -> the new owner accepts (the same verification) -> ownership changes in ONE transaction
 *   -> audit -> notification of the new owner, the previous owner and the administrators.
 *
 * There is no direct owner reassignment anywhere else. Exactly one transfer is open per
 * organization (unique index), a transfer expires if it is not accepted in time, and every row is
 * kept for good: the history is permanent. The new owner must already have MFA enrolled, because
 * the Owner role requires it; the previous owner receives the replacement role chosen at
 * initiation. The ledger and every document are untouched.
 */

export const OWNERSHIP_TRANSFER_RESOURCE = 'ownership_transfer';

type TransferEvent = 'initiated' | 'accepted' | 'completed' | 'cancelled' | 'declined' | 'expired';

interface Notice {
  to: string;
  subject: string;
  text: string;
  template: string;
}

export class OwnershipTransferService {
  constructor(private readonly deps: AppDependencies) {}

  private get now() {
    return this.deps.clock.now();
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  private async view(tx: Transaction, organizationId: string, transfers: OwnershipTransfer[]) {
    const memberships = new Map<string, { userId: string }>();
    for (const id of new Set(transfers.flatMap((t) => [t.fromMembershipId, t.toMembershipId]))) {
      const membership = await findMembershipById(tx, organizationId, id);
      if (membership) memberships.set(id, { userId: membership.userId });
    }
    const profiles = await getUserProfiles(tx, [
      ...new Set([...memberships.values()].map((m) => m.userId)),
    ]);
    const person = (membershipId: string) => {
      const userId = memberships.get(membershipId)?.userId ?? null;
      const profile = userId ? profiles.get(userId) : undefined;
      return {
        membershipId,
        userId,
        email: profile?.email ?? null,
        displayName: profile?.displayName ?? null,
      };
    };
    const roles = new Map<string, string>();
    for (const id of new Set(transfers.map((t) => t.replacementRoleId))) {
      const role = await getRole(tx, organizationId, id);
      if (role) roles.set(id, role.name);
    }
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    return transfers.map((t) => ({
      id: t.id,
      status: t.status,
      from: person(t.fromMembershipId),
      to: person(t.toMembershipId),
      replacementRole: { id: t.replacementRoleId, name: roles.get(t.replacementRoleId) ?? null },
      initiatedAt: t.initiatedAt.toISOString(),
      verifiedAt: iso(t.verifiedAt),
      acceptedAt: iso(t.acceptedAt),
      completedAt: iso(t.completedAt),
      cancelledAt: iso(t.cancelledAt),
      cancelReason: t.cancelReason,
      expiredAt: iso(t.expiredAt),
      expiresAt: t.expiresAt.toISOString(),
    }));
  }

  /**
   * Transfers the caller may see: the Owner and holders of `members.manage` see all; anyone else
   * only a transfer addressed to them. Overdue open transfers are expired first.
   */
  list(principal: Principal, limit = 50) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      await this.expireOverdue(tx, ctx, this.eventOriginNone());
      const all = await listOwnershipTransfers(tx, ctx.organizationId, limit);
      const mayManage = ctx.isOwner || ctx.permissions.has(OrganizationPermissions.MembersManage);
      const visible = mayManage ? all : all.filter((t) => t.toMembershipId === ctx.membershipId);
      return { items: await this.view(tx, ctx.organizationId, visible) };
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private eventOriginNone(): EventOrigin {
    return { requestId: null, ipAddress: null, userAgent: null };
  }

  private async audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    transfer: OwnershipTransfer,
    event: TransferEvent,
    origin: EventOrigin,
    extra: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: `ownership_transfer.${event}`,
      resourceType: OWNERSHIP_TRANSFER_RESOURCE,
      resourceId: transfer.id,
      metadata: {
        fromMembershipId: transfer.fromMembershipId,
        toMembershipId: transfer.toMembershipId,
        replacementRoleId: transfer.replacementRoleId,
        ...extra,
      },
      origin,
    });
    await recordSecurityEvent(tx, {
      occurredAt: this.now,
      eventType: `ownership.transfer_${event}`,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      metadata: { transferId: transfer.id },
      origin,
    });
  }

  /** Expires every open transfer of the organization that is past its deadline. */
  private async expireOverdue(tx: Transaction, ctx: AuthorizationContext, origin: EventOrigin) {
    const open = await findOpenOwnershipTransfer(tx, ctx.organizationId, { forUpdate: true });
    if (!open || open.expiresAt.getTime() > this.now.getTime()) return false;
    const expired = await updateOwnershipTransfer(tx, ctx.organizationId, open.id, {
      status: 'expired',
      expiredAt: this.now,
    });
    await this.audit(tx, ctx, expired ?? open, 'expired', origin);
    return true;
  }

  /** E-mail addresses of active members holding `members.manage` (the administrators). */
  private async administratorEmails(tx: Transaction, organizationId: string) {
    const result = await tx.execute<{ email: string }>(sql`
      SELECT DISTINCT u.email
        FROM memberships m
        JOIN users u ON u.id = m.user_id AND u.kind = 'human' AND u.status = 'active'
        JOIN membership_roles mr ON mr.membership_id = m.id AND mr.organization_id = m.organization_id
        JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.organization_id = m.organization_id
       WHERE m.organization_id = ${organizationId}::uuid AND m.status = 'active'
         AND rp.permission_key = ${OrganizationPermissions.MembersManage}`);
    return result.rows.map((r) => String(r.email));
  }

  private async send(notices: readonly Notice[]) {
    for (const notice of notices) {
      try {
        await this.deps.emailProvider.send(notice);
      } catch (error) {
        // A notification problem never undoes an ownership change.
        this.deps.logger.warn({ err: error, template: notice.template }, 'Ownership notice failed');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Initiate
  // ---------------------------------------------------------------------------

  /**
   * The Owner proposes the transfer. Security verification is the password re-authentication and
   * the MFA step-up that the route demands; passing them is recorded as `verified`.
   */
  async initiate(
    principal: Principal,
    input: { toMembershipId: string; replacementRoleId: string },
    origin: EventOrigin,
  ) {
    const result = await withOrganization(
      this.deps,
      principal,
      { sensitive: true, stepUp: true },
      async (tx, ctx) => {
        if (!ctx.isOwner) {
          throw new PermissionDeniedError('Only the Owner can start an ownership transfer.');
        }
        await this.expireOverdue(tx, ctx, origin);
        const issues: ValidationIssue[] = [];
        const target = await findMembershipById(tx, ctx.organizationId, input.toMembershipId);
        if (!target || target.status !== 'active') {
          issues.push({ path: 'toMembershipId', message: 'Choose an active member.' });
        } else if (target.id === ctx.membershipId) {
          issues.push({ path: 'toMembershipId', message: 'The new owner must be someone else.' });
        } else if (!(await listMemberMfaEnrollment(tx)).get(target.id)) {
          issues.push({
            path: 'toMembershipId',
            message:
              'The new owner must enroll multi-factor authentication first: the Owner role requires it.',
          });
        }
        const replacement = await getRole(tx, ctx.organizationId, input.replacementRoleId);
        if (!replacement) {
          issues.push({ path: 'replacementRoleId', message: 'The role does not exist.' });
        } else if (replacement.isOwner) {
          issues.push({
            path: 'replacementRoleId',
            message: 'Choose the role the previous owner keeps; it cannot be the Owner role.',
          });
        }
        if (issues.length) throw new ValidationError(issues);
        const inserted = await insertOwnershipTransfer(tx, {
          organizationId: ctx.organizationId,
          fromMembershipId: ctx.membershipId,
          toMembershipId: input.toMembershipId,
          replacementRoleId: input.replacementRoleId,
          initiatedByUserId: ctx.userId,
          now: this.now,
          expiresAt: new Date(this.now.getTime() + this.deps.config.ownershipTransfer.expiryMs),
        });
        if (!inserted) {
          throw new ConflictError(
            'CONFLICT',
            'An ownership transfer is already open. Cancel it or wait for it to finish.',
          );
        }
        const verified = await updateOwnershipTransfer(tx, ctx.organizationId, inserted.id, {
          status: 'verified',
          verifiedAt: this.now,
        });
        const transfer = verified ?? inserted;
        await this.audit(tx, ctx, transfer, 'initiated', origin, {
          expiresAt: transfer.expiresAt.toISOString(),
        });
        const [view] = await this.view(tx, ctx.organizationId, [transfer]);
        const organization = await getOrganization(tx, ctx.organizationId);
        const notices: Notice[] = [];
        const email = view!.to.email;
        if (email) {
          notices.push({
            to: email,
            template: 'ownership-transfer-offered',
            subject: `Ownership of "${organization?.name ?? 'an organization'}" is being offered to you`,
            text: `${view!.from.displayName ?? 'The current owner'} wants to transfer ownership of "${organization?.name ?? 'the organization'}" to you. Sign in, open Settings > Ownership and accept within ${Math.round(this.deps.config.ownershipTransfer.expiryMs / 3_600_000)} hours. You will be asked to confirm your password and a second factor. If you do not expect this, decline it.`,
          });
        }
        return { view: view!, notices };
      },
    );
    await this.send(result.notices);
    return result.view;
  }

  // ---------------------------------------------------------------------------
  // Accept (completes the transfer)
  // ---------------------------------------------------------------------------

  /**
   * The new owner accepts. Acceptance needs the same verification as initiation. Ownership then
   * changes in this transaction: the Owner role moves, the previous owner receives the replacement
   * role, and the transfer is completed. Nothing partial can remain.
   */
  async accept(principal: Principal, id: string, origin: EventOrigin) {
    const outcome = await withOrganization(
      this.deps,
      principal,
      { sensitive: true, stepUp: true },
      async (tx, ctx) => {
        const transfer = await getOwnershipTransfer(tx, ctx.organizationId, id, {
          forUpdate: true,
        });
        if (!transfer || transfer.toMembershipId !== ctx.membershipId) {
          throw new NotFoundError('Ownership transfer not found.');
        }
        if (
          (OPEN_TRANSFER_STATUSES as readonly string[]).includes(transfer.status) &&
          transfer.expiresAt.getTime() <= this.now.getTime()
        ) {
          await this.expireOverdue(tx, ctx, origin);
          return { kind: 'expired' as const };
        }
        if (transfer.status !== 'verified') {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            `This transfer is ${transfer.status} and cannot be accepted.`,
          );
        }
        const previous = await findMembershipById(
          tx,
          ctx.organizationId,
          transfer.fromMembershipId,
        );
        const previousAccess = await getEffectiveAccess(
          tx,
          ctx.organizationId,
          transfer.fromMembershipId,
        );
        if (!previous || previous.status !== 'active' || !previousAccess.isOwner) {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            'The member who offered ownership no longer owns this organization.',
          );
        }
        if (!(await hasActiveFactor(tx, ctx.userId))) {
          throw new ConflictError(
            'MFA_ENROLLMENT_REQUIRED',
            'Enroll multi-factor authentication before taking ownership.',
          );
        }
        const ownerRole = await getOwnerRole(tx, ctx.organizationId);
        const replacement = await getRole(tx, ctx.organizationId, transfer.replacementRoleId);
        if (!ownerRole || !replacement || replacement.isOwner) {
          throw new ProtectedResourceError('The replacement role is no longer available.');
        }
        const accepted = await updateOwnershipTransfer(tx, ctx.organizationId, transfer.id, {
          status: 'accepted',
          acceptedAt: this.now,
          acceptedByUserId: ctx.userId,
        });
        await this.audit(tx, ctx, accepted ?? transfer, 'accepted', origin);
        await transferOwnerRole(tx, {
          organizationId: ctx.organizationId,
          fromMembershipId: transfer.fromMembershipId,
          toMembershipId: transfer.toMembershipId,
          ownerRole,
          replacementRole: replacement,
          assignedByUserId: ctx.userId,
        });
        const completed = await updateOwnershipTransfer(tx, ctx.organizationId, transfer.id, {
          status: 'completed',
          completedAt: this.now,
        });
        const final = completed ?? transfer;
        await this.audit(tx, ctx, final, 'completed', origin, {
          previousOwnerUserId: previous.userId,
          newOwnerUserId: ctx.userId,
          replacementRoleName: replacement.name,
        });
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'organization.owner_changed',
          resourceType: 'organization',
          resourceId: ctx.organizationId,
          metadata: {
            transferId: final.id,
            previousOwnerUserId: previous.userId,
            newOwnerUserId: ctx.userId,
          },
          origin,
        });
        await enqueueOutboxEvent(
          tx,
          {
            eventType: 'organizations.ownership_transferred',
            aggregateType: 'organization',
            aggregateId: ctx.organizationId,
            organizationId: ctx.organizationId,
            payload: {
              transferId: final.id,
              fromMembershipId: final.fromMembershipId,
              toMembershipId: final.toMembershipId,
            },
          },
          this.now,
        );
        const [view] = await this.view(tx, ctx.organizationId, [final]);
        const organization = await getOrganization(tx, ctx.organizationId);
        const name = organization?.name ?? 'the organization';
        const notices: Notice[] = [];
        const to = (
          email: string | null | undefined,
          template: string,
          subject: string,
          text: string,
        ) => {
          if (email) notices.push({ to: email, template, subject, text });
        };
        to(
          view!.to.email,
          'ownership-transfer-completed-new-owner',
          `You are now the owner of "${name}"`,
          `Ownership of "${name}" has been transferred to you.`,
        );
        to(
          view!.from.email,
          'ownership-transfer-completed-previous-owner',
          `You are no longer the owner of "${name}"`,
          `Ownership of "${name}" was transferred to ${view!.to.displayName ?? 'another member'}. You now hold the role "${replacement.name}".`,
        );
        const ids = new Set([view!.to.email, view!.from.email]);
        for (const email of await this.administratorEmails(tx, ctx.organizationId)) {
          if (ids.has(email)) continue;
          to(
            email,
            'ownership-transfer-completed-admin',
            `Ownership of "${name}" changed`,
            `Ownership of "${name}" moved from ${view!.from.displayName ?? 'the previous owner'} to ${view!.to.displayName ?? 'a new owner'}.`,
          );
        }
        return { kind: 'completed' as const, view: view!, notices };
      },
    );
    if (outcome.kind === 'expired') {
      throw new ConflictError('INVALID_STATE_TRANSITION', 'This ownership transfer has expired.');
    }
    await this.send(outcome.notices);
    return outcome.view;
  }

  // ---------------------------------------------------------------------------
  // Cancel (by the Owner) and decline (by the new owner)
  // ---------------------------------------------------------------------------

  /** The Owner withdraws an open transfer. */
  cancel(principal: Principal, id: string, reason: string, origin: EventOrigin) {
    return this.close(principal, id, reason, origin, 'cancelled', { sensitive: true });
  }

  /** The member who was offered ownership refuses it. */
  decline(principal: Principal, id: string, reason: string, origin: EventOrigin) {
    return this.close(principal, id, reason, origin, 'declined', {});
  }

  private async close(
    principal: Principal,
    id: string,
    reason: string,
    origin: EventOrigin,
    event: 'cancelled' | 'declined',
    options: { sensitive?: boolean },
  ) {
    return withOrganization(this.deps, principal, options, async (tx, ctx) => {
      const transfer = await getOwnershipTransfer(tx, ctx.organizationId, id, { forUpdate: true });
      const allowed =
        transfer &&
        (event === 'cancelled'
          ? ctx.isOwner && transfer.fromMembershipId === ctx.membershipId
          : transfer.toMembershipId === ctx.membershipId);
      if (!transfer || !allowed) throw new NotFoundError('Ownership transfer not found.');
      if (!(OPEN_TRANSFER_STATUSES as readonly string[]).includes(transfer.status)) {
        throw new ConflictError(
          'INVALID_STATE_TRANSITION',
          `This transfer is ${transfer.status} and cannot be ${event}.`,
        );
      }
      const closed = await updateOwnershipTransfer(tx, ctx.organizationId, transfer.id, {
        status: 'cancelled',
        cancelledAt: this.now,
        cancelledByUserId: ctx.userId,
        cancelReason: reason,
      });
      await this.audit(tx, ctx, closed ?? transfer, event, origin, { reason });
      const [view] = await this.view(tx, ctx.organizationId, [closed ?? transfer]);
      return view!;
    });
  }
}
