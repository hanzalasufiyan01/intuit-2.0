import { sql } from 'drizzle-orm';
import { ConflictError, NotFoundError, ProtectedResourceError } from '../domain/errors.js';
import { getEffectiveAccess } from '../modules/access-control/index.js';
import {
  recordAuditEvent,
  recordSecurityEvent,
  SecurityEventTypes,
  type EventOrigin,
} from '../modules/audit/index.js';
import { getUserProfiles } from '../modules/identity/index.js';
import {
  findMembershipById,
  getSecurityPolicy,
  OrganizationPermissions,
  saveSecurityPolicy,
} from '../modules/organizations/index.js';
import type { AuthService } from './auth-service.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { memberMfaStatus } from './mfa-policy.js';
import { withOrganization } from './organization-service.js';

const RESET_REFUSALS: Record<string, string> = {
  owner: "An Owner's two-step verification cannot be reset. Owners recover with recovery codes.",
  self: 'You cannot reset your own two-step verification here. Use Account security.',
  other_organization:
    'This person also belongs to another organization, so their two-step verification cannot ' +
    'be reset here. They can sign in with a recovery code and set up a new authenticator.',
  not_found: 'Member not found.',
  context: 'This action is not available.',
};

/** Finds the definer function's refusal reason in a (possibly wrapped) database error. */
function resetRefusal(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const message = (current as { message?: unknown }).message;
    const match = typeof message === 'string' ? /MFA_RESET_REFUSED:(\w+)/.exec(message) : null;
    if (match?.[1]) return match[1];
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Organization security (S7-29, S7-36 to S7-39): the MFA policy, member MFA status for
 * administrators, and the admin MFA reset. All need `members.manage` (Decision 65); changes also
 * need re-authentication and step-up (S7-33).
 */
export class OrganizationSecurityService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly auth: AuthService,
  ) {}

  getPolicy(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersManage },
      async (tx, ctx) => {
        const policy = await getSecurityPolicy(tx, ctx.organizationId);
        const status = await memberMfaStatus(tx, ctx.organizationId);
        const active = [...status.values()].filter((m) => m.active);
        return {
          requireMfaForAllMembers: policy.requireMfaForAllMembers,
          allowTrustedDevices: policy.allowTrustedDevices,
          version: policy.version,
          updatedAt: policy.updatedAt?.toISOString() ?? null,
          members: {
            total: active.length,
            enrolled: active.filter((m) => m.enrolled).length,
            requiredNotEnrolled: active.filter((m) => m.required && !m.enrolled).length,
          },
        };
      },
    );
  }

  updatePolicy(
    principal: Principal,
    input: { requireMfaForAllMembers: boolean; allowTrustedDevices: boolean; version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersManage, stepUp: true },
      async (tx, ctx) => {
        const before = await getSecurityPolicy(tx, ctx.organizationId);
        const now = this.deps.clock.now();
        const saved = await saveSecurityPolicy(tx, {
          organizationId: ctx.organizationId,
          expectedVersion: input.version,
          requireMfaForAllMembers: input.requireMfaForAllMembers,
          allowTrustedDevices: input.allowTrustedDevices,
          userId: ctx.userId,
          now,
        });
        if (!saved) {
          throw new ConflictError(
            'VERSION_CONFLICT',
            'The security settings were changed by someone else. Reload and try again.',
          );
        }
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'organization.security_policy_updated',
          resourceType: 'organization',
          resourceId: ctx.organizationId,
          metadata: {
            from: {
              requireMfaForAllMembers: before.requireMfaForAllMembers,
              allowTrustedDevices: before.allowTrustedDevices,
            },
            to: {
              requireMfaForAllMembers: saved.requireMfaForAllMembers,
              allowTrustedDevices: saved.allowTrustedDevices,
            },
            version: saved.version,
          },
          origin,
        });
        return {
          requireMfaForAllMembers: saved.requireMfaForAllMembers,
          allowTrustedDevices: saved.allowTrustedDevices,
          version: saved.version,
          updatedAt: saved.updatedAt?.toISOString() ?? null,
        };
      },
    );
  }

  /**
   * Admin MFA reset (Decision 72 as refined by S7-37; S7-38). Refused for the Owner, for
   * oneself, and for anyone who is an Owner anywhere or belongs to another organization.
   * Revokes the member's factors, unused recovery codes, remembered devices and sessions.
   */
  async resetMemberMfa(principal: Principal, membershipId: string, origin: EventOrigin) {
    const result = await withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersManage, stepUp: true },
      async (tx, ctx) => {
        const membership = await findMembershipById(tx, ctx.organizationId, membershipId);
        if (!membership) throw new NotFoundError('Member not found.');
        if (membership.userId === ctx.userId)
          throw new ProtectedResourceError(RESET_REFUSALS.self!);
        const access = await getEffectiveAccess(tx, ctx.organizationId, membership.id);
        if (access.isOwner) throw new ProtectedResourceError(RESET_REFUSALS.owner!);

        const now = this.deps.clock.now();
        let row: {
          target_user_id: string;
          factors_revoked: number;
          codes_revoked: number;
          devices_revoked: number;
          sessions_revoked: number;
        };
        try {
          const executed = await tx.execute<typeof row>(
            sql`SELECT * FROM app_reset_member_mfa(${membership.id}::uuid, ${now.toISOString()}::timestamptz)`,
          );
          row = executed.rows[0]!;
        } catch (error) {
          const reason = resetRefusal(error);
          if (!reason) throw error;
          if (reason === 'not_found') throw new NotFoundError(RESET_REFUSALS.not_found);
          throw new ProtectedResourceError(RESET_REFUSALS[reason] ?? RESET_REFUSALS.context!);
        }
        const counts = {
          factorsRevoked: row.factors_revoked,
          codesRevoked: row.codes_revoked,
          devicesRevoked: row.devices_revoked,
          sessionsRevoked: row.sessions_revoked,
        };
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'membership.mfa_reset',
          resourceType: 'membership',
          resourceId: membership.id,
          metadata: { userId: membership.userId, ...counts },
          origin,
        });
        await recordSecurityEvent(tx, {
          occurredAt: now,
          eventType: SecurityEventTypes.MfaResetByAdmin,
          userId: membership.userId,
          organizationId: ctx.organizationId,
          metadata: { actorUserId: ctx.userId, membershipId: membership.id, ...counts },
          origin,
        });
        const profile = (await getUserProfiles(tx, [membership.userId])).get(membership.userId);
        return { membershipId: membership.id, counts, profile };
      },
    );
    if (result.profile) {
      await this.auth.sendEmailSafely({
        to: result.profile.email,
        template: 'mfa_reset_by_admin',
        subject: 'Your Intuit 2.0 two-step verification was reset',
        text:
          `Hello ${result.profile.displayName},\n\nAn administrator of your organization reset ` +
          'your two-step verification and signed you out everywhere. Sign in with your password ' +
          'and set up a new authenticator app. If you did not expect this, contact your ' +
          'organization administrator.',
      });
    }
    return { membershipId: result.membershipId, ...result.counts };
  }
}
