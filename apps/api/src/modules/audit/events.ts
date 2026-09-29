import { and, count, desc, eq, gte, lt, max, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { auditEvents, securityEvents, type EventMetadata } from './schema.js';

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
  /** Defaults to 'user' when actorUserId is set, otherwise 'anonymous'. */
  actorType?: 'user' | 'system' | 'anonymous';
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata?: EventMetadata;
  origin: EventOrigin;
}

export async function recordAuditEvent(tx: Transaction, input: AuditEventInput): Promise<void> {
  await tx.insert(auditEvents).values({
    occurredAt: input.occurredAt,
    organizationId: input.organizationId,
    actorType: input.actorType ?? (input.actorUserId ? 'user' : 'anonymous'),
    actorUserId: input.actorUserId,
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
