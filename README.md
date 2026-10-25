# Intuit 2.0

Cloud accounting and business-management platform. The initial market is the Maldives; the core is country- and industry-independent.

> **Status (2026-10-21):** much of the original product scope is implemented and tested (full `pnpm verify` green locally, run 18; CI green on GitHub). `main` is at `58983e8` on `origin`; the deployment smoke work (milestone M1, up to `26391f3`) is on branch `m1-deploy-smoke` in pull request #1, open and not merged. The container stack has been verified only on disposable CI runners: nothing is deployed and no production readiness is claimed. Read [the handover](docs/HANDOVER.md) first, then [the requirements matrix](docs/requirements-matrix.md), [master-specification coverage](docs/master-spec-coverage.md) and [open decisions](docs/open-decisions.md). Older phase notes below are kept for history.

## Architecture

- **Modular monolith**: one Fastify backend with strict module boundaries, one PostgreSQL database, one React frontend.
- The accounting module (Phase 2) is the single financial source of truth. The general ledger is derived from posted journal lines only.
- Tenant isolation, authorization and audit are enforced on the server. PostgreSQL Row-Level Security is a second line of defence.

Read more:

- [Architecture overview](docs/architecture.md)
- [Local development](docs/development.md)
- [Security architecture](docs/security.md)
- [API conventions](docs/api.md)
- [Module boundaries](docs/module-boundaries.md)
- [Phase 1 decisions](docs/decisions/0001-phase-1-foundation.md)
- [Phase 2 decisions](docs/decisions/0002-phase-2-accounting.md)
- [Phase 3 decisions](docs/decisions/0003-phase-3-sales-receivables.md)
- [Phase 4 decisions](docs/decisions/0004-phase-4-purchases-payables.md)
- [Banking decisions](docs/decisions/0005-banking.md)
- [Inventory decisions](docs/decisions/0006-inventory.md)
- [Purchase order decisions](docs/decisions/0007-purchase-orders.md)
- [Fixed asset decisions](docs/decisions/0008-fixed-assets.md)
- [Expense claim decisions](docs/decisions/0009-expense-claims.md)
- [Customer refund decisions](docs/decisions/0010-customer-refunds.md)
- [Public API and webhooks — proposal for review](docs/decisions/0011-public-api-and-webhooks-proposal.md)
- [Open points and recorded decisions](docs/open-points.md), [known flaky tests](docs/known-flaky-tests.md)
- [Integration plan](docs/integration-plan.md) (migration numbers and shared-file ownership)

## Repository layout

```
apps/
  api/        Backend (Node.js, TypeScript, Fastify, Drizzle, PostgreSQL, Zod)
  web/        Frontend (React, TypeScript, Vite, React Router, TanStack Query)
packages/     Shared workspace packages (added as needed)
docs/         Architecture, conventions and decision records
```

## Quick start

Prerequisites: Node.js 22.12+, pnpm 10.28, and PostgreSQL 16 running as the native local service on port 5432.

```sh
pnpm install
cp .env.example .env          # then replace every CHANGE_ME value
pnpm db:bootstrap             # one time: creates roles intuit_owner/intuit_app and database intuit2_dev (prompts for the postgres password)
pnpm db:setup                 # migrations + reference-data seed
pnpm db:seed:dev              # optional: example organization, users and journals (needs DEV_SEED_PASSWORD)
pnpm dev                      # API on :3000, web app on http://localhost:5173
```

See [docs/development.md](docs/development.md) for details on each step, the environment variables and the database roles.

## Common commands

```sh
pnpm verify        # format:check + lint + typecheck + openapi:check + test + build
pnpm test          # all tests (API integration tests use the database named by DATABASE_URL, see below)
pnpm lint
pnpm typecheck
pnpm build
```

> **Before running any API test or `pnpm db:*` command:** API test runs apply every pending migration and the seed to whichever database `DATABASE_URL` / `DATABASE_MIGRATION_URL` name (the environment, or the repository-root `.env`), and the tests then add data that is never cleaned up. Use an isolated, disposable PostgreSQL server for them, never a database you want to keep. See `docs/HANDOVER.md` section 0 ("Safe test environment") and `docs/development.md` ("Tests").
