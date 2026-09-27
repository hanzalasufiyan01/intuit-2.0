import { loadEnvFile } from '../../infrastructure/config/load-env.js';
import { runSeed } from '../seed.js';

loadEnvFile();

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL is not set (seeding runs as the intuit_owner role).');
  process.exit(1);
}

try {
  const result = await runSeed(url);
  console.log(
    `Seeded ${result.permissions} permission(s) and ${result.templates} role template(s); ` +
      `synced ${result.ownerRolesSynced} Owner role permission(s).`,
  );
  if (result.stalePermissions.length > 0) {
    console.warn(`Permissions no longer in the catalog: ${result.stalePermissions.join(', ')}`);
  }
} catch (error) {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
