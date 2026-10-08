import { and, count, desc, eq, gte, lt, max, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { auditEvents, securityEvents, type AuditActorType, type EventMetadata } from './schema.js';

export type AuditEvent = typeof auditEvents.$inferSelect;
export type SecurityEvent = typeof securityEvents.$inferSelect;

/** Where an event came from. Carried from the HTTP request; never contains secrets. */
export interface EventOrigin {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

const SECRET_KEY_PATTERN =
  /pass(word)?|secret|token|credential|hash|cookie|authorization|totp|^otp|recovery_?code/i;

/**
 * Defence-in-depth: drops metadata keys that look like secrets so a coding mistake
 * cannot persist a password or token into immutable history.
 */
export function sanitizeMetadata(metadata: EventMetadata): EventMetadata {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        if (!SECRET_KEY_PATTERN.test(key)) out[key] = clean(inner);
      }
      return out;
    }
    return value;
  };
  return clean(metadata) as EventMetadata;
}

export interface AuditEventInput {
  occurredAt: Date;
  organizationId: string | null;
  actorUserId: string | null;
  /**
   * Defaults to 'user' when actorUserId is set, otherwise 'anonymous'. The type of a service
   * principal is never taken from the caller: it is always 'api_token' (see recordAuditEvent).
   */
  actorType?: AuditActorType;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata?: EventMetadata;
  origin: EventOrigin;
}

interface ActorIdentity {
  kind: string;
  /** For a service principal: the integration it belongs to (ADR 0011). */
  integrationId: string | null;
}

// The kind of a user and the integration of a service principal never change (migrations 0053,
// 0056: one-to-one, immutable), so the identity is cached for the transaction.
const identities = new WeakMap<object, Map<string, ActorIdentity>>();
// The token behind the current Public API request, bound once by the integration authentication.
const apiTokens = new WeakMap<object, string>();

/**
 * Binds the token of the authenticated Public API request to the transaction, so audit events
 * written during it can name the token. Called by the integration authentication only; callers of
 * recordAuditEvent never construct integration or token identities themselves.
 */
export function bindAuditApiToken(tx: Transaction, tokenId: string): void {
  apiTokens.set(tx, tokenId);
}

async function actorIdentity(tx: Transaction, userId: string): Promise<ActorIdentity> {
  let known = identities.get(tx);
  if (!known) {
    known = new Map();
    identities.set(tx, known);
  }
  const cached = known.get(userId);
  if (cached) return cached;
  const result = await tx.execute<{ kind: string; integration_id: string | null }>(sql`
    SELECT u.kind,
           (SELECT i.id FROM api_integrations i WHERE i.service_user_id = u.id) AS integration_id
      FROM users u WHERE u.id = ${userId}`);
  const row = result.rows[0];
  const identity = { kind: row?.kind ?? 'human', integrationId: row?.integration_id ?? null };
  known.set(userId, identity);
  return identity;
}

/**
 * The canonical audit insertion. The actor is derived from the identity, never trusted from the
 * caller: a service principal (a non-human user, ADR 0011) is always recorded as 'api_token' with
 * its integration (resolved here from the principal) and, when the request was authenticated by a
 * token, that token. It fails closed when a service principal has no integration. Everything else
 * keeps its meaning ('user' for a person, 'system', 'anonymous'). The database separately
 * verifies the attribution and rejects, for example, a service principal recorded as a user.
 */
export async function recordAuditEvent(tx: Transaction, input: AuditEventInput): Promise<void> {
  let actorType: AuditActorType = input.actorType ?? (input.actorUserId ? 'user' : 'anonymous');
  let integrationId: string | null = null;
  let tokenId: string | null = null;
  if (input.actorUserId) {
    const identity = await actorIdentity(tx, input.actorUserId);
    if (identity.kind === 'service') {
      if (!identity.integrationId) {
        throw new Error('An audit event by a service principal needs its integration.');
      }
      integrationId = identity.integrationId;
      tokenId = apiTokens.get(tx) ?? null;
      if (actorType === 'user') actorType = 'api_token';
    }
  }
  await tx.insert(auditEvents).values({
    occurredAt: input.occurredAt,
    organizationId: input.organizationId,
    actorType,
    actorUserId: input.actorUserId,
    actorIntegrationId: integrationId,
    actorTokenId: tokenId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    requestId: input.origin.requestId,
    ipAddress: input.origin.ipAddress,
    userAgent: input.origin.userAgent?.slice(0, 512) ?? null,
    metadata: sanitizeMetadata(input.metadata ?? {}),
  });
}

export async function listAuditEvents(
  tx: Transaction,
  organizationId: string,
  options: { limit: number; before?: Date | undefined },
): Promise<AuditEvent[]> {
  const conditions = [eq(auditEvents.organizationId, organizationId)];
  if (options.before) conditions.push(lt(auditEvents.occurredAt, options.before));
  return tx
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(options.limit);
}

export const SecurityEventTypes = {
  UserRegistered: 'auth.user_registered',
  LoginSucceeded: 'auth.login_succeeded',
  LoginFailed: 'auth.login_failed',
  LoginThrottled: 'auth.login_throttled',
  Logout: 'auth.logout',
  SessionRevoked: 'auth.session_revoked',
  SessionExpired: 'auth.session_expired',
  Reauthenticated: 'auth.reauthenticated',
  PasswordResetRequested: 'auth.password_reset_requested',
  PasswordResetCompleted: 'auth.password_reset_completed',
  PasswordResetFailed: 'auth.password_reset_failed',
  AccountDisabled: 'account.disabled',
  OrganizationSwitched: 'session.organization_switched',
  CsrfRejected: 'security.csrf_rejected',
  // Phase 3A S7 (S7-25). Failed codes are recorded as LoginFailed (reason mfa_*), so they feed
  // the existing login protection (S7-17).
  MfaChallengeRequired: 'auth.mfa_challenge_required',
  MfaSucceeded: 'auth.mfa_succeeded',
  MfaChallengeExhausted: 'auth.mfa_challenge_exhausted',
  MfaStepUp: 'auth.mfa_step_up',
  MfaEnrollmentRequired: 'mfa.enrollment_required',
  TotpEnrollmentStarted: 'mfa.totp_enrollment_started',
  TotpEnabled: 'mfa.totp_enabled',
  TotpReplaced: 'mfa.totp_replaced',
  TotpDisabled: 'mfa.totp_disabled',
  RecoveryCodesGenerated: 'mfa.recovery_codes_generated',
  RecoveryCodeUsed: 'mfa.recovery_code_used',
  MfaResetByAdmin: 'mfa.reset_by_admin',
  TrustedDeviceCreated: 'trusted_device.created',
  TrustedDeviceUsed: 'trusted_device.used',
  TrustedDeviceRevoked: 'trusted_device.revoked',
  TrustedDeviceReuseDetected: 'trusted_device.reuse_detected',
} as const;

export interface SecurityEventInput {
  occurredAt: Date;
  eventType: string;
  userId: string | null;
  organizationId?: string | null;
  emailNormalized?: string | null;
  metadata?: EventMetadata;
  origin: EventOrigin;
}

export async function recordSecurityEvent(
  tx: Transaction,
  input: SecurityEventInput,
): Promise<void> {
  await tx.insert(securityEvents).values({
    occurredAt: input.occurredAt,
    eventType: input.eventType,
    userId: input.userId,
    organizationId: input.organizationId ?? null,
    emailNormalized: input.emailNormalized ?? null,
    ipAddress: input.origin.ipAddress,
    userAgent: input.origin.userAgent?.slice(0, 512) ?? null,
    requestId: input.origin.requestId,
    metadata: sanitizeMetadata(input.metadata ?? {}),
  });
}

export interface FailureWindow {
  count: number;
  lastAt: Date | null;
}

/** Recent failed sign-ins, counted separately per account and per IP address. */
export async function countRecentLoginFailures(
  tx: Transaction,
  input: { emailNormalized: string; ipAddress: string | null; since: Date },
): Promise<{ byAccount: FailureWindow; byIp: FailureWindow }> {
  const window = async (condition: ReturnType<typeof eq>): Promise<FailureWindow> => {
    const [row] = await tx
      .select({ count: count(), lastAt: max(securityEvents.occurredAt) })
      .from(securityEvents)
      .where(
        and(
          eq(securityEvents.eventType, SecurityEventTypes.LoginFailed),
          gte(securityEvents.occurredAt, input.since),
          condition,
        ),
      );
    return { count: row?.count ?? 0, lastAt: row?.lastAt ?? null };
  };
  const byAccount = await window(eq(securityEvents.emailNormalized, input.emailNormalized));
  const byIp = input.ipAddress
    ? await window(eq(securityEvents.ipAddress, input.ipAddress))
    : { count: 0, lastAt: null };
  return { byAccount, byIp };
}

/** Whether an event of this type was already recorded for a session (and organization). */
export async function hasSecurityEventForSession(
  tx: Transaction,
  input: { userId: string; eventType: string; sessionId: string; organizationId: string | null },
): Promise<boolean> {
  const conditions = [
    eq(securityEvents.userId, input.userId),
    eq(securityEvents.eventType, input.eventType),
    sql`${securityEvents.metadata} ->> 'sessionId' = ${input.sessionId}`,
  ];
  if (input.organizationId)
    conditions.push(eq(securityEvents.organizationId, input.organizationId));
  const [row] = await tx
    .select({ n: count() })
    .from(securityEvents)
    .where(and(...conditions));
  return (row?.n ?? 0) > 0;
}
