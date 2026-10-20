import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, HOUR, type TestContext } from './helpers.js';

/**
 * The controlled ownership-transfer workflow (master context section 8, ADR 0012) on real
 * PostgreSQL: initiate -> security verification -> accept -> ownership changes -> audit and
 * notifications. Expiry (which advances the test clock) comes last.
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

const sql = (text: string, params: unknown[] = []) => owner.query(text, params);
const BASE = '/organizations/current/ownership-transfers';

interface Person {
  client: Awaited<ReturnType<typeof joinWithRole>>['client'];
  email: string;
  userId: string;
  membershipId: string;
  roleId: string;
}

/** An organization with an Owner and two Administrators who already have MFA (Admin requires it). */
async function world() {
  const org = await setUpAccountingOrg(ctx);
  const a = (await joinWithRole(ctx, org.owner, 'Administrator')) as Person;
  const b = (await joinWithRole(ctx, org.owner, 'Administrator')) as Person;
  // The new owner must already use MFA (the Owner role requires it): enroll both administrators.
  for (const p of [a, b]) await p.client.enrollMfa();
  const roles = (await org.owner.get('/organizations/current/roles')).body.data as {
    id: string;
    name: string;
    isOwner: boolean;
  }[];
  return { org, a, b, ownerRole: roles.find((r) => r.isOwner)!, adminRoleId: a.roleId };
}

const initiate = (org: AccountingOrg, to: string, replacementRoleId: string) =>
  org.owner.post(BASE, { toMembershipId: to, replacementRoleId });

const ownerMembershipOf = async (organizationId: string) =>
  (
    await sql(
      `SELECT membership_id FROM membership_roles WHERE organization_id = $1 AND role_is_owner`,
      [organizationId],
    )
  ).rows.map((r) => r.membership_id as string);

const audits = async (organizationId: string) =>
  (
    await sql(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'ownership_transfer.%' OR (organization_id = $1 AND action = 'organization.owner_changed') ORDER BY occurred_at, id`,
      [organizationId],
    )
  ).rows.map((r) => r.action as string);

describe('ownership transfer workflow', () => {
  it('moves the Owner role in one step after both people verify, and notifies everyone concerned', async () => {
    const { org, a, b, adminRoleId } = await world();
    const originalOwner = (await ownerMembershipOf(org.organizationId))[0]!;
    const res = await initiate(org, a.membershipId, adminRoleId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const transfer = res.body.data;
    expect(transfer).toMatchObject({
      status: 'verified',
      to: { membershipId: a.membershipId, email: a.email },
      replacementRole: { id: adminRoleId },
    });
    expect(transfer.verifiedAt).not.toBeNull();
    // Nothing changed yet: the Owner is still the Owner.
    expect(await ownerMembershipOf(org.organizationId)).toEqual([originalOwner]);
    // The new owner was told; the offer carries no token or link.
    const offer = ctx.email.sent.filter((m) => m.template === 'ownership-transfer-offered');
    expect(offer.map((m) => m.to)).toEqual([a.email]);
    expect(offer[0]!.text).not.toMatch(/https?:|token/i);
    // Only the person offered ownership can accept it; others (even administrators) see nothing.
    expect((await b.client.post(`${BASE}/${transfer.id}/accept`, {})).status).toBe(404);
    expect((await org.owner.post(`${BASE}/${transfer.id}/accept`, {})).status).toBe(404);
    expect((await b.client.get(BASE)).body.data.items).toHaveLength(1); // b holds members.manage
    const accepted = await a.client.post(`${BASE}/${transfer.id}/accept`, {});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data).toMatchObject({ status: 'completed' });
    expect(accepted.body.data.completedAt).not.toBeNull();
    // Exactly one Owner, and it is the new one; the previous owner holds the replacement role.
    expect(await ownerMembershipOf(org.organizationId)).toEqual([a.membershipId]);
    const previous = (
      await sql(
        `SELECT r.name, mr.role_is_owner FROM membership_roles mr JOIN roles r ON r.id = mr.role_id
          WHERE mr.membership_id = $1`,
        [originalOwner],
      )
    ).rows;
    expect(previous).toEqual([{ name: 'Administrator', role_is_owner: false }]);
    expect(await audits(org.organizationId)).toEqual([
      'ownership_transfer.initiated',
      'ownership_transfer.accepted',
      'ownership_transfer.completed',
      'organization.owner_changed',
    ]);
    // New owner, previous owner and the other administrator are notified.
    const done = ctx.email.sent.filter((m) =>
      m.template.startsWith('ownership-transfer-completed'),
    );
    const byTemplate = new Map(done.map((m) => [m.template, m.to]));
    expect(byTemplate.get('ownership-transfer-completed-new-owner')).toBe(a.email);
    expect(byTemplate.get('ownership-transfer-completed-previous-owner')).toBe(org.ownerEmail);
    expect(done.filter((m) => m.template.endsWith('-admin')).map((m) => m.to)).toContain(b.email);
    // The previous owner is no longer Owner: Owner-only actions are refused, the new owner may act.
    expect(
      (
        await org.owner.post(BASE, {
          toMembershipId: b.membershipId,
          replacementRoleId: adminRoleId,
        })
      ).status,
    ).toBe(403);
    const next = await a.client.post(BASE, {
      toMembershipId: b.membershipId,
      replacementRoleId: adminRoleId,
    });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    // History is permanent and visible to the owner.
    const history = (await a.client.get(BASE)).body.data.items as { status: string }[];
    expect(history.map((t) => t.status).sort()).toEqual(['completed', 'verified']);
  });

  it('validates who may receive ownership and which role the previous owner keeps', async () => {
    const { org, a, ownerRole, adminRoleId } = await world();
    const member = (await joinWithRole(ctx, org.owner, 'Member')) as Person; // no MFA enrolled
    const ownerMembership = (await ownerMembershipOf(org.organizationId))[0]!;
    const issues = async (to: string, role: string) => {
      const res = await initiate(org, to, role);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      return (res.body.error.details.issues as { path: string; message: string }[]).map(
        (i) => `${i.path}: ${i.message}`,
      );
    };
    expect((await issues(member.membershipId, adminRoleId)).join(' ')).toMatch(/multi-factor/);
    expect((await issues(ownerMembership, adminRoleId)).join(' ')).toMatch(/someone else/);
    expect((await issues(randomUUID(), adminRoleId)).join(' ')).toMatch(/active member/);
    expect((await issues(a.membershipId, ownerRole.id)).join(' ')).toMatch(
      /cannot be the Owner role/,
    );
    expect((await issues(a.membershipId, randomUUID())).join(' ')).toMatch(/does not exist/);
    // Only the Owner starts a transfer.
    const refused = await a.client.post(BASE, {
      toMembershipId: a.membershipId,
      replacementRoleId: adminRoleId,
    });
    expect(refused.status).toBe(403);
    // Strict body.
    expect(
      (
        await org.owner.post(BASE, {
          toMembershipId: a.membershipId,
          replacementRoleId: adminRoleId,
          extra: 1,
        })
      ).status,
    ).toBe(400);
  });

  it('allows one open transfer at a time, and lets the owner cancel or the new owner decline', async () => {
    const { org, a, b, adminRoleId } = await world();
    const first = await initiate(org, a.membershipId, adminRoleId);
    expect(first.status).toBe(201);
    const second = await initiate(org, b.membershipId, adminRoleId);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
    // A reason is required; only the owner cancels, only the addressee declines.
    expect((await org.owner.post(`${BASE}/${first.body.data.id}/cancel`, {})).status).toBe(400);
    expect(
      (await b.client.post(`${BASE}/${first.body.data.id}/cancel`, { reason: 'no' })).status,
    ).toBe(404);
    expect(
      (await a.client.post(`${BASE}/${first.body.data.id}/cancel`, { reason: 'no' })).status,
    ).toBe(404);
    expect(
      (await org.owner.post(`${BASE}/${first.body.data.id}/decline`, { reason: 'no' })).status,
    ).toBe(404);
    const declined = await a.client.post(`${BASE}/${first.body.data.id}/decline`, {
      reason: 'Not me',
    });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'Not me' });
    // A finished transfer cannot be accepted or cancelled, and a new one can be started.
    expect((await a.client.post(`${BASE}/${first.body.data.id}/accept`, {})).status).toBe(409);
    expect(
      (await org.owner.post(`${BASE}/${first.body.data.id}/cancel`, { reason: 'again' })).status,
    ).toBe(409);
    const again = await initiate(org, b.membershipId, adminRoleId);
    expect(again.status).toBe(201);
    const cancelled = await org.owner.post(`${BASE}/${again.body.data.id}/cancel`, {
      reason: 'Changed my mind',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(await audits(org.organizationId)).toEqual([
      'ownership_transfer.initiated',
      'ownership_transfer.declined',
      'ownership_transfer.initiated',
      'ownership_transfer.cancelled',
    ]);
    // Ownership never moved.
    expect(await ownerMembershipOf(org.organizationId)).toHaveLength(1);
  });

  it('is tenant isolated: another organization sees and can do nothing', async () => {
    const { org, a, adminRoleId } = await world();
    const transfer = (await initiate(org, a.membershipId, adminRoleId)).body.data;
    const other = await world();
    expect((await other.org.owner.get(BASE)).body.data.items).toEqual([]);
    expect((await other.a.client.post(`${BASE}/${transfer.id}/accept`, {})).status).toBe(404);
    expect(
      (await other.org.owner.post(`${BASE}/${transfer.id}/cancel`, { reason: 'x' })).status,
    ).toBe(404);
  });

  it('demands the password confirmation and the second factor for both sides', async () => {
    const { org, a, adminRoleId } = await world();
    org.owner.autoMfa = false;
    a.client.autoMfa = false;
    ctx.clock.advance(16 * 60_000); // past the re-authentication and step-up windows
    await org.owner.get('/auth/session');
    const stale = await initiate(org, a.membershipId, adminRoleId);
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await org.owner.reauthenticate()).status).toBe(200);
    const noFactor = await initiate(org, a.membershipId, adminRoleId);
    expect(noFactor.body.error.code).toBe('MFA_STEP_UP_REQUIRED');
    expect((await org.owner.stepUp()).status).toBe(200);
    const started = await initiate(org, a.membershipId, adminRoleId);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    // The new owner needs the same verification to accept.
    await a.client.get('/auth/session');
    const acceptStale = await a.client.post(`${BASE}/${started.body.data.id}/accept`, {});
    expect(acceptStale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await a.client.reauthenticate()).status).toBe(200);
    expect(
      (await a.client.post(`${BASE}/${started.body.data.id}/accept`, {})).body.error.code,
    ).toBe('MFA_STEP_UP_REQUIRED');
    expect((await a.client.stepUp()).status).toBe(200);
    const done = await a.client.post(`${BASE}/${started.body.data.id}/accept`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await ownerMembershipOf(org.organizationId)).toEqual([a.membershipId]);
  });

  it('protects the history in the database: forward-only states, fixed participants, no delete', async () => {
    const { org, a, adminRoleId } = await world();
    const id = (await initiate(org, a.membershipId, adminRoleId)).body.data.id as string;
    await expect(
      sql(`UPDATE ownership_transfers SET status = 'initiated' WHERE id = $1`, [id]),
    ).rejects.toThrow(/Invalid ownership transfer status change/);
    await expect(
      sql(`UPDATE ownership_transfers SET to_membership_id = from_membership_id WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/cannot change who is involved/);
    await expect(
      sql(`UPDATE ownership_transfers SET status = 'completed' WHERE id = $1`, [id]),
    ).rejects.toThrow(
      /Invalid ownership transfer status change|ownership_transfers_status_timestamps/,
    );
    await org.owner.post(`${BASE}/${id}/cancel`, { reason: 'done' });
    await expect(
      sql(`UPDATE ownership_transfers SET status = 'verified' WHERE id = $1`, [id]),
    ).rejects.toThrow(/final/);
    // The application role can read and write transfers but never delete them.
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [org.organizationId]);
      await expect(
        app.query(`DELETE FROM ownership_transfers WHERE id = $1`, [id]),
      ).rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });

  it('expires an offer that is not accepted in time, and then a new one can start', async () => {
    const { org, a, adminRoleId } = await world();
    const id = (await initiate(org, a.membershipId, adminRoleId)).body.data.id as string;
    ctx.clock.advance(73 * HOUR); // the offer lasts 72 hours
    const signedIn = await a.client.login(a.email);
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const late = await a.client.post(`${BASE}/${id}/accept`, {});
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/expired/);
    const row = (
      await sql(`SELECT status, expired_at FROM ownership_transfers WHERE id = $1`, [id])
    ).rows[0];
    expect(row.status).toBe('expired');
    expect(row.expired_at).not.toBeNull();
    expect(await audits(org.organizationId)).toContain('ownership_transfer.expired');
    expect(await ownerMembershipOf(org.organizationId)).not.toContain(a.membershipId);
    await org.owner.login(org.ownerEmail);
    const retry = await initiate(org, a.membershipId, adminRoleId);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
  });
});
