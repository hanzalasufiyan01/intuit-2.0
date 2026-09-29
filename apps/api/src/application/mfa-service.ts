import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  InvalidMfaCodeError,
  NotFoundError,
  ProtectedResourceError,
  UnauthenticatedError,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { totpSecretAad } from '../infrastructure/security/mfa-keyring.js';
import { qrSvgDataUri } from '../infrastructure/security/qr.js';
import { hashToken } from '../infrastructure/security/tokens.js';
import { base32Encode, generateTotpSecret, otpauthUri } from '../infrastructure/security/totp.js';
import { getEffectiveAccess } from '../modules/access-control/index.js';
import {
  recordSecurityEvent,
  SecurityEventTypes,
  type EventOrigin,
} from '../modules/audit/index.js';
import {
  activateFactor,
  countUsableRecoveryCodes,
  getActiveTotpFactor,
  getPendingFactor,
  insertPendingTotpFactor,
  latestRecoveryCodeIssue,
  listActiveFactors,
  listActiveTrustedDevices,
  lockUserForMfa,
  recordFactorFailure,
  revokeFactors,
  revokeTrustedDevices,
  revokeUsableRecoveryCodes,
  satisfySessionMfa,
} from '../modules/identity/index.js';
import { getSecurityPolicy, listUserOrganizations } from '../modules/organizations/index.js';
import type { AuthService, MfaChallengeMethod } from './auth-service.js';
import { requireRecentAuthentication, requireRecentMfa, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { mfaRequirement, type MfaRequirementReason } from './mfa-policy.js';
import type { MfaVerifier, PreparedRecoveryCodes } from './mfa-verifier.js';
import { inTransaction, setDbContext } from './unit-of-work.js';

/** An organization in which MFA is required of the user, and why. */
export interface MfaRequiredOrganization {
  organizationId: string;
  name: string;
  reasons: MfaRequirementReason[];
}

/**
 * Self-service MFA (S7-12 to S7-22, S7-33 to S7-35): enrollment, step-up, recovery codes,
 * disabling and remembered devices. Secrets and codes are returned exactly once (at enrollment
 * or regeneration) and are never readable afterwards.
 */
export class MfaService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly auth: AuthService,
    private readonly verifier: MfaVerifier,
  ) {}

  private get now(): Date {
    return this.deps.clock.now();
  }

  /** Every organization of the user where MFA is required of them (S7-21, status view). */
  async requiredOrganizations(tx: Transaction, userId: string): Promise<MfaRequiredOrganization[]> {
    const required: MfaRequiredOrganization[] = [];
    for (const org of await listUserOrganizations(tx, userId)) {
      await setDbContext(tx, { userId, organizationId: org.organizationId });
      const access = await getEffectiveAccess(tx, org.organizationId, org.membershipId);
      const requirement = mfaRequirement(access, await getSecurityPolicy(tx, org.organizationId));
      if (requirement.required) {
        required.push({
          organizationId: org.organizationId,
          name: org.organizationName,
          reasons: requirement.reasons,
        });
      }
    }
    await setDbContext(tx, { userId });
    return required;
  }

  status(principal: Principal) {
    const userId = principal.user.id;
    return inTransaction(this.deps.db, { userId }, async (tx) => {
      const factors = await listActiveFactors(tx, userId);
      const requiredBy = await this.requiredOrganizations(tx, userId);
      return {
        factors: factors.map((f) => ({
          id: f.id,
          type: f.type,
          label: f.label,
          createdAt: f.createdAt.toISOString(),
          activatedAt: f.activatedAt?.toISOString() ?? null,
          lastUsedAt: f.lastUsedAt?.toISOString() ?? null,
        })),
        recoveryCodes: {
          remaining: factors.length > 0 ? await countUsableRecoveryCodes(tx, userId) : 0,
          issuedAt: (await latestRecoveryCodeIssue(tx, userId))?.toISOString() ?? null,
        },
        requiredBy,
        canDisable: factors.length > 0 && requiredBy.length === 0,
      };
    });
  }

  /**
   * Starts (or restarts) an authenticator setup (S7-12). Needs a recent password; replacing an
   * active authenticator also needs step-up. The secret is shown in this response only.
   */
  async startEnrollment(principal: Principal, origin: EventOrigin) {
    const now = this.now;
    const { user } = principal;
    requireRecentAuthentication(principal, now, this.deps.config.session.reauthWindowMs);
    const config = this.deps.config.mfa;
    return inTransaction(this.deps.db, { userId: user.id }, async (tx) => {
      await lockUserForMfa(tx, user.id);
      const current = await getActiveTotpFactor(tx, user.id);
      if (current) await requireRecentMfa(tx, principal, now, config.stepUpWindowMs);
      await revokeFactors(tx, { userId: user.id, status: 'pending', reason: 'superseded', now });

      const secret = generateTotpSecret();
      const factorId = randomUUID();
      const expiresAt = new Date(now.getTime() + config.enrollmentTtlMs);
      try {
        const sealed = config.keyRing.seal(secret, totpSecretAad(factorId, user.id));
        await insertPendingTotpFactor(tx, {
          id: factorId,
          userId: user.id,
          secretCiphertext: sealed.ciphertext,
          secretIv: sealed.iv,
          secretTag: sealed.tag,
          keyId: sealed.keyId,
          now,
          expiresAt,
        });
        await recordSecurityEvent(tx, {
          occurredAt: now,
          eventType: SecurityEventTypes.TotpEnrollmentStarted,
          userId: user.id,
          metadata: { factorId, replacing: current !== undefined },
          origin,
        });
        const encoded = base32Encode(secret);
        const uri = otpauthUri({ issuer: config.issuer, account: user.email, secret: encoded });
        return {
          enrollmentId: factorId,
          secret: encoded,
          otpauthUri: uri,
          qrCode: qrSvgDataUri(uri),
          issuer: config.issuer,
          account: user.email,
          expiresAt: expiresAt.toISOString(),
        };
      } finally {
        secret.fill(0);
      }
    });
  }

  /**
   * Confirms a pending authenticator with a code (S7-12). Activates it (replacing any previous
   * one), issues recovery codes when the user has none left, marks the session MFA-verified and
   * rotates the session token. Five wrong codes discard the pending setup.
   */
  async completeEnrollment(
    principal: Principal,
    input: { enrollmentId: string; code: string },
    origin: EventOrigin,
  ): Promise<{ recoveryCodes: string[] | null; sessionToken: string }> {
    const now = this.now;
    const { user, session } = principal;
    const needsCodes = await inTransaction(
      this.deps.db,
      { userId: user.id },
      async (tx) => (await countUsableRecoveryCodes(tx, user.id)) === 0,
    );
    const prepared: PreparedRecoveryCodes | null = needsCodes
      ? await this.verifier.prepareRecoveryCodes()
      : null;

    const outcome = await inTransaction(this.deps.db, { userId: user.id }, async (tx) => {
      await lockUserForMfa(tx, user.id);
      const pending = await getPendingFactor(tx, user.id, input.enrollmentId);
      if (!pending || !pending.pendingExpiresAt) {
        throw new NotFoundError('This setup was not found. Start again.');
      }
      if (pending.pendingExpiresAt.getTime() <= now.getTime()) {
        throw new ConflictError('INVALID_STATE_TRANSITION', 'This setup has expired. Start again.');
      }
      const step = this.verifier.matchStep(pending, input.code, now);
      if (step === null) {
        const failures = await recordFactorFailure(tx, pending.id);
        if (failures >= this.deps.config.mfa.challengeMaxAttempts) {
          await revokeFactors(tx, {
            userId: user.id,
            factorId: pending.id,
            reason: 'enrollment_failed',
            now,
          });
        }
        return { ok: false as const };
      }

      const previous = await getActiveTotpFactor(tx, user.id);
      if (previous) {
        await revokeFactors(tx, {
          userId: user.id,
          factorId: previous.id,
          reason: 'replaced',
          now,
        });
      }
      if (!(await activateFactor(tx, { factorId: pending.id, step, now }))) {
        throw new ConflictError('INVALID_STATE_TRANSITION', 'This setup has changed. Start again.');
      }
      let issued: string[] | null = null;
      if (prepared && (await countUsableRecoveryCodes(tx, user.id)) === 0) {
        await this.verifier.storeRecoveryCodes(tx, user.id, prepared, now);
        issued = prepared.display;
      }
      const devicesRevoked = previous
        ? await revokeTrustedDevices(tx, { userId: user.id, reason: 'mfa_replaced', now })
        : 0;
      const token = await satisfySessionMfa(tx, {
        sessionId: session.id,
        method: 'totp',
        factorVerified: true,
        now,
      });
      if (!token) throw new UnauthenticatedError();
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: previous ? SecurityEventTypes.TotpReplaced : SecurityEventTypes.TotpEnabled,
        userId: user.id,
        metadata: {
          factorId: pending.id,
          previousFactorId: previous?.id ?? null,
          sessionId: session.id,
          devicesRevoked,
        },
        origin,
      });
      if (issued) {
        await recordSecurityEvent(tx, {
          occurredAt: now,
          eventType: SecurityEventTypes.RecoveryCodesGenerated,
          userId: user.id,
          metadata: { count: issued.length, reason: 'enrollment' },
          origin,
        });
      }
      return { ok: true as const, token, issued, replaced: previous !== undefined };
    });
    if (!outcome.ok) throw new InvalidMfaCodeError();
    await this.auth.sendEmailSafely({
      to: user.email,
      template: outcome.replaced ? 'mfa_replaced' : 'mfa_enabled',
      subject: outcome.replaced
        ? 'Your Intuit 2.0 authenticator app was changed'
        : 'Two-step verification is now on for your Intuit 2.0 account',
      text:
        `Hello ${user.displayName},\n\n` +
        (outcome.replaced
          ? 'A new authenticator app was set up for your account and the previous one stopped working.'
          : 'Two-step verification was turned on for your account.') +
        ' If this was not you, reset your password and contact your organization administrator.',
    });
    return { recoveryCodes: outcome.issued, sessionToken: outcome.token };
  }

  /**
   * Step-up (S7-33): a fresh second factor in this session. It also satisfies MFA for an
   * organization that does not accept remembered devices (S7-36). Rotates the session token.
   */
  async stepUp(
    principal: Principal,
    input: { method: MfaChallengeMethod; code: string },
    origin: EventOrigin,
  ): Promise<string> {
    const now = this.now;
    const { user, session } = principal;
    await this.auth.enforceLoginProtection(user.emailNormalized, origin, now);
    let remaining: number | null = null;
    let ok: boolean;
    if (input.method === 'totp') {
      ok = await inTransaction(this.deps.db, { userId: user.id }, (tx) =>
        this.verifier.verifyTotp(tx, user.id, input.code, now),
      );
    } else {
      const used = await this.verifier.useRecoveryCode(user.id, input.code, now);
      ok = used.ok;
      if (used.ok) remaining = used.remaining;
    }
    if (!ok) {
      await this.auth.recordCredentialFailure({
        eventType: SecurityEventTypes.LoginFailed,
        userId: user.id,
        emailNormalized: user.emailNormalized,
        reason: input.method === 'totp' ? 'mfa_invalid_code' : 'mfa_invalid_recovery_code',
        origin,
        now,
      });
      throw new InvalidMfaCodeError();
    }
    const token = await inTransaction(this.deps.db, { userId: user.id }, async (tx) => {
      const rotated = await satisfySessionMfa(tx, {
        sessionId: session.id,
        method: input.method,
        factorVerified: true,
        now,
      });
      if (!rotated) throw new UnauthenticatedError();
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.MfaStepUp,
        userId: user.id,
        metadata: { sessionId: session.id, method: input.method },
        origin,
      });
      if (remaining !== null) {
        await recordSecurityEvent(tx, {
          occurredAt: now,
          eventType: SecurityEventTypes.RecoveryCodeUsed,
          userId: user.id,
          metadata: { sessionId: session.id, remaining },
          origin,
        });
      }
      return rotated;
    });
    if (remaining !== null) await this.auth.notifyRecoveryCodeUsed(user, remaining);
    return token;
  }

  /**
   * Turns MFA off (S7-21): only when no organization requires it of the user (so never for an
   * Owner). Needs re-authentication and step-up; revokes recovery codes and remembered devices.
   */
  async disable(principal: Principal, input: { factorId: string }, origin: EventOrigin) {
    const now = this.now;
    const { user } = principal;
    requireRecentAuthentication(principal, now, this.deps.config.session.reauthWindowMs);
    await inTransaction(this.deps.db, { userId: user.id }, async (tx) => {
      await requireRecentMfa(tx, principal, now, this.deps.config.mfa.stepUpWindowMs);
      await lockUserForMfa(tx, user.id);
      const factor = await getActiveTotpFactor(tx, user.id);
      if (!factor || factor.id !== input.factorId)
        throw new NotFoundError('Authenticator not found.');
      const requiredBy = await this.requiredOrganizations(tx, user.id);
      if (requiredBy.length > 0) {
        throw new ProtectedResourceError(
          `Two-step verification is required for your account in ${requiredBy
            .map((o) => o.name)
            .join(', ')}, so it cannot be turned off.`,
        );
      }
      await revokeFactors(tx, {
        userId: user.id,
        factorId: factor.id,
        reason: 'user_disabled',
        now,
      });
      const codesRevoked = await revokeUsableRecoveryCodes(tx, user.id, now);
      const devicesRevoked = await revokeTrustedDevices(tx, {
        userId: user.id,
        reason: 'mfa_disabled',
        now,
      });
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.TotpDisabled,
        userId: user.id,
        metadata: { factorId: factor.id, codesRevoked, devicesRevoked },
        origin,
      });
    });
    await this.auth.sendEmailSafely({
      to: user.email,
      template: 'mfa_disabled',
      subject: 'Two-step verification was turned off for your Intuit 2.0 account',
      text:
        `Hello ${user.displayName},\n\nTwo-step verification was turned off for your account. ` +
        'If this was not you, reset your password immediately.',
    });
  }

  /** New recovery codes (S7-19): the previous unused set stops working. */
  async regenerateRecoveryCodes(principal: Principal, origin: EventOrigin): Promise<string[]> {
    const now = this.now;
    const { user } = principal;
    requireRecentAuthentication(principal, now, this.deps.config.session.reauthWindowMs);
    await inTransaction(this.deps.db, { userId: user.id }, (tx) =>
      requireRecentMfa(tx, principal, now, this.deps.config.mfa.stepUpWindowMs),
    );
    const prepared = await this.verifier.prepareRecoveryCodes();
    await inTransaction(this.deps.db, { userId: user.id }, async (tx) => {
      await requireRecentMfa(tx, principal, now, this.deps.config.mfa.stepUpWindowMs);
      await lockUserForMfa(tx, user.id);
      const revoked = await revokeUsableRecoveryCodes(tx, user.id, now);
      await this.verifier.storeRecoveryCodes(tx, user.id, prepared, now);
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.RecoveryCodesGenerated,
        userId: user.id,
        metadata: {
          count: prepared.display.length,
          previousRevoked: revoked,
          reason: 'regenerated',
        },
        origin,
      });
    });
    await this.auth.sendEmailSafely({
      to: user.email,
      template: 'mfa_recovery_codes_regenerated',
      subject: 'New Intuit 2.0 recovery codes were generated',
      text:
        `Hello ${user.displayName},\n\nNew recovery codes were generated for your account and ` +
        'the previous ones no longer work. If this was not you, reset your password immediately.',
    });
    return prepared.display;
  }

  /** The user's remembered devices; `currentToken` (the cookie) marks this browser. */
  listTrustedDevices(principal: Principal, currentToken: string | undefined) {
    const userId = principal.user.id;
    const currentHash = currentToken ? hashToken(currentToken) : null;
    return inTransaction(this.deps.db, { userId }, async (tx) => {
      const devices = await listActiveTrustedDevices(tx, userId, this.now);
      return devices.map((d) => ({
        id: d.id,
        current: currentHash !== null && d.tokenHash.equals(currentHash),
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: d.lastUsedAt.toISOString(),
        expiresAt: d.expiresAt.toISOString(),
        ipAddress: d.ipAddress,
        userAgent: d.userAgent,
      }));
    });
  }

  /** Forgets one device (no re-authentication: it only reduces access, like signing out). */
  async revokeTrustedDevice(principal: Principal, deviceId: string, origin: EventOrigin) {
    const now = this.now;
    const userId = principal.user.id;
    await inTransaction(this.deps.db, { userId }, async (tx) => {
      const count = await revokeTrustedDevices(tx, {
        userId,
        reason: 'user_revoked',
        now,
        deviceIds: [deviceId],
      });
      if (count === 0) throw new NotFoundError('Device not found.');
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.TrustedDeviceRevoked,
        userId,
        metadata: { deviceId, reason: 'user_revoked' },
        origin,
      });
    });
  }

  /** Forgets every device (S7-35): a security action, so re-authentication and step-up. */
  async revokeAllTrustedDevices(principal: Principal, origin: EventOrigin): Promise<number> {
    const now = this.now;
    const userId = principal.user.id;
    requireRecentAuthentication(principal, now, this.deps.config.session.reauthWindowMs);
    return inTransaction(this.deps.db, { userId }, async (tx) => {
      await requireRecentMfa(tx, principal, now, this.deps.config.mfa.stepUpWindowMs);
      const count = await revokeTrustedDevices(tx, { userId, reason: 'user_revoked', now });
      await recordSecurityEvent(tx, {
        occurredAt: now,
        eventType: SecurityEventTypes.TrustedDeviceRevoked,
        userId,
        metadata: { count, reason: 'user_revoked_all' },
        origin,
      });
      return count;
    });
  }
}
