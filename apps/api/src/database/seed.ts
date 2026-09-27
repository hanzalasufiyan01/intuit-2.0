import pg from 'pg';
import { permissionCatalog } from '../application/permission-catalog.js';
import { roleTemplateDefinitions } from '../application/role-templates.js';
import {
  syncAccessControlCatalog,
  type CatalogSyncResult,
} from '../modules/access-control/catalog-sync.js';

/**
 * Seeds reference data required by every environment (permission catalog, role templates).
 * Runs as the migration role. Contains no user, organization or credential data.
 */
export async function runSeed(connectionString: string): Promise<CatalogSyncResult> {
  const client = new pg.Client({ connectionString, application_name: 'intuit2-seed' });
  await client.connect();
  try {
    await client.query('BEGIN');
    const result = await syncAccessControlCatalog(
      client,
      permissionCatalog,
      roleTemplateDefinitions,
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
