import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveActingUserContext } from '../src/application/authorization.js';
import { inTransaction } from '../src/application/unit-of-work.js';
import { rotateMfaKeys } from '../src/database/mfa-key-rotation.js';
import { MfaKeyRing } from '../src/infrastructure/security/mfa-keyring.js';
import { base32Decode } from '../src/infrastructure/security/totp.js';
import { joinWithRole } from './fixtures.js';
import {
  connectAs,
  createTestContext,
  DAY,
  MINUTE,
  nextTotpCode,
  TEST_PASSWORD,
  tokenFromEmail,
  uniqueEmail,
  type TestClient,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
/** Every secret, recovery code and token the tests see; none may appear in logs or events. */
const leaks = new Set<string>();

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

/** A fresh, unused code for a user; moves the clock to the next step when the window is used. */
function code(email: string): string {
  try {
    return nextTotpCode(email, ctx.clock.now());
  } catch {
    ctx.clock.advance(30_000);
    return nextTotpCode(email, ctx.clock.now());
  }
}

function manual(client: TestClient): TestClient {
  client.autoMfa = false;
  return client;
}

/** Registers an Owner and completes enrollment explicitly. */
async function owner(label = 'owner') {
  const client = ctx.client();
  const registered = await client.register({ email: uniqueEmail(label) });
  const enrolled = await client.enrollMfa();
  leaks.add(enrolled.secret);
  enrolled.recoveryCodes?.forEach((c) => leaks.add(c));
  const session = (await client.get('/auth/session')).body.data;
  return {
    client,
    email: registered.email,
    userId: session.user.id as string,
    organizationId: session.activeOrganization.id as string,
    membershipId: session.activeOrganization.membershipId as string,
    recoveryCodes: enrolled.recoveryCodes ?? [],
  };
}

/** Signs in without answering the challenge. */
async function pendingLogin(email: string, password = TEST_PASSWORD) {
  const client = manual(ctx.client());
  const response = await client.post('/auth/login', { email, password });
  if (client.sessionToken) leaks.add(client.sessionToken);
  return { client, response };
}

async function securityEvents(userId: string): Promise<{ event_type: string; metadata: any }[]> {
  const db = await connectAs('owner');
  try {
    const { rows } = await db.query(
      `SELECT event_type, metadata FROM security_events WHERE user_id = $1 ORDER BY occurred_at`,
      [userId],
    );
    return rows;
  } finally {
    await db.end();
  }
}

describe('enrollment (S7-12, S7-13)', () => {
  it('makes a new Owner enroll before using the organization, behind a recent password', async () => {
    const client = manual(ctx.client());
    await client.register({ email: uniqueEmail('new-owner') });
    const blocked = await client.get('/organizations/current');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    const view = (await client.get('/auth/session')).body.data;
    expect(view.mfa.enrolled).toBe(false);
    expect(view.mfa.activeOrganization).toMatchObject({
      required: true,
      reasons: ['owner', 'privileged_permission'],
      satisfied: false,
    });

    ctx.clock.advance(16 * MINUTE);
    const stale = await client.post('/auth/mfa/totp/enroll', {});
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await client.reauthenticate();
    const started = await client.post('/auth/mfa/totp/enroll', {});
    expect(started.status).toBe(200);
    const { secret, otpauthUri, qrCode, enrollmentId } = started.body.data;
    leaks.add(secret);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/Intuit%202\.0:/);
    expect(qrCode).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(started.headers['cache-control']).toBe('no-store');

    // Never readable again.
    const status = await client.get('/auth/mfa');
    expect(JSON.stringify(status.body)).not.toContain(secret);
    expect(status.body.data.factors).toEqual([]);

    const wrong = await client.post('/auth/mfa/totp/verify', { enrollmentId, code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('INVALID_MFA_CODE');

    const { rememberMfaSecret } = await import('./helpers.js');
    const { totpStep, totpCode, base32Decode } =
      await import('../src/infrastructure/security/totp.js');
    const step = totpStep(ctx.clock.now());
    rememberMfaSecret(client.email!, secret, step);
    const beforeToken = client.sessionToken!;
    const csrf = client.csrfToken!;
    const verified = await client.post('/auth/mfa/totp/verify', {
      enrollmentId,
      code: totpCode(base32Decode(secret), step),
    });
    expect(verified.status).toBe(200);
    const codes: string[] = verified.body.data.recoveryCodes;
    codes.forEach((c) => leaks.add(c));
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    codes.forEach((c) => expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-Z]{6}-[0-9A-Z]{6}$/));

    // Token rotated on gaining MFA status; the CSRF token (bound to the session id) still works.
    expect(client.sessionToken).not.toBe(beforeToken);
    const old = manual(ctx.client());
    old.sessionToken = beforeToken;
    expect((await old.get('/auth/session')).status).toBe(401);
    expect(client.csrfToken).toBe(csrf);
    const renamed = await client.patch('/organizations/current', { name: 'Renamed Co' });
    expect(renamed.status).toBe(200);
    const noCsrf = await client.request(
      'PATCH',
      '/organizations/current',
      { name: 'X' },
      {
        'x-csrf-token': 'wrong',
      },
    );
    expect(noCsrf.body.error.code).toBe('CSRF_REJECTED');

    const after = (await client.get('/auth/mfa')).body.data;
    expect(after.factors).toHaveLength(1);
    expect(after.recoveryCodes.remaining).toBe(10);
    expect(after.canDisable).toBe(false);
    expect(after.requiredBy[0].reasons).toEqual(['owner', 'privileged_permission']);
    expect(ctx.email.sent.some((m) => m.to === client.email && m.template === 'mfa_enabled')).toBe(
      true,
    );
  });

  it('discards a setup after five wrong codes and refuses an expired one', async () => {
    const client = manual(ctx.client());
    await client.register();
    const first = (await client.post('/auth/mfa/totp/enroll', {})).body.data;
    leaks.add(first.secret);
    for (let i = 0; i < 5; i += 1) {
      const wrong = await client.post('/auth/mfa/totp/verify', {
        enrollmentId: first.enrollmentId,
        code: '000000',
      });
      expect(wrong.body.error.code).toBe('INVALID_MFA_CODE');
    }
    const { totpStep, totpCode, base32Decode } =
      await import('../src/infrastructure/security/totp.js');
    const right = (secret: string) => totpCode(base32Decode(secret), totpStep(ctx.clock.now()));
    const discarded = await client.post('/auth/mfa/totp/verify', {
      enrollmentId: first.enrollmentId,
      code: right(first.secret),
    });
    expect(discarded.status).toBe(404);

    const second = (await client.post('/auth/mfa/totp/enroll', {})).body.data;
    leaks.add(second.secret);
    ctx.clock.advance(16 * MINUTE);
    const expired = await client.post('/auth/mfa/totp/verify', {
      enrollmentId: second.enrollmentId,
      code: right(second.secret),
    });
    expect(expired.status).toBe(409);
  });
});

describe('login challenge (S7-14 to S7-17)', () => {
  it('keeps MFA-pending sessions away from every other registered route', async () => {
    const o = await owner();
    const { client, response } = await pendingLogin(o.email);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      authentication: 'mfa_required',
      methods: ['totp', 'recovery_code'],
    });
    expect(response.body.data.activeOrganization).toBeUndefined();
    expect(response.body.data.permissions).toBeUndefined();

    // The only routes a pending session may use (register/login start over; S7-15).
    const open = new Set([
      'POST /auth/register',
      'POST /auth/login',
      'POST /auth/logout',
      'GET /auth/session',
      'POST /auth/mfa/challenge',
    ]);
    const checked: string[] = [];
    for (const route of ctx.routes) {
      if (!route.url.startsWith('/api/v1/') || route.method === 'HEAD') continue;
      const path = route.url.slice('/api/v1'.length);
      const key = `${route.method} ${path}`;
      if (open.has(key)) continue;
      const url = path.replace(/:[A-Za-z]+/g, () => randomUUID());
      const result = await client.request(
        route.method as 'GET',
        url,
        route.method === 'GET' ? undefined : {},
      );
      checked.push(key);
      expect({ key, status: result.status, code: result.body?.error?.code }).toEqual({
        key,
        status: 401,
        code: 'MFA_REQUIRED',
      });
    }
    expect(checked.length).toBeGreaterThan(80);

    // The allowed routes do not leak organization data either.
    const view = await client.get('/auth/session');
    expect(view.body.data.authentication).toBe('mfa_required');
    expect(view.body.data.activeOrganization).toBeUndefined();
    expect((await client.post('/auth/logout')).status).toBe(204);
    expect((await client.get('/auth/session')).status).toBe(401);
  });

  it('completes sign-in with a code, rotates the token, and never accepts a code twice', async () => {
    const o = await owner();
    const { client } = await pendingLogin(o.email);
    const pendingToken = client.sessionToken!;
    const value = code(o.email);
    const done = await client.post('/auth/mfa/challenge', { method: 'totp', code: value });
    expect(done.status).toBe(200);
    expect(done.body.data.authentication).toBe('complete');
    expect(done.body.data.mfa).toMatchObject({ enrolled: true, method: 'totp' });
    expect(client.sessionToken).not.toBe(pendingToken);
    expect((await client.get('/organizations/current')).status).toBe(200);
    const stale = manual(ctx.client());
    stale.sessionToken = pendingToken;
    expect((await stale.get('/auth/session')).status).toBe(401);

    const again = await pendingLogin(o.email);
    const replay = await again.client.post('/auth/mfa/challenge', { method: 'totp', code: value });
    expect(replay.body.error.code).toBe('INVALID_MFA_CODE');

    // The same fresh code submitted concurrently from two pending sessions succeeds once.
    const a = await pendingLogin(o.email);
    const b = await pendingLogin(o.email);
    ctx.clock.advance(30_000);
    const shared = code(o.email);
    const results = await Promise.all([
      a.client.post('/auth/mfa/challenge', { method: 'totp', code: shared }),
      b.client.post('/auth/mfa/challenge', { method: 'totp', code: shared }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('answers wrong codes generically, counts them as failed sign-ins and ends the session at five', async () => {
    const o = await owner();
    const { client } = await pendingLogin(o.email);
    for (let i = 0; i < 4; i += 1) {
      const wrong = await client.post('/auth/mfa/challenge', { method: 'totp', code: '123456' });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toMatchObject({ code: 'INVALID_MFA_CODE' });
    }
    const last = await client.post('/auth/mfa/challenge', {
      method: 'recovery_code',
      code: 'AAAA-AAAAAA-AAAAAA',
    });
    expect(last.status).toBe(401);
    expect(last.body.error.code).toBe('MFA_CHALLENGE_FAILED');
    expect((await client.get('/auth/session')).status).toBe(401);
    const events = await securityEvents(o.userId);
    expect(
      events.filter(
        (e) => e.event_type === 'auth.login_failed' && e.metadata.reason?.startsWith('mfa_invalid'),
      ),
    ).toHaveLength(5);
    expect(events.map((e) => e.event_type)).toContain('auth.mfa_challenge_exhausted');
    // The failures count toward the existing login protection (S7-17).
    const throttled = await pendingLogin(o.email);
    expect(throttled.response.status).toBe(429);
  });

  it('expires an unanswered challenge after ten minutes', async () => {
    const o = await owner();
    const { client } = await pendingLogin(o.email);
    ctx.clock.advance(11 * MINUTE);
    const late = await client.post('/auth/mfa/challenge', { method: 'totp', code: code(o.email) });
    expect(late.status).toBe(401);
  });
});

describe('recovery codes (S7-18 to S7-20)', () => {
  it('signs in with a code once (even concurrently), regenerates behind step-up, and survives exhaustion', async () => {
    const o = await owner();
    const [first, second, third] = o.recoveryCodes;
    const a = await pendingLogin(o.email);
    const used = await a.client.post('/auth/mfa/challenge', {
      method: 'recovery_code',
      code: ` ${first!.toLowerCase().replace(/-/g, ' ')} `,
    });
    expect(used.status).toBe(200);
    expect(used.body.data.mfa).toMatchObject({
      method: 'recovery_code',
      recoveryCodesRemaining: 9,
    });
    expect(
      ctx.email.sent.some((m) => m.to === o.email && m.template === 'mfa_recovery_code_used'),
    ).toBe(true);

    const reuse = await pendingLogin(o.email);
    const again = await reuse.client.post('/auth/mfa/challenge', {
      method: 'recovery_code',
      code: first,
    });
    expect(again.body.error.code).toBe('INVALID_MFA_CODE');

    const x = await pendingLogin(o.email);
    const y = await pendingLogin(o.email);
    const race = await Promise.all([
      x.client.post('/auth/mfa/challenge', { method: 'recovery_code', code: second }),
      y.client.post('/auth/mfa/challenge', { method: 'recovery_code', code: second }),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 400]);

    // Regeneration: re-authentication, then step-up, then a new set; the old set stops working.
    const signedIn = race[0]!.status === 200 ? x.client : y.client;
    ctx.clock.advance(16 * MINUTE);
    const needsPassword = await signedIn.post('/auth/mfa/recovery-codes', {});
    expect(needsPassword.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await signedIn.reauthenticate();
    const needsCode = await signedIn.post('/auth/mfa/recovery-codes', {});
    expect(needsCode.body.error.code).toBe('MFA_STEP_UP_REQUIRED');
    const stepped = await signedIn.post('/auth/mfa/step-up', {
      method: 'totp',
      code: code(o.email),
    });
    expect(stepped.status).toBe(200);
    const regenerated = await signedIn.post('/auth/mfa/recovery-codes', {});
    expect(regenerated.status).toBe(200);
    const fresh: string[] = regenerated.body.data.recoveryCodes;
    fresh.forEach((c) => leaks.add(c));
    expect(fresh).toHaveLength(10);
    const oldCode = await pendingLogin(o.email);
    expect(
      (await oldCode.client.post('/auth/mfa/challenge', { method: 'recovery_code', code: third }))
        .body.error.code,
    ).toBe('INVALID_MFA_CODE');

    // Exhaustion: every code used; TOTP still works and nothing weaker appears.
    for (const c of fresh) {
      const p = await pendingLogin(o.email);
      expect(
        (await p.client.post('/auth/mfa/challenge', { method: 'recovery_code', code: c })).status,
      ).toBe(200);
      ctx.clock.advance(MINUTE);
    }
    const last = await pendingLogin(o.email);
    const viaTotp = await last.client.post('/auth/mfa/challenge', {
      method: 'totp',
      code: code(o.email),
    });
    expect(viaTotp.status).toBe(200);
    expect(viaTotp.body.data.mfa.recoveryCodesRemaining).toBe(0);
    expect(viaTotp.body.data.mfa.method).toBe('totp');
  });
});

describe('remembered devices (S7-34 to S7-36)', () => {
  async function remember(email: string) {
    const { client } = await pendingLogin(email);
    const done = await client.post('/auth/mfa/challenge', {
      method: 'totp',
      code: code(email),
      rememberDevice: true,
    });
    expect(done.status).toBe(200);
    expect(client.deviceToken).toBeDefined();
    leaks.add(client.deviceToken!);
    return client;
  }

  it('skips the code on a remembered device, rotates the token each time and catches reuse', async () => {
    const o = await owner();
    const device = await remember(o.email);
    const first = device.deviceToken!;
    await device.post('/auth/logout');
    const again = await device.post('/auth/login', { email: o.email, password: TEST_PASSWORD });
    expect(again.body.data.authentication).toBe('complete');
    expect(again.body.data.mfa.method).toBe('trusted_device');
    expect(device.deviceToken).toBeDefined();
    expect(device.deviceToken).not.toBe(first);
    leaks.add(device.deviceToken!);
    // The password is still required: a device never replaces it.
    const wrongPassword = await manual(ctx.client()).post('/auth/login', {
      email: o.email,
      password: 'not the password at all',
    });
    expect(wrongPassword.status).toBe(401);

    // Replaying the pre-rotation token revokes the device.
    const thief = manual(ctx.client());
    thief.deviceToken = first;
    const stolen = await thief.post('/auth/login', { email: o.email, password: TEST_PASSWORD });
    expect(stolen.body.data.authentication).toBe('mfa_required');
    await device.post('/auth/logout');
    const after = await device.post('/auth/login', { email: o.email, password: TEST_PASSWORD });
    expect(after.body.data.authentication).toBe('mfa_required');
    const events = (await securityEvents(o.userId)).map((e) => e.event_type);
    expect(events).toEqual(
      expect.arrayContaining([
        'trusted_device.created',
        'trusted_device.used',
        'trusted_device.reuse_detected',
      ]),
    );
  });

  it('expires after 30 days, can be revoked, and is forgotten by a password reset (MFA stays)', async () => {
    const o = await owner();
    const device = await remember(o.email);
    ctx.clock.advance(31 * DAY);
    const expired = await device.post('/auth/login', { email: o.email, password: TEST_PASSWORD });
    expect(expired.body.data.authentication).toBe('mfa_required');

    const second = await remember(o.email);
    const listed = (await second.get('/auth/trusted-devices')).body.data;
    const current = listed.find((d: { current: boolean }) => d.current);
    expect(current).toBeDefined();
    expect(new Date(current.expiresAt).getTime() - new Date(current.createdAt).getTime()).toBe(
      30 * DAY,
    );
    expect(JSON.stringify(listed)).not.toContain(second.deviceToken!);
    expect((await second.delete(`/auth/trusted-devices/${current.id}`)).status).toBe(204);
    expect(second.deviceToken).toBeUndefined();

    const third = await remember(o.email);
    const token = third.deviceToken!;
    await manual(ctx.client()).post('/auth/password-reset/request', { email: o.email });
    const reset = await ctx.client().post('/auth/password-reset/complete', {
      token: tokenFromEmail(ctx.email, o.email),
      newPassword: 'a brand new passphrase',
    });
    expect(reset.status).toBe(200);
    const fresh = manual(ctx.client());
    fresh.deviceToken = token;
    const afterReset = await fresh.post('/auth/login', {
      email: o.email,
      password: 'a brand new passphrase',
    });
    expect(afterReset.body.data.authentication).toBe('mfa_required');
  });

  it('lets an organization refuse remembered devices; a step-up code then satisfies it', async () => {
    const o = await owner();
    const current = (await o.client.get('/organizations/current/security')).body.data;
    expect(current).toMatchObject({
      requireMfaForAllMembers: false,
      allowTrustedDevices: true,
      version: 0,
    });
    const saved = await o.client.put('/organizations/current/security', {
      requireMfaForAllMembers: false,
      allowTrustedDevices: false,
      version: 0,
    });
    expect(saved.status).toBe(200);
    const device = await remember(o.email);
    await device.post('/auth/logout');
    const viaDevice = await device.post('/auth/login', { email: o.email, password: TEST_PASSWORD });
    expect(viaDevice.body.data.mfa.method).toBe('trusted_device');
    expect(viaDevice.body.data.mfa.activeOrganization.satisfied).toBe(false);
    const blocked = await device.get('/organizations/current');
    expect(blocked.body.error.code).toBe('MFA_VERIFICATION_REQUIRED');
    const stepped = await device.post('/auth/mfa/step-up', { method: 'totp', code: code(o.email) });
    expect(stepped.status).toBe(200);
    expect((await device.get('/organizations/current')).status).toBe(200);
  });
});

describe('enforcement (S7-27 to S7-31)', () => {
  it('does not require MFA of plain members, but a privileged custom role requires it at once', async () => {
    const o = await owner();
    const member = await joinWithRole(ctx, o.client, 'Member');
    manual(member.client);
    expect((await member.client.get('/organizations/current')).status).toBe(200);
    expect(
      (await member.client.get('/auth/session')).body.data.mfa.activeOrganization.required,
    ).toBe(false);

    const role = await o.client.post('/organizations/current/roles', {
      name: 'Approval admins',
      permissionKeys: ['organization.read', 'approvals.manage'],
    });
    expect(role.status).toBe(201);
    const assigned = await o.client.put(
      `/organizations/current/members/${member.membershipId}/roles`,
      {
        roleIds: [role.body.data.id],
      },
    );
    expect(assigned.status).toBe(200);
    // Mid-session: the very next request is blocked until the member sets up MFA.
    const blocked = await member.client.get('/organizations/current');
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(
      (await member.client.get('/auth/session')).body.data.mfa.activeOrganization.reasons,
    ).toEqual(['privileged_permission']);
    const enrolled = await member.client.enrollMfa();
    leaks.add(enrolled.secret);
    expect((await member.client.get('/organizations/current')).status).toBe(200);
  });

  it('requires MFA of everyone under the organization policy, changed only with re-auth and step-up', async () => {
    const o = await owner();
    const member = await joinWithRole(ctx, o.client, 'Member');
    manual(member.client);
    manual(o.client);
    ctx.clock.advance(16 * MINUTE);
    const body = { requireMfaForAllMembers: true, allowTrustedDevices: true, version: 0 };
    const withoutPassword = await o.client.put('/organizations/current/security', body);
    expect(withoutPassword.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await o.client.reauthenticate();
    const withoutCode = await o.client.put('/organizations/current/security', body);
    expect(withoutCode.body.error.code).toBe('MFA_STEP_UP_REQUIRED');
    await o.client.post('/auth/mfa/step-up', { method: 'totp', code: code(o.email) });
    const saved = await o.client.put('/organizations/current/security', body);
    expect(saved.status).toBe(200);
    expect(saved.body.data.version).toBe(1);
    const stale = await o.client.put('/organizations/current/security', body);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    const summary = (await o.client.get('/organizations/current/security')).body.data;
    expect(summary.members).toMatchObject({ total: 2, enrolled: 1, requiredNotEnrolled: 1 });
    const members = (await o.client.get('/organizations/current/members')).body.data;
    const row = members.find(
      (m: { membershipId: string }) => m.membershipId === member.membershipId,
    );
    expect(row.mfa).toEqual({ enrolled: false, required: true });

    const blocked = await member.client.get('/organizations/current');
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    // A plain member cannot read the security settings or other members' MFA status.
    await member.client.enrollMfa();
    expect((await member.client.get('/organizations/current/security')).status).toBe(403);
    const seen = (await member.client.get('/organizations/current/members')).body.data;
    expect(seen.every((m: object) => !('mfa' in m))).toBe(true);

    const audit = (await o.client.get('/organizations/current/audit-events')).body.data;
    expect(
      audit.some((e: { action: string }) => e.action === 'organization.security_policy_updated'),
    ).toBe(true);
  });

  it('applies the requirement of the organization a multi-organization user enters', async () => {
    const strict = await owner('strict');
    await strict.client.put('/organizations/current/security', {
      requireMfaForAllMembers: true,
      allowTrustedDevices: true,
      version: 0,
    });
    const relaxed = await owner('relaxed');
    const person = await joinWithRole(ctx, relaxed.client, 'Member');
    manual(person.client);
    await strict.client.post('/organizations/current/invitations', {
      email: person.email,
      roleId: (await strict.client.get('/organizations/current/roles')).body.data.find(
        (r: { name: string }) => r.name === 'Member',
      ).id,
    });
    const joined = await person.client.post('/invitations/accept', {
      token: tokenFromEmail(ctx.email, person.email),
    });
    expect(joined.status).toBe(200);
    expect((await person.client.get('/organizations/current')).body.error.code).toBe(
      'MFA_ENROLLMENT_REQUIRED',
    );
    await person.client.put('/auth/session/organization', {
      organizationId: relaxed.organizationId,
    });
    expect((await person.client.get('/organizations/current')).status).toBe(200);
  });

  it('stops background work for a user who must have MFA but has none (S7-31)', async () => {
    const o = await owner();
    await o.client.put('/organizations/current/security', {
      requireMfaForAllMembers: true,
      allowTrustedDevices: true,
      version: 0,
    });
    const member = await joinWithRole(ctx, o.client, 'Member');
    const run = () =>
      inTransaction(ctx.database.db, {}, (tx) =>
        resolveActingUserContext(tx, member.userId, o.organizationId),
      );
    await expect(run()).rejects.toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });
    await member.client.enrollMfa();
    await expect(run()).resolves.toMatchObject({ userId: member.userId, sessionId: null });
  });
});

describe('admin reset and self-service disable (S7-21, S7-37, S7-38)', () => {
  it('resets a member with members.manage, re-auth and step-up, revoking everything', async () => {
    const o = await owner();
    const member = await joinWithRole(ctx, o.client, 'Member');
    await member.client.enrollMfa();
    await member.client.post('/auth/logout');
    await member.client.login(member.email); // answered and remembered by the harness
    manual(member.client);
    expect(member.client.deviceToken).toBeDefined();

    // A plain member cannot reset anyone.
    expect(
      (await member.client.post(`/organizations/current/members/${o.membershipId}/mfa-reset`, {}))
        .status,
    ).toBe(403);

    manual(o.client);
    ctx.clock.advance(16 * MINUTE);
    const url = `/organizations/current/members/${member.membershipId}/mfa-reset`;
    expect((await o.client.post(url, {})).body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await o.client.reauthenticate();
    expect((await o.client.post(url, {})).body.error.code).toBe('MFA_STEP_UP_REQUIRED');
    await o.client.post('/auth/mfa/step-up', { method: 'totp', code: code(o.email) });
    const reset = await o.client.post(url, {});
    expect(reset.status).toBe(200);
    expect(reset.body.data).toMatchObject({ factorsRevoked: 1, codesRevoked: 10 });
    expect(reset.body.data.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(reset.body.data.devicesRevoked).toBeGreaterThanOrEqual(1);

    expect((await member.client.get('/auth/session')).status).toBe(401);
    const back = await member.client.post('/auth/login', {
      email: member.email,
      password: TEST_PASSWORD,
    });
    expect(back.body.data.authentication).toBe('complete');
    expect(back.body.data.mfa.enrolled).toBe(false);
    expect(
      ctx.email.sent.some((m) => m.to === member.email && m.template === 'mfa_reset_by_admin'),
    ).toBe(true);
    const audit = (await o.client.get('/organizations/current/audit-events')).body.data;
    expect(audit.some((e: { action: string }) => e.action === 'membership.mfa_reset')).toBe(true);
    expect((await securityEvents(member.userId)).map((e) => e.event_type)).toContain(
      'mfa.reset_by_admin',
    );
  });

  it('refuses the Owner, oneself, other tenants and anyone who belongs elsewhere (S7-37)', async () => {
    const o = await owner();
    const admin = await joinWithRole(ctx, o.client, 'Administrator');
    await admin.client.enrollMfa();
    const reset = (client: TestClient, membershipId: string) =>
      client.post(`/organizations/current/members/${membershipId}/mfa-reset`, {});

    const ownerRefused = await reset(admin.client, o.membershipId);
    expect(ownerRefused.status).toBe(409);
    expect(ownerRefused.body.error.message).toMatch(/Owner/);
    expect((await reset(o.client, o.membershipId)).body.error.message).toMatch(/your own/);
    expect((await reset(admin.client, admin.membershipId)).body.error.message).toMatch(/your own/);

    // A member who also belongs to another organization.
    const elsewhere = await owner('elsewhere');
    const shared = await joinWithRole(ctx, elsewhere.client, 'Member');
    await o.client.post('/organizations/current/invitations', {
      email: shared.email,
      roleId: (await o.client.get('/organizations/current/roles')).body.data.find(
        (r: { name: string }) => r.name === 'Member',
      ).id,
    });
    const joined = await shared.client.post('/invitations/accept', {
      token: tokenFromEmail(ctx.email, shared.email),
    });
    const sharedHere = joined.body.data.activeOrganization.membershipId;
    const crossRefused = await reset(admin.client, sharedHere);
    expect(crossRefused.status).toBe(409);
    expect(crossRefused.body.error.message).toMatch(/another organization/);

    // An Owner elsewhere who is only a member here.
    const ownerElsewhere = await owner('owner-elsewhere');
    await o.client.post('/organizations/current/invitations', {
      email: ownerElsewhere.email,
      roleId: (await o.client.get('/organizations/current/roles')).body.data.find(
        (r: { name: string }) => r.name === 'Member',
      ).id,
    });
    const ownerJoined = await ownerElsewhere.client.post('/invitations/accept', {
      token: tokenFromEmail(ctx.email, ownerElsewhere.email),
    });
    const ownerRefusedElsewhere = await reset(
      admin.client,
      ownerJoined.body.data.activeOrganization.membershipId,
    );
    expect(ownerRefusedElsewhere.status).toBe(409);
    expect(ownerRefusedElsewhere.body.error.message).toMatch(/Owner/);

    // Another tenant's membership id is simply not found.
    expect((await reset(admin.client, elsewhere.membershipId)).status).toBe(404);
  });

  it('never lets a required user turn MFA off; others can, behind re-auth and step-up', async () => {
    const o = await owner();
    manual(o.client);
    const factorId = (await o.client.get('/auth/mfa')).body.data.factors[0].id;
    const refused = await o.client.post('/auth/mfa/totp/disable', { factorId });
    expect(refused.status).toBe(409);

    const member = await joinWithRole(ctx, o.client, 'Member');
    await member.client.enrollMfa();
    manual(member.client);
    const memberFactor = (await member.client.get('/auth/mfa')).body.data;
    expect(memberFactor.canDisable).toBe(true);
    ctx.clock.advance(16 * MINUTE);
    const needsPassword = await member.client.post('/auth/mfa/totp/disable', {
      factorId: memberFactor.factors[0].id,
    });
    expect(needsPassword.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await member.client.reauthenticate();
    await member.client.post('/auth/mfa/step-up', { method: 'totp', code: code(member.email) });
    const disabled = await member.client.post('/auth/mfa/totp/disable', {
      factorId: memberFactor.factors[0].id,
    });
    expect(disabled.status).toBe(204);
    expect((await member.client.get('/auth/mfa')).body.data).toMatchObject({
      factors: [],
      recoveryCodes: { remaining: 0 },
    });
    await member.client.post('/auth/logout');
    const plain = await member.client.post('/auth/login', {
      email: member.email,
      password: TEST_PASSWORD,
    });
    expect(plain.body.data.authentication).toBe('complete');
  });
});

describe('database protections (S7-07, S7-09)', () => {
  it('keeps credentials per user under RLS and immutable for the application role', async () => {
    const a = await owner('rls-a');
    const b = await owner('rls-b');
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.user_id', $1, true)`, [a.userId]);
      const own = await app.query('SELECT count(*)::int AS n FROM mfa_factors WHERE user_id = $1', [
        a.userId,
      ]);
      expect(own.rows[0].n).toBeGreaterThan(0);
      for (const table of ['mfa_factors', 'mfa_recovery_codes', 'trusted_devices']) {
        const other = await app.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`,
          [b.userId],
        );
        expect(other.rows[0].n).toBe(0);
      }
      const policies = await app.query(
        'SELECT count(*)::int AS n FROM organization_security_policies',
      );
      expect(policies.rows[0].n).toBe(0);
      await app.query('ROLLBACK');

      for (const statement of [
        `UPDATE mfa_factors SET secret_ciphertext = '\\x00' WHERE user_id = '${a.userId}'`,
        `UPDATE mfa_factors SET user_id = '${b.userId}' WHERE user_id = '${a.userId}'`,
        `UPDATE mfa_recovery_codes SET code_hash = 'x' WHERE user_id = '${a.userId}'`,
        `DELETE FROM mfa_factors WHERE user_id = '${a.userId}'`,
        `DELETE FROM trusted_devices WHERE user_id = '${a.userId}'`,
      ]) {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('app.user_id', $1, true)`, [a.userId]);
        await expect(app.query(statement)).rejects.toMatchObject({ code: '42501' });
        await app.query('ROLLBACK');
      }

      // Without a user context nothing is visible, and the reset function refuses to run.
      const none = await app.query('SELECT count(*)::int AS n FROM mfa_factors');
      expect(none.rows[0].n).toBe(0);
      await expect(
        app.query('SELECT * FROM app_reset_member_mfa($1, now())', [b.membershipId]),
      ).rejects.toThrow(/MFA_RESET_REFUSED:context/);
      // Nor across tenants: A's organization context cannot reach B's membership.
      await app.query('BEGIN');
      await app.query(
        `SELECT set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)`,
        [a.userId, a.organizationId],
      );
      await expect(
        app.query('SELECT * FROM app_reset_member_mfa($1, now())', [b.membershipId]),
      ).rejects.toThrow(/MFA_RESET_REFUSED:not_found/);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }

    const owner_ = await connectAs('owner');
    try {
      const { rows } = await owner_.query(
        'SELECT secret_ciphertext, key_id FROM mfa_factors WHERE user_id = $1 AND status = $2',
        [a.userId, 'active'],
      );
      expect(rows[0].key_id).toBe(ctx.config.mfa.keyRing.activeKeyId);
      expect(rows[0].secret_ciphertext.length).toBe(20);
      const codes = await owner_.query(
        'SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1',
        [a.userId],
      );
      expect(codes.rows.every((r) => r.code_hash.startsWith('$argon2id$'))).toBe(true);
    } finally {
      await owner_.end();
    }
  });

  it('rotates keys; an unknown key makes TOTP unavailable while recovery codes still work', async () => {
    const o = await owner('rotation');
    const configured = process.env.MFA_ENCRYPTION_KEYS!;
    const activeId = ctx.config.mfa.keyRing.activeKeyId;
    const newKey = `t${randomBytes(4).toString('hex')}`;
    const spec = `${configured},${newKey}:${randomBytes(32).toString('base64')}`;
    const wider = MfaKeyRing.parse(spec, newKey);
    const db = await connectAs('owner');
    try {
      const forward = await rotateMfaKeys(db, wider, { userId: o.userId });
      expect(forward.reencrypted).toBe(1);
      expect(forward.remainingByKey).toEqual({ [newKey]: 1 });

      // The application does not know the new key: TOTP is unavailable, recovery codes work.
      const p = await pendingLogin(o.email);
      const unavailable = await p.client.post('/auth/mfa/challenge', {
        method: 'totp',
        code: code(o.email),
      });
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.error.code).toBe('MFA_UNAVAILABLE');
      const viaRecovery = await p.client.post('/auth/mfa/challenge', {
        method: 'recovery_code',
        code: o.recoveryCodes[0],
      });
      expect(viaRecovery.status).toBe(200);

      // Rotating back: the same keys, with the original key active again.
      const backward = await rotateMfaKeys(db, MfaKeyRing.parse(spec, activeId), {
        userId: o.userId,
      });
      expect(backward.reencrypted).toBe(1);
      const q = await pendingLogin(o.email);
      expect(
        (await q.client.post('/auth/mfa/challenge', { method: 'totp', code: code(o.email) }))
          .status,
      ).toBe(200);
    } finally {
      await db.end();
    }
  });
});

describe('audit completeness and secret hygiene (S7-25, S7-47)', () => {
  it('records the MFA lifecycle as security events', async () => {
    const o = await owner('audit');
    const p = await pendingLogin(o.email);
    await p.client.post('/auth/mfa/challenge', { method: 'totp', code: '000000' });
    await p.client.post('/auth/mfa/challenge', {
      method: 'recovery_code',
      code: o.recoveryCodes[0],
      rememberDevice: true,
    });
    if (p.client.deviceToken) leaks.add(p.client.deviceToken);
    const types = new Set((await securityEvents(o.userId)).map((e) => e.event_type));
    for (const expected of [
      'auth.user_registered',
      'mfa.enrollment_required',
      'mfa.totp_enrollment_started',
      'mfa.totp_enabled',
      'mfa.recovery_codes_generated',
      'auth.mfa_challenge_required',
      'auth.login_failed',
      'auth.mfa_succeeded',
      'mfa.recovery_code_used',
      'trusted_device.created',
      'auth.login_succeeded',
    ]) {
      expect(types).toContain(expected);
    }
  });

  it('never writes secrets, recovery codes or device tokens to logs, events or responses', async () => {
    expect(leaks.size).toBeGreaterThan(20);
    const logText = ctx.logs.join('\n');
    const db = await connectAs('owner');
    try {
      const events = await db.query(
        `SELECT metadata::text AS m FROM security_events WHERE occurred_at > now() - interval '1 day'
         UNION ALL SELECT metadata::text FROM audit_events WHERE occurred_at > now() - interval '1 day'`,
      );
      const eventText = events.rows.map((r) => r.m).join('\n');
      for (const value of leaks) {
        const plain = value.replace(/-/g, '');
        expect(logText).not.toContain(value);
        expect(eventText).not.toContain(value);
        expect(eventText).not.toContain(plain);
      }
      // No TOTP secret is stored in the clear anywhere in the credentials table.
      const stored = await db.query(
        `SELECT encode(secret_ciphertext, 'hex') AS c FROM mfa_factors WHERE created_at > now() - interval '1 day'`,
      );
      const storedHex = stored.rows.map((r) => r.c).join('\n');
      for (const value of leaks) {
        if (!/^[A-Z2-7]{32}$/.test(value)) continue;
        expect(storedHex).not.toContain(base32Decode(value).toString('hex'));
      }
    } finally {
      await db.end();
    }
    expect(logText).not.toMatch(/"code":"\d{6}"/);
  });
});
