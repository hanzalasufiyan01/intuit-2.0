import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { idempotencyKeys } from './schema.js';

export type IdempotencyRecord = typeof idempotencyKeys.$inferSelect;

/** Client keys: 1–200 characters of letters, digits and `_ . : -` (e.g. a UUID). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

/** A stable SHA-256 of the request (object keys sorted), to detect a key reused differently. */
export function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Claims a key in the caller's transaction. Returns the claimed row, or undefined when the key
 * already exists (a concurrent claimant blocks here until the first transaction ends).
 */
export async function claimIdempotencyKey(
  tx: Transaction,
  input: {
    organizationId: string;
    userId: string;
    scope: string;
    key: string;
    requestHash: string;
    now: Date;
    expiresAt: Date;
  },
): Promise<IdempotencyRecord | undefined> {
  const [row] = await tx
    .insert(idempotencyKeys)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      scope: input.scope,
      idempotencyKey: input.key,
      requestHash: input.requestHash,
      createdAt: input.now,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function findIdempotencyKey(
  tx: Transaction,
  organizationId: string,
  scope: string,
  key: string,
): Promise<IdempotencyRecord | undefined> {
  const [row] = await tx
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.organizationId, organizationId),
        eq(idempotencyKeys.scope, scope),
        eq(idempotencyKeys.idempotencyKey, key),
      ),
    );
  return row;
}

export async function completeIdempotencyKey(
  tx: Transaction,
  id: string,
  response: unknown,
  now: Date,
): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({ response: response as object, completedAt: now })
    .where(eq(idempotencyKeys.id, id));
}

/** Housekeeping: removes expired keys across organizations (SECURITY DEFINER). */
export async function purgeExpiredIdempotencyKeys(tx: Transaction, limit: number): Promise<number> {
  const result = await tx.execute<{ n: number }>(
    sql`SELECT app_purge_expired_idempotency_keys(${limit}) AS n`,
  );
  return Number(result.rows[0]?.n ?? 0);
}
