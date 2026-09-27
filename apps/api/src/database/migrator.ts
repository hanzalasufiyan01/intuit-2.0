import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Locates src/database/migrations from either the source tree or the compiled dist tree. */
export function migrationsDirectory(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return path.join(dir, 'src', 'database', 'migrations');
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate the API package root');
    dir = parent;
  }
}

export interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
}

export function readMigrationFiles(dir = migrationsDirectory()): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(path.join(dir, name), 'utf8');
      return {
        version: name.replace(/\.sql$/, ''),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

// Arbitrary constant key so only one migrator runs at a time.
const MIGRATION_LOCK_KEY = 72_020_001;

/**
 * Applies pending SQL migrations in order, each in its own transaction.
 * Must run as the migration role (intuit_owner). Already-applied migrations are
 * verified by checksum so edited history is detected instead of silently ignored.
 */
export async function runMigrations(
  connectionString: string,
  log: (message: string) => void = () => {},
): Promise<string[]> {
  const client = new pg.Client({ connectionString, application_name: 'intuit2-migrator' });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    await client.query('REVOKE ALL ON schema_migrations FROM PUBLIC');

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const existing = new Map(rows.map((row) => [row.version, row.checksum]));

    for (const migration of readMigrationFiles()) {
      const recorded = existing.get(migration.version);
      if (recorded !== undefined) {
        if (recorded !== migration.checksum) {
          throw new Error(
            `Migration ${migration.version} has changed since it was applied. ` +
              'Applied migrations are immutable; add a new migration instead.',
          );
        }
        continue;
      }
      log(`Applying migration ${migration.version}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          migration.version,
          migration.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(migration.version);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}
