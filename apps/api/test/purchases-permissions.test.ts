import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrationFiles } from '../src/database/migrator.js';
import {
  expensePermissionDefinitions,
  expenseViewPermissions,
  purchasesPermissionDefinitions,
  billViewPermissions,
  vendorCreditViewPermissions,
  vendorPaymentViewPermissions,
  purchasesReportViewPermissions,
} from '../src/modules/purchases/index.js';
import { vendorPermissionDefinitions } from '../src/modules/vendors/permissions.js';
import { VendorPermissions } from '../src/modules/vendors/permissions.js';
import {
  connectAs,
  createTestContext,
  scopeBackfillToOrganizations,
  type TestContext,
} from './helpers.js';

/**
 * Phase 4B-12: the Purchases permission backfill for existing organizations (ADR 0004 P4-39,
 * P4-40; migration 0044). Serial: replaying the backfill touches every organization's roles.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('Purchases permission backfill (P4-39, P4-40, migration 0044)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    owner = await connectAs('owner');
  });
  afterAll(async () => {
    await owner.end();
  });

  const catalog = [
    ...vendorPermissionDefinitions,
    ...purchasesPermissionDefinitions,
    ...expensePermissionDefinitions,
  ];
  const sqlText = () =>
    readMigrationFiles().find((m) => m.version === '0044_purchases_permission_backfill')!.sql;

  it('covers exactly the 26 catalog keys, with the catalog descriptions', () => {
    const inserted = [
      ...sqlText().matchAll(/\('([a-z_.]+)', '(vendors|purchases)', '([^']+)'\)/g),
    ].map((m) => ({ key: m[1], module: m[2], description: m[3] }));
    expect(catalog).toHaveLength(26);
    expect(inserted).toEqual(
      expect.arrayContaining(
        catalog.map((d) => ({ key: d.key, module: d.module, description: d.description })),
      ),
    );
    expect(inserted).toHaveLength(26);
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
    const memberKeys = [
      VendorPermissions.View,
      ...billViewPermissions,
      ...vendorCreditViewPermissions,
      ...vendorPaymentViewPermissions,
      ...purchasesReportViewPermissions,
      ...expenseViewPermissions,
    ].sort();
    await owner.query('BEGIN');
    await scopeBackfillToOrganizations(owner, [orgId]);
    try {
      await owner.query(
        `DELETE FROM role_permissions WHERE organization_id = $1 AND permission_key = ANY($2)`,
        [orgId, keys],
      );
      await owner.query(backfill);
      await owner.query('DROP TABLE p4_purchases_backfill_grants, p4_purchases_backfilled');
      await owner.query(backfill); // idempotent: nothing new, no further audit events
      const { rows } = await owner.query(
        `SELECT r.name,
                coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key)
                  FILTER (WHERE rp.permission_key = ANY($2)), '{}') AS purchases,
                array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.organization_id = $1 GROUP BY r.name`,
        [orgId, keys],
      );
      const byRole = Object.fromEntries(rows.map((r) => [r.name, r]));
      expect(byRole.Owner.purchases).toEqual([...keys].sort());
      expect(byRole.Administrator.purchases).toEqual([...keys].sort());
      expect(byRole.Member.purchases).toEqual(memberKeys);
      expect(byRole.Custom.keys).toEqual(['organization.read']);
      const audit = await owner.query(
        `SELECT metadata->>'roleName' AS role, jsonb_array_length(metadata->'permissionsAdded') AS n
           FROM audit_events
          WHERE organization_id = $1 AND request_id = 'migration:0044_purchases_permission_backfill'
          ORDER BY 1`,
        [orgId],
      );
      expect(audit.rows).toEqual([
        { role: 'Administrator', n: 26 },
        { role: 'Member', n: 6 },
        { role: 'Owner', n: 26 },
      ]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
