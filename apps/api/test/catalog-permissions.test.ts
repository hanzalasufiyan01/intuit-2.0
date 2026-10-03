import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrationFiles } from '../src/database/migrator.js';
import { catalogPermissionDefinitions } from '../src/modules/catalog/index.js';
import {
  connectAs,
  createTestContext,
  scopeBackfillToOrganizations,
  type TestContext,
} from './helpers.js';

/**
 * Phase 4A-4 (ADR 0004 P4-06, amended): the neutral `catalog.items.manage` key is granted to every
 * role holding `sales.items.manage` (migration 0031), additively and audited. Serial: replaying
 * the backfill touches roles.
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

const sqlText = () =>
  readMigrationFiles().find((m) => m.version === '0031_catalog_items_permission_backfill')!.sql;

describe('catalog permission backfill (P4-06, migration 0031)', () => {
  it('inserts the catalog key with the catalog description', () => {
    expect(catalogPermissionDefinitions).toEqual([
      expect.objectContaining({ key: 'catalog.items.manage', module: 'catalog' }),
    ]);
    const [definition] = catalogPermissionDefinitions;
    expect(sqlText()).toContain(
      `('${definition!.key}', '${definition!.module}', '${definition!.description}')`,
    );
  });

  it('grants every holder of sales.items.manage, custom roles included, additively and audited', async () => {
    const client = ctx.client();
    const orgId = (await client.register()).session.activeOrganization.id;
    for (const [name, permissionKeys] of [
      ['Custom items', ['sales.items.manage']],
      ['Custom viewer', ['organization.read']],
    ] as const) {
      const res = await client.post('/organizations/current/roles', { name, permissionKeys });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    await owner.query('BEGIN');
    try {
      await scopeBackfillToOrganizations(owner, [orgId]);
      // Simulate an organization created before 4A-4: nobody holds the new key yet.
      await owner.query(
        `DELETE FROM role_permissions
          WHERE organization_id = $1 AND permission_key = 'catalog.items.manage'`,
        [orgId],
      );
      await owner.query(sqlText());
      await owner.query('DROP TABLE p4_catalog_backfilled');
      await owner.query(sqlText()); // idempotent: nothing new, no further audit events
      const { rows } = await owner.query(
        `SELECT r.name,
                bool_or(rp.permission_key = 'catalog.items.manage') AS catalog,
                bool_or(rp.permission_key = 'sales.items.manage') AS sales
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.organization_id = $1 GROUP BY r.name ORDER BY r.name`,
        [orgId],
      );
      expect(rows).toEqual([
        { name: 'Administrator', catalog: true, sales: true },
        { name: 'Custom items', catalog: true, sales: true },
        { name: 'Custom viewer', catalog: false, sales: false },
        { name: 'Member', catalog: false, sales: false },
        { name: 'Owner', catalog: true, sales: true },
      ]);
      const audit = await owner.query(
        `SELECT metadata->>'roleName' AS role, metadata->'permissionsAdded' AS added
           FROM audit_events
          WHERE organization_id = $1
            AND request_id = 'migration:0031_catalog_items_permission_backfill'
          ORDER BY 1`,
        [orgId],
      );
      expect(audit.rows).toEqual([
        { role: 'Administrator', added: ['catalog.items.manage'] },
        { role: 'Custom items', added: ['catalog.items.manage'] },
        { role: 'Owner', added: ['catalog.items.manage'] },
      ]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
