import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { generateSecureToken, hashToken } from '../../infrastructure/security/tokens.js';
import { sessions, users, type SessionMfaMethod, type SessionRevocationReason } from './schema.js';
import type { User } from './users.js';

export type Session = typeof sessions.$inferSelect;

export interface SessionPolicy {
  idleTimeoutMs: number;
  absoluteLifetimeMs: number;
}

export interface IssuedSession {
  session: Session;
  /** Raw opaque token for the cookie. Returned once, never stored. */
  token: string;
}

export async function createSession(
  tx: Transaction,
  input: {
    userId: string;
    activeOrganizationId: string | null;
    now: Date;
    policy: SessionPolicy;
    ipAddress: string | null;
    userAgent: string | null;
    /**
     * S7-14: a pending session waits for the second factor until `pendingUntil`; a session
     * opened through a remembered device records that (it is not a factor verification).
     */
    mfa?: { pendingUntil: Date } | { method: 'trusted_device' };
  },
): Promise<IssuedSession> {
  const token = generateSecureToken();
  const mfa = input.mfa;
  const [session] = await tx
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: hashToken(token),
      activeOrganizationId: input.activeOrganizationId,
      createdAt: input.now,
      lastSeenAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.policy.absoluteLifetimeMs),
      reauthenticatedAt: input.now,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      mfaPendingUntil: mfa && 'pendingUntil' in mfa ? mfa.pendingUntil : null,
      mfaMethod: mfa && 'method' in mfa ? mfa.method : null,
    })
    .returning();
  if (!session) throw new Error('Session insert returned no row');
  return { session, token };
}

export type SessionState = 'valid' | 'revoked' | 'expired' | 'idle_timeout' | 'user_disabled';

/** Applies the approved session rules: immediate revocation, absolute lifetime, idle timeout. */
export function evaluateSession(
  session: Session,
  user: Pick<User, 'status'>,
  now: Date,
  policy: SessionPolicy,
): SessionState {
  if (session.revokedAt !== null) return 'revoked';
  if (user.status !== 'active') return 'user_disabled';
  if (now.getTime() >= session.expiresAt.getTime()) return 'expired';
  // An unanswered MFA challenge expires on its own, shorter clock (S7-14).
  if (session.mfaPendingUntil && now.getTime() >= session.mfaPendingUntil.getTime()) {
    return 'expired';
  }
  if (now.getTime() - session.lastSeenAt.getTime() >= policy.idleTimeoutMs) return 'idle_timeout';
  return 'valid';
}

export async function findSessionByToken(
  tx: Transaction,
  token: string,
): Promise<{ session: Session; user: User } | undefined> {
  const [row] = await tx
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1);
  return row;
}

export async function touchSession(tx: Transaction, sessionId: string, now: Date): Promise<void> {
  await tx.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));
}

export async function markSessionReauthenticated(
  tx: Transaction,
  sessionId: string,
  now: Date,
): Promise<void> {
  await tx.update(sessions).set({ reauthenticatedAt: now }).where(eq(sessions.id, sessionId));
}

export async function setSessionActiveOrganization(
  tx: Transaction,
  sessionId: string,
  organizationId: string | null,
): Promise<void> {
  await tx
    .update(sessions)
    .set({ activeOrganizationId: organizationId })
    .where(eq(sessions.id, sessionId));
}

/** Revokes one session of a user. Returns false if it was not found or already revoked. */
export async function revokeSession(
  tx: Transaction,
  input: { sessionId: string; userId: string; reason: SessionRevocationReason; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: input.now, revokedReason: input.reason })
    .where(
      and(
        eq(sessions.id, input.sessionId),
        eq(sessions.userId, input.userId),
        isNull(sessions.revokedAt),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Revokes every active session of a user (optionally keeping one). Returns the count. */
export async function revokeAllUserSessions(
  tx: Transaction,
  input: { userId: string; reason: SessionRevocationReason; now: Date; exceptSessionId?: string },
): Promise<number> {
  const conditions = [eq(sessions.userId, input.userId), isNull(sessions.revokedAt)];
  if (input.exceptSessionId) conditions.push(ne(sessions.id, input.exceptSessionId));
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: input.now, revokedReason: input.reason })
    .where(and(...conditions))
    .returning({ id: sessions.id });
  return rows.length;
}

export async function listActiveSessions(
  tx: Transaction,
  userId: string,
  now: Date,
): Promise<Session[]> {
  return tx
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
    )
    .orderBy(desc(sessions.lastSeenAt));
}

/** True while the session waits for its second factor (default-deny, S7-15). */
export function isMfaPending(session: Pick<Session, 'mfaPendingUntil'>): boolean {
  return session.mfaPendingUntil !== null;
}

/**
 * The session has satisfied MFA (S7-14): clears the pending state, records how, and rotates the
 * session token so no pre-MFA token carries the new status. `factorVerified` is false only for a
 * remembered-device satisfaction, which is not a factor entry (it never counts as step-up).
 * Returns the new raw token, or undefined if the session is gone.
 */
export async function satisfySessionMfa(
  tx: Transaction,
  input: { sessionId: string; method: SessionMfaMethod; factorVerified: boolean; now: Date },
): Promise<string | undefined> {
  const token = generateSecureToken();
  const rows = await tx
    .update(sessions)
    .set({
      tokenHash: hashToken(token),
      mfaPendingUntil: null,
      mfaMethod: input.method,
      mfaFailedAttempts: 0,
      ...(input.factorVerified ? { mfaVerifiedAt: input.now } : {}),
    })
    .where(and(eq(sessions.id, input.sessionId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0 ? token : undefined;
}

/** Counts a wrong code on a pending session and returns the new count. */
export async function recordSessionMfaFailure(tx: Transaction, sessionId: string): Promise<number> {
  const [row] = await tx
    .update(sessions)
    .set({ mfaFailedAttempts: sql`${sessions.mfaFailedAttempts} + 1` })
    .where(eq(sessions.id, sessionId))
    .returning({ attempts: sessions.mfaFailedAttempts });
  return row?.attempts ?? 0;
}
