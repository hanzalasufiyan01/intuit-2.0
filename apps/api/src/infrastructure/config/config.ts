import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const positiveInt = z.coerce.number().int().positive();

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// connection URL');

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'testing', 'staging', 'production']),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  WEB_ORIGIN: z.url(),
  // Set to true only when the API runs behind a trusted reverse proxy (client IP from X-Forwarded-For).
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  DATABASE_URL: postgresUrl,
  DATABASE_MIGRATION_URL: postgresUrl.optional(),
  DATABASE_POOL_MAX: positiveInt.default(10),

  SESSION_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default('intuit_session'),
  SESSION_IDLE_TIMEOUT_MINUTES: positiveInt.default(30),
  SESSION_ABSOLUTE_LIFETIME_DAYS: positiveInt.default(7),
  SENSITIVE_ACTION_REAUTH_MINUTES: positiveInt.default(15),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  PASSWORD_MIN_LENGTH: positiveInt.default(12),
  // Approved and frozen at 60 minutes (ADR 0001).
  PASSWORD_RESET_TOKEN_TTL_MINUTES: positiveInt.default(60),

  LOGIN_MAX_FAILED_ATTEMPTS: positiveInt.default(5),
  LOGIN_FAILED_WINDOW_MINUTES: positiveInt.default(15),
  LOGIN_BACKOFF_BASE_SECONDS: positiveInt.default(60),
  LOGIN_BACKOFF_MAX_SECONDS: positiveInt.default(900),

  INVITATION_EXPIRY_HOURS: positiveInt.default(72),

  OUTBOX_POLL_INTERVAL_MS: positiveInt.default(2000),
  OUTBOX_BATCH_SIZE: positiveInt.default(20),

  EMAIL_PROVIDER: z.enum(['mock']).default('mock'),
  EMAIL_FROM: z.email().default('no-reply@example.test'),
});

export type AppEnv = z.infer<typeof envSchema>['APP_ENV'];

export interface AppConfig {
  appEnv: AppEnv;
  api: { host: string; port: number };
  logLevel: (typeof logLevels)[number];
  webOrigin: string;
  trustProxy: boolean;
  database: { url: string; migrationUrl: string | undefined; poolMax: number };
  session: {
    cookieName: string;
    cookieSecure: boolean;
    idleTimeoutMs: number;
    absoluteLifetimeMs: number;
    reauthWindowMs: number;
    secret: string;
  };
  password: { minLength: number; maxLength: number; resetTokenTtlMs: number };
  loginProtection: {
    maxFailedAttempts: number;
    windowMs: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
  };
  invitations: { expiryMs: number };
  outbox: { pollIntervalMs: number; batchSize: number };
  email: { provider: 'mock'; from: string };
}

const MINUTE = 60_000;

/** Upper bound on password length, to bound hashing cost. Not a complexity rule. */
const PASSWORD_MAX_LENGTH = 1024;

export class ConfigError extends Error {}

/** Validates environment variables and derives the typed application configuration. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${problems}`);
  }
  const e = parsed.data;
  return {
    appEnv: e.APP_ENV,
    api: { host: e.API_HOST, port: e.API_PORT },
    logLevel: e.LOG_LEVEL,
    webOrigin: new URL(e.WEB_ORIGIN).origin,
    trustProxy: e.TRUST_PROXY,
    database: {
      url: e.DATABASE_URL,
      migrationUrl: e.DATABASE_MIGRATION_URL,
      poolMax: e.DATABASE_POOL_MAX,
    },
    session: {
      cookieName: e.SESSION_COOKIE_NAME,
      // Approved: Secure in production. Local http development and tests cannot use Secure cookies.
      cookieSecure: e.APP_ENV === 'production' || e.APP_ENV === 'staging',
      idleTimeoutMs: e.SESSION_IDLE_TIMEOUT_MINUTES * MINUTE,
      absoluteLifetimeMs: e.SESSION_ABSOLUTE_LIFETIME_DAYS * 24 * 60 * MINUTE,
      reauthWindowMs: e.SENSITIVE_ACTION_REAUTH_MINUTES * MINUTE,
      secret: e.SESSION_SECRET,
    },
    password: {
      minLength: e.PASSWORD_MIN_LENGTH,
      maxLength: PASSWORD_MAX_LENGTH,
      resetTokenTtlMs: e.PASSWORD_RESET_TOKEN_TTL_MINUTES * MINUTE,
    },
    loginProtection: {
      maxFailedAttempts: e.LOGIN_MAX_FAILED_ATTEMPTS,
      windowMs: e.LOGIN_FAILED_WINDOW_MINUTES * MINUTE,
      backoffBaseMs: e.LOGIN_BACKOFF_BASE_SECONDS * 1000,
      backoffMaxMs: e.LOGIN_BACKOFF_MAX_SECONDS * 1000,
    },
    invitations: { expiryMs: e.INVITATION_EXPIRY_HOURS * 60 * MINUTE },
    outbox: { pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS, batchSize: e.OUTBOX_BATCH_SIZE },
    email: { provider: e.EMAIL_PROVIDER, from: e.EMAIL_FROM },
  };
}
