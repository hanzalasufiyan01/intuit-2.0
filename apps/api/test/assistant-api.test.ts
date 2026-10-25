import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantProvider, ProviderInput } from '../src/application/assistant/types.js';
import { buildSummaries, type SummarySources } from '../src/application/assistant/summaries.js';
import { AssistantProviderError } from '../src/application/assistant/types.js';
import type { AuthorizationContext } from '../src/application/authorization.js';
import { inTransaction } from '../src/application/unit-of-work.js';
import { joinWithRole, setUpAccountingOrg } from './fixtures.js';
import { createTestContext, type TestContext } from './helpers.js';

/**
 * The help assistant and tutorial progress over HTTP, against the real database. The provider is a
 * fake: no network and no key are ever used. Covers authentication, validation, tenant isolation,
 * permissions on financial figures, fallback when the provider fails, rate limits, audit and logs.
 */

class FakeProvider implements AssistantProvider {
  readonly name = 'fake';
  readonly mode = 'ai' as const;
  calls: ProviderInput[] = [];
  failWith: AssistantProviderError | null = null;
  async answer(input: ProviderInput) {
    this.calls.push(input);
    if (this.failWith) throw this.failWith;
    return { text: 'Model wording.' };
  }
}

const provider = new FakeProvider();
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext(
    { ASSISTANT_USER_PER_MINUTE: '5', ASSISTANT_ORG_PER_MINUTE: '50' },
    { assistantProvider: provider },
  );
});
afterAll(() => ctx.close());

const ask = (client: ReturnType<TestContext['client']>, body: object) =>
  client.post('/assistant/messages', body);

describe('authentication and validation', () => {
  it('needs a session on every route', async () => {
    const anon = ctx.client();
    const id = 'welcome';
    expect((await anon.get('/assistant/status')).status).toBe(401);
    expect((await ask(anon, { message: 'hi' })).status).toBe(401);
    expect((await anon.get('/tutorials/progress')).status).toBe(401);
    expect(
      (await anon.put(`/tutorials/progress/${id}`, { status: 'in_progress', step: 0 })).status,
    ).toBe(401);
    expect((await anon.delete(`/tutorials/progress/${id}`)).status).toBe(401);
  });

  it('rejects malformed questions', async () => {
    const { owner } = await setUpAccountingOrg(ctx);
    expect((await ask(owner, {})).status).toBe(400);
    expect((await ask(owner, { message: '' })).status).toBe(400);
    expect((await ask(owner, { message: 'x'.repeat(2001) })).status).toBe(400);
    expect((await ask(owner, { message: 'hi', extra: 1 })).status).toBe(400);
    expect(
      (await ask(owner, { message: 'hi', history: [{ role: 'system', content: 'x' }] })).status,
    ).toBe(400);
    expect(
      (
        await ask(owner, {
          message: 'hi',
          history: Array.from({ length: 11 }, () => ({ role: 'user', content: 'x' })),
        })
      ).status,
    ).toBe(400);
    // Only whitespace and control characters is not a question.
    expect((await ask(owner, { message: ' \u0000 ' })).status).toBe(400);
  });
});

describe('answers', () => {
  it('reports its mode and answers without any financial write', async () => {
    const { owner } = await setUpAccountingOrg(ctx);
    const status = await owner.get('/assistant/status');
    expect(status.status).toBe(200);
    expect(status.body.data.mode).toBe('ai');
    expect(JSON.stringify(status.body)).not.toMatch(/key|secret/i);

    provider.calls = [];
    const res = await ask(owner, {
      message: 'How do I create an invoice?',
      path: '/sales/invoices/abc',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ reply: 'Model wording.', mode: 'ai', degraded: false });
    expect(res.body.data.sources[0].topicId).toBe('invoices');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.figures).toEqual([]);
    // The raw path never reaches the provider, only the fixed page label.
    expect(JSON.stringify(provider.calls[0])).not.toContain('abc');
  });

  it('falls back to the help catalogue, with a notice, when the provider fails', async () => {
    const { owner } = await setUpAccountingOrg(ctx);
    provider.failWith = new AssistantProviderError('unavailable');
    try {
      const res = await ask(owner, { message: 'How do I create an invoice?' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ mode: 'documentation', degraded: true });
      expect(res.body.data.notice).toContain('built-in help catalogue');
      expect(res.body.data.reply.length).toBeGreaterThan(20);
    } finally {
      provider.failWith = null;
    }
  });

  it('reads figures through the reports for a permitted member and audits it', async () => {
    const org = await setUpAccountingOrg(ctx);
    provider.calls = [];
    const res = await ask(org.owner, { message: 'What is our net profit this year?' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.figures.map((f: { id: string }) => f.id)).toEqual(['profit_and_loss']);
    expect(provider.calls[0]!.figures).toHaveLength(1);
    const audit = await org.owner.get('/organizations/current/audit-events?limit=50');
    expect(audit.status).toBe(200);
    const shown = audit.body.data.filter(
      (e: { action: string }) => e.action === 'assistant.financial_summary_shown',
    );
    expect(shown).toHaveLength(1);
    // Kinds only: no amounts and no question text.
    expect(shown[0].metadata).toEqual({ kinds: ['profit_and_loss'], mode: 'ai' });
  });

  it('withholds figures from a member without the report permission', async () => {
    const org = await setUpAccountingOrg(ctx);
    const role = await org.owner.post('/organizations/current/roles', {
      name: 'Assistant no reports',
      permissionKeys: ['webhooks.view'],
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const member = await joinWithRole(ctx, org.owner, 'Assistant no reports');
    provider.calls = [];
    const res = await ask(member.client, { message: 'What is our net profit this year?' });
    expect(res.status).toBe(200);
    expect(res.body.data.figures).toEqual([]);
    expect(res.body.data.unavailable).toEqual([
      expect.objectContaining({ id: 'profit_and_loss', reason: 'no_permission' }),
    ]);
    expect(provider.calls[0]!.figures).toEqual([]);
  });
});

describe('tutorial progress', () => {
  it('is per member and per organization', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    const put = await a.owner.put('/tutorials/progress/welcome', {
      status: 'in_progress',
      step: 2,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.progress).toMatchObject({
      tutorialId: 'welcome',
      status: 'in_progress',
      currentStep: 2,
    });
    const done = await a.owner.put('/tutorials/progress/welcome', { status: 'completed', step: 5 });
    expect(done.body.data.progress.completedAt).not.toBeNull();
    const again = await a.owner.put('/tutorials/progress/welcome', {
      status: 'in_progress',
      step: 0,
    });
    expect(again.body.data.progress.completedAt).toBeNull();

    expect((await a.owner.get('/tutorials/progress')).body.data.items).toHaveLength(1);
    expect((await b.owner.get('/tutorials/progress')).body.data.items).toEqual([]);

    // Another member of the same organization has their own progress.
    const colleague = await joinWithRole(ctx, a.owner, 'Administrator');
    expect((await colleague.client.get('/tutorials/progress')).body.data.items).toEqual([]);

    const reset = await a.owner.delete('/tutorials/progress/welcome');
    expect(reset.body.data.reset).toBe(true);
    expect((await a.owner.delete('/tutorials/progress/welcome')).body.data.reset).toBe(false);
  });

  it('validates the identifier, status and step', async () => {
    const { owner } = await setUpAccountingOrg(ctx);
    expect(
      (await owner.put('/tutorials/progress/Bad_Id', { status: 'in_progress', step: 0 })).status,
    ).toBe(400);
    expect(
      (await owner.put('/tutorials/progress/welcome', { status: 'done', step: 0 })).status,
    ).toBe(400);
    expect(
      (await owner.put('/tutorials/progress/welcome', { status: 'completed', step: -1 })).status,
    ).toBe(400);
    expect(
      (await owner.put('/tutorials/progress/welcome', { status: 'completed', step: 101 })).status,
    ).toBe(400);
    expect(
      (await owner.put('/tutorials/progress/welcome', { status: 'completed', step: 1, extra: 1 }))
        .status,
    ).toBe(400);
  });
});

describe('limits and logs', () => {
  it('limits each member per minute and says when to retry', async () => {
    const { owner } = await setUpAccountingOrg(ctx);
    let limited = null as Awaited<ReturnType<typeof ask>> | null;
    for (let i = 0; i < 8 && !limited; i += 1) {
      const res = await ask(owner, { message: 'What can each role do?' });
      if (res.status === 429) limited = res;
    }
    expect(limited, 'a 429 within 8 requests at 5 per minute').not.toBeNull();
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('never writes the question or the answer to the logs', async () => {
    const { owner } = await setUpAccountingOrg(ctx);
    const marker = `marker-${randomUUID()}`;
    provider.failWith = new AssistantProviderError('timeout');
    try {
      await ask(owner, { message: `How do I create an invoice? ${marker}` });
    } finally {
      provider.failWith = null;
    }
    expect(ctx.logs.join('\n')).not.toContain(marker);
  });
});

describe('a failing report does not poison the transaction (real PostgreSQL)', () => {
  const allReports = {
    userId: 'u',
    sessionId: 's',
    organizationId: 'o',
    membershipId: 'm',
    isOwner: false,
    roleIds: [],
    permissions: new Set(['sales.reports.view', 'purchases.reports.view']),
  } as AuthorizationContext;

  const sources = (tx: never): SummarySources => ({
    reports: {
      profitAndLossInTransaction: async () => {
        throw new Error('not used');
      },
    },
    arReports: {
      // A real database error (division by zero) inside the shared transaction.
      agingInTransaction: async () => {
        await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(sql`SELECT 1 / 0`);
        return { baseCurrency: 'MVR', totals: {} };
      },
    },
    apReports: {
      agingInTransaction: async () => {
        await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(sql`SELECT 1`);
        return { baseCurrency: 'MVR', totals: { total: '7.0000' } };
      },
    },
  });

  it('premise: without a savepoint an error leaves the transaction unusable', async () => {
    await expect(
      inTransaction(ctx.database.db, {}, async (tx) => {
        await tx.execute(sql`SELECT 1 / 0`).catch(() => undefined);
        await tx.execute(sql`SELECT 1`);
      }),
    ).rejects.toThrow(/Failed query/);
  });

  it('keeps the other figures and a usable transaction for the audit write', async () => {
    const outcome = await inTransaction(ctx.database.db, {}, async (tx) => {
      const result = await buildSummaries(
        ['receivables', 'payables'],
        sources(tx as never),
        tx,
        allReports,
        '2026-10-25',
      );
      // The service writes its audit event next, in this same transaction: it must still work.
      const check = await tx.execute<{ ok: number }>(sql`SELECT 1 AS ok`);
      return { result, ok: check.rows[0]!.ok };
    });
    expect(outcome.ok).toBe(1);
    expect(outcome.result.figures.map((f) => f.id)).toEqual(['payables']);
    expect(outcome.result.figures[0]!.rows[0]!.display).toBe('7.00');
    expect(outcome.result.unavailable).toEqual([
      expect.objectContaining({ id: 'receivables', reason: 'not_available' }),
    ]);
  });

  it('does not recover a privilege error: it propagates and ends the transaction', async () => {
    await expect(
      inTransaction(ctx.database.db, {}, async (tx) =>
        buildSummaries(
          ['receivables'],
          {
            ...sources(tx as never),
            arReports: {
              agingInTransaction: async () => {
                // Reading a table the application role may not read: insufficient_privilege.
                await tx.execute(sql`SELECT * FROM schema_migrations`);
                return { baseCurrency: 'MVR', totals: {} };
              },
            },
          },
          tx,
          allReports,
          '2026-10-25',
        ),
      ),
    ).rejects.toBeDefined();
  });
});

describe('the organization budget is spent only by current members', () => {
  it('lets a disabled member neither use the assistant nor spend the organization budget', async () => {
    const org = await setUpAccountingOrg(ctx);
    const member = await joinWithRole(ctx, org.owner, 'Administrator');
    const key = `assistant:o:${org.organizationId}`;
    const limit = ctx.config.assistant.orgPerMinute;
    const remaining = async () => (await ctx.services.rateLimiter.peek(key, limit)).remaining;
    expect(await remaining()).toBe(limit);

    // While a member, a question spends one unit of the organization's budget.
    expect((await ask(member.client, { message: 'What can each role do?' })).status).toBe(200);
    expect(await remaining()).toBe(limit - 1);

    const disabled = await org.owner.patch(
      `/organizations/current/members/${member.membershipId}`,
      { status: 'disabled' },
    );
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);

    // The session still names the organization, but the membership is no longer active.
    for (let i = 0; i < 3; i += 1) {
      const refused = await ask(member.client, { message: 'What can each role do?' });
      expect([401, 403], JSON.stringify(refused.body)).toContain(refused.status);
    }
    expect(await remaining()).toBe(limit - 1);

    // The organization's remaining members are unaffected.
    expect((await ask(org.owner, { message: 'What can each role do?' })).status).toBe(200);
    expect(await remaining()).toBe(limit - 2);
  });

  it('never counts a question for an organization other than the member current one', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    const keyB = `assistant:o:${b.organizationId}`;
    const limit = ctx.config.assistant.orgPerMinute;
    expect((await ask(a.owner, { message: 'What can each role do?' })).status).toBe(200);
    expect((await ctx.services.rateLimiter.peek(keyB, limit)).remaining).toBe(limit);
  });
});
