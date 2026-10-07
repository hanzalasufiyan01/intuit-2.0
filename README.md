# Intuit 2.0

Cloud accounting and business-management platform. The initial market is the Maldives; the core is country- and industry-independent.

> **Status:** Phases 1–4 are implemented: the foundation, the accounting core (chart of accounts, periods, the double-entry journal engine with configurable approvals, multi-currency, the general ledger, financial statements, dimensions, opening balances and foreign-currency revaluation), Sales and receivables, and Purchases and payables (vendors, bills, vendor credits and debit notes, payments, prepayments, refunds, batch Pay bills, direct expenses, AP reports, remittance advices, imports and exports). Banking (bank accounts, CSV and OFX statements, matching, bank entries, transfers, reconciliation and rules) follows. Inventory (weighted-average stock, cost of goods sold, adjustments, valuation) follows. Purchase orders with goods receiving and three-way matching follow. Fixed assets (register, straight-line depreciation, disposal, transfers) follow. Employee expense claims (posted as bills, reimbursed through the payment engine) follow. The public API and tax returns are not built yet; see [the integration plan](docs/integration-plan.md) and the decision records.

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
pnpm verify        # format:check + lint + typecheck + test + build
pnpm test          # all tests (API integration tests use the real intuit2_dev database)
pnpm lint
pnpm typecheck
pnpm build
```
