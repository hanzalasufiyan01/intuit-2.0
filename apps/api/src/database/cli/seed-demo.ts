/**
 * Demo data for a private review environment (pnpm db:seed:demo).
 *
 * Seeds the same fictional "Maldives Demo Trading" data as `seed-dev.ts` (which stays untouched,
 * with its own APP_ENV guard) into ONE exactly named database, `intuit2_review`. Nothing else can
 * be targeted. Before the seed starts, and again after it ends, this command:
 *   - validates the environment (APP_ENV set to development, testing or staging and never
 *     production, exact confirmation, URLs, roles, port, database, no `.env`, no redirecting libpq
 *     variables, long shared secrets); and
 *   - asks the database server itself which database, port and role it is (and that no protected
 *     database exists in that cluster), for both the runtime and the migration connection.
 * Only then does it run `seed-dev` with APP_ENV=testing for this one process; `seed-dev` keeps
 * refusing every other APP_ENV and every other way in.
 *
 * Never run it against real data. The demo accounts share one password and one authenticator key,
 * so the environment must be network-restricted; rotate or remove them before any wider exposure.
 * It writes the credentials nowhere and prints none.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { findRepoRoot } from '../../infrastructure/config/load-env.js';
import {
  checkServerIdentity,
  DemoSeedGuardError,
  EXPECTED_ROLES,
  validateDemoSeedEnvironment,
  type DemoSeedTarget,
} from './demo-seed-guard.js';

async function verifyServer(
  label: string,
  connectionString: string | undefined,
  target: DemoSeedTarget,
  role: string,
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const me = await client.query<{ database: string; port: number; role: string }>(
      'select current_database() as database, inet_server_port() as port, current_user as role',
    );
    const names = await client.query<{ datname: string }>('select datname from pg_database');
    const row = me.rows[0]!;
    const problems = checkServerIdentity(
      {
        database: row.database,
        port: Number(row.port),
        role: row.role,
        databases: names.rows.map((r) => r.datname),
      },
      target,
      role,
    );
    if (problems.length) throw new DemoSeedGuardError(problems.map((p) => `${label}: ${p}`));
    console.log(`Verified ${label}: database ${row.database} on port ${row.port} as ${row.role}.`);
  } finally {
    await client.end();
  }
}

async function verifyBothConnections(target: DemoSeedTarget): Promise<void> {
  await verifyServer('runtime connection', process.env.DATABASE_URL, target, EXPECTED_ROLES.app);
  await verifyServer(
    'migration connection',
    process.env.DATABASE_MIGRATION_URL,
    target,
    EXPECTED_ROLES.owner,
  );
}

try {
  const root = findRepoRoot();
  const target = validateDemoSeedEnvironment(process.env, {
    envFileExists: root !== undefined && existsSync(path.join(root, '.env')),
  });
  console.log(`Target: ${target.host}:${target.port}/${target.database}`);

  await verifyBothConnections(target); // before the seed writes anything

  // seed-dev refuses every APP_ENV except development and testing; this process, and only this
  // one, runs it as "testing" after the checks above have passed.
  process.env.APP_ENV = 'testing';
  await import('./seed-dev.js');
  if (process.exitCode) throw new Error('the seed reported a failure (see above)');

  await verifyBothConnections(target); // and again after it finished
  console.log(
    `Demo data is in ${target.database}. The shared demo credentials are those you supplied; rotate them before any wider exposure.`,
  );
} catch (error) {
  if (error instanceof DemoSeedGuardError) console.error(error.message);
  else console.error('Demo seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
