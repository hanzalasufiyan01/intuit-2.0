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
- **D19** Rejected or withdrawn journals return to DRAFT. There is no journal deletion in Phase 2. _(Refined by ADR 0003 ruling L-9: never-submitted imported drafts may be moved to the terminal `DISCARDED` status; journals are still never deleted.)_
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

## Amendment 1 (Phase 3) — FX journal architecture and related changes

- **Status:** APPROVED / FROZEN by the Decision 1–52 register ([ADR 0003](0003-phase-3-sales-receivables.md)), 2026-09-27.
- **Rule:** the text above this amendment is not edited. Where this amendment conflicts with it, this amendment governs from Phase 3A onward. Phase 2 journals already posted are unaffected.

### A1.1 System FX journals with base-only lines (Decision 10)

System-generated FX journals (realized FX from Sales settlements; revaluation and its reversal/adjustment) may contain:

- **Normal lines:** a transaction-currency amount (exactly one positive side) and its base amount.
- **Base-only lines:** transaction amount **zero** and an explicit positive base amount on exactly one side.

Validation for these journals:

- The **base currency must balance** across all lines.
- The **transaction currency must balance** across normal lines.
- **Per-line base amounts** are supported. For example, receivables relieved at each invoice's historical rate while the deposit is converted at the receipt rate.
- **Base-only lines are restricted to approved FX/revaluation system handlers.** Users can't create them through manual journals, the API or imports.

Other rules:

- **Manual journals keep the Phase 2 single-rate rules** (principle 3, A3–A5) unchanged.
- The database posting guard (`accounting_guard_journal_entry`) is amended in a new migration to enforce the above, including recognizing base-only lines. Posted-journal immutability, open-period and balance guarantees remain.
- **Supersedes, narrowly:** principle 3 and A5, for approved system FX journals only.

### A1.2 Account currency and posting rule (Decisions 1, 11, 26)

- Accounts carry an ISO-4217 `currency_code`. Existing accounts default to the base currency.
- A journal line may post only to an account whose currency equals the **journal currency** or the **base currency**. A foreign-currency account accepts only its own currency.
- Receivables use **one base-currency AR control account**; foreign-currency receivables are tracked in the Sales/AR subledger.
- **Refines A2:** before the first posted transaction, a base-currency change moves base-currency accounts to the new base currency, and explicitly foreign accounts are unchanged. After the first posted transaction the base currency is immutable.

### A1.3 Source-document reference (Decision 12)

- Journal entries carry `source_module`, `source_type` and `source_id`, set at creation and immutable after posting.
- Journals posted before this amendment keep null references, because posted rows can't be changed.

### A1.4 Journal approval scope (Decision 13)

- **Narrows assumption 4:** journals generated by Sales documents, whose domain approval is authoritative, post atomically with the Sales issue. They don't stay drafts and don't need journal approval.
- Event types without domain approval continue through accounting approval where applicable.
- **Narrows F26:** re-authentication for journal posting applies to **manual journals**, not the Sales atomic issue path.

### A1.5 Conditional approvals (Decision 22)

- **Supersedes D16's exclusion of amount thresholds.** The approval engine supports conditions: in Phase 3A, **amount thresholds** and **transaction type**, extensible to account, dimension and others.
- Self-approval stays prohibited, and no policy still means direct action.

### A1.6 Other additive changes

- **Classification/subtype and bank/cash designation** (Decision 2).
- **System account designations:** Retained Earnings, Realized FX Gain/Loss, Unrealized FX Gain/Loss, Rounding Difference, Opening Balance Equity (Decision 14).
- **Journal-line dimensions** (Decisions 3, 16).
- **Virtual year-end** (Decision 18).
- **Opening-balance journal** (Decision 27).
- **Revaluation schema and engine support** (Decision 9; user workflow **DEFERRED TO PHASE 4**).
- **Transaction-aware event intake** (Phase 3 C1).
- **Control accounts** (Phase 3 C3).

### A1.7 Refinements (Decisions 64, 68–71, 73, 77)

- **Account currency immutability (Decision 70):** an account's currency is immutable once the account has any non-draft journal line.
- **Base-only lines on foreign accounts (Decision 71):** `base_only` lines from approved revaluation and realized-FX handlers may post to **foreign-currency monetary accounts**. Their foreign-currency balance is unchanged. This is the only exception to A1.2's "a foreign-currency account accepts only its own currency".
- **Opening balances (Decisions 68, 69, 73):**
  - one opening journal **per currency** within one opening batch (amends Decision 27);
  - no opening balances on the AR control account in Phase 3A;
  - posting requires re-authentication.
- **Designation template accounts (Decision 64):** 4950 Realized FX Gain/Loss, 4960 Unrealized FX Gain/Loss, 5950 Rounding Differences, 3900 Opening Balance Equity; Retained Earnings = 3200.
- **Conditional approvals (Decisions 56, 77):** conditions attach to approval steps and are evaluated into the request snapshot. Amount thresholds use the base-currency equivalent at the document rate. If no step matches, the action proceeds directly.

### A1.8 Refinements (Decisions 79–83, 87)

- **Designated system accounts (Decision 79):** remain active, leaf, base-currency, non-control accounts of the required nature; they cannot be archived, deleted, retyped incompatibly or become parents. Engines reference designations, never account codes.
- **System FX/revaluation journals (Decision 80):** not reversible through the generic reversal mechanism (`SYSTEM_JOURNAL`); corrected through the FX/revaluation process.
- **Base-currency change (Decision 81):** refines A2/Decision 26. Blocked after posted transactions; pending/draft lines that prevent the migration must be cleared explicitly (never silently deleted); base-currency accounts follow the new base currency, foreign accounts are unchanged; audited.
- **Manual journal API strictness (Decision 83):** unknown fields are rejected; `base_only` lines and explicit base amounts are system-handler concepts only, blocked by API/domain validation and by the database guard.
- **Reversal dimensions (Decision 87):** reversals copy the original's dimension assignments (archived values included); newly introduced required-dimension rules do not apply to the reversal.
