# Module Boundaries

## Rules

1. Each module owns its tables, domain logic and persistence access.
2. Other modules interact with it only through its **public contract**: application services, commands/queries, and internal events.
3. No module reads or writes another module's tables directly.
4. Modules never bypass domain services to reach the database.
5. There is exactly one ledger and one customer master. Modules must not create duplicates.
6. Country-specific rules never enter the accounting core.
7. Every organization-owned operation receives an **authorization context** (user, organization, permissions) resolved by the server.

## Phase 1 modules

| Module | Owns |
| --- | --- |
| identity | users, credentials, sessions, password reset tokens |
| organizations | organizations, memberships, invitations |
| access-control | permission catalog, organization roles, role-permission and membership-role mappings |
| audit | audit events, security events (append-only) |
| outbox | outbox events and delivery state |

Later phases add business modules (accounting, customers, vendors, sales, and so on) under `apps/api/src/modules/`, following the same rules.
