import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setDbContext } from '../src/application/unit-of-work.js';
import { requestFingerprint } from '../src/modules/idempotency/index.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/** Phase 3B step 1: the reusable request-idempotency store (Decision 23). */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

async function actor() {
  const client = ctx.client();
  const { session } = await client.register();
  return {
    organizationId: session.activeOrganization.id as string,
    userId: session.user.id as string,
  };
}

function run<T>(
  who: { organizationId: string; userId: string },
  input: { key: string | null; scope?: string; request: unknown },
  work: () => Promise<T>,
) {
  return inTransaction(ctx.database.db, who, async (tx) => {
    await setDbContext(tx, who);
    return ctx.services.idempotency.run(
      tx,
      who,
      { key: input.key, scope: input.scope ?? 'test.operation', request: input.request },
      work,
    );
  });
}

describe('request fingerprint', () => {
  it('ignores key order and undefined fields but not values', () => {
    expect(requestFingerprint({ a: 1, b: [1, { c: 2, d: undefined }] })).toBe(
      requestFingerprint({ b: [1, { c: 2 }], a: 1 }),
    );
    expect(requestFingerprint({ a: 1 })).not.toBe(requestFingerprint({ a: 2 }));
  });
});

describe('idempotent execution', () => {
  it('runs once per key and replays the stored response', async () => {
    const who = await actor();
    let calls = 0;
    const work = async () => ({ id: `doc-${++calls}`, when: new Date('2026-09-30T00:00:00Z') });
    const key = randomUUID();
    const first = await run(who, { key, request: { amount: '10.00' } }, work);
    const second = await run(who, { key, request: { amount: '10.00' } }, work);
    expect(first).toEqual({
      value: { id: 'doc-1', when: '2026-09-30T00:00:00.000Z' },
      replayed: false,
    });
    expect(second).toEqual({ value: first.value, replayed: true });
    expect(calls).toBe(1);
    // No key: every call runs.
    await run(who, { key: null, request: {} }, work);
    await run(who, { key: null, request: {} }, work);
    expect(calls).toBe(3);
    // The same key in another scope is a different operation.
    await run(who, { key, scope: 'test.other', request: { amount: '10.00' } }, work);
    expect(calls).toBe(4);
  });

  it('refuses a key reused for another request or by another user', async () => {
    const who = await actor();
    const key = randomUUID();
    await run(who, { key, request: { amount: '10.00' } }, async () => 'ok');
    await expect(
      run(who, { key, request: { amount: '11.00' } }, async () => 'other'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const colleague = { ...who, userId: (await actor()).userId };
    await expect(
      run(colleague, { key, request: { amount: '10.00' } }, async () => 'ok'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('stores nothing when the operation fails, so a retry runs again', async () => {
    const who = await actor();
    const key = randomUUID();
    await expect(
      run(who, { key, request: {} }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const retried = await run(who, { key, request: {} }, async () => 'second try');
    expect(retried).toEqual({ value: 'second try', replayed: false });
  });

  it('executes concurrent duplicates once', async () => {
    const who = await actor();
    const key = randomUUID();
    let calls = 0;
    const slow = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { n: calls };
    };
    const results = await Promise.all([
      run(who, { key, request: { x: 1 } }, slow),
      run(who, { key, request: { x: 1 } }, slow),
      run(who, { key, request: { x: 1 } }, slow),
    ]);
    expect(calls).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => JSON.stringify(r.value))).size).toBe(1);
  });
});

describe('database protections', () => {
  it('keeps keys immutable, deletes only expired ones, isolates tenants and purges', async () => {
    const who = await actor();
    const other = await actor();
    const key = randomUUID();
    await run(who, { key, request: {} }, async () => ({ ok: true }));
    const app = await connectAs('app');
    const owner = await connectAs('owner');
    try {
      const inTenant = async (organizationId: string, statement: string) => {
        await app.query('BEGIN');
        try {
          await app.query(`SELECT set_config('app.organization_id', $1, true)`, [organizationId]);
          return await app.query(statement);
        } finally {
          await app.query('ROLLBACK');
        }
      };
      await expect(
        inTenant(
          who.organizationId,
          `UPDATE idempotency_keys SET response = '{"ok":false}' WHERE idempotency_key = '${key}'`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        inTenant(
          who.organizationId,
          `DELETE FROM idempotency_keys WHERE idempotency_key = '${key}'`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const hidden = await inTenant(
        other.organizationId,
        `SELECT count(*)::int AS n FROM idempotency_keys WHERE idempotency_key = '${key}'`,
      );
      expect(hidden.rows[0].n).toBe(0);

      // An expired key is purged by the housekeeping function; a live one stays.
      const expired = randomUUID();
      await owner.query(
        `INSERT INTO idempotency_keys (organization_id, user_id, scope, idempotency_key, request_hash,
           response, created_at, completed_at, expires_at)
         VALUES ($1, $2, 'test.operation', $3, repeat('a', 64), '{}', now() - interval '2 days',
                 now() - interval '2 days', now() - interval '1 day')`,
        [who.organizationId, who.userId, expired],
      );
      await ctx.services.idempotency.purgeExpired();
      const { rows } = await owner.query(
        `SELECT idempotency_key FROM idempotency_keys WHERE idempotency_key = ANY($1)`,
        [[key, expired]],
      );
      expect(rows.map((r) => r.idempotency_key)).toEqual([key]);
    } finally {
      await app.end();
      await owner.end();
    }
  });
});
