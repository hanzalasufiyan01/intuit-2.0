import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  TEST_PASSWORD,
  tokenFromEmail,
  uniqueEmail,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('API conventions', () => {
  it('reports health including the database', async () => {
    const response = await ctx.client().get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: 'ok', database: 'ok' } });
  });

  it('returns a request id on every response and reuses a well-formed incoming one', async () => {
    const generated = await ctx.client().get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const incoming = await ctx.client().request('GET', '/health', undefined, {
      'x-request-id': 'trace-abc-12345',
    });
    expect(incoming.headers['x-request-id']).toBe('trace-abc-12345');

    const malformed = await ctx.client().request('GET', '/health', undefined, {
      'x-request-id': 'bad id with spaces',
    });
    expect(malformed.headers['x-request-id']).not.toBe('bad id with spaces');
  });

  it('uses a consistent error envelope that includes the request id', async () => {
    const response = await ctx.client().get('/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
        requestId: response.headers['x-request-id'],
      },
    });
  });

  it('validates request bodies and reports field-level issues', async () => {
    const response = await ctx.client().post('/auth/register', {
      email: 'not-an-email',
      password: '',
      displayName: '',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    const paths = response.body.error.details.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining(['email', 'password', 'displayName', 'organizationName']),
    );
  });

  it('validates path parameters', async () => {
    const client = ctx.client();
    await client.register();
    const response = await client.patch('/organizations/current/members/not-a-uuid', {
      status: 'disabled',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details.issues[0].path).toBe('membershipId');
  });

  it('rejects non-JSON bodies and malformed JSON without leaking internals', async () => {
    const wrongType = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: 'email=a',
    });
    expect(wrongType.statusCode).toBe(415);
    expect(JSON.parse(wrongType.body).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const malformed = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(malformed.statusCode).toBe(400);
    const body = JSON.parse(malformed.body);
    expect(body.error.code).toBe('MALFORMED_REQUEST');
    expect(malformed.body).not.toMatch(/stack|SyntaxError|at .*\.js/);
  });

  it('hides internal errors behind a generic 500', async () => {
    const original = ctx.services.organizations.listMyOrganizations.bind(
      ctx.services.organizations,
    );
    ctx.services.organizations.listMyOrganizations = () => {
      throw new Error('relation "secret_table" does not exist');
    };
    try {
      const client = ctx.client();
      await client.register();
      const response = await client.get('/organizations');
      expect(response.status).toBe(500);
      expect(response.body.error).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        requestId: response.headers['x-request-id'],
      });
      expect(JSON.stringify(response.body)).not.toContain('secret_table');
    } finally {
      ctx.services.organizations.listMyOrganizations = original;
    }
  });

  it('sets protective response headers', async () => {
    const response = await ctx.client().get('/health');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('requires authentication on protected routes', async () => {
    for (const url of [
      '/organizations',
      '/organizations/current',
      '/organizations/current/members',
      '/organizations/current/roles',
      '/organizations/current/audit-events',
      '/permissions',
      '/auth/sessions',
    ]) {
      const response = await ctx.client().get(url);
      expect(response.status, url).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('ignores forged or unknown session cookies', async () => {
    const client = ctx.client();
    client.sessionToken = 'forged-session-token-value-0000000000000000';
    const response = await client.get('/auth/session');
    expect(response.status).toBe(401);
  });
});

describe('logging', () => {
  it('never writes passwords, tokens or cookies to the logs', async () => {
    ctx.logs.length = 0;
    const client = ctx.client();
    const { email } = await client.register();
    const sessionToken = client.sessionToken!;
    await client.login(email, 'a wrong password attempt');
    await client.get('/auth/session');

    await ctx.client().post('/auth/password-reset/request', { email });
    const resetToken = tokenFromEmail(ctx.email, email);
    await ctx.client().post('/auth/password-reset/complete', {
      token: resetToken,
      newPassword: 'the replacement passphrase',
    });

    const owner = ctx.client();
    await owner.register();
    const roles = (await owner.get('/organizations/current/roles')).body.data;
    const inviteeEmail = uniqueEmail();
    await owner.post('/organizations/current/invitations', {
      email: inviteeEmail,
      roleId: roles.find((r: { name: string }) => r.name === 'Member').id,
    });
    const invitationToken = tokenFromEmail(ctx.email, inviteeEmail);
    await ctx.client().post('/invitations/accept', {
      token: invitationToken,
      displayName: 'Invitee',
      password: TEST_PASSWORD,
    });

    const logText = ctx.logs.join('\n');
    expect(ctx.logs.length).toBeGreaterThan(10);
    expect(logText).toContain('"reqId"');
    for (const secret of [
      TEST_PASSWORD,
      'a wrong password attempt',
      'the replacement passphrase',
      sessionToken,
      resetToken,
      invitationToken,
      client.csrfToken ?? 'no-csrf',
    ]) {
      expect(logText).not.toContain(secret);
    }
  });
});
