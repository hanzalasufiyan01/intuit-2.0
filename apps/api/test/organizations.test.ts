import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectAs,
  createTestContext,
  HOUR,
  MINUTE,
  TEST_PASSWORD,
  tokenFromEmail,
  uniqueEmail,
  type TestClient,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function roleId(client: TestClient, name: string): Promise<string> {
  const roles = await client.get('/organizations/current/roles');
  const role = roles.body.data.find((r: { name: string }) => r.name === name);
  if (!role) throw new Error(`role ${name} not found`);
  return role.id;
}

/** Owner invites a new person with the given role; returns the invitee's signed-in client. */
async function inviteAndJoin(owner: TestClient, roleName: string) {
  const email = uniqueEmail('invitee');
  const created = await owner.post('/organizations/current/invitations', {
    email,
    roleId: await roleId(owner, roleName),
  });
  expect(created.status).toBe(201);
  const token = tokenFromEmail(ctx.email, email);
  const invitee = ctx.client();
  const accepted = await invitee.post('/invitations/accept', {
    token,
    displayName: 'Invited Person',
    password: TEST_PASSWORD,
  });
  expect(accepted.status).toBe(200);
  return { invitee, email, session: accepted.body.data };
}

describe('organizations and ownership', () => {
  it('registration provisions system roles and exactly one Owner', async () => {
    const owner = ctx.client();
    await owner.register();
    const roles = await owner.get('/organizations/current/roles');
    expect(roles.status).toBe(200);
    const names = roles.body.data.map((r: { name: string }) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Owner', 'Administrator', 'Member']));
    const ownerRole = roles.body.data.find((r: { isOwner: boolean }) => r.isOwner);
    expect(ownerRole.memberCount).toBe(1);
    // Owner holds the whole catalog (Phase 1: 8 permissions; Phase 2 adds 18).
    expect(ownerRole.permissionKeys).toHaveLength(26);
    const member = roles.body.data.find((r: { name: string }) => r.name === 'Member');
    expect(member.permissionKeys).toEqual([
      'accounting.accounts.view',
      'accounting.journals.view',
      'accounting.ledger.view',
      'accounting.periods.view',
      'members.read',
      'organization.read',
    ]);

    const members = await owner.get('/organizations/current/members');
    expect(members.body.data).toHaveLength(1);
    expect(members.body.data[0].isOwner).toBe(true);
  });

  it('lets a user create another organization and switch between them', async () => {
    const client = ctx.client();
    const { session } = await client.register({ organizationName: 'First Org' });
    const firstId = session.activeOrganization.id;

    const created = await client.post('/organizations', { name: 'Second Org' });
    expect(created.status).toBe(201);
    const secondId = created.body.data.id;

    const list = await client.get('/organizations');
    expect(list.body.data.map((o: { name: string }) => o.name)).toEqual([
      'First Org',
      'Second Org',
    ]);
    expect(list.body.data.find((o: { active: boolean }) => o.active).id).toBe(secondId);

    const switched = await client.put('/auth/session/organization', { organizationId: firstId });
    expect(switched.status).toBe(200);
    expect(switched.body.data.activeOrganization.id).toBe(firstId);
    expect((await client.get('/organizations/current')).body.data.name).toBe('First Org');
  });

  it('refuses to switch to an organization the user does not belong to', async () => {
    const other = ctx.client();
    const { session } = await other.register();
    const client = ctx.client();
    await client.register();
    const response = await client.put('/auth/session/organization', {
      organizationId: session.activeOrganization.id,
    });
    expect(response.status).toBe(404);
    const unknown = await client.put('/auth/session/organization', {
      organizationId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.status).toBe(404);
  });

  it('updates the organization profile with an audit trail', async () => {
    const owner = ctx.client();
    await owner.register({ organizationName: 'Old Name' });
    const updated = await owner.patch('/organizations/current', { name: 'New Name' });
    expect(updated.status).toBe(200);
    const audit = await owner.get('/organizations/current/audit-events');
    const event = audit.body.data.find(
      (e: { action: string }) => e.action === 'organization.updated',
    );
    expect(event.metadata.changes.name).toEqual({ from: 'Old Name', to: 'New Name' });
  });
});

describe('invitations', () => {
  it('invites a new person who joins with the invited role', async () => {
    const owner = ctx.client();
    const { session: ownerSession } = await owner.register({ organizationName: 'Invite Org' });
    const { invitee, session } = await inviteAndJoin(owner, 'Member');
    expect(session.activeOrganization.id).toBe(ownerSession.activeOrganization.id);
    expect(session.activeOrganization.isOwner).toBe(false);
    expect(session.activeOrganization.permissions).toEqual([
      'accounting.accounts.view',
      'accounting.journals.view',
      'accounting.ledger.view',
      'accounting.periods.view',
      'members.read',
      'organization.read',
    ]);
    expect((await invitee.get('/organizations/current')).body.data.name).toBe('Invite Org');

    const invitations = await owner.get('/organizations/current/invitations');
    expect(invitations.body.data[0].status).toBe('accepted');
    const actions = (await owner.get('/organizations/current/audit-events')).body.data.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['invitation.created', 'invitation.accepted', 'membership.created']),
    );
  });

  it('lets an existing user accept only while signed in with the invited email', async () => {
    const owner = ctx.client();
    await owner.register({ organizationName: 'Second Home' });
    const existing = ctx.client();
    const { email } = await existing.register({ organizationName: 'Home Org' });
    await owner.post('/organizations/current/invitations', {
      email,
      roleId: await roleId(owner, 'Administrator'),
    });
    const token = tokenFromEmail(ctx.email, email);

    const preview = await ctx.client().post('/invitations/lookup', { token });
    expect(preview.body.data).toMatchObject({
      organizationName: 'Second Home',
      accountExists: true,
      status: 'pending',
    });

    const anonymous = await ctx.client().post('/invitations/accept', { token });
    expect(anonymous.status).toBe(409);
    expect(anonymous.body.error.code).toBe('LOGIN_REQUIRED');

    const someoneElse = ctx.client();
    await someoneElse.register();
    const mismatch = await someoneElse.post('/invitations/accept', { token });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');

    const accepted = await existing.post('/invitations/accept', { token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.organizations.map((o: { name: string }) => o.name)).toEqual([
      'Home Org',
      'Second Home',
    ]);
    expect(accepted.body.data.activeOrganization.name).toBe('Second Home');

    const again = await existing.post('/invitations/accept', { token });
    expect(again.status).toBe(409);
  });

  it('expires invitations after 72 hours', async () => {
    expect(ctx.config.invitations.expiryMs).toBe(72 * HOUR);
    const owner = ctx.client();
    const { email: ownerEmail } = await owner.register();
    const email = uniqueEmail('late');
    const created = await owner.post('/organizations/current/invitations', {
      email,
      roleId: await roleId(owner, 'Member'),
    });
    expect(
      new Date(created.body.data.expiresAt).getTime() -
        new Date(created.body.data.createdAt).getTime(),
    ).toBe(72 * HOUR);
    const token = tokenFromEmail(ctx.email, email);

    ctx.clock.advance(72 * HOUR + MINUTE);
    const response = await ctx.client().post('/invitations/accept', {
      token,
      displayName: 'Too Late',
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe('INVITATION_EXPIRED');

    // The owner's session idled out meanwhile; after signing in again a fresh invitation
    // can be issued because the old one lapsed.
    expect((await owner.get('/auth/session')).status).toBe(401);
    expect((await owner.login(ownerEmail)).status).toBe(200);
    const reinvite = await owner.post('/organizations/current/invitations', {
      email,
      roleId: await roleId(owner, 'Member'),
    });
    expect(reinvite.status).toBe(201);
  });

  it('revoked invitations cannot be accepted and unknown tokens are rejected', async () => {
    const owner = ctx.client();
    await owner.register();
    const email = uniqueEmail('revoked');
    const created = await owner.post('/organizations/current/invitations', {
      email,
      roleId: await roleId(owner, 'Member'),
    });
    const token = tokenFromEmail(ctx.email, email);
    expect(
      (await owner.post(`/organizations/current/invitations/${created.body.data.id}/revoke`))
        .status,
    ).toBe(204);
    const response = await ctx.client().post('/invitations/accept', {
      token,
      displayName: 'Nope',
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INVITATION_NOT_PENDING');

    const bogus = await ctx.client().post('/invitations/lookup', { token: 'x'.repeat(43) });
    expect(bogus.status).toBe(404);
  });

  it('stores only a hash of invitation tokens and never grants Owner by invitation', async () => {
    const owner = ctx.client();
    await owner.register();
    const email = uniqueEmail('hash');
    const ownerRole = await roleId(owner, 'Owner');
    const denied = await owner.post('/organizations/current/invitations', {
      email,
      roleId: ownerRole,
    });
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('PROTECTED_RESOURCE');

    await owner.post('/organizations/current/invitations', {
      email,
      roleId: await roleId(owner, 'Member'),
    });
    const token = tokenFromEmail(ctx.email, email);
    const db = await connectAs('owner');
    try {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM invitations WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
        [token],
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await db.end();
    }
  });
});

describe('RBAC', () => {
  it('denies actions the member lacks permission for', async () => {
    const owner = ctx.client();
    await owner.register();
    const { invitee } = await inviteAndJoin(owner, 'Member');

    expect((await invitee.get('/organizations/current/members')).status).toBe(200);
    for (const [method, url, body] of [
      ['GET', '/organizations/current/roles', undefined],
      ['GET', '/organizations/current/audit-events', undefined],
      ['GET', '/organizations/current/invitations', undefined],
      ['PATCH', '/organizations/current', { name: 'Hijacked' }],
      [
        'POST',
        '/organizations/current/invitations',
        { email: uniqueEmail(), roleId: '00000000-0000-4000-8000-000000000000' },
      ],
    ] as const) {
      const response = await invitee.request(method, url, body);
      expect(response.status, `${method} ${url}`).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('assigning a role grants its permissions; sensitive changes need re-authentication', async () => {
    const owner = ctx.client();
    await owner.register();
    const { invitee, session } = await inviteAndJoin(owner, 'Member');
    const membershipId = session.activeOrganization.membershipId;
    const adminRole = await roleId(owner, 'Administrator');

    ctx.clock.advance(16 * MINUTE);
    await owner.get('/auth/session');
    const stale = await owner.put(`/organizations/current/members/${membershipId}/roles`, {
      roleIds: [adminRole],
    });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');

    await owner.reauthenticate();
    const assigned = await owner.put(`/organizations/current/members/${membershipId}/roles`, {
      roleIds: [adminRole],
    });
    expect(assigned.status).toBe(200);

    // Permissions are re-evaluated on every request.
    await invitee.get('/auth/session');
    expect((await invitee.get('/organizations/current/roles')).status).toBe(200);
    expect((await invitee.get('/organizations/current/audit-events')).status).toBe(200);
  });

  it('protects the Owner role and the Owner membership', async () => {
    const owner = ctx.client();
    const { session } = await owner.register();
    const ownerMembership = session.activeOrganization.membershipId;
    const { invitee, session: memberSession } = await inviteAndJoin(owner, 'Administrator');
    const ownerRole = await roleId(owner, 'Owner');
    await invitee.reauthenticate();

    const grantOwner = await invitee.put(
      `/organizations/current/members/${memberSession.activeOrganization.membershipId}/roles`,
      { roleIds: [ownerRole] },
    );
    expect(grantOwner.status).toBe(409);
    expect(grantOwner.body.error.code).toBe('PROTECTED_RESOURCE');

    const demoteOwner = await invitee.put(
      `/organizations/current/members/${ownerMembership}/roles`,
      {
        roleIds: [],
      },
    );
    expect(demoteOwner.status).toBe(409);

    const disableOwner = await invitee.patch(`/organizations/current/members/${ownerMembership}`, {
      status: 'disabled',
    });
    expect(disableOwner.status).toBe(409);

    const editOwnerRole = await invitee.put(`/organizations/current/roles/${ownerRole}`, {
      name: 'Owner',
      description: '',
      permissionKeys: [],
    });
    expect(editOwnerRole.status).toBe(409);
    expect((await invitee.delete(`/organizations/current/roles/${ownerRole}`)).status).toBe(409);
  });

  it('supports custom roles with granular permissions', async () => {
    const owner = ctx.client();
    await owner.register();
    const { invitee, session } = await inviteAndJoin(owner, 'Member');

    const unknown = await owner.post('/organizations/current/roles', {
      name: 'Bad',
      permissionKeys: ['invoices.delete'],
    });
    expect(unknown.status).toBe(400);

    const created = await owner.post('/organizations/current/roles', {
      name: 'Auditor',
      description: 'Reads audit history',
      permissionKeys: ['audit.read', 'organization.read'],
    });
    expect(created.status).toBe(201);
    const auditorId = created.body.data.id;

    expect((await invitee.get('/organizations/current/audit-events')).status).toBe(403);
    await owner.put(
      `/organizations/current/members/${session.activeOrganization.membershipId}/roles`,
      {
        roleIds: [auditorId],
      },
    );
    expect((await invitee.get('/organizations/current/audit-events')).status).toBe(200);
    // Member role was replaced, so members.read is gone.
    expect((await invitee.get('/organizations/current/members')).status).toBe(403);

    // Assigned roles cannot be deleted; unassigned custom roles can.
    expect((await owner.delete(`/organizations/current/roles/${auditorId}`)).status).toBe(409);
    await owner.put(
      `/organizations/current/members/${session.activeOrganization.membershipId}/roles`,
      {
        roleIds: [],
      },
    );
    expect((await owner.delete(`/organizations/current/roles/${auditorId}`)).status).toBe(204);

    const actions = (await owner.get('/organizations/current/audit-events')).body.data.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['role.created', 'role.deleted', 'membership.roles_changed']),
    );
  });

  it('system roles keep their name but their permissions are customizable', async () => {
    const owner = ctx.client();
    await owner.register();
    const memberRole = await roleId(owner, 'Member');
    const rename = await owner.put(`/organizations/current/roles/${memberRole}`, {
      name: 'Staff',
      permissionKeys: ['organization.read'],
    });
    expect(rename.status).toBe(409);
    const customize = await owner.put(`/organizations/current/roles/${memberRole}`, {
      name: 'Member',
      description: 'Customized',
      permissionKeys: ['organization.read'],
    });
    expect(customize.status).toBe(200);
    expect(customize.body.data.permissionKeys).toEqual(['organization.read']);
  });

  it('a disabled membership loses access immediately', async () => {
    const owner = ctx.client();
    await owner.register();
    const { invitee, session } = await inviteAndJoin(owner, 'Member');
    expect((await invitee.get('/organizations/current')).status).toBe(200);
    const disabled = await owner.patch(
      `/organizations/current/members/${session.activeOrganization.membershipId}`,
      {
        status: 'disabled',
      },
    );
    expect(disabled.status).toBe(200);
    const response = await invitee.get('/organizations/current');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('exposes the permission catalog without invoices.delete', async () => {
    const owner = ctx.client();
    await owner.register();
    const catalog = await owner.get('/permissions');
    const keys = catalog.body.data.map((p: { key: string }) => p.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'organization.read',
        'organization.update',
        'members.read',
        'members.invite',
        'members.manage',
        'roles.read',
        'roles.manage',
        'audit.read',
      ]),
    );
    expect(keys).not.toContain('invoices.delete');
  });
});

describe('cross-organization isolation', () => {
  it('cannot reach another organization’s resources even with their IDs', async () => {
    const alice = ctx.client();
    await alice.register({ organizationName: 'Alice Co' });
    const bob = ctx.client();
    await bob.register({ organizationName: 'Bob Co' });
    await bob.post('/organizations/current/invitations', {
      email: uniqueEmail(),
      roleId: await roleId(bob, 'Member'),
    });

    const bobMembers = (await bob.get('/organizations/current/members')).body.data;
    const bobRoles = (await bob.get('/organizations/current/roles')).body.data;
    const bobInvitations = (await bob.get('/organizations/current/invitations')).body.data;
    const bobMembership = bobMembers[0].membershipId;
    const bobMemberRole = bobRoles.find((r: { name: string }) => r.name === 'Member').id;
    const bobAdminRole = bobRoles.find((r: { name: string }) => r.name === 'Administrator').id;

    const attempts = [
      alice.put(`/organizations/current/members/${bobMembership}/roles`, { roleIds: [] }),
      alice.patch(`/organizations/current/members/${bobMembership}`, { status: 'disabled' }),
      alice.put(`/organizations/current/roles/${bobMemberRole}`, {
        name: 'Member',
        permissionKeys: ['audit.read'],
      }),
      alice.delete(`/organizations/current/roles/${bobAdminRole}`),
      alice.post(`/organizations/current/invitations/${bobInvitations[0].id}/revoke`),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(404);
    }

    // Using Bob's role id for Alice's own member or invitation is rejected too.
    const aliceMembership = (await alice.get('/organizations/current/members')).body.data[0]
      .membershipId;
    const invite = await alice.post('/organizations/current/invitations', {
      email: uniqueEmail(),
      roleId: bobMemberRole,
    });
    expect(invite.status).toBe(400);
    const assign = await alice.put(`/organizations/current/members/${aliceMembership}/roles`, {
      roleIds: [bobMemberRole],
    });
    expect([400, 409]).toContain(assign.status);

    // Alice's listings never include Bob's data.
    const aliceRoles = (await alice.get('/organizations/current/roles')).body.data.map(
      (r: { id: string }) => r.id,
    );
    expect(aliceRoles).not.toContain(bobMemberRole);
    const aliceAudit = JSON.stringify(
      (await alice.get('/organizations/current/audit-events')).body,
    );
    expect(aliceAudit).not.toContain('Bob Co');

    // Bob's data is unchanged.
    const after = (await bob.get('/organizations/current/roles')).body.data;
    expect(after.find((r: { name: string }) => r.name === 'Member').permissionKeys).toEqual([
      'accounting.accounts.view',
      'accounting.journals.view',
      'accounting.ledger.view',
      'accounting.periods.view',
      'members.read',
      'organization.read',
    ]);
  });
});
