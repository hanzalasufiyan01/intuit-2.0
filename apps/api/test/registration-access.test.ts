import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  randomIp,
  tokenFromEmail,
  TEST_PASSWORD,
  uniqueEmail,
  type TestContext,
} from './helpers.js';

/**
 * Registration access over HTTP (REGISTRATION_MODE), against the real database. Three application
 * instances share the database and differ only in their mode: open (the default), closed, and
 * code. Covers the public policy endpoint, refusals, the access code check, invitations in closed
 * mode, the attempt limit, and that the code never appears in a response, a cookie or a log.
 * Needs the test database like every API test file.
 */

const CODE = `review-code-${randomUUID()}`;
let open: TestContext;
let closed: TestContext;
let coded: TestContext;

beforeAll(async () => {
  open = await createTestContext();
  closed = await createTestContext({ REGISTRATION_MODE: 'closed' });
  coded = await createTestContext({ REGISTRATION_MODE: 'code', REGISTRATION_ACCESS_CODE: CODE });
});
afterAll(async () => {
  await open.close();
  await closed.close();
  await coded.close();
});

const account = () => ({
  email: uniqueEmail(),
  password: TEST_PASSWORD,
  displayName: 'Test User',
  organizationName: `Org ${randomUUID().slice(0, 8)}`,
});

describe('the public policy endpoint', () => {
  it('needs no session and reports only the mode', async () => {
    for (const [ctx, mode] of [
      [open, 'open'],
      [closed, 'closed'],
      [coded, 'code'],
    ] as const) {
      const res = await ctx.client().get('/auth/registration-policy');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { mode } });
    }
    const leaked = JSON.stringify((await coded.client().get('/auth/registration-policy')).body);
    expect(leaked).not.toContain(CODE);
  });
});

describe('open mode (default)', () => {
  it('still registers without any code, and ignores one if sent', async () => {
    expect((await open.client().post('/auth/register', account())).status).toBe(201);
    const withCode = await open.client().post('/auth/register', { ...account(), accessCode: 'x' });
    expect(withCode.status).toBe(201);
  });
});

describe('closed mode', () => {
  it('refuses registration, even with a code, and creates nothing', async () => {
    const input = account();
    const res = await closed.client().post('/auth/register', { ...input, accessCode: CODE });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Registration is closed.');
    // No account exists: the same address can still sign in nowhere.
    expect((await closed.client().login(input.email)).status).toBe(401);
  });

  it('refuses before the body is read: an invalid body is also a 403', async () => {
    const res = await closed.client().post('/auth/register', { email: 'not-an-email' });
    expect(res.status).toBe(403);
  });

  it('leaves invitations untouched: an invited person can accept and sign in', async () => {
    // The owner and the invitation are made through the open instance (same database).
    const owner = open.client();
    await owner.register();
    const roles = (await owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    const role = roles.find((r) => r.name === 'Member')!;
    const email = uniqueEmail('invited');
    expect(
      (await owner.post('/organizations/current/invitations', { email, roleId: role.id })).status,
    ).toBe(201);
    const token = tokenFromEmail(open.email, email);

    const invitee = closed.client();
    const accepted = await invitee.post('/invitations/accept', {
      token,
      displayName: 'Invited Person',
      password: TEST_PASSWORD,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const again = closed.client();
    expect((await again.login(email)).status).toBe(200);
  });
});

describe('code mode', () => {
  it('refuses a missing and a wrong code with the same answer', async () => {
    const missing = await coded.client().post('/auth/register', account());
    const wrong = await coded
      .client()
      .post('/auth/register', { ...account(), accessCode: 'not-the-code-at-all' });
    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(missing.body.error.message).toBe(wrong.body.error.message);
    expect(JSON.stringify([missing.body, wrong.body])).not.toContain(CODE);
  });

  it('registers with the right code, and never returns or sets the code', async () => {
    const input = account();
    const client = coded.client();
    const res = await client.post('/auth/register', { ...input, accessCode: CODE });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(CODE);
    expect(JSON.stringify(res.headers)).not.toContain(CODE);
    // The new account is a normal one.
    expect((await client.get('/auth/session')).status).toBe(200);
  });

  it('limits guessing per address and says when to retry', async () => {
    const ip = randomIp();
    let limited = null as Awaited<ReturnType<ReturnType<TestContext['client']>['post']>> | null;
    for (let i = 0; i < 14 && !limited; i += 1) {
      const res = await coded
        .client(ip)
        .post('/auth/register', { ...account(), accessCode: `guess-${i}-0000000` });
      if (res.status === 429) limited = res;
      else expect(res.status).toBe(403);
    }
    expect(limited, 'a 429 within 14 wrong guesses from one address').not.toBeNull();
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Another address is not affected by it.
    const other = await coded
      .client(randomIp())
      .post('/auth/register', { ...account(), accessCode: CODE });
    expect(other.status).toBe(201);
  });

  it('never writes the code, or a guess, to the logs', async () => {
    const guess = `guess-${randomUUID()}`;
    await coded.client().post('/auth/register', { ...account(), accessCode: guess });
    await coded.client().post('/auth/register', { ...account(), accessCode: CODE });
    const logs = coded.logs.join('\n');
    expect(logs).not.toContain(CODE);
    expect(logs).not.toContain(guess);
  });
});
