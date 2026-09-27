# Intuit 2.0

Cloud accounting and business-management platform. The initial market is the Maldives; the core is country- and industry-independent.

> **Status:** Phase 1 (Foundation) — repository structure initialized. Backend and frontend are not yet runnable. See [Current status](#current-status).

## Architecture

- **Modular monolith**: one Fastify backend with strict module boundaries, one PostgreSQL database, one React frontend.
- The accounting ledger is the single financial source of truth.
- Tenant isolation, authorization and audit are enforced on the server.

Read more:

- [Architecture overview](docs/architecture.md)
- [Module boundaries](docs/module-boundaries.md)
- [Phase 1 decisions](docs/decisions/0001-phase-1-foundation.md)

## Repository layout

```
apps/
  api/        Backend (Node.js, TypeScript, Fastify, Drizzle, PostgreSQL, Zod)
  web/        Frontend (React, TypeScript, Vite, React Router, TanStack Query)
packages/     Shared workspace packages (added as needed)
docs/         Architecture, conventions and decision records
```

## Prerequisites

- Node.js 22 (see `.nvmrc`)
- pnpm 10
- PostgreSQL 16 (a `docker-compose.yml` is provided for local development)

## Configuration

Copy `.env.example` to `.env` and fill in real values. The example file contains placeholders only. Environments: `development`, `testing`, `staging`, `production`.

## Local database

```sh
docker compose up -d postgres
```

## Current status

Phase 1 foundation is being built in small, reviewable commits. Setup, migration, test and API-convention instructions will be added here as each part lands.
