import { base32Decode } from '../../infrastructure/security/totp.js';

/**
 * Safety checks for the demo-data seed (`seed-demo.ts`). Pure functions with no I/O, so they are
 * unit-tested without a database. The seed may write ONLY to one exactly named review database:
 * every rule here fails closed, and each problem is reported without ever printing a password,
 * a connection string or a secret.
 */

/** The only database the demo seed may write to. */
export const DEMO_DATABASE = 'intuit2_review';

/** Never a target, whatever else is configured. */
export const PROTECTED_DATABASES = [
  'intuit2_dev',
  'intuit2_trial',
  'intuit2_restore_drill',
] as const;

/**
 * The only configurations the demo seed accepts, written exactly (no case folding). `production`
 * is refused whatever else is configured, and so is a missing or unknown value: the seed must be
 * told, explicitly, that this is not a production configuration. (The production images bake in
 * APP_ENV=production, so a review stack passes `staging` for the one seed command.)
 */
export const ALLOWED_APP_ENVS = ['development', 'testing', 'staging'] as const;

const RUNTIME_ROLE = 'intuit_app';
const OWNER_ROLE = 'intuit_owner';

/** libpq variables that can silently redirect a connection; none may be set. */
const REDIRECTING_VARIABLES = [
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGOPTIONS',
] as const;

export interface DemoSeedTarget {
  host: string;
  port: number;
  database: string;
}

export class DemoSeedGuardError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The demo seed refused to run:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'DemoSeedGuardError';
  }
}

function parseConnection(
  name: string,
  raw: string | undefined,
  role: string,
  problems: string[],
): DemoSeedTarget | null {
  if (!raw) {
    problems.push(`${name} is not set`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} is not a valid connection URL`);
    return null;
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    problems.push(`${name}: the protocol must be postgres:// or postgresql://`);
  }
  if (!url.hostname) problems.push(`${name}: the host is missing`);
  if (url.search)
    problems.push(`${name}: query parameters are not allowed (they can redirect the connection)`);
  // The port must be written out: an omitted port means 5432, which is never allowed.
  if (url.port === '') problems.push(`${name}: the port must be explicit and must not be 5432`);
  const port = Number(url.port);
  if (url.port !== '' && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    problems.push(`${name}: the port is not valid`);
  }
  if (port === 5432) problems.push(`${name}: port 5432 is refused`);
  if ((PROTECTED_DATABASES as readonly string[]).includes(database.toLowerCase())) {
    problems.push(`${name}: the database is a protected database`);
  }
  if (database !== DEMO_DATABASE) {
    problems.push(`${name}: the database must be exactly "${DEMO_DATABASE}"`);
  }
  if (decodeURIComponent(url.username) !== role) {
    problems.push(`${name}: the role must be ${role}`);
  }
  return { host: url.hostname, port, database };
}

/**
 * Validates everything knowable from the environment before any connection is made. Throws a
 * DemoSeedGuardError listing every problem; returns the one allowed target otherwise.
 */
export function validateDemoSeedEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { envFileExists: boolean },
): DemoSeedTarget {
  const problems: string[] = [];

  // Independent of everything else: no database name, port or confirmation makes a production
  // configuration acceptable. The value itself is not printed.
  const appEnv = env.APP_ENV;
  if (appEnv?.trim().toLowerCase() === 'production') {
    problems.push(
      'APP_ENV=production is refused: the demo seed never runs in a production configuration',
    );
  } else if (!(ALLOWED_APP_ENVS as readonly (string | undefined)[]).includes(appEnv)) {
    problems.push(`APP_ENV must be set to exactly one of: ${ALLOWED_APP_ENVS.join(', ')}`);
  }
  if (env.DEMO_SEED_CONFIRM !== DEMO_DATABASE) {
    problems.push(`DEMO_SEED_CONFIRM must be exactly "${DEMO_DATABASE}"`);
  }
  if (options.envFileExists) {
    problems.push(
      'a .env file exists in the repository root; it could silently supply database settings, so it must not be present',
    );
  }
  const redirecting = REDIRECTING_VARIABLES.filter((name) => env[name] !== undefined);
  if (redirecting.length) {
    problems.push(
      `these variables can redirect a connection and must be unset: ${redirecting.join(', ')}`,
    );
  }

  const app = parseConnection('DATABASE_URL', env.DATABASE_URL, RUNTIME_ROLE, problems);
  const owner = parseConnection(
    'DATABASE_MIGRATION_URL',
    env.DATABASE_MIGRATION_URL,
    OWNER_ROLE,
    problems,
  );
  if (
    app &&
    owner &&
    (app.host !== owner.host || app.port !== owner.port || app.database !== owner.database)
  ) {
    problems.push(
      'DATABASE_URL and DATABASE_MIGRATION_URL must name the same host, port and database',
    );
  }

  // The demo accounts are shared and only for a network-restricted review environment, so the
  // shared secrets must at least be long. The values are never printed.
  const password = env.DEV_SEED_PASSWORD;
  if (!password || password.length < 16) {
    problems.push('DEV_SEED_PASSWORD must be set and at least 16 characters');
  }
  let totp: number;
  try {
    totp = base32Decode(env.DEV_SEED_TOTP_SECRET ?? '').length;
  } catch {
    totp = 0;
  }
  if (totp < 20) problems.push('DEV_SEED_TOTP_SECRET must be a base32 key of at least 20 bytes');

  if (problems.length || !app) throw new DemoSeedGuardError(problems);
  return app;
}

/** What the database server itself says about the connection that was made. */
export interface ServerIdentity {
  database: string;
  port: number;
  role: string;
  /** Every database name in the cluster reached. */
  databases: readonly string[];
}

/**
 * Compares the server's own answers with the validated target. Returns the problems found, so
 * that the URL cannot say one thing while the server reached is another.
 */
export function checkServerIdentity(
  identity: ServerIdentity,
  target: DemoSeedTarget,
  expectedRole: string,
): string[] {
  const problems: string[] = [];
  if (identity.database !== DEMO_DATABASE) {
    problems.push(
      `the server reports database "${identity.database}", expected "${DEMO_DATABASE}"`,
    );
  }
  if (identity.database !== target.database) {
    problems.push('the database reached differs from the one in the connection URL');
  }
  if (identity.port === 5432) problems.push('the server reports port 5432, which is refused');
  if (identity.port !== target.port) {
    problems.push(`the server reports port ${identity.port}, the URL says ${target.port}`);
  }
  if (identity.role !== expectedRole) {
    problems.push(`the connection role is "${identity.role}", expected "${expectedRole}"`);
  }
  const protectedPresent = identity.databases.filter((name) =>
    (PROTECTED_DATABASES as readonly string[]).includes(name.toLowerCase()),
  );
  if (protectedPresent.length) {
    problems.push(
      `the cluster reached holds a protected database (${protectedPresent.join(', ')})`,
    );
  }
  return problems;
}

export const EXPECTED_ROLES = { app: RUNTIME_ROLE, owner: OWNER_ROLE } as const;
