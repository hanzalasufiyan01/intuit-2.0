import { and, asc, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { generateSecureToken, hashToken } from '../../infrastructure/security/tokens.js';
import { trustedDevices, type TrustedDeviceRevocationReason } from './schema.js';

/**
 * Remembered devices (Decision 57d; S7-34, S7-35). A device credential is a 256-bit random token
 * kept only as SHA-256, bound to one user, valid for at most 30 days (never sliding), rotated on
 * every use; presenting the token from before the latest rotation revokes the device (reuse).
 */
export type TrustedDevice = typeof trustedDevices.$inferSelect;

export interface IssuedDevice {
  device: TrustedDevice;
  /** Raw token for the cookie. Returned once, never stored. */
  token: string;
}

export async function createTrustedDevice(
  tx: Transaction,
  input: {
    userId: string;
    now: Date;
    lifetimeMs: number;
    ipAddress: string | null;
    userAgent: string | null;
  },
): Promise<IssuedDevice> {
  const token = generateSecureToken();
  const [device] = await tx
    .insert(trustedDevices)
    .values({
      userId: input.userId,
      tokenHash: hashToken(token),
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.lifetimeMs),
      lastUsedAt: input.now,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
    })
    .returning();
  if (!device) throw new Error('Trusted device insert returned no row');
  return { device, token };
}

export type DeviceLookup =
  | { state: 'valid'; device: TrustedDevice }
  | { state: 'reused'; device: TrustedDevice }
  | { state: 'invalid' };

/** Resolves a presented device token for a user (RLS: app.user_id must be that user). */
export async function lookupTrustedDevice(
  tx: Transaction,
  input: { userId: string; token: string; now: Date },
): Promise<DeviceLookup> {
  const hash = hashToken(input.token);
  const [current] = await tx
    .select()
    .from(trustedDevices)
    .where(and(eq(trustedDevices.userId, input.userId), eq(trustedDevices.tokenHash, hash)))
    .limit(1);
  if (current) {
    const usable = current.revokedAt === null && current.expiresAt.getTime() > input.now.getTime();
    return usable ? { state: 'valid', device: current } : { state: 'invalid' };
  }
  const [previous] = await tx
    .select()
    .from(trustedDevices)
    .where(
      and(
        eq(trustedDevices.userId, input.userId),
        eq(trustedDevices.previousTokenHash, hash),
        isNull(trustedDevices.revokedAt),
      ),
    )
    .limit(1);
  return previous ? { state: 'reused', device: previous } : { state: 'invalid' };
}

/**
 * Rotates the token of a device that was just used. Compare-and-set on the old hash, so two
 * concurrent uses of one token cannot both rotate it. Returns the new raw token, or undefined.
 */
export async function rotateTrustedDevice(
  tx: Transaction,
  input: { device: TrustedDevice; now: Date },
): Promise<string | undefined> {
  const token = generateSecureToken();
  const rows = await tx
    .update(trustedDevices)
    .set({
      tokenHash: hashToken(token),
      previousTokenHash: input.device.tokenHash,
      lastUsedAt: input.now,
    })
    .where(
      and(
        eq(trustedDevices.id, input.device.id),
        eq(trustedDevices.tokenHash, input.device.tokenHash),
        isNull(trustedDevices.revokedAt),
      ),
    )
    .returning({ id: trustedDevices.id });
  return rows.length > 0 ? token : undefined;
}

export async function revokeTrustedDevices(
  tx: Transaction,
  input: {
    userId: string;
    reason: TrustedDeviceRevocationReason;
    now: Date;
    deviceIds?: string[];
    exceptId?: string;
  },
): Promise<number> {
  const conditions = [eq(trustedDevices.userId, input.userId), isNull(trustedDevices.revokedAt)];
  if (input.deviceIds) conditions.push(inArray(trustedDevices.id, input.deviceIds));
  if (input.exceptId) conditions.push(ne(trustedDevices.id, input.exceptId));
  const rows = await tx
    .update(trustedDevices)
    .set({ revokedAt: input.now, revokedReason: input.reason })
    .where(and(...conditions))
    .returning({ id: trustedDevices.id });
  return rows.length;
}

export async function listActiveTrustedDevices(
  tx: Transaction,
  userId: string,
  now: Date,
): Promise<TrustedDevice[]> {
  return tx
    .select()
    .from(trustedDevices)
    .where(
      and(
        eq(trustedDevices.userId, userId),
        isNull(trustedDevices.revokedAt),
        gt(trustedDevices.expiresAt, now),
      ),
    )
    .orderBy(desc(trustedDevices.lastUsedAt));
}

/** Keeps at most `max` active devices per user by revoking the oldest (S7-35). */
export async function enforceTrustedDeviceLimit(
  tx: Transaction,
  input: { userId: string; max: number; now: Date },
): Promise<number> {
  const active = await tx
    .select({ id: trustedDevices.id })
    .from(trustedDevices)
    .where(
      and(
        eq(trustedDevices.userId, input.userId),
        isNull(trustedDevices.revokedAt),
        gt(trustedDevices.expiresAt, input.now),
      ),
    )
    .orderBy(asc(trustedDevices.createdAt));
  const excess = active.slice(0, Math.max(0, active.length - input.max)).map((d) => d.id);
  if (excess.length === 0) return 0;
  return revokeTrustedDevices(tx, {
    userId: input.userId,
    reason: 'limit_exceeded',
    now: input.now,
    deviceIds: excess,
  });
}
