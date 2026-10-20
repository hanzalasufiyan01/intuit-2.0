import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cashSale,
  joinWithRole,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Groups of legal entities (FP-24, migration 0085): a group links organizations one user owns and
 * shows them side by side. It consolidates nothing. Real PostgreSQL.
 */

let ctx: TestContext;
let db: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext();
  db = await connectAs('owner');
});
afterAll(async () => {
  await db.end();
  await ctx.close();
});

/** A user who owns two organizations that both have books and one posted sale. */
async function twoEntities(amountA = '100.00', amountB = '250.00') {
  const a: AccountingOrg = await setUpAccountingOrg(ctx);
  await postJournal(a, cashSale(a, amountA));
  const created = await a.owner.post('/organizations', { name: 'Second entity' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bId = created.body.data.id as string;
  expect(
    (await a.owner.post('/accounting/setup', { baseCurrency: 'USD', templateKey: 'maldives' }))
      .status,
  ).toBe(201);
  expect(
    (
      await a.owner.post('/accounting/fiscal-years', {
        name: 'FY2026',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      })
    ).status,
  ).toBe(201);
  const accounts = Object.fromEntries(
    (await a.owner.get('/accounting/accounts')).body.data.map((x: { code: string; id: string }) => [
      x.code,
      x.id,
    ]),
  );
  await postJournal({ ...a, accounts }, cashSale({ ...a, accounts }, amountB, '2026-03-15', 'USD'));
  return { a, bId };
}

const createGroup = async (client: AccountingOrg['owner'], name = 'Holding') => {
  const r = await client.post('/organization-groups', { name });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
};

describe('organization groups', () => {
  it('lists organizations side by side, per base currency, and sums nothing', async () => {
    const { a, bId } = await twoEntities();
    const groupId = await createGroup(a.owner);
    for (const organizationId of [a.organizationId, bId]) {
      const r = await a.owner.post(`/organization-groups/${groupId}/organizations`, {
        organizationId,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const list = await a.owner.get('/organization-groups');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].organizations.map((o: { name: string }) => o.name).sort()).toEqual(
      expect.arrayContaining(['Second entity']),
    );
    const overview = await a.owner.get(
      `/organization-groups/${groupId}/overview?from=2026-01-01&to=2026-12-31`,
    );
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    const rows = overview.body.data.organizations as {
      organizationId: string;
      status: string;
      baseCurrency: string;
      netProfit: string;
    }[];
    const rowA = rows.find((r) => r.organizationId === a.organizationId)!;
    const rowB = rows.find((r) => r.organizationId === bId)!;
    expect([rowA.status, rowA.baseCurrency, Number(rowA.netProfit)]).toEqual(['ok', 'MVR', 100]);
    expect([rowB.status, rowB.baseCurrency, Number(rowB.netProfit)]).toEqual(['ok', 'USD', 250]);
    // No cross-organization total of any kind.
    expect(JSON.stringify(overview.body)).not.toMatch(/total|consolidated/i);
    expect(overview.body.data.note).toMatch(/Nothing is added together/);
    // The active organization of the session is unchanged by the overview.
    expect((await a.owner.get('/organizations/current')).body.data.id).toBe(bId);
  });

  it('only the owner of an organization can add it, an organization joins one group, and groups are private', async () => {
    const { a, bId } = await twoEntities();
    const groupId = await createGroup(a.owner);
    // A member who is not an owner cannot add the organization (and learns nothing about it).
    const admin = await joinWithRole(ctx, a.owner, 'Administrator');
    const adminGroup = await createGroup(admin.client, 'Mine');
    const refused = await admin.client.post(`/organization-groups/${adminGroup}/organizations`, {
      organizationId: a.organizationId,
    });
    expect(refused.status).toBe(404);
    const unknown = await admin.client.post(`/organization-groups/${adminGroup}/organizations`, {
      organizationId: '11111111-1111-4111-8111-111111111111',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toBe(refused.body.error.message);

    expect(
      (
        await a.owner.post(`/organization-groups/${groupId}/organizations`, {
          organizationId: bId,
        })
      ).status,
    ).toBe(201);
    const second = await createGroup(a.owner, 'Other');
    const dup = await a.owner.post(`/organization-groups/${second}/organizations`, {
      organizationId: bId,
    });
    expect(dup.status).toBe(409);

    // Another user sees and changes nothing of this group.
    const stranger = await setUpAccountingOrg(ctx);
    expect((await stranger.owner.get('/organization-groups')).body.data).toEqual([]);
    for (const path of [`/organization-groups/${groupId}/overview?from=2026-01-01&to=2026-12-31`]) {
      expect((await stranger.owner.get(path)).status).toBe(404);
    }
    expect((await stranger.owner.delete(`/organization-groups/${groupId}`)).status).toBe(404);
    expect(
      (await stranger.owner.delete(`/organization-groups/${groupId}/organizations/${bId}`)).status,
    ).toBe(404);
  });

  it('audits join and leave in the organization and deletes cleanly', async () => {
    const { a, bId } = await twoEntities();
    const groupId = await createGroup(a.owner);
    await a.owner.post(`/organization-groups/${groupId}/organizations`, { organizationId: bId });
    await a.owner.post(`/organization-groups/${groupId}/organizations`, {
      organizationId: a.organizationId,
    });
    const overview = await a.owner.get(
      `/organization-groups/${groupId}/overview?from=2026-01-01&to=2026-12-31`,
    );
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);

    const left = await a.owner.delete(
      `/organization-groups/${groupId}/organizations/${a.organizationId}`,
    );
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    const actions = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND resource_id = $2 ORDER BY occurred_at`,
      [a.organizationId, groupId],
    );
    expect(actions.rows.map((r) => r.action)).toEqual([
      'organization.group_joined',
      'organization.group_left',
    ]);
    const deleted = await a.owner.delete(`/organization-groups/${groupId}`);
    expect(deleted.status).toBe(200);
    expect((await a.owner.get('/organization-groups')).body.data).toEqual([]);
    const rows = await db.query(
      `SELECT count(*)::int AS n FROM organization_group_members WHERE group_id = $1`,
      [groupId],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});
