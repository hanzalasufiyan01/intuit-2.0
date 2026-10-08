import { ConflictError } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  findIdempotencyKey,
  purgeExpiredIdempotencyKeys,
  requestFingerprint,
} from '../modules/idempotency/index.js';
import type { AppDependencies } from './dependencies.js';
import { inTransaction } from './unit-of-work.js';

/** How long a completed key replays its response (Decision 23). */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyInput {
  /** The client's `Idempotency-Key`, or null when none was sent. */
  key: string | null;
  /** The operation, e.g. `sales.receipt.create`. */
  scope: string;
  /** Everything that defines the request (route parameters and body). */
  request: unknown;
}

export interface IdempotentResult<T> {
  value: T;
  replayed: boolean;
}

/**
 * Reusable request idempotency (Decision 23). Runs `work` in the caller's transaction with the key
 * claimed first: a retry with the same key and request returns the stored response instead of
 * running again; the same key with another request, or from another user, is refused. Nothing is
 * stored when `work` fails, because the claim rolls back with the transaction.
 */
/** `public.i<12 hex of the integration id>.<scope>`; scopes are at most 100 characters. */
export function integrationScope(integrationId: string, scope: string): string {
  const scoped = `public.i${integrationId.replaceAll('-', '').slice(0, 12)}.${scope}`;
  if (scoped.length > 100) throw new Error('The idempotency scope is too long.');
  return scoped;
}

export class IdempotencyService {
  constructor(private readonly deps: AppDependencies) {}

  async run<T>(
    tx: Transaction,
    actor: {
      organizationId: string;
      userId: string;
      /** Present for a Public API request (the AuthorizationContext carries it). */
      integration?: { integrationId: string } | undefined;
    },
    rawInput: IdempotencyInput,
    work: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    if (rawInput.key === null) return { value: await work(), replayed: false };
    const key: string = rawInput.key;
    // A Public API request is owned by its integration (its service principal, the same across
    // token rotation) and lives in the integration's own scope namespace, so one integration can
    // never collide with or probe another's keys. Browser requests are unchanged.
    const input = actor.integration
      ? { ...rawInput, scope: integrationScope(actor.integration.integrationId, rawInput.scope) }
      : rawInput;
    const now = this.deps.clock.now();
    const requestHash = requestFingerprint({ scope: input.scope, request: input.request });
    const claimed = await claimIdempotencyKey(tx, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      scope: input.scope,
      key,
      requestHash,
      now,
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS),
    });
    if (claimed) {
      const value = await work();
      // Stored as JSON: what a replay returns is exactly what the first response serialized to.
      const stored = JSON.parse(JSON.stringify(value ?? null)) as T;
      await completeIdempotencyKey(tx, claimed.id, stored, now);
      return { value: stored, replayed: false };
    }
    const existing = await findIdempotencyKey(tx, actor.organizationId, input.scope, key);
    if (
      !existing ||
      existing.userId !== actor.userId ||
      existing.requestHash !== requestHash ||
      existing.response === null
    ) {
      throw new ConflictError(
        'IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    return { value: existing.response as T, replayed: true };
  }

  /** Housekeeping: removes expired keys (all organizations). */
  purgeExpired(limit = 5000): Promise<number> {
    return inTransaction(this.deps.db, {}, (tx) => purgeExpiredIdempotencyKeys(tx, limit));
  }
}
