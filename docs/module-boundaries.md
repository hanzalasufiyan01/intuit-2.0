# Module Boundaries

## Rules

1. Each module owns its tables, domain logic and persistence access.
2. Other modules interact with it only through its **public contract**: application services, commands/queries, and internal events.
3. No module reads or writes another module's tables directly.
4. Modules never bypass domain services to reach the database.
5. There is exactly one ledger and one customer master. Modules must not create duplicates.
6. Country-specific rules never enter the accounting core.
7. Every organization-owned operation receives an **authorization context** (user, organization, permissions) resolved by the server.

## Modules

| Module          | Owns (tables)                                                                                                                                                                                                                                                                                             | Public contract                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| identity        | `users`, `sessions`, `password_reset_tokens`                                                                                                                                                                                                                                                              | `modules/identity/index.ts`       |
| organizations   | `organizations`, `memberships`, `invitations`, `ownership_transfers`                                                                                                                                                                                                                                      | `modules/organizations/index.ts`  |
| access-control  | `permissions`, `role_templates`, `role_template_permissions`, `roles`, `role_permissions`, `membership_roles`                                                                                                                                                                                             | `modules/access-control/index.ts` |
| audit           | `audit_events`, `security_events` (append-only)                                                                                                                                                                                                                                                           | `modules/audit/index.ts`          |
| outbox          | `outbox_events`                                                                                                                                                                                                                                                                                           | `modules/outbox/index.ts`         |
| approvals (P2)  | `approval_policies`, `approval_policy_steps`, `approval_step_eligible_roles`, `approval_step_eligible_members`, `approval_requests`, `approval_decisions` (append-only)                                                                                                                                   | `modules/approvals/index.ts`      |
| accounting (P2) | `accounting_settings`, `accounting_coa_templates`, `accounting_coa_template_accounts`, `accounting_accounts`, `accounting_exchange_rates`, `accounting_fiscal_years`, `accounting_periods`, `accounting_journal_entries`, `accounting_journal_lines`, `accounting_journal_reversals`, `accounting_events` | `modules/accounting/index.ts`     |

Each module defines its own Drizzle table definitions in `schema.ts`. `src/database/schema.ts` only re-exports them for the shared client. The SQL migrations in `src/database/migrations/` are the physical source of truth. A centralized migration runner applies them.

## How boundaries are enforced

- **Lint rule:** code outside a module (`api/`, `application/`) and other modules may import a module only through its `index.ts`. ESLint `no-restricted-imports` blocks deep imports.
- **Cross-module workflows** live in `src/application/`. Examples are registration, invitation acceptance and organization provisioning. They orchestrate several modules' public functions inside one transaction (unit of work) and never touch tables directly.
- **Permission catalog:** each module contributes its own permission definitions (`permissions.ts`). The composition root (`application/permission-catalog.ts`) aggregates and validates them.
- **Database integrity across modules** uses foreign keys, including composite `(id, organization_id)` keys that pin children to the same organization. Only the owning module writes each table.

## Layering

```
api (HTTP, validation, cookies/CSRF)  →  application (use cases, authorization, unit of work)
  →  modules (domain + persistence per module)  →  database (client, migrations, seed)
infrastructure (config, logging, clock, crypto, email provider) is used by all layers
domain (errors) and shared (small utilities) have no framework or database dependencies
```

## Accounting integration rule (Phase 2)

Operational modules added in later phases (sales, purchases, payroll, and so on) must never write accounting tables. They send **accounting events** through the accounting module's contract (`JournalService.receiveEvent`, idempotent on the source module plus event key). A registered handler turns each event into a journal that goes through the same validation and posting engine as manual journals.

Approvals are a shared module. Modules register their approvable actions with `ApprovalService` and must not build their own approval mechanisms.

Later phases add business modules (customers, vendors, sales, and so on) under `apps/api/src/modules/`, following the same rules.
