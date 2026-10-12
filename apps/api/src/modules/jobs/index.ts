/**
 * Public contract of the jobs module (Decision 76; K-2; S5-14..S5-19): a PostgreSQL-backed job
 * queue with idempotent enqueue, cross-tenant claiming through a narrow SECURITY DEFINER
 * function, lock-guarded state changes, retries and a dead-letter state.
 */
export * from './jobs.js';
export { jobStatuses } from './schema.js';
export type { JobStatus } from './schema.js';

/** Thrown by a handler for an error that retrying cannot fix: the job ends as `failed`. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/**
 * Thrown by a handler that decides when the job runs again (a retry schedule of its own, or
 * throttling). `countsAsAttempt: false` gives the attempt back, so waiting for a free slot never
 * uses up the job's attempts.
 */
export class RetryAfterError extends Error {
  constructor(
    readonly delayMs: number,
    message: string,
    readonly countsAsAttempt = true,
  ) {
    super(message);
    this.name = 'RetryAfterError';
  }
}

/**
 * Retry delay after failed attempt `n` (1-based): min(base × 6^(n−1), max) with ±20% jitter
 * (S5-14). `random` is injectable for tests.
 */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const raw = Math.min(baseMs * 6 ** Math.max(0, attempt - 1), maxMs);
  const jitter = 1 + (random() * 2 - 1) * 0.2;
  return Math.round(raw * jitter);
}
