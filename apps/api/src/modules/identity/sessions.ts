import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { generateSecureToken, hashToken } from '../../infrastructure/security/tokens.js';
import { sessions, users, type SessionRevocationReason } from './schema.js';
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
  },
): Promise<IssuedSession> {
  const token = generateSecureToken();
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
