import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole } from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/** Phase 3A S4 — organization legal profile (Decision 17; S4-02..S4-07, S4-12, S4-14, S4-22). */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

const address = (overrides: object = {}) => ({
  line1: 'H. Example, Boduthakurufaanu Magu',
  line2: null,
  city: 'Malé',
  region: 'Kaafu',
  postalCode: '20026',
  countryCode: 'MV',
  ...overrides,
});

function profile(version: number, overrides: object = {}) {
  return {
    version,
    legalName: 'Example Resorts Private Limited',
    tradingName: 'Example Resort',
    tin: '1001234GST501',
    gstRegistered: true,
    gstRegistrationNumber: '1001234GST501',
    gstRegisteredFrom: '2023-01-01',
    email: 'accounts@example.test',
    phone: '+960 330 0000',
    website: 'https://example.test',
    identifiers: [{ scheme: 'business_registration', value: 'C-0123/2020' }],
    registeredAddress: address(),
    businessAddress: null,
    ...overrides,
  };
}

async function newOwner(): Promise<TestClient> {
  const owner = ctx.client();
  await owner.register();
  return owner;
}

describe('organization profile', () => {
  it('starts empty (nothing inferred) and is created and updated with versions', async () => {
    const owner = await newOwner();
    const empty = (await owner.get('/organizations/current/profile')).body.data;
    expect(empty).toMatchObject({
      version: 0,
      legalName: null,
      identifiers: [],
      registeredAddress: null,
    });

    const created = await owner.put('/organizations/current/profile', profile(0));
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.data).toMatchObject({
      version: 1,
      legalName: 'Example Resorts Private Limited',
      gstRegistered: true,
      registeredAddress: { city: 'Malé', countryCode: 'MV' },
      businessAddress: null,
    });

    const updated = await owner.put(
      '/organizations/current/profile',
      profile(1, {
        tradingName: 'Example Island',
        businessAddress: address({ city: 'Hulhumalé' }),
      }),
    );
    expect(updated.body.data).toMatchObject({ version: 2, tradingName: 'Example Island' });
    expect(updated.body.data.businessAddress.city).toBe('Hulhumalé');

    // Optimistic concurrency (S4-14): a stale version is rejected, nothing overwritten.
    const stale = await owner.put(
      '/organizations/current/profile',
      profile(1, { tradingName: 'Stale' }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await owner.get('/organizations/current/profile')).body.data.tradingName).toBe(
      'Example Island',
    );
  });

  it('validates GST registration, countries, identifiers and unknown fields', async () => {
    const owner = await newOwner();
    const gst = await owner.put(
      '/organizations/current/profile',
      profile(0, { gstRegistrationNumber: null }),
    );
    expect(gst.status).toBe(400);
    expect(gst.body.error.details.issues[0].path).toBe('gstRegistrationNumber');
    expect(
      (
        await owner.put(
          '/organizations/current/profile',
          profile(0, { registeredAddress: address({ countryCode: 'ZZ' }) }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.put(
          '/organizations/current/profile',
          profile(0, { identifiers: [{ scheme: 'Bad Scheme', value: 'x' }] }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await owner.put('/organizations/current/profile', { ...profile(0), logo: 'x' })).status,
    ).toBe(400);
    expect(
      (
        await owner.put(
          '/organizations/current/profile',
          profile(0, { registeredAddress: { ...address(), extra: 1 } }),
        )
      ).status,
    ).toBe(400);
    // Not GST-registered: no number needed.
    expect(
      (
        await owner.put(
          '/organizations/current/profile',
          profile(0, { gstRegistered: false, gstRegistrationNumber: null }),
        )
      ).status,
    ).toBe(200);
  });

  it('keeps an inactive country but refuses it as a new selection', async () => {
    const owner = await newOwner();
    await owner.put(
      '/organizations/current/profile',
      profile(0, { registeredAddress: address({ countryCode: 'AQ' }) }),
    );
    const db = await connectAs('owner');
    try {
      await db.query(`UPDATE countries SET is_active = false WHERE code = 'AQ'`);
      const kept = await owner.put(
        '/organizations/current/profile',
        profile(1, { registeredAddress: address({ countryCode: 'AQ' }) }),
      );
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      const fresh = await owner.put(
        '/organizations/current/profile',
        profile(2, { businessAddress: address({ countryCode: 'AQ' }) }),
      );
      expect(fresh.status).toBe(400);
    } finally {
      await db.query(`UPDATE countries SET is_active = true WHERE code = 'AQ'`);
      await db.end();
    }
  });

  it('requires recent re-authentication only for TIN/GST changes (S4-12)', async () => {
    const owner = await newOwner();
    expect((await owner.put('/organizations/current/profile', profile(0))).status).toBe(200);
    ctx.clock.advance(16 * MINUTE); // past the 15-minute re-auth window, inside the 30-minute idle timeout
    try {
      // Non-tax change: no re-authentication.
      expect(
        (await owner.put('/organizations/current/profile', profile(1, { phone: '+960 111 1111' })))
          .status,
      ).toBe(200);
      const tin = await owner.put(
        '/organizations/current/profile',
        profile(2, { tin: '9999999GST501' }),
      );
      expect(tin.status).toBe(403);
      expect(tin.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
      const gst = await owner.put(
        '/organizations/current/profile',
        profile(2, { gstRegistered: false, gstRegistrationNumber: null }),
      );
      expect(gst.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    } finally {
      ctx.clock.advance(-16 * MINUTE);
    }
  });

  it('needs organization.read to view and organization.update to change; audits without contact values', async () => {
    const owner = await newOwner();
    await owner.put('/organizations/current/profile', profile(0));
    const member = await joinWithRole(ctx, owner, 'Member');
    expect((await member.client.get('/organizations/current/profile')).status).toBe(200);
    expect((await member.client.put('/organizations/current/profile', profile(1))).status).toBe(
      403,
    );

    await owner.put(
      '/organizations/current/profile',
      profile(1, { email: 'new@example.test', tradingName: 'Renamed' }),
    );
    const audit = (await owner.get('/organizations/current/audit-events?limit=5')).body.data;
    const entry = audit.find(
      (e: { action: string }) => e.action === 'organization.profile_updated',
    );
    expect(entry.metadata.changedFields).toEqual(expect.arrayContaining(['tradingName', 'email']));
    expect(entry.metadata.values).toEqual({ tradingName: 'Renamed' });
    expect(JSON.stringify(entry.metadata)).not.toContain('new@example.test');
  });

  it('lists the 249 ISO 3166-1 countries for any signed-in user', async () => {
    const owner = await newOwner();
    const list = (await owner.get('/reference/countries')).body.data as {
      code: string;
      name: string;
    }[];
    expect(list).toHaveLength(249);
    expect(list.find((c) => c.code === 'MV')?.name).toBe('Maldives');
    expect((await ctx.client().get('/reference/countries')).status).toBe(401);
  });

  it('is isolated per organization, also for the application role', async () => {
    const a = await newOwner();
    const b = await newOwner();
    await b.put('/organizations/current/profile', profile(0, { legalName: 'B Holdings' }));
    expect((await a.get('/organizations/current/profile')).body.data.legalName).toBeNull();
    const db = await connectAs('app');
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.organization_id', gen_random_uuid()::text, true)`);
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM organization_profiles WHERE legal_name = 'B Holdings'`,
      );
      expect(rows[0].n).toBe(0);
      await expect(
        db.query('INSERT INTO countries (code, name) VALUES ($1, $2)', ['QX', 'X']),
      ).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  });
});
