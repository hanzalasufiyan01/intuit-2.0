/**
 * Development/testing trigger for revaluation runs (S9, N6):
 *
 *   pnpm --filter @intuit-2/api revaluation:dev-run --email <user> --date YYYY-MM-DD [--run-key K]
 *   pnpm --filter @intuit-2/api revaluation:dev-run --email <user> --cancel <run id>
 *        --version N --reason "..."
 *   (add --organization "<name>" when the user belongs to several organizations)
 *
 * Runs through the real RevaluationService as the named user, with their current permissions
 * and MFA requirement (see application/revaluation-dev-trigger.ts). Refuses to run outside
 * APP_ENV development/testing. Prints the run's id, status, totals and journals only.
 */
import { parseArgs } from 'node:util';
import { buildApp } from '../../app.js';
import {
  DEV_TRIGGER_ENVIRONMENTS,
  runDevRevaluation,
} from '../../application/revaluation-dev-trigger.js';
import { systemClock } from '../../infrastructure/clock.js';
import { loadConfig } from '../../infrastructure/config/config.js';
import { loadEnvFile } from '../../infrastructure/config/load-env.js';
import { MockEmailProvider } from '../../infrastructure/email/email-provider.js';
import { createArgon2idPasswordHasher } from '../../infrastructure/security/password-hasher.js';
import { createDatabase } from '../client.js';

loadEnvFile();
const config = loadConfig({ ...process.env, LOG_LEVEL: 'warn' });
if (!DEV_TRIGGER_ENVIRONMENTS.has(config.appEnv)) {
  console.error(`Refusing to run the revaluation development trigger in APP_ENV=${config.appEnv}.`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    organization: { type: 'string' },
    date: { type: 'string' },
    'run-key': { type: 'string' },
    cancel: { type: 'string' },
    version: { type: 'string' },
    reason: { type: 'string' },
  },
});
if (!values.email || (!values.date && !values.cancel)) {
  console.error(
    'Usage: --email <user> (--date YYYY-MM-DD | --cancel <run id> --version N --reason "...")',
  );
  process.exit(1);
}

const database = createDatabase({ connectionString: config.database.url, poolMax: 2 });
const { app, services } = await buildApp({
  deps: {
    db: database.db,
    config,
    clock: systemClock,
    passwordHasher: createArgon2idPasswordHasher(),
    emailProvider: new MockEmailProvider(config.email.from),
  },
});

try {
  const run = await runDevRevaluation({ db: database.db, config }, services.revaluations, {
    email: values.email,
    organizationName: values.organization ?? null,
    action: values.cancel
      ? {
          kind: 'cancel',
          runId: values.cancel,
          version: Number(values.version),
          reason: values.reason ?? '',
        }
      : { kind: 'post', revaluationDate: values.date!, runKey: values['run-key'] ?? null },
  });
  console.log(
    JSON.stringify(
      {
        id: run.id,
        status: run.status,
        revaluationDate: run.revaluationDate,
        reversalDate: run.reversalDate,
        version: run.version,
        totalGain: run.totalGain,
        totalLoss: run.totalLoss,
        netAdjustment: run.netAdjustment,
        lineCount: run.lineCount,
        journals: run.journals.map((j) => ({
          number: j.number,
          currency: j.currency,
          role: j.role,
          entryDate: j.entryDate,
          status: j.status,
        })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  const { code, details } = error as { code?: string; details?: unknown };
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(
    `Revaluation failed${code ? ` (${code})` : ''}: ${message}` +
      (details === undefined ? '' : ` ${JSON.stringify(details)}`),
  );
  process.exitCode = 1;
} finally {
  await app.close();
  await database.close();
}
