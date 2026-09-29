import path from 'node:path';
import { z } from 'zod';
import { MfaKeyError, MfaKeyRing } from '../security/mfa-keyring.js';
import { findRepoRoot } from './load-env.js';

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

  // Phase 3A S5: file storage (Decisions 6, 29, 61, 75, 76; S5-02, S5-08, S5-13)
  STORAGE_PROVIDER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().min(1).default('.data/storage'),
  FILE_DOWNLOAD_TOKEN_TTL_MINUTES: positiveInt.default(5),
  FILE_RETENTION_DAYS: positiveInt.default(90),
  FILES_PURGE_INTERVAL_MINUTES: positiveInt.default(60),
  // Phase 3A S5: background jobs (Decisions 20, 76; S5-14, S5-17)
  JOBS_WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  JOBS_POLL_INTERVAL_MS: positiveInt.default(1000),
  JOBS_CONCURRENCY: positiveInt.default(2),
  JOBS_MAX_ATTEMPTS: positiveInt.default(5),
  JOBS_BACKOFF_BASE_SECONDS: positiveInt.default(5),
  JOBS_BACKOFF_MAX_SECONDS: positiveInt.default(900),
  JOBS_STALE_LOCK_MINUTES: positiveInt.default(10),
  // Phase 3A S6: import/export (Decisions 24, 61; S6-40). Decision 61 maxima may only be lowered.
  IMPORT_MAX_ROWS: positiveInt.max(25_000).default(25_000),
  IMPORT_PREVIEW_ROWS: positiveInt.max(500).default(500),
  IMPORT_MAX_ACTIVE_PER_ORGANIZATION: positiveInt.default(3),
  IMPORT_BATCH_EXPIRY_DAYS: positiveInt.default(7),
  IMPORT_STAGING_RETENTION_DAYS: positiveInt.default(30),
  IMPORT_COMMIT_STATEMENT_TIMEOUT_SECONDS: positiveInt.default(600),
  IMPORT_COMMIT_LOCK_TIMEOUT_SECONDS: positiveInt.default(10),
  EXPORT_MAX_BYTES: positiveInt.max(25 * 1024 * 1024).default(25 * 1024 * 1024),
  EXPORT_EXPIRY_DAYS: positiveInt.default(7),
  DATA_EXCHANGE_CLEANUP_INTERVAL_MINUTES: positiveInt.default(60),

  // Phase 3A S7: MFA (Decisions 25, 57, 76; S7-09, S7-11, S7-18, S7-34, S7-43).
  // Keys: comma-separated `keyId:base64(32 bytes)`; the active key seals new secrets.
  MFA_ENCRYPTION_KEYS: z.string().min(1, 'MFA_ENCRYPTION_KEYS is required'),
  MFA_ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1, 'MFA_ENCRYPTION_ACTIVE_KEY_ID is required'),
  MFA_TOTP_ISSUER: z.string().trim().min(1).max(60).default('Intuit 2.0'),
  // Decision 76: ±1 step. Configurable only to be stricter (0), never wider.
  MFA_TOTP_WINDOW: z.coerce.number().int().min(0).max(1).default(1),
  // Decision 76: 10 codes per issue; configurable upwards only.
  MFA_RECOVERY_CODE_COUNT: z.coerce.number().int().min(10).max(20).default(10),
  MFA_PENDING_TTL_MINUTES: positiveInt.max(30).default(10),
  MFA_CHALLENGE_MAX_ATTEMPTS: positiveInt.max(10).default(5),
  MFA_ENROLLMENT_TTL_MINUTES: positiveInt.max(60).default(15),
  MFA_STEP_UP_MINUTES: positiveInt.max(60).default(15),
  // Decision 57d / S7-34: at most 30 days.
  TRUSTED_DEVICE_DAYS: positiveInt.max(30).default(30),
  TRUSTED_DEVICE_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default('intuit_trusted_device'),
  TRUSTED_DEVICE_MAX_PER_USER: positiveInt.max(50).default(10),

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
  storage: {
    provider: 'local';
    /** Absolute path of the local provider root. */
    localRoot: string;
    downloadTokenTtlMs: number;
    retentionMs: number;
    purgeIntervalMs: number;
  };
  jobs: {
    workerEnabled: boolean;
    pollIntervalMs: number;
    concurrency: number;
    maxAttempts: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    staleLockMs: number;
  };
  dataExchange: {
    maxRows: number;
    previewRows: number;
    maxActivePerOrganization: number;
    batchExpiryMs: number;
    stagingRetentionMs: number;
    commitStatementTimeoutMs: number;
    commitLockTimeoutMs: number;
    exportMaxBytes: number;
    exportExpiryMs: number;
    cleanupIntervalMs: number;
  };
  mfa: {
    keyRing: MfaKeyRing;
    issuer: string;
    totpWindow: number;
    recoveryCodeCount: number;
    pendingTtlMs: number;
    challengeMaxAttempts: number;
    enrollmentTtlMs: number;
    stepUpWindowMs: number;
    trustedDeviceLifetimeMs: number;
    trustedDeviceCookieName: string;
    trustedDeviceMaxPerUser: number;
  };
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
  let keyRing: MfaKeyRing;
  try {
    keyRing = MfaKeyRing.parse(e.MFA_ENCRYPTION_KEYS, e.MFA_ENCRYPTION_ACTIVE_KEY_ID);
  } catch (error) {
    // The message names the problem only, never key material.
    const detail = error instanceof MfaKeyError ? error.message : 'invalid MFA key ring';
    throw new ConfigError(`Invalid environment configuration:
  - ${detail}`);
  }
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
    storage: {
      provider: e.STORAGE_PROVIDER,
      // Relative roots resolve against the repository root (like .env), not the process cwd.
      localRoot: path.isAbsolute(e.STORAGE_LOCAL_ROOT)
        ? e.STORAGE_LOCAL_ROOT
        : path.join(findRepoRoot() ?? process.cwd(), e.STORAGE_LOCAL_ROOT),
      downloadTokenTtlMs: e.FILE_DOWNLOAD_TOKEN_TTL_MINUTES * MINUTE,
      retentionMs: e.FILE_RETENTION_DAYS * 24 * 60 * MINUTE,
      purgeIntervalMs: e.FILES_PURGE_INTERVAL_MINUTES * MINUTE,
    },
    jobs: {
      workerEnabled: e.JOBS_WORKER_ENABLED,
      pollIntervalMs: e.JOBS_POLL_INTERVAL_MS,
      concurrency: e.JOBS_CONCURRENCY,
      maxAttempts: e.JOBS_MAX_ATTEMPTS,
      backoffBaseMs: e.JOBS_BACKOFF_BASE_SECONDS * 1000,
      backoffMaxMs: e.JOBS_BACKOFF_MAX_SECONDS * 1000,
      staleLockMs: e.JOBS_STALE_LOCK_MINUTES * MINUTE,
    },
    dataExchange: {
      maxRows: e.IMPORT_MAX_ROWS,
      previewRows: e.IMPORT_PREVIEW_ROWS,
      maxActivePerOrganization: e.IMPORT_MAX_ACTIVE_PER_ORGANIZATION,
      batchExpiryMs: e.IMPORT_BATCH_EXPIRY_DAYS * 24 * 60 * MINUTE,
      stagingRetentionMs: e.IMPORT_STAGING_RETENTION_DAYS * 24 * 60 * MINUTE,
      commitStatementTimeoutMs: e.IMPORT_COMMIT_STATEMENT_TIMEOUT_SECONDS * 1000,
      commitLockTimeoutMs: e.IMPORT_COMMIT_LOCK_TIMEOUT_SECONDS * 1000,
      exportMaxBytes: e.EXPORT_MAX_BYTES,
      exportExpiryMs: e.EXPORT_EXPIRY_DAYS * 24 * 60 * MINUTE,
      cleanupIntervalMs: e.DATA_EXCHANGE_CLEANUP_INTERVAL_MINUTES * MINUTE,
    },
    mfa: {
      keyRing,
      issuer: e.MFA_TOTP_ISSUER,
      totpWindow: e.MFA_TOTP_WINDOW,
      recoveryCodeCount: e.MFA_RECOVERY_CODE_COUNT,
      pendingTtlMs: e.MFA_PENDING_TTL_MINUTES * MINUTE,
      challengeMaxAttempts: e.MFA_CHALLENGE_MAX_ATTEMPTS,
      enrollmentTtlMs: e.MFA_ENROLLMENT_TTL_MINUTES * MINUTE,
      stepUpWindowMs: e.MFA_STEP_UP_MINUTES * MINUTE,
      trustedDeviceLifetimeMs: e.TRUSTED_DEVICE_DAYS * 24 * 60 * MINUTE,
      trustedDeviceCookieName: e.TRUSTED_DEVICE_COOKIE_NAME,
      trustedDeviceMaxPerUser: e.TRUSTED_DEVICE_MAX_PER_USER,
    },
    email: { provider: e.EMAIL_PROVIDER, from: e.EMAIL_FROM },
  };
}
