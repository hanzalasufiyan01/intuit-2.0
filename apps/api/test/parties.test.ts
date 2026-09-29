import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrationFiles } from '../src/database/migrator.js';
import { joinWithRole } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 3A S4 — unified Party master (Decisions 8, 28, 65, 90; S4-08..S4-11, S4-13..S4-17,
 * S4-19, S4-20, S4-22) on real PostgreSQL.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function newOwner(): Promise<TestClient> {
  const owner = ctx.client();
  await owner.register();
  return owner;
}

async function create(client: TestClient, body: object) {
  const res = await client.post('/parties', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

const billing = (overrides: object = {}) => ({
  kind: 'billing',
  line1: 'Orchid Magu',
  city: 'Malé',
  countryCode: 'MV',
  ...overrides,
});

describe('party create and read (S4-08, S4-09, S4-20)', () => {
  it('creates an organization party with roles, contact persons and addresses', async () => {
    const owner = await newOwner();
    const party = await create(owner, {
      kind: 'organization',
      displayName: 'Blue Lagoon Traders',
      companyName: 'Blue Lagoon Traders Pvt Ltd',
      reference: 'C-001',
      tin: '1002003GST501',
      email: 'ap@bluelagoon.test',
      roles: ['vendor', 'customer'],
      contacts: [
        {
          firstName: 'Aisha',
          lastName: 'Rasheed',
          email: 'aisha@bluelagoon.test',
          isPrimary: true,
          receivesDocuments: true,
        },
        { firstName: 'Ibrahim', jobTitle: 'Manager' },
      ],
      addresses: [
        billing({ isDefault: true }),
        { ...billing(), kind: 'delivery', line1: 'Harbour Road', isDefault: true },
      ],
    });
    expect(party).toMatchObject({
      kind: 'organization',
      displayName: 'Blue Lagoon Traders',
      roles: ['customer', 'vendor'],
      status: 'ACTIVE',
      version: 1,
      warnings: [],
    });
    expect(
      party.contacts.map((c: { firstName: string; isPrimary: boolean }) => [
        c.firstName,
        c.isPrimary,
      ]),
    ).toEqual([
      ['Aisha', true],
      ['Ibrahim', false],
    ]);
    expect(party.addresses).toHaveLength(2);
    const fetched = (await owner.get(`/parties/${party.id}`)).body.data;
    expect(fetched).toMatchObject({ id: party.id, reference: 'C-001' });
    // All four roles are assignable (S4-20); no roles is allowed.
    await create(owner, {
      kind: 'organization',
      displayName: 'Staff Person',
      roles: ['employee', 'other'],
    });
    await create(owner, { kind: 'organization', displayName: 'No Role Ltd' });
  });

  it('applies display-name rules and a case-insensitive unique reference', async () => {
    const owner = await newOwner();
    const individual = await create(owner, {
      kind: 'individual',
      firstName: 'Mariyam',
      lastName: 'Shifa',
    });
    expect(individual.displayName).toBe('Mariyam Shifa');
    expect((await owner.post('/parties', { kind: 'individual' })).status).toBe(400);
    expect((await owner.post('/parties', { kind: 'organization', companyName: 'X' })).status).toBe(
      400,
    );
    await create(owner, { kind: 'organization', displayName: 'A', reference: 'REF-1' });
    const dup = await owner.post('/parties', {
      kind: 'organization',
      displayName: 'B',
      reference: 'ref-1',
    });
    expect(dup.status).toBe(409);
    await create(owner, { kind: 'organization', displayName: 'C' });
    await create(owner, { kind: 'organization', displayName: 'D' }); // many null references are fine
  });

  it('validates contacts, addresses and strict schemas', async () => {
    const owner = await newOwner();
    const bad = (body: object) =>
      owner.post('/parties', { kind: 'organization', displayName: 'X', ...body });
    expect((await bad({ contacts: [{ jobTitle: 'No name' }] })).status).toBe(400);
    expect(
      (
        await bad({
          contacts: [
            { firstName: 'A', isPrimary: true },
            { firstName: 'B', isPrimary: true },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (await bad({ addresses: [billing({ isDefault: true }), billing({ isDefault: true })] }))
        .status,
    ).toBe(400);
    expect((await bad({ addresses: [billing({ countryCode: 'ZZ' })] })).status).toBe(400);
    expect((await bad({ email: 'not-an-email' })).status).toBe(400);
    expect((await bad({ roles: ['supplier'] })).status).toBe(400);
    expect((await bad({ currency: 'USD' })).status).toBe(400); // no customer defaults on Party
    expect((await bad({ creditLimit: '100' })).status).toBe(400);
    expect((await bad({ contacts: [{ firstName: 'A', ssn: 'x' }] })).status).toBe(400);
  });
});

describe('duplicate hints (S4-13)', () => {
  it('warns on same TIN, email or normalized name among active parties, never blocking', async () => {
    const owner = await newOwner();
    const first = await create(owner, {
      kind: 'organization',
      displayName: 'Coral  Bay Supplies',
      tin: 'TIN-777',
      email: 'sales@coral.test',
    });
    const second = await create(owner, { kind: 'organization', displayName: 'coral bay supplies' });
    expect(second.warnings).toEqual([
      expect.objectContaining({
        code: 'POSSIBLE_DUPLICATE',
        matches: [{ partyId: first.id, matchedOn: ['name'] }],
      }),
    ]);
    const third = await create(owner, {
      kind: 'organization',
      displayName: 'Other',
      tin: 'tin-777',
      email: 'SALES@coral.test',
    });
    expect(third.warnings[0].matches).toEqual([{ partyId: first.id, matchedOn: ['tin', 'email'] }]);
    // Archived parties are not suggested.
    await owner.post(`/parties/${first.id}/archive`, {});
    const fourth = await create(owner, {
      kind: 'organization',
      displayName: 'Another',
      tin: 'TIN-777',
    });
    expect(fourth.warnings[0].matches.map((m: { partyId: string }) => m.partyId)).toEqual([
      third.id,
    ]);
  });
});

describe('updates and optimistic concurrency (S4-14)', () => {
  it('updates with the current version, rejects stale versions and audits business fields only', async () => {
    const owner = await newOwner();
    const party = await create(owner, {
      kind: 'organization',
      displayName: 'Atoll Foods',
      roles: ['customer'],
    });
    const updated = await owner.patch(`/parties/${party.id}`, {
      version: 1,
      displayName: 'Atoll Foods Co',
      email: 'private@atoll.test',
      roles: ['customer', 'vendor'],
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data).toMatchObject({
      version: 2,
      displayName: 'Atoll Foods Co',
      roles: ['customer', 'vendor'],
    });
    const stale = await owner.patch(`/parties/${party.id}`, {
      version: 1,
      displayName: 'Lost update',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await owner.patch(`/parties/${party.id}`, { version: 2, nickname: 'x' })).status).toBe(
      400,
    );

    const audit = (await owner.get('/organizations/current/audit-events?limit=5')).body.data;
    const entry = audit.find((e: { action: string }) => e.action === 'party.updated');
    expect(entry.metadata).toMatchObject({
      changedFields: expect.arrayContaining(['displayName', 'email', 'roles']),
      before: { displayName: 'Atoll Foods', roles: ['customer'] },
      after: { displayName: 'Atoll Foods Co', roles: ['customer', 'vendor'] },
    });
    // S4-19: personal contact values are never stored in audit metadata.
    expect(JSON.stringify(entry.metadata)).not.toContain('private@atoll.test');
  });
});

describe('contact persons and addresses (S4-10)', () => {
  it('switches the single primary contact and default address, and bumps the party version', async () => {
    const owner = await newOwner();
    const party = await create(owner, {
      kind: 'organization',
      displayName: 'Reef Divers',
      contacts: [{ firstName: 'Ali', isPrimary: true }],
      addresses: [billing({ isDefault: true })],
    });
    const added = await owner.post(`/parties/${party.id}/contacts`, {
      firstName: 'Hawwa',
      email: 'hawwa@reef.test',
      isPrimary: true,
    });
    expect(added.status).toBe(201);
    expect(added.body.data.version).toBe(2);
    expect(
      added.body.data.contacts
        .filter((c: { isPrimary: boolean }) => c.isPrimary)
        .map((c: { firstName: string }) => c.firstName),
    ).toEqual(['Hawwa']);
    const ali = added.body.data.contacts.find((c: { firstName: string }) => c.firstName === 'Ali');
    const patched = await owner.patch(`/parties/${party.id}/contacts/${ali.id}`, {
      isPrimary: true,
      jobTitle: 'Owner',
    });
    expect(patched.body.data.contacts.find((c: { id: string }) => c.id === ali.id)).toMatchObject({
      isPrimary: true,
      jobTitle: 'Owner',
    });
    expect(
      (await owner.patch(`/parties/${party.id}/contacts/${ali.id}`, { firstName: null })).status,
    ).toBe(400);
    expect((await owner.delete(`/parties/${party.id}/contacts/${ali.id}`)).status).toBe(200);

    const secondBilling = await owner.post(
      `/parties/${party.id}/addresses`,
      billing({ line1: 'New St', isDefault: true }),
    );
    const defaults = secondBilling.body.data.addresses.filter(
      (a: { isDefault: boolean; kind: string }) => a.isDefault,
    );
    expect(defaults.map((a: { line1: string }) => a.line1)).toEqual(['New St']);
    const oldBilling = secondBilling.body.data.addresses.find(
      (a: { line1: string }) => a.line1 === 'Orchid Magu',
    );
    const moved = await owner.patch(`/parties/${party.id}/addresses/${oldBilling.id}`, {
      kind: 'delivery',
      isDefault: true,
    });
    expect(
      moved.body.data.addresses.find((a: { id: string }) => a.id === oldBilling.id),
    ).toMatchObject({
      kind: 'delivery',
      isDefault: true,
    });
    expect(
      (await owner.patch(`/parties/${party.id}/addresses/${oldBilling.id}`, { countryCode: 'ZZ' }))
        .status,
    ).toBe(400);
    expect((await owner.delete(`/parties/${party.id}/addresses/${oldBilling.id}`)).status).toBe(
      200,
    );

    // S4-19: contact values are not in the audit trail.
    const audit = (await owner.get('/organizations/current/audit-events?limit=20')).body.data;
    const addedEvent = audit.find((e: { action: string }) => e.action === 'party.contact_added');
    expect(addedEvent.metadata.fields).toEqual(expect.arrayContaining(['firstName', 'email']));
    expect(JSON.stringify(audit)).not.toContain('hawwa@reef.test');
    expect(audit.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining([
        'party.contact_updated',
        'party.contact_removed',
        'party.address_added',
        'party.address_updated',
        'party.address_removed',
      ]),
    );
  });
});

describe('database integrity for contacts and addresses', () => {
  it('enforces one primary contact and one default address per kind even bypassing the service', async () => {
    const owner = await newOwner();
    const party = await create(owner, {
      kind: 'organization',
      displayName: 'Integrity Co',
      contacts: [{ firstName: 'P', isPrimary: true }],
      addresses: [billing({ isDefault: true })],
    });
    const orgId = (await owner.get('/organizations/current')).body.data.id;
    const db = await connectAs('app');
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.organization_id', $1, true)`, [orgId]);
      await db.query('SAVEPOINT s');
      await expect(
        db.query(
          `INSERT INTO party_contacts (party_id, organization_id, first_name, is_primary) VALUES ($1, $2, 'Q', true)`,
          [party.id, orgId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await db.query('ROLLBACK TO SAVEPOINT s');
      await expect(
        db.query(
          `INSERT INTO party_addresses (party_id, organization_id, kind, line1, country_code, is_default)
           VALUES ($1, $2, 'billing', 'x', 'MV', true)`,
          [party.id, orgId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  });
});

describe('archive and restore (S4-11)', () => {
  it('archives and restores, never deletes, and filters lists by status', async () => {
    const owner = await newOwner();
    const party = await create(owner, { kind: 'organization', displayName: 'Old Supplier' });
    expect((await owner.post(`/parties/${party.id}/archive`, { reason: 'x' })).status).toBe(400);
    const archived = await owner.post(`/parties/${party.id}/archive`, {});
    expect(archived.body.data).toMatchObject({ status: 'ARCHIVED' });
    expect((await owner.post(`/parties/${party.id}/archive`, {})).status).toBe(409);
    expect((await owner.get('/parties')).body.data.items).toHaveLength(0);
    expect((await owner.get('/parties?status=archived')).body.data.items).toHaveLength(1);
    expect((await owner.post(`/parties/${party.id}/restore`, {})).body.data.status).toBe('ACTIVE');
    // There is no delete endpoint, and the application role cannot delete parties.
    expect((await owner.delete(`/parties/${party.id}`)).status).toBe(404);
    const db = await connectAs('app');
    try {
      await expect(db.query('DELETE FROM parties WHERE id = $1', [party.id])).rejects.toMatchObject(
        { code: '42501' },
      );
    } finally {
      await db.end();
    }
    const actions = (
      (await owner.get('/organizations/current/audit-events?limit=10')).body.data as {
        action: string;
      }[]
    ).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['party.archived', 'party.restored', 'party.created']),
    );
  });
});

describe('list, search and pagination (S4-15)', () => {
  it('searches names, reference, email and TIN (contains, case-insensitive), filters roles and pages by cursor', async () => {
    const owner = await newOwner();
    const names = ['Alpha Marine', 'Bravo Fuel', 'Charlie Foods', 'Delta Travel', 'Echo Marine'];
    for (const [i, name] of names.entries()) {
      await create(owner, {
        kind: 'organization',
        displayName: name,
        reference: `REF-${i}`,
        email: `${name.split(' ')[0]!.toLowerCase()}@example.test`,
        tin: `TIN${i}0${i}`,
        roles: i % 2 === 0 ? ['customer'] : ['vendor'],
      });
    }
    const search = async (term: string) =>
      (
        (await owner.get(`/parties?search=${encodeURIComponent(term)}`)).body.data.items as {
          displayName: string;
        }[]
      ).map((p) => p.displayName);
    expect(await search('marine')).toEqual(['Alpha Marine', 'Echo Marine']);
    expect(await search('ref-3')).toEqual(['Delta Travel']);
    expect(await search('bravo@')).toEqual(['Bravo Fuel']);
    expect(await search('TIN202')).toEqual(['Charlie Foods']);
    expect(await search('100%')).toEqual([]); // LIKE wildcards are escaped
    const customers = (await owner.get('/parties?role=customer')).body.data.items as {
      displayName: string;
    }[];
    expect(customers.map((p) => p.displayName)).toEqual([
      'Alpha Marine',
      'Charlie Foods',
      'Echo Marine',
    ]);

    const page1 = (await owner.get('/parties?limit=2')).body.data;
    expect(page1.items.map((p: { displayName: string }) => p.displayName)).toEqual([
      'Alpha Marine',
      'Bravo Fuel',
    ]);
    const page2 = (await owner.get(`/parties?limit=2&after=${page1.nextCursor}`)).body.data;
    expect(page2.items.map((p: { displayName: string }) => p.displayName)).toEqual([
      'Charlie Foods',
      'Delta Travel',
    ]);
    const page3 = (await owner.get(`/parties?limit=2&after=${page2.nextCursor}`)).body.data;
    expect(page3).toMatchObject({ nextCursor: null });
    expect(page3.items).toHaveLength(1);
    expect((await owner.get('/parties?after=not-a-cursor')).status).toBe(400);
    expect((await owner.get('/parties?sort=name')).status).toBe(400);
  });

  it('uses the trigram index for contains search', async () => {
    const db = await connectAs('owner');
    try {
      const { rows } = await db.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'parties_search_trgm_idx'`,
      );
      expect(rows[0].indexdef).toContain('gin_trgm_ops');
    } finally {
      await db.end();
    }
  });
});

describe('permissions (S4-16)', () => {
  it('lets Member view only and enforces create/update/archive keys separately', async () => {
    const owner = await newOwner();
    const party = await create(owner, { kind: 'organization', displayName: 'Perm Test' });
    const member = await joinWithRole(ctx, owner, 'Member');
    expect((await member.client.get('/parties')).status).toBe(200);
    expect((await member.client.get(`/parties/${party.id}`)).status).toBe(200);
    expect(
      (await member.client.post('/parties', { kind: 'organization', displayName: 'X' })).status,
    ).toBe(403);
    expect(
      (await member.client.patch(`/parties/${party.id}`, { version: 1, displayName: 'Y' })).status,
    ).toBe(403);
    expect(
      (await member.client.post(`/parties/${party.id}/contacts`, { firstName: 'Z' })).status,
    ).toBe(403);
    expect((await member.client.post(`/parties/${party.id}/archive`, {})).status).toBe(403);

    await owner.post('/organizations/current/roles', {
      name: 'Party editor',
      permissionKeys: ['parties.view', 'parties.update'],
    });
    const editor = (await joinWithRole(ctx, owner, 'Party editor')).client;
    expect(
      (await editor.patch(`/parties/${party.id}`, { version: 1, displayName: 'Edited' })).status,
    ).toBe(200);
    expect((await editor.post(`/parties/${party.id}/archive`, {})).status).toBe(403);
    expect((await editor.post('/parties', { kind: 'organization', displayName: 'X' })).status).toBe(
      403,
    );
  });
});

describe('tenant isolation', () => {
  it('rejects cross-organization access through the API and the database', async () => {
    const a = await newOwner();
    const b = await newOwner();
    const bParty = await create(b, {
      kind: 'organization',
      displayName: 'B Only',
      contacts: [{ firstName: 'Secret' }],
    });
    const aParty = await create(a, { kind: 'organization', displayName: 'A Only' });
    expect((await a.get(`/parties/${bParty.id}`)).status).toBe(404);
    expect(
      (await a.patch(`/parties/${bParty.id}`, { version: 1, displayName: 'Hijack' })).status,
    ).toBe(404);
    expect((await a.post(`/parties/${bParty.id}/archive`, {})).status).toBe(404);
    expect((await a.post(`/parties/${bParty.id}/contacts`, { firstName: 'X' })).status).toBe(404);
    // B's contact through A's party path.
    expect(
      (await a.patch(`/parties/${aParty.id}/contacts/${bParty.contacts[0].id}`, { firstName: 'X' }))
        .status,
    ).toBe(404);
    expect(((await a.get('/parties?search=B%20Only')).body.data.items as unknown[]).length).toBe(0);

    const db = await connectAs('app');
    try {
      await db.query('BEGIN');
      const orgA = (await a.get('/organizations/current')).body.data.id;
      await db.query(`SELECT set_config('app.organization_id', $1, true)`, [orgA]);
      for (const table of ['parties', 'party_contacts', 'party_roles', 'party_addresses']) {
        const column = table === 'parties' ? 'id' : 'party_id';
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
          [bParty.id],
        );
        expect(rows[0].n, table).toBe(0);
      }
      await db.query('SAVEPOINT s');
      // A contact for B's party under A's organization id: the composite key finds no party.
      await expect(
        db.query(
          `INSERT INTO party_contacts (party_id, organization_id, first_name) VALUES ($1, $2, 'x')`,
          [bParty.id, orgA],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await db.query('ROLLBACK TO SAVEPOINT s');
      await expect(
        db.query(
          `INSERT INTO parties (organization_id, kind, display_name, created_by_user_id)
           VALUES ($1, 'organization', 'x', $2)`,
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  });
});

describe('parties permission backfill (S4-17, migration 0011)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    owner = await connectAs('owner');
  });
  afterAll(async () => {
    await owner.end();
  });

  it('grants Owner/Administrator all party keys and Member view, additively and audited', async () => {
    const sqlText = readMigrationFiles().find((m) => m.version === '0011_parties')!.sql;
    const backfill = sqlText.slice(sqlText.indexOf('INSERT INTO permissions'));
    const client = ctx.client();
    const orgId = (await client.register()).session.activeOrganization.id;
    await client.post('/organizations/current/roles', {
      name: 'Custom',
      permissionKeys: ['organization.read'],
    });
    await owner.query('BEGIN');
    try {
      await owner.query(
        `DELETE FROM role_permissions WHERE organization_id = $1 AND permission_key LIKE 'parties.%'`,
        [orgId],
      );
      await owner.query(backfill);
      await owner.query('DROP TABLE s4_parties_backfill_grants, s4_parties_backfilled');
      await owner.query(backfill);
      const { rows } = await owner.query(
        `SELECT r.name, array_agg(rp.permission_key ORDER BY rp.permission_key)
                  FILTER (WHERE rp.permission_key LIKE 'parties.%') AS parties,
                array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.organization_id = $1 GROUP BY r.name`,
        [orgId],
      );
      const byRole = Object.fromEntries(rows.map((r) => [r.name, r]));
      const all = ['parties.archive', 'parties.create', 'parties.update', 'parties.view'];
      expect(byRole.Owner.parties).toEqual(all);
      expect(byRole.Administrator.parties).toEqual(all);
      expect(byRole.Member.parties).toEqual(['parties.view']);
      expect(byRole.Custom.keys).toEqual(['organization.read']);
      const audit = await owner.query(
        `SELECT metadata->>'roleName' AS role FROM audit_events
          WHERE organization_id = $1 AND request_id = 'migration:0011_parties'`,
        [orgId],
      );
      expect(audit.rows.map((r) => r.role).sort()).toEqual(['Administrator', 'Member', 'Owner']);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
