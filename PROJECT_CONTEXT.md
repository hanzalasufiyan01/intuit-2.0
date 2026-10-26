# Project context: Intuit 2.0

Snapshot of 2026-10-27 at `origin/main` `2652a64b96272d2bb22757b68319ec67cde15b73`. Read this first, then `RESUME.md` (how to continue) and `FINAL_HANDOVER.md` (state and blockers). Facts here were checked against the repository; each section names where to re-check.

## What it is

Intuit 2.0 is a cloud accounting and business-management platform: **multi-tenant, accounting-first, Maldives-first** (MVR base currency, Maldives chart template, GST-style tax codes) but country- and industry-independent in the core. It is built as a **modular monolith**: one backend, one PostgreSQL database, one React web app. It covers accounting, sales and purchases (documents, payments, credits, refunds), banking, inventory, fixed assets, expense claims, payroll (no statutory rules), projects (v1), a clinic extension, data import and export, a Public API with webhooks, an in-app help assistant with tutorials, and the access, audit and approval controls around them.

**It is not production-ready** (`docs/production-readiness-audit.md`). No real deployment exists; everything ran on a developer machine, throwaway databases and disposable CI runners.

## Sources of truth, in order

1. The code and the tests in this repository.
2. The master specification, `Intuit_Software_Clone_Master_Project_Context_v0.1.pdf` (sections 1 to 36). **The PDF is not stored in the repository**; its requirement-by-requirement audit is `docs/master-spec-coverage.md`.
3. `docs/remaining-scope.md` (prioritized scope with owner decisions), `docs/decisions/` (ADRs 0001 to 0015), `docs/open-points.md`, `docs/open-decisions.md`.
4. `docs/feature-completion-matrix.md` (this handover's area-level summary) and `docs/HANDOVER.md` (older, dated snapshots).

If documents disagree, the code and tests win; then the newest dated document.

## Stack

- Node 22.12 or newer (`.nvmrc` 22), pnpm 10.28 (monorepo, `pnpm-workspace.yaml`: `apps/*`, `packages/*`).
- API: Fastify 5, Drizzle, Zod, Vitest, pino logging. Web: React 19, Vite, TanStack Query, react-router, a typed message catalog (`useT`).
- PostgreSQL 16 with row-level security; two roles, `intuit_owner` (migrations) and `intuit_app` (runtime).
- Tests: Vitest (API and web), Playwright (browser journeys). CI: GitHub Actions (`ci.yml`, `deploy-smoke.yml`). Deployment files: `Dockerfile`, `deploy/` (compose, nginx, backup and restore scripts).

## Layout

- `apps/api/src`: `api/` (HTTP routes, `v1/*.routes.ts`, the Public API), `application/` (use-case services; 132 files), `domain/` (errors and shared domain types; the permission catalog is `application/permission-catalog.ts`), `modules/` (persistence per area), `database/` (migrations 0001 to 0096, `bootstrap.sql`, schema, CLIs), `infrastructure/` (config, security, providers), `shared/`.
- `apps/web/src`: `app/` (routes, providers), `features/` (one directory per area), `shared/ui`, `i18n/`, `auth/`, `services/`.
- `e2e/` (Playwright), `deploy/`, `docs/`, `.github/workflows/`. The workspace file also lists `packages/*`, which holds no package at this commit.

## Architecture rules that must not be broken

- The **ledger is the single source of truth**. Operational modules raise accounting events; they never write journals directly.
- **Tenant isolation** is enforced on the server (the client never supplies a trusted organization id) and by row-level security. Every tenant table needs an organization id, a policy and a test.
- **Posted records are immutable**: corrections are reversals, voids, credit notes or adjustments. Enforced by triggers, not only in code.
- Layers: routes, then application services, then modules, then the database. Transactions go through `withOrganization`.
- **Idempotency** (`Idempotency-Key`), the **append-only audit log** and the **permission catalog** (154 permissions) apply to every new write path.
- External services sit behind provider interfaces (e-mail, storage, payments, assistant) with mock or simulated providers by default.
- AI is assistive only: the help assistant is read-only and quotes three aggregate figures at most (`docs/assistant.md`).
- Migrations are forward-only and checksummed. Never edit an applied migration; the next number is 0097.

## Decisions and constraints worth knowing

- ADRs 0001 to 0015 in `docs/decisions/` record the module designs; ADR 0015 lists the reversible defaults chosen where the specification is silent, and `docs/remaining-scope.md` lists what still needs the owner.
- Registration is public by default (`REGISTRATION_MODE=open`); `code` and `closed` exist. The demo seed (`pnpm db:seed:demo`) writes only to a database named `intuit2_review`, refuses `APP_ENV=production` and port 5432, and is for network-restricted review environments only.
- English is complete; Dhivehi is blocked on a translator. Payroll has no statutory rules. Online payments are simulated.

## How the owner works (observed working agreements)

- Work is phase-gated: inspect, report, wait for approval before commits, pushes and anything outward-facing. Ask when something is ambiguous.
- Never push, merge or deploy without an explicit instruction. The owner opens pull requests in the browser (there is no `gh` CLI in the development environment) and merges them.
- Superuser database steps (creating clusters or roles) are done on a throwaway cluster, never on a personal or shared database. Report only what actually ran; distinguish verified from inferred.

## Current state in one paragraph

`main` is at `2652a64` after 13 merged pull requests. `pnpm verify` and the full Playwright suite pass locally against a throwaway database (API 1909 tests, web 829, browser 22 of 22). On GitHub, `deploy-smoke` passes; the post-merge `ci` run failed once in the Playwright step (cause unknown) and passed on re-run. Open blockers and risks: `docs/production-readiness-audit.md`.
