import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEvents } from '../src/database/schema.js';
import {
  enqueueOutboxEvent,
  OutboxDispatcher,
  type OutboxEvent,
} from '../src/modules/outbox/index.js';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function enqueue(eventType: string, maxAttempts?: number): Promise<string> {
  return ctx.database.db.transaction((tx) =>
    enqueueOutboxEvent(
      tx,
      {
        eventType,
        aggregateType: 'test',
        aggregateId: randomUUID(),
        organizationId: null,
        payload: { hello: 'world' },
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
      },
      ctx.clock.now(),
    ),
  );
}

/** Dispatches until no due events remain (the shared dev database may hold a backlog). */
async function drain(dispatcher: OutboxDispatcher): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const result = await dispatcher.dispatchBatch();
    if (result.claimed === 0) return;
  }
}

async function load(id: string): Promise<OutboxEvent> {
  const [row] = await ctx.database.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
  if (!row) throw new Error('outbox event missing');
  return row;
}

describe('outbox', () => {
  it('persists events only when the surrounding transaction commits', async () => {
    const committed = await enqueue('test.committed');
    expect((await load(committed)).status).toBe('pending');

    const rolledBackId = await ctx.database.db
      .transaction(async (tx) => {
        const id = await enqueueOutboxEvent(
          tx,
          {
            eventType: 'test.rolled_back',
            aggregateType: 'test',
            aggregateId: 'x',
            organizationId: null,
            payload: {},
          },
          ctx.clock.now(),
        );
        throw Object.assign(new Error('rollback'), { id });
      })
      .catch((error: { id: string }) => error.id);
    const rows = await ctx.database.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, rolledBackId));
    expect(rows).toHaveLength(0);
  });

  it('business operations write outbox events in the same transaction', async () => {
    const client = ctx.client();
    const { session } = await client.register();
    const rows = await ctx.database.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, session.user.id));
    expect(rows.map((r) => r.eventType)).toContain('identity.user_registered');
    expect(JSON.stringify(rows)).not.toMatch(/password|token/i);
  });

  it('delivers events to subscribers and marks them processed', async () => {
    const type = `test.delivered_${randomUUID().replaceAll('-', '')}`;
    const id = await enqueue(type);
    const seen: string[] = [];
    const dispatcher = new OutboxDispatcher(ctx.database.db, {
      batchSize: 500,
      now: () => ctx.clock.now(),
    });
    dispatcher.subscribe(type, async (event) => {
      seen.push(event.id);
    });
    await drain(dispatcher);
    expect(seen).toEqual([id]);
    const event = await load(id);
    expect(event.status).toBe('processed');
    expect(event.attempts).toBe(1);
    expect(event.processedAt).not.toBeNull();
    expect(event.lockedAt).toBeNull();
  });

  it('retries failures with back-off and marks exhausted events failed', async () => {
    const type = `test.flaky_${randomUUID().replaceAll('-', '')}`;
    const id = await enqueue(type, 2);
    const dispatcher = new OutboxDispatcher(ctx.database.db, {
      batchSize: 500,
      now: () => ctx.clock.now(),
      retryDelayMs: () => 30_000,
    });
    dispatcher.subscribe(type, async () => {
      throw new Error('downstream unavailable');
    });

    await drain(dispatcher);
    let event = await load(id);
    expect(event.status).toBe('pending');
    expect(event.attempts).toBe(1);
    expect(event.lastError).toContain('downstream unavailable');
    expect(event.availableAt.getTime()).toBeGreaterThan(ctx.clock.now().getTime());

    // Not yet due: not claimed again.
    await drain(dispatcher);
    expect((await load(id)).attempts).toBe(1);

    ctx.clock.advance(31_000);
    await drain(dispatcher);
    event = await load(id);
    expect(event.status).toBe('failed');
    expect(event.attempts).toBe(2);
    expect(event.processedAt).toBeNull();
  });

  it('reclaims events whose worker lock went stale', async () => {
    const type = `test.stale_${randomUUID().replaceAll('-', '')}`;
    const id = await enqueue(type);
    await ctx.database.db
      .update(outboxEvents)
      .set({
        status: 'processing',
        lockedAt: new Date(ctx.clock.now().getTime() - 10 * 60_000),
        lockedBy: 'dead-worker',
        attempts: 1,
      })
      .where(eq(outboxEvents.id, id));
    const dispatcher = new OutboxDispatcher(ctx.database.db, {
      batchSize: 500,
      now: () => ctx.clock.now(),
    });
    await drain(dispatcher);
    const event = await load(id);
    expect(event.status).toBe('processed');
    expect(event.attempts).toBe(2);
  });
});
