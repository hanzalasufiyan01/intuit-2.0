import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrationFiles } from '../src/database/migrator.js';
import { customerPermissionDefinitions } from '../src/modules/customers/permissions.js';
import { salesPermissionDefinitions, salesViewPermissions } from '../src/modules/sales/index.js';
import { taxPermissionDefinitions } from '../src/modules/tax/permissions.js';
import {
  connectAs,
  createTestContext,
  scopeBackfillToOrganizations,
  type TestContext,
} from './helpers.js';

/**
 * Phase 3B step 21: the Sales, customer and tax permission backfill for existing organizations
 * (D14, migration 0026). Serial: replaying the backfill touches every organization's roles.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('Sales permission backfill (D14, migration 0026)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    owner = await connectAs('owner');
  });
  afterAll(async () => {
    await owner.end();
  });

  const catalog = [
    ...customerPermissionDefinitions,
    ...salesPermissionDefinitions,
    ...taxPermissionDefinitions,
  ];
  const sqlText = () =>
    readMigrationFiles().find((m) => m.version === '0026_sales_permission_backfill')!.sql;

  it('covers exactly the 22 catalog keys, with the catalog descriptions', () => {
    const inserted = [
      ...sqlText().matchAll(/\('([a-z_.]+)', '(customers|sales|tax)', '([^']+)'\)/g),
    ].map((m) => ({ key: m[1], module: m[2], description: m[3] }));
    expect(catalog).toHaveLength(22);
    expect(inserted).toEqual(
      expect.arrayContaining(
        catalog.map((d) => ({ key: d.key, module: d.module, description: d.description })),
      ),
    );
    expect(inserted).toHaveLength(22);
  });

  it('grants Owner/Administrator every key and Member view, additively and audited', async () => {
    const backfill = sqlText();
    const client = ctx.client();
    const orgId = (await client.register()).session.activeOrganization.id;
    await client.post('/organizations/current/roles', {
      name: 'Custom',
      permissionKeys: ['organization.read'],
    });
    const keys = catalog.map((d) => d.key);
    await owner.query('BEGIN');
    await scopeBackfillToOrganizations(owner, [orgId]);
    try {
      await owner.query(
        `DELETE FROM role_permissions WHERE organization_id = $1 AND permission_key = ANY($2)`,
        [orgId, keys],
      );
      await owner.query(backfill);
      await owner.query('DROP TABLE p3b_sales_backfill_grants, p3b_sales_backfilled');
      await owner.query(backfill); // idempotent: nothing new, no further audit events
      const { rows } = await owner.query(
        `SELECT r.name,
                coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key)
                  FILTER (WHERE rp.permission_key = ANY($2)), '{}') AS sales,
                array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.organization_id = $1 GROUP BY r.name`,
        [orgId, keys],
      );
      const byRole = Object.fromEntries(rows.map((r) => [r.name, r]));
      expect(byRole.Owner.sales).toEqual([...keys].sort());
      expect(byRole.Administrator.sales).toEqual([...keys].sort());
      expect(byRole.Member.sales).toEqual(['customers.view', ...salesViewPermissions].sort());
      expect(byRole.Custom.keys).toEqual(['organization.read']);
      const audit = await owner.query(
        `SELECT metadata->>'roleName' AS role, jsonb_array_length(metadata->'permissionsAdded') AS n
           FROM audit_events
          WHERE organization_id = $1 AND request_id = 'migration:0026_sales_permission_backfill'
          ORDER BY 1`,
        [orgId],
      );
      expect(audit.rows).toEqual([
        { role: 'Administrator', n: 22 },
        { role: 'Member', n: 5 },
        { role: 'Owner', n: 22 },
      ]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
