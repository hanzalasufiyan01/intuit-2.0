import { randomUUID } from 'node:crypto';
import { sql as q } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdempotencyService } from '../src/application/idempotency-service.js';
import { inTransaction } from '../src/application/unit-of-work.js';
import { permissionCatalog } from '../src/application/permission-catalog.js';
import { UnauthenticatedError } from '../src/domain/errors.js';
import {
  PUBLIC_API_SCOPES,
  generateToken,
  parseToken,
  permissionsForScopes,
} from '../src/modules/api-integrations/index.js';
import { recordAuditEvent } from '../src/modules/audit/index.js';
import { joinWithRole, setUpAccountingOrg } from './fixtures.js';
import {
  connectAs,
  createTestContext,
  DAY,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/**
 * ADR 0011 Step 2: the Public API permission keys, organization-owned API integrations (each a
 * non-human service principal), tokens, the integration authentication context, idempotency and
 * audit identity. No Public API routes exist yet: the context is exercised through
 * `integrationAuth.withIntegration`.
 */

let ctx: TestContext;
let owner: pg.Client;
let idempotency: IdempotencyService;
beforeAll(async () => {
  ctx = await createTestContext();
  owner = await connectAs('owner');
  idempotency = new IdempotencyService({ clock: ctx.clock, db: ctx.database.db } as never);
});
afterAll(async () => {
  await owner.end();
  await ctx.close();
});

const origin = { requestId: 'test', ipAddress: '203.0.113.9', userAgent: null };
const sql = (text: string, params: unknown[] = []) => owner.query(text, params);

async function integrationOf(
  client: TestClient,
  scopes: string[] = ['customers:read'],
  name = `Integration ${randomUUID().slice(0, 8)}`,
) {
  const res = await client.post('/api-integrations', { name, scopes });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as {
    id: string;
    version: number;
    scopes: string[];
    responsible: { membershipId: string };
  };
}

async function tokenOf(client: TestClient, integrationId: string, body: object = {}) {
  const res = await client.post(`/api-integrations/${integrationId}/tokens`, {
    name: 'Production',
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; token: string; prefix: string; expiresAt: string };
}

const authenticate = (credential: string, permission?: string) =>
  ctx.services.integrationAuth.withIntegration(
    credential,
    { origin, permission },
    async (_tx, c) => c,
  );

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error;
}

async function securityReasons(organizationId: string) {
  const { rows } = await sql(
    `SELECT metadata->>'reason' AS reason FROM security_events
      WHERE event_type = 'api_token.auth_failed' AND organization_id = $1 ORDER BY occurred_at, id`,
    [organizationId],
  );
  return rows.map((r) => r.reason as string);
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('Public API permissions', () => {
  it('adds exactly the four frozen keys and no settings permission', async () => {
    const keys = permissionCatalog
      .map((p) => p.key)
      .filter((k) => /^(api_tokens|webhooks|public_api)\./.test(k));
    expect(keys.sort()).toEqual([
      'api_tokens.manage',
      'api_tokens.view',
      'webhooks.manage',
      'webhooks.view',
    ]);
    const stored = await sql(`SELECT key FROM permissions WHERE key LIKE 'public_api%'`);
    expect(stored.rows).toEqual([]);
    await expect(
      sql(`SELECT 1 FROM information_schema.tables WHERE table_name = 'public_api_settings'`),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('grants Owner and Administrator all four, Member only the views, and custom roles nothing', async () => {
    const org = await setUpAccountingOrg(ctx);
    const roles = await sql(
      `SELECT r.name, r.is_system, array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
         FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.organization_id = $1 AND (rp.permission_key LIKE 'api_tokens.%' OR rp.permission_key LIKE 'webhooks.%')
        GROUP BY r.id`,
      [org.organizationId],
    );
    const byName = Object.fromEntries(roles.rows.map((r) => [r.name, r.keys]));
    const all = ['api_tokens.manage', 'api_tokens.view', 'webhooks.manage', 'webhooks.view'];
    expect(byName.Owner).toEqual(all);
    expect(byName.Administrator).toEqual(all);
    expect(byName.Member).toEqual(['api_tokens.view', 'webhooks.view']);
    const custom = await org.owner.post('/organizations/current/roles', {
      name: 'Bookkeeper',
      permissionKeys: ['customers.view'],
    });
    expect(custom.status).toBe(201);
    const person = await joinWithRole(ctx, org.owner, 'Bookkeeper');
    expect((await person.client.get('/api-integrations')).status).toBe(403);
  });

  it('keeps management to api_tokens.manage and listing to api_tokens.view', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.get('/api-integrations')).status).toBe(200);
    expect((await member.client.get(`/api-integrations/${integration.id}`)).status).toBe(200);
    expect((await member.client.get('/api-integrations/scopes')).status).toBe(200);
    for (const [method, path, body] of [
      ['post', '/api-integrations', { name: 'X', scopes: ['customers:read'] }],
      ['patch', `/api-integrations/${integration.id}`, { version: 1, name: 'Y' }],
      ['post', `/api-integrations/${integration.id}/tokens`, { name: 'T' }],
      ['post', `/api-integrations/${integration.id}/revoke`, { version: 1, reason: 'no' }],
    ] as const) {
      expect((await member.client[method](path, body)).status, path).toBe(403);
    }
    const noView = await org.owner.post('/organizations/current/roles', {
      name: 'No API access',
      permissionKeys: ['customers.view'],
    });
    expect(noView.status).toBe(201);
    const person = await joinWithRole(ctx, org.owner, 'No API access');
    expect((await person.client.get('/api-integrations')).status).toBe(403);
  });

  it('also needs an MFA step-up when MFA applies to the actor', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    // Owners are always required to use MFA; observe every step by hand.
    org.owner.autoMfa = false;
    ctx.clock.advance(16 * MINUTE);
    await org.owner.get('/auth/session');
    expect((await org.owner.reauthenticate()).status).toBe(200);
    const blocked = await org.owner.post(`/api-integrations/${integration.id}/tokens`, {
      name: 'T',
    });
    expect(blocked.body.error.code).toBe('MFA_STEP_UP_REQUIRED');
    ctx.clock.advance(30_000);
    expect((await org.owner.stepUp()).status).toBe(200);
    expect(
      (await org.owner.post(`/api-integrations/${integration.id}/tokens`, { name: 'T' })).status,
    ).toBe(201);
    // Reading never needs it.
    expect((await org.owner.get('/api-integrations')).status).toBe(200);
  });

  it('needs a recent password confirmation for every management write', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    ctx.clock.advance(16 * MINUTE);
    await org.owner.get('/auth/session');
    const stale = await org.owner.post(`/api-integrations/${integration.id}/tokens`, { name: 'T' });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await org.owner.get('/api-integrations')).status).toBe(200);
    expect((await org.owner.reauthenticate()).status).toBe(200);
    expect(
      (await org.owner.post(`/api-integrations/${integration.id}/tokens`, { name: 'T' })).status,
    ).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// The fixed platform policy
// ---------------------------------------------------------------------------

describe('platform Public API policy', () => {
  it('maps no scope to a posting, approving, voiding or settings permission', () => {
    const forbidden =
      /\.(issue|post|record|void|approve|submit|reverse|refund|settings|manage_settings)\b/;
    for (const scope of PUBLIC_API_SCOPES) {
      for (const key of scope.permissions) {
        expect(key, scope.scope).not.toMatch(forbidden);
        expect(
          permissionCatalog.map((p) => p.key),
          scope.scope,
        ).toContain(key);
      }
      if (scope.write) expect(scope.scope).toMatch(/^(customers|items|invoices):write$/);
    }
    expect([...permissionsForScopes(['invoices:write'])].sort()).toEqual([
      'invoices.create',
      'invoices.edit_draft',
    ]);
    expect(permissionsForScopes(['ledger:write', 'invoices:issue']).size).toBe(0);
  });

  it('refuses unknown scopes and scopes the actor does not hold', async () => {
    const org = await setUpAccountingOrg(ctx);
    for (const scope of ['invoices:issue', 'journals:write', 'customers:delete', 'bills:write']) {
      const res = await org.owner.post('/api-integrations', {
        name: `x ${scope}`,
        scopes: [scope],
      });
      expect(res.status, scope).toBe(400);
    }
    expect((await org.owner.post('/api-integrations', { name: 'none', scopes: [] })).status).toBe(
      400,
    );
    // The actor may grant only what the actor holds: this manager cannot read invoices.
    const role = await org.owner.post('/organizations/current/roles', {
      name: 'API manager',
      permissionKeys: ['api_tokens.view', 'api_tokens.manage', 'customers.view'],
    });
    expect(role.status).toBe(201);
    const manager = await joinWithRole(ctx, org.owner, 'API manager');
    const refused = await manager.client.post('/api-integrations', {
      name: 'Billing',
      scopes: ['invoices:read'],
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('invoices.view');
    expect(
      (
        await manager.client.post('/api-integrations', {
          name: 'Contacts',
          scopes: ['customers:read'],
        })
      ).status,
    ).toBe(201);
  });

  it('ignores a scope outside the platform policy at runtime', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner, ['customers:read']);
    // A row the application would never write: the policy still grants nothing for it.
    await sql(
      `INSERT INTO api_integration_scopes (integration_id, organization_id, scope, granted_by_user_id, granted_at)
       SELECT $1, $2, 'ledger:write', created_by_user_id, now() FROM api_integrations WHERE id = $1`,
      [integration.id, org.organizationId],
    );
    const { token } = await tokenOf(org.owner, integration.id);
    const context = await authenticate(token);
    expect([...context.permissions]).toEqual(['customers.view']);
  });
});

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

describe('API integrations', () => {
  it('creates an organization-owned integration with a non-human service principal', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(
      org.owner,
      ['customers:read', 'invoices:write'],
      'Payroll sync',
    );
    expect(integration).toMatchObject({
      name: 'Payroll sync',
      status: 'active',
      scopes: ['customers:read', 'invoices:write'],
      responsible: { membershipId: org.ownerMembershipId },
    });
    const row = (
      await sql(
        `SELECT i.service_user_id, u.kind, u.email, u.password_hash,
                (SELECT count(*)::int FROM memberships m WHERE m.user_id = u.id) AS memberships,
                (SELECT count(*)::int FROM membership_roles r JOIN memberships m ON m.id = r.membership_id WHERE m.user_id = u.id) AS roles
           FROM api_integrations i JOIN users u ON u.id = i.service_user_id WHERE i.id = $1`,
        [integration.id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      kind: 'service',
      email: null,
      password_hash: null,
      memberships: 1,
      roles: 0,
    });
    // Not a member, not listed, no login.
    const members = await org.owner.get('/organizations/current/members');
    expect(JSON.stringify(members.body)).not.toContain(row.service_user_id);
    const names = (
      await org.owner.post('/api-integrations', {
        name: 'payroll SYNC',
        scopes: ['customers:read'],
      })
    ).status;
    expect(names).toBe(400);
  });

  it('audits every lifecycle action with the human actor', async () => {
    const org = await setUpAccountingOrg(ctx);
    const created = await integrationOf(org.owner, ['customers:read']);
    const token = await tokenOf(org.owner, created.id);
    const updated = await org.owner.patch(`/api-integrations/${created.id}`, {
      version: created.version,
      description: 'Sync',
      scopes: ['customers:read', 'customers:write'],
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const disabled = await org.owner.post(`/api-integrations/${created.id}/disable`, {
      version: updated.body.data.version,
      reason: 'Maintenance',
    });
    const enabled = await org.owner.post(`/api-integrations/${created.id}/enable`, {
      version: disabled.body.data.version,
    });
    const revoked = await org.owner.post(`/api-integrations/${created.id}/revoke`, {
      version: enabled.body.data.version,
      reason: 'Decommissioned',
    });
    expect(revoked.body.data.status).toBe('revoked');
    const { rows } = await sql(
      `SELECT action, actor_type, resource_id FROM audit_events
        WHERE organization_id = $1 AND (action LIKE 'api_integration.%' OR action LIKE 'api_token.%')
        ORDER BY occurred_at, id`,
      [org.organizationId],
    );
    // updated and scopes_changed come from one request (same instant), so their order is not fixed.
    const actions = rows.map((r) => r.action) as string[];
    expect(actions.slice(0, 2)).toEqual(['api_integration.created', 'api_token.created']);
    expect(actions.slice(2, 4).sort()).toEqual([
      'api_integration.scopes_changed',
      'api_integration.updated',
    ]);
    expect(actions.slice(4)).toEqual([
      'api_integration.disabled',
      'api_integration.enabled',
      'api_integration.revoked',
    ]);
    expect(rows.every((r) => r.actor_type === 'user')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token.token);
  });

  it('keeps optimistic concurrency and makes revocation terminal', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const stale = await org.owner.patch(`/api-integrations/${integration.id}`, {
      version: 99,
      name: 'X',
    });
    expect(stale.status).toBe(409);
    const revoked = await org.owner.post(`/api-integrations/${integration.id}/revoke`, {
      version: 1,
      reason: 'Done',
    });
    expect(revoked.status).toBe(200);
    for (const path of ['disable', 'enable']) {
      const again = await org.owner.post(`/api-integrations/${integration.id}/${path}`, {
        version: 2,
      });
      expect(again.status, path).toBe(409);
    }
    expect(
      (await org.owner.post(`/api-integrations/${integration.id}/tokens`, { name: 'T' })).status,
    ).toBe(409);
    await expect(
      sql(
        `UPDATE api_integrations SET status = 'active', revoked_at = NULL, revoke_reason = NULL WHERE id = $1`,
        [integration.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('reassigns the responsible administrator, who must be a human allowed to manage tokens', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const admin = await joinWithRole(ctx, org.owner, 'Administrator');
    const member = await joinWithRole(ctx, org.owner, 'Member');
    const serviceMembership = (
      await sql(`SELECT service_membership_id FROM api_integrations WHERE id = $1`, [
        integration.id,
      ])
    ).rows[0].service_membership_id as string;
    for (const bad of [member.membershipId, serviceMembership, randomUUID()]) {
      const res = await org.owner.post(`/api-integrations/${integration.id}/reassign`, {
        version: 1,
        responsibleMembershipId: bad,
      });
      expect(res.status, bad).toBe(400);
    }
    const ok = await org.owner.post(`/api-integrations/${integration.id}/reassign`, {
      version: 1,
      responsibleMembershipId: admin.membershipId,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.responsible.membershipId).toBe(admin.membershipId);
    await expect(
      sql(`UPDATE api_integrations SET responsible_membership_id = $2 WHERE id = $1`, [
        integration.id,
        serviceMembership,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const audit = await sql(
      `SELECT metadata FROM audit_events WHERE action = 'api_integration.responsible_reassigned' AND resource_id = $1`,
      [integration.id],
    );
    expect(audit.rows[0].metadata).toMatchObject({
      from: org.ownerMembershipId,
      to: admin.membershipId,
    });
  });

  it('keeps running when the responsible administrator leaves', async () => {
    const org = await setUpAccountingOrg(ctx);
    const admin = await joinWithRole(ctx, org.owner, 'Administrator');
    const created = await admin.client.post('/api-integrations', {
      name: 'Admin-owned',
      scopes: ['customers:read'],
      responsibleMembershipId: admin.membershipId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const token = await tokenOf(admin.client, created.body.data.id);
    const disabled = await org.owner.patch(`/organizations/current/members/${admin.membershipId}`, {
      status: 'disabled',
    });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    // The employee is gone; the organization's integration still authenticates.
    const context = await authenticate(token.token, 'customers.view');
    expect(context.organizationId).toBe(org.organizationId);
    // Any api_tokens.manage holder can still revoke it.
    const revoke = await org.owner.post(`/api-integrations/${created.body.data.id}/revoke`, {
      version: 1,
      reason: 'Owner decision',
    });
    expect(revoke.status).toBe(200);
  });

  it('keeps integrations inside their organization', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(a.owner);
    const token = await tokenOf(a.owner, integration.id);
    expect((await b.owner.get(`/api-integrations/${integration.id}`)).status).toBe(404);
    expect((await b.owner.get(`/api-integrations/${integration.id}/tokens`)).status).toBe(404);
    expect(
      (await b.owner.patch(`/api-integrations/${integration.id}`, { version: 1, name: 'Z' }))
        .status,
    ).toBe(404);
    expect(
      (
        await b.owner.post(`/api-integrations/${integration.id}/revoke`, {
          version: 1,
          reason: 'x',
        })
      ).status,
    ).toBe(404);
    expect((await b.owner.post(`/api-tokens/${token.id}/revoke`, { reason: 'x' })).status).toBe(
      404,
    );
    expect((await b.owner.post(`/api-tokens/${token.id}/rotate`, { name: 'x' })).status).toBe(404);
    expect((await b.owner.get('/api-integrations')).body.data).toEqual([]);
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      for (const table of ['api_integrations', 'api_integration_scopes', 'api_tokens']) {
        expect((await app.query(`SELECT 1 FROM ${table}`)).rows, table).toEqual([]);
      }
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

describe('API tokens', () => {
  it('shows the credential once and stores only a one-way hash', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const created = await tokenOf(org.owner, integration.id);
    expect(created.token).toMatch(/^itk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(created.prefix).toBe(created.token.slice(0, 12));
    const parsed = parseToken(created.token)!;
    const stored = (
      await sql(
        `SELECT public_id, encode(secret_hash, 'hex') AS hash, length(secret_hash) AS n FROM api_tokens WHERE id = $1`,
        [created.id],
      )
    ).rows[0];
    expect(stored.public_id).toBe(parsed.publicId);
    expect(stored.n).toBe(32);
    expect(stored.hash).not.toContain(parsed.secret);
    for (const res of [
      await org.owner.get(`/api-integrations/${integration.id}/tokens`),
      await org.owner.get(`/api-integrations/${integration.id}`),
      await org.owner.get('/api-integrations'),
    ]) {
      expect(JSON.stringify(res.body)).not.toContain(parsed.secret);
      expect(JSON.stringify(res.body)).not.toMatch(/secret|hash/i);
    }
    expect(generateToken().token).not.toBe(generateToken().token);
  });

  it('never leaks a secret into logs, audit history, security events or errors', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const created = await tokenOf(org.owner, integration.id);
    const rotated = (await org.owner.post(`/api-tokens/${created.id}/rotate`, { name: 'v2' })).body
      .data;
    const secrets = [created.token, rotated.token].map((t) => parseToken(t)!.secret);
    await authenticate(created.token);
    const tampered = created.token.slice(0, -1) + (created.token.endsWith('a') ? 'b' : 'a');
    const error = await rejection(authenticate(tampered));
    await rejection(authenticate('itk_zzzzzzzz_' + secrets[0]));
    await org.owner.post(`/api-tokens/${created.id}/revoke`, { reason: 'Rotated' });
    await rejection(authenticate(created.token));
    const everything = JSON.stringify([
      ctx.logs,
      (await sql(`SELECT * FROM audit_events WHERE organization_id = $1`, [org.organizationId]))
        .rows,
      (await sql(`SELECT * FROM security_events`)).rows,
      (error as Error).message,
      (await org.owner.get(`/api-integrations/${integration.id}/tokens`)).body,
    ]);
    for (const secret of secrets) expect(everything).not.toContain(secret);
  });

  it('requires an expiry of at most 365 days, in the service and in the database', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const day = await tokenOf(org.owner, integration.id, { expiresInDays: 1 });
    const year = await tokenOf(org.owner, integration.id, { expiresInDays: 365 });
    expect(
      Math.abs(new Date(year.expiresAt).getTime() - new Date(day.expiresAt).getTime() - 364 * DAY),
    ).toBeLessThan(1000);
    const dflt = await tokenOf(org.owner, integration.id);
    expect(Math.round((new Date(dflt.expiresAt).getTime() - ctx.clock.now().getTime()) / DAY)).toBe(
      90,
    );
    for (const expiresInDays of [0, 366, -1, 1.5]) {
      const res = await org.owner.post(`/api-integrations/${integration.id}/tokens`, {
        name: 'T',
        expiresInDays,
      });
      expect(res.status, String(expiresInDays)).toBe(400);
    }
    await expect(
      sql(
        `INSERT INTO api_tokens (organization_id, integration_id, public_id, secret_hash, name, created_by_user_id, created_at, expires_at)
         SELECT organization_id, id, 'zzzzzzzz', decode(repeat('ab', 32), 'hex'), 'Raw', created_by_user_id, now(), now() + interval '366 days'
           FROM api_integrations WHERE id = $1`,
        [integration.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('caps the active tokens of an organization', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push((await tokenOf(org.owner, integration.id)).id);
    const over = await org.owner.post(`/api-integrations/${integration.id}/tokens`, {
      name: 'Eleventh',
    });
    expect(over.status).toBe(409);
    expect(
      (await org.owner.post(`/api-tokens/${ids[0]}/revoke`, { reason: 'Rotated away' })).status,
    ).toBe(200);
    expect(
      (await org.owner.post(`/api-integrations/${integration.id}/tokens`, { name: 'Eleventh' }))
        .status,
    ).toBe(201);
  });

  it('rotates by replacement and preserves the integration identity', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner, ['customers:read']);
    const first = await tokenOf(org.owner, integration.id);
    const rotated = await org.owner.post(`/api-tokens/${first.id}/rotate`, {
      name: 'Production v2',
    });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(201);
    expect(rotated.headers['cache-control']).toBe('no-store');
    expect(rotated.body.data.replacesId).toBe(first.id);
    expect(rotated.body.data.token).not.toBe(first.token);
    const [before, after] = [
      await authenticate(first.token),
      await authenticate(rotated.body.data.token),
    ];
    expect(after.userId).toBe(before.userId);
    expect(after.integration!.integrationId).toBe(integration.id);
    expect(after.integration!.tokenId).not.toBe(before.integration!.tokenId);
    expect([...after.permissions]).toEqual([...before.permissions]);
    // The old token works until it is revoked.
    expect(
      (await org.owner.post(`/api-tokens/${first.id}/revoke`, { reason: 'Switched over' })).status,
    ).toBe(200);
    await expect(authenticate(first.token)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect((await authenticate(rotated.body.data.token)).userId).toBe(before.userId);
    expect(
      (await org.owner.post(`/api-tokens/${first.id}/revoke`, { reason: 'Again' })).status,
    ).toBe(409);
    expect((await org.owner.post(`/api-tokens/${first.id}/revoke`, { reason: '' })).status).toBe(
      400,
    );
    await expect(
      sql(
        `UPDATE api_tokens SET revoked_at = NULL, revoke_reason = NULL, revoked_by_user_id = NULL WHERE id = $1`,
        [first.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql(`UPDATE api_tokens SET secret_hash = decode(repeat('cd', 32), 'hex') WHERE id = $1`, [
        rotated.body.data.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------------------
// Authentication context
// ---------------------------------------------------------------------------

describe('integration authentication context', () => {
  it('resolves token → integration → service principal → organization', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner, ['customers:read', 'invoices:write']);
    const token = await tokenOf(org.owner, integration.id);
    const row = (
      await sql(
        `SELECT service_user_id, service_membership_id FROM api_integrations WHERE id = $1`,
        [integration.id],
      )
    ).rows[0];
    const context = await authenticate(token.token);
    expect(context).toMatchObject({
      userId: row.service_user_id,
      membershipId: row.service_membership_id,
      organizationId: org.organizationId,
      sessionId: null,
      isOwner: false,
      roleIds: [],
      integration: { integrationId: integration.id, tokenId: token.id },
    });
    expect([...context.permissions].sort()).toEqual([
      'customers.view',
      'invoices.create',
      'invoices.edit_draft',
    ]);
    // Effective permission checks.
    await expect(authenticate(token.token, 'customers.view')).resolves.toBeDefined();
    await expect(authenticate(token.token, 'invoices.issue')).rejects.toMatchObject({
      status: 403,
    });
    await expect(authenticate(token.token, 'invoices.view')).rejects.toMatchObject({
      status: 403,
    });
    await expect(authenticate(token.token, 'api_tokens.manage')).rejects.toMatchObject({
      status: 403,
    });
    // Runs under the integration's RLS context.
    const seen = await ctx.services.integrationAuth.withIntegration(
      token.token,
      { origin },
      async (tx) => {
        const r = await tx.execute<{ org: string; user: string }>(
          q`SELECT app_current_organization_id() AS org, app_current_user_id() AS "user"`,
        );
        return r.rows[0];
      },
    );
    expect(seen).toEqual({ org: org.organizationId, user: row.service_user_id });
  });

  it('records last use at most once a minute', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const token = await tokenOf(org.owner, integration.id);
    await authenticate(token.token);
    const first = (
      await sql(`SELECT last_used_at, last_used_ip FROM api_tokens WHERE id = $1`, [token.id])
    ).rows[0];
    expect(first.last_used_ip).toBe('203.0.113.9');
    await authenticate(token.token);
    expect(
      (await sql(`SELECT last_used_at FROM api_tokens WHERE id = $1`, [token.id])).rows[0]
        .last_used_at,
    ).toEqual(first.last_used_at);
    ctx.clock.advance(2 * MINUTE);
    await authenticate(token.token);
    expect(
      (await sql(`SELECT last_used_at FROM api_tokens WHERE id = $1`, [token.id])).rows[0]
        .last_used_at,
    ).not.toEqual(first.last_used_at);
  });

  it('answers every failure with the same generic 401 and records the reason', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const live = await tokenOf(org.owner, integration.id);
    const revoked = await tokenOf(org.owner, integration.id);
    await org.owner.post(`/api-tokens/${revoked.id}/revoke`, { reason: 'Leaked' });
    const short = await tokenOf(org.owner, integration.id, { expiresInDays: 1 });
    const parsed = parseToken(live.token)!;
    const wrongSecret = `itk_${parsed.publicId}_${'A'.repeat(43)}`;
    const unknown = `itk_zzzzzzzz_${'B'.repeat(43)}`;
    const attempts: Record<string, string> = {
      malformed: 'not-a-token',
      empty: '',
      unknown,
      wrongSecret,
      revoked: revoked.token,
    };
    const messages = new Set<string>();
    for (const [name, credential] of Object.entries(attempts)) {
      const error = (await rejection(authenticate(credential))) as UnauthenticatedError;
      expect(error, name).toBeInstanceOf(UnauthenticatedError);
      expect(error).toMatchObject({ status: 401 });
      messages.add(error.message);
      expect(error.message).not.toContain(parsed.secret);
    }
    // Expired.
    ctx.clock.advance(2 * DAY);
    const expired = (await rejection(authenticate(short.token))) as UnauthenticatedError;
    expect(expired).toBeInstanceOf(UnauthenticatedError);
    messages.add(expired.message);
    expect(messages.size).toBe(1);
    const reasons = await securityReasons(org.organizationId);
    expect(reasons).toEqual(expect.arrayContaining(['bad_secret', 'revoked', 'expired']));
    const anonymous = await sql(
      `SELECT metadata FROM security_events WHERE event_type = 'api_token.auth_failed' AND organization_id IS NULL ORDER BY occurred_at DESC LIMIT 5`,
    );
    expect(JSON.stringify(anonymous.rows)).not.toMatch(/itk_|secret/i);
  });

  it('stops at once when the integration is disabled or revoked', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const token = await tokenOf(org.owner, integration.id);
    await authenticate(token.token);
    const disabled = await org.owner.post(`/api-integrations/${integration.id}/disable`, {
      version: 1,
      reason: 'Pause',
    });
    await expect(authenticate(token.token)).rejects.toBeInstanceOf(UnauthenticatedError);
    const enabled = await org.owner.post(`/api-integrations/${integration.id}/enable`, {
      version: disabled.body.data.version,
    });
    await expect(authenticate(token.token)).resolves.toBeDefined();
    await org.owner.post(`/api-integrations/${integration.id}/revoke`, {
      version: enabled.body.data.version,
      reason: 'Gone',
    });
    await expect(authenticate(token.token)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(await securityReasons(org.organizationId)).toEqual(['integration_disabled', 'revoked']);
    // Revoking the integration revoked its tokens, with a reason.
    const row = (await sql(`SELECT revoke_reason FROM api_tokens WHERE id = $1`, [token.id]))
      .rows[0];
    expect(row.revoke_reason).toContain('Integration revoked');
  });

  it('never lets a token act in another organization', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    const integrationA = await integrationOf(a.owner);
    const integrationB = await integrationOf(b.owner);
    const tokenB = await tokenOf(b.owner, integrationB.id);
    const found = await ctx.services.integrationAuth.withIntegration(
      tokenB.token,
      { origin },
      async (tx, c) => {
        const own = await tx.execute(
          q`SELECT id FROM api_integrations WHERE id = ${integrationB.id}`,
        );
        const other = await tx.execute(
          q`SELECT id FROM api_integrations WHERE id = ${integrationA.id}`,
        );
        return { organizationId: c.organizationId, own: own.rows.length, other: other.rows.length };
      },
    );
    expect(found).toEqual({ organizationId: b.organizationId, own: 1, other: 0 });
    // A browser sign-in is impossible for the service principal behind the token.
    const login = await ctx.client().post('/auth/login', {
      email: `${integrationB.id}@example.test`,
      password: 'correct horse battery staple',
    });
    expect(login.status).toBe(401);
  });

  it('is deterministic about a stolen secret for an unknown or foreign public id', async () => {
    const a = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(a.owner);
    const token = await tokenOf(a.owner, integration.id);
    const parsed = parseToken(token.token)!;
    const foreign = `itk_${parsed.publicId.split('').reverse().join('')}_${parsed.secret}`;
    if (foreign !== token.token)
      await expect(authenticate(foreign)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

// ---------------------------------------------------------------------------
// Audit identity
// ---------------------------------------------------------------------------

describe('audit identity of an integration', () => {
  it('records integration activity as api_token with its integration and token, resolved automatically', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const token = await tokenOf(org.owner, integration.id);
    const marker = randomUUID();
    await ctx.services.integrationAuth.withIntegration(token.token, { origin }, async (tx, c) => {
      // A domain service would write this, passing only the context's user id.
      await recordAuditEvent(tx, {
        occurredAt: new Date(),
        organizationId: c.organizationId,
        actorUserId: c.userId,
        action: 'test.integration_acted',
        resourceType: 'test',
        resourceId: marker,
        origin,
      });
    });
    const event = (
      await sql(
        `SELECT actor_type, actor_user_id, actor_integration_id, actor_token_id FROM audit_events WHERE resource_id = $1`,
        [marker],
      )
    ).rows[0];
    const principal = (
      await sql(`SELECT service_user_id FROM api_integrations WHERE id = $1`, [integration.id])
    ).rows[0];
    expect(event).toEqual({
      actor_type: 'api_token',
      actor_user_id: principal.service_user_id,
      actor_integration_id: integration.id,
      actor_token_id: token.id,
    });
    // The human lifecycle events stay human.
    const created = (
      await sql(
        `SELECT actor_type, actor_integration_id FROM audit_events WHERE action = 'api_integration.created' AND resource_id = $1`,
        [integration.id],
      )
    ).rows[0];
    expect(created).toEqual({ actor_type: 'user', actor_integration_id: null });
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('idempotency ownership', () => {
  const run = (
    tx: Parameters<IdempotencyService['run']>[0],
    actor: Parameters<IdempotencyService['run']>[1],
    key: string,
    value: string,
  ) =>
    idempotency.run(
      tx,
      actor,
      { key, scope: 'sales.invoice.create', request: { value } },
      async () => ({ value }),
    );

  it('owns an integration request by the integration, across token rotation', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const first = await tokenOf(org.owner, integration.id);
    const second = (await org.owner.post(`/api-tokens/${first.id}/rotate`, { name: 'v2' })).body
      .data as { token: string };
    const key = `k-${randomUUID()}`;
    const one = await ctx.services.integrationAuth.withIntegration(
      first.token,
      { origin },
      (tx, c) => run(tx, c, key, 'a'),
    );
    expect(one.replayed).toBe(false);
    // Another token of the same integration replays it: the identity did not change.
    const two = await ctx.services.integrationAuth.withIntegration(
      second.token,
      { origin },
      (tx, c) => run(tx, c, key, 'a'),
    );
    expect(two).toMatchObject({ replayed: true, value: { value: 'a' } });
    // A different request under the same key is a conflict, as for people.
    await expect(
      ctx.services.integrationAuth.withIntegration(second.token, { origin }, (tx, c) =>
        run(tx, c, key, 'b'),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const stored = (
      await sql(
        `SELECT scope, user_id FROM idempotency_keys WHERE organization_id = $1 AND idempotency_key = $2`,
        [org.organizationId, key],
      )
    ).rows;
    const principal = (
      await sql(`SELECT service_user_id FROM api_integrations WHERE id = $1`, [integration.id])
    ).rows[0].service_user_id;
    expect(stored).toEqual([
      {
        scope: expect.stringMatching(/^public\.i[0-9a-f]{12}\.sales\.invoice\.create$/),
        user_id: principal,
      },
    ]);
  });

  it('keeps integrations from colliding with or probing each other', async () => {
    const org = await setUpAccountingOrg(ctx);
    const a = await integrationOf(org.owner);
    const b = await integrationOf(org.owner);
    const tokenA = await tokenOf(org.owner, a.id);
    const tokenB = await tokenOf(org.owner, b.id);
    const key = `shared-${randomUUID()}`;
    const first = await ctx.services.integrationAuth.withIntegration(
      tokenA.token,
      { origin },
      (tx, c) => run(tx, c, key, 'from A'),
    );
    const second = await ctx.services.integrationAuth.withIntegration(
      tokenB.token,
      { origin },
      (tx, c) => run(tx, c, key, 'from B'),
    );
    expect(first).toMatchObject({ replayed: false, value: { value: 'from A' } });
    expect(second).toMatchObject({ replayed: false, value: { value: 'from B' } });
    const rows = await sql(
      `SELECT count(*)::int AS n, count(DISTINCT scope)::int AS scopes FROM idempotency_keys WHERE organization_id = $1 AND idempotency_key = $2`,
      [org.organizationId, key],
    );
    expect(rows.rows[0]).toEqual({ n: 2, scopes: 2 });
  });

  it('leaves browser (session) idempotency exactly as before', async () => {
    const org = await setUpAccountingOrg(ctx);
    const humanId = (await org.owner.get('/auth/session')).body.data.user.id as string;
    const key = `browser-${randomUUID()}`;
    const actor = { organizationId: org.organizationId, userId: humanId };
    const outcome = await inTransaction(
      ctx.database.db,
      { organizationId: org.organizationId, userId: humanId },
      async (tx) => [await run(tx, actor, key, 'x'), await run(tx, actor, key, 'x')],
    );
    expect(outcome.map((r) => r.replayed)).toEqual([false, true]);
    const stored = (
      await sql(
        `SELECT scope, user_id FROM idempotency_keys WHERE organization_id = $1 AND idempotency_key = $2`,
        [org.organizationId, key],
      )
    ).rows;
    expect(stored).toEqual([{ scope: 'sales.invoice.create', user_id: humanId }]);
    // Another person with the same key is still a conflict.
    const other = await joinWithRole(ctx, org.owner, 'Member');
    await expect(
      inTransaction(
        ctx.database.db,
        { organizationId: org.organizationId, userId: other.userId },
        (tx) => run(tx, { organizationId: org.organizationId, userId: other.userId }, key, 'x'),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

// ---------------------------------------------------------------------------
// Runtime organization permission boundary and scope boundaries
// ---------------------------------------------------------------------------

describe('runtime organization permission boundary', () => {
  type RoleRow = {
    id: string;
    name: string;
    description: string;
    isOwner: boolean;
    permissionKeys: string[];
  };

  async function nonOwnerRoles(org: { owner: TestClient }) {
    const roles = (await org.owner.get('/organizations/current/roles')).body.data as RoleRow[];
    return roles.filter((r) => !r.isOwner);
  }

  async function setRoleKeys(org: { owner: TestClient }, role: RoleRow, keys: string[]) {
    const res = await org.owner.put(`/organizations/current/roles/${role.id}`, {
      name: role.name,
      description: role.description,
      permissionKeys: keys,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  it('withdraws a stored scope while the organization lacks its permission and restores it afterwards', async () => {
    const org = await setUpAccountingOrg(ctx);
    // A: the integration has customers:write.
    const integration = await integrationOf(org.owner, ['customers:write']);
    const { token } = await tokenOf(org.owner, integration.id);
    // B + C: the organization permits customers write, and the API succeeds.
    await expect(authenticate(token, 'customers.create')).resolves.toBeDefined();
    await expect(authenticate(token, 'customers.update')).resolves.toBeDefined();

    // D: the organization stops permitting customers.create (no non-Owner role holds it).
    const roles = await nonOwnerRoles(org);
    const holders = roles.filter((r) => r.permissionKeys.includes('customers.create'));
    expect(holders.length).toBeGreaterThan(0);
    for (const role of holders) {
      await setRoleKeys(
        org,
        role,
        role.permissionKeys.filter((k) => k !== 'customers.create'),
      );
    }
    // E: the same token and scope now receive the authorization denial; the rest is unaffected.
    await expect(authenticate(token, 'customers.create')).rejects.toMatchObject({ status: 403 });
    await expect(authenticate(token, 'customers.update')).resolves.toBeDefined();
    const withdrawn = await authenticate(token);
    expect([...withdrawn.permissions]).toEqual(['customers.update']);
    // Nothing stored changed: same grants, same integration version, same token.
    const stored = await org.owner.get(`/api-integrations/${integration.id}`);
    expect(stored.body.data).toMatchObject({
      scopes: ['customers:write'],
      version: integration.version,
      status: 'active',
    });

    // F: the organization permits it again.
    for (const role of holders) await setRoleKeys(org, role, role.permissionKeys);
    // G: the same token and scope work again.
    await expect(authenticate(token, 'customers.create')).resolves.toBeDefined();
    expect([...(await authenticate(token)).permissions].sort()).toEqual([
      'customers.create',
      'customers.update',
    ]);
  });

  it('does not depend on the creator or the responsible administrator', async () => {
    const org = await setUpAccountingOrg(ctx);
    const admin = await joinWithRole(ctx, org.owner, 'Administrator');
    const created = await admin.client.post('/api-integrations', {
      name: 'Admin-run',
      scopes: ['customers:write', 'invoices:write'],
      responsibleMembershipId: admin.membershipId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const token = (await tokenOf(admin.client, created.body.data.id)).token;
    // Strip the person of every permission: a role with nothing, and the account disabled.
    const empty = await org.owner.post('/organizations/current/roles', {
      name: 'Nothing',
      permissionKeys: ['organization.read'],
    });
    expect(empty.status).toBe(201);
    const assigned = await org.owner.put(
      `/organizations/current/members/${admin.membershipId}/roles`,
      { roleIds: [empty.body.data.id] },
    );
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    await org.owner.patch(`/organizations/current/members/${admin.membershipId}`, {
      status: 'disabled',
    });
    const context = await authenticate(token);
    expect([...context.permissions].sort()).toEqual([
      'customers.create',
      'customers.update',
      'invoices.create',
      'invoices.edit_draft',
    ]);
    expect(
      (await org.owner.get(`/api-integrations/${created.body.data.id}`)).body.data.scopes,
    ).toEqual(['customers:write', 'invoices:write']);
  });

  it('ignores the Owner role, which holds every key and cannot be changed', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner, ['invoices:write']);
    const { token } = await tokenOf(org.owner, integration.id);
    const roles = await nonOwnerRoles(org);
    for (const role of roles) {
      await setRoleKeys(
        org,
        role,
        role.permissionKeys.filter((k) => !k.startsWith('invoices.')),
      );
    }
    // The Owner still holds invoices.create, yet the delegated roles of the organization do not.
    expect((await authenticate(token)).permissions.size).toBe(0);
    await expect(authenticate(token, 'invoices.create')).rejects.toMatchObject({ status: 403 });
  });
});

describe('scope boundaries', () => {
  const SCOPES = PUBLIC_API_SCOPES.map((s) => s.scope);

  async function contexts() {
    const org = await setUpAccountingOrg(ctx);
    const result: Record<string, Set<string>> = {};
    for (const scope of SCOPES) {
      const integration = await integrationOf(org.owner, [scope], `Only ${scope}`);
      const { token } = await tokenOf(org.owner, integration.id);
      result[scope] = new Set((await authenticate(token)).permissions);
    }
    return result;
  }

  it('gives each scope exactly its own capabilities and nothing else', async () => {
    const byScope = await contexts();
    expect([...byScope['customers:write']!].sort()).toEqual([
      'customers.create',
      'customers.update',
    ]);
    expect([...byScope['items:write']!]).toEqual(['catalog.items.manage']);
    expect([...byScope['invoices:write']!].sort()).toEqual([
      'invoices.create',
      'invoices.edit_draft',
    ]);
    expect([...byScope['customers:read']!]).toEqual(['customers.view']);
    expect([...byScope['vendors:read']!]).toEqual(['vendors.view']);
    expect([...byScope['invoices:read']!]).toEqual(['invoices.view']);
    expect([...byScope['bills:read']!]).toEqual(['bills.view']);
    expect([...byScope['accounts:read']!]).toEqual(['accounting.accounts.view']);
  });

  it('keeps read scopes read-only', async () => {
    const byScope = await contexts();
    for (const scope of SCOPES.filter((s) => s.endsWith(':read'))) {
      for (const key of byScope[scope]!) expect(key, scope).toMatch(/\.view$/);
    }
  });

  it('never lets a write scope reach issuing, posting, approving, voiding, refunding or the ledger', async () => {
    const byScope = await contexts();
    const ledgerOrMoney =
      /(\.issue|\.post|\.record|\.void|\.approve|\.submit|\.reverse|\.refund|\.delete_draft|\.archive|\.settings|journals\.|ledger\.|periods\.|receipts\.|credit_notes\.|vendor_payments\.|vendor_credits\.|banking\.|inventory\.|fixed_assets\.|expenses?\.|purchases\.|accounting\.|organization\.|members\.|roles\.|api_tokens\.|webhooks\.)/;
    for (const scope of SCOPES.filter((s) => s.endsWith(':write'))) {
      for (const key of byScope[scope]!) expect(key, scope).not.toMatch(ledgerOrMoney);
    }
    // invoices:write is exactly draft create and edit.
    const invoices = byScope['invoices:write']!;
    for (const forbidden of [
      'invoices.issue',
      'invoices.void',
      'invoices.approve',
      'invoices.delete_draft',
      'invoices.view',
      'receipts.create',
      'credit_notes.create',
      'accounting.journals.view',
    ]) {
      expect(invoices.has(forbidden), forbidden).toBe(false);
    }
    // items:write is item master data only: no invoice, bill, accounting, payment or settings key.
    for (const key of byScope['items:write']!) expect(key).toBe('catalog.items.manage');
    // customers:write is customer create and update only (no archive, no other resources).
    const customers = byScope['customers:write']!;
    for (const forbidden of [
      'customers.archive',
      'parties.manage',
      'invoices.create',
      'receipts.create',
    ]) {
      expect(customers.has(forbidden), forbidden).toBe(false);
    }
  });

  it('refuses every other capability at the permission check', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner, ['invoices:write']);
    const { token } = await tokenOf(org.owner, integration.id);
    for (const key of [
      'invoices.issue',
      'invoices.void',
      'invoices.approve',
      'receipts.create',
      'receipts.void',
      'accounting.journals.create',
      'accounting.journals.post',
      'catalog.items.manage',
      'customers.create',
      'api_tokens.manage',
      'webhooks.manage',
    ]) {
      await expect(authenticate(token, key), key).rejects.toMatchObject({ status: 403 });
    }
    for (const key of ['invoices.create', 'invoices.edit_draft']) {
      await expect(authenticate(token, key), key).resolves.toBeDefined();
    }
  });
});

describe('audit path of an integration request', () => {
  it('ignores any integration or token identity a caller tries to supply', async () => {
    const org = await setUpAccountingOrg(ctx);
    const integration = await integrationOf(org.owner);
    const token = await tokenOf(org.owner, integration.id);
    const marker = randomUUID();
    const bogus = randomUUID();
    await ctx.services.integrationAuth.withIntegration(token.token, { origin }, async (tx, c) => {
      await recordAuditEvent(tx, {
        occurredAt: new Date(),
        organizationId: c.organizationId,
        actorUserId: c.userId,
        action: 'test.spoof_attempt',
        resourceType: 'test',
        resourceId: marker,
        origin,
        // Not part of the input type; if it were honoured the row would name these identities.
        ...({ actorIntegrationId: bogus, actorTokenId: bogus } as object),
      });
    });
    const row = (
      await sql(
        `SELECT actor_type, actor_integration_id, actor_token_id FROM audit_events WHERE resource_id = $1`,
        [marker],
      )
    ).rows[0];
    expect(row).toEqual({
      actor_type: 'api_token',
      actor_integration_id: integration.id,
      actor_token_id: token.id,
    });
  });
});
