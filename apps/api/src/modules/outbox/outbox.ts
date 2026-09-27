import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../../database/client.js';
import { outboxEvents } from './schema.js';

export type OutboxEvent = typeof outboxEvents.$inferSelect;

export interface OutboxEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  organizationId: string | null;
  /** Must never contain secrets (raw tokens, passwords); the outbox is persisted. */
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

/**
 * Records an internal event in the caller's transaction (transactional outbox):
 * the event is persisted if and only if the business change commits.
 */
export async function enqueueOutboxEvent(
  tx: Transaction,
  event: OutboxEventInput,
  now: Date,
): Promise<string> {
  const [row] = await tx
    .insert(outboxEvents)
    .values({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      organizationId: event.organizationId,
      payload: event.payload,
      maxAttempts: event.maxAttempts ?? 10,
      availableAt: now,
      createdAt: now,
    })
    .returning({ id: outboxEvents.id });
  if (!row) throw new Error('Outbox insert returned no row');
  return row.id;
}

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

export interface OutboxDispatcherOptions {
  batchSize: number;
  /** A 'processing' event whose lock is older than this is considered abandoned. */
  lockTimeoutMs?: number;
  /** Delay before retry n (1-based). Default: exponential, 5s base, capped at 15 minutes. */
  retryDelayMs?: (attempt: number) => number;
  now?: () => Date;
  onError?: (event: OutboxEvent, error: unknown) => void;
}

export interface DispatchResult {
  claimed: number;
  processed: number;
  retried: number;
  failed: number;
}

const defaultRetryDelay = (attempt: number) => Math.min(5_000 * 2 ** (attempt - 1), 15 * 60_000);

/**
 * PostgreSQL-backed outbox dispatcher. Claims due events with FOR UPDATE SKIP LOCKED
 * (safe with several workers), invokes the registered handlers, and records the outcome
 * with retry metadata. Events with no subscribers are marked processed.
 */
export class OutboxDispatcher {
  private readonly handlers = new Map<string, OutboxHandler[]>();
  private readonly workerId = `worker-${randomUUID()}`;

  constructor(
    private readonly db: Database,
    private readonly options: OutboxDispatcherOptions,
  ) {}

  subscribe(eventType: string, handler: OutboxHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async dispatchBatch(): Promise<DispatchResult> {
    const now = this.now();
    const lockTimeoutMs = this.options.lockTimeoutMs ?? 5 * 60_000;
    const staleBefore = new Date(now.getTime() - lockTimeoutMs);

    const claimed = await this.db.transaction(async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE outbox_events
        SET status = 'processing', locked_at = ${now}, locked_by = ${this.workerId},
            attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox_events
          WHERE (status = 'pending' AND available_at <= ${now})
             OR (status = 'processing' AND locked_at < ${staleBefore})
          ORDER BY available_at, created_at
          LIMIT ${this.options.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`);
      return result.rows.map((row) => row.id);
    });

    const outcome: DispatchResult = {
      claimed: claimed.length,
      processed: 0,
      retried: 0,
      failed: 0,
    };
    for (const id of claimed) {
      const [event] = await this.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
      if (!event) continue;
      try {
        for (const handler of this.handlers.get(event.eventType) ?? []) {
          await handler(event);
        }
        await this.db
          .update(outboxEvents)
          .set({
            status: 'processed',
            processedAt: this.now(),
            lockedAt: null,
            lockedBy: null,
            lastError: null,
          })
          .where(and(eq(outboxEvents.id, id), eq(outboxEvents.lockedBy, this.workerId)));
        outcome.processed += 1;
      } catch (error) {
        this.options.onError?.(event, error);
        const exhausted = event.attempts >= event.maxAttempts;
        const delay = (this.options.retryDelayMs ?? defaultRetryDelay)(event.attempts);
        await this.db
          .update(outboxEvents)
          .set({
            status: exhausted ? 'failed' : 'pending',
            availableAt: exhausted ? event.availableAt : new Date(this.now().getTime() + delay),
            lockedAt: null,
            lockedBy: null,
            lastError: describeError(error),
          })
          .where(and(eq(outboxEvents.id, id), eq(outboxEvents.lockedBy, this.workerId)));
        if (exhausted) outcome.failed += 1;
        else outcome.retried += 1;
      }
    }
    return outcome;
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 2000);
}

/** Starts polling; returns a stop function that waits for the in-flight batch. */
export function startOutboxPolling(
  dispatcher: OutboxDispatcher,
  intervalMs: number,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    inFlight = dispatcher
      .dispatchBatch()
      .catch(onError)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  let timer = setTimeout(tick, intervalMs);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await inFlight;
  };
}
