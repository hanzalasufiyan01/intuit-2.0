# Architecture Overview

Intuit 2.0 is a cloud accounting and business-management platform built as a **modular monolith**: one deployable backend with strict internal module boundaries, one PostgreSQL database, and a React frontend.

## Request flow

```
Frontend (React)
  → API (Fastify, /api/v1)
    → Application / use cases
      → Domain services
        → Persistence (Drizzle)
          → PostgreSQL
```

Every protected request passes through:

```
Authentication → Organization membership → Roles → Permissions → Resource/scope authorization
```

## Core principles

- **The accounting ledger is the single financial source of truth.** Operational modules produce accounting events; they never write to the ledger directly.
- **Tenant isolation is enforced on the server.** The client never supplies a trusted `organization_id`. PostgreSQL Row-Level Security is the second layer of defence (see [security](security.md)).
- **Posted financial records are immutable.** Corrections use void, reversal, credit notes or adjustments.
- **The core is country-independent.** Tax, fiscal and statutory rules live in localization modules.
- **The core is industry-independent.** Industry extensions (for example, clinics) consume shared platform services.
- **External services sit behind provider interfaces** (email, payments, bank feeds, OCR, storage, SMS), with mock providers in development.
- **AI is assistive only.** It never posts entries, changes records, tax rules or permissions, or touches audit history.

## Internal events (transactional outbox)

Business transactions write an outbox event in the same database transaction, through `enqueueOutboxEvent(tx, ...)`. The event exists if and only if the business change commits. No external message broker is used.

`outbox_events` holds:

- the event ID and type
- the aggregate type and ID
- the organization (optional)
- a JSON payload, which must never contain secrets
- status: `pending` → `processing` → `processed`, or `failed`
- retry metadata: `attempts`, `max_attempts`, `available_at`, `last_error`, `locked_at` / `locked_by`
- `created_at` and `processed_at`

The `OutboxDispatcher` runs inside the API process and polls every `OUTBOX_POLL_INTERVAL_MS`. Each cycle:

1. It claims due events with `FOR UPDATE SKIP LOCKED`, so several workers are safe.
2. It invokes the subscribers registered for the event type.
3. On success it marks the event `processed`.
4. On failure it schedules a retry with exponential back-off (5 s base, capped at 15 minutes).
5. Once `max_attempts` is exhausted, it marks the event `failed`.

Events whose worker died mid-processing are reclaimed after a lock timeout.

Phase 1 emits events such as:

- `identity.user_registered`
- `identity.password_changed`
- `organizations.organization_created`
- `organizations.invitation_created`
- `organizations.member_joined`
- `organizations.membership_roles_changed`
- `organizations.membership_status_changed`
- `access_control.role_created` / `_updated` / `_deleted`

Phase 1 registers no subscribers yet. Later phases add consumers such as notifications and projections.

Emails that contain one-time links (password reset, invitation) are sent directly after commit, not through the outbox. That keeps raw tokens out of persisted payloads.

## Documentation

- [Local development](development.md): setup, PostgreSQL, environment, migrations, commands, tests
- [Security architecture](security.md): authentication, sessions, CSRF, authorization/RBAC, RLS, audit, logging
- [API conventions](api.md): versioning, envelopes, errors, endpoints
- [Module boundaries](module-boundaries.md)
- Decisions: [ADR 0001 (Phase 1)](decisions/0001-phase-1-foundation.md), [ADR 0002 (Phase 2)](decisions/0002-phase-2-accounting.md), [ADR 0003 (Phase 3)](decisions/0003-phase-3-sales-receivables.md), [ADR 0004 (Phase 4)](decisions/0004-phase-4-purchases-payables.md)

## Accounting (Phase 2)

```
Operational module --(accounting event, idempotent)--+
Manual journal (UI/API) -----------------------------+
                                                     v
                 Journal engine: DRAFT -> PENDING_APPROVAL -> POSTED -> REVERSED
                 (double-entry validation, approvals, atomic posting)
                                                     v
                 Journal lines (posted, immutable) --> General Ledger (query view)
```

- **Accounting module:** chart of accounts (from COA templates), fiscal years and periods, exchange rates, the journal engine, accounting events and the ledger query. Details are in [ADR 0002](decisions/0002-phase-2-accounting.md).
- **Approvals module:** the reusable Authority & Approval framework. It holds policies with AND-ed steps, eligible roles or members, per-request policy snapshots, and append-only decisions. Journal posting and period reopening use it today; later modules register their own actions.
- **Posting is atomic.** One transaction runs the checks and then:
  1. checks authorization and approvals;
  2. validates the lines;
  3. checks the currency and resolves the exchange rate;
  4. locks the open period (`FOR SHARE`, so closing waits for in-flight postings);
  5. converts to the base currency (largest-eligible-line rounding);
  6. assigns the journal number;
  7. marks the journal POSTED;
  8. writes the audit event and the outbox event.

  Any failure rolls back everything. Database triggers repeat the core invariants.

- **Money** is exact: PostgreSQL `numeric`, `decimal.js` in TypeScript, and decimal strings in the API. JSON numbers are rejected for amounts.

## Phase status

- **Phase 1 (Foundation):** identity, organizations, access control, audit, outbox.
- **Phase 2 (Accounting Foundation & General Ledger):** accounting and approvals.
- **Phase 3A (Foundations):** account classification and currency, dimensions, financial statements, the party master, files and background jobs, CSV import and export, MFA, opening balances, revaluation support, conditional approvals.
- **Phase 3B (Sales & Accounts Receivable):** tax codes, customers, items, invoices, credit notes, receipts, AR reports, PDFs and email.
- **Phase 4 (Purchases & Accounts Payable):** vendors, bills, vendor credits and debit notes, payments, prepayments and refunds, batch Pay bills, direct expenses, opening AP documents, AP reports, remittance advices, purchase imports and exports, and the revaluation user workflow.
- **Banking (ADR 0005):** bank accounts, statement import (CSV and OFX behind a provider abstraction), matching, bank entries and transfers as accounting source documents, reconciliation and rules.
- **Inventory (ADR 0006):** tracked items at weighted-average cost, an immutable stock ledger, stock in on bills and out on invoices (an additive cost-of-goods-sold journal through an accounting event), adjustments and valuation.
- Purchase orders, fixed assets, expense claims, the public API and tax returns are planned; see the [integration plan](integration-plan.md).
