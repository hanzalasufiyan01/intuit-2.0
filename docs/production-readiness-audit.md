# Production readiness audit (read-only), 2026-10-27

Audit of `origin/main` `2652a64b96272d2bb22757b68319ec67cde15b73`, made by reading the repository documents, scripts, migrations and CI, plus the full verification run described in `testing.md`. **It is an internal review, not a penetration test or an external audit. Intuit 2.0 is NOT production-ready.** Every item marks what is `Verified` (read in code or run) and what is `Unknown` (no evidence). Missing evidence is treated as not done.

## Verdict

The code-level controls (double-entry, immutability, tenant isolation, audit trail) are implemented and tested. The operational layer (real host, TLS, scheduled and off-site backups, alerting, error reporting, real providers) has never run outside a developer machine, throwaway databases and disposable GitHub Actions runners.

## P0: blockers for any real go-live

| #   | Finding                                           | Status             | Evidence                                                                                                                                                                                                                                          | Action                                                                          |
| --- | ------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | No real deployment exists                         | Unknown            | `operations.md` section 9 lists as not verified: TLS and HSTS, a real host name, a load balancer, a real SMTP provider, a real S3 bucket, a container image scan. The section 7 go-live checklist has no ticked box.                              | A staging deployment on a real host, then the section 7 checklist.              |
| 2   | Backups are not production-grade                  | Verified gap       | `deploy/backup.sh` writes an unencrypted `pg_dump` custom-format file, checks it with `pg_restore --list` and keeps 14 days. It has no encryption, no off-site copy and no scheduler. Point-in-time recovery is stated to be a platform decision. | Scheduled, encrypted, off-site backups; decide on WAL archiving.                |
| 3   | Restore only drilled on development data          | Verified, limited  | Drill of 2026-10-19 (1 GB of development data, 211 tables, counts, checksums and balances equal) and a small drill in `deploy-smoke`. No production volume, no time to recover (R-53).                                                            | Repeat on production-like data and record the time to recover.                  |
| 4   | Rollback is restore-only                          | Verified by design | `operations.md` section 4: migrations are forward-only and not reversible; a rollback after a migration is a restore of the pre-upgrade backup.                                                                                                   | Settle item 3 first; write the release procedure with a measured recovery time. |
| 5   | Encryption keys have no tested backup or rotation | Unknown            | `MFA_ENCRYPTION_KEYS` and `WEBHOOK_ENCRYPTION_KEYS` must be backed up separately or the secrets cannot be read. A key-rotation module exists (`mfa-key-rotation.ts`); no drill is recorded.                                                       | A documented key-backup procedure and a rotation drill.                         |

## P1: serious gaps before real users

| #   | Finding                                          | Status       | Evidence                                                                                                                                                                                                                                                                     | Action                                                                                                     |
| --- | ------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 6   | No error reporting or alerting                   | Verified gap | No Sentry, OpenTelemetry or APM library in `apps/api/package.json`. `/api/v1/health` and the token-protected `/api/v1/metrics` exist; the alert list in `operations.md` section 6 is a suggestion only.                                                                      | Choose and connect an error-reporting and alerting service (owner decision).                               |
| 7   | CI Playwright step fails without explanation     | Verified     | See "Unexplained Playwright failures" below. `retries: 0`, so a single intermittent failure turns `main` red.                                                                                                                                                                | Make failures self-diagnosing; retrieve the attempt-1 artifact.                                            |
| 8   | S3 and SMTP only verified against fakes          | Verified gap | S3 adapter: AWS signing test vector and an in-memory store. SMTP: a Mailpit catcher. Four real-TLS tests skip on the dev machine (R-52).                                                                                                                                     | A real upload, download and purge; a real password-reset e-mail.                                           |
| 9   | Nine known advisories in production dependencies | Verified     | `pnpm audit --prod` on 2026-10-26: 5 low, 4 moderate, none high; all through `fastify` and `@fastify/ajv-compiler`. See "Dependency advisories". The CI gate is `--audit-level high`, so it stays green. `security-review.md` said "no known vulnerabilities" on 2026-10-17. | Update `fastify` and `fast-uri`; refresh `security-review.md`; decide whether the CI gate should be lower. |
| 10  | No image scan, dependency bot or code scanning   | Verified gap | `.github/` holds only `ci.yml` and `deploy-smoke.yml`; no `dependabot.yml`, no CodeQL, no container scan. No penetration test, fuzzing or external audit.                                                                                                                    | Add them; commission an external review before real tenants' data.                                         |
| 11  | TLS and web hardening headers not defined        | Verified gap | `deploy/nginx.conf` listens on port 80 and sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy`. No HSTS and no Content-Security-Policy for the web app; TLS is assumed to terminate in front.                                       | Decide TLS termination, HSTS and a CSP.                                                                    |
| 12  | Single API instance                              | Verified     | Local file store is not shared; `operations.md` section 1 says to scale vertically or share the volume.                                                                                                                                                                      | Acceptable for a pilot; plan shared storage before scaling out.                                            |

## P2: should fix

| #   | Finding                                             | Status   | Evidence                                                                                                                                                                                                                  | Action                                                                                  |
| --- | --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 13  | Registration is public by default                   | Verified | `REGISTRATION_MODE` defaults to `open`. The `code` and `closed` modes are built and proven in the compose stack by `deploy-smoke` (`review-port` job).                                                                    | Set `closed` or `code` and a network gate for any private or review environment.        |
| 14  | The demo seed relies on an operator statement       | Verified | It refuses `APP_ENV=production`, any database but `intuit2_review`, port 5432, and protected names. The override `APP_ENV=staging` is the operator saying it is a review environment. It cannot tell if real data exists. | Use only in network-restricted review environments; rotate the shared demo credentials. |
| 15  | Row-level security is `ENABLE` without `FORCE`      | Verified | 77 `ENABLE ROW LEVEL SECURITY` and 85 `CREATE POLICY` statements, 0 `FORCE`. The owner role bypasses RLS; it must be used only for migrations.                                                                            | Confirm that no runtime path uses `DATABASE_MIGRATION_URL`; consider `FORCE`.           |
| 16  | Load and rate limits untested under real conditions | Unknown  | One read-only load run on a development machine (about 600 requests per second, empty data). No write path and no authentication limit was load tested (R-54).                                                            | Run `deploy/loadtest.mjs` and a write-path test against production-like data.           |

## P3: enhancements

17. Remaining product scope: see `feature-completion-matrix.md` and `remaining-scope.md` (19 owner decisions, 7 items blocked on outside input, 4 deferred).
18. Localization cleanup (customer refund pages, expense claims, assets, data exchange use literal English) in `open-points.md`.
19. The Anthropic assistant adapter is unverified against a real provider (`assistant.md`).

## Controls verified in code and tests

- **Double entry:** a database check requires balanced original and base totals and a non-zero total on posting; one side only per line (`0002_phase2_accounting.sql`).
- **Immutability:** posted journals and lines are immutable by trigger ("posted journal % is immutable"); only posted journals can be reversed.
- **Periods:** posting requires an open period inside a fiscal year (`journal-service.ts`, `accounting-service.ts`).
- **Precision:** money columns are `numeric(28,4)`, `(28,6)` and `(28,10)`; the few `double precision` uses are metrics counters.
- **Idempotency:** a reusable store (`0019_idempotency_keys.sql`) and use in 52 source files.
- **Audit:** `audit_events` is append-only by trigger and has no truncate; the runtime role has only `SELECT, INSERT`; an actor-verification trigger covers API tokens.
- **Tenant isolation:** row-level security with `app_current_organization_id()` and per-organization policies; an end-to-end isolation journey (`e2e/isolation.spec.ts`) and permission suites per module.
- **Sessions:** httpOnly, Secure (production), SameSite cookies, CSRF handling, MFA with step-up and recovery codes.

## Unexplained Playwright failures (do not treat as fixed)

- **`ci` run 40366991696 on `2652a64`, attempt 1: FAILED** (2026-10-26, 11m 8s) in step 16, "Browser end-to-end smoke tests (Playwright)". All earlier steps passed. The run has a failure artifact `playwright-failure-40366991696-1` (84,160 bytes, expires 2026-11-02). **The failing test, assertion and values are not known**: logs and artifact need a GitHub sign-in that was not available. Attempt 2 later **passed**, which does not explain attempt 1.
- **`accounting.spec.ts:11`** failed in `ci` run 40279914371 (2026-10-26). It did not reproduce in 15 local runs.
- Earlier unexplained failures are recorded in `known-flaky-tests.md`: `reversals.spec.ts` "Posted" (run 39565353761), runs #15 and #16, and `restricted-user.spec.ts:32` (run #21, reported only).
- The one failure that was reproduced and fixed is the refund-link layout shift (PR #13, commit `acaa571`): the refund link moved when the refund list finished loading, so a click landed on the card.
- **To diagnose attempt 1:** sign in to GitHub, open the run, download `playwright-failure-40366991696-1` and read `error-context.md`, or open step 16's log and copy the failure block.

## Dependency advisories (`pnpm audit --prod`, 2026-10-26: 9 found, 5 low and 4 moderate)

| Severity | Package    | Vulnerable       | Patched  | Via                                     |
| -------- | ---------- | ---------------- | -------- | --------------------------------------- |
| low      | `fastify`  | >=5.12.2 <5.12.6 | >=5.12.6 | `apps/api`                              |
| moderate | `fast-uri` | >=4.0.0 <4.2.3   | >=4.2.3  | `fastify > @fastify/ajv-compiler`       |
| moderate | `fast-uri` | >=3.0.0 <3.1.9   | >=3.1.9  | `fastify > @fastify/ajv-compiler > ajv` |
| low      | `fast-uri` | >=4.0.0 <4.2.3   | >=4.2.3  | same (path equivalence)                 |
| low      | `fast-uri` | >=3.0.0 <3.1.9   | >=3.1.9  | same (path equivalence)                 |
| moderate | `fast-uri` | >=4.0.1 <4.2.3   | >=4.2.3  | same (host confusion)                   |
| moderate | `fast-uri` | >=3.1.3 <3.1.9   | >=3.1.9  | same (host confusion)                   |
| low      | `fast-uri` | >=4.0.0 <4.2.3   | >=4.2.3  | same (scheme injection)                 |
| low      | `fast-uri` | >=3.0.0 <3.1.9   | >=3.1.9  | same (scheme injection)                 |

Not fixed in this handover (a dependency change is outside its scope).

## Recommended next task

Make CI Playwright failures self-diagnosing (a failure summary in the job log and the failing test names in the artifact), because unexplained red runs cost more than any single item above. Files: `.github/workflows/ci.yml` and `playwright.config.ts`. Test plan: confirm locally that a deliberately failing spec produces the summary and artifact and that a passing run is unchanged.
