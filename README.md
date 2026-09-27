# Intuit 2.0

Cloud accounting and business-management platform. The initial market is the Maldives; the core is country- and industry-independent.

> **Status:** Phase 1 (Foundation) and Phase 2 (Accounting Foundation & General Ledger) are implemented. Phase 2 adds the chart of accounts, fiscal years and periods, the double-entry journal engine with configurable approvals, posting and reversal, multi-currency, accounting events and the general ledger. There are no operational business modules yet (invoicing, expenses, banking and so on).

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
pnpm verify        # format:check + lint + typecheck + test + build
pnpm test          # all tests (API integration tests use the real intuit2_dev database)
pnpm lint
pnpm typecheck
pnpm build
```
