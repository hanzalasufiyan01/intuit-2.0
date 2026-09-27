import { loadEnvFile } from '../src/infrastructure/config/load-env.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeed } from '../src/database/seed.js';

/**
 * Integration tests run against the real local PostgreSQL database (intuit2_dev) using the
 * approved roles: migrations/seed as intuit_owner, the application as intuit_app.
 * Tests never truncate: every test creates uniquely-named users and organizations, and
 * audit/security history is append-only by design.
 */
export default async function setup(): Promise<void> {
  loadEnvFile();
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url || !process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL and DATABASE_MIGRATION_URL must be set (see .env.example and docs/development.md).',
    );
  }
  await runMigrations(url);
  await runSeed(url);
}
