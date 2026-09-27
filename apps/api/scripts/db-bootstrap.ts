/**
 * Runs src/database/bootstrap.sql through psql as a PostgreSQL superuser.
 *
 * Role passwords and the database name are read from DATABASE_URL / DATABASE_MIGRATION_URL
 * in the git-ignored .env. psql prompts interactively for the superuser password; it is never
 * read or stored by this script.
 *
 * Optional env: PSQL_PATH (path to psql), PG_SUPERUSER (default "postgres").
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../src/infrastructure/config/load-env.js';

loadEnvFile();

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlFile = path.resolve(here, '../src/database/bootstrap.sql');

function required(name: string): URL {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. Copy .env.example to .env and fill it in first.`);
    process.exit(1);
  }
  return new URL(value);
}

const appUrl = required('DATABASE_URL');
const ownerUrl = required('DATABASE_MIGRATION_URL');
const dbName = decodeURIComponent(appUrl.pathname.slice(1));

if (appUrl.username !== 'intuit_app' || ownerUrl.username !== 'intuit_owner') {
  console.error(
    'DATABASE_URL must use role intuit_app and DATABASE_MIGRATION_URL role intuit_owner.',
  );
  process.exit(1);
}

const windowsDefault = path.win32.join(
  'C:/',
  'Program Files',
  'PostgreSQL',
  '16',
  'bin',
  'psql.exe',
);
const psql =
  process.env.PSQL_PATH ??
  (process.platform === 'win32' && existsSync(windowsDefault) ? windowsDefault : 'psql');

const result = spawnSync(
  psql,
  [
    '-h',
    appUrl.hostname,
    '-p',
    appUrl.port || '5432',
    '-U',
    process.env.PG_SUPERUSER ?? 'postgres',
    '-d',
    'postgres',
    '-v',
    `db_name=${dbName}`,
    '-v',
    `owner_password=${decodeURIComponent(ownerUrl.password)}`,
    '-v',
    `app_password=${decodeURIComponent(appUrl.password)}`,
    '-f',
    sqlFile,
  ],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
