# Local Development

## Prerequisites

| Tool       | Version                                   |
| ---------- | ----------------------------------------- |
| Node.js    | 22.12 or later (see `.nvmrc`)             |
| pnpm       | 10.28.0 (pinned in `package.json`)        |
| PostgreSQL | 16, the native local service on port 5432 |

Docker is **not** required. `docker-compose.yml` is an optional alternative only.

## 1. Install dependencies

```sh
pnpm install
```

## 2. Configure the environment

```sh
cp .env.example .env
```

Edit `.env` and replace every `CHANGE_ME` value:

- `DATABASE_URL`: connection string for the **`intuit_app`** role on `intuit2_dev`.
- `DATABASE_MIGRATION_URL`: connection string for the **`intuit_owner`** role on `intuit2_dev`.
- `SESSION_SECRET`: a long random value (32+ characters). For example: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

Choose strong, unique passwords for the two roles. `.env` is git-ignored. Never commit it.

### Environment variables

| Variable                                                 | Default                               | Purpose                                                           |
| -------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `APP_ENV`                                                | —                                     | `development`, `testing`, `staging` or `production`               |
| `API_HOST` / `API_PORT`                                  | `127.0.0.1` / `3000`                  | API listen address                                                |
| `LOG_LEVEL`                                              | `info`                                | pino log level                                                    |
| `WEB_ORIGIN`                                             | —                                     | Web app origin. State-changing requests from other origins fail.  |
| `TRUST_PROXY`                                            | `false`                               | `true` only behind a trusted reverse proxy                        |
| `DATABASE_URL`                                           | —                                     | Runtime role (`intuit_app`)                                       |
| `DATABASE_MIGRATION_URL`                                 | —                                     | Migration role (`intuit_owner`)                                   |
| `DATABASE_POOL_MAX`                                      | `10`                                  | Connection pool size                                              |
| `SESSION_COOKIE_NAME`                                    | `intuit_session`                      | Session cookie name                                               |
| `SESSION_IDLE_TIMEOUT_MINUTES`                           | `30`                                  | Idle timeout                                                      |
| `SESSION_ABSOLUTE_LIFETIME_DAYS`                         | `7`                                   | Absolute session lifetime                                         |
| `SENSITIVE_ACTION_REAUTH_MINUTES`                        | `15`                                  | Re-authentication window for sensitive actions                    |
| `SESSION_SECRET`                                         | —                                     | Server secret used to derive CSRF tokens                          |
| `PASSWORD_MIN_LENGTH`                                    | `12`                                  | Minimum password length                                           |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES`                       | `60`                                  | Reset-link lifetime. Approved and frozen at 60                    |
| `LOGIN_MAX_FAILED_ATTEMPTS`                              | `5`                                   | Failures (per account and per IP) before back-off                 |
| `LOGIN_FAILED_WINDOW_MINUTES`                            | `15`                                  | Failure counting window                                           |
| `LOGIN_BACKOFF_BASE_SECONDS` / `_MAX_SECONDS`            | `60` / `900`                          | Progressive back-off                                              |
| `INVITATION_EXPIRY_HOURS`                                | `72`                                  | Invitation lifetime (approved)                                    |
| `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_BATCH_SIZE`          | `2000` / `20`                         | Outbox dispatcher                                                 |
| `DEV_SEED_PASSWORD`                                      | —                                     | Password for `pnpm db:seed:dev` users (local only)                |
| `DEV_SEED_TOTP_SECRET`                                   | —                                     | Authenticator key (base32) for the seeded Owner and Administrator |
| `MFA_ENCRYPTION_KEYS` / `MFA_ENCRYPTION_ACTIVE_KEY_ID`   | — (required)                          | AES-256-GCM key ring for TOTP secrets (`keyId:base64-32-bytes`)   |
| `MFA_TOTP_ISSUER` / `MFA_TOTP_WINDOW`                    | `Intuit 2.0` / `1`                    | Authenticator label; ±1 step (0 allowed, never wider)             |
| `MFA_RECOVERY_CODE_COUNT`                                | `10`                                  | Codes per issue (10–20)                                           |
| `MFA_PENDING_TTL_MINUTES` / `MFA_CHALLENGE_MAX_ATTEMPTS` | `10` / `5`                            | Sign-in code step                                                 |
| `MFA_ENROLLMENT_TTL_MINUTES` / `MFA_STEP_UP_MINUTES`     | `15` / `15`                           | Setup lifetime; step-up freshness                                 |
| `TRUSTED_DEVICE_DAYS` / `_MAX_PER_USER` / `_COOKIE_NAME` | `30` / `10` / `intuit_trusted_device` | Remembered browsers (at most 30 days)                             |
| `EMAIL_PROVIDER` / `EMAIL_FROM`                          | `mock`                                | Email provider (mock records messages in memory)                  |

The API validates its configuration at startup and exits with a list of problems if anything is invalid.

## 3. Set up PostgreSQL (one time)

The database uses two roles:

- **`intuit_owner`** owns the schema and runs migrations and seeding.
- **`intuit_app`** is the runtime role. It has least privilege: INSERT and SELECT only on audit and security-event tables, and it is subject to Row-Level Security.

Create both roles and the `intuit2_dev` database as a PostgreSQL superuser:

```sh
pnpm db:bootstrap
```

This runs `apps/api/src/database/bootstrap.sql` through `psql`. It reads the role passwords from your `.env`. `psql` prompts you for the superuser (`postgres`) password, and the script never reads or stores that password. The script is idempotent. On Windows it finds `psql` in the default install location. Set `PSQL_PATH` to use a different `psql`, or `PG_SUPERUSER` to connect as a superuser other than `postgres`.

## 4. Migrate and seed

```sh
pnpm db:setup      # = db:migrate + db:seed
```

- `pnpm db:migrate` applies the SQL files in `apps/api/src/database/migrations/` in order, as `intuit_owner`. Applied migrations are recorded with a checksum in `schema_migrations`. Editing an applied migration is detected and refused, so add a new numbered file instead.
- `pnpm db:seed` upserts the permission catalog and the system role templates, and re-syncs every organization's Owner role to the full catalog. It contains no user data.

Both commands are safe to run repeatedly.

### Development seed (optional)

```sh
pnpm db:seed:dev
```

This creates the example organization "Maldives Demo Trading":

- accounting set up with MVR and the Maldives template, plus the current fiscal year with monthly periods;
- users `owner@`, `admin@` and `member@intuit2-dev.test` (Owner, Administrator, Member);
- an approval policy for journals, a USD rate, one approved and posted journal, and one draft journal.

Details:

- Set `DEV_SEED_PASSWORD` in `.env` first. All seeded users share that password, and it is never printed or committed.
- Set `DEV_SEED_TOTP_SECRET` too (a base32 authenticator key, e.g. 20 random bytes). The Owner and Administrator must use two-step verification (Decision 57a), so the seed enrolls them with this key; add it to an authenticator app to sign in as them. The Member does not need it.
- The command refuses to run unless `APP_ENV` is `development` or `testing`.
- It is idempotent: if the seed owner already exists, it changes nothing, except that it sets up two-step verification for a seeded Owner or Administrator who does not have it yet.
- A database seeded before Phase 3A S1 keeps its original chart: accounts are unclassified and there are no system-account designations. To try opening balances there, add an Opening Balance Equity account and designate it (and Retained Earnings), and classify the receivable account as `ACCOUNTS_RECEIVABLE` so that S8-07 excludes it.

### Revaluation development trigger (optional)

S9 has no revaluation screen yet (Phase 4). In development or testing, a run can be posted or cancelled from the command line, through the real revaluation service, as an existing user:

```sh
pnpm --filter @intuit-2/api revaluation:dev-run --email owner@intuit2-dev.test --date 2026-09-30
pnpm --filter @intuit-2/api revaluation:dev-run --email owner@intuit2-dev.test --cancel <run id> --version <n> --reason "Why"
```

- The user needs `accounting.journals.post` (or `accounting.journals.reverse` to cancel) and must satisfy their MFA requirement.
- Add `--organization "<name>"` when the user belongs to several organizations, and `--run-key <key>` to make a retry return the same run.
- The command refuses to run in any other `APP_ENV`.
- It has no browser session, so it skips the password re-confirmation that the real (Phase 4) flow will require. This test-only bypass is recorded on the audit event as `reauthentication: dev_trigger_bypass`.

## 5. Run

```sh
pnpm dev           # API (http://127.0.0.1:3000) + web (http://localhost:5173)
pnpm dev:api
pnpm dev:web
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the API, so the browser only sees one origin. The session cookie stays first-party, and the approved cookie and CSRF model is unchanged.

**Emails in development:** the mock provider records messages in memory and never logs them, because they contain one-time links. To test password-reset and invitation flows end to end, use the integration tests, which read the mock provider directly.

## Commands

| Command                             | What it does                                                   |
| ----------------------------------- | -------------------------------------------------------------- |
| `pnpm lint` / `pnpm lint:fix`       | ESLint, including module-boundary import rules                 |
| `pnpm format` / `pnpm format:check` | Prettier                                                       |
| `pnpm typecheck`                    | TypeScript (strict) for all workspaces                         |
| `pnpm test`                         | All tests                                                      |
| `pnpm test:api`                     | API unit and integration tests (real PostgreSQL)               |
| `pnpm test:web`                     | Frontend tests (jsdom)                                         |
| `pnpm build`                        | Builds the API (`apps/api/dist`) and web app (`apps/web/dist`) |
| `pnpm verify`                       | format:check, lint, typecheck, test, build                     |

## Tests

API integration tests run against the real `intuit2_dev` database, using the same two roles as the application:

- Global setup applies migrations and the seed as `intuit_owner`.
- The app under test connects as `intuit_app` and is exercised through HTTP (`fastify.inject`).
- Tests never truncate. Every test creates uniquely named users and organizations. Audit and security history is append-only by design, so test runs accumulate rows in the development database.
- Time-dependent behavior (session expiry, reset-token expiry, invitation expiry, login back-off) uses an injectable clock.

Frontend tests use jsdom with a small in-memory API stand-in for UI behavior. The real API behavior is covered by the integration tests.
