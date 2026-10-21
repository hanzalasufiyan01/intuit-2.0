# Handover: Intuit 2.0

Written 2026-10-19 so that someone who was not in the build can pick the project up. It states what exists, how to run and verify it, what is not done and what must be decided. It claims no production readiness. Where a fact can go stale, a command is given to re-check it.

## 1. Repository state

- **Branch:** `main`, at `58983e8` on `origin` (2026-10-21): the six commits below (`7a7bb4c`..`74add07`) and the CI fixes after them are pushed. The deployment smoke work (milestone M1: `c41f1e0`, `761de39`, `26391f3`) is on branch `m1-deploy-smoke`, pull request #1, not merged. Check with `git log --oneline origin/main` and `git status`.
- The six commits (approved 2026-10-20, pushed 2026-10-21): (1) migrations `0059`-`0094` (36 files, all new); (2) the API: the rest of `apps/api/` and `.env.example`; (3) the web app: `apps/web/` (features, English localization, tests); (4) root tooling and Playwright: `e2e/`, `playwright.config.ts`, `package.json`, `pnpm-lock.yaml`, `.gitignore`, `.prettierignore`; (5) ops and CI: `Dockerfile`, `.dockerignore`, `deploy/`, `.github/workflows/ci.yml`, `eslint.config.js`; (6) docs: `docs/` and `README.md`. The order matters: the API tests need the migrations, the root `openapi:check` script calls the API package's script, and CI runs `pnpm verify` and `pnpm e2e`. Finer splits are not possible without hunk staging because the work shares files (`app.ts`, `api/v1/index.ts`, the permission catalog, `messages.en.ts`).
- `.claude/` was never touched. `.env` is git-ignored and holds local secrets; do not commit it.
- **Stage files explicitly; do not use `git add -A` or `git add .`.** `.claude/` (local Claude Code settings such as `launch.json`) is now listed in `.gitignore`, but a blanket add can still pick up other local or generated files. Stage by path (for example `git add apps/api/src/database/migrations/0059_webhook_enabled_at.sql ...`), then check `git diff --cached --name-only` before committing: it must list no `.claude/` path and no `.env` file.
- Two PostgreSQL databases exist on the local server and **must not be cleaned up until the evidence below is reviewed**: `intuit2_dev` (about 11 GB of accumulated test data; the API tests create thousands of organizations in it) and `intuit2_restore_drill` (about 6 GB, the restored copy from the restore drill).

## 2. How to run it locally

Prerequisites: Node 22.12+, pnpm 10.28, PostgreSQL 16 as the native service on port 5432. Docker is not required.

```sh
pnpm install
cp .env.example .env        # replace every CHANGE_ME; see section 3
pnpm db:bootstrap           # once: roles intuit_owner / intuit_app and database intuit2_dev (needs the postgres password)
pnpm db:setup               # migrations (0001-0094) and reference-data seed
pnpm db:seed:dev            # optional example data (needs DEV_SEED_PASSWORD)
pnpm dev                    # API :3000, web http://localhost:5173
```

Register in the browser: the first user of an organization is the Owner and must enrol two-step verification (an authenticator app) before anything else is available.

Windows notes: use Git Bash. Options for `psql` must come BEFORE the connection string. Each API test file loads in several minutes because every file creates a real application context against the 11 GB database; run API suites in the background and do not edit `src/` or `test/` while a run is loading.

## 3. Environment variables

`.env.example` lists every variable with comments; `docs/development.md` explains them. The ones you must set:

| Variable                                                           | Meaning                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `APP_ENV`                                                          | `development`, `testing`, `staging` or `production`                   |
| `DATABASE_URL` / `DATABASE_MIGRATION_URL`                          | runtime role `intuit_app` / migration role `intuit_owner`             |
| `SESSION_SECRET`                                                   | 32+ random characters                                                 |
| `MFA_ENCRYPTION_KEYS`, `MFA_ENCRYPTION_ACTIVE_KEY_ID`              | encryption of authenticator secrets (`id:base64key`)                  |
| `WEBHOOK_ENCRYPTION_KEYS`, `WEBHOOK_ENCRYPTION_ACTIVE_KEY_ID`      | encryption of webhook signing secrets                                 |
| `WEB_ORIGIN`, `TRUST_PROXY`, `API_HOST`, `API_PORT`                | origin check, proxy trust, listen address                             |
| `EMAIL_PROVIDER` (`smtp` in production), `SMTP_*`, `EMAIL_FROM`    | outgoing mail; the server refuses the mock provider in production     |
| `STORAGE_PROVIDER` (`local` or `s3`), `STORAGE_LOCAL_ROOT`, `S3_*` | file storage; S3 adapter only tested against a fake store             |
| `METRICS_TOKEN`                                                    | enables `GET /api/v1/metrics` (disabled when unset)                   |
| `PAYMENTS_*`                                                       | online payments use a SIMULATED provider only; `live` mode is refused |

Back up the encryption keys and `SESSION_SECRET` separately from the database: without them MFA secrets and webhook secrets cannot be read.

## 4. Verification commands and the last results

| Command                                | What it runs                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm verify`                          | format check, lint, typecheck, OpenAPI contract check, all unit/integration tests, build |
| `pnpm test:api` / `pnpm test:web`      | API (vitest, real PostgreSQL) / web (vitest, jsdom)                                      |
| `pnpm openapi:check`                   | the public API contract against the committed baseline                                   |
| `pnpm e2e:install` then `pnpm e2e`     | Playwright smoke tests in Chromium against the real API and web server                   |
| `pnpm audit --prod --audit-level high` | dependency audit of production packages                                                  |
| `sh deploy/restore-drill.sh`           | dump a database, restore into an empty one, validate (see `docs/operations.md`)          |

Last recorded results (the matrix `docs/requirements-matrix.md` and `docs/security-review.md` hold dated detail):

- GitHub Actions, 2026-10-21 (pull request #1, branch `m1-deploy-smoke`, commit `26391f3`): `ci` [run 39574210127](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39574210127) green, including the 16 Playwright journeys and `pnpm audit --prod`; `deploy-smoke` [run 39574210093](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39574210093) green (evidence in `docs/operations.md` section 9). On the same pull request, `ci` [run 39565353761](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39565353761) (#6) failed once on a Playwright journey, cause unknown, not recurred (`docs/known-flaky-tests.md`). Earlier `ci` runs on `main` failed on and led to the fixes for the sign-in race, the shared job-queue claim, the time-zone test and the missing `WEB_ORIGIN`; run 39548171751 on `58983e8` was the first fully green one.
- `pnpm verify`: green on 2026-10-20 (run 18, in this session on a quiet machine, after the English localization pass was completed: format, lint, typecheck and the OpenAPI check passed; API 130 files, 1,780 passed, 4 skipped (1,784); web 56 files, 369 passed; API and web builds passed; only the large-chunk build warning; 33 min 29 s). Run 17 just before it exited 1 on the known web `app.test.tsx` sign-in flake (see `docs/known-flaky-tests.md`); that file then passed 10 of 10 times alone, and nothing was changed. Playwright 16/16 passed the same day after the localization changes. Earlier, run 16 ( run by the owner in their own terminal after the fixes below; the current tree with the R-02 expense trend export, migration 0094): reported results: format, lint, typecheck and the OpenAPI compatibility check passed; API 130 files passed, 1,784 tests; web 53 files passed, 351 tests; API and web builds passed; the existing Vite large-chunk warning remains. The output was not captured in this session, so the API pass/skip split is not confirmed: earlier runs had 1,784 API tests in total of which 4 real-TLS tests skip themselves, so this is most likely 1,780 passed and 4 skipped.
- Before run 16, runs 12 to 15 on 2026-10-20 exited 1. Run 12: three export tests waited behind about 200 document-PDF jobs left in the shared job queue by earlier test files (fixed: `exports.test.ts` now processes already-due jobs first; the file passes 16/16 alone). Run 13: 61 timeouts across 25 files while the machine was busy (Zoom and other programs running; run took 3,182 s instead of about 1,200 s). Run 14: one latent flake in the public-API rate-limit test, whose three counted requests could straddle a one-minute window (fixed: the test aligns its clock to a fresh window; its assertions are unchanged). Run 15: one web test (`app.test.tsx`) failed under the same machine load; it passes 3/3 alone. Run 16 (above) was the clean full run.
- `pnpm verify`: exit 0 on 2026-10-20 (run 11, after R-03 purchase suggestions: API 130 files, 1776 passed, 4 skipped; web 53 files, 350 passed; OpenAPI check and build included; only the large-chunk build warning). Playwright was not re-run for R-03 (no journey visits the inventory pages; last result 16/16 before run 10). Earlier, run 10 ( after R-05 paid-document reversal coverage: API 129 files, 1767 passed, 4 skipped; web 52 files, 344 passed; OpenAPI check and build included; only the large-chunk build warning). Playwright 16/16 passed before it (new: `reversals.spec.ts`, 3 journeys). Earlier, run 9 ( current tree with R-04 and the R-02 expense trend: API 128 files, 1763 passed, 4 skipped; web 52 files, 344 passed; OpenAPI check and build included; only the large-chunk build warning). Run 8 the same day exited 1 on one failure in a new R-04 test that asserted a fixed order for two audit events written at the same instant (uuid tie-break is random); the test now compares them as a set. Earlier, run 7 ( after R-04 employee-claim expense policies: API 127 files, 1757 passed, 4 skipped; web 51 files, 339 passed; OpenAPI check and build included; only the large-chunk build warning). Playwright 13/13 passed the same day before the run. Earlier, run 6 (after the audit-query scoping; API 127 files, 1750 passed, 4 skipped; web 51 files, 336 passed; only the large-chunk build warning). Before it, the 11 touched test files passed together (11 files, 230 tests) and `webhooks.test.ts` alone passed (66 tests). Earlier run 5 on 2026-10-19: API 127 files, 1750 passed, 4 skipped; web 51 files, 336 passed; format, lint, typecheck, OpenAPI check and build included; the only build warning is the large-chunk notice. Runs 2, 3 and 4 the same day exited 1 with 30-second timeouts (three tests, then `api-integrations` audit identity, then `public-events`); each passed alone in 1-3 s. Two causes were found and fixed: (1) `api-integrations.test.ts` read `audit_events` by `resource_id` without `organization_id`, a sequential scan of about 4 M rows (now scoped, 1.2 s); (2) the API project ran about 27 parallel workers against one local PostgreSQL, so a different test timed out on most runs; `apps/api/vitest.config.ts` now sets `maxWorkers: 8` (whole API suite 713 s instead of about 1,400 s). Five consecutive full-suite results are not yet available, so treat flakiness as improved, not proven gone. Audit-query review 2026-10-20: of 24 further `audit_events` statements without an organization filter, 21 are now scoped by organization (the webhook ones through a primary-key sub-select with explicit `::uuid` and `::text` casts) and 3 stay unscoped on purpose: `database.test.ts` `DELETE FROM audit_events` (a security test that the runtime role is refused, so there is no row to scope to), `mfa.test.ts` (a deliberately global scan of every audit row of the last day to prove no secret was written anywhere, so scoping would weaken it) and the `DELETE ... WHERE id = $1` in `service-principals.test.ts` (a security test that history cannot be deleted, addressed by primary key). The `service-principals` lookup of its `'visible'` row is now scoped to the fixture's own organization, so it can no longer pick another run's row.
- Playwright: 13/13 passed locally on 2026-10-19: the accounting, sales and purchases journeys (`e2e/accounting.spec.ts`, `sales.spec.ts`, `purchases.spec.ts`: post, collect or pay in part, check the trial balance), `aging.spec.ts`, `void.spec.ts`, `isolation.spec.ts` (aging buckets, void/reversal, cross-tenant reads) and `e2e/smoke.spec.ts` (registration with two-step enrolment, navigation, sign-out, wrong password, sign-in with the authenticator code, redirect, branch access and entity-group pages).
- Restore drill: passed on the development database on 2026-10-19 (211 tables, counts, checksums, policies, balanced journals, fingerprint, inventory levels). Not production evidence.
- Skipped automatically: 4 real-TLS tests (webhook transport and SMTP) skip themselves when `tlsUsable()` fails; here local antivirus intercepts TLS. Nothing needs un-skipping: on a clean runner they execute. **Run `pnpm test` on a clean machine or CI before trusting those paths.**

## 5. Migration status

94 forward-only migrations, `0001` to `0094`, in `apps/api/src/database/migrations/`. Applied migrations are checksum-protected and are never edited: fix with a new migration. Every new migration must be added to the registry in `apps/api/test/s2-fixes.test.ts` and to the table in `docs/integration-plan.md` (next free number: **0095**).

Recent ones: 0084 branch access, 0085 entity groups, 0086 clinic consent/retention, 0087 tax treatment, 0088 classification (groups, custom fields, categories, barcodes), 0089 payroll one-off amounts, 0090 variants and bins, 0091 delivery notes and reservations, 0092 expense policies, 0093 petty cash, 0094 expense trend export domain.

## 6. Architecture in one page

Modular monolith: Fastify API (`apps/api`), React/Vite web (`apps/web`), one PostgreSQL database. Row-level security on every tenant table with `app_current_organization_id()`; the runtime role cannot alter audit history. The ledger is the only financial source of truth: operational documents emit accounting events that become journals (`docs/architecture.md`, `docs/module-boundaries.md`). Patterns to follow when adding features:

- Services use `withOrganization(deps, principal, {permission, sensitive, readOnlySnapshot, module}, work)`; mutating requests are idempotent through `IdempotencyService` where a retry is plausible; every sensitive action writes an audit event without personal data or amounts.
- New side-table features (classification, variants, delivery, policies) deliberately do not touch frozen module tables; see ADR 0015.
- Web pages use `useT()` (message catalog) and `usePermission`; a ratchet test (`apps/web/test/i18n-coverage.test.ts`) fails if a new page lacks the catalog.

## 7. Deployment

`Dockerfile`, `deploy/docker-compose.prod.yml`, `deploy/nginx.conf`, `deploy/backup.sh`, `deploy/restore.sh`, `deploy/smoke.sh`, `.github/workflows/ci.yml` and the runbook `docs/operations.md`. **Verified on disposable GitHub Actions runners only (2026-10-21), never deployed:** CI [run 39574210127](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39574210127) is green including Playwright and `pnpm audit --prod`; the deployment smoke workflow `.github/workflows/deploy-smoke.yml` [run 39574210093](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39574210093) builds both images and proves a fresh bootstrap, migrations, health and smoke checks, configuration refusals, forwarded-address rate limiting, SMTP into a sandbox, and backup and restore into an empty database served by a restored API (results in `docs/operations.md` section 9). The development machine still has no container runtime. A real deployment (TLS, host, SMTP, S3) and a production-like restore remain. Production checklist: `docs/operations.md` section 7 and `docs/security-review.md`.

## 8. What is complete, partial, blocked

The authoritative lists are `docs/requirements-matrix.md` (finishing plan, FP-nn rows) and `docs/master-spec-coverage.md` (every bullet of the master specification). Summary:

- **Complete and tested:** auth/MFA/RBAC/tenancy/audit; accounting core and statements; sales, purchases, banking, inventory (average cost, warehouses, lots/serials, landed cost, units, bundles, counts, returns); purchase orders, fixed assets (straight-line), expense claims; public API and webhooks; payroll (components, runs, salary history, leave, advances, payslips, one-off amounts, register); projects; clinic administrative/billing/consent/retention; customer portal v1 (statement links), simulated payment gateway; branch access, entity groups; tax treatment; classification; delivery/reservations; expense policies; petty cash.
- **Partial:** localization (infrastructure done and English extraction complete on 2026-10-20: 99 of 100 pages use the catalog, the last one, `SalesSection.tsx`, renders no text; 3,437 English catalog keys; 0 Dhivehi on purpose: no qualified translator yet; translator notes and the strings kept in English on purpose are in `docs/design/localization.md`); management reports; clinic (no scheduling extras or clinical records); several master-spec rows listed there.
- **Blocked on outside input:** every MIRA-dependent item (return layout, rates, withholding), statutory payroll rules, a real payment provider, real e-mail/S3 credentials, bank feeds/OCR/SMS providers, customer/vendor portal sign-in, Dhivehi translation (needs a qualified translator).
- **Verified only on disposable CI runners:** container build and stack, CI (`docs/operations.md` section 9). **Not executed anywhere:** clean-environment TLS tests, production-scale restore, penetration test, write-path load test, a real deployment.

## 9. Decisions still needed from the owner

The exact questions, with a suggested default for each, are in `docs/open-decisions.md` (section "Master specification: decisions needed from the owner") and the ADR 0015 table. Highest impact first: (1) MIRA rules and the tax return layout; (2) statutory payroll rules; (3) approval gating for exports and permission changes; (4) compound and multiple taxes; (5) which fixed-asset depreciation methods; (6) clinical records scope and retention period/consent wording values; (7) consolidation rules; (8) real providers (payments, e-mail, storage, bank feeds); (9) portal sign-in; (10) named role templates, employment types, attendance.

## 10. Exact remaining requirements (from `docs/master-spec-coverage.md`)

NOT DONE or NEEDS DECISION, in priority order:

1. MIRA-dependent: tax return data and reconciliation, tax types governed list, compound/multiple taxes, withholding, rounding rules, branch/entity tax applicability.
2. Payroll: statutory rules, employment types, attendance, payout through a provider, payslip e-mail with the PDF (consent decision).
3. Approvals for data exports and permission changes.
4. Expense policies for employee expense claims; expense trend report; custom fields beyond customers; required custom fields.
5. Fixed assets: other depreciation methods, impairment, write-off, improvements, maintenance history.
6. Clinic: availability, rooms, recurring appointments, reminders, clinical records (new ADR), patient custom fields.
7. Inventory: FIFO (new ADR), stock per bin (new ADR), blocking reservations, per-warehouse cost.
8. Providers: bank feeds, OCR, SMS, real payment provider, customer/vendor portal sign-in, vendor portal.
9. Localization: convert the remaining pages to the catalog, server messages/e-mails/PDF text, Thaana font, translator and reviewer, then approve the locale.
10. Operations: a real deployment (TLS and HSTS, host, SMTP, S3), clean-environment TLS tests, production-like restore drill, penetration test, write-path load test, browser tests for credit notes, customer refunds, vendor credits, a role-restricted second user and the password re-confirmation prompt (API tests cover the permission and re-confirmation rules).

## 11. Where things are

| Need                                 | File                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Status per finishing-plan item       | `docs/requirements-matrix.md`                                                              |
| Status per master-spec bullet        | `docs/master-spec-coverage.md`                                                             |
| What is unresolved and why           | `docs/open-decisions.md`, `docs/known-limitations.md`                                      |
| Reversible defaults and how to undo  | `docs/decisions/0015-completion-defaults.md`                                               |
| Operations runbook                   | `docs/operations.md`                                                                       |
| Security findings                    | `docs/security-review.md`, `docs/security.md`                                              |
| Migration numbers and file ownership | `docs/integration-plan.md`                                                                 |
| Design notes per module              | `docs/design/*.md` (payroll, clinic, branches, inventory, portal, localization)            |
| Specification                        | `Downloads/Intuit_Software_Clone_Master_Project_Context_v0.1.pdf` (outside the repository) |
