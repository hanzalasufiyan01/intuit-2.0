import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrationFiles } from '../src/database/migrator.js';
import {
  FixedAssetPermissions,
  fixedAssetPermissionDefinitions,
} from '../src/modules/fixed-assets/index.js';
import {
  connectAs,
  createTestContext,
  scopeBackfillToOrganizations,
  type TestContext,
} from './helpers.js';

/**
 * The Fixed asset permission backfill for existing organizations (migration 0048). Serial: replaying
 * the backfill touches the roles of the organizations it is scoped to.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('Fixed asset permission backfill (migration 0048)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    owner = await connectAs('owner');
  });
  afterAll(async () => {
    await owner.end();
  });

  const backfillSql = () => {
    const sql = readMigrationFiles().find((m) => m.version === '0048_fixed_assets')!.sql;
    return sql.slice(sql.indexOf('INSERT INTO permissions'));
  };

  it('covers exactly the five catalog keys, with the catalog descriptions', () => {
    const inserted = [
      ...backfillSql().matchAll(/\('(fixed_assets\.[a-z_.]+)', 'fixed_assets', '([^']+)'\)/g),
    ].map((m) => ({ key: m[1], description: m[2] }));
    expect(fixedAssetPermissionDefinitions).toHaveLength(5);
    expect(inserted).toHaveLength(5);
    expect(inserted).toEqual(
      expect.arrayContaining(
        fixedAssetPermissionDefinitions.map((d) => ({ key: d.key, description: d.description })),
      ),
    );
  });

  it('grants Owner and Administrator every key and Member the view, additively and audited', async () => {
    const client = ctx.client();
    const orgId = (await client.register()).session.activeOrganization.id;
    await client.post('/organizations/current/roles', {
      name: 'Custom',
      permissionKeys: ['organization.read'],
    });
    const keys = Object.values(FixedAssetPermissions);
    await owner.query('BEGIN');
    await scopeBackfillToOrganizations(owner, [orgId]);
    try {
      await owner.query(
        `DELETE FROM role_permissions WHERE organization_id = $1 AND permission_key = ANY($2)`,
        [orgId, keys],
      );
      const sql = backfillSql();
      await owner.query(sql);
      await owner.query('DROP TABLE fixed_asset_backfill_grants, fixed_asset_backfilled');
      await owner.query(sql); // idempotent: nothing new, no further audit events
      const { rows } = await owner.query(
        `SELECT r.name,
                coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key)
                  FILTER (WHERE rp.permission_key = ANY($2)), '{}') AS fixed_assets,
                array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.organization_id = $1 GROUP BY r.name`,
        [orgId, keys],
      );
      const byRole = Object.fromEntries(rows.map((r) => [r.name, r]));
      expect(byRole.Owner.fixed_assets).toEqual([...keys].sort());
      expect(byRole.Administrator.fixed_assets).toEqual([...keys].sort());
      expect(byRole.Member.fixed_assets).toEqual([FixedAssetPermissions.View]);
      expect(byRole.Custom.keys).toEqual(['organization.read']);
      const audit = await owner.query(
        `SELECT metadata->>'roleName' AS role, jsonb_array_length(metadata->'permissionsAdded') AS n
           FROM audit_events
          WHERE organization_id = $1 AND request_id = 'migration:0048_fixed_assets'
          ORDER BY 1`,
        [orgId],
      );
      expect(audit.rows).toEqual([
        { role: 'Administrator', n: 5 },
        { role: 'Member', n: 1 },
        { role: 'Owner', n: 5 },
      ]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
