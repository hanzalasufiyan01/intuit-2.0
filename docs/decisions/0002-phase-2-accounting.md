# ADR 0002 — Phase 2 Accounting Foundation & General Ledger

- **Status:** Approved
- **Date:** 2026-09-27
- **Source:** Intuit 2.0 Phase 2 Architecture & Implementation Brief v1.0 (APPROVED / FROZEN), the Phase 2 implementation approval, and the clarification answers A1–F27 recorded below.

ADR 0001 remains in force. Where they overlap, this ADR records the Phase 2 decisions.

## Frozen principles (brief §27 and implementation approval)

1. Accounting is the financial source of truth. The General Ledger is a query over posted journal lines, not a second store.
2. One journal has one transaction currency. The transaction amount, currency, exchange rate and base-currency amount are preserved.
3. Every submitted or postable journal has at least two lines, total debits equal total credits, amounts are positive, and each line carries either a debit or a credit, never both.
4. Posted journals are immutable. Corrections use reversal journals.
5. Closed periods accept no postings. Reopening requires permission, re-authentication, a reason, an audit event, and any applicable approval rules.
6. Authority is configurable (one or many approvers, groups, multi-step). No single "main person" or Owner is assumed for business authority.
7. Operational modules never write the General Ledger. They send accounting events, which are idempotent.
8. Only leaf accounts receive postings. Parent accounts are grouping and reporting nodes.
9. Financial arithmetic is exact: PostgreSQL `numeric` plus `decimal.js`. JavaScript floating point is never used for money.

## Clarification decisions

### A. Setup and currency

- **A1** One-time accounting setup (`POST /api/v1/accounting/setup`) selects the base currency and the COA template. It requires the new permission `accounting.setup` and re-authentication. Existing organizations use the same step.
- **A2** The base currency is an ISO 4217 code chosen at setup. It can change (`PATCH /accounting/settings`, `accounting.setup` + re-authentication) only until the first journal is posted.
- **A3** Amounts may have no more decimals than the currency's ISO minor unit (0, 2, 3 or 4). Exchange rates are stored to 10 decimals. Base amounts are rounded half-up, per line, to the base currency's minor unit. Storage is `numeric(28,4)` for amounts and `numeric(28,10)` for rates.
- **A4** Base-currency rounding uses the **largest-eligible-line rule**. The whole rounding difference goes to the line with the largest transaction amount; ties go to the first line. "Eligible" means the adjusted base amount stays positive. The adjustment is stored on the line (`rounding_adjustment`) and in the `journal.posted` audit event.
- **A5** The rate is either entered on the journal (`manual`) or taken from the organization's rate table (`table`). The table rate used is the most recent one on or before the journal date. Base-currency journals use a rate of 1 (`base`). The rate used at posting is copied onto the journal and never changes afterwards.
- **A6** Exact decimals use `decimal.js` (approved dependency) together with PostgreSQL `numeric`.

### B. Chart of Accounts

- **B7** The Maldives, India, UAE and UK templates share one starting structure (31 accounts: 5 root groups with sub-groups and leaf accounts) until country-specific charts are supplied. The Custom template starts empty. Templates are reference data seeded by `pnpm db:seed`.
- **B8** The account type is one of the five categories: ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE.
- **B9** Account rules:
  - Codes are unique per organization (1–20 characters).
  - A parent must be in the same organization and have the same type (enforced by a composite foreign key).
  - Cycles are rejected.
  - Only leaf accounts can receive postings.
- **B10** Deleting an account requires the new permission `accounting.accounts.delete` plus re-authentication.
- **B11** An account used in posted transactions cannot be deleted; it can be archived. References from draft journals do not prevent deletion: those draft lines lose their account, and the draft must be completed before submission.
- **B12** Template-created accounts are marked `is_system` and follow the same lifecycle rules as custom accounts. Archived accounts cannot receive new postings. Phase 2 has no un-archive endpoint.

### C. Fiscal years and periods

- **C13** Fiscal years are created with monthly periods by default. Custom, contiguous periods may be supplied instead. Fiscal years are contiguous and non-overlapping; overlaps are also rejected by a PostgreSQL exclusion constraint.
- **C14** Periods can close in any order. Draft or pending journals do not block closing. Year-end closing is out of scope.
- **C15** The journal date determines the accounting period, which must be open at submission and at posting.

### D. Authority & Approval framework (reusable `approvals` module)

- **D16** A policy exists per organization and approvable action. It has one or more steps, and every step must pass. Each step needs N distinct approvers from its eligible set: roles and/or named members. An approver must also hold the action's approver permission. Amount thresholds and conditional rules are out of scope.
- **D17** With no policy, an authorized user may post directly (DRAFT → POSTED).
- **D18** Self-approval is prohibited. Neither the journal's preparer nor its submitter can approve it. There is no other segregation-of-duties rule: an approver may also post.
- **D19** Rejected or withdrawn journals return to DRAFT. There is no journal deletion in Phase 2.
- **D20** Approval policies are managed with the new permission `approvals.manage`, re-authentication and an audit trail. Posting stays a separate `/post` call after the final approval. Period reopening uses the same framework: with a policy, a reopen creates a request, and the period reopens automatically on final approval.

### E. Journals, reversal, events, ledger

- **E21** Journal numbers are assigned at posting from a per-organization counter. Drafts consume no number, and gapless numbering is not required. The UI displays numbers as `JE-000001`.
- **E22** Reversal requires `accounting.journals.reverse` and re-authentication. The user chooses a reversal date in an open period; the default is the original date when that period is open. The reversal posts immediately, without an approval step. It swaps every debit and credit and reuses the original's exact rate and base amounts. The original becomes REVERSED and nothing else about it changes.
- **E23** Accounting events arrive in an idempotent inbox (`accounting_events`), unique on (organization, source module, event key):
  - A replay of the same event returns the original result.
  - A replay with a different payload is rejected (`IDEMPOTENCY_CONFLICT`).
  - A handler registry turns events into journals through the same posting engine. Phase 2 registers no handlers.
  - Accounting events are separate from the Phase 1 outbox. Posting still writes outbox events.
- **E24** The ledger (`GET /accounting/ledger`) filters by account (a parent rolls up its descendants), date range and limit. It returns an opening balance, a running balance (in base currency, debit minus credit) and totals, alongside the transaction-currency columns.

### F. Roles, sensitive actions, seed

- **F25** Owner receives every permission automatically (ADR 0001). The Administrator template receives all accounting permissions plus `approvals.manage`. The Member template receives the four accounting view permissions. No new role templates are added.
- **F26** Sensitive actions (re-authentication within 15 minutes):
  - accounting setup and base-currency changes
  - period close
  - period reopen, including approving a reopen request
  - journal post
  - journal reverse
  - approval-policy changes
  - account deletion
- **F27** `pnpm db:seed:dev` creates development data. It refuses to run outside `development` and `testing`. The users' password comes only from `DEV_SEED_PASSWORD` in the git-ignored `.env`, and the seed never contains real secrets.

## Permission catalog added in Phase 2

`accounting.setup`, `accounting.accounts.{view,create,update,archive,delete}`, `accounting.journals.{view,create,edit_draft,submit,approve,post,reverse}`, `accounting.periods.{view,close,reopen}`, `accounting.ledger.view`, `approvals.manage`.

Permission keys may now have more than two segments. A migration relaxed the Phase 1 key constraint, and the `invoices.delete` prohibition remains.

## Implementation mappings (no new business rules)

These map endpoints in the brief to permissions in the approved catalog:

- Creating fiscal years and recording exchange rates use `accounting.setup`. Listing exchange rates uses `accounting.journals.view`.
- The accounting dashboard shows the sections the caller has view permission for (journals and/or periods).
- Approving a journal uses `accounting.journals.approve`. Approving a period-reopen request uses `accounting.periods.reopen`.

## Defence-in-depth (database)

- Triggers block every update of a POSTED or REVERSED journal except the single POSTED → REVERSED transition. They also block deleting any non-draft journal and any change to posted journal lines. Moving a journal to POSTED is refused unless it has at least 2 valid lines, balances in both transaction and base currency, and falls inside an OPEN period.
- Approval decisions and reversal links are append-only.
- All accounting and approval tables are organization-scoped with RLS. The application role has no DELETE on journals.

## Approved implementation assumptions (2026-09-27)

These four assumptions filled gaps the brief did not cover. They were reported in the Phase 2 implementation report and approved on review:

1. **Pending references block account deletion.** An account referenced by a journal that is PENDING_APPROVAL (or POSTED/REVERSED) cannot be deleted (`ACCOUNT_IN_USE`). Only draft-only references are cleared on deletion (B11).
2. **Used accounts cannot become parents.** An account that already has non-draft journal lines cannot be given child accounts, because parents are grouping nodes that never carry postings (principle 8). The same rule applies when moving an account under a new parent.
3. **Reversals may post to archived accounts.** A reversal corrects an earlier posting, so its lines may hit accounts archived after the original was posted. Archived accounts still reject every other new posting (B12).
4. **Event journals that need approval stay drafts.** If the organization requires approval for journal posting, a journal created from an accounting event is saved as a DRAFT for the normal submit → approve → post workflow instead of being posted directly (D17).

## Existing-organization permission backfill — APPROVED (2026-09-27)

Seeding re-syncs only the protected Owner role (ADR 0001: seeding never changes organization-customizable roles). To give organizations created before Phase 2 the same starting access as new ones, migration `0003_phase2_permission_backfill` runs once:

- It grants the template-derived **Administrator** roles every accounting permission plus `approvals.manage`, and the template-derived **Member** roles the four accounting view permissions.
- It is **additive only**: no permission is removed, customizations are preserved, and custom roles and the Owner role are not touched.
- It is idempotent (`ON CONFLICT DO NOTHING`). It also inserts the Phase 2 catalog keys first, so it works when upgrading a Phase 1 database before `pnpm db:seed` has run.
- For each role that received permissions, it writes a `role.permissions_backfilled` audit event (actor `system`) listing the permissions added.
