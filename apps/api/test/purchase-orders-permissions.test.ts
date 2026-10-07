import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrationFiles } from '../src/database/migrator.js';
import {
  PurchaseOrderPermissions,
  purchaseOrderPermissionDefinitions,
} from '../src/modules/purchase-orders/index.js';
import {
  connectAs,
  createTestContext,
  scopeBackfillToOrganizations,
  type TestContext,
} from './helpers.js';

/**
 * The Purchase order permission backfill for existing organizations (migration 0047). Serial: replaying
 * the backfill touches the roles of the organizations it is scoped to.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('Purchase order permission backfill (migration 0047)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    owner = await connectAs('owner');
  });
  afterAll(async () => {
    await owner.end();
  });

  const backfillSql = () => {
    const sql = readMigrationFiles().find((m) => m.version === '0047_purchase_orders')!.sql;
    return sql.slice(sql.indexOf('INSERT INTO permissions'));
  };

  it('covers exactly the six catalog keys, with the catalog descriptions', () => {
    const inserted = [
      ...backfillSql().matchAll(/\('(purchase_orders\.[a-z_.]+)', 'purchases', '([^']+)'\)/g),
    ].map((m) => ({ key: m[1], description: m[2] }));
    expect(purchaseOrderPermissionDefinitions).toHaveLength(6);
    expect(inserted).toHaveLength(6);
    expect(inserted).toEqual(
      expect.arrayContaining(
        purchaseOrderPermissionDefinitions.map((d) => ({ key: d.key, description: d.description })),
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
    const keys = Object.values(PurchaseOrderPermissions);
    await owner.query('BEGIN');
    await scopeBackfillToOrganizations(owner, [orgId]);
    try {
      await owner.query(
        `DELETE FROM role_permissions WHERE organization_id = $1 AND permission_key = ANY($2)`,
        [orgId, keys],
      );
      const sql = backfillSql();
      await owner.query(sql);
      await owner.query('DROP TABLE purchase_order_backfill_grants, purchase_order_backfilled');
      await owner.query(sql); // idempotent: nothing new, no further audit events
      const { rows } = await owner.query(
        `SELECT r.name,
                coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key)
                  FILTER (WHERE rp.permission_key = ANY($2)), '{}') AS purchase_orders,
                array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.organization_id = $1 GROUP BY r.name`,
        [orgId, keys],
      );
      const byRole = Object.fromEntries(rows.map((r) => [r.name, r]));
      expect(byRole.Owner.purchase_orders).toEqual([...keys].sort());
      expect(byRole.Administrator.purchase_orders).toEqual([...keys].sort());
      expect(byRole.Member.purchase_orders).toEqual([PurchaseOrderPermissions.View]);
      expect(byRole.Custom.keys).toEqual(['organization.read']);
      const audit = await owner.query(
        `SELECT metadata->>'roleName' AS role, jsonb_array_length(metadata->'permissionsAdded') AS n
           FROM audit_events
          WHERE organization_id = $1 AND request_id = 'migration:0047_purchase_orders'
          ORDER BY 1`,
        [orgId],
      );
      expect(audit.rows).toEqual([
        { role: 'Administrator', n: 6 },
        { role: 'Member', n: 1 },
        { role: 'Owner', n: 6 },
      ]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
