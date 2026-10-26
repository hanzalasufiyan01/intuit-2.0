# Operations: deployment, backup, monitoring and release

This document is the runbook for running Intuit 2.0 in a real environment. **Status of `deploy/`, the `Dockerfile` and the workflows (2026-10-21): verified on disposable GitHub Actions runners, not in a real deployment.** The CI workflow ([run 39574210127](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39574210127)) and the deployment smoke workflow ([run 39574210093](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39574210093)) pass; section 9 lists what they prove and what is still unverified. Nothing here is a claim that a production deployment exists or that the product is production-ready.

## 1. What runs

| Part       | What                                                                                | Notes                                                                                 |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| PostgreSQL | 16, two roles: `intuit_owner` (migrations) and `intuit_app` (runtime)               | Row-level security protects tenants; the runtime role cannot change audit history.    |
| API        | `node dist/src/server.js` (Fastify), port 3000                                      | Also runs the job worker, the outbox dispatcher and the maintenance polls in-process. |
| Web        | Static files from `apps/web/dist` behind nginx                                      | nginx proxies `/api` to the API; TLS terminates in front of it.                       |
| File store | `STORAGE_PROVIDER=local` (`STORAGE_LOCAL_ROOT`) or `s3` (any S3-compatible service) | The S3 adapter is tested against a fake store only; never run against a real bucket.  |

| E-mail | `EMAIL_PROVIDER=smtp` (required in production) | The server refuses to start in production with the mock provider. |
| Help assistant | `ASSISTANT_PROVIDER=docs` (default) or `anthropic` | Optional AI wording; needs `ASSISTANT_API_KEY` and `ASSISTANT_MODEL`. Not exercised against a real provider yet. See `assistant.md`. |

**One API instance.** The job worker, the outbox dispatcher and the maintenance polls use `SKIP LOCKED` queues and are safe to run twice, but the local file store is not shared. Scale vertically, or put `STORAGE_LOCAL_ROOT` on a shared volume, before running more than one instance.

## 2. Configuration

Everything is configured through environment variables (`.env.example` lists them; `docs/development.md` explains them). For production create an `.env.production` that is **not** committed, with at least:

- `APP_ENV=production`, `WEB_ORIGIN=https://<your host>`, `TRUST_PROXY=true` (behind the proxy), `API_HOST=0.0.0.0`.
- `DATABASE_URL` (runtime role) and `DATABASE_MIGRATION_URL` (owner role). Use long random passwords.
- `SESSION_SECRET` (32+ random characters), `MFA_ENCRYPTION_KEYS` / `MFA_ENCRYPTION_ACTIVE_KEY_ID`, and, if webhooks are used, `WEBHOOK_ENCRYPTION_KEYS` / `WEBHOOK_ENCRYPTION_ACTIVE_KEY_ID`. Generate with `openssl rand -base64 32`. **Back these keys up separately from the database**: without them, MFA secrets and webhook signing secrets cannot be read.
- `REGISTRATION_MODE` (`open` by default). **Registration is public unless you change it.** For a private or review environment set `closed` (people join by invitation, which needs working e-mail) or `code` with `REGISTRATION_ACCESS_CODE` (at least 12 characters, shared out of band; a missing or wrong code is refused identically and guesses are limited per address). The code is a secret: keep it in the secret manager, not in Git. The mode and the code are read when the API starts, so changing either needs a restart; `REGISTRATION_ACCESS_CODE` is allowed only with `code` (the API refuses to start otherwise). The `review-port` job of `deploy-smoke` exercises all three modes through the running production stack: `open` registers, `code` refuses a missing, empty or wrong code and accepts the valid one, and `closed` refuses registration even with the earlier code. This is an application-level control; a network-level gate in front is still advisable for a review environment.
- `EMAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` (`starttls` or `tls`), `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` (a verified sender of your SMTP service).
- `STORAGE_LOCAL_ROOT` on a persistent, backed-up volume.
- `deploy/nginx.conf` sets `X-Forwarded-For` to the address nginx sees (`$remote_addr`) instead of appending to the client's header, so a caller cannot choose the address the API rate-limits on. If a load balancer sits in front of nginx, configure nginx's `set_real_ip_from` (the balancer's address range) and `real_ip_header X-Forwarded-For` so that `$remote_addr` is the real client. That load-balancer setup is not tested.

Cookies are `Secure` in production: the site must be served over HTTPS.

## 3. First deployment

1. Provision PostgreSQL 16. With `deploy/docker-compose.prod.yml` the roles and the database are created on the first start of an EMPTY data volume: `deploy/postgres-init/10-intuit-bootstrap.sh` runs the unchanged `bootstrap.sql` with `INTUIT_DB_NAME`, `INTUIT_OWNER_PASSWORD` and `INTUIT_APP_PASSWORD` from `.env.production`, which must be the same database and passwords as in `DATABASE_URL` and `DATABASE_MIGRATION_URL`. For an existing volume or a separately provisioned server, run `apps/api/src/database/bootstrap.sql` once as the `postgres` superuser (passwords are psql variables, see the file header).
2. Build: `docker build --target api -t intuit2-api .` and `--target web -t intuit2-web .` (or use `deploy/docker-compose.prod.yml`).
3. Migrate and seed reference data: `node dist/src/database/cli/migrate.js` then `node dist/src/database/cli/seed.js` (compose: `docker compose -f deploy/docker-compose.prod.yml run --rm migrate`). Migrations are checksummed; an applied migration is never edited.
4. Start the API and the web container, then run `BASE_URL=https://<host> sh deploy/smoke.sh`.
5. Register the first organization in the browser (with `REGISTRATION_MODE=closed` nobody can; use `open` or `code` for the first registration, then switch to `closed` and restart) (the registering user becomes the Owner and must enroll two-step verification).

### Demo data for a private review environment

`pnpm --filter @intuit-2/api db:seed:demo` (compiled: `node dist/src/database/cli/seed-demo.js`) puts the same fictional "Maldives Demo Trading" data as `db:seed:dev` (sales and purchases samples, three users) into **one exactly named database, `intuit2_review`**. It is for a network-restricted review environment, never for real data.

- It runs only if `DEMO_SEED_CONFIRM` is exactly `intuit2_review`; `DATABASE_URL` (role `intuit_app`) and `DATABASE_MIGRATION_URL` (role `intuit_owner`) both name that database on the same host and an **explicit port other than 5432**, with no query parameters; no `.env` file exists in the repository root; and no libpq variable (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGSERVICE`, `PGOPTIONS`) is set. `intuit2_dev`, `intuit2_trial` and `intuit2_restore_drill` are refused by name.
- **`APP_ENV` must be `development`, `testing` or `staging`, written exactly.** `APP_ENV=production` is refused whatever the database name, port or confirmation, and so is a missing, empty or differently spelled value. The production images and compose file set `APP_ENV=production`, so in a review stack override it for the one seed command only, for example `docker compose --profile tools run --rm -e APP_ENV=staging -e DEMO_SEED_CONFIRM=intuit2_review -e DEV_SEED_PASSWORD -e DEV_SEED_TOTP_SECRET migrate node dist/src/database/cli/seed-demo.js`. Do not put `APP_ENV=staging` in `.env.production` for the running API. The override is the operator's statement that this is a review environment; never make it against a database that holds real data.
- Before it writes anything, and again after it finishes, it asks the database server itself which database, port and role it is reached as, and refuses if the cluster holds any protected database name.
- `db:seed:dev` is not changed and still refuses every `APP_ENV` but `development` and `testing`; the wrapper runs it with `APP_ENV=testing` for that one process after the checks pass. It must run with the same `MFA_ENCRYPTION_KEYS` as the API, because the authenticator secrets are sealed with them.
- **Database port.** The demo seed refuses port 5432, and the compose database listens on 5432 by default. For a review environment set `INTUIT_DB_PORT=5433` in `.env.production` and use `:5433` in both `DATABASE_URL` and `DATABASE_MIGRATION_URL`; the compose file then starts PostgreSQL with `-p 5433` and `PGPORT=5433`, and the database stays unpublished. Without `INTUIT_DB_PORT` nothing changes (5432). The `review-port` job of `deploy-smoke` proves, on a disposable runner, a fresh bootstrap on 5433, that the built API image contains the wrapper and its guard, that the wrapper still refuses 5432, a wrong confirmation, `APP_ENV=production` and an empty `APP_ENV` inside the stack, and that the seed reaches only `intuit2_review`.
- Shared credentials: every demo user has the password in `DEV_SEED_PASSWORD` (at least 16 characters) and the owner and administrator share the authenticator key in `DEV_SEED_TOTP_SECRET` (a base32 key of at least 20 bytes). Supply them from a secret manager; never commit them, never print them. They are acceptable **only** behind a network gate. Rotate them, or remove the demo users, before any wider exposure.
- It is idempotent. To reset the demo, drop and recreate the review database (an operator action on that database only, never on real data) and run the migrations and the seed again.
- It is not production data and not a test of production readiness. Banking, inventory and payroll samples are not part of it.

## 4. Upgrades and rollback

1. Take a backup first (section 5).
2. Deploy the new image, run the migrations (they are forward-only and additive), run `deploy/smoke.sh`.
3. **Rollback** is a restore: migrations are not reversible. If a release must be undone after migrations ran, restore the pre-upgrade backup and redeploy the previous image. Plan upgrades so that the previous image still works with the new schema where possible (additive columns, no renames).

## 5. Backup and recovery

- **Database**: `deploy/backup.sh` (pg_dump custom format, verified with `pg_restore --list`, 14-day retention by default). Schedule it at least daily and keep copies off the database host. For a lower recovery point objective use PostgreSQL continuous archiving (WAL) in addition; that is a platform decision, not part of this repository.
- **Files**: the same script archives `FILES_DIR` (uploaded documents, generated PDFs).
- **Keys**: back up the encryption keys and `SESSION_SECRET` separately from the data.
- **Restore drill** (do it before go-live and after each major change): create an empty database, run `TARGET_URL=... sh deploy/restore.sh <dump>`, start the API against it, run the smoke test, and compare the Trial Balance of a known organization with production. `restore.sh` refuses a non-empty target unless `RESTORE_FORCE=yes`. **A restore drill was performed on 2026-10-19** with `deploy/restore-drill.sh` against the DEVELOPMENT database (11 GB of accumulated test data, 88 migrations, dump 1 GB) restored into an empty `intuit2_restore_drill` database created by a superuser: 211 tables, 196 tables with row-level security, row counts equal on every table, 88 identical migration checksums, every posted journal balances, the trial balance sums to zero for every organization, an identical fingerprint of all journal lines, inventory levels add up, 200 policies restored. It was run in two invocations: the first restored the database and then hit a bug in the validator's trial-balance query (an ambiguous column) which is fixed; the validation was then re-run on the restored database and passed. Two script bugs were found by actually running it (Windows `psql` ignores options placed after the connection string; the ambiguous column) and fixed. This is NOT evidence about a production system, production data volumes, point-in-time recovery or the time to recover; repeat it against a production-like backup before go-live.

## 6. Monitoring

- `GET /api/v1/health` returns 200 `{"data":{"status":"ok","database":"ok"}}` and 503 when the database is unreachable. Point the load balancer's health check and an external uptime monitor at it.
- `GET /api/v1/metrics` (Prometheus text format) exposes request counts and latency by route class, in-flight requests, job queue depth, pending and failed outbox events and failed webhook deliveries. It needs `Authorization: Bearer <METRICS_TOKEN>`; without `METRICS_TOKEN` configured the endpoint is disabled.
- Logs are structured JSON (pino) on stdout with a request id on every line; ship them to your log store. Secrets, tokens and message bodies are not logged.
- Suggested alerts: health check failing for 2 minutes; `intuit_jobs_failed` increasing; `intuit_outbox_failed` > 0; 5xx rate above 2% for 5 minutes; disk space on the database and file volumes below 20%; certificate expiry within 14 days.

## 7. Security checklist before go-live

- [ ] HTTPS everywhere; HSTS configured at the proxy.
- [ ] `EMAIL_PROVIDER=smtp` and a test of password reset and invitations end to end.
- [ ] Production secrets generated fresh (never reuse development values) and stored in a secret manager.
- [ ] Database not reachable from the internet; only the API host connects; `intuit_app` has no superuser rights.
- [ ] Backups scheduled, a restore drill done on production-like data (one dev-data drill exists, 2026-10-19), keys backed up separately.
- [ ] `pnpm audit --prod` shows no high or critical findings (CI runs it).
- [ ] The Owner and every administrator have two-step verification enrolled and recovery codes stored.
- [ ] The two real-TLS webhook tests (`webhooks-security.test.ts`) have been run on a machine without TLS interception.
- [ ] The security review of the webhook and Public API surface (ADR 0011 Step 7, WS3) is complete.

## 8. Release checklist

1. `pnpm verify` is green on the release commit (CI runs it).
2. `pnpm openapi:check -- --base-ref <previous release>` shows no breaking change, or the exception is recorded (`docs/openapi-compatibility.md`).
3. Migration list reviewed; none edits an applied migration.
4. Backup taken; deployment performed; `deploy/smoke.sh` passes; a manual walk through login, an invoice, a payment and the Trial Balance on the deployed instance.
5. Tag the release; record the image digests.

## 9. Known gaps (honest list)

- **Verified on disposable GitHub Actions runners (2026-10-21; not a deployment).** `.github/workflows/deploy-smoke.yml`, [run 39574210093](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39574210093) at `26391f3`: both images built; the fresh bootstrap and migration step passed; the health checks and `deploy/smoke.sh` passed; a missing `WEB_ORIGIN`, a short `SESSION_SECRET` and the mock e-mail provider under `APP_ENV=production` were each refused; forwarded-address spoofing: 61 requests with forged `X-Forwarded-For` values gave 429 x0 through a deliberately vulnerable nginx variant and 429 x31 (first at request 31) through the real `deploy/nginx.conf`; SMTP: the password-reset request returned 202 and the e-mail was captured by a Mailpit catcher on an internal-only network that has no outbound route; backup and restore: `deploy/backup.sh`, then `deploy/restore.sh` into a database that had 0 tables, then `deploy/restore-validate.mjs`: 225 tables restored, row counts equal on 225, 94 migration checksums equal, the journal, trial-balance, inventory and row-level-security checks passed, 214 RLS policies restored; an API started on the restored copy was healthy and answered from it (sign-in 200 for a user in the backup, 401 for a user created after the backup, 200 for that user on the original database). `.github/workflows/ci.yml`, [run 39574210127](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39574210127): green, including the 16 Playwright journeys and `pnpm audit --prod`.
- **Not verified by those runs:** TLS termination and HSTS, a real host name with `WEB_ORIGIN=https://…`, a load balancer in front of nginx, a real SMTP provider and S3 bucket, a container image scan, scheduled backups with off-site copies, a production-like restore (data volume, time to recover), key backup and rotation drills.
- A Playwright browser suite (`e2e/`, 16 journeys) runs in CI and passed in [run 39574210127](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39574210127). One earlier CI run ([run 39565353761](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39565353761), #6) failed once in `reversals.spec.ts` (a bill never showed "Posted" after Post); the cause is unknown, it did not recur, and no application or test change was made for it (`docs/known-flaky-tests.md`). Browser coverage is not complete (see the matrix row FP-20).
- The development machine has no container runtime (checked 2026-10-19), so the container stack is exercised only on GitHub Actions runners (above).
- The S3 adapter (`STORAGE_PROVIDER=s3`) has been verified only against the AWS signing test vector and an in-memory fake; run a real upload, download and purge against your bucket before relying on it. Local storage still limits the API to one instance.
- Load test: `deploy/loadtest.mjs` exists. One run on the development machine (single API process, local PostgreSQL, a new empty organization, 20 concurrent clients, 30 s, read endpoints only) gave about 600 requests per second, 0 errors, p95 of 54 ms at worst. That shows the read path and the script work; it is NOT capacity evidence (empty data, one machine, no writes, no reports). Run it against a production-like environment with realistic data before sizing anything. No penetration test.
