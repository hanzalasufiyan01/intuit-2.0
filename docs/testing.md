# Testing and verification

Facts here come from running the commands on 2026-10-26 on a Windows development machine (Node 22.15.1, pnpm 10.28.0, PostgreSQL 16.15) against a throwaway database, and from `.github/workflows/ci.yml`. Counts change; re-run the commands.

## The commands

| What                                                     | Command                                                                        | Needs a database |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------- |
| Everything CI runs before the browser tests              | `pnpm verify` (format check, lint, typecheck, OpenAPI check, all tests, build) | yes              |
| One API test file                                        | `pnpm --filter @intuit-2/api exec vitest run test/<file>.test.ts`              | yes (most files) |
| Database-free API tests (guards, policy, assistant unit) | run the named files with a config that has no global setup (see below)         | no               |
| Web tests                                                | `pnpm --filter @intuit-2/web test`                                             | no               |
| Typecheck and lint                                       | `pnpm typecheck`, `pnpm lint`                                                  | no               |
| Format                                                   | `pnpm format:check` (Prettier over the whole repository)                       | no               |
| OpenAPI baseline                                         | `pnpm openapi:check`                                                           | no               |
| Browser tests (Playwright, 12 spec files, 22 journeys)   | `pnpm e2e:install` once, then `pnpm e2e`                                       | yes              |
| Production dependency audit                              | `pnpm audit --prod --audit-level high`                                         | network          |

The API test run starts slowly (migrations and seeding of the real database) and the full API suite took about nine minutes on a fast machine. Test files run in parallel against one database; the suite caps its workers, and the known load-dependent failures are in `known-flaky-tests.md`.

## Results at `2652a64` (2026-10-26, throwaway database)

- `pnpm verify`: exit 0. API 135 files, 1909 passed, 4 skipped. Web 71 files, 829 passed.
- `playwright test` with `CI=1`: 22 passed, twice in a row, on the database left behind by the API suite (as in CI).
- `pnpm audit --prod --audit-level high`: exit 0, but it reports 9 low and moderate advisories (`production-readiness-audit.md`).
- GitHub: `deploy-smoke` passed; `ci` run 40366991696 attempt 1 failed in the Playwright step (test unknown), attempt 2 passed.

## A throwaway PostgreSQL for tests (never use a shared or personal database)

CI uses a `postgres:16` service container. Locally, create a disposable cluster, bootstrap one database in it, and delete it afterwards:

1. `initdb -D <scratch>/data -U <super> --auth=scram-sha-256 --pwfile=<file>` then start it on a non-default port bound to loopback, for example `pg_ctl -D <scratch>/data -o "-p 55432 -c listen_addresses=127.0.0.1" -w start`. (On Windows, redirect the standard streams or `pg_ctl` may hang.)
2. Bootstrap: `psql -h 127.0.0.1 -p 55432 -U <super> -d postgres -v ON_ERROR_STOP=1 -v db_name=<db> -v owner_password=<pw> -v app_password=<pw> -f apps/api/src/database/bootstrap.sql`. The options must come before the file name on Windows.
3. Set `DATABASE_URL` (`intuit_app`) and `DATABASE_MIGRATION_URL` (`intuit_owner`) for that port, plus `APP_ENV=testing`, `WEB_ORIGIN=http://localhost:5173`, `SESSION_SECRET` (32+ characters), `MFA_ENCRYPTION_KEYS`, `MFA_ENCRYPTION_ACTIVE_KEY_ID`, `WEBHOOK_ENCRYPTION_KEYS`, `WEBHOOK_ENCRYPTION_ACTIVE_KEY_ID` and `DEV_SEED_PASSWORD` in the process environment. Do not create a `.env` in the repository root (some guards refuse to run if one exists).
4. `pnpm db:setup`, then the tests.
5. Teardown: stop the server, confirm the port is closed, then delete only the exact scratch directory.

Before running anything that writes, check which database you are connected to. The helper guards used during this project asked the server itself for its database, port and role and refused to continue on any mismatch.

## Database-free API tests

The default Vitest configuration starts a real database through a global setup. To run pure unit tests (the demo-seed guard, the registration policy, the assistant unit tests) without one, use a small config with `test.include` set to those files and no `globalSetup`.

## Browser tests

`playwright.config.ts` starts `pnpm dev:api` and `pnpm dev:web` and reuses them if already running. Each journey registers its own organization, so no seed data is needed. `retries` is 0 and there is one worker. In CI the API request log is printed and, on failure, a screenshot and `error-context.md` per failing test are uploaded (7 days). Traces are not uploaded because they hold cookies and tokens.

One reproduced, fixed failure class: clicking a link that moves while a list loads (the refund link; `known-flaky-tests.md`). When a journey fails, record the failing test, line and call log before changing anything.

## CI

`ci.yml` (verify job): Postgres 16 service, bootstrap, `.env` with throwaway secrets, `pnpm db:setup`, format, lint, typecheck, OpenAPI check (against the base branch on pull requests), `pnpm test`, `pnpm build`, Playwright, failure upload, `pnpm audit --prod --audit-level high`. `deploy-smoke.yml` builds both images and proves the compose stack on a disposable runner (`stack` job) and, separately, a review database on port 5433, the demo seed, and all three registration modes (`review-port` job). Neither workflow deploys anything.
