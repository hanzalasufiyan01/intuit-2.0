import type pg from 'pg';
import type { PermissionDefinition } from './permission-catalog.js';
import type { RoleTemplateDefinition } from './role-templates.js';

export interface CatalogSyncResult {
  permissions: number;
  templates: number;
  ownerRolesSynced: number;
  stalePermissions: string[];
}

/**
 * Seeds the global permission catalog and system role templates. Idempotent.
 * Runs as the migration role, inside a caller-managed transaction.
 *
 * Every organization's protected Owner role is re-synced to the full catalog so the
 * Owner always holds every permission as modules add new ones. Other roles are
 * organization-customizable and are never changed here.
 */
export async function syncAccessControlCatalog(
  client: pg.ClientBase,
  catalog: readonly PermissionDefinition[],
  templates: readonly RoleTemplateDefinition[],
): Promise<CatalogSyncResult> {
  const catalogKeys = new Set(catalog.map((p) => p.key));

  for (const permission of catalog) {
    await client.query(
      `INSERT INTO permissions (key, module, description) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description`,
      [permission.key, permission.module, permission.description],
    );
  }

  const { rows: existing } = await client.query<{ key: string }>('SELECT key FROM permissions');
  const stalePermissions = existing.map((row) => row.key).filter((key) => !catalogKeys.has(key));

  for (const template of templates) {
    const templatePermissions =
      template.permissions === 'all' ? [...catalogKeys] : template.permissions;
    for (const key of templatePermissions) {
      if (!catalogKeys.has(key)) {
        throw new Error(`Role template "${template.key}" references unknown permission "${key}"`);
      }
    }
    await client.query(
      `INSERT INTO role_templates (key, name, description, is_owner, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
         is_owner = EXCLUDED.is_owner, sort_order = EXCLUDED.sort_order`,
      [template.key, template.name, template.description, template.isOwner, template.sortOrder],
    );
    await client.query('DELETE FROM role_template_permissions WHERE template_key = $1', [
      template.key,
    ]);
    await client.query(
      `INSERT INTO role_template_permissions (template_key, permission_key)
       SELECT $1, unnest($2::text[])`,
      [template.key, templatePermissions],
    );
  }

  const ownerSync = await client.query(
    `INSERT INTO role_permissions (role_id, organization_id, permission_key)
     SELECT r.id, r.organization_id, p.key
     FROM roles r CROSS JOIN permissions p
     WHERE r.is_owner AND p.key = ANY($1::text[])
     ON CONFLICT DO NOTHING`,
    [[...catalogKeys]],
  );

  return {
    permissions: catalog.length,
    templates: templates.length,
    ownerRolesSynced: ownerSync.rowCount ?? 0,
    stalePermissions,
  };
}
