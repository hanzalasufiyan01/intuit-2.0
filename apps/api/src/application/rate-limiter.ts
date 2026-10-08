import { sql } from 'drizzle-orm';
import { AppError } from '../domain/errors.js';
import type { Database } from '../database/client.js';
import type { Clock } from '../infrastructure/clock.js';
import { inTransaction } from './unit-of-work.js';

/**
 * Rate limiting for the Public API (ADR 0011 section 4). The store sits behind this interface; the
 * default is PostgreSQL fixed one-minute windows (no external service). Limits are configuration.
 * The response contract is frozen: `429`, `RateLimit-Limit`, `RateLimit-Remaining`,
 * `RateLimit-Reset` (seconds until the window ends) and `Retry-After`.
 */

export const RATE_WINDOW_MS = 60_000;

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window ends (at least 1). */
  resetSeconds: number;
}

export interface RateLimiter {
  /** Counts one request against `key` and decides. */
  consume(key: string, limit: number): Promise<RateDecision>;
  /** The current count of `key` without counting (used to refuse before any work is done). */
  peek(key: string, limit: number): Promise<RateDecision>;
}

/** A request over a limit. Carries the headers of the frozen contract. */
export class RateLimitedError extends AppError {
  constructor(readonly decision: RateDecision) {
    super('TOO_MANY_ATTEMPTS', 429, 'Rate limit exceeded.', {
      retryAfterSeconds: decision.resetSeconds,
    });
  }
}

function windowOf(now: Date) {
  const start = Math.floor(now.getTime() / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const resetSeconds = Math.max(1, Math.ceil((start + RATE_WINDOW_MS - now.getTime()) / 1000));
  return { start: new Date(start), resetSeconds };
}

const decide = (count: number, limit: number, resetSeconds: number): RateDecision => ({
  allowed: count <= limit,
  limit,
  remaining: Math.max(0, limit - count),
  resetSeconds,
});

/** Fixed-window counters in PostgreSQL (table api_rate_windows). */
export class PostgresRateLimiter implements RateLimiter {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async consume(key: string, limit: number): Promise<RateDecision> {
    const now = this.clock.now();
    const { start, resetSeconds } = windowOf(now);
    const count = await inTransaction(this.db, {}, async (tx) => {
      const result = await tx.execute<{ count: number }>(sql`
        INSERT INTO api_rate_windows (key, window_start, count) VALUES (${key}, ${start}, 1)
        ON CONFLICT (key, window_start) DO UPDATE SET count = api_rate_windows.count + 1
        RETURNING count`);
      // Housekeeping: a new window occasionally drops windows older than an hour.
      if (result.rows[0]!.count === 1 && Math.random() < 0.02) {
        await tx.execute(
          sql`DELETE FROM api_rate_windows WHERE window_start < ${new Date(now.getTime() - 3_600_000)}`,
        );
      }
      return result.rows[0]!.count;
    });
    return decide(count, limit, resetSeconds);
  }

  async peek(key: string, limit: number): Promise<RateDecision> {
    const { start, resetSeconds } = windowOf(this.clock.now());
    const count = await inTransaction(this.db, {}, async (tx) => {
      const result = await tx.execute<{ count: number }>(
        sql`SELECT count FROM api_rate_windows WHERE key = ${key} AND window_start = ${start}`,
      );
      return result.rows[0]?.count ?? 0;
    });
    // Over the limit only once the counter has gone beyond it.
    return decide(count, limit, resetSeconds);
  }
}

/** Process-local counters: the interface's second implementation (single instance, tests). */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  async consume(key: string, limit: number): Promise<RateDecision> {
    const { start, resetSeconds } = windowOf(this.clock.now());
    const id = `${key}@${start.getTime()}`;
    const count = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, count);
    return decide(count, limit, resetSeconds);
  }

  async peek(key: string, limit: number): Promise<RateDecision> {
    const { start, resetSeconds } = windowOf(this.clock.now());
    return decide(this.counts.get(`${key}@${start.getTime()}`) ?? 0, limit, resetSeconds);
  }
}
