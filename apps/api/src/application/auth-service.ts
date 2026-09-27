import {
  AppError,
  ConflictError,
  NotFoundError,
  TooManyAttemptsError,
  ValidationError,
} from '../domain/errors.js';
import { getEffectiveAccess } from '../modules/access-control/index.js';
import {
  countRecentLoginFailures,
  recordSecurityEvent,
  SecurityEventTypes,
  type EventOrigin,
  type FailureWindow,
} from '../modules/audit/index.js';
import {
  consumePasswordResetToken,
  createSession,
  createUser,
  evaluateSession,
  findSessionByToken,
  findUserByEmail,
  findUserById,
  invalidateOutstandingResetTokens,
  issuePasswordResetToken,
  listActiveSessions,
  markSessionReauthenticated,
  revokeAllUserSessions,
  revokeSession,
  setSessionActiveOrganization,
  setUserDisabled,
  toUserProfile,
  touchSession,
  updateUserPassword,
  type IssuedSession,
  type SessionPolicy,
  type UserProfile,
} from '../modules/identity/index.js';
import { findMembership, listUserOrganizations } from '../modules/organizations/index.js';
import { enqueueOutboxEvent } from '../modules/outbox/index.js';
import { normalizeEmail } from '../shared/email.js';
import { requireRecentAuthentication, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { createOrganizationWithOwner } from './organization-provisioning.js';
import { inTransaction, setDbContext } from './unit-of-work.js';

export class InvalidCredentialsError extends AppError {
  constructor(status = 401) {
    super('INVALID_CREDENTIALS', status, 'The email or password is incorrect.');
  }
}

export class InvalidResetTokenError extends AppError {
  constructor() {
    super('INVALID_TOKEN', 400, 'This password reset link is invalid or has expired.');
  }
}

export interface SessionView {
  user: UserProfile;
  session: {
    id: string;
    createdAt: string;
    expiresAt: string;
    idleExpiresAt: string;
    reauthenticatedAt: string;
    reauthenticationValidUntil: string;
  };
  organizations: { id: string; name: string; membershipId: string }[];
  activeOrganization: {
    id: string;
    name: string;
    membershipId: string;
    isOwner: boolean;
    permissions: string[];
  } | null;
}

/**
 * Authentication and session workflows: registration, sign-in with progressive
 * login protection, sessions, sensitive-action re-authentication, password reset,
 * organization switching and account disablement.
 */
export class AuthService {
  constructor(private readonly deps: AppDependencies) {}

  private get policy(): SessionPolicy {
    return {
      idleTimeoutMs: this.deps.config.session.idleTimeoutMs,
      absoluteLifetimeMs: this.deps.config.session.absoluteLifetimeMs,
    };
  }

  assertPasswordPolicy(password: string, path = 'password'): void {
    const { minLength, maxLength } = this.deps.config.password;
    if (password.length < minLength) {
      throw new ValidationError([
        { path, message: `Password must be at least ${minLength} characters.` },
      ]);
    }
    if (password.length > maxLength) {
      throw new ValidationError([
        { path, message: `Password must be at most ${maxLength} characters.` },
      ]);
    }
  }

  async register(
    input: { email: string; password: string; displayName: string; organizationName: string },
    origin: EventOrigin,
  ): Promise<{ issued: IssuedSession; userId: string; organizationId: string }> {
    this.assertPasswordPolicy(input.password);
    const passwordHash = await this.deps.passwordHasher.hash(input.password);
    const now = this.deps.clock.now();

    return inTransaction(this.deps.db, {}, async (tx) => {
      const user = await createUser(tx, {
        email: input.email,
        displayName: input.displayName,
        passwordHash,
        now,
      });
      if (!user) {
        throw new ConflictError('EMAIL_UNAVAILABLE', 'An account with this email already exists.');
      }
      const { organization } = await createOrganizationWithOwner(tx, {
        name: input.organizationName,
        ownerUserId: user.id,
        now,
        origin,
      });
      const issued = await createSession(tx, {
        userId: user.id,
        activeOrganizationId: organization.id,
        now,
        policy: this.policy,
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.UserRegistered,
        userId: user.id,
        organizationId: organization.id,
        metadata: { via: 'registration', sessionId: issued.session.id },
        origin,
      });
      await enqueueOutboxEvent(
        tx,
        {
          eventType: 'identity.user_registered',
          aggregateType: 'user',
          aggregateId: user.id,
          organizationId: organization.id,
          payload: { userId: user.id, organizationId: organization.id },
        },
        now,
      );
      return { issued, userId: user.id, organizationId: organization.id };
    });
  }

  /** Remaining back-off for one failure window (0 = not throttled). */
  private backoffRemainingMs(window: FailureWindow, now: Date): number {
    const { maxFailedAttempts, backoffBaseMs, backoffMaxMs } = this.deps.config.loginProtection;
    if (window.count < maxFailedAttempts || !window.lastAt) return 0;
    const excess = window.count - maxFailedAttempts;
    const delay = Math.min(backoffBaseMs * 2 ** Math.min(excess, 30), backoffMaxMs);
    return Math.max(0, window.lastAt.getTime() + delay - now.getTime());
  }

  /**
   * Login protection: failures are counted per account and per IP within the window.
   * Past the threshold, each further attempt waits a doubling back-off (capped).
   * There is no permanent lockout; failures age out of the window.
   */
  private async enforceLoginProtection(emailNormalized: string, origin: EventOrigin, now: Date) {
    const since = new Date(now.getTime() - this.deps.config.loginProtection.windowMs);
    const retryAfterMs = await inTransaction(this.deps.db, {}, async (tx) => {
      const windows = await countRecentLoginFailures(tx, {
        emailNormalized,
        ipAddress: origin.ipAddress,
        since,
      });
      const remaining = Math.max(
        this.backoffRemainingMs(windows.byAccount, now),
        this.backoffRemainingMs(windows.byIp, now),
      );
      if (remaining > 0) {
        await recordSecurityEvent(tx, {
          occurredAt: now,
          eventType: SecurityEventTypes.LoginThrottled,
          userId: null,
          emailNormalized,
          metadata: {
            accountFailures: windows.byAccount.count,
            ipFailures: windows.byIp.count,
            retryAfterSeconds: Math.ceil(remaining / 1000),
          },
          origin,
        });
      }
      return remaining;
    });
    if (retryAfterMs > 0) throw new TooManyAttemptsError(Math.ceil(retryAfterMs / 1000));
  }

  private async recordCredentialFailure(input: {
    eventType: string;
    userId: string | null;
    emailNormalized: string;
    reason: string;
    origin: EventOrigin;
    now: Date;
  }): Promise<void> {
    await inTransaction(this.deps.db, {}, (tx) =>
      recordSecurityEvent(tx, {
        occurredAt: input.now,
        eventType: input.eventType,
        userId: input.userId,
        emailNormalized: input.emailNormalized,
        metadata: { reason: input.reason },
        origin: input.origin,
      }),
    );
  }

  async login(
    input: { email: string; password: string },
    origin: EventOrigin,
  ): Promise<{ issued: IssuedSession; userId: string }> {
    const now = this.deps.clock.now();
    const emailNormalized = normalizeEmail(input.email);
    await this.enforceLoginProtection(emailNormalized, origin, now);

    const user = await inTransaction(this.deps.db, {}, (tx) => findUserByEmail(tx, input.email));
    let valid = false;
    if (user) {
      valid = await this.deps.passwordHasher.verify(user.passwordHash, input.password);
    } else {
      await this.deps.passwordHasher.verifyDummy(input.password);
    }
    if (!user || !valid || user.status !== 'active') {
      await this.recordCredentialFailure({
        eventType: SecurityEventTypes.LoginFailed,
        userId: user?.id ?? null,
        emailNormalized,
        reason: !user ? 'unknown_account' : !valid ? 'invalid_password' : 'account_disabled',
        origin,
        now,
      });
      throw new InvalidCredentialsError();
    }

    const issued = await inTransaction(this.deps.db, { userId: user.id }, async (tx) => {
      const organizations = await listUserOrganizations(tx, user.id);
      const session = await createSession(tx, {
        userId: user.id,
        activeOrganizationId: organizations[0]?.organizationId ?? null,
        now,
        policy: this.policy,
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.LoginSucceeded,
        userId: user.id,
        metadata: { sessionId: session.session.id },
        origin,
      });
      return session;
    });
    return { issued, userId: user.id };
  }

  /** Validates an opaque session token. Returns null for any unusable session. */
  async authenticate(token: string, origin: EventOrigin): Promise<Principal | null> {
    const now = this.deps.clock.now();
    return inTransaction(this.deps.db, {}, async (tx) => {
      const found = await findSessionByToken(tx, token);
      if (!found) return null;
      const state = evaluateSession(found.session, found.user, now, this.policy);
      if (state !== 'valid') {
        if (state === 'expired' || state === 'idle_timeout') {
          const revoked = await revokeSession(tx, {
            sessionId: found.session.id,
            userId: found.user.id,
            reason: 'expired',
            now,
          });
          if (revoked) {
            await recordSecurityEvent(tx, {
              occurredAt: now,
              eventType: SecurityEventTypes.SessionExpired,
              userId: found.user.id,
              metadata: { sessionId: found.session.id, cause: state },
              origin,
            });
          }
        }
        return null;
      }
      await touchSession(tx, found.session.id, now);
      return { user: found.user, session: { ...found.session, lastSeenAt: now } };
    });
  }

  async getSessionView(principal: Principal): Promise<SessionView> {
    const { session, user } = principal;
    const reauthWindow = this.deps.config.session.reauthWindowMs;
    return inTransaction(this.deps.db, { userId: user.id }, async (tx) => {
      const organizations = await listUserOrganizations(tx, user.id);
      let activeOrganization: SessionView['activeOrganization'] = null;
      const active = organizations.find((o) => o.organizationId === session.activeOrganizationId);
      if (active) {
        await setDbContext(tx, { userId: user.id, organizationId: active.organizationId });
        const access = await getEffectiveAccess(tx, active.organizationId, active.membershipId);
        activeOrganization = {
          id: active.organizationId,
          name: active.organizationName,
          membershipId: active.membershipId,
          isOwner: access.isOwner,
          permissions: [...access.permissions].sort(),
        };
      }
      const idleExpiry = Math.min(
        session.lastSeenAt.getTime() + this.deps.config.session.idleTimeoutMs,
        session.expiresAt.getTime(),
      );
      return {
        user: toUserProfile(user),
        session: {
          id: session.id,
          createdAt: session.createdAt.toISOString(),
          expiresAt: session.expiresAt.toISOString(),
          idleExpiresAt: new Date(idleExpiry).toISOString(),
          reauthenticatedAt: session.reauthenticatedAt.toISOString(),
          reauthenticationValidUntil: new Date(
            session.reauthenticatedAt.getTime() + reauthWindow,
          ).toISOString(),
        },
        organizations: organizations.map((o) => ({
          id: o.organizationId,
          name: o.organizationName,
          membershipId: o.membershipId,
        })),
        activeOrganization,
      };
    });
  }

  async logout(principal: Principal, origin: EventOrigin): Promise<void> {
    const now = this.deps.clock.now();
    await inTransaction(this.deps.db, { userId: principal.user.id }, async (tx) => {
      await revokeSession(tx, {
        sessionId: principal.session.id,
        userId: principal.user.id,
        reason: 'logout',
        now,
      });
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.Logout,
        userId: principal.user.id,
        metadata: { sessionId: principal.session.id },
        origin,
      });
    });
  }

  /** Confirms the password to open the sensitive-action window. Subject to login protection. */
  async reauthenticate(principal: Principal, password: string, origin: EventOrigin): Promise<Date> {
    const now = this.deps.clock.now();
    const emailNormalized = principal.user.emailNormalized;
    await this.enforceLoginProtection(emailNormalized, origin, now);
    const valid = await this.deps.passwordHasher.verify(principal.user.passwordHash, password);
    if (!valid) {
      await this.recordCredentialFailure({
        eventType: SecurityEventTypes.LoginFailed,
        userId: principal.user.id,
        emailNormalized,
        reason: 'reauthentication_failed',
        origin,
        now,
      });
      throw new InvalidCredentialsError(403);
    }
    await inTransaction(this.deps.db, { userId: principal.user.id }, async (tx) => {
      await markSessionReauthenticated(tx, principal.session.id, now);
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.Reauthenticated,
        userId: principal.user.id,
        metadata: { sessionId: principal.session.id },
        origin,
      });
    });
    return now;
  }

  async listSessions(principal: Principal) {
    const now = this.deps.clock.now();
    const sessions = await inTransaction(this.deps.db, { userId: principal.user.id }, (tx) =>
      listActiveSessions(tx, principal.user.id, now),
    );
    return sessions.map((s) => ({
      id: s.id,
      current: s.id === principal.session.id,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
    }));
  }

  /** Revokes another of the caller's own sessions (sensitive; immediately effective). */
  async revokeOtherSession(
    principal: Principal,
    sessionId: string,
    origin: EventOrigin,
  ): Promise<void> {
    const now = this.deps.clock.now();
    requireRecentAuthentication(principal, now, this.deps.config.session.reauthWindowMs);
    await inTransaction(this.deps.db, { userId: principal.user.id }, async (tx) => {
      const revoked = await revokeSession(tx, {
        sessionId,
        userId: principal.user.id,
        reason: 'user_revoked',
        now,
      });
      if (!revoked) throw new NotFoundError('Session not found.');
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.SessionRevoked,
        userId: principal.user.id,
        metadata: { sessionId, revokedBySessionId: principal.session.id },
        origin,
      });
    });
  }

  /** Always resolves the same way whether or not the account exists (no enumeration). */
  async requestPasswordReset(email: string, origin: EventOrigin): Promise<void> {
    const now = this.deps.clock.now();
    const emailNormalized = normalizeEmail(email);
    const issued = await inTransaction(this.deps.db, {}, async (tx) => {
      const user = await findUserByEmail(tx, email);
      const eligible = user?.status === 'active';
      const token = eligible
        ? await issuePasswordResetToken(tx, {
            userId: user.id,
            now,
            ttlMs: this.deps.config.password.resetTokenTtlMs,
            requestedIp: origin.ipAddress,
          })
        : null;
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.PasswordResetRequested,
        userId: user?.id ?? null,
        emailNormalized,
        metadata: { tokenIssued: eligible },
        origin,
      });
      return user && token ? { to: user.email, displayName: user.displayName, token } : null;
    });

    if (issued) {
      const link = `${this.deps.config.webOrigin}/reset-password#token=${issued.token}`;
      const minutes = Math.round(this.deps.config.password.resetTokenTtlMs / 60_000);
      await this.sendEmailSafely({
        to: issued.to,
        template: 'password_reset',
        subject: 'Reset your Intuit 2.0 password',
        text:
          `Hello ${issued.displayName},\n\nUse this link to choose a new password ` +
          `(valid for ${minutes} minutes, single use):\n${link}\n\n` +
          'If you did not request this, you can ignore this email.',
      });
    }
  }

  /** Completes a reset: single-use token, new password, all sessions revoked. */
  async completePasswordReset(
    input: { token: string; newPassword: string },
    origin: EventOrigin,
  ): Promise<void> {
    this.assertPasswordPolicy(input.newPassword, 'newPassword');
    const passwordHash = await this.deps.passwordHasher.hash(input.newPassword);
    const now = this.deps.clock.now();
    const completed = await inTransaction(this.deps.db, {}, async (tx) => {
      const userId = await consumePasswordResetToken(tx, input.token, now);
      const user = userId ? await findUserById(tx, userId) : undefined;
      if (!user || user.status !== 'active') return false;
      await updateUserPassword(tx, user.id, passwordHash, now);
      await invalidateOutstandingResetTokens(tx, user.id, now);
      const sessionsRevoked = await revokeAllUserSessions(tx, {
        userId: user.id,
        reason: 'password_reset',
        now,
      });
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.PasswordResetCompleted,
        userId: user.id,
        metadata: { sessionsRevoked },
        origin,
      });
      await enqueueOutboxEvent(
        tx,
        {
          eventType: 'identity.password_changed',
          aggregateType: 'user',
          aggregateId: user.id,
          organizationId: null,
          payload: { userId: user.id, via: 'password_reset' },
        },
        now,
      );
      return true;
    });
    if (!completed) {
      await inTransaction(this.deps.db, {}, (tx) =>
        recordSecurityEvent(tx, {
          occurredAt: now,
          eventType: SecurityEventTypes.PasswordResetFailed,
          userId: null,
          metadata: { reason: 'invalid_or_expired_token' },
          origin,
        }),
      );
      throw new InvalidResetTokenError();
    }
  }

  /** Switches the session's active organization after verifying an active membership. */
  async switchOrganization(
    principal: Principal,
    organizationId: string,
    origin: EventOrigin,
  ): Promise<void> {
    const now = this.deps.clock.now();
    await inTransaction(this.deps.db, { userId: principal.user.id, organizationId }, async (tx) => {
      const membership = await findMembership(tx, organizationId, principal.user.id);
      if (!membership || membership.status !== 'active') {
        // Same response whether the organization does not exist or the user is not a member.
        throw new NotFoundError('Organization not found.');
      }
      await setSessionActiveOrganization(tx, principal.session.id, organizationId);
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.OrganizationSwitched,
        userId: principal.user.id,
        organizationId,
        metadata: {
          sessionId: principal.session.id,
          fromOrganizationId: principal.session.activeOrganizationId,
        },
        origin,
      });
    });
  }

  /**
   * Account disablement: blocks sign-in and revokes every session immediately.
   * Exposed as a service for platform administration (no public endpoint in Phase 1).
   */
  async disableAccount(
    input: { userId: string; actorUserId: string | null; reason: string },
    origin: EventOrigin,
  ): Promise<boolean> {
    const now = this.deps.clock.now();
    return inTransaction(this.deps.db, {}, async (tx) => {
      const disabled = await setUserDisabled(tx, input.userId, now);
      if (!disabled) return false;
      const sessionsRevoked = await revokeAllUserSessions(tx, {
        userId: input.userId,
        reason: 'account_disabled',
        now,
      });
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.AccountDisabled,
        userId: input.userId,
        metadata: { actorUserId: input.actorUserId, reason: input.reason, sessionsRevoked },
        origin,
      });
      return true;
    });
  }

  /** Email failures must never change the response or leak message contents to logs. */
  async sendEmailSafely(message: Parameters<AppDependencies['emailProvider']['send']>[0]) {
    try {
      await this.deps.emailProvider.send(message);
    } catch (error) {
      this.deps.logger.error(
        { template: message.template, err: error instanceof Error ? error.name : 'unknown' },
        'Email delivery failed',
      );
    }
  }
}
