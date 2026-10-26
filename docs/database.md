# Database

PostgreSQL 16. Everything in this file was read from `apps/api/src/database/` (the migrations, `bootstrap.sql`, the migrator) on `origin/main` `2652a64`; it was not run against a production database.

## Roles and bootstrap

- Two login roles: `intuit_owner` (runs migrations; owns the tables) and `intuit_app` (the runtime role; no superuser, no `BYPASSRLS`, no `CREATEROLE`). A fresh cluster is prepared by `apps/api/src/database/bootstrap.sql`, which creates both roles and the database. The deployment smoke job checks the roles are `intuit_app:000` and `intuit_owner:000` (superuser, bypass-RLS and create-role flags all off).
- `bootstrap.sql` sets the passwords of those two roles. **Never run it against a cluster whose roles are shared with another database**, because it resets their passwords. Use a throwaway cluster for tests (see `testing.md`).
- The API connects with `DATABASE_URL` (`intuit_app`). The migrator uses `DATABASE_MIGRATION_URL` (`intuit_owner`). Nothing at runtime should use the owner URL: the owner role is not subject to row-level security.
- For compose, `deploy/postgres-init/10-intuit-bootstrap.sh` runs the same `bootstrap.sql` on the first start of an EMPTY data volume. The port is `INTUIT_DB_PORT` (default 5432; a review environment uses 5433, which the demo seed requires).

## Migrations

- 96 files, `0001_phase1_foundation.sql` to `0096_tutorial_progress.sql`; the next free number is **0097**. They are forward-only and additive. The migrator (`migrator.ts`) records a checksum for each applied file and refuses to start if an applied file changed, so never edit an applied migration; add a new one.
- Run with `pnpm db:setup` (migrate and seed reference data: 154 permissions, 3 role templates, 5 chart-of-accounts templates) or, compiled, `node dist/src/database/cli/migrate.js` then `seed.js`.
- Rollback is a restore from backup (`operations.md` section 4). There are no down migrations.
- Applying a migration to a database is an operator action on that database. Being present in Git says nothing about any database.

## Tenant isolation (row-level security)

- Tenant data carries an organization id. The migrations contain 77 `ENABLE ROW LEVEL SECURITY` statements and 85 `CREATE POLICY` statements; there is no `FORCE ROW LEVEL SECURITY`, so the table owner bypasses the policies. A restore drill on 2026-10-19 counted 211 tables, 196 with row-level security and 200 policies on the development database at that time.
- The application sets the organization and the user for each transaction (`withOrganization`) and the policies read them through `app_current_organization_id()` and `app_current_user_id()`.
- Evidence: per-module permission suites and cross-organization tests in `apps/api/test`, and `e2e/isolation.spec.ts`. Nothing tests every table for isolation automatically; treat a new table as unprotected until its policy and a test exist.

## Accounting integrity enforced by the database

- A journal can become `POSTED` only when it balances (original and base totals), has at least two valid lines and is dated inside an open period. Posted journals and lines are immutable by trigger, and only posted journals can be reversed (`0002_phase2_accounting.sql`, `0006_journal_fx_lines_source_refs.sql`).
- A line has either a debit or a credit, never both.
- Money columns are `numeric(28,4)` (227 columns), `numeric(28,6)` (51) and `numeric(28,10)` (25, rates). There is no floating-point money column; the `double precision` uses are metrics counters.
- `audit_events` and `security_events` are append-only: a trigger blocks update and delete, another blocks truncate, and `intuit_app` has only `SELECT` and `INSERT`. A further trigger verifies the actor of API-token events.
- Request idempotency: the `idempotency_keys` table (`0019`) lets a client retry safely with an `Idempotency-Key`.

## Conventions for a new migration

1. New number, descriptive name, forward-only SQL.
2. A new tenant table needs an organization id, `ENABLE ROW LEVEL SECURITY`, a policy, grants for `intuit_app` that match its needs, and a test that another organization cannot read it.
3. Anything that must not change after the fact (final records) is enforced by a trigger, not only by the application.
4. Update the schema in `schema.ts` and run `pnpm openapi:check` if an API shape changes.
