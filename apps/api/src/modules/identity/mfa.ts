import { and, asc, count, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { mfaFactors, mfaRecoveryCodes, users } from './schema.js';

/**
 * MFA credential storage (S7-02, S7-04). Every table here is user-keyed under RLS: callers set
 * `app.user_id` to the user whose credentials they touch. Secrets are only ever stored sealed
 * (AES-256-GCM) and recovery codes only as Argon2id hashes.
 */
export type MfaFactor = typeof mfaFactors.$inferSelect;
export type MfaFactorRevocationReason = NonNullable<MfaFactor['revokedReason']>;

/** Serializes MFA changes of one user (enrollment, replacement, disable, regeneration, reset). */
export async function lockUserForMfa(tx: Transaction, userId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);
}

export async function getActiveTotpFactor(
  tx: Transaction,
  userId: string,
): Promise<MfaFactor | undefined> {
  const [row] = await tx
    .select()
    .from(mfaFactors)
    .where(
      and(
        eq(mfaFactors.userId, userId),
        eq(mfaFactors.type, 'totp'),
        eq(mfaFactors.status, 'active'),
      ),
    )
    .limit(1);
  return row;
}

export async function hasActiveFactor(tx: Transaction, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ n: count() })
    .from(mfaFactors)
    .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.status, 'active')));
  return (row?.n ?? 0) > 0;
}

export async function listActiveFactors(tx: Transaction, userId: string): Promise<MfaFactor[]> {
  return tx
    .select()
    .from(mfaFactors)
    .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.status, 'active')))
    .orderBy(asc(mfaFactors.createdAt));
}

export async function insertPendingTotpFactor(
  tx: Transaction,
  input: {
    id: string;
    userId: string;
    secretCiphertext: Buffer;
    secretIv: Buffer;
    secretTag: Buffer;
    keyId: string;
    now: Date;
    expiresAt: Date;
  },
): Promise<MfaFactor> {
  const [row] = await tx
    .insert(mfaFactors)
    .values({
      id: input.id,
      userId: input.userId,
      type: 'totp',
      status: 'pending',
      label: 'Authenticator app',
      secretCiphertext: input.secretCiphertext,
      secretIv: input.secretIv,
      secretTag: input.secretTag,
      keyId: input.keyId,
      pendingExpiresAt: input.expiresAt,
      createdAt: input.now,
    })
    .returning();
  if (!row) throw new Error('MFA factor insert returned no row');
  return row;
}

/** A pending enrollment of this user (expired ones included; the caller checks expiry). */
export async function getPendingFactor(
  tx: Transaction,
  userId: string,
  factorId: string,
): Promise<MfaFactor | undefined> {
  const [row] = await tx
    .select()
    .from(mfaFactors)
    .where(
      and(
        eq(mfaFactors.id, factorId),
        eq(mfaFactors.userId, userId),
        eq(mfaFactors.status, 'pending'),
      ),
    )
    .limit(1);
  return row;
}

export async function revokeFactors(
  tx: Transaction,
  input: {
    userId: string;
    reason: MfaFactorRevocationReason;
    now: Date;
    status?: 'pending' | 'active';
    factorId?: string;
    exceptId?: string;
  },
): Promise<number> {
  const conditions = [eq(mfaFactors.userId, input.userId), ne(mfaFactors.status, 'revoked')];
  if (input.status) conditions.push(eq(mfaFactors.status, input.status));
  if (input.factorId) conditions.push(eq(mfaFactors.id, input.factorId));
  if (input.exceptId) conditions.push(ne(mfaFactors.id, input.exceptId));
  const rows = await tx
    .update(mfaFactors)
    .set({ status: 'revoked', revokedAt: input.now, revokedReason: input.reason })
    .where(and(...conditions))
    .returning({ id: mfaFactors.id });
  return rows.length;
}

/** Counts a failed enrollment code and returns the new count. */
export async function recordFactorFailure(tx: Transaction, factorId: string): Promise<number> {
  const [row] = await tx
    .update(mfaFactors)
    .set({ failedAttempts: sql`${mfaFactors.failedAttempts} + 1` })
    .where(eq(mfaFactors.id, factorId))
    .returning({ failedAttempts: mfaFactors.failedAttempts });
  return row?.failedAttempts ?? 0;
}

export async function activateFactor(
  tx: Transaction,
  input: { factorId: string; step: number; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(mfaFactors)
    .set({
      status: 'active',
      activatedAt: input.now,
      lastUsedAt: input.now,
      lastUsedStep: input.step,
      failedAttempts: 0,
    })
    .where(and(eq(mfaFactors.id, input.factorId), eq(mfaFactors.status, 'pending')))
    .returning({ id: mfaFactors.id });
  return rows.length > 0;
}

/**
 * Replay protection (S7-16): records `step` as used only if it is later than the last used
 * step. Exactly one of several concurrent verifications of the same code can succeed.
 */
export async function consumeTotpStep(
  tx: Transaction,
  input: { factorId: string; step: number; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(mfaFactors)
    .set({ lastUsedStep: input.step, lastUsedAt: input.now })
    .where(
      and(
        eq(mfaFactors.id, input.factorId),
        eq(mfaFactors.status, 'active'),
        or(isNull(mfaFactors.lastUsedStep), lt(mfaFactors.lastUsedStep, input.step)),
      ),
    )
    .returning({ id: mfaFactors.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Recovery codes (S7-18 to S7-20)
// ---------------------------------------------------------------------------

export type RecoveryCodeRow = typeof mfaRecoveryCodes.$inferSelect;

export async function insertRecoveryCodes(
  tx: Transaction,
  input: {
    userId: string;
    setId: string;
    codes: { lookupId: string; codeHash: string }[];
    now: Date;
  },
): Promise<void> {
  await tx.insert(mfaRecoveryCodes).values(
    input.codes.map((c) => ({
      userId: input.userId,
      setId: input.setId,
      lookupId: c.lookupId,
      codeHash: c.codeHash,
      createdAt: input.now,
    })),
  );
}

/** Revokes every unused code of the user (regeneration, disable). Returns the count. */
export async function revokeUsableRecoveryCodes(
  tx: Transaction,
  userId: string,
  now: Date,
): Promise<number> {
  const rows = await tx
    .update(mfaRecoveryCodes)
    .set({ revokedAt: now })
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        isNull(mfaRecoveryCodes.usedAt),
        isNull(mfaRecoveryCodes.revokedAt),
      ),
    )
    .returning({ id: mfaRecoveryCodes.id });
  return rows.length;
}

export async function countUsableRecoveryCodes(tx: Transaction, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(mfaRecoveryCodes)
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        isNull(mfaRecoveryCodes.usedAt),
        isNull(mfaRecoveryCodes.revokedAt),
      ),
    );
  return row?.n ?? 0;
}

export async function findUsableRecoveryCode(
  tx: Transaction,
  userId: string,
  lookupId: string,
): Promise<RecoveryCodeRow | undefined> {
  const [row] = await tx
    .select()
    .from(mfaRecoveryCodes)
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        eq(mfaRecoveryCodes.lookupId, lookupId),
        isNull(mfaRecoveryCodes.usedAt),
        isNull(mfaRecoveryCodes.revokedAt),
      ),
    )
    .limit(1);
  return row;
}

/** Single use: succeeds for exactly one of several concurrent attempts. */
export async function consumeRecoveryCode(
  tx: Transaction,
  input: { id: string; userId: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(mfaRecoveryCodes)
    .set({ usedAt: input.now })
    .where(
      and(
        eq(mfaRecoveryCodes.id, input.id),
        eq(mfaRecoveryCodes.userId, input.userId),
        isNull(mfaRecoveryCodes.usedAt),
        isNull(mfaRecoveryCodes.revokedAt),
      ),
    )
    .returning({ id: mfaRecoveryCodes.id });
  return rows.length > 0;
}

/** Latest time a recovery-code set was issued to the user (for the status view). */
export async function latestRecoveryCodeIssue(
  tx: Transaction,
  userId: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({ at: sql<Date | null>`max(${mfaRecoveryCodes.createdAt})` })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.revokedAt)));
  return row?.at ? new Date(row.at) : null;
}
