import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { generateSecureToken, hashToken } from '../../infrastructure/security/tokens.js';
import { passwordResetTokens } from './schema.js';

/** Issues a single-use reset token. Only its hash is stored; the raw token is returned once. */
export async function issuePasswordResetToken(
  tx: Transaction,
  input: { userId: string; now: Date; ttlMs: number; requestedIp: string | null },
): Promise<string> {
  const token = generateSecureToken();
  await tx.insert(passwordResetTokens).values({
    userId: input.userId,
    tokenHash: hashToken(token),
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + input.ttlMs),
    requestedIp: input.requestedIp,
  });
  return token;
}

/**
 * Atomically consumes a token: succeeds only if it exists, is unused and unexpired.
 * Returns the owning user id, or undefined for any invalid token (no reason is disclosed).
 */
export async function consumePasswordResetToken(
  tx: Transaction,
  token: string,
  now: Date,
): Promise<string | undefined> {
  const [row] = await tx
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hashToken(token)),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, now),
      ),
    )
    .returning({ userId: passwordResetTokens.userId });
  return row?.userId;
}

/** Invalidates all other outstanding reset tokens of a user (after a successful reset). */
export async function invalidateOutstandingResetTokens(
  tx: Transaction,
  userId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
}
