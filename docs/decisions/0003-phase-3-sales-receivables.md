# ADR 0003 — Phase 3: Foundations (3A) and Sales & Accounts Receivable (3B)

- **Status:** APPROVED / FROZEN. It covers the Decision 1–92 register (Decisions 1–52; P1–P13 as Decisions 53–65; PC-1–PC-12 as Decisions 66–77; Decisions 78–92; S3-01–S3-24; S4-01–S4-22; K-1–K-7 and S5-01–S5-22; L-1–L-12 and S6-01–S6-46; S7-01–S7-46; S8-01–S8-23; the S9 decisions with amendments N1–N9; S10-01–S10-12) and the earlier Phase 3 decisions C1–C3 and D1–D16, as refined below. Items marked **UNDECIDED**, **DEFERRED** or **OPEN** are not approved for implementation.
- **Date:** 2026-09-27
- **Authoritative source:** "Authoritative Intuit 2.0 — Decision 1–52 Register", the Phase 3A readiness decisions P1–P13 (Decisions 53–65), planning decisions PC-1–PC-12 (Decisions 66–77), Decision 78 (approved 2026-09-27) and Decisions 79–92 (approved 2026-09-28). Numbering is the register's own and must not be changed.
- **Brief:** [docs/phase-3-brief.md](../phase-3-brief.md)
- **Amends:** [ADR 0002](0002-phase-2-accounting.md), see its "Amendment 1 (Phase 3)" section.
- **Preserves:** ADR 0001 and ADR 0002, except where this ADR explicitly supersedes them.

## Governance

- New business rules or architecture changes follow **Proposal → Review → User approval → Freeze → Implementation**.
- If a conflict with a frozen decision is found during implementation, it must be reported with impact, the affected decisions and options, and work stops before the conflicting change.
- Intuit 2.0 must keep moving toward QuickBooks Online / Xero functional breadth plus differentiated features. Features are not removed to make a phase easier.

## Earlier Phase 3 decisions (still frozen, with refinements)

| #   | Decision (summary)                                                                                                                                                                                                                    | Refined by the register                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Transaction-aware accounting-event intake, so a sales document and its journal commit or roll back together. Phase 2 `receiveEvent` unchanged.                                                                                        | 3A step 6                                                                                                                                                                        |
| C2  | Sales documents have their own approval workflow. Approval comes first, then the event posts the journal atomically. Subledger and GL never out of sync.                                                                              | **Decision 13**; U1 remains UNDECIDED                                                                                                                                            |
| C3  | `is_control_account` on accounting accounts. AR control accounts are rejected in manual journals.                                                                                                                                     | **Decision 11** (single base-currency AR control account)                                                                                                                        |
| D1  | Configurable tax codes: code, rate, tax payable account, inclusive/exclusive, exact rounding. No filing, returns or e-invoicing.                                                                                                      | **Decisions 15, 32, 33, 44** (effective-dated rate versions, snapshots, per-line rounding, "No Tax" treatment)                                                                   |
| D2  | Customer fields: name, email/phone, tax ID, billing address, default currency, payment terms, credit limit (not enforced).                                                                                                            | **Decisions 8, 28, 48**. Identity data (name, contacts, addresses, TIN) lives on the Party. Currency, terms and credit limit live on the Customer. Credit limit is warning-only. |
| D3  | Separate configurable sequences for invoices, credit notes and receipts. Number assigned at issue. Configurable prefix/format. Not gapless. Issued numbers immutable.                                                                 | Decision 52 (R37)                                                                                                                                                                |
| D4  | Product/service catalog: name/SKU, type, description, sales price, revenue account, tax code, active/inactive. No inventory.                                                                                                          | Decision 31 (`sales.items.manage`)                                                                                                                                               |
| D5  | Partial payments; one receipt across many invoices; many receipts per invoice; unallocated amounts become customer credit; refunds later.                                                                                             | **Decisions 36–40**                                                                                                                                                              |
| D6  | Foreign-currency invoices using Phase 2 rate infrastructure. Rate preserved. Realized FX through the accounting engine.                                                                                                               | **Decisions 10, 11, 36, 37**                                                                                                                                                     |
| D7  | Sales settings hold default AR, revenue, tax and receipt accounts. Items may override revenue/tax accounts. AR control account system-controlled. Missing accounts block issue.                                                       | **Decisions 11, 14, 42**                                                                                                                                                         |
| D8  | Void only when unpaid and in an open period. Partial/full credit notes. Issued invoices never deleted.                                                                                                                                | Decision 52 (R35)                                                                                                                                                                |
| D9  | Net X days terms, overridable per invoice. Aging buckets Current, 1–30, 31–60, 61–90, 90+.                                                                                                                                            | —                                                                                                                                                                                |
| D10 | Professional invoice PDFs with preview/download. Email through the provider abstraction; mock email in development.                                                                                                                   | **Decisions 21, 43**; U18 DEFERRED                                                                                                                                               |
| D11 | Sales permissions: `customers.{view,create,update,archive}`, `invoices.{view,create,edit_draft,issue,void,delete_draft}`, `credit_notes.{view,create,issue}`, `receipts.{view,create}`, `sales.settings.manage`, `sales.reports.view` | **Extended** by Decisions 28 (`parties.*`), 30 (`invoices.approve`, `credit_notes.approve`), 31 (`sales.items.manage`, `tax.codes.manage`), 40 (`receipts.void`)                 |
| D12 | Re-authentication: invoice void, credit-note issue, sales settings changes, tax-code changes, refunds (later).                                                                                                                        | **Extended** by Decision 40 (receipt void). Decision 31 (`tax.codes.manage` with re-auth) and Decision 41 (credit-note issue) confirm existing items.                            |
| D13 | Existing approval engine for invoice and credit-note issuing when configured. No self-approval. No policy means direct action.                                                                                                        | **Decisions 13, 22, 30**                                                                                                                                                         |
| D14 | Administrator all Sales permissions, Member view-only, Owner full. Additive, audited backfill for existing organizations.                                                                                                             | Applies to all Phase 3 permissions                                                                                                                                               |
| D15 | Document date determines the period, which must be open. Issued dates immutable.                                                                                                                                                      | —                                                                                                                                                                                |
| D16 | Line-level and invoice-level discounts, percentage or fixed, exact decimals.                                                                                                                                                          | **Superseded in part by Decision 34**: discounts are always before tax (the "by default" alternative is removed). Posting per Decision 35.                                       |

## Decision 1–52 register (incorporated)

The register text is authoritative. The summaries here are for navigation only.

### Decisions 1–9: Foundational amendments (Phase 3A)

1. **Account currency.** Add `currency_code` to accounting accounts, using controlled ISO-4217 reference data. Existing accounts default to the base currency. Foreign-currency accounts are supported, and account currency is part of posting validation.
2. **Bank account designation.** Accounts keep their fundamental nature. Add structured classification/subtype. Explicitly designate bank/cash accounts, which must have a currency. Banking remains an operational module; the GL remains the source of truth.
3. **Journal-line dimensions.**
   - Generic framework: Dimension Type → Dimension Values → Journal-Line Assignments (for example Branch, Department, Project, Cost Center, custom). No hardcoded `branch_id`/`project_id` columns.
   - Posted assignments are immutable. One value per type per line.
   - Types can be marked required or optional per organization. No balancing.
4. **Financial statements.**
   - Trial Balance, Profit & Loss and Balance Sheet.
   - Date/period and dimension filters. Currency-aware. Opening and closing balances.
   - Drill-down: report → account → journal → source document. Export-ready.
   - Derived only from the ledger. A dimension-filtered Balance Sheet is labelled "tagged activity only".
5. **MFA.**
   - TOTP authenticator app and recovery codes. SMS is not the primary mechanism.
   - Required for the Owner and high-privilege users; organizations may require more.
   - WebAuthn/passkey-ready. TOTP secrets encrypted at rest. Recovery codes Argon2id-hashed and single-use. TOTP attempts throttled.
   - MFA-pending session state. Secure admin reset.
   - "Remember this device" only as opt-in, time-limited, revocable server-side trust. Sensitive actions can still require re-authentication.
6. **File storage.**
   - Application → Storage Service → Storage Provider.
   - Tenant-isolated and private by default. Secure upload/download with metadata, MIME/type and size validation. Access control and business-record attachments.
   - Soft delete plus audit. Signed/temporary URLs.
   - File contents never in PostgreSQL.
   - Local development provider; production S3-compatible abstraction.
   - Magic-byte validation and MIME allowlist. Malware scanning architecture-ready (mandatory scanning may be deferred).
   - Soft-deleted files retained 90 days subject to legal retention. Issued legal PDFs can't be removed through normal user actions.
7. **Import/export.**
   - Reusable pipeline: file → validate → preview/map → confirm → transactional import → audit.
   - Imports: customers/contacts, COA, opening balances, safe accounting data.
   - Exports: CSV and Excel-compatible formats (reports, customers, COA, journals/GL).
   - Safety controls per Decision 24.
8. **Unified Party/Contact master.**
   - A shared identity layer with roles Customer, Vendor, Employee, Other, or several.
   - Customer and Vendor logic stay in separate modules.
   - Multiple contact persons, billing and delivery addresses, and party-level TIN.
   - Customer-specific currency, terms and credit limit.
   - `parties.*` permissions for non-customer contacts. Merge/dedup is future work.
9. **Unrealized FX revaluation architecture.**
   - Must support foreign-currency monetary accounts, period-end rates, unrealized FX calculation, revaluation journals, reversal/adjustment, configurable FX gain/loss accounts and full audit.
   - Original transactions untouched.
   - **Schema and engine support in 3A. The user-facing periodic revaluation workflow is DEFERRED TO PHASE 4.**

### Decisions 10–19: R1–R10

10. **FX journal architecture (R1).** System-generated FX journals may contain normal transaction-currency lines and **base-currency-only lines**: transaction amount zero with an explicit base amount. Rules:
    - Per-line base amounts are allowed.
    - The base currency must balance.
    - The transaction currency must balance across normal lines.
    - Manual journals keep the single-rate rules.
    - Base-only lines are restricted to approved FX/revaluation system handlers.
    - Database posting guards are amended.

    See the ADR 0002 amendment.

11. **Foreign-currency receivables (R2).**
    - **One base-currency AR control account.** Foreign-currency receivables are tracked in the Sales/AR subledger.
    - A line may post to an account whose currency equals the journal currency or the base currency. A foreign-currency account accepts only its own currency.
    - Revaluation works per open foreign-currency document and per foreign-currency monetary account.
    - Resolved; not open.
12. **Journal → source document (R3).** Journals carry `source_module`, `source_type` and `source_id`. They are set at creation and immutable after posting, enabling report → account → journal → source drill-down.
13. **Sales approval → accounting posting (R4).**
    - Sales approval is authoritative for Sales-generated journals. Once it is satisfied, invoice issue, the accounting event and the journal posting happen atomically.
    - The Sales path needs no second journal approval.
    - Manual journals keep accounting journal approval. Event types without domain approval continue through accounting approval where applicable.
    - Manual-journal posting re-auth applies to manual journals, not the Sales atomic issue path.
14. **System account designations (R5).**
    - Designation map: Retained Earnings, Realized FX Gain/Loss, Unrealized FX Gain/Loss, Rounding Difference, Opening Balance Equity.
    - Templates include corresponding accounts.
    - Existing organizations must designate required accounts explicitly before dependent features are used. No guessing.
    - Designation changes are audited.
15. **Tax snapshots and effective dating (R6).**
    - Tax codes have effective-dated rate versions.
    - Issued documents snapshot tax code, rate, amount and treatment, and never recalculate.
    - Supports Maldives and future localizations.
16. **Dimension rules (R7).**
    - Posted assignments immutable. One value per type per line.
    - Document dimensions flow to relevant revenue and tax lines. AR/bank lines may inherit document-level dimensions.
    - No balancing. "Tagged activity" labelling on Balance Sheets. Types can be required or optional per organization.
17. **Organization legal profile (R8).** Legal/business name, registered/business address, TIN, GST registration information, logo, contact details, and extensible localization identifiers. Owned by the organizations module and consumed by Sales.
18. **Virtual year-end (R9).**
    - No physical closing journals.
    - Revenue/expense results are calculated per fiscal year, and current-year earnings and retained earnings come from reporting logic.
    - History untouched.
19. **Phase 3 staging (R10).** 3A Foundations → full verification → **one local commit**. Then 3B Sales & AR → full verification → **one local commit**. No single combined Phase 3 commit.

### Decisions 20–29: R11–R20

20. **Background job runner.**
    - PostgreSQL job table with `SKIP LOCKED`, retry/backoff, failure/dead-letter handling, idempotency, tenant context, audit and status/progress.
    - No Redis, Kafka or RabbitMQ.
    - Outbox handles event delivery; the job runner handles background work.
21. **Immutable PDF snapshots.**
    - Invoices and credit notes get an immutable PDF snapshot at issue, stored through file storage.
    - Later template changes never alter the legal copy. The job system may generate PDFs.
    - The library is chosen per Decision 43.
22. **Conditional approvals (Phase 3A).**
    - The approval engine supports conditions. Phase 3 supports **amount thresholds** and **transaction type**, extensible to account, dimension and other conditions.
    - Simple, multi-level and conditional approval.
    - No policy means direct action by an authorized user. Self-approval prohibited.
    - Supersedes ADR 0002 D16's exclusion of thresholds.
23. **Idempotency.**
    - A reusable mechanism. First consumers: Sales create and Sales issue. Later: receipts, credit notes, imports, accounting events, payments, banking.
    - Duplicate detection is separate from request idempotency.
24. **Import/export safety.**
    - Formula-injection protection, dry-run/preview, duplicate/conflict warnings, batch tracking, file/row limits, permission checks, transactional financial imports, audit and malformed-file safety.
    - The spreadsheet library is selected during implementation after compatibility, licence and safety evaluation. It is not a frozen product decision.
25. **MFA security details.**
    - Secrets encrypted at rest, with the key held in environment/secret management and a rotation plan.
    - Recovery codes Argon2id-hashed and single-use. Throttling. MFA-pending session state.
    - Enforced for the Owner and high-privilege permission holders, including `roles.manage`, `members.manage`, `approvals.manage`, `accounting.setup` and `sales.settings.manage`. Organizations may require more.
    - Multi-organization users must satisfy the requirements of the organization they enter.
    - Secure admin reset. Opt-in, time-limited, revocable remembered devices. Sensitive actions can still require re-auth.
26. **Base currency changes.**
    - Before the first posted accounting transaction: accounts in the old base currency follow the new base currency; explicitly foreign accounts are unchanged.
    - After the first posted transaction: the base currency is immutable.
27. **Opening balances.** Opening/conversion date, validation and dry-run, **one balanced opening journal**, Opening Balance Equity designation, optional approval, full audit, migration-friendly.
28. **Party master details.** Multiple contact persons, billing and delivery addresses, party-level TIN, customer-specific currency, terms and credit limit, `parties.*` permissions for non-customer contacts. Merge/dedup deferred.
29. **File storage security.**
    - S3-compatible provider abstraction. Magic-byte validation, MIME allowlist, size limits.
    - Malware scanning architecture-ready, with mandatory scanning deferrable.
    - 90-day soft-delete retention subject to legal retention. Issued legal PDFs not removable by normal users.
    - Private by default; signed temporary URLs.
    - The production vendor is a deployment decision, not an architecture decision.

### Decisions 30–44: approved U items

30. **U2.** Add `invoices.approve` and `credit_notes.approve`. Approval is separate from issuing. No self-approval.
31. **U3.** Add `sales.items.manage` and `tax.codes.manage`. `tax.codes.manage` requires re-authentication.
32. **U4.** Tax treatment is an organization default with a per-document override: Tax Inclusive, Tax Exclusive or No Tax.
33. **U5.** Tax is calculated and rounded **per line**; total tax is the sum of rounded line taxes. Exact decimals and currency minor units.
34. **U6.** **All** discounts are applied before tax: Gross → Discount → Tax → Final.
35. **U7.** The invoice-level discount is allocated pro-rata across lines by net line value and reduces revenue. Tax is calculated after the discount. No separate discount account for this mechanism.
36. **U9.** A receipt has one transaction currency, normally the invoice currency. The deposit/bank account is in the same currency or the base currency, subject to the rules. Customer credit keeps the receipt currency. FX goes through the approved FX engine.
37. **U10.** Receipt rates reuse the Phase 2 exchange-rate architecture: system/default rate, authorized manual override with a **mandatory override reason**, audit, and the exact rate used preserved.
38. **U11.** A receipt is allocated up to each invoice's balance. The excess becomes customer credit in the receipt currency, which can later be applied to eligible same-currency invoices.
39. **U12.** Customer credit is applied to outstanding invoices as an allocation, under `receipts.create`. Currency-compatible only. Fully audited.
40. **U13.** Posted receipts are immutable. They are voided by reversal, only in an open period, with `receipts.void` and re-auth. Invoice allocations and customer credit are reversed consistently. Full audit.
41. **U14.** Draft credit notes can be created, edited and deleted. Issued credit notes are immutable. Issue may use Sales approval and requires sensitive re-authentication.
42. **U15.** The receipt user may choose a different deposit/bank account. The settings default is the fallback. The account must be an eligible cash/bank account and meet the currency rules. Permission and audit required. No arbitrary GL posting.
43. **U17.** No PDF library is hardcoded. Candidates are evaluated on quality, Unicode/fonts, tables/layout, security, performance, licensing and maintainability, and a recommendation is made. **Adoption requires approval.** The immutable-PDF architecture is frozen.
44. **U20.** The Maldives localization seeds editable, effective-dated tax configuration: **General GST 8%**; **Tourism GST 17% effective 1 July 2025**.
    - Rates are configuration data, not hardcoded logic.
    - Authorized users add future versions. Issued documents keep their snapshots.
    - Maldives is the primary launch localization. India, UAE and UK are localization-ready but not statutory-certified until validated.

### Decisions 45–50: R21–R26

45. **Sales reporting.** Sales by customer, sales by item, and other appropriate derived Sales reports. No competing source of truth.
46. **Draft concurrency.** Optimistic concurrency protection for draft edits; no silent overwrites.
47. **Search.** PostgreSQL search optimization (for example `pg_trgm`), with indexes introduced based on actual query needs.
48. **Credit limit.** Warning only; no automatic blocking or credit control in this phase.
49. **TOTP QR UX.** Enrollment provides a TOTP QR-code setup, within the MFA security architecture.
50. **Internationalization readiness.** Frontend strings are localization-ready, and future languages including Dhivehi/RTL are architecturally possible. No completeness claims until implemented and validated.

### Decision 51: Future roadmap (DEFERRED / FROZEN ROADMAP)

These must not enter Phase 3:

- **R27:** quotes, repeating/recurring invoices, automated reminders, online invoice/pay links, payment gateways, customer portal.
- **R28:** public API, API tokens, webhooks.
- **R29:** rebuildable report snapshots/caching.
- **R30:** automatic FX rate feeds.
- **R31:** Maldives GST returns (MIRA 205) and other tax returns/e-invoicing.
- **R32:** personal-data erasure versus immutable audit-history policy.

### Decision 52: No change (R33–R37)

- **R33:** one transaction currency per journal/document, with only the Decision 10 base-only exception.
- **R34:** per-period close remains.
- **R35:** posted financial records immutable; corrections by reversal/adjustment.
- **R36:** Customer and Vendor are separate modules on the shared Party master.
- **R37:** numbering stays non-gapless.

## Decisions 53–65: Phase 3A readiness decisions (P1–P13)

53. **Account subtype catalog (P1).**
    - Subtypes: Bank, Cash, Accounts Receivable, Other Current Asset, Fixed Asset, Other Asset, Accounts Payable, Credit Card, Other Current Liability, Long-Term Liability, Equity, Operating Revenue, Other Income, Cost of Sales, Operating Expense, Other Expense. Each belongs to one account nature.
    - **Monetary** (for revaluation): Bank, Cash, Accounts Receivable, Accounts Payable, Credit Card, and monetary current/long-term liabilities, marked explicitly.
    - Bank/cash designation (Decision 2) is the Bank or Cash subtype.
54. **Existing accounts (P2).**
    - Existing accounts start **unclassified**, with no bank designation, and the organization classifies them. No classification is inferred from codes or names.
    - New organizations get classifications from the updated templates.
55. **Required dimensions (P3).** Together with Decision 67: required dimension types apply to **applicable/relevant journal lines**, not P&L lines only and not blindly every line.
56. **Approval threshold basis (P4).** Amount thresholds compare the **base-currency equivalent** at the document rate.
57. **MFA specifics (P5).**
    - (a) High-privilege set: the **Owner** plus holders of `roles.manage`, `members.manage`, `approvals.manage`, `accounting.setup` and `sales.settings.manage`.
    - (b) Organization option **"require MFA for all members"**.
    - (c) Enforced for existing privileged users **at next sign-in**, with no grace period.
    - (d) Remembered devices trusted for **30 days**, revocable.
58. **Manual receipt-rate override permission (P6), for Phase 3B.** Approved as proposed: a new `sales.rates.override` permission **or** reuse of `receipts.create`, with manual journals unchanged. _The choice between the two options is recorded as a Phase 3B clarification item (see Status items); it doesn't affect Phase 3A._
59. **Deposit-account override permission (P7), for Phase 3B.** Approved as proposed: `receipts.create` **or** a new key. _Phase 3B clarification item; doesn't affect Phase 3A._
60. **Maldives tax seed details (P8), for Phase 3B.**
    - General GST 8% effective **2023-01-01** (per MIRA).
    - Tourism GST 16% (2023-01-01 → 2025-06-30) is seeded **only if approved**.
    - Seeded codes map to template account **2130 Tax Payable**.
    - _Seeding the 16% version remains a Phase 3B clarification item._
61. **File and import limits (P9). Authoritative:**
    - Maximum general file size **25 MB**.
    - Maximum import file size **25 MB**.
    - Maximum import rows **25,000**.
    - Import preview **500 rows**.
    - Allowed types: **PDF, PNG, JPEG/JPG, WebP, CSV, XLSX**.
62. **Library selection (P10).**
    - Third-party libraries (TOTP/QR, i18n, spreadsheet, PDF, S3 SDK) each need an evaluation report (licence, maintenance, security, size, fit) and **approval before adoption**.
    - Governs Decisions 24, 43, 49 and 50.
63. **U1 timing (P11).** U1 must be decided **before Phase 3B step 6**. It stays UNDECIDED until then.
64. **Designation template accounts (P12).**
    - 4950 Realized FX Gain/Loss
    - 4960 Unrealized FX Gain/Loss
    - 5950 Rounding Differences
    - 3900 Opening Balance Equity
    - Retained Earnings = existing **3200**.
65. **Phase 3A permission model (P13), complete.**
    - **New keys:** `accounting.reports.view` (financial statements); `accounting.dimensions.manage` (dimension types and values); `parties.view`, `parties.create`, `parties.update`, `parties.archive`.
    - **Reused keys:**
      - `accounting.setup`: system account designations, opening balances, conversion date;
      - `organization.update`: organization legal profile;
      - `members.manage` **plus re-authentication**: organization MFA policy and admin MFA reset.
    - **Files:** access inherits the **linked business record's** permission.
    - **Imports and exports:** inherit the **target's create (import) or view (export) permission**. For example, COA import needs `accounting.accounts.create`, parties import needs `parties.create`, opening balances need `accounting.setup`, and a report export needs `accounting.reports.view`.
    - **Backfill:** additive and audited, as in D14. Administrator gets all new keys; Member gets the view keys (`accounting.reports.view`, `parties.view`); Owner gets all via sync; custom roles are never overwritten.

## Decisions 66–77: Phase 3A planning decisions (PC-1–PC-12)

66. **Numbering (PC-1).** P1–P13 are Decisions 53–65, and PC-1–PC-12 are Decisions 66–77.
67. **Required-dimension scope (PC-2).** With Decision 55: required dimension types apply to applicable/relevant journal lines, not P&L-only and not blindly every line.
68. **Opening balances across currencies (PC-3).**
    - **One opening journal per currency**, all belonging to **one opening batch**.
    - **Amends Decision 27** ("one balanced opening journal"), consistent with R33 and Decision 11.
69. **No AR control opening balances in 3A (PC-4).** Opening balances to the **AR control account are blocked in Phase 3A**. AR opening balances arrive as opening invoices in Phase 3B, which keeps the subledger reconciled.
70. **Account currency immutability (PC-5).** An account's currency becomes **immutable once the account has any non-draft journal line**.
71. **Base-only lines on foreign accounts (PC-6).** `base_only` lines created by approved revaluation/realized-FX handlers **may post to foreign-currency monetary accounts**; their foreign-currency balance is unchanged. This clarifies Decision 11 and is required by Decision 9.
72. **Admin MFA reset (PC-7).** Admins (`members.manage` + re-auth) may reset members' MFA **except the Owner's**. The Owner recovers through recovery codes. _(Refined by S7-37: also refused for an Owner of any organization and for anyone who belongs to another organization; see the S7 decisions.)_
73. **Opening-balance re-auth (PC-8).** Posting opening balances requires re-authentication, the same as manual journal posting.
74. **Placement (PC-9).**
    - **MFA including its TOTP QR UX** (Decisions 5, 25, 49) is Phase 3A.
    - **Idempotency's Sales consumers** (Decision 23) and **broad frontend i18n** (Decision 50) are Phase 3B, per the register's 3B list (R21–R26).
75. **Dependencies (PC-10).**
    - Phase 3A proceeds with no-dependency components: TOTP on `node:crypto`, in-house CSV reader/writer, local storage provider.
    - The QR renderer, XLSX library and S3 SDK are adopted only after evaluation and approval (Decision 62).
76. **Technical defaults (PC-11), all configurable.**
    - Signed download token lifetime 5 minutes.
    - Job max attempts 5, with backoff from 5 s up to 15 min.
    - TOTP 30-second step with a ±1 step window.
    - 10 recovery codes per issue.
77. **Conditional approval model (PC-12).**
    - Conditions attach to **approval steps**; a step applies only if its conditions match the subject facts.
    - The request snapshot keeps matching steps only.
    - If no step matches, the action proceeds directly.

## Decision 78 (verbatim)

### Decision 78 — Manual Journal Dimension Applicability: FROZEN

For manual journals:

- A required dimension applies when the journal line's account/line context requires that dimension type.
- Missing required dimensions block posting.
- No automatic guessing.
- Dimensions are not forced onto irrelevant accounts/lines.
- Explicitly supported document-level dimensions may be inherited where applicable.
- System-generated journals follow their originating transaction/module rules.
- Posted dimension assignments remain immutable.

## Decisions 79–92 (verbatim) — APPROVED / FROZEN

Decisions 79–83 confirm the S1 implementation rules; Decisions 84–92 govern S2 (dimensions), the related permission backfill and the ledger dimension filter. This section replaces the earlier placeholder for Decisions 79–83 and the earlier recording of Decisions 84–86.

### Decision 79 — Designated System Account Constraints

- Designated system accounts must remain active, leaf accounts, in base currency, and cannot be control accounts.
- Retained Earnings and Opening Balance Equity must use Equity nature.
- Realized FX Gain/Loss, Unrealized FX Gain/Loss, and Rounding Difference must use Revenue or Expense nature as applicable.
- A designated system account cannot be archived, deleted, retyped incompatibly, or converted into a parent account.
- System engines reference stable designations, not hardcoded account codes.

### Decision 80 — System FX/Revaluation Journal Reversal

- System FX/revaluation journals cannot be manually reversed through the generic journal reversal mechanism.
- Generic reversal attempts against such journals must return the appropriate SYSTEM_JOURNAL rejection.
- Corrections must occur through the appropriate FX/revaluation process.
- Ordinary user-created journals continue to use the normal reversal workflow.

### Decision 81 — Base-Currency Change with Pending Journals

- Base currency cannot change after posted transactions exist.
- Pending/draft journal lines that prevent an otherwise eligible base-currency migration must be explicitly cleared before migration.
- Never silently delete pending journals.
- The user must withdraw/clear them or receive a blocking validation.
- Eligible base-currency accounts follow the new base currency.
- Foreign-currency accounts remain unchanged.
- The migration must be audited.

### Decision 82 — Template Account Classification

- Template header/grouping accounts remain unclassified where appropriate.
- Accounts 2120 and 2130 retain their subtype but are not automatically classified as monetary.
- Account 2510 retains its subtype but is not automatically classified as monetary.
- Monetary classification must be explicitly established where required by business configuration.
- Template accounts are not automatically designated as control accounts.
- AR control is established through the Phase 3B Sales configuration.
- Do not infer monetary/control classification from account names or codes.

### Decision 83 — Manual Journal API Field Strictness

- Manual journal APIs must reject unknown fields.
- Manual journal endpoints may accept only explicitly approved normal-journal fields.
- base_only and explicit-base-only fields are internal system-handler concepts and must not be exposed as manual journal API bypasses.
- Both API/domain validation and database safeguards must prevent bypass.

### Decision 84 — Dimension Applicability Mechanism

- Use account scope as the applicability mechanism.
- Each dimension type may be Required or Optional.
- Required dimensions have an applicability scope based on account classification.
- Scope may use account nature and/or subtype.
- Example: Department required for Revenue + Expense.
- In-scope journal lines require the dimension.
- Out-of-scope lines do not.
- Empty scope means no enforcement by default.
- Do not introduce per-account include/exclude rules in S2.
- Keep the model extensible.

### Decision 85 — Manual Journal Header Dimensions

- Manual journals are line-level only in S2.
- No manual-journal header dimensions.
- No header-to-line inheritance for manual journals.
- Operational documents may use document-level dimensions only where explicitly supported by their module.
- Do not add an unnecessary manual-journal inheritance mechanism.

### Decision 86 — Dimension Enforcement Timing

- Required dimensions are validated at both submission and posting.
- Posting validation is authoritative.
- If a dimension requirement changes after submission, posting must revalidate against the current requirement and block if necessary.
- Never auto-insert missing dimensions.
- User must withdraw/edit and supply the required dimension.

### Decision 87 — Journal Reversal Dimensions

- Reversals copy all original dimension assignments.
- Preserve original dimension values even if they are now archived.
- Newly introduced required-dimension rules do not apply to the reversal.
- Reversal remains fully audited and linked to the original journal.
- Reversal cannot be used to create arbitrary new dimension assignments.

### Decision 88 — Archived Dimension Values on Existing Drafts

- A dimension value must be active when newly assigned.
- If a draft already contains a dimension value and that value is subsequently archived, the existing assignment may remain.
- The draft may still be submitted and posted with that existing archived value.
- Archived values must not be offered for new assignments.
- Preserve historical/draft continuity while preventing new use of obsolete values.

### Decision 89 — Dimension Scope: Nature + Subtype

- Dimension applicability may be scoped by account nature.
- Dimension applicability may also be scoped by account subtype.
- Both mechanisms may be used for precise applicability.
- No guessing or automatic applicability outside configured scope.
- This remains within the account-scope mechanism of Decision 84.

### Decision 90 — Existing-Organization Permission Backfill

- New permissions must be added to existing organizations through an additive migration.
- Existing custom permissions must not be overwritten, removed, or reset.
- Permission backfill must be audited.
- Existing Owners retain required access.
- Follow the permission-backfill principle established in Decision 65.

### Decision 91 — Dimension Permission for Journal Entry

- accounting.dimensions.view is required to view/select dimension types and values.
- Journal create/edit permissions remain separate.
- Do not introduce accounting.dimensions.assign in S2.
- Custom roles are not automatically granted dimension-view access merely because they have journal-create permission.
- If required dimensions apply but the user cannot access the dimension data, submission/posting must not bypass the requirement.

### Decision 92 — Ledger Dimension Filter Permission

For `GET /accounting/ledger?dimensionValueIds=...` the requester must have `accounting.dimensions.view` in addition to the existing `accounting.ledger.view`.

1. Unfiltered ledger: requests without `dimensionValueIds` continue to require only `accounting.ledger.view`; existing behavior unchanged.
2. Dimension-filtered ledger: if `dimensionValueIds` is supplied, require `accounting.ledger.view` AND `accounting.dimensions.view`.
3. Unauthorized request: if `dimensionValueIds` is supplied and the user lacks `accounting.dimensions.view`, return HTTP 403; do not expose dimension type/value names or dimension metadata.
4. Authorized request: existing dimension filtering and `taggedActivityOnly` behavior remain unchanged.
5. No bypass: the permission is enforced server-side, not only by frontend visibility.

## S3 decisions — Financial Statements (APPROVED / FROZEN)

Approved 2026-09-28 as proposed in the S3 architecture review. Decision 53 subtype codes are unchanged (`OPERATING_REVENUE`, `OTHER_INCOME`, `COST_OF_SALES`, `OPERATING_EXPENSE`, `OTHER_EXPENSE`); P&L section labels are presentation only.

- **S3-01 — Report permission key.** `accounting.reports.view` (Decision 65) governs the Trial Balance, Profit & Loss, Balance Sheet and their exports. No `reports.financial.*` keys and no separate export key.
- **S3-02 — Reports permission backfill.** Migration `0009_reports_permission_backfill`: additive, audited; Owner, Administrator and Member receive `accounting.reports.view` (Owner granted by the migration itself). Planned migrations 0009–0018 become 0010–0019.
- **S3-03 — Dimension filters on statements** require `accounting.dimensions.view` in addition to `accounting.reports.view` (as Decision 92); 403 without it, with no metadata exposed.
- **S3-04 — Module placement.** Aggregation SQL in `modules/accounting/balances.ts`; pure statement composition in `modules/reports` (no tables); orchestration in `application/report-service.ts`; routes in `api/v1/reports.routes.ts`.
- **S3-05 — Source data.** Only journals in status POSTED or REVERSED, with their stored base amounts. No operational, draft or pending data.
- **S3-06 — Virtual year-end.** For a report fiscal year starting on S: retained earnings = the designated Retained Earnings account balance + the net of all P&L activity before S; current-year earnings = P&L net from S to the as-of date; P&L accounts restart at zero at S; no journals are written.
- **S3-07 — Fiscal-year requirement.** The Balance Sheet as-of date and the Trial Balance range must fall inside a defined fiscal year, otherwise `409 FISCAL_YEAR_NOT_FOUND`. A P&L range only needs valid dates.
- **S3-08 — Trial Balance range and mode.** From–to inside one fiscal year, presented after the virtual close (P&L accounts fiscal-year to date; prior-year P&L folded into Retained Earnings).
- **S3-09 — Trial Balance columns.** Opening and closing are net and one-sided (the column follows the sign); period debit and credit are gross movements.
- **S3-10 — Natural sign.** P&L and Balance Sheet show each nature's normal balance as positive; contra and abnormal balances show negative and are never reclassified.
- **S3-11 — P&L sections** by leaf subtype: Revenue (`OPERATING_REVENUE`), Cost of Goods Sold (`COST_OF_SALES`), Gross Profit, Operating Expenses (`OPERATING_EXPENSE`), Operating Profit, Other Income (`OTHER_INCOME`), Other Expenses (`OTHER_EXPENSE`), Net Profit. Trees are pruned per section with section-partial parent subtotals. Unclassified revenue/expense accounts get their own sections and a warning; gross and operating profit exclude them; net profit includes everything.
- **S3-12 — Balance Sheet sections.** Current / non-current assets and liabilities by subtype plus unclassified sections; equity shows its leaves except the designated Retained Earnings account, then one Retained Earnings line (account + computed) and a Current-Year Earnings line.
- **S3-13 — Retained Earnings designation.** Balance Sheet `409 DESIGNATION_REQUIRED` without a valid designation; P&L unaffected; Trial Balance shows a computed prior-years row with a warning.
- **S3-14 — Zero and archived rows.** Rows whose opening, movement and closing are all zero are hidden by default (`includeZero` shows them); archived accounts with a non-zero figure always show, flagged.
- **S3-15 — Currency.** Base currency; optional account-currency column for foreign leaves (normal lines only, never rolled up, base-only lines excluded per Decision 71); no presentation-currency translation.
- **S3-16 — Dimension filter semantics.** AND across types, one value per type; `taggedActivityOnly` on every statement; balancing checks `NOT_APPLICABLE` when filtered.
- **S3-17 — Integrity.** Every statement returns integrity checks (TB debits = credits; assets = liabilities + equity; current-year earnings = P&L net) with differences; `OUT_OF_BALANCE` is shown and logged, never hidden or auto-corrected.
- **S3-18 — Comparatives.** One optional comparison column (previous period, previous year, custom) for the P&L and Balance Sheet.
- **S3-19 — Drill-down.** Via the existing ledger and journal endpoints and permissions; ledger parameter `openingBasis=fiscal_year` makes P&L-account openings match the Trial Balance.
- **S3-20 — Export scope.** S3 delivers the export-ready row model; CSV/XLSX files in S6 (XLSX after Decision 62 approval); PDF after the Decision 43 evaluation.
- **S3-21 — No caching or snapshots** (R29); indexes only on measured need (Decision 47).
- **S3-22 — Rounding.** No report-time conversion or rounding; every figure is an exact sum of stored amounts.
- **S3-23 — Default filters.** TB and P&L default to the current fiscal year to today; Balance Sheet defaults to today; `periodId`/`fiscalYearId` expand to their dates; closed periods are always readable.
- **S3-24 — Parent rows** are the sum of their descendants; parents never receive postings; drilling into a parent opens the ledger for all descendants.

## S4 decisions — Organization Legal Profile and Party Master (APPROVED / FROZEN)

Approved 2026-09-28 as proposed in the S4 architecture review (conflicts K-1 to K-5 resolved by S4-03, S4-05, S4-19, S4-20 and S4-21).

- **S4-01 — Module ownership.** `organizations` owns the profile and organization addresses; the new `parties` module owns parties, roles, contacts and addresses and exposes a read contract for 3B. No other module writes party tables.
- **S4-02 — Profile shape.** Legal name (required on save), trading name, registered and business addresses (structured), TIN, GST registration (flag, number, from-date), email, phone, website, `identifiers` as `[{scheme, value}]`.
- **S4-03 — Logo deferred to S5.** Column, upload and display ship with S5 storage.
- **S4-04 — No inferred profile.** Empty until an authorized user saves it; `organizations.name` stays the display name.
- **S4-05 — Country reference table.** Seeded ISO 3166-1 alpha-2 (249 codes), global and read-only; inactive countries not newly selectable.
- **S4-06 — No statutory format validation** for TIN or identifiers in Phase 3A.
- **S4-07 — GST consistency.** A GST-registered organization needs its registration number (DB check and API validation).
- **S4-08 — Party kinds and names.** `organization` | `individual`; `display_name` required, defaulting to "first last" for individuals; roles `customer`, `vendor`, `employee`, `other` (zero or more).
- **S4-09 — Optional unique reference**, case-insensitive per organization.
- **S4-10 — Contact persons.** Many per party; at most one primary; `receives_documents` flag; at least one name part.
- **S4-11 — Archive and restore; no party deletion.** Contacts and addresses may be deleted under `parties.update`, audited.
- **S4-12 — Re-authentication for tax-identity changes** (TIN or GST registration) on the profile.
- **S4-13 — Duplicate hints, never blocking** (same TIN, email or normalized display name among active parties).
- **S4-14 — Optimistic concurrency.** Parties and the profile carry `version`; stale updates get `409 VERSION_CONFLICT`.
- **S4-15 — Party search with `pg_trgm`.** Trigram "contains" search over names, reference, email and TIN; cursor pagination on `(lower(display_name), id)`.
- **S4-16 — Permissions.** Frozen `parties.view/create/update/archive` and `organization.read/update`; contacts, addresses and roles under `parties.update`.
- **S4-17 — Parties permission backfill inside `0011_parties`** (additive, audited; Administrator all, Member view, Owner all granted by the migration).
- **S4-18 — Deferred party defaults.** No default dimensions, accounts or tax on parties; customer currency, terms and credit limit stay on the 3B Customer record.
- **S4-19 — Personal data in audit.** Values only for business fields (display name, reference, TIN, roles, status); personal contact values by field name only.
- **S4-20 — All four roles assignable in 3A** under `parties.update`; 3B defines what additionally needs `customers.*`.
- **S4-21 — Party GST status deferred to 3B.**
- **S4-22 — Strict S4 API contracts**; `archive`/`restore` take `{}` only.

## S5 decisions — File Storage and Background Job Runner (APPROVED / FROZEN)

Approved 2026-09-28 as proposed in the S5 architecture review: rulings K-1 to K-7 **APPROVED**, S5-01 to S5-22 **APPROVED AND FROZEN**. Out of scope for S5 (not approved for implementation): storage quotas, user-managed legal hold, mandatory malware scanning, the S3-compatible production adapter, upload idempotency keys and an admin jobs dashboard.

### Rulings K-1 to K-7

| #   | Ruling (approved option)                                                                                                                                                         | Sources            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| K-1 | **Legal hold is system-managed only in 3A.** Set by later modules (for example issued PDFs in 3B); no user API and no new permission key.                                        | 6, 29, 65          |
| K-2 | **RLS on `jobs` plus a narrow `SECURITY DEFINER` claim function** (`app_claim_jobs`), following the invitation-resolver precedent; not a system table without RLS.               | Plan §6.4/§6.5; 20 |
| K-3 | **Journal attachments: add at any status, remove only while the journal is a draft** (option b). Evidence can be added later; nothing is silently removed from a posted journal. | 52 (R35), 65       |
| K-4 | **Every upload names its target** (no orphan uploads).                                                                                                                           | 65                 |
| K-5 | **Download-token key derived by HKDF from `SESSION_SECRET`** with a dedicated label (no new secret).                                                                             | 76                 |
| K-6 | **The logo accepts PNG, JPEG and WebP only** (narrowing Decision 61; no new type), within the 25 MB limit.                                                                       | 61, S4-03          |
| K-7 | **Storage quotas per organization: deferred.**                                                                                                                                   | –                  |

### S5-01 to S5-22

- **S5-01 — Module ownership.** A `files` module (storage service, provider interface, local provider, type detection, tokens) and a `jobs` module (runner, registry, enqueue). An application-layer attachment-target registry maps link types to resolvers and permissions.
- **S5-02 — Provider interface and local provider.** `put(key, stream)`, `get(key)`, `delete(key)`, `exists(key)`. The local provider writes under the configurable `STORAGE_LOCAL_ROOT` (default `.data/storage`) and refuses keys outside the root. The S3 adapter waits for the Decision 62 evaluation.
- **S5-03 — Tenant-prefixed, server-generated storage keys** `org/{orgId}/{yyyy}/{mm}/{fileId}`, never derived from user input.
- **S5-04 — One link per file, required at upload** (K-4). Link types in S5: `organization_logo`, `party`, `journal`; S6 adds `import_batch` and `export`.
- **S5-05 — Inherited permissions** (Decision 65): `organization_logo` view `organization.read` / change `organization.update`; `party` view `parties.view` / change `parties.update`; `journal` view `accounting.journals.view` / change `accounting.journals.edit_draft`.
- **S5-06 — Magic-byte type detection** with the Decision 61 allowlist: in-house detectors, a minimal ZIP central-directory check for XLSX and a UTF-8/no-NUL check for CSV. A declared extension that disagrees with the detected type → 415. Per-link-type allowlists narrow this further (S5-11).
- **S5-07 — Scanning hook.** A `FileScanner` interface, `NoopScanner` by default, `scan_status` stored, quarantined files never downloadable.
- **S5-08 — Signed download tokens** (K-5): a stateless HMAC token bound to file, organization, user and expiry (5 min, Decision 76, configurable); key derived from `SESSION_SECRET` by HKDF; constant-time verification; if a session is present it must be the same user.
- **S5-09 — Safe delivery headers:** `Content-Disposition: attachment` (RFC 5987 filename), `nosniff`, `CSP: sandbox`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`.
- **S5-10 — No new permission keys and no backfill.**
- **S5-11 — Organization logo.** `logo_file_id` on the profile (S4-03); PNG, JPEG and WebP only (K-6); replacing it soft-deletes the old file; managed by `organization.update` through dedicated endpoints; it doesn't change the profile `version`.
- **S5-12 — Logo change is separate from the profile's optimistic-concurrency version.**
- **S5-13 — Soft delete, retention and legal hold** (K-1). Delete sets `purge_after` to now + 90 days (configurable). Legal hold blocks delete and purge and is system-managed only in 3A.
- **S5-14 — Job runner.** PostgreSQL `jobs` table, claiming through `app_claim_jobs` (K-2), per-job tenant context. Retries: 5 attempts with backoff min(5 s × 6^(n−1), 15 min) ±20% jitter; a 10-minute stale-lock threshold reclaims jobs; then dead letter plus a `job.failed` audit event. Poll interval and concurrency configurable.
- **S5-15 — Idempotent enqueue.** Unique `(organization, type, job_key)`; enqueueing again returns the existing job whatever its status. Handlers must be idempotent.
- **S5-16 — Job visibility.** `GET /jobs/:id` for the creator or a holder of the job's stored `required_permission`; other tenants get 404. No public enqueue endpoint.
- **S5-17 — Worker placement.** In-process in the API server, started like the outbox dispatcher and switched by `JOBS_WORKER_ENABLED`, so a separate worker process can be added later without code changes.
- **S5-18 — Audit events.** `file.uploaded`, `file.deleted`, `file.purged`, `organization.logo_changed`, `job.failed` (system actor, when dead-lettered). Downloads aren't audited individually. Error messages carry no personal data.
- **S5-19 — `files.purge` handler and scheduler.** Hourly (configurable), organizations with due purges are found through a narrow definer function returning IDs only; one date-keyed `files.purge` job per organization removes the objects, marks files `purged` and sweeps orphaned objects.
- **S5-20 — Journal attachments** (K-3 option b): add at any journal status under `accounting.journals.edit_draft`; view under `accounting.journals.view`; remove only while the journal is a draft. Attachments never change journal data.
- **S5-21 — Strict contracts and upload transport.** Raw `application/octet-stream` body with an `X-File-Name` header, accepted only on `POST /files`; streaming upload with a 25 MB cap; all JSON and query schemas strict.
- **S5-22 — Frontend.** `FileUpload` (progress via `XMLHttpRequest`), `AttachmentsCard` on the Party and Journal detail pages, the logo on the Company profile page, and a `useJob` hook. No new dependencies.

### Implementation notes (S5, 2026-09-28; within the approved decisions)

- Migrations `0012_files` (files, file_links, `organization_profiles.logo_file_id`, `app_organizations_with_due_file_purges()`) and `0013_jobs` (jobs, idempotency index, `app_claim_jobs()`); RLS on all three tables; grants SELECT, INSERT, UPDATE only; definer functions executable by `intuit_app` only.
- The provider interface also has `list(prefix)`, which the S5-19 orphan sweep needs; it walks a single tenant prefix.
- The delivery CSP is `sandbox; default-src 'none'` (S5-09's `sandbox`, with no resource loading).
- Token format per the proposal: `base64url(fileId.orgId.userId.exp).base64url(HMAC-SHA256)`, HKDF label `intuit2 file-download v1`.
- Orphan sweep grace: objects younger than one hour are kept (uploads still committing).
- Download tokens are redacted from request logs (`token=[REDACTED]`).
- **Erratum (comments only):** two comments in the applied migration `0013_jobs.sql` cite S5-16 for idempotent enqueue and S5-18 for job visibility; the correct references are **S5-15** and **S5-16**. Applied migrations are checksum-protected and not edited.

## S6 decisions — Import and Export (APPROVED / FROZEN)

Approved 2026-09-28 as proposed in the S6 architecture review: rulings L-1 to L-12 **APPROVED**, S6-01 to S6-46 **APPROVED AND FROZEN**, with the three corrections below.

Out of scope for S6 (not approved for implementation):

- XLSX, pending Decision 62 (see the [XLSX evaluation](../xlsx-evaluation.md));
- PDF (Decision 43);
- update/upsert imports, automatic undo, custom fields, party merge and transcoding;
- OFX/QIF, scheduled exports;
- anything from S7–S10 or Phase 3B.

### Rulings L-1 to L-12

| #    | Ruling (approved option)                                                                                                                                                                                                           | Sources       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| L-1  | **Validate every row, show the first 500**; the full error report is downloadable.                                                                                                                                                 | 61            |
| L-2  | **Import domains:** chart of accounts, parties, party contacts, dimension values, exchange rates and **draft** manual journals.                                                                                                    | Plan, 7       |
| L-3  | **CSV only now.** S6 delivers the XLSX evaluation report; XLSX follows after Decision 62 approval.                                                                                                                                 | S3-20, 62, 75 |
| L-4  | **UTF-8 only** (S5-06 unchanged); the UI tells users to save as "CSV UTF-8".                                                                                                                                                       | S5-06         |
| L-5  | **Exports are capped at 25 MB** and fail with guidance.                                                                                                                                                                            | 61            |
| L-6  | **Acting-user context for background work:** resolved from user plus organization at job time, with the same membership, role and permission checks and no session ID.                                                             | Auth design   |
| L-7  | **In-transaction variants** of the S1/S2/S4 service operations; the HTTP paths call the same code.                                                                                                                                 | C1 precedent  |
| L-8  | **Provenance on imported drafts:** `source='manual'`, `source_module='data_exchange'`, `source_type='import_batch'`, `source_id` = batch.                                                                                          | 12            |
| L-9  | **Amends ADR 0002 D19:** a terminal `DISCARDED` journal status (a status change, never a deletion), allowed only for never-submitted imported drafts; per-journal and batch-level "discard untouched import drafts", both audited. | D19           |
| L-10 | **Create-only imports** in 3A.                                                                                                                                                                                                     | 65            |
| L-11 | **Staging redaction** of `raw` and `normalized` 30 days after the batch ends; counts and error codes are kept. This is not the R32 erasure policy.                                                                                 | R32           |
| L-12 | **Export generation is audited** (`export.generated`); downloads stay unaudited.                                                                                                                                                   | S5-18         |

**Corrections given with the approval:**

1. **Exchange-rate imports use the existing setup permission.** The approval named `accounting.setup.manage`, but that key doesn't exist. The existing key is **`accounting.setup`** (Decision 65, the key `recordExchangeRate` uses), and it is the one used, per the instruction's intent ("existing permission", no new keys).
2. **Party-contact imports use `parties.update`.**
3. **Export reads and download links re-check current authorization and tenant isolation** on every request: the creator or a holder of the domain's view permission, re-resolved now, not at creation.

### S6-01 to S6-46

**Batch A — Core architecture and data model**

- **S6-01 — Module ownership.**
  - A `data-exchange` module owns batches, rows, mappings, exports, the CSV reader/writer and formula neutralization.
  - An application-layer domain registry supplies each domain's fields, validation, commit or row source, and permission.
- **S6-02 — Migration `0014_data_exchange`.**
  - Tables `import_batches`, `import_rows` (row number 1–25,000), `import_mappings` and `exports`.
  - `file_links.link_type` gets `import_batch` and `export`.
  - RLS on all tables; grants SELECT, INSERT, UPDATE.
- **S6-03 — Batch state machine:** `awaiting_file` → `ready` → `validating` → `validated` / `failed_file` → `committing` → `committed`, plus `needs_review`, `cancelled` and `expired`. Optimistic `version`.
- **S6-04 — Row staging:** `raw`, `normalized`, `status`, `excluded`, `messages[]`, `group_key` and `record_id`.
- **S6-05 — Import domains** per L-2.
- **S6-06 — Export domains:** chart of accounts, parties, dimension values, journals, general ledger, Trial Balance, P&L, Balance Sheet, and the import error report.
- **S6-07 — Create-only** (L-10).
- **S6-08 — In-transaction domain operations** (L-7). data-exchange never writes other modules' tables.
- **S6-09 — Acting-user context** (L-6).
- **S6-10 — Jobs:** `import.validate`, `import.commit`, `export.generate` and `data_exchange.cleanup`, with job keys per batch or export (and mapping version). Everything is asynchronous except `inspect` and templates.

**Batch B — Validation, accounting and integrity**

- **S6-11 — Validation is the dry run:** shared rule functions plus cross-row state; no domain writes; no per-row savepoints.
- **S6-12 — Re-validation inside the commit transaction.** Any failure rolls back fully and ends in `needs_review`.
- **S6-13 — All-or-nothing commit** with explicit row exclusions. A journal can only be excluded whole.
- **S6-14 — Commit gating:** zero errors among included rows, acknowledged warnings, and a matching `version`.
- **S6-15 — Journals import as DRAFT only.** The import never submits, approves or posts.
- **S6-16 — Journal rules = manual-journal rules:**
  - one currency and one rate per journal;
  - no base-only lines or explicit base amounts;
  - control accounts rejected;
  - the Decision 11 currency rule;
  - Decisions 78, 84–92 for dimensions;
  - balanced per journal key.
- **S6-17 — Provenance** (L-8).
- **S6-18 — Imported drafts can be discarded** (L-9).
- **S6-19 — Chart of accounts rules:**
  - code pattern and uniqueness;
  - nature/subtype (Decisions 53, 54);
  - parents in the database or in the file, in topological order with cycle detection;
  - no designations, control or system settings (Decisions 14, 79, 82).
- **S6-20 — Party and contact rules:**
  - S4 rules;
  - a conflicting reference is an error;
  - S4-13 duplicate hints are warnings;
  - S4-19 applies to audit data.
- **S6-21 — Dimension value and exchange rate rules:**
  - dimension values only under existing active types;
  - rates follow `recordExchangeRate`, and duplicates are errors.
- **S6-22 — Duplicates and exactly-once commit:**
  - the batch state machine, the row lock and the job key make each commit exactly-once;
  - a file with the same sha256 as an earlier committed batch needs acknowledgement;
  - in-file duplicates are errors;
  - existing codes and references are errors;
  - matching journals are warnings.
- **S6-23 — Normalization:** explicit date format, no guessing, exact decimals.
- **S6-24 — Recovery:** crash-safe; no automatic undo beyond existing tools and S6-18.
- **S6-25 — Opening-balance hooks only;** the behaviour belongs to S8.

**Batch C — Export, jobs, files, security and permissions**

- **S6-26 — Export pipeline:** streamed from the same service queries, filters and permissions as the UI; stored as generated S5 files.
- **S6-27 — Export expiry:** 7 days, then the S5 purge.
- **S6-28 — 25 MB export cap** (L-5).
- **S6-29 — Statement exports** have a titled preamble; list exports are plain, re-importable tables.
- **S6-30 — Keyset-paged ledger and journal exports**, respecting Decision 92.
- **S6-31 — File integration:**
  - `import_batch`: CSV only, uses the domain create permission, and the file can't be deleted while the batch is validating or committing;
  - `export`: no user uploads; access for the creator or a view-permission holder;
  - an in-transaction generated-file path.
- **S6-32 — No new permission keys.** Imports use the target's create permission (party contacts: `parties.update`; exchange rates: `accounting.setup`; journals: `accounting.journals.create`, plus `accounting.dimensions.view` when dimension columns are mapped). Exports use the target's view permission. Batches and exports are visible to the creator or a domain-permission holder.
- **S6-33 — Audit events:**
  - `import.created`, `import.committed`, `import.cancelled`, `import.needs_review` and `export.generated`;
  - each created record gets its normal domain audit.
- **S6-34 — Security controls:**
  - formula neutralization with the round-trip escape;
  - parser hardening;
  - no imported values in logs;
  - RLS and tenant job context.
- **S6-35 — Concurrency:**
  - one active job per batch;
  - the `version` check;
  - at most 3 imports validating or committing per organization;
  - the database unique constraints decide races;
  - statements read one snapshot.
- **S6-36 — Staging retention** per L-11. Uncommitted batches expire after 7 days.

**Batch D — UX, formats, limits and edge cases**

- **S6-37 — Formats:** CSV now; XLSX after Decision 62, with the evaluation delivered (L-3).
- **S6-38 — UTF-8 only** (L-4).
- **S6-39 — CSV dialect:**
  - RFC 4180, streamed;
  - BOM tolerated;
  - comma, semicolon or tab detected, with an override;
  - a header row is required, and duplicate or blank headers are errors;
  - ragged rows are errors;
  - output is UTF-8 with BOM, CRLF line endings and quoted text.
- **S6-40 — Limits** (configurable, never above the frozen maxima):

  | Limit                                       | Value             |
  | ------------------------------------------- | ----------------- |
  | File size                                   | 25 MB             |
  | Rows                                        | 25,000            |
  | Preview                                     | 500 rows          |
  | Columns                                     | 200               |
  | Cell length                                 | 10,000 characters |
  | Record length                               | 1 MB              |
  | Active imports per organization             | 3                 |
  | Batch expiry                                | 7 days            |
  | Export expiry                               | 7 days            |
  | Export size                                 | 25 MB             |
  | Commit `statement_timeout` / `lock_timeout` | 10 min / 10 s     |

- **S6-41 — Templates** share columns with exports (round trip).
- **S6-42 — Mapping:** auto-suggest, user confirmation and saved named mappings; no custom fields.
- **S6-43 — Preview semantics** (L-1).
- **S6-44 — UX:**
  - the wizard, import history and the Exports list;
  - export actions on the account, party, dimension, journal, ledger and statement pages;
  - permission-aware; `useJob`.
- **S6-45 — Edge-case catalogue**, each case tested.
- **S6-46 — Strict API contracts.**

### Implementation notes (S6, 2026-09-28; within the approved decisions)

**Routes** (under `/api/v1`):

| Area                  | Routes                                                                                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog and templates | `GET /imports/catalog` (the domains the user can import, with field catalogues); `GET /imports/templates/:domain` (`text/csv`)                                                                                                                                                           |
| Batches               | `GET`/`POST /imports`, `GET /imports/:id`, `POST /imports/:id/inspect`, `PUT /imports/:id/mapping`, `PUT /imports/:id/exclusions`, `GET /imports/:id/rows`, `POST /imports/:id/commit`, `POST /imports/:id/cancel`, `POST /imports/:id/discard-drafts`, `POST /imports/:id/error-report` |
| Saved mappings        | `GET`/`POST /import-mappings`, `DELETE /import-mappings/:id` (soft delete)                                                                                                                                                                                                               |
| Exports               | `GET`/`POST /exports`, `GET /exports/:id`, `GET /exports/:id/download-url`                                                                                                                                                                                                               |

Journals also get `POST /accounting/journals/:id/discard` (`accounting.journals.edit_draft`).

**Row exclusions** use their own endpoint. Changing them re-runs validation, so counts and gating always reflect the included rows.

**DISCARDED:**

- The replaced journal guard allows `DRAFT` → `DISCARDED` only for a never-submitted `data_exchange`/`import_batch` draft, with no other column changed. A `DISCARDED` journal is immutable.
- The comparisons are NULL-safe.
- The default journal list hides `DISCARDED`; filtering by status shows them.

**Batch lifecycle details:**

- `failed_file` is terminal: fix the file and start a new batch.
- Staged rows never exceed the batch limit.
- The import file is soft-deleted when the batch ends (S5-13).

**Journal exports** include dimension columns only when `includeDimensions` is requested **and** the user holds `accounting.dimensions.view` (Decision 91).

**Statement and ledger exports:**

- Ledger balances use fixed 4-decimal amounts.
- The P&L total row is "Net Profit (Loss)".

**Audit:**

- The batch-level discard is audited as `import.drafts_discarded`; each discarded journal as `journal.discarded`.
- Generated export files aren't audited separately; `export.generated` covers them.

**Configuration** (`.env.example`):

- `IMPORT_MAX_ROWS`, `IMPORT_PREVIEW_ROWS`, `IMPORT_MAX_ACTIVE_PER_ORGANIZATION`, `IMPORT_BATCH_EXPIRY_DAYS`, `IMPORT_STAGING_RETENTION_DAYS`;
- `IMPORT_COMMIT_STATEMENT_TIMEOUT_SECONDS`, `IMPORT_COMMIT_LOCK_TIMEOUT_SECONDS`;
- `EXPORT_MAX_BYTES`, `EXPORT_EXPIRY_DAYS`;
- `DATA_EXCHANGE_CLEANUP_INTERVAL_MINUTES`.

**Cleanup discovery:** `app_organizations_with_data_exchange_work()` (SECURITY DEFINER, IDs only, executable by `intuit_app` only) finds organizations with expirable batches or exports, or staging due for redaction.

**Format-neutral seam:** domain code sees only typed cells. CSV reading and writing are confined to the import and export services, which is where XLSX will plug in. There are no separate `TabularReader`/`TabularWriter` types yet.

**The S8 re-authentication hook** (`reauthenticated_at` on the batch) isn't added in S6, because no S6 domain needs it. S8 adds it in its own migration.

**Throughput** (development machine, 25,000 rows):

| Import                   | Validation | Commit   |
| ------------------------ | ---------- | -------- |
| Parties                  | ≈2.5 s     | ≈7.5 min |
| 12,500 two-line journals | ≈20 s      | ≈54 s    |

The commit reuses the audited domain services row by row (L-7) inside one transaction, so it is bounded by the commit `statement_timeout` (10 min).

**Test harness:** job-worker and permission-backfill test files run in a serial Vitest project, because the worker claims every due job and the backfill replays deadlock with parallel organization registration.

## S7 decisions — Multi-Factor Authentication (APPROVED / FROZEN)

Approved 2026-09-28 as proposed in the S7 architecture review: S7-01 to S7-46 **APPROVED AND FROZEN**, with these rulings on the judgment items:

| Item  | Ruling                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------- |
| S7-07 | User-keyed RLS on the credential tables, plus a SECURITY DEFINER function for the admin reset.          |
| S7-10 | `qrcode-generator`, subject to Decision 62 verification ([QR evaluation](../qr-library-evaluation.md)). |
| S7-11 | SHA-1, 6 digits, 30-second step, ±1 step.                                                               |
| S7-18 | 10 recovery codes, Argon2id, single use.                                                                |
| S7-23 | No in-app recovery for an Owner who has lost the authenticator **and** every recovery code.             |
| S7-28 | The high-privilege set is not expanded beyond Decision 57a.                                             |
| S7-30 | Existing privileged users are enforced on their **next request**.                                       |
| S7-33 | Step-up (a fresh second factor) is required for MFA management and security actions only.               |
| S7-34 | Remembered devices last at most 30 days.                                                                |
| S7-36 | Organization option "Allow remembered devices", default on.                                             |
| S7-37 | Cross-tenant admin MFA reset is restricted (**amends Decision 72**, below).                             |

**Confirmed onboarding behaviour:** registration creates an Owner, and Owner MFA is mandatory (Decision 57a). Every newly registered account therefore completes MFA enrollment before it can use its organization.

Out of scope for S7: WebAuthn/passkeys, SMS, email OTP, biometrics, SSO and external identity providers, the ownership-transfer workflow, and `sales.settings.manage` (Phase 3B).

### Amendment to Decision 72 (S7-37)

Decision 72 lets an Administrator (`members.manage` + re-authentication) reset a member's MFA, except the Owner's. MFA factors belong to the user account, not to one organization, so a reset in one organization would also remove the user's second factor everywhere else. **Refinement:** an admin reset is refused when the target:

- is an Owner of **any** organization; or
- has a membership (active or disabled) in **any other** organization.

Such users recover with their recovery codes. Decision 72's other rules stand (never the Owner; `members.manage` + re-authentication; S7-33 adds step-up).

**Final ruling (2026-09-29, S7 acceptance):** this stricter reading is the approved S7-37 decision. Any membership in another organization blocks the reset, **including a disabled one**. Resets also stay blocked for Owners, for the administrator themselves, and in every cross-organization case. S7 is closed.

### S7-01 to S7-46

**Batch A — Architecture and database**

- **S7-01 — Module ownership.**
  - `identity` owns factors, recovery codes and trusted devices.
  - `infrastructure/security` owns TOTP, base32, the AES-GCM key ring, recovery-code format and the QR renderer.
  - The application layer owns `MfaService`, `MfaVerifier`, the MFA policy and `OrganizationSecurityService`.
  - There is one identity (`users.id`).
- **S7-02 — Factor model** `mfa_factors` (type `totp`; status pending/active/revoked) with a factor verifier. WebAuthn later adds a detail table and a type.
- **S7-03 — MFA state on the existing `sessions` row:** `mfa_pending_until`, `mfa_method`, `mfa_verified_at`, `mfa_failed_attempts`.
- **S7-04 — `mfa_recovery_codes`:** a lookup id in clear plus an Argon2id hash.
- **S7-05 — `trusted_devices`:** a SHA-256 token hash, the previous hash (for reuse detection), and an absolute expiry of at most 30 days.
- **S7-06 — `organization_security_policies`** (tenant RLS, `version`).
- **S7-07 — User-keyed RLS and a definer reset** (ruling above).
- **S7-08 — Migration `0015_mfa`.** No backfill; existing sessions are not MFA-verified.
- **S7-09 — Secret encryption.**
  - AES-256-GCM with the environment key ring (`MFA_ENCRYPTION_KEYS`, `MFA_ENCRYPTION_ACTIVE_KEY_ID`).
  - The additional authenticated data binds each ciphertext to its factor and user.
  - The application role cannot update the secret columns.
  - Rotation is a command run as the owner role (`mfa:rotate-keys`).
- **S7-10 — QR renderer** (ruling above).

**Batch B — Enrollment, sign-in, recovery and security**

- **S7-11 — TOTP:** RFC 6238, SHA-1, 6 digits, 30 s, ±1 (configurable to 0, never wider), 160-bit secrets, implemented on `node:crypto`.
- **S7-12 — Enrollment:**
  - needs a recent password (and step-up when replacing);
  - pending for 15 minutes, with 5 attempts;
  - the secret is shown once;
  - one active TOTP factor per user.
- **S7-13 — Manual key entry** (grouped base32, with issuer and account).
- **S7-14 — Sign-in:**
  - a user with an active factor gets an MFA-pending session (10 minutes, 5 codes) unless a valid remembered device is presented;
  - the session token rotates whenever MFA status is gained.
- **S7-15 — Pending sessions are default-deny.** They may use only the challenge, the session read, logout, sign-in and registration. Everything else is refused before any handler runs.
- **S7-16 — Replay protection:** the last-used time step is updated with compare-and-set.
- **S7-17 — Throttling:** failed codes are recorded as failed sign-ins (existing login protection), plus the per-session and per-enrollment caps.
- **S7-18 — Recovery codes** (ruling above). Usable for sign-in and step-up; shown once.
- **S7-19 — Regeneration:** re-authentication and step-up; the previous set is revoked.
- **S7-20 — Exhaustion:** a warning at 3 or fewer codes; no weaker fallback.
- **S7-21 — Self-service:**
  - replacing needs re-authentication and step-up;
  - disabling is allowed only when no organization requires MFA of the user (never for an Owner);
  - replacing keeps the recovery codes.
- **S7-22 — Password reset keeps MFA** and revokes remembered devices.
- **S7-23 — Owner recovery** (ruling above).
- **S7-24 — Clock drift:** ±1 step only; servers must be NTP-synchronized.
- **S7-25 — Security events** without secrets (see implementation notes).
- **S7-26 — Email notices:**
  - MFA enabled, replaced or disabled;
  - recovery code used; codes regenerated;
  - admin reset;
  - device remembered.

**Batch C — Policies, permissions, remembered devices and admin controls**

- **S7-27 — Four enforcement layers:**
  - (A) sign-in challenge when the user has a factor;
  - (B) organization policy;
  - (C) Owner / privileged permission;
  - (D) sensitive-action re-authentication, with step-up for MFA management and security actions.
- **S7-28 — High-privilege set = Decision 57a:** the Owner and holders of `roles.manage`, `members.manage`, `approvals.manage`, `accounting.setup`. Evaluated from effective permissions, so custom roles count. `sales.settings.manage` joins in 3B.
- **S7-29 — Organization policy** "require MFA for all members": `members.manage` plus re-authentication and step-up; evaluated per request.
- **S7-30 — Next-request enforcement** (ruling above). Mid-session role grants take effect immediately.
- **S7-31 — Enforcement points:**
  - `resolveAuthorizationContext` (every organization-scoped operation);
  - the session view;
  - `resolveActingUserContext`: jobs fail permanently when MFA is required of the acting user and they have no factor.
- **S7-32 — Errors:**
  - `MFA_REQUIRED` (401);
  - `MFA_ENROLLMENT_REQUIRED`, `MFA_VERIFICATION_REQUIRED`, `MFA_STEP_UP_REQUIRED` (403);
  - `INVALID_MFA_CODE` (400);
  - `MFA_CHALLENGE_FAILED` (401);
  - `MFA_UNAVAILABLE` (503).
- **S7-33 — Step-up for MFA management and security actions** (ruling above), within 15 minutes. A remembered device never counts.
- **S7-34 — Remembered devices:**
  - opt-in at the challenge;
  - at most 30 days, never sliding (also enforced by a database check);
  - a 256-bit token stored as SHA-256;
  - rotated on every use; reuse of the previous token revokes the device;
  - a cookie that is httpOnly, SameSite=Strict and limited to `/api/v1/auth`;
  - they skip only the sign-in code.
- **S7-35 — Revocation:**
  - by the user (one; or all, with re-authentication and step-up);
  - automatically on password reset, MFA disable or replacement, admin reset and reuse detection;
  - at most 10 devices per user.
- **S7-36 — "Allow remembered devices"** (ruling above). When off, a remembered-device session must enter a code in-session for that organization.
- **S7-37 — Cross-tenant reset restriction** (amendment above).
- **S7-38 — Admin reset:**
  - requires `members.manage`, re-authentication and step-up;
  - never the Owner, never oneself;
  - revokes factors, unused recovery codes, remembered devices and sessions;
  - audited in the organization audit and in security events;
  - the user gets an email notice.
- **S7-39 — Member MFA status** (enrolled / required) visible to `members.manage` holders only.
- **S7-40 — No new permission keys**, no permission backfill.

**Batch D — UX, API, testing and future-proofing**

- **S7-41 — API contracts:**
  - `POST /auth/mfa/challenge`, `GET /auth/mfa`;
  - `POST /auth/mfa/totp/enroll`, `/verify`, `/disable`;
  - `POST /auth/mfa/step-up`, `POST /auth/mfa/recovery-codes`;
  - `GET`/`DELETE /auth/trusted-devices[/:deviceId]`;
  - `GET`/`PUT /organizations/current/security`;
  - `POST /organizations/current/members/:membershipId/mfa-reset`.

  All strict, no-store responses.

- **S7-42 — Frontend:**
  - the sign-in code step and the enforcement screen;
  - enrollment with the QR code and manual key;
  - one-time recovery codes;
  - the combined re-authentication / step-up dialog;
  - Account security, organization Security, and the Members MFA column and reset.
- **S7-43 — Configuration** (`MFA_*`, `TRUSTED_DEVICE_*`), bounded by the frozen values.
- **S7-44 — Test harness:** the test client enrolls and answers challenges like a user when asked; there is no enforcement-bypass flag.
- **S7-45 — Browser E2E.**
- **S7-46 — WebAuthn-ready factor registry and deferred list.**

### Implementation notes (S7, 2026-09-28; within the approved decisions)

**Security events:**

- sign-in: `auth.mfa_challenge_required`, `auth.mfa_succeeded`, `auth.mfa_challenge_exhausted`, `auth.mfa_step_up`;
- factor lifecycle: `mfa.enrollment_required` (once per session and organization), `mfa.totp_enrollment_started`, `mfa.totp_enabled`, `mfa.totp_replaced`, `mfa.totp_disabled`;
- recovery codes: `mfa.recovery_codes_generated`, `mfa.recovery_code_used`;
- admin: `mfa.reset_by_admin`;
- remembered devices: `trusted_device.created`, `trusted_device.used`, `trusted_device.revoked`, `trusted_device.reuse_detected`.

Wrong codes are `auth.login_failed` with reason `mfa_invalid_code` or `mfa_invalid_recovery_code`. A complete sign-in is always `auth.login_succeeded`.

**Organization audit:** `organization.security_policy_updated` and `membership.mfa_reset`. The action uses the existing `membership.*` naming rather than the proposal's `member.mfa_reset`.

**Metadata** holds only ids, methods and counts. The audit secret-key filter also drops `totp*`, `otp*` and `recovery_code*` keys.

**Default-deny for pending sessions** is enforced in the session hook, against an allowlist of route patterns: challenge, session read, logout, login and register.

**Key ring and rotation:**

- A missing or invalid key ring stops start-up.
- An unknown key at verification time is `MFA_UNAVAILABLE`, and recovery codes still work.
- `pnpm --filter @intuit-2/api mfa:rotate-keys` re-encrypts under the active key with compare-and-set, and prints counts only.

**Dev seed:** the Owner and Administrator are enrolled through the real verification path with `DEV_SEED_TOTP_SECRET` from the git-ignored `.env`. The secret is never printed. An already-seeded database is upgraded idempotently.

**Frontend session handling:**

- Navigation after sign-in and after the challenge is driven by the session state, not by mutation callbacks.
- MFA setup and step-up update the cached session in place, without clearing other cached data.

**Recovery codes on enrollment:** codes are issued when the user has no unused codes (the first enrollment, or after exhaustion). Replacing an authenticator keeps the existing codes.

## S8 decisions — Opening Balances / Conversion Balances (APPROVED / FROZEN)

Approved 2026-09-29 for implementation: S8-01 to S8-23 **APPROVED AND FROZEN**. Opening balances bring the balances of a prior accounting system into the ledger:

conversion date → opening batch (manual entry or CSV import) → validation and preview → optional approval → re-authenticated posting → one system journal per currency, balanced to Opening Balance Equity → immutable history → batch-level reversal and repost.

Accounting stays the source of truth. There is no parallel ledger and no direct GL write: posting goes through `postSystemJournal`.

### S8-01 to S8-23

- **S8-01 — Ownership.** The Accounting module owns opening balances. No new business module.
- **S8-02 — Migration `0016_opening_balances`.** Schema, RLS, grants and database protections. Migrations 0001–0015 are untouched.
- **S8-03 — States:** `DRAFT`, `PENDING_APPROVAL`, `POSTED`, `REVERSED`. There is **no `READY` state** (see the clarification below).
- **S8-04 — Conversion date.**
  - The conversion date is explicit. The opening journal date is the conversion date minus one day.
  - The opening date must be in an existing fiscal year and an open accounting period.
  - When the fiscal year or period is missing, the preview explains it. Periods are never created automatically.
- **S8-05 — Opening Balance Equity.**
  - Each currency's journal balances automatically to the account designated `OPENING_BALANCE_EQUITY`, which must meet the designation rules (Decision 79).
  - Users cannot enter OBE lines; the system generates the balancing line.
- **S8-06 — Foreign currency.**
  - Amounts are entered in the account's currency.
  - By default the base amount comes from the exchange-rate table at the opening date.
  - Explicit carrying (base) amounts are allowed, all-or-none per currency.
  - The rate and base amounts actually used are kept on the journal. There is no report-time conversion.
- **S8-07 — Receivable and control accounts.**
  - Accounts with `is_control_account = true` and accounts of subtype `ACCOUNTS_RECEIVABLE` are rejected.
  - The message points to the Phase 3B opening-invoice flow.
  - No AR subledger records are created in S8 (Decision 69).
  - **Final ruling (2026-09-29, S8 acceptance):** every account used in an opening balance must have an explicit subtype. Unclassified accounts are rejected. The system never infers a classification.
- **S8-08 — Profit and loss.**
  - P&L balances are rejected when the opening date is the last day of a fiscal year; prior-year earnings belong in Retained Earnings.
  - Mid-year conversions may carry year-to-date P&L balances.
  - The preview explains the rule.
- **S8-09 — Dimensions.**
  - A required, applicable dimension that is missing **blocks** submit and post. It is not a warning, and there is no opening-balance bypass.
  - Optional dimensions may be omitted, and dimensions that do not apply are not asked for.
  - The existing applicability rules (Decisions 84, 89) are reused.
  - Assignments are line-level only, with no header inheritance and no guessing. Posted assignments are immutable.
- **S8-10 — Posting,** in one transaction:
  1. lock the batch row;
  2. check the version;
  3. check the status;
  4. check the approval requirement;
  5. revalidate everything;
  6. check the OBE designation;
  7. check that the period is open;
  8. build one journal per currency;
  9. post the journals through `postSystemJournal`, base currency first;
  10. mark the batch `POSTED`;
  11. write the audit event.

  Any failure rolls everything back, so no batch is ever partly posted.

- **S8-11 — Approval.**
  - Action `accounting.opening_balance.post` in the existing approval framework. The approver permission is `accounting.journals.approve`, and self-approval is not allowed.
  - With a policy: `DRAFT` → `PENDING_APPROVAL` → approval → post.
  - Without a policy, a holder of `accounting.setup` posts directly, with re-authentication.
- **S8-12 — Re-authentication.**
  - Posting, reversing and changing the conversion date use the existing sensitive-action re-authentication.
  - S7-33 step-up (a fresh second factor) is **not** extended to these actions.
- **S8-13 — Conversion date endpoint.**
  - `PUT /accounting/settings/conversion-date` requires `accounting.setup` and re-authentication.
  - It is refused while a batch is `PENDING_APPROVAL` or `POSTED`.
- **S8-14 — Batch-level reversal.**
  - An opening batch is reversed as a whole, atomically, through the existing reversal engine. A revised batch is then entered and posted.
  - Generic reversal of a single opening journal returns a domain error. The original journals stay immutable.
- **S8-15 — Permissions.**
  - Read: `accounting.journals.view`. Write: `accounting.setup`.
  - No new permission keys; `accounting.setup.manage` and `sales.settings.manage` are not used.
- **S8-16 — Import.**
  - The S6 import infrastructure is reused (upload → validate → preview → confirm), with its CSV, size, formula-injection, job and audit protections.
  - An import creates or updates the `DRAFT` batch's lines only and **never posts**.
- **S8-17 — Attachments.**
  - S5 target `opening_balance_batch`: view with `accounting.journals.view`, change with `accounting.setup`.
  - Attachments are added or removed only while the batch is `DRAFT`. Evidence on a posted batch is immutable.
- **S8-18 — Deletion.**
  - A `DRAFT` batch may be deleted, and the deletion is audited.
  - Submitted, posted and reversed history is never physically deleted.
- **S8-19 — Line cap.**
  - The global 500-line journal cap is kept and a currency's journal is never split (Decision 68).
  - That allows at most **499 account lines plus 1 OBE line per currency**. A larger currency is rejected cleanly, with an actionable message.
- **S8-20 — No link table.** A journal's source reference (`accounting` / `opening_balance` / batch id) is the authoritative link to its batch.
- **S8-21 — Audit.**
  - Events: `accounting.conversion_date_changed` and `opening_balance.created`, `.lines_updated`, `.submitted`, `.approved`, `.rejected`, `.withdrawn`, `.posted`, `.reversed`, `.deleted`.
  - Metadata holds ids, counts and totals only. The existing journal events are unchanged.
- **S8-22 — Frontend.** Accounting → Opening Balances, permission-aware. Sections:
  - conversion date, the grid with currency tabs, account search, debit/credit inputs, foreign base amounts and dimensions;
  - running totals, the OBE result, validation messages and preview;
  - import and export;
  - submit, approval status, post with re-authentication, and posted journal links;
  - attachments and reversal.
- **S8-23 — Tests.** Unit, integration, accounting, security, web and browser end-to-end tests with the dev-seed users. The full suite runs three consecutive times.

### Clarification: no `READY` state (S8-03)

The persistent state machine is only `DRAFT`, `PENDING_APPROVAL`, `POSTED` and `REVERSED`.

When the approval request is approved, the batch **stays `PENDING_APPROVAL`**. Whether it may be posted is derived from its approval request, never stored:

- The batch detail returns `approval.readyToPost`. It is true for a `PENDING_APPROVAL` batch whose linked request is approved, and for a `DRAFT` batch when no policy applies.
- `post` checks the same condition inside its transaction.

When an approver rejects the request, the batch returns to `DRAFT`. When an `accounting.setup` holder withdraws it, the request is withdrawn and the batch returns to `DRAFT`. Without a policy there is no request, and a `DRAFT` batch is posted directly.

### Implementation notes (S8, 2026-09-29; within the approved decisions)

**Database (0016):**

- `accounting_settings.conversion_date` is nullable.
- `accounting_opening_balance_batches` holds:
  - the status and the conversion and opening dates, with a CHECK that the opening date is the conversion date minus one day;
  - a version, notes and the approval request (composite tenant FK);
  - who and when for create, update, submit, post and reverse, plus the reversal reason.
  - A state-consistency CHECK ties those columns to the status.
  - A partial unique index allows **one open batch** (`DRAFT`, `PENDING_APPROVAL` or `POSTED`) per organization, so a revised batch can be started only after a reversal.
- `accounting_opening_balance_lines` holds the account (composite tenant FK), one positive side, an optional base amount and line dimensions (a JSON array).
- Triggers:
  - Lines change only while the batch is `DRAFT`.
  - Only a `DRAFT` batch can be deleted, and a batch's identity never changes.
  - The allowed transitions are `DRAFT` → `PENDING_APPROVAL` or `POSTED`, `PENDING_APPROVAL` → `DRAFT` or `POSTED`, and `POSTED` → `REVERSED`. `REVERSED` is final.
  - The dates change only on a `DRAFT` batch.
  - `TRUNCATE` is refused.
- Tenant RLS on both tables. The application role is granted `DELETE` so that drafts can be deleted; the triggers refuse deleting anything else.
- The S6 domain checks gain `opening_balances`, and the S5 link types gain `opening_balance_batch`.

**Journals:**

- One `opening_balance` system journal per currency, the base currency first.
- Date: the opening date. Reference: `Opening <conversion date>`.
- The source reference is the batch.
- With explicit carrying values, every line carries its base amount. The generated OBE line gets the balancing base amount, and the journal records the implied rate with rate source `manual`. Otherwise the table rate is used (`table`).

**Generic reversal (S8-14):**

- `POST /accounting/journals/:id/reverse` on an opening journal returns `409 SYSTEM_JOURNAL`, pointing to the batch.
- The batch reversal uses the same reversal engine in one transaction, dated like the original (the opening date), which must still be in an open period.
- Decision 80's test for `opening_balance` journals now expects this refusal.

**Submission without a policy** returns `409 INVALID_STATE_TRANSITION` ("post them directly").

**Line entry:**

- Saving lines checks the line rules (account, side, precision, base amount) and the version.
- The batch-level rules are checked by preview, submit and post: fiscal year, period, P&L, designation, rates, required dimensions and the line cap.
- An import replaces the draft's lines with the confirmed rows.

**The S6 re-authentication hook** (a `reauthenticated_at` on the import batch, noted under S6) is not needed and was not added, because an opening-balance import never posts (S8-16).

**Unclassified accounts (S8-07 final ruling).** The E2E found that accounts with no subtype (as in organizations created before S1) escaped the receivable rule. The final ruling closes this: an opening balance on an unclassified account is rejected, and the organization classifies the account first (Decision 54).

**Enforcement:** implemented with S9 as its approved prerequisite (N1): the line rules, the entry grid and a database trigger (migration 0017). See the S9 section.

## S9 decisions — Foreign Currency Revaluation Support (APPROVED / FROZEN)

Approved 2026-09-29 with amendments. S9 delivers the revaluation engine only (Decision 9; the user workflow stays in Phase 4):

- the revaluation calculation and the exposure model;
- revaluation runs, their lines, and the run-to-journal links with roles;
- system revaluation journals, and a dedicated system-journal reversal path inside `JournalService`;
- the automatic D + 1 reversal, and cancellation through that reversal path;
- audit events, and a provider interface for future document exposures;
- a development/testing trigger for the browser end-to-end test.

**Not in S9:** HTTP routes, UI, scheduled jobs, the approval workflow, rate override, the unrealized FX report, presentation-currency translation, AR/AP/banking/payroll exposure providers, and automatic rate feeds.

### Frozen rules

- **Calculation.** For each eligible exposure:
  - F = the foreign-currency transaction balance (normal lines only; Decision 71);
  - B = the carrying amount in the base currency (all lines);
  - T = F × closing rate, rounded half-up to base minor units with the existing rounding;
  - A = T − B.
- **Eligible GL exposures:** leaf accounts in a foreign currency, explicitly monetary, that are not control accounts. Base-currency, non-monetary, parent and control accounts never participate.
- **Journals.** One `revaluation` system journal per foreign currency:
  - currency = that currency, date = D, exchange rate = the closing rate;
  - every line is `base_only`: one adjustment line per account, plus one net Unrealized FX offset line on the `UNREALIZED_FX_GAIN_LOSS` designation;
  - zero adjustments are omitted.
  - Original journals and foreign balances never change; only the base carrying value does.
- **Reversal.** Each revaluation journal gets a mirrored `revaluation_reversal` journal dated D + 1, through the dedicated S9 path. It restores the pre-revaluation carrying amount.
  - Generic reversal keeps refusing `revaluation` and `revaluation_reversal` journals (Decision 80).
  - D and D + 1 must both fall in existing, open periods; periods are never created.
- **Zero-adjustment run (N7):** valid. It is recorded as POSTED with no lines, no journals and zero totals, and audited. Exposures whose adjustment is zero are not persisted as run lines, and no zero-value accounting line is ever created (S9 final review correction).
- **Archived accounts (N8):** an archived eligible account with a non-zero exposure blocks the whole run, with an error naming the accounts. Nothing is skipped or partly revalued, and archived accounts still cannot receive postings.
- **Dimensions (N4), exact clarification:** revaluation is an accounting-internal system operation.
  - Revaluation lines do not accept user-supplied dimensions.
  - They do not inherit operational or document dimensions.
  - Required-dimension validation does not apply to them.
  - Dimensions are never invented or assigned automatically.
  - Future document-level revaluation may define its own dimension behaviour.
- **Permissions (N3):** view `accounting.journals.view`; post `accounting.journals.post`; cancel `accounting.journals.reverse`.
  - Post and cancel require the existing re-authentication and security controls.
  - There is no `accounting.revaluation.run` key, and `accounting.setup` is not used.
- **Run-journal links (N5):** `accounting_revaluation_run_journals` with roles `REVALUATION`, `SCHEDULED_REVERSAL` and `CANCELLATION`.
- **States:** `DRAFT`, `PENDING_APPROVAL`, `POSTED` and `REVERSED`. S9 posts directly; `PENDING_APPROVAL` is schema-ready for Phase 4.
- **Idempotency and concurrency:**
  - uniqueness per organization and revaluation date (for active runs), and `run_key` uniqueness;
  - version compare-and-set, an organization advisory transaction lock, the existing period locks, and one atomic transaction.
  - A retry with the same `run_key` returns the existing run. A second submission for the date is a conflict.
- **Atomicity:** calculation → run → lines → revaluation journals → D + 1 reversals → links → audit, all or nothing.
- **Providers:** read-only document exposure providers registered by later modules. Accounting alone posts.
- **Audit:** `revaluation.posted` and `revaluation.reversed`, with ids, date, method, currencies, counts, totals, journal ids and the cancellation reason. There is no personal data, and `journal.posted` is unchanged.
- **Development trigger (N6):**
  - development/testing only, and refused in any other environment;
  - an acting-user context with permission and MFA checks;
  - uses the real `RevaluationService`;
  - no production HTTP feature.
- **Reporting:** no change to the S3 engine. Reports reflect revaluations through the ledger, and the foreign balance is unchanged because `base_only` lines are excluded from it.

### Amendment to Decision 53 (N9)

`OTHER_CURRENT_ASSET` and `OTHER_ASSET` accounts may be marked monetary, **explicitly**. They are never monetary by default, and no engine infers monetary status from names or usage. The list of explicitly markable subtypes becomes: Other Current Asset, Other Asset, Other Current Liability and Long-Term Liability. Migration 0017 replaces the `accounting_accounts_monetary` CHECK.

### S8-07 enforcement (N1)

The final S8-07 ruling is enforced as the S9 prerequisite:

- **Line rule:** an opening-balance account with no subtype is rejected with guidance to classify it, alongside the receivable and control-account rejections.
- **Entry grid:** it hides unclassified accounts and says how many.
- **Database:** a trigger on opening-balance lines refuses unclassified, receivable and control accounts (migration 0017).

### Implementation notes (S9, 2026-09-29; within the approved decisions)

- **Migration `0017_revaluation_support`** contains:
  - the S8-07 line guard;
  - the Decision 53 CHECK;
  - `jobs (id, organization_id)` uniqueness, so the run's `job_id` is a tenant-safe foreign key;
  - the three revaluation tables with RLS, composite tenant FKs and state/immutability triggers.
- **Database protections:**
  - A run is inserted as a `DRAFT`, filled, and moved to `POSTED` in the same transaction. Its identity, date, method and posted figures never change afterwards.
  - Lines change only while the run is a `DRAFT`.
  - Links are append-only. `REVALUATION`/`SCHEDULED_REVERSAL` links are added only while the run is a `DRAFT`, `CANCELLATION` links only while it is `POSTED`. A linked journal must be a system journal whose source is the run, with the type matching its role.
- **Journals:**
  - Revaluation journals carry source (`accounting`, `revaluation`, run id). Reversal and cancellation journals carry (`accounting`, `revaluation_reversal`, run id).
  - The exchange-rate source is `table` for table rates. `SystemJournalInput` gained an optional `exchangeRateSource` for this.
- **Cancellation:** it reverses every still-posted revaluation and scheduled-reversal journal on its own date, through the S9 path with a reversal link. The originals become `REVERSED`, and the run becomes `REVERSED`, so the date can be revalued again.
- **Exposure rules:** the run records each exposure whose adjustment is non-zero; zero adjustments are neither recorded nor posted. A zero F with a residual base is revalued to zero, with a warning about a possibly unrecorded realized difference. A rate dated before D's period gives a warning.
- **Line cap:** at most 499 accounts per currency journal plus the offset (the S8-19 precedent). Document exposures are aggregated per control account.
- **Classification rule as implemented:** a foreign-currency `ACCOUNTS_RECEIVABLE` account that is not a control account is monetary by Decision 53, so it participates as a GL exposure. The base-currency AR control account never does.
- **Development trigger:** `pnpm --filter @intuit-2/api revaluation:dev-run`, through `application/revaluation-dev-trigger.ts`. The production service methods (`post`, `cancel`) keep requiring the permission, a recent session re-authentication and MFA where applicable. The trigger has no browser session, so it applies, in order:
  - the development/testing environment guard (refused in any other `APP_ENV`);
  - the authenticated acting-user identity (active membership, active organization);
  - the permission check (`accounting.journals.post` or `accounting.journals.reverse`);
  - the MFA check (Decision 57a and organization policy, as for background work);
  - a **test-only session re-authentication bypass**, passed explicitly as `reauthentication: 'dev_trigger_bypass'` and recorded on the `revaluation.posted` / `revaluation.reversed` audit events (the production path records `session`).

## S10 decisions — Conditional Approvals (APPROVED / FROZEN)

Approved 2026-09-29 with the final amendments. S10 extends the existing approvals engine (Decisions 22, 56, 77; ADR 0002 A1.5, A1.7). It adds no second approval system, no new permissions and no new journals.

### S10-01 to S10-12

- **S10-01 — Step conditions.** A policy step may set:
  - `minBaseAmount` (inclusive);
  - `maxBaseAmount` (exclusive);
  - a list of `transactionTypes`;
  - `thresholdCurrency`, which the server records as the base currency whenever an amount bound is set.

  Every condition a step sets must hold (AND). A step with no condition always applies.

- **S10-02 — Actions declare their conditions.** Each registered action declares whether it supports an amount and its controlled list of transaction types. The facts are always derived on the server; a client-supplied amount or type is never used.
- **S10-03 — Facts of the existing actions:**

  | Action                            | Transaction types                                                                                          | Amount                                                                                                |
  | --------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
  | `accounting.journal.post`         | `manual`, `imported` (a manual journal with the `data_exchange / import_batch` source), `accounting_event` | The journal's base-currency total at its rate, converted exactly as posting converts it (Decision 56) |
  | `accounting.opening_balance.post` | `opening_balance`                                                                                          | The canonical S8 amount (below)                                                                       |
  | `accounting.period.reopen`        | `period_reopen`                                                                                            | None; amount conditions are rejected                                                                  |

  **Canonical opening-balance amount (final amendment):** the sum, over the batch's per-currency opening journals, of each journal's balanced base total, computed exactly as the S8 posting path computes it:
  - base-currency journals at rate 1;
  - explicit carrying values from their base amounts;
  - table-rate journals through the engine's own conversion at the plan's rate.

  The Opening Balance Equity line only balances the smaller side and is never counted twice: each currency contributes the larger of its entered base debits and base credits.

- **S10-04 — Snapshot of matching steps.** A request stores only the steps that apply, with their policy step numbers, plus the facts and the evaluation time. **No matching step means no request, and the action proceeds directly (Decision 77).** Gaps between bands are valid by design. There is no `allowUncovered` flag and no rule requiring an unconditional step.
- **S10-05 — Fail closed.** A step with an amount condition applies whenever:
  - the subject's amount is unknown (for example, a draft that doesn't validate yet); or
  - the step's threshold currency differs from the current base currency.

  Transaction-type conditions still decide.

- **S10-06 — Posting-time re-check.** The requirement is evaluated with facts:
  - at submit;
  - again inside the authoritative posting transaction, for draft journals, pending journals without a request, accounting-event journals and opening-balance posting.
- **S10-07 — Withdrawn** (the `allowUncovered` proposal).
- **S10-08 — Locking.** Replacing a policy locks its row (`FOR UPDATE`); opening a request or checking the requirement reads it with `FOR SHARE`. A snapshot therefore never contains half of a replaced policy.
- **S10-09 — Request immutability.** A request's identity, snapshot, requester, excluded users, reason and creation time never change. Its status moves once, from `pending` to `approved`, `rejected` or `withdrawn`. Requests cannot be deleted or truncated.
- **S10-10 — Strict API.** `PUT /approvals/policies/:actionKey` rejects unknown fields at every level with `400 VALIDATION_FAILED`.
- **S10-11 — Permissions:** no new keys.
  - Policies: `approvals.manage` plus re-authentication, with MFA under Decision 57a.
  - Approvers: each action's existing approver permission.
  - Self-approval stays prohibited (preparer and submitter).
- **S10-12 — Migration `0018_approval_conditions`.** Additive, with no backfill; existing steps stay unconditional. **There is no migration 0019**: every Phase 3A permission was already backfilled (0008, 0009, 0011), and S5–S10 added no keys.

### Implementation notes (S10, 2026-09-29; within the approved decisions)

- `ApprovalService.requirementFor(tx, org, action, facts)` replaces the old action-only check.
- Journal detail returns:
  - `approvalRequiredForPosting` from the journal's own facts;
  - `approvalFacts` and `approvalSteps`.

  The opening-balance approval state returns `facts` and `appliedSteps`. Approval requests list their `facts` and `appliedSteps`.

- **Changed behaviour (from S10-06):** a journal submitted when no step applied (pending without a request), and that a later policy now covers, is refused at posting with "withdraw it and submit it again".
- In opening-balance posting, the batch is evaluated once before the approval check (step 4) and the same evaluation serves steps 5–7. The S8-10 order of verdicts is unchanged: approval first, then validation errors.
- Requests created before S10 have no `facts` and their steps no `conditions`. They are read as unconditional and still decide as before.

## Status items (must not be guessed)

| Item                                               | Status                                                                                        | Rule                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **U1** Final Sales approval behaviour              | **UNDECIDED**                                                                                 | Decision 13 fixes atomic issue + event + posting once approval is satisfied. Whether the final approval **itself** performs issue (number, date lock, post), or an explicit Issue command follows, is not approved. Flag before implementing the approval → issue transition. |
| **U18** Production email provider                  | **DEFERRED** to production readiness                                                          | The provider abstraction and mock email are approved. Not an architecture blocker.                                                                                                                                                                                            |
| **U19** MIRA foreign-currency tax conversion rules | **OPEN before production**; not a Phase 3 architecture blocker                                | The architecture must be able to implement the statutory rule. It must not be invented and must be verified before production use.                                                                                                                                            |
| PDF library                                        | Evaluation → recommendation → approval (Decision 43)                                          | Not an open product question.                                                                                                                                                                                                                                                 |
| Spreadsheet library                                | Evaluated in S6 ([XLSX evaluation](../xlsx-evaluation.md)); **awaiting Decision 62 approval** | Not an open product question.                                                                                                                                                                                                                                                 |
| Production storage vendor                          | Deployment decision (Decision 29)                                                             | Not an open product question.                                                                                                                                                                                                                                                 |
| Receivables model                                  | **Resolved** by Decision 11                                                                   | Single base-currency AR control account plus subledger.                                                                                                                                                                                                                       |
| Decision 58 option (rate-override permission)      | **Phase 3B clarification**                                                                    | Choose `sales.rates.override` or `receipts.create` before Phase 3B step 7.                                                                                                                                                                                                    |
| Decision 59 option (deposit-override permission)   | **Phase 3B clarification**                                                                    | Choose `receipts.create` or a new key before Phase 3B step 7.                                                                                                                                                                                                                 |
| Decision 60 option (Tourism GST 16% seed)          | **Phase 3B clarification**                                                                    | Seed the 2023-01-01 → 2025-06-30 16% version only if approved, before Phase 3B step 1.                                                                                                                                                                                        |

## Supersessions of earlier frozen decisions

| Earlier decision                                                          | Superseded or refined by                  | Effect                                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| ADR 0002 principle 3 (positive amounts, one side per line)                | Decision 10                               | Base-only lines allowed for approved system FX/revaluation handlers only                                          |
| ADR 0002 A5 (one rate per journal)                                        | Decision 10                               | Per-line base amounts for system FX journals; manual journals unchanged                                           |
| ADR 0002 A2 (base currency changeable until first posting)                | Decision 26                               | Base-currency accounts follow a pre-posting change; immutable after the first posting                             |
| ADR 0002 D16 (amount thresholds out of scope)                             | Decision 22                               | Amount-threshold and transaction-type conditions in Phase 3A                                                      |
| ADR 0002 assumption 4 (event journals stay drafts under journal approval) | Decision 13                               | Not applied to Sales-generated journals                                                                           |
| ADR 0002 F26 (post requires re-auth)                                      | Decision 13                               | Applies to manual journals, not the Sales atomic issue path                                                       |
| ADR 0002 B8 (type = 5 categories)                                         | Decision 2                                | Categories unchanged; classification/subtype added                                                                |
| ADR 0001 organizations (name only)                                        | Decision 17                               | Additive legal profile                                                                                            |
| ADR 0001 identity (password sessions)                                     | Decisions 5, 25                           | Additive MFA and MFA-pending session state                                                                        |
| Earlier Phase 3 D2, D11, D12, D16                                         | Decisions 8/28/48, 28/30/31/40, 40, 34/35 | See the refinement table above                                                                                    |
| Decision 27 (one balanced opening journal)                                | Decision 68                               | One opening journal per currency within one opening batch                                                         |
| Decision 11 (foreign account accepts only its own currency)               | Decision 71                               | Approved FX/revaluation `base_only` lines may post to foreign monetary accounts                                   |
| Decision 1 (account currency)                                             | Decision 70                               | Currency immutable once the account has any non-draft journal line                                                |
| Decision 22 (conditional approvals)                                       | Decisions 56, 77                          | Step-level conditions; thresholds in base-currency equivalent at the document rate                                |
| Brief v2.0 placement of idempotency and i18n in 3A                        | Decision 74                               | Moved to 3B; MFA including QR UX stays in 3A                                                                      |
| Decision 26 (base-currency change before first posting)                   | Decision 81                               | Pending/draft lines that block the migration must be cleared first; audited                                       |
| Decision 65 backfill timing (end of Phase 3A)                             | Decision 90                               | New permissions reach existing organizations through an additive, audited migration                               |
| ADR 0002 D19 (journals are never deleted)                                 | S6 ruling L-9                             | Never-submitted imported drafts may move to the terminal `DISCARDED` status; still never deleted                  |
| Decision 72 (admin MFA reset, not the Owner)                              | S7 ruling S7-37                           | Also refused for an Owner of any organization and for anyone with a membership in another organization            |
| Decision 57(c) (privileged users enforced at next sign-in)                | S7 ruling S7-30                           | Enforced on the next request (stricter); existing sessions are not MFA-verified                                   |
| Decision 65 (`members.manage` + re-auth for MFA policy and admin reset)   | S7 ruling S7-33                           | Also requires a fresh second factor (step-up); stricter                                                           |
| Decision 80 (generic reversal refused for FX/revaluation system journals) | S8 ruling S8-14                           | Also refused for `opening_balance` journals; they are reversed only with their whole opening batch                |
| Decision 53 (explicit monetary marking on liability subtypes only)        | S9 amendment N9                           | Other Current Asset and Other Asset accounts may also be marked monetary, explicitly; never by default            |
| ADR 0002 D16 (policy per action; every step must pass)                    | S10-01, S10-04                            | Steps may be conditional; every step that applies must pass; no applicable step means direct action (Decision 77) |

## Consequences

- **Phase 3A** extends the accounting, organizations, identity and approvals modules only additively. It adds `parties`, `files`, `jobs`, `data-exchange` (import/export), dimensions (inside accounting) and `reports` capabilities. All Phase 1 and Phase 2 tests must stay green.
- **Phase 3B** adds `customers`, `sales` and `tax` on top of the 3A foundations.
- New migrations start at `0004`. Migrations `0001`–`0003` are never edited.
