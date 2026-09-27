import {
  AppError,
  ConflictError,
  NotFoundError,
  ProtectedResourceError,
  ValidationError,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { getRole, replaceMembershipRoles, type Role } from '../modules/access-control/index.js';
import {
  recordAuditEvent,
  recordSecurityEvent,
  SecurityEventTypes,
  type EventOrigin,
} from '../modules/audit/index.js';
import {
  createSession,
  createUser,
  findUserByEmail,
  getUserProfiles,
  setSessionActiveOrganization,
  type IssuedSession,
  type User,
} from '../modules/identity/index.js';
import {
  createInvitation,
  createMembership,
  effectiveInvitationStatus,
  findInvitationById,
  findMembership,
  getOrganization,
  listInvitations,
  markInvitationAccepted,
  OrganizationPermissions,
  resolveInvitationToken,
  revokeInvitation,
  type Invitation,
} from '../modules/organizations/index.js';
import { enqueueOutboxEvent } from '../modules/outbox/index.js';
import { normalizeEmail } from '../shared/email.js';
import type { AuthService } from './auth-service.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';
import { inTransaction, setDbContext } from './unit-of-work.js';

export class InvalidInvitationError extends AppError {
  constructor() {
    super('INVALID_TOKEN', 404, 'This invitation link is invalid.');
  }
}

function invitationView(invitation: Invitation, now: Date, roleName?: string) {
  return {
    id: invitation.id,
    email: invitation.email,
    roleId: invitation.roleId,
    ...(roleName === undefined ? {} : { roleName }),
    status: effectiveInvitationStatus(invitation, now),
    invitedByUserId: invitation.invitedByUserId,
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
    acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
    revokedAt: invitation.revokedAt?.toISOString() ?? null,
  };
}

/** Invitation-based joining: create, list, revoke, look up and accept invitations. */
export class InvitationService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly auth: AuthService,
  ) {}

  async createInvitation(
    principal: Principal,
    input: { email: string; roleId: string },
    origin: EventOrigin,
  ) {
    const now = this.deps.clock.now();
    const result = await withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersInvite },
      async (tx, ctx) => {
        const role = await getRole(tx, ctx.organizationId, input.roleId);
        if (!role) {
          throw new ValidationError([{ path: 'roleId', message: 'The role does not exist.' }]);
        }
        if (role.isOwner) {
          throw new ProtectedResourceError(
            'The Owner role cannot be granted by invitation; use the ownership-transfer workflow.',
          );
        }
        const existingUser = await findUserByEmail(tx, input.email);
        if (existingUser) {
          const membership = await findMembership(tx, ctx.organizationId, existingUser.id);
          if (membership) {
            throw new ConflictError(
              'ALREADY_MEMBER',
              'This person is already a member of the organization.',
            );
          }
        }
        const issued = await createInvitation(tx, {
          organizationId: ctx.organizationId,
          email: input.email,
          roleId: role.id,
          invitedByUserId: ctx.userId,
          now,
          expiryMs: this.deps.config.invitations.expiryMs,
        });
        if (!issued) {
          throw new ConflictError(
            'CONFLICT',
            'A pending invitation already exists for this email.',
          );
        }
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'invitation.created',
          resourceType: 'invitation',
          resourceId: issued.invitation.id,
          metadata: {
            email: issued.invitation.email,
            roleId: role.id,
            roleName: role.name,
            expiresAt: issued.invitation.expiresAt.toISOString(),
          },
          origin,
        });
        await enqueueOutboxEvent(
          tx,
          {
            eventType: 'organizations.invitation_created',
            aggregateType: 'invitation',
            aggregateId: issued.invitation.id,
            organizationId: ctx.organizationId,
            payload: { invitationId: issued.invitation.id, roleId: role.id },
          },
          now,
        );
        const organization = await getOrganization(tx, ctx.organizationId);
        return { issued, role, organizationName: organization?.name ?? 'an organization' };
      },
    );

    // Sent only after commit, so a delivered link always refers to a persisted invitation.
    const hours = Math.round(this.deps.config.invitations.expiryMs / 3_600_000);
    const link = `${this.deps.config.webOrigin}/invitations/accept#token=${result.issued.token}`;
    await this.auth.sendEmailSafely({
      to: result.issued.invitation.email,
      template: 'organization_invitation',
      subject: `You have been invited to ${result.organizationName} on Intuit 2.0`,
      text:
        `${principal.user.displayName} invited you to join ${result.organizationName} ` +
        `as ${result.role.name}.\n\nAccept the invitation (valid for ${hours} hours):\n${link}`,
    });
    return invitationView(result.issued.invitation, now, result.role.name);
  }

  listInvitations(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersInvite },
      async (tx, ctx) => {
        const now = this.deps.clock.now();
        const rows = await listInvitations(tx, ctx.organizationId);
        return rows.map((row) => invitationView(row, now));
      },
    );
  }

  revokeInvitation(principal: Principal, invitationId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.MembersInvite },
      async (tx, ctx) => {
        const now = this.deps.clock.now();
        const invitation = await findInvitationById(tx, ctx.organizationId, invitationId);
        if (!invitation) throw new NotFoundError('Invitation not found.');
        if (effectiveInvitationStatus(invitation, now) !== 'pending') {
          throw new ConflictError(
            'INVITATION_NOT_PENDING',
            'Only pending invitations can be revoked.',
          );
        }
        await revokeInvitation(tx, {
          organizationId: ctx.organizationId,
          invitationId,
          userId: ctx.userId,
          now,
        });
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'invitation.revoked',
          resourceType: 'invitation',
          resourceId: invitationId,
          metadata: { email: invitation.email },
          origin,
        });
      },
    );
  }

  /** Loads an invitation by token under its own organization's RLS context. */
  private async loadByToken(tx: Transaction, token: string, userId: string | null) {
    const resolved = await resolveInvitationToken(tx, token);
    if (!resolved) throw new InvalidInvitationError();
    await setDbContext(tx, { userId, organizationId: resolved.organizationId });
    const invitation = await findInvitationById(tx, resolved.organizationId, resolved.invitationId);
    const organization = await getOrganization(tx, resolved.organizationId);
    if (!invitation || !organization) throw new InvalidInvitationError();
    return { invitation, organization };
  }

  /** Public preview for the acceptance page. The caller already holds the token. */
  async lookup(token: string) {
    const now = this.deps.clock.now();
    return inTransaction(this.deps.db, {}, async (tx) => {
      const { invitation, organization } = await this.loadByToken(tx, token, null);
      const role = await getRole(tx, organization.id, invitation.roleId);
      const accountExists = (await findUserByEmail(tx, invitation.email)) !== undefined;
      const inviter = (await getUserProfiles(tx, [invitation.invitedByUserId])).get(
        invitation.invitedByUserId,
      );
      return {
        organizationName: organization.name,
        email: invitation.email,
        roleName: role?.name ?? null,
        invitedBy: inviter?.displayName ?? null,
        status: effectiveInvitationStatus(invitation, now),
        expiresAt: invitation.expiresAt.toISOString(),
        accountExists,
      };
    });
  }

  private assertAcceptable(invitation: Invitation, now: Date) {
    const status = effectiveInvitationStatus(invitation, now);
    if (status === 'expired') {
      throw new AppError('INVITATION_EXPIRED', 410, 'This invitation has expired.');
    }
    if (status !== 'pending') {
      throw new ConflictError('INVITATION_NOT_PENDING', 'This invitation is no longer valid.');
    }
  }

  private async join(
    tx: Transaction,
    input: {
      invitation: Invitation;
      user: User;
      now: Date;
      origin: EventOrigin;
      newAccount: boolean;
    },
  ) {
    const { invitation, user, now, origin } = input;
    const organizationId = invitation.organizationId;
    const existing = await findMembership(tx, organizationId, user.id);
    if (existing) {
      throw new ConflictError('ALREADY_MEMBER', 'You are already a member of this organization.');
    }
    const role: Role | undefined = await getRole(tx, organizationId, invitation.roleId);
    if (!role || role.isOwner) throw new InvalidInvitationError();
    const membership = await createMembership(tx, { organizationId, userId: user.id });
    if (!membership) {
      throw new ConflictError('ALREADY_MEMBER', 'You are already a member of this organization.');
    }
    await replaceMembershipRoles(tx, {
      organizationId,
      membershipId: membership.id,
      roles: [role],
      assignedByUserId: invitation.invitedByUserId,
    });
    const accepted = await markInvitationAccepted(tx, {
      organizationId,
      invitationId: invitation.id,
      userId: user.id,
      now,
    });
    if (!accepted)
      throw new ConflictError('INVITATION_NOT_PENDING', 'This invitation is no longer valid.');

    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId,
      actorUserId: user.id,
      action: 'invitation.accepted',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { email: invitation.email, newAccount: input.newAccount },
      origin,
    });
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId,
      actorUserId: user.id,
      action: 'membership.created',
      resourceType: 'membership',
      resourceId: membership.id,
      metadata: {
        userId: user.id,
        roles: [role.name],
        via: 'invitation',
        invitationId: invitation.id,
        invitedByUserId: invitation.invitedByUserId,
      },
      origin,
    });
    await enqueueOutboxEvent(
      tx,
      {
        eventType: 'organizations.member_joined',
        aggregateType: 'membership',
        aggregateId: membership.id,
        organizationId,
        payload: { membershipId: membership.id, userId: user.id, invitationId: invitation.id },
      },
      now,
    );
    return membership;
  }

  /**
   * Accepts an invitation.
   * - Signed in: the account email must match the invited email.
   * - Signed out, new email: creates the account (display name + password required) and signs in.
   * - Signed out, existing account: the person must sign in first.
   */
  async accept(
    input: { token: string; displayName?: string | undefined; password?: string | undefined },
    principal: Principal | null,
    origin: EventOrigin,
  ): Promise<{ organizationId: string; issued: IssuedSession | null }> {
    const now = this.deps.clock.now();

    if (principal) {
      return inTransaction(this.deps.db, { userId: principal.user.id }, async (tx) => {
        const { invitation } = await this.loadByToken(tx, input.token, principal.user.id);
        this.assertAcceptable(invitation, now);
        if (invitation.emailNormalized !== principal.user.emailNormalized) {
          throw new AppError(
            'INVITATION_EMAIL_MISMATCH',
            403,
            'This invitation was sent to a different email address.',
          );
        }
        await this.join(tx, { invitation, user: principal.user, now, origin, newAccount: false });
        await setSessionActiveOrganization(tx, principal.session.id, invitation.organizationId);
        return { organizationId: invitation.organizationId, issued: null };
      });
    }

    // Validate the invitation before doing any expensive password hashing.
    const preview = await inTransaction(this.deps.db, {}, async (tx) => {
      const { invitation } = await this.loadByToken(tx, input.token, null);
      this.assertAcceptable(invitation, now);
      if (await findUserByEmail(tx, invitation.email)) {
        throw new ConflictError('LOGIN_REQUIRED', 'Sign in with the invited account to accept.');
      }
      return invitation;
    });
    if (!input.displayName || !input.password) {
      throw new ValidationError([
        ...(input.displayName ? [] : [{ path: 'displayName', message: 'Name is required.' }]),
        ...(input.password ? [] : [{ path: 'password', message: 'Password is required.' }]),
      ]);
    }
    this.auth.assertPasswordPolicy(input.password);
    const passwordHash = await this.deps.passwordHasher.hash(input.password);
    const displayName = input.displayName;

    return inTransaction(this.deps.db, {}, async (tx) => {
      const { invitation } = await this.loadByToken(tx, input.token, null);
      this.assertAcceptable(invitation, now);
      const user = await createUser(tx, {
        email: preview.email,
        displayName,
        passwordHash,
        now,
      });
      if (!user)
        throw new ConflictError('LOGIN_REQUIRED', 'Sign in with the invited account to accept.');
      await setDbContext(tx, { userId: user.id, organizationId: invitation.organizationId });
      await this.join(tx, { invitation, user, now, origin, newAccount: true });
      const issued = await createSession(tx, {
        userId: user.id,
        activeOrganizationId: invitation.organizationId,
        now,
        policy: {
          idleTimeoutMs: this.deps.config.session.idleTimeoutMs,
          absoluteLifetimeMs: this.deps.config.session.absoluteLifetimeMs,
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.UserRegistered,
        userId: user.id,
        organizationId: invitation.organizationId,
        emailNormalized: normalizeEmail(user.email),
        metadata: { via: 'invitation', invitationId: invitation.id, sessionId: issued.session.id },
        origin,
      });
      return { organizationId: invitation.organizationId, issued };
    });
  }
}
