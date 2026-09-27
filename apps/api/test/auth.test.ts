import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectAs,
  createTestContext,
  DAY,
  MINUTE,
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

async function securityEvents(userId: string): Promise<string[]> {
  const db = await connectAs('owner');
  try {
    const { rows } = await db.query<{ event_type: string }>(
      'SELECT event_type FROM security_events WHERE user_id = $1 ORDER BY occurred_at, id',
      [userId],
    );
    return rows.map((r) => r.event_type);
  } finally {
    await db.end();
  }
}

describe('registration', () => {
  it('creates a user, an organization, an Owner membership and a session', async () => {
    const client = ctx.client();
    const { email, session } = await client.register({ organizationName: 'Acme Maldives' });

    expect(session.user.email).toBe(email);
    expect(session.csrfToken).toEqual(expect.any(String));
    expect(session.organizations).toHaveLength(1);
    expect(session.activeOrganization).toMatchObject({ name: 'Acme Maldives', isOwner: true });
    expect(session.activeOrganization.permissions).toEqual(
      expect.arrayContaining(['organization.read', 'members.manage', 'roles.manage', 'audit.read']),
    );

    const cookie = client.sessionToken;
    expect(cookie).toBeDefined();
    const me = await client.get('/auth/session');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email);
  });

  it('sets an httpOnly, SameSite=Strict session cookie and never stores the raw token', async () => {
    const client = ctx.client();
    const response = await client.post('/auth/register', {
      email: uniqueEmail(),
      password: TEST_PASSWORD,
      displayName: 'Cookie Check',
      organizationName: 'Cookie Org',
    });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain(`${ctx.config.session.cookieName}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);

    const db = await connectAs('owner');
    try {
      // Only the SHA-256 of the cookie value is stored.
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM sessions WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
        [client.sessionToken],
      );
      expect(rows[0].n).toBe(1);
      const raw = await db.query(
        `SELECT count(*)::int AS n FROM sessions s WHERE row_to_json(s)::text LIKE '%' || $1 || '%'`,
        [client.sessionToken],
      );
      expect(raw.rows[0].n).toBe(0);
    } finally {
      await db.end();
    }
  });

  it('marks the cookie Secure in production-like environments', async () => {
    const prod = await createTestContext({ APP_ENV: 'staging' });
    try {
      const response = await prod.client().post('/auth/register', {
        email: uniqueEmail(),
        password: TEST_PASSWORD,
        displayName: 'Secure Cookie',
        organizationName: 'Secure Org',
      });
      expect(response.status).toBe(201);
      expect(String(response.headers['set-cookie'])).toMatch(/Secure/);
    } finally {
      await prod.close();
    }
  });

  it('rejects a duplicate email and weak passwords', async () => {
    const client = ctx.client();
    const { email } = await client.register();
    const duplicate = await ctx.client().post('/auth/register', {
      email: email.toUpperCase(),
      password: TEST_PASSWORD,
      displayName: 'Dup',
      organizationName: 'Dup Org',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EMAIL_UNAVAILABLE');

    const weak = await ctx.client().post('/auth/register', {
      email: uniqueEmail(),
      password: 'short-pass',
      displayName: 'Weak',
      organizationName: 'Weak Org',
    });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_FAILED');
    expect(weak.body.error.details.issues[0].path).toBe('password');
  });

  it('stores passwords as Argon2id hashes', async () => {
    const client = ctx.client();
    const { email } = await client.register();
    const db = await connectAs('owner');
    try {
      const { rows } = await db.query(
        'SELECT password_hash FROM users WHERE email_normalized = $1',
        [email],
      );
      expect(rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(rows[0].password_hash).not.toContain(TEST_PASSWORD);
    } finally {
      await db.end();
    }
  });
});

describe('login and logout', () => {
  it('logs in with valid credentials and records a security event', async () => {
    const { email, session } = await ctx.client().register();
    const client = ctx.client();
    const response = await client.login(email);
    expect(response.status).toBe(200);
    expect(response.body.data.user.email).toBe(email);
    expect(response.body.data.activeOrganization.id).toBe(session.activeOrganization.id);
    expect(await securityEvents(session.user.id)).toContain('auth.login_succeeded');
  });

  it('rejects invalid credentials with a generic error', async () => {
    const { email, session } = await ctx.client().register();
    const wrongPassword = await ctx.client().login(email, 'not the right password');
    const unknownUser = await ctx.client().login(uniqueEmail(), 'not the right password');
    for (const response of [wrongPassword, unknownUser]) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(response.body.error.message).toBe('The email or password is incorrect.');
    }
    expect(await securityEvents(session.user.id)).toContain('auth.login_failed');
  });

  it('logout revokes the session immediately', async () => {
    const client = ctx.client();
    await client.register();
    const token = client.sessionToken!;
    const csrf = client.csrfToken!;

    const logout = await client.post('/auth/logout');
    expect(logout.status).toBe(204);
    expect(client.sessionToken).toBeUndefined();

    // Replaying the old cookie no longer works.
    client.sessionToken = token;
    client.csrfToken = csrf;
    const after = await client.get('/auth/session');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('requires authentication for session endpoints', async () => {
    const response = await ctx.client().get('/auth/session');
    expect(response.status).toBe(401);
  });
});

describe('login protection', () => {
  it('throttles after 5 failures per account with progressive back-off (no permanent lockout)', async () => {
    const { email } = await ctx.client().register();
    const attacker = ctx.client();
    for (let i = 0; i < 5; i += 1) {
      expect((await attacker.login(email, `wrong password ${i}`)).status).toBe(401);
    }
    const throttled = await attacker.login(email);
    expect(throttled.status).toBe(429);
    expect(throttled.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);

    // A different IP is throttled too: failures are also counted per account.
    expect((await ctx.client().login(email)).status).toBe(429);

    // After the first back-off (60s) another failure doubles it (120s).
    ctx.clock.advance(61_000);
    expect((await attacker.login(email, 'wrong again')).status).toBe(401);
    const second = await attacker.login(email);
    expect(second.status).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(60);

    // Once failures age out of the 15-minute window the account works again.
    ctx.clock.advance(16 * MINUTE);
    expect((await attacker.login(email)).status).toBe(200);
  });

  it('throttles per IP address across different accounts', async () => {
    const attacker = ctx.client();
    for (let i = 0; i < 5; i += 1) {
      expect((await attacker.login(uniqueEmail(), 'wrong password')).status).toBe(401);
    }
    const { email } = await ctx.client().register();
    const response = await attacker.login(email);
    expect(response.status).toBe(429);
  });
});

describe('session expiry and revocation', () => {
  it('expires after 30 minutes of inactivity', async () => {
    const client = ctx.client();
    await client.register();
    ctx.clock.advance(29 * MINUTE);
    expect((await client.get('/auth/session')).status).toBe(200);
    ctx.clock.advance(29 * MINUTE); // activity above reset the idle timer
    expect((await client.get('/auth/session')).status).toBe(200);
    ctx.clock.advance(31 * MINUTE);
    const expired = await client.get('/auth/session');
    expect(expired.status).toBe(401);
  });

  it('expires after the 7-day absolute lifetime even when active', async () => {
    const client = ctx.client();
    const { session } = await client.register();
    // Simulates continuous activity (fresh last_seen_at) so only the absolute lifetime applies.
    const markActive = async () => {
      const db = await connectAs('owner');
      try {
        await db.query('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [
          new Date(ctx.clock.now().getTime() - MINUTE),
          session.session.id,
        ]);
      } finally {
        await db.end();
      }
    };

    ctx.clock.advance(7 * DAY - 10 * MINUTE);
    await markActive();
    expect((await client.get('/auth/session')).status).toBe(200);

    ctx.clock.advance(11 * MINUTE);
    await markActive();
    expect((await client.get('/auth/session')).status).toBe(401);
  });

  it('revoking another session takes effect immediately and requires recent re-authentication', async () => {
    const { email } = await ctx.client().register();
    const laptop = ctx.client();
    const phone = ctx.client();
    await laptop.login(email);
    await phone.login(email);
    const phoneSessionId = (await phone.get('/auth/session')).body.data.session.id;

    ctx.clock.advance(16 * MINUTE);
    await laptop.get('/auth/session');
    await phone.get('/auth/session');
    const stale = await laptop.delete(`/auth/sessions/${phoneSessionId}`);
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');

    expect((await laptop.reauthenticate()).status).toBe(200);
    expect((await laptop.delete(`/auth/sessions/${phoneSessionId}`)).status).toBe(204);
    expect((await phone.get('/auth/session')).status).toBe(401);
    expect((await laptop.get('/auth/session')).status).toBe(200);
  });

  it('lists only the caller’s own active sessions', async () => {
    const client = ctx.client();
    await client.register();
    const response = await client.get('/auth/sessions');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].current).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(/token/i);
  });

  it('account disablement blocks login and revokes sessions', async () => {
    const client = ctx.client();
    const { email, session } = await client.register();
    const disabled = await ctx.services.auth.disableAccount(
      { userId: session.user.id, actorUserId: null, reason: 'test' },
      { requestId: null, ipAddress: null, userAgent: null },
    );
    expect(disabled).toBe(true);
    expect((await client.get('/auth/session')).status).toBe(401);
    const login = await ctx.client().login(email);
    expect(login.status).toBe(401);
    expect(await securityEvents(session.user.id)).toContain('account.disabled');
  });
});

describe('password reset', () => {
  it('responds identically for known and unknown emails', async () => {
    const { email } = await ctx.client().register();
    const known = await ctx.client().post('/auth/password-reset/request', { email });
    const unknown = await ctx
      .client()
      .post('/auth/password-reset/request', { email: uniqueEmail() });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
  });

  it('resets the password with a single-use token and revokes all sessions', async () => {
    const client = ctx.client();
    const { email, session } = await client.register();
    const other = ctx.client();
    await other.login(email);

    await ctx.client().post('/auth/password-reset/request', { email });
    const token = tokenFromEmail(ctx.email, email);

    const db = await connectAs('owner');
    try {
      const { rows } = await db.query(
        'SELECT token_hash FROM password_reset_tokens WHERE user_id = $1',
        [session.user.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash.toString('base64url')).not.toBe(token);
    } finally {
      await db.end();
    }

    const newPassword = 'a brand new passphrase';
    const reset = await ctx.client().post('/auth/password-reset/complete', { token, newPassword });
    expect(reset.status).toBe(200);

    // Existing sessions are revoked.
    expect((await client.get('/auth/session')).status).toBe(401);
    expect((await other.get('/auth/session')).status).toBe(401);

    // Old password no longer works; the new one does.
    expect((await ctx.client().login(email)).status).toBe(401);
    expect((await ctx.client().login(email, newPassword)).status).toBe(200);

    // Single use.
    const reuse = await ctx.client().post('/auth/password-reset/complete', {
      token,
      newPassword: 'yet another passphrase',
    });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_TOKEN');

    const events = await securityEvents(session.user.id);
    expect(events).toEqual(
      expect.arrayContaining(['auth.password_reset_requested', 'auth.password_reset_completed']),
    );
  });

  it('uses the approved 60-minute reset-token lifetime from configuration', async () => {
    // The repository .env and the application default must both carry the approved value.
    expect(ctx.config.password.resetTokenTtlMs).toBe(60 * MINUTE);
    const { email, session } = await ctx.client().register();
    const issuedAt = ctx.clock.now().getTime();
    await ctx.client().post('/auth/password-reset/request', { email });
    const db = await connectAs('owner');
    try {
      const { rows } = await db.query(
        'SELECT created_at, expires_at FROM password_reset_tokens WHERE user_id = $1',
        [session.user.id],
      );
      expect(rows[0].expires_at.getTime() - rows[0].created_at.getTime()).toBe(60 * MINUTE);
      expect(rows[0].created_at.getTime()).toBeGreaterThanOrEqual(issuedAt);
    } finally {
      await db.end();
    }
    expect(ctx.email.lastTo(email)?.text).toContain('valid for 60 minutes');
  });

  it('accepts a reset token just before its lifetime ends', async () => {
    const { email } = await ctx.client().register();
    await ctx.client().post('/auth/password-reset/request', { email });
    const token = tokenFromEmail(ctx.email, email);
    ctx.clock.advance(ctx.config.password.resetTokenTtlMs - MINUTE);
    const response = await ctx.client().post('/auth/password-reset/complete', {
      token,
      newPassword: 'just in time passphrase',
    });
    expect(response.status).toBe(200);
  });

  it('derives reset-token expiry from the configured value', async () => {
    const shortLived = await createTestContext({ PASSWORD_RESET_TOKEN_TTL_MINUTES: '5' });
    try {
      const { email } = await shortLived.client().register();
      await shortLived.client().post('/auth/password-reset/request', { email });
      const token = tokenFromEmail(shortLived.email, email);
      shortLived.clock.advance(6 * MINUTE);
      const response = await shortLived.client().post('/auth/password-reset/complete', {
        token,
        newPassword: 'configuration driven passphrase',
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_TOKEN');
    } finally {
      await shortLived.close();
    }
  });

  it('rejects expired reset tokens', async () => {
    const { email } = await ctx.client().register();
    await ctx.client().post('/auth/password-reset/request', { email });
    const token = tokenFromEmail(ctx.email, email);
    ctx.clock.advance(ctx.config.password.resetTokenTtlMs + MINUTE);
    const response = await ctx.client().post('/auth/password-reset/complete', {
      token,
      newPassword: 'too late for this one',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_TOKEN');
    expect((await ctx.client().login(email)).status).toBe(200);
  });

  it('never returns reset tokens from authenticated APIs', async () => {
    const client = ctx.client();
    const { email } = await client.register();
    await ctx.client().post('/auth/password-reset/request', { email });
    const token = tokenFromEmail(ctx.email, email);
    for (const url of ['/auth/session', '/auth/sessions', '/organizations/current/audit-events']) {
      const response = await client.get(url);
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(token);
    }
  });
});

describe('CSRF protection', () => {
  it('rejects cookie-authenticated writes without the CSRF token', async () => {
    const client = ctx.client();
    await client.register();
    const response = await client.request('POST', '/auth/logout', {}, { 'x-csrf-token': 'forged' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_REJECTED');
    expect((await client.get('/auth/session')).status).toBe(200);
  });

  it('rejects state-changing requests from another origin', async () => {
    const response = await ctx
      .client()
      .request(
        'POST',
        '/auth/login',
        { email: uniqueEmail(), password: TEST_PASSWORD },
        { origin: 'https://evil.example' },
      );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_REJECTED');
  });

  it('accepts requests from the configured web origin', async () => {
    const client = ctx.client();
    await client.register();
    const response = await client.request(
      'POST',
      '/auth/logout',
      {},
      { origin: ctx.config.webOrigin },
    );
    expect(response.status).toBe(204);
  });
});
