import { loadEnvFile } from '../../infrastructure/config/load-env.js';
import { runMigrations } from '../migrator.js';

loadEnvFile();

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL is not set (migrations run as the intuit_owner role).');
  process.exit(1);
}

try {
  const applied = await runMigrations(url, (message) => console.log(message));
  console.log(
    applied.length === 0 ? 'Database is up to date.' : `Applied ${applied.length} migration(s).`,
  );
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
