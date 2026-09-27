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
- **Tenant isolation is enforced on the server.** The client never supplies a trusted `organization_id`. PostgreSQL Row-Level Security is planned as a second layer of defence.
- **Posted financial records are immutable.** Corrections use void, reversal, credit notes or adjustments.
- **The core is country-independent.** Tax, fiscal and statutory rules live in localization modules.
- **The core is industry-independent.** Industry extensions (for example, clinics) consume shared platform services.
- **External services sit behind provider interfaces** (email, payments, bank feeds, OCR, storage, SMS), with mock providers in development.
- **AI is assistive only.** It never posts entries, changes records, tax rules or permissions, or touches audit history.

## Internal events

Business transactions write an outbox event in the same database transaction. Consumers (notifications, audit processing, integrations, projections) read from the PostgreSQL-backed outbox. No external message broker is used at this stage.

## Phase status

Phase 1 (Foundation) is in progress. See `docs/decisions/0001-phase-1-foundation.md`.
