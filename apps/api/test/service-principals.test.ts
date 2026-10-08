import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/application/unit-of-work.js';
import { recordAuditEvent } from '../src/modules/audit/index.js';
import {
  createServicePrincipal,
  findServicePrincipal,
  findUserByEmail,
  findUserById,
} from '../src/modules/identity/index.js';
import { listOrganizationMemberships } from '../src/modules/organizations/index.js';
import { setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, uniqueEmail, type TestContext } from './helpers.js';

/**
 * ADR 0011 Step 1: non-human service principals (migration 0053) and the `api_token` audit actor
 * (migration 0054). Human-user invariants are unchanged; a service principal can never log in,
 * hold a session, reset a password, enroll MFA, hold a role (so never Owner), be an approver,
 * enter invitation or member flows, or belong to a second organization.
 */

let ctx: TestContext;
let owner: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext();
  owner = await connectAs('owner');
});
afterAll(async () => {
  await owner.end();
  await ctx.close();
});

const origin = { requestId: 'test', ipAddress: null, userAgent: null };
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA';

interface Fixture {
  org: AccountingOrg;
  humanId: string;
  serviceId: string;
  serviceMembershipId: string;
}

async function fixture(): Promise<Fixture> {
  const org = await setUpAccountingOrg(ctx);
  const session = (await org.owner.get('/auth/session')).body.data;
  const principal = await inTransaction(ctx.database.db, {}, (tx) =>
    createServicePrincipal(tx, { displayName: 'Payroll sync', now: new Date() }),
  );
  const membership = await owner.query(
    `INSERT INTO memberships (organization_id, user_id) VALUES ($1, $2) RETURNING id`,
    [org.organizationId, principal.id],
  );
  return {
    org,
    humanId: session.user.id as string,
    serviceId: principal.id,
    serviceMembershipId: membership.rows[0].id as string,
  };
}

/** Expects a check_violation (23514) whose message matches. */
async function refused(promise: Promise<unknown>, message: RegExp) {
  await expect(promise).rejects.toMatchObject({
    code: '23514',
    message: expect.stringMatching(message),
  });
}

const sql = (text: string, params: unknown[] = []) => owner.query(text, params);

// ---------------------------------------------------------------------------
// Human users keep every invariant
// ---------------------------------------------------------------------------

describe('human user invariants are not weakened', () => {
  it('requires e-mail, normalized e-mail and an Argon2id hash for a human', async () => {
    for (const [email, normalized, hash] of [
      [null, 'a@example.test', HASH],
      ['a@example.test', null, HASH],
      ['a@example.test', 'a@example.test', null],
      [null, null, null],
    ]) {
      await refused(
        sql(
          `INSERT INTO users (kind, email, email_normalized, password_hash, display_name, password_changed_at)
           VALUES ('human', $1, $2, $3, 'Human', now())`,
          [email, normalized, hash],
        ),
        /users_kind_identity/,
      );
    }
    // The pre-existing format rules still apply to a human.
    await refused(
      sql(
        `INSERT INTO users (email, email_normalized, password_hash, display_name, password_changed_at)
         VALUES ('x@example.test', 'x@example.test', 'not-a-hash', 'Human', now())`,
      ),
      /users_password_hash_check/,
    );
    await refused(
      sql(
        `INSERT INTO users (email, email_normalized, password_hash, display_name, password_changed_at)
         VALUES ('X@Example.test', 'X@Example.test', $1, 'Human', now())`,
        [HASH],
      ),
      /users_email_normalized_check/,
    );
  });

  it('cannot strip a registered human of e-mail or password', async () => {
    const f = await fixture();
    for (const column of ['email', 'email_normalized', 'password_hash']) {
      await refused(
        sql(`UPDATE users SET ${column} = NULL WHERE id = $1`, [f.humanId]),
        /users_kind_identity/,
      );
    }
  });

  it('registers and signs in humans exactly as before', async () => {
    const client = ctx.client();
    const { email } = await client.register();
    const fresh = ctx.client();
    expect((await fresh.login(email)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The service principal representation
// ---------------------------------------------------------------------------

describe('service principal representation', () => {
  it('has no e-mail, no password and a fixed kind', async () => {
    const f = await fixture();
    const row = (await sql(`SELECT * FROM users WHERE id = $1`, [f.serviceId])).rows[0];
    expect(row).toMatchObject({
      kind: 'service',
      email: null,
      email_normalized: null,
      password_hash: null,
      email_verified_at: null,
      display_name: 'Payroll sync',
    });
    for (const [column, value] of [
      ['email', "'svc@example.test'"],
      ['email_normalized', "'svc@example.test'"],
      ['password_hash', `'${HASH}'`],
      ['email_verified_at', 'now()'],
    ] as const) {
      await refused(
        sql(`UPDATE users SET ${column} = ${value} WHERE id = $1`, [f.serviceId]),
        /users_kind_identity/,
      );
    }
    await refused(
      sql(
        `INSERT INTO users (kind, email, display_name, password_changed_at)
         VALUES ('service', 'svc@example.test', 'S', now())`,
      ),
      /users_kind_identity/,
    );
  });

  it('never changes kind, in either direction', async () => {
    const f = await fixture();
    await refused(
      sql(
        `UPDATE users SET kind = 'human', email = 'h@example.test', email_normalized = 'h@example.test',
                password_hash = $2 WHERE id = $1`,
        [f.serviceId, HASH],
      ),
      /cannot change/,
    );
    await refused(
      sql(
        `UPDATE users SET kind = 'service', email = NULL, email_normalized = NULL, password_hash = NULL
          WHERE id = $1`,
        [f.humanId],
      ),
      /cannot change/,
    );
  });

  it('is invisible to human lookups and listed by its own', async () => {
    const f = await fixture();
    await inTransaction(ctx.database.db, {}, async (tx) => {
      expect(await findUserById(tx, f.serviceId)).toBeUndefined();
      expect(await findServicePrincipal(tx, f.serviceId)).toMatchObject({ kind: 'service' });
      expect(await findServicePrincipal(tx, f.humanId)).toBeUndefined();
      expect(await findUserByEmail(tx, 'svc@example.test')).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Negative tests: what a service principal can never do
// ---------------------------------------------------------------------------

describe('a service principal can never act as a human', () => {
  it('cannot log in, hold a session, or be signed in by e-mail', async () => {
    const f = await fixture();
    // No e-mail exists to sign in with: any attempt is the same generic failure.
    const login = await ctx.client().post('/auth/login', {
      email: uniqueEmail('svc'),
      password: 'correct horse battery staple',
    });
    expect(login.status).toBe(401);
    await refused(
      sql(
        `INSERT INTO sessions (user_id, token_hash, active_organization_id, created_at, last_seen_at,
                               expires_at, reauthenticated_at)
         VALUES ($1, decode(repeat('ab', 32), 'hex'), $2, now(), now(), now() + interval '1 day', now())`,
        [f.serviceId, f.org.organizationId],
      ),
      /service principal/,
    );
    // A session of a human cannot be moved onto a service principal either.
    const humanSession = (
      await sql(`SELECT id FROM sessions WHERE user_id = $1 LIMIT 1`, [f.humanId])
    ).rows[0];
    await refused(
      sql(`UPDATE sessions SET user_id = $2 WHERE id = $1`, [humanSession.id, f.serviceId]),
      /service principal/,
    );
  });

  it('cannot reset a password', async () => {
    const f = await fixture();
    const requested = await ctx.client().post('/auth/password-reset/request', {
      email: uniqueEmail('svc'),
    });
    expect(requested.status).toBe(202);
    await refused(
      sql(
        `INSERT INTO password_reset_tokens (user_id, token_hash, created_at, expires_at)
         VALUES ($1, decode(repeat('cd', 32), 'hex'), now(), now() + interval '1 hour')`,
        [f.serviceId],
      ),
      /service principal/,
    );
  });

  it('cannot enroll or use MFA', async () => {
    const f = await fixture();
    await refused(
      sql(
        `INSERT INTO mfa_factors (user_id, type, status, pending_expires_at, secret_ciphertext, secret_iv,
                                  secret_tag, key_id, created_at)
         VALUES ($1, 'totp', 'pending', now() + interval '10 minutes', decode('00', 'hex'),
                 decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 'k1', now())`,
        [f.serviceId],
      ),
      /service principal/,
    );
    await refused(
      sql(
        `INSERT INTO mfa_recovery_codes (user_id, set_id, lookup_id, code_hash, created_at)
         VALUES ($1, gen_random_uuid(), 'ABCD', '$argon2id$x', now())`,
        [f.serviceId],
      ),
      /service principal/,
    );
    await refused(
      sql(
        `INSERT INTO trusted_devices (user_id, token_hash, created_at, expires_at, last_used_at)
         VALUES ($1, decode(repeat('ef', 32), 'hex'), now(), now() + interval '1 day', now())`,
        [f.serviceId],
      ),
      /service principal/,
    );
  });

  it('cannot hold any role, so never Owner', async () => {
    const f = await fixture();
    const roles = (
      await sql(`SELECT id, is_owner FROM roles WHERE organization_id = $1`, [f.org.organizationId])
    ).rows as { id: string; is_owner: boolean }[];
    expect(roles.some((r) => r.is_owner)).toBe(true);
    for (const role of roles) {
      await refused(
        sql(
          `INSERT INTO membership_roles (membership_id, role_id, organization_id, role_is_owner)
           VALUES ($1, $2, $3, $4)`,
          [f.serviceMembershipId, role.id, f.org.organizationId, role.is_owner],
        ),
        /service principal/,
      );
    }
    // Through the application: the member, role and ownership flows do not even find it.
    const assign = await f.org.owner.put(
      `/organizations/current/members/${f.serviceMembershipId}/roles`,
      { roleIds: [roles.find((r) => r.is_owner)!.id] },
    );
    expect([400, 404]).toContain(assign.status);
    const disable = await f.org.owner.patch(
      `/organizations/current/members/${f.serviceMembershipId}`,
      { status: 'disabled' },
    );
    expect([400, 404]).toContain(disable.status);
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM membership_roles WHERE membership_id = $1`, [
          f.serviceMembershipId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('cannot become an approver, by policy or by decision', async () => {
    const f = await fixture();
    const policy = await f.org.owner.put('/approvals/policies/accounting.journal.post', {
      steps: [
        {
          name: 'Review',
          requiredApprovals: 1,
          roleIds: [],
          membershipIds: [f.serviceMembershipId],
        },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(400);
    const row = (
      await sql(
        `INSERT INTO approval_policies (organization_id, action_key) VALUES ($1, 'test.step.guard') RETURNING id`,
        [f.org.organizationId],
      )
    ).rows[0];
    const step = (
      await sql(
        `INSERT INTO approval_policy_steps (organization_id, policy_id, step_order, name, required_approvals)
         VALUES ($1, $2, 1, 'Step', 1) RETURNING id`,
        [f.org.organizationId, row.id],
      )
    ).rows[0];
    await refused(
      sql(
        `INSERT INTO approval_step_eligible_members (step_id, organization_id, membership_id)
         VALUES ($1, $2, $3)`,
        [step.id, f.org.organizationId, f.serviceMembershipId],
      ),
      /service principal/,
    );
    const request = (
      await sql(
        `INSERT INTO approval_requests (organization_id, action_key, subject_type, subject_id,
                                        policy_snapshot, requested_by_user_id, created_at)
         VALUES ($1, 'test.step.guard', 'test', gen_random_uuid(), '{}'::jsonb, $2, now()) RETURNING id`,
        [f.org.organizationId, f.humanId],
      )
    ).rows[0];
    // Both the membership and the user of a decision are guarded.
    await refused(
      sql(
        `INSERT INTO approval_decisions (organization_id, request_id, step_order, approver_membership_id,
                                         approver_user_id, decision, decided_at)
         VALUES ($1, $2, 1, $3, $4, 'approved', now())`,
        [f.org.organizationId, request.id, f.serviceMembershipId, f.serviceId],
      ),
      /service principal/,
    );
    await refused(
      sql(
        `INSERT INTO approval_decisions (organization_id, request_id, step_order, approver_membership_id,
                                         approver_user_id, decision, decided_at)
         VALUES ($1, $2, 1, $3, $4, 'approved', now())`,
        [f.org.organizationId, request.id, f.org.ownerMembershipId, f.serviceId],
      ),
      /service principal/,
    );
  });

  it('cannot enter invitation, organization or ownership flows', async () => {
    const f = await fixture();
    const member = (
      await sql(`SELECT id FROM roles WHERE organization_id = $1 AND NOT is_owner LIMIT 1`, [
        f.org.organizationId,
      ])
    ).rows[0];
    const invite = (userColumn: string, user: string) =>
      sql(
        `INSERT INTO invitations (organization_id, email, email_normalized, role_id, invited_by_user_id,
                                  token_hash, created_at, expires_at${userColumn === 'accepted_by_user_id' ? ', accepted_by_user_id' : ''})
         VALUES ($1, $2, $2, $3, $4, decode(repeat('0a', 32), 'hex'), now(), now() + interval '1 day'${
           userColumn === 'accepted_by_user_id' ? ', $5' : ''
         })`,
        userColumn === 'accepted_by_user_id'
          ? [f.org.organizationId, `${randomUUID()}@example.test`, member.id, f.humanId, user]
          : [f.org.organizationId, `${randomUUID()}@example.test`, member.id, user],
      );
    await refused(invite('invited_by_user_id', f.serviceId), /service principal/);
    await refused(invite('accepted_by_user_id', f.serviceId), /service principal/);
    await refused(
      sql(`INSERT INTO organizations (name, created_by_user_id) VALUES ('Svc org', $1)`, [
        f.serviceId,
      ]),
      /service principal/,
    );
    await refused(
      sql(
        `INSERT INTO ownership_transfers (organization_id, from_membership_id, to_membership_id,
                                          replacement_role_id, initiated_by_user_id, initiated_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, now(), now() + interval '1 day')`,
        [
          f.org.organizationId,
          f.org.ownerMembershipId,
          f.serviceMembershipId,
          member.id,
          f.humanId,
        ],
      ),
      /service principal/,
    );
    await refused(
      sql(
        `INSERT INTO ownership_transfers (organization_id, from_membership_id, to_membership_id,
                                          replacement_role_id, initiated_by_user_id, initiated_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, now(), now() + interval '1 day')`,
        [
          f.org.organizationId,
          f.serviceMembershipId,
          f.org.ownerMembershipId,
          member.id,
          f.humanId,
        ],
      ),
      /service principal/,
    );
  });

  it('is not listed as a member and has no permissions', async () => {
    const f = await fixture();
    const members = (await f.org.owner.get('/organizations/current/members')).body.data as {
      membershipId?: string;
      id?: string;
    }[];
    expect(JSON.stringify(members)).not.toContain(f.serviceMembershipId);
    await inTransaction(
      ctx.database.db,
      { userId: f.humanId, organizationId: f.org.organizationId },
      async (tx) => {
        const listed = await listOrganizationMemberships(tx, f.org.organizationId);
        expect(listed.map((m) => m.userId)).not.toContain(f.serviceId);
      },
    );
  });

  it('is organization-scoped: one membership, never moved, invisible to other tenants', async () => {
    const f = await fixture();
    const other = await setUpAccountingOrg(ctx);
    await refused(
      sql(`INSERT INTO memberships (organization_id, user_id) VALUES ($1, $2)`, [
        other.organizationId,
        f.serviceId,
      ]),
      /exactly one organization/,
    );
    await refused(
      sql(`UPDATE memberships SET organization_id = $2 WHERE id = $1`, [
        f.serviceMembershipId,
        other.organizationId,
      ]),
      /cannot move/,
    );
    // Row level security: in the other tenant's context neither the membership nor the role
    // assignments of this organization are visible.
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [other.organizationId]);
      expect(
        (
          await app.query(`SELECT id FROM memberships WHERE organization_id = $1`, [
            f.org.organizationId,
          ])
        ).rows,
      ).toEqual([]);
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
    expect(
      (await other.owner.get('/organizations/current/members')).body.data.length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The api_token audit actor
// ---------------------------------------------------------------------------

describe('audit actors', () => {
  const record = (
    f: Fixture,
    input: Partial<Parameters<typeof recordAuditEvent>[1]> & { actorUserId: string | null },
  ) =>
    inTransaction(
      ctx.database.db,
      { userId: f.humanId, organizationId: f.org.organizationId },
      (tx) =>
        recordAuditEvent(tx, {
          occurredAt: new Date(),
          organizationId: f.org.organizationId,
          action: 'test.actor_checked',
          resourceType: 'test',
          resourceId: null,
          origin,
          ...input,
        }),
    );

  const lastEvent = async (f: Fixture, marker: string) =>
    (
      await sql(
        `SELECT actor_type, actor_user_id, actor_integration_id, actor_token_id
           FROM audit_events WHERE organization_id = $1 AND resource_id = $2`,
        [f.org.organizationId, marker],
      )
    ).rows[0];

  it('keeps the user, system and anonymous actors as they were', async () => {
    const f = await fixture();
    await record(f, { actorUserId: f.humanId, resourceId: 'human' });
    await record(f, { actorUserId: null, actorType: 'system', resourceId: 'system' });
    await record(f, { actorUserId: null, resourceId: 'anonymous' });
    expect(await lastEvent(f, 'human')).toMatchObject({
      actor_type: 'user',
      actor_user_id: f.humanId,
      actor_integration_id: null,
      actor_token_id: null,
    });
    expect(await lastEvent(f, 'system')).toMatchObject({
      actor_type: 'system',
      actor_user_id: null,
    });
    expect(await lastEvent(f, 'anonymous')).toMatchObject({
      actor_type: 'anonymous',
      actor_user_id: null,
    });
  });

  it('records a service principal as api_token with its integration and token', async () => {
    const f = await fixture();
    const integration = randomUUID();
    const token = randomUUID();
    await record(f, {
      actorUserId: f.serviceId,
      actorIntegrationId: integration,
      actorTokenId: token,
      resourceId: 'api',
    });
    expect(await lastEvent(f, 'api')).toMatchObject({
      actor_type: 'api_token',
      actor_user_id: f.serviceId,
      actor_integration_id: integration,
      actor_token_id: token,
    });
    // The token is optional supplementary data.
    await record(f, {
      actorUserId: f.serviceId,
      actorIntegrationId: integration,
      resourceId: 'api2',
    });
    expect(await lastEvent(f, 'api2')).toMatchObject({
      actor_type: 'api_token',
      actor_token_id: null,
    });
  });

  it('derives the actor from the identity: a service principal cannot masquerade as a user', async () => {
    const f = await fixture();
    const integration = randomUUID();
    // Even when the caller says 'user', the identity decides.
    await record(f, {
      actorUserId: f.serviceId,
      actorType: 'user',
      actorIntegrationId: integration,
      resourceId: 'masquerade',
    });
    expect(await lastEvent(f, 'masquerade')).toMatchObject({ actor_type: 'api_token' });
    // A service principal without an integration fails closed.
    await expect(record(f, { actorUserId: f.serviceId, resourceId: 'noint' })).rejects.toThrow(
      /must name its integration/,
    );
    expect(await lastEvent(f, 'noint')).toBeUndefined();
  });

  it('rejects inconsistent actor combinations in the database', async () => {
    const f = await fixture();
    const insert = (
      actorType: string,
      user: string | null,
      integration: string | null,
      token: string | null,
    ) =>
      sql(
        `INSERT INTO audit_events (occurred_at, organization_id, actor_type, actor_user_id,
                                   actor_integration_id, actor_token_id, action, resource_type)
         VALUES (now(), $1, $2, $3, $4, $5, 'test.raw_insert', 'test')`,
        [f.org.organizationId, actorType, user, integration, token],
      );
    const i = randomUUID();
    // Masquerade in both directions.
    await refused(insert('user', f.serviceId, null, null), /service principal cannot be recorded/);
    await refused(insert('api_token', f.humanId, i, null), /must be a service principal/);
    // Missing or inconsistent identity.
    await refused(insert('api_token', f.serviceId, null, null), /audit_events_actor_consistency/);
    await refused(
      insert('api_token', f.serviceId, null, randomUUID()),
      /audit_events_actor_consistency/,
    );
    await refused(insert('api_token', null, i, null), /audit_events_actor_consistency/);
    await refused(insert('user', f.humanId, i, null), /audit_events_actor_consistency/);
    await refused(insert('user', f.humanId, null, randomUUID()), /audit_events_actor_consistency/);
    await refused(insert('user', null, null, null), /audit_events_actor_consistency/);
    await refused(insert('system', f.humanId, null, null), /audit_events_actor_consistency/);
    await refused(insert('system', null, i, null), /audit_events_actor_consistency/);
    await refused(insert('anonymous', null, null, randomUUID()), /audit_events_actor_consistency/);
    await refused(insert('robot', null, null, null), /audit_events_actor_(type_check|consistency)/);
    // The valid shapes still insert.
    await insert('user', f.humanId, null, null);
    await insert('api_token', f.serviceId, i, null);
    await insert('api_token', f.serviceId, i, randomUUID());
    await insert('system', null, null, null);
    await insert('anonymous', null, null, null);
  });

  it('refuses a human recorded as api_token through the application path', async () => {
    const f = await fixture();
    // The application cannot be talked into it: the database verifies the attribution.
    const failure = await record(f, {
      actorUserId: f.humanId,
      actorType: 'api_token',
      actorIntegrationId: randomUUID(),
      resourceId: 'human-as-token',
    }).then(
      () => null,
      (error: { cause?: { code?: string; message?: string } }) => error.cause,
    );
    expect(failure).toMatchObject({
      code: '23514',
      message: expect.stringMatching(/must be a service principal/),
    });
    expect(await lastEvent(f, 'human-as-token')).toBeUndefined();
  });

  it('keeps audit history append-only and visible only inside its organization', async () => {
    const f = await fixture();
    await record(f, {
      actorUserId: f.serviceId,
      actorIntegrationId: randomUUID(),
      resourceId: 'visible',
    });
    const id = (await sql(`SELECT id FROM audit_events WHERE resource_id = 'visible'`)).rows[0].id;
    await expect(
      sql(`UPDATE audit_events SET actor_type = 'user' WHERE id = $1`, [id]),
    ).rejects.toThrow();
    await expect(sql(`DELETE FROM audit_events WHERE id = $1`, [id])).rejects.toThrow();
    const seen = await f.org.owner.get('/organizations/current/audit-events');
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.body)).toContain('api_token');
    const other = await setUpAccountingOrg(ctx);
    expect(
      JSON.stringify((await other.owner.get('/organizations/current/audit-events')).body),
    ).not.toContain(f.serviceId);
  });
});
