import { describe, expect, it } from 'vitest';
import {
  checkServerIdentity,
  DEMO_DATABASE,
  DemoSeedGuardError,
  EXPECTED_ROLES,
  PROTECTED_DATABASES,
  validateDemoSeedEnvironment,
  type ServerIdentity,
} from '../src/database/cli/demo-seed-guard.js';

/**
 * The demo seed may write only to the database named exactly "intuit2_review". These are the pure
 * checks (no database): the environment rules and the comparison with what the server itself
 * reports. The credentials in this file are throwaway test strings.
 */

const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // 20 bytes of base32
const PASSWORD = 'throwaway-demo-pass-1';

const good = {
  APP_ENV: 'staging',
  DEMO_SEED_CONFIRM: DEMO_DATABASE,
  DATABASE_URL: `postgres://intuit_app:pw@127.0.0.1:55432/${DEMO_DATABASE}`,
  DATABASE_MIGRATION_URL: `postgres://intuit_owner:pw@127.0.0.1:55432/${DEMO_DATABASE}`,
  DEV_SEED_PASSWORD: PASSWORD,
  DEV_SEED_TOTP_SECRET: TOTP,
};
const ok = { envFileExists: false };

function problemsOf(env: Record<string, string | undefined>, options = ok): string[] {
  try {
    validateDemoSeedEnvironment(env, options);
  } catch (error) {
    expect(error).toBeInstanceOf(DemoSeedGuardError);
    return [...(error as DemoSeedGuardError).problems];
  }
  return [];
}

describe('validateDemoSeedEnvironment', () => {
  it('accepts the one allowed target and returns it', () => {
    expect(validateDemoSeedEnvironment(good, ok)).toEqual({
      host: '127.0.0.1',
      port: 55432,
      database: DEMO_DATABASE,
    });
    // A container service name on a non-default port is also fine.
    expect(
      validateDemoSeedEnvironment(
        {
          ...good,
          DATABASE_URL: `postgres://intuit_app:pw@postgres:5433/${DEMO_DATABASE}`,
          DATABASE_MIGRATION_URL: `postgres://intuit_owner:pw@postgres:5433/${DEMO_DATABASE}`,
        },
        ok,
      ).host,
    ).toBe('postgres');
  });

  it('needs the exact confirmation', () => {
    for (const confirm of [
      undefined,
      '',
      'yes',
      'INTUIT2_REVIEW',
      'intuit2_review ',
      'intuit2_dev',
    ]) {
      expect(problemsOf({ ...good, DEMO_SEED_CONFIRM: confirm }).join(), String(confirm)).toContain(
        'DEMO_SEED_CONFIRM',
      );
    }
  });

  it('accepts each non-production APP_ENV with an otherwise valid review configuration', () => {
    for (const appEnv of ['development', 'testing', 'staging']) {
      expect(problemsOf({ ...good, APP_ENV: appEnv }), appEnv).toEqual([]);
    }
  });

  it('refuses APP_ENV=production even when the database, port and confirmation are all valid', () => {
    // `good` names intuit2_review on the non-default port 55432 with the exact confirmation:
    // everything but APP_ENV is acceptable, and that alone must be enough to refuse.
    expect(problemsOf({ ...good, APP_ENV: 'staging' })).toEqual([]);
    for (const appEnv of ['production', 'Production', 'PRODUCTION', ' production', 'production ']) {
      const problems = problemsOf({ ...good, APP_ENV: appEnv });
      expect(problems, JSON.stringify(appEnv)).toHaveLength(1);
      expect(problems[0], JSON.stringify(appEnv)).toContain('APP_ENV=production is refused');
    }
    // A container service name on a port such as 5433, as in the review stack, is no exception.
    expect(
      problemsOf({
        ...good,
        APP_ENV: 'production',
        DATABASE_URL: `postgres://intuit_app:pw@postgres:5433/${DEMO_DATABASE}`,
        DATABASE_MIGRATION_URL: `postgres://intuit_owner:pw@postgres:5433/${DEMO_DATABASE}`,
      }).join(),
    ).toContain('APP_ENV=production is refused');
  });

  it('refuses a missing, empty or unknown APP_ENV (fail closed)', () => {
    for (const appEnv of [undefined, '', ' ', 'prod', 'live', 'Staging', 'development ', 'dev']) {
      const problems = problemsOf({ ...good, APP_ENV: appEnv });
      expect(problems, JSON.stringify(appEnv)).toHaveLength(1);
      expect(problems[0], JSON.stringify(appEnv)).toContain(
        'APP_ENV must be set to exactly one of',
      );
    }
  });

  it('lists a production configuration together with every other problem, not instead of them', () => {
    const problems = problemsOf({ ...good, APP_ENV: 'production', DEMO_SEED_CONFIRM: 'no' });
    expect(problems.join('\n')).toContain('APP_ENV=production is refused');
    expect(problems.join('\n')).toContain('DEMO_SEED_CONFIRM');
  });

  it('refuses every database but intuit2_review, and names the protected ones', () => {
    for (const database of [
      ...PROTECTED_DATABASES,
      'INTUIT2_DEV',
      'intuit2_review2',
      'intuit2_reviews',
      'review',
      'postgres',
      '',
    ]) {
      const problems = problemsOf({
        ...good,
        DATABASE_URL: `postgres://intuit_app:pw@127.0.0.1:55432/${database}`,
        DATABASE_MIGRATION_URL: `postgres://intuit_owner:pw@127.0.0.1:55432/${database}`,
      });
      expect(problems.length, database).toBeGreaterThan(0);
      expect(problems.join(), database).toContain('exactly');
    }
    const dev = problemsOf({
      ...good,
      DEMO_SEED_CONFIRM: 'intuit2_dev',
      DATABASE_URL: 'postgres://intuit_app:pw@127.0.0.1:55432/intuit2_dev',
      DATABASE_MIGRATION_URL: 'postgres://intuit_owner:pw@127.0.0.1:55432/intuit2_dev',
    });
    expect(dev.join()).toContain('protected database');
  });

  it('refuses port 5432, written or implied', () => {
    for (const authority of ['127.0.0.1:5432', '127.0.0.1', 'localhost:5432', 'db.example.test']) {
      const problems = problemsOf({
        ...good,
        DATABASE_URL: `postgres://intuit_app:pw@${authority}/${DEMO_DATABASE}`,
        DATABASE_MIGRATION_URL: `postgres://intuit_owner:pw@${authority}/${DEMO_DATABASE}`,
      });
      expect(problems.join(), authority).toMatch(/5432|explicit/);
    }
  });

  it('refuses query parameters that could redirect the connection', () => {
    const problems = problemsOf({
      ...good,
      DATABASE_URL: `${good.DATABASE_URL}?host=/var/run/postgresql`,
    });
    expect(problems.join()).toContain('query parameters');
  });

  it('refuses the wrong roles and URLs that disagree', () => {
    expect(
      problemsOf({
        ...good,
        DATABASE_URL: `postgres://postgres:pw@127.0.0.1:55432/${DEMO_DATABASE}`,
      }).join(),
    ).toContain('role must be intuit_app');
    expect(
      problemsOf({
        ...good,
        DATABASE_MIGRATION_URL: `postgres://intuit_owner:pw@127.0.0.1:55433/${DEMO_DATABASE}`,
      }).join(),
    ).toContain('same host, port and database');
    expect(problemsOf({ ...good, DATABASE_URL: undefined }).join()).toContain(
      'DATABASE_URL is not set',
    );
    expect(problemsOf({ ...good, DATABASE_URL: 'not a url' }).join()).toContain('not a valid');
  });

  it('refuses when a .env file exists or a libpq variable could redirect the connection', () => {
    expect(problemsOf(good, { envFileExists: true }).join()).toContain('.env');
    for (const name of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGSERVICE', 'PGOPTIONS']) {
      expect(problemsOf({ ...good, [name]: 'x' }).join(), name).toContain(name);
    }
  });

  it('needs long shared secrets', () => {
    expect(problemsOf({ ...good, DEV_SEED_PASSWORD: 'short' }).join()).toContain(
      'DEV_SEED_PASSWORD',
    );
    expect(problemsOf({ ...good, DEV_SEED_PASSWORD: undefined }).join()).toContain(
      'DEV_SEED_PASSWORD',
    );
    expect(problemsOf({ ...good, DEV_SEED_TOTP_SECRET: 'MFRGGZDFMZTWQ2LK' }).join()).toContain(
      'DEV_SEED_TOTP_SECRET',
    );
    expect(problemsOf({ ...good, DEV_SEED_TOTP_SECRET: '!!!' }).join()).toContain(
      'DEV_SEED_TOTP_SECRET',
    );
  });

  it('reports every problem at once and never repeats a secret or a connection string', () => {
    const problems = problemsOf({
      DEMO_SEED_CONFIRM: 'no',
      DATABASE_URL: 'postgres://intuit_app:SuperSecretPw@127.0.0.1:5432/intuit2_dev',
      DATABASE_MIGRATION_URL: 'postgres://intuit_owner:SuperSecretPw@127.0.0.1:5432/intuit2_dev',
      DEV_SEED_PASSWORD: 'SuperSecretPw',
      DEV_SEED_TOTP_SECRET: 'AAAA',
    });
    expect(problems.length).toBeGreaterThanOrEqual(5);
    const text = problems.join('\n');
    expect(text).not.toContain('SuperSecretPw');
    expect(text).not.toContain('postgres://');
    try {
      validateDemoSeedEnvironment({ ...good, DEV_SEED_PASSWORD: 'SuperSecretPw' }, ok);
    } catch (error) {
      expect((error as Error).message).not.toContain('SuperSecretPw');
    }
  });
});

describe('checkServerIdentity', () => {
  const target = { host: '127.0.0.1', port: 55432, database: DEMO_DATABASE };
  const identity = (over: Partial<ServerIdentity> = {}): ServerIdentity => ({
    database: DEMO_DATABASE,
    port: 55432,
    role: 'intuit_app',
    databases: ['postgres', DEMO_DATABASE, 'template1'],
    ...over,
  });

  it('accepts the matching server', () => {
    expect(checkServerIdentity(identity(), target, EXPECTED_ROLES.app)).toEqual([]);
  });

  it('rejects a server that says it is somewhere else', () => {
    expect(
      checkServerIdentity(identity({ database: 'intuit2_dev' }), target, 'intuit_app').length,
    ).toBeGreaterThan(0);
    expect(checkServerIdentity(identity({ port: 5432 }), target, 'intuit_app').join()).toContain(
      '5432',
    );
    expect(checkServerIdentity(identity({ port: 55433 }), target, 'intuit_app').join()).toContain(
      '55433',
    );
    expect(
      checkServerIdentity(identity({ role: 'postgres' }), target, 'intuit_app').join(),
    ).toContain('role');
  });

  it('rejects a cluster that holds any protected database', () => {
    for (const name of PROTECTED_DATABASES) {
      const problems = checkServerIdentity(
        identity({ databases: ['postgres', DEMO_DATABASE, name] }),
        target,
        'intuit_app',
      );
      expect(problems.join(), name).toContain('protected database');
    }
    expect(
      checkServerIdentity(identity({ databases: ['INTUIT2_TRIAL'] }), target, 'intuit_app').join(),
    ).toContain('protected database');
  });
});
