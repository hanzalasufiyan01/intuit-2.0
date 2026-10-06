# ADR 0004 — Phase 4: Purchases & Accounts Payable, and the revaluation user workflow

- **Status:** APPROVED / FROZEN (2026-10-01). Decisions P4-01 to P4-53 are approved as recommended in the Phase 4 Purchases/AP Architecture Brief, with three amendments (P4-06, P4-19, P4-52) and a later P4-08 amendment (control-account integrity). Items marked **OPEN** or **CLARIFICATION** are not approved for implementation.
- **Date:** 2026-10-01
- **Source:** "Intuit 2.0 Phase 4 — Purchases/AP Architecture Brief" (architecture proposal reviewed at baseline `3a75cd4`) and the Phase 4 architecture approval of 2026-10-01.
- **Preserves:** ADR 0001, ADR 0002 (with Amendment 1) and ADR 0003, except where a decision below explicitly amends them. Each amendment is listed under "Amendments to earlier frozen decisions".

## Governance

- **Phase 4** = Purchases/AP, plus the revaluation user workflow as its final stage (P4-01). This fulfils Decision 9, which deferred that workflow to Phase 4.
- **Staging (P4-02):** checkpoint 4A, then full verification and one local commit; checkpoint 4B, then full verification and one local commit. Nothing is pushed automatically.
- **Process:** Proposal → Review → Approval → Freeze → Implementation. A conflict with a frozen decision found during implementation is reported, with its impact and options, and work stops before the conflicting change. An improvement that wasn't approved is proposed first, never silently implemented.

## Non-negotiables (approval text)

- **Migrations:** `0001`–`0026` are never modified; new migrations start at `0027`.
- **Frozen behaviour:**
  - Frozen Phase 1–3B behaviour is never changed silently.
  - All Sales behaviour is preserved, and the Sales tests stay green after the shared-engine extraction.
- **Ledger:**
  - No Purchases module writes accounting ledger tables. The path is always: operational document → accounting event → journal → journal lines → GL.
  - Posted accounting is immutable.
- **Platform controls kept:** tenant RLS and composite tenant FKs; strict API validation with unknown-field rejection; idempotency; auditability; server-derived accounting facts.
- **No inference:** account classification, tax rules and localization rules are never inferred.
- **No invented statute:** no MIRA, import-GST, reverse-charge or withholding rules are invented.
- **Dependencies:** no new third-party dependency without explicit review. PDFKit 0.20.2 and the existing file and job infrastructure are reused.
- **Scope:** deferred items are not implemented just because they seem useful.

**Accounting safety.** Every money-moving operation is proven to have all of the following:

- a balanced journal;
- correct base conversion, FX sign and tax treatment;
- correct dimensions and period validation;
- correct approval behaviour and idempotency;
- correct source-document linkage and reversal/void behaviour;
- correct AP subledger ↔ GL reconciliation.

## Amendments made by the approval

1. **P4-06 — neutral catalog permission.**
   - The shared catalog is governed by a new key, **`catalog.items.manage`**, not `sales.items.manage`.
   - It is introduced additively: a permission migration with an audited backfill grants `catalog.items.manage` to every role that holds `sales.items.manage` (including custom roles, because this preserves existing access rather than widening it). Owner and Administrator templates gain it.
   - Existing Sales access is preserved throughout.
   - `sales.items.manage` is **not removed**. It stays in the catalog, described as superseded by `catalog.items.manage`; removing it needs a future approved decision.
   - Viewing the catalog: `invoices.view`, `bills.view` or `catalog.items.manage`. During the transition, `sales.items.manage` also still permits catalog management, so no existing grant stops working.
2. **P4-19 — bill-line eligibility includes prepaid expenses** (clarified: through `OTHER_CURRENT_ASSET`).
   - Eligible: active leaf accounts of subtypes `OPERATING_EXPENSE`, `OTHER_EXPENSE`, `COST_OF_SALES`, `FIXED_ASSET`, `OTHER_ASSET` and `OTHER_CURRENT_ASSET`. Prepaid expenses are covered by `OTHER_CURRENT_ASSET`.
   - Always rejected: control accounts, bank/cash, AR, AP, credit-card/payment-source accounts, designated/system accounts, equity, revenue, unclassified accounts and other prohibited classifications.
   - Classification is never inferred.
   - **Clarification (decided 2026-10-01, option B):** the amendment's "prepaid expenses" are satisfied by the existing `OTHER_CURRENT_ASSET` classification. **No `PREPAID_EXPENSE` subtype is added.** Decision 53 and its subtype catalog are unchanged, no migration is created for it, and no existing account is reclassified. Template account `1150 Prepaid Expenses` stays `OTHER_CURRENT_ASSET` and is eligible for bill lines under these rules.
3. **P4-52 — revaluation workflow on the frozen S9 engine.** It is built strictly on S9, and none of the following is weakened or bypassed:
   - permission checks (N3);
   - fresh-session re-authentication;
   - MFA where applicable;
   - system-journal protections (Decision 80);
   - the dedicated revaluation reversal and cancellation path;
   - audit;
   - the AR/AP provider architecture;
   - the base-only/system FX journal rules (Decisions 10, 71).

4. **P4-08 amendment — control-account integrity** (approved 2026-10-01, after step 4A-1).
   - While an account has `control_subledger` ownership, none of these is allowed:
     - reclassification (account type or subtype);
     - a currency change;
     - a parent/hierarchy change (moving it, or giving it a child account, by creation, move or import);
     - archiving or deactivating it.
   - The owning subledger's settings workflow releases ownership first. A released account can then be changed normally.
   - **Where it's enforced:**
     - the account update, archive, create (parent) and base-currency-change paths, and the chart-of-accounts import, all refuse with clear messages;
     - database triggers are the backstop.
   - No other account restriction is added.

## Decision register P4-01 to P4-53 (approved)

| ID    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P4-01 | Phase 4 = Purchases/AP + the revaluation user workflow as the final stage.                                                                                                                                                                                                                                                                                                                                              |
| P4-02 | Two checkpoints, 4A and 4B, each with full verification and one local commit.                                                                                                                                                                                                                                                                                                                                           |
| P4-03 | Separate `vendors` and `purchases` modules (R36, Decision 8).                                                                                                                                                                                                                                                                                                                                                           |
| P4-04 | A neutral `documents` module holds the pure calculation, settlement, journal-builder and dimension-merge functions. Sales uses it unchanged (behaviour-preserving extraction, proven by golden tests).                                                                                                                                                                                                                  |
| P4-05 | Shared catalog: items gain purchase fields and `is_sold`/`is_purchased` facets. Ownership moves to a neutral `catalog` module; the table name `sales_items` is unchanged.                                                                                                                                                                                                                                               |
| P4-06 | **Amended:** the neutral key `catalog.items.manage`, with an additive backfill (see Amendments).                                                                                                                                                                                                                                                                                                                        |
| P4-07 | One base-currency AP control account per organization, plus the AP subledger (mirrors Decision 11).                                                                                                                                                                                                                                                                                                                     |
| P4-08 | `accounting_accounts.control_subledger` (`sales`, `purchases`) with the CHECK `is_control_account = (control_subledger IS NOT NULL)`. Existing AR control accounts are backfilled to `sales`. Marking goes through a generalized `setSubledgerControlInTransaction`. **Amended:** control-account integrity (see Amendments, item 4).                                                                                   |
| P4-09 | A registry of subledger modules (`sales`, `purchases`). `reverseSubledgerJournalInTransaction(module, …)`; generic reversal refuses the journals of every subledger module and their reversals. Sales behaviour is unchanged.                                                                                                                                                                                           |
| P4-10 | A source-document registry: journal and ledger views return `sourceDocument`, and the UI links to Sales and Purchases documents (completes Decision 4).                                                                                                                                                                                                                                                                 |
| P4-11 | Tax codes gain an optional `input_tax_account_id`, required when the code is used on a purchase document. Output tax keeps `tax_account_id`.                                                                                                                                                                                                                                                                            |
| P4-12 | A per-line `tax_recoverable` flag, defaulting from the organization's GST registration and the item or vendor default, overridable with `bills.create`. Non-recoverable tax is capitalized into the line's account.                                                                                                                                                                                                     |
| P4-13 | Template account `1160 GST Input Tax Recoverable` (`OTHER_CURRENT_ASSET`) for new organizations, mapped as the seeded codes' input account. Existing organizations set it explicitly; nothing is inferred (Decision 54).                                                                                                                                                                                                |
| P4-14 | Import/customs GST, reverse charge and blocked input-tax categories are **OPEN** (localization; not designed, not implemented).                                                                                                                                                                                                                                                                                         |
| P4-15 | Bills: `DRAFT → PENDING_APPROVAL → POSTED → VOID`. Approval authorizes; a separate Post by `bills.post` performs the atomic operation (mirrors D1). "Ready to post" is derived, never stored.                                                                                                                                                                                                                           |
| P4-16 | Bill rate: the table rate on the bill date by default. An optional manual override needs a mandatory reason, keeps the table rate, requires `bills.post`, and is audited.                                                                                                                                                                                                                                               |
| P4-17 | `vendor_reference` (supplier invoice number) is required to post a standard bill and optional on drafts.                                                                                                                                                                                                                                                                                                                |
| P4-18 | Duplicate detection (same vendor + normalized supplier reference, non-void bills) blocks posting unless the user confirms with a reason (audited). A non-blocking warning covers the same vendor, amount and date within 7 days. The check runs under an advisory lock.                                                                                                                                                 |
| P4-19 | **Amended and clarified:** bill-line account eligibility, with prepaid expenses through `OTHER_CURRENT_ASSET`; no new subtype (see Amendments).                                                                                                                                                                                                                                                                         |
| P4-20 | Bill currency defaults to the vendor's currency; any supported currency is allowed (Sales parity).                                                                                                                                                                                                                                                                                                                      |
| P4-21 | A bill is voided only when unpaid and in an open period, with `bills.void` and re-authentication. Other corrections use vendor credits (mirrors D8).                                                                                                                                                                                                                                                                    |
| P4-22 | Bill evidence: attachments can be added at any time and removed only before posting.                                                                                                                                                                                                                                                                                                                                    |
| P4-23 | One vendor-credit document with `origin` = `supplier_credit_note` or `debit_note`. Debit notes get a number, an immutable PDF and email.                                                                                                                                                                                                                                                                                |
| P4-24 | A vendor credit can be voided while fully unapplied and unrefunded, with re-authentication.                                                                                                                                                                                                                                                                                                                             |
| P4-25 | Optional payment approval: action `purchases.payment.record`, draft payments with planned allocations, approver `vendor_payments.approve`. With no policy, the payment is recorded directly.                                                                                                                                                                                                                            |
| P4-26 | Payment source accounts: bank, cash and `CREDIT_CARD` accounts, under the Decision 42 currency rules.                                                                                                                                                                                                                                                                                                                   |
| P4-27 | Payment rate override mirrors D2: `vendor_payments.create`, a mandatory reason, the table rate retained.                                                                                                                                                                                                                                                                                                                |
| P4-28 | Payment account override mirrors D3: `vendor_payments.create`, audited.                                                                                                                                                                                                                                                                                                                                                 |
| P4-29 | A payment's excess, or a payment with no bills, is a prepayment: a vendor debit balance on the AP control account (mirrors Decision 38).                                                                                                                                                                                                                                                                                |
| P4-30 | Vendor refunds against unapplied credits and prepayments, with void (re-authentication).                                                                                                                                                                                                                                                                                                                                |
| P4-31 | Customer refunds stay deferred; frozen Sales scope is unchanged.                                                                                                                                                                                                                                                                                                                                                        |
| P4-32 | Batch "Pay bills": one payment per vendor and currency, all-or-nothing in one transaction under one idempotency key.                                                                                                                                                                                                                                                                                                    |
| P4-33 | Payment void mirrors the receipt void: the journal and every unreversed allocation are reversed; refunds taken from the payment must be voided first.                                                                                                                                                                                                                                                                   |
| P4-34 | Payment, refund and application dimensions mirror the Sales receipt rule exactly.                                                                                                                                                                                                                                                                                                                                       |
| P4-35 | Vendor opening balances are opening bills and opening vendor credits: OBE, explicit carrying values (mirrors D5).                                                                                                                                                                                                                                                                                                       |
| P4-36 | The S8-07 opening-balance guard also rejects `ACCOUNTS_PAYABLE` accounts (application rule and trigger). Existing posted AP opening balances are handled through guidance, never automatic conversion.                                                                                                                                                                                                                  |
| P4-37 | Approval actions (approver in brackets): `purchases.bill.post` (types `standard`, `opening`; `bills.approve`); `purchases.vendor_credit.post` (`supplier_credit_note`, `debit_note`; `vendor_credits.approve`); `purchases.payment.record` (`payment`, `prepayment`; `vendor_payments.approve`); `purchases.expense.post` (`expense`; `expenses.approve`). The amount is the AP line base, or the payment or paid base. |
| P4-38 | Vendor, account and dimension approval conditions are deferred.                                                                                                                                                                                                                                                                                                                                                         |
| P4-39 | The permission catalog of brief §20: `vendors.{view,create,update,archive}`, `bills.{view,create,edit_draft,delete_draft,post,void,approve}`, `vendor_credits.{view,create,post,void,approve}`, `vendor_payments.{view,create,void,approve}`, `purchases.settings.manage`, `purchases.reports.view`, `expenses.{view,create,void,approve}`, plus `catalog.items.manage` (P4-06).                                        |
| P4-40 | Member defaults: the view keys (mirrors D14).                                                                                                                                                                                                                                                                                                                                                                           |
| P4-41 | `purchases.settings.manage` joins the Decision 57a MFA high-privilege set.                                                                                                                                                                                                                                                                                                                                              |
| P4-42 | Re-authentication for Purchases settings, bill void, vendor-credit post and void, payment void, refund void and expense void. Tax-code input-account changes are covered by `tax.codes.manage`. Recording a payment has no re-authentication; approval policy controls it.                                                                                                                                              |
| P4-43 | Vendor bank and payment details are deferred to Banking.                                                                                                                                                                                                                                                                                                                                                                |
| P4-44 | Direct expenses ("spend money") are included as a late, separable Phase 4 stage.                                                                                                                                                                                                                                                                                                                                        |
| P4-45 | Purchase orders are deferred.                                                                                                                                                                                                                                                                                                                                                                                           |
| P4-46 | Remittance-advice and debit-note PDFs with email (PDFKit, jobs, email provider abstraction).                                                                                                                                                                                                                                                                                                                            |
| P4-47 | Imports: vendors, opening bills (drafts only), and the catalog purchase columns.                                                                                                                                                                                                                                                                                                                                        |
| P4-48 | Exports: vendors, bills, vendor credits, vendor payments, AP aging, purchases by vendor.                                                                                                                                                                                                                                                                                                                                |
| P4-49 | Reports per brief §26; AP aging uses due-date buckets Current, 1–30, 31–60, 61–90, 90+ (D9).                                                                                                                                                                                                                                                                                                                            |
| P4-50 | Limits: at most 497 bills per payment (the 500-line journal cap); a batch covers at most 100 vendors; bills and credits have at most 200 lines.                                                                                                                                                                                                                                                                         |
| P4-51 | Numbering prefixes `BILL-`, `VC-`/`DN-`, `PAY-`, `VR-`, `EXP-`; assigned at post or record; not gapless (R37); configurable.                                                                                                                                                                                                                                                                                            |
| P4-52 | **Amended:** the revaluation user workflow, built strictly on S9 (see Amendments). Routes for preview, post, cancel and list; approval action `accounting.revaluation.post` using the S9 `PENDING_APPROVAL`; UI; AR and AP providers; N3 permissions.                                                                                                                                                                   |
| P4-53 | Early-payment discounts are deferred; withholding tax is **OPEN** (localization).                                                                                                                                                                                                                                                                                                                                       |

## Architecture rules carried into implementation

- **Journals:**
  - Bill: Dr expense lines (net, plus non-recoverable tax) / Dr input tax (recoverable) / Cr AP control.
  - Vendor credit: the reverse of a bill.
  - Payment: Dr AP at each bill's historical base / Cr payment account at the payment rate / realized FX as `base_only` lines (the `realized_fx` system type).
  - Prepayment: Dr AP / Cr payment account.
  - Credit application: AP against AP, with FX.
  - Refund: Dr bank / Cr AP, with FX.
  - Opening bill: Dr OBE / Cr AP (the `opening_balance` system type, source `purchases`).
  - Direct expense: Dr expense and input tax / Cr bank or card.
  - Voids: reversal through the generalized E2 path.
- **FX sign for AP:** `fx_difference = base_relieved − source_base` (positive = gain). The AR definition is unchanged.
- **Dimensions:** bills, vendor credits and expenses follow D10; required types are enforced at submit and post; no inference.
- **Event types:**
  - `purchases.bill_posted`, `purchases.vendor_credit_posted`, `purchases.payment_recorded`;
  - `purchases.credit_applied`, `purchases.refund_recorded`, `purchases.expense_posted`;
  - source references are `purchases/<type>/<id>`; handlers use `domainApproval`.
- **Idempotency scopes:**
  - `purchases.bill.create`, `.bill.post`;
  - `.vendor_credit.create`, `.vendor_credit.post`;
  - `.payment.record`, `.payment_batch.record`;
  - `.credit.apply`, `.refund.record`, `.expense.post`.
- **Invariants (brief §29):**
  - **I-1:** −(AP control GL balance − revaluation adjustments) = Σ POSTED bills `base_due` − Σ POSTED vendor credits `base_unapplied` − Σ RECORDED payments `base_unallocated`.
  - I-2 to I-12 as written in the brief: open-balance bounds, allocation limits, FX identity, immutability, void preconditions, E2 ownership, one journal per document, account eligibility, approval re-check, opening-bill rules, and duplicate confirmation.
- **Concurrency:**
  - optimistic versions on drafts;
  - `FOR UPDATE` on posting;
  - lock order: source → bills by ascending id → refunds;
  - an advisory lock for the duplicate check;
  - the AP lock is checked under the settings row lock.
- **Migration plan:**
  - `0027` subledger control ownership and the S8 AP guard;
  - `0028` tax input accounts;
  - `0029` vendors, Purchases settings and catalog;
  - `0030` bills;
  - `0031` vendor credits;
  - `0032` payments, allocations and refunds;
  - `0033` integrations;
  - `0034` direct expenses;
  - `0035` permission backfill.
  - The catalog permission migration for P4-06 is numbered when it is reached; numbers stay sequential.

## Amendments to earlier frozen decisions (approved through this ADR)

| Earlier decision                                    | Amended by      | Effect                                                                                                                                                                       |
| --------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 3B E2 (Sales-only reversal)                   | P4-09           | Generalized to every registered subledger module. Sales behaviour unchanged.                                                                                                 |
| Phase 3B E3 (AR control marking)                    | P4-08           | Ownership recorded in `control_subledger`; marking generalized.                                                                                                              |
| Account maintenance (ADR 0002; Decisions 1, 26, 53) | P4-08 amendment | While owned, a control account cannot be reclassified, re-currencied, moved, given children or archived; the base currency cannot change while any control account is owned. |
| S8-07 (opening-balance accounts)                    | P4-36           | Additionally rejects `ACCOUNTS_PAYABLE`.                                                                                                                                     |
| Phase 3B D8 / Decision 31 (items)                   | P4-05, P4-06    | Items become a shared catalog under `catalog.items.manage`; `sales.items.manage` is retained.                                                                                |
| Decision 9 (revaluation workflow)                   | P4-01, P4-52    | Delivered as the final stage of Phase 4.                                                                                                                                     |
| Decision 57a (MFA set)                              | P4-41           | Adds `purchases.settings.manage`.                                                                                                                                            |
| Decision 4 (drill-down)                             | P4-10           | Completed for subledger documents.                                                                                                                                           |

## Open items

| Item                                                    | Status                            | Blocks             |
| ------------------------------------------------------- | --------------------------------- | ------------------ |
| Import/customs GST, reverse charge, blocked input tax   | **OPEN** (P4-14)                  | Nothing in Phase 4 |
| Withholding tax                                         | **OPEN** (P4-53)                  | Nothing in Phase 4 |
| U18 production email vendor; U19 MIRA FX tax conversion | Deferred / open before production | Production only    |

## Implementation notes

### 4A-0 — shared document engine (P4-04), 2026-10-01

- **Move:** `calculation.ts`, `settlement.ts` and `posting.ts` moved from `modules/sales` to the new `modules/documents` (`git mv`, history kept). The code is byte-identical; only the three header comments changed. `modules/documents/index.ts` is the public contract. It has no tables and no database access.
- **Sales contract:** `modules/sales/index.ts` re-exports `../documents/index.js`, so its public contract and every Sales caller are unchanged. Purchases will import `documents` directly, never through Sales.
- **Golden equivalence:** `test/documents-golden.test.ts` holds outputs captured from the Sales implementation before the move, in `test/golden/documents-engine.json`:
  - 307 calculation cases (249 valid, 58 rejected), across five currencies with 0, 2 and 3 minor units, all three treatments, line and document discounts, and edge cases;
  - 60 receipt and 60 credit settlements;
  - 147 relieved-base values;
  - 40 document journals (base and foreign, invoice and credit note, dimensions);
  - due dates and the dimension merge.
- **Proof:**
  - the engine reproduces the captured outputs exactly;
  - the Sales contract re-exports the very same function objects;
  - a deliberate one-character rounding mutation makes the golden test fail.
- **Fixture handling:** it's (re)captured only with `UPDATE_GOLDEN=1`, and excluded from Prettier as generated data.
- **Scope kept:** the application-level helpers in `application/sales-documents.ts` (open-period, required-dimension, approval-state, numbering) were not moved. Purchases-specific generalizations of the engine (AP direction in the journal builder, AP FX sign) arrive with the steps that need them (4A-10, 4B), each under the golden test.

### 4A-1 — subledger control ownership (P4-07, P4-08), 2026-10-01

- **Migration `0027_subledger_control_ownership`:**
  - adds `accounting_accounts.control_subledger` (`sales` or `purchases`) and the CHECK `is_control_account = (control_subledger IS NOT NULL)`;
  - backfills every existing control account to `sales`, because Phase 3B E3 was the only application path that marked one;
  - writes one system-actor `account.control_subledger_recorded` audit event per backfilled account.
- **Code:**
  - `setControlAccount` now sets the flag and its owner together.
  - `AccountingService.setSubledgerControlInTransaction` is the generalized E3 marking, driven by a rule table:
    - Sales: asset, `ACCOUNTS_RECEIVABLE`; Purchases: liability, `ACCOUNTS_PAYABLE`;
    - active, leaf, base currency, no designation;
    - not controlled by another subledger;
    - no posted lines from outside the subledger's module.
  - `setReceivablesControlInTransaction` remains as the `sales` case, so the Sales settings service is unchanged. Every AR error message is identical to Phase 3B.
  - Account views gain `controlSubledger` (additive).
- **Behaviour note:** releasing the previous control account now happens only when that account is owned by the same subledger. Through the application this is always the case, so Sales behaviour is unchanged. The old code would also have written a release audit event for an account that wasn't a control account.
- **Migration numbering refinement:** `0027` holds only control ownership. The S8 AP opening-balance guard (P4-36, step 4A-5) gets its own later migration instead of sharing `0027`, so each stage stays reviewable. Numbers stay sequential.
- **Tests:** `test/subledger-control.test.ts` (serial). Three existing tests that set control flags through raw SQL (`accounting-core`, `revaluation`, `tax`) now also set `control_subledger = 'sales'`, as the new CHECK requires.

### P4-08 amendment — control-account integrity guard, 2026-10-01

- **Migration `0028_control_account_integrity`** adds two triggers on `accounting_accounts`:
  - `accounting_accounts_control_integrity`: `BEFORE UPDATE OF account_type, subtype, currency_code, parent_id, status`, firing only `WHEN OLD.control_subledger IS NOT NULL`. It refuses any change to those columns (`check_violation`). Releasing ownership touches none of these columns, so it is never blocked.
  - `accounting_accounts_control_parent`: `BEFORE INSERT OR UPDATE OF parent_id`. It refuses a parent that is an owned control account, in the same organization.
- **Application refusals** (`409 ACCOUNT_IN_USE`, naming the owner):
  - `updateAccount`: a type, subtype, currency or parent change on an owned account. Message: "This account is the AR control account of Sales. Release it in Sales settings before changing its type, subtype, currency or parent." The AP equivalent names Purchases.
  - `archiveAccount`: "… before archiving it."
  - Base-currency change: "… before changing the base currency." Decision 26 moves every base-currency account, so owned control accounts would change currency.
  - Account create or move under an owned control account: "A subledger control account receives postings, so it cannot become a parent." The chart-of-accounts import reports the equivalent row error.
- **Not restricted:** code, name, description and the monetary flag, as the decision lists no other restriction.
- **Tests:** `test/subledger-control.test.ts` (serial) gains six tests:
  - every blocked mutation for the AR (Sales) and AP (Purchases) control accounts through the API, with the row unchanged afterwards and renaming still allowed;
  - the base-currency refusal;
  - the import refusal;
  - the database backstop for each guarded column and for the child rule;
  - a released account (and a later released one) being reclassified, re-currencied, moved, archived and given children, and the base currency then changing normally.
- **Reported, not changed (outside the decision):** deleting an owned control account is not guarded by this decision. Today the delete of the Sales AR control account fails safely (rolled back) through the `sales_settings` foreign key, but surfaces as `500 INTERNAL_ERROR`. This predates Phase 4.
- **Migration numbering:** this guard takes `0028`. The planned later migrations (tax input accounts, S8 AP guard, vendors and settings, bills, and so on) take the next free numbers in order, starting at `0029`. Numbers stay sequential and no applied migration is edited.

### 4A-2 — generalized subledger journal reversal (P4-09), 2026-10-01

- **Registry.** The subledger modules are the existing `subledgers` list (`sales`, `purchases`) from 4A-1. `JournalService` keeps one table, `SUBLEDGER_JOURNALS`, with each module's label and its refusal message. The Sales message is the Phase 3B one, word for word.
- **Ownership.** `subledgerOwner(journal)` returns the subledger that created the journal, or, for a reversal journal, the subledger that created its original. It replaces the Sales-only `isSalesJournal`.
- **Generic reversal** (`reverseJournalInTransaction`, used by `POST /accounting/journals/:id/reverse`):
  - It refuses any journal with a subledger owner unless the call comes from that owner. The option is `subledger?: Subledger`, replacing `sales?: boolean`.
  - The refusal is `409 SYSTEM_JOURNAL` with the owner's message.
  - The opening-journal exemption now applies to the reversing subledger's own opening documents (Sales opening invoices; Purchases opening bills later).
  - Everything else is unchanged: status check, open-period check, Decision 80 refusal of FX/revaluation system journals and base-only lines, line-by-line mirror including dimensions and base amounts, `recordReversal`, the `journal.reversed` audit and the `accounting.journal_reversed` outbox event.
- **Subledger path** — `reverseSubledgerJournalInTransaction(tx, ctx, module, journalId, input, origin)` replaces `reverseSalesJournalInTransaction`:
  - The journal must have been created by `module`, otherwise `409 SYSTEM_JOURNAL` "Only Sales journals are reversed here." (or "Only Purchases …"). The Sales message is unchanged.
  - Event journals go through the generic engine as the owner.
  - Realized-FX system journals are mirrored as a `realized_fx` system journal of the same module and source document (the Phase 3B mechanism, now module-parameterized).
  - The caller (a module's void) authorizes and re-authenticates, as in Phase 3B.
- **Callers.** Invoice void and receipt void now call `reverseSubledgerJournalInTransaction(…, 'sales', …)`. No other code changed. No Sales-specific reversal code remains.
- **Behaviour change (intended by P4-09):** journals created by the `purchases` module, and reversals of them, are no longer generically reversible. No such journals existed before Phase 4. Journals of modules that aren't subledgers (for example a future `payroll` event journal) keep the generic engine.
- **No migration.** Ownership comes from `source_module` and the reversal links, which already exist. No permission changes.
- **Tests.**
  - `test/subledger-reversal.test.ts` (12 tests). Purchases-owned journals are posted through the real accounting-event pipeline with a test handler, because Purchases flows don't exist yet.
  - Existing Sales void tests (invoices, receipts, credit notes, AR reports), Decision 80/79–91, accounting and opening-balance reversal tests pass unchanged.

### 4A-3 — vendors on the Party master (P4-03, P4-20, P4-39, P4-40, P4-43), 2026-10-01

- **Ordering.** Vendors were implemented as stage "4A-3" at the decision maker's request. The approved 4A list placed the source-document drill-down (P4-10), input-tax accounts (P4-11 to P4-13) and the S8 AP guard (P4-36) before Vendors; those three remain pending.
- **Data model, migration `0029_vendors`.**
  - `vendors` references `party_id` and is unique per organization and party. A party can be a customer and a vendor at the same time.
  - It holds:
    - `currency_code` (the default for future bills, P4-20);
    - `payment_terms_days` (NULL means the later Purchases default);
    - a warning-only `credit_limit`;
    - `account_number` (the organization's number at the vendor);
    - `default_expense_account_id` and `default_tax_code_id` (brief §6).
  - Identity, contacts and addresses stay on the Party; no parallel tables. There are no bank or payment fields (P4-43) and no bill fields such as the supplier invoice number (P4-17).
  - Protections, as for customers in `0021`:
    - archived, never deleted;
    - immutable identity (id, organization, party);
    - the Party keeps its `vendor` role while a vendor exists (deferred constraint trigger);
    - no truncate, tenant RLS, no DELETE grant;
    - composite tenant FKs to parties, accounts and tax codes.
- **Shared Party-role helper.**
  - `application/party-role-records.ts` holds the steps Customers and Vendors share:
    - cursor paging over parties;
    - create-or-attach (an existing active party gains the role and keeps its other roles, or a new party is created with it);
    - party identity for detail views;
    - the "restore the contact first" rule.
  - `CustomerService` now uses it. Every customer message and behaviour is unchanged (the noun is "customer"), and the customer, Party and Sales suites pass unchanged.
- **Validation.**
  - The default expense account follows P4-19, as clarified: active leaf, subtype `OPERATING_EXPENSE`, `OTHER_EXPENSE`, `COST_OF_SALES`, `FIXED_ASSET`, `OTHER_ASSET` or `OTHER_CURRENT_ASSET`; never control, designated or unclassified. The rule is the pure `purchaseAccountProblem` in the vendors module, for later reuse by bill lines.
  - The default tax code must be active. Its input-account requirement (P4-11) is checked when a purchase document uses it.
  - Defaults are checked only when set or changed.
- **API.**
  - `GET/POST /vendors`; `GET/PATCH /vendors/:id`; `POST /vendors/:id/archive` and `/restore`.
  - Identity sub-resources `/vendors/:id/contacts…` and `/addresses…` run the Party rules under `vendors.update` (the D6 mirror).
  - Schemas are strict, versions are optimistic (vendor and party), and duplicate hints come from the Party rules.
  - There is no re-authentication or MFA requirement (P4-41 and P4-42 list none for vendors).
- **Permissions.**
  - `vendors.view`, `vendors.create`, `vendors.update` and `vendors.archive` (P4-39).
  - Administrator template: all four; Member template: `vendors.view` (P4-40). Owners receive them through the catalog sync.
  - Existing organizations' Administrator and Member roles receive them through the Phase 4 permission backfill migration (the approved plan's final 4B stage). Until then, only new organizations' roles and Owners hold them.
- **Archived vendors.** They stay readable (`GET /vendors/:id`, the `archived` and `all` lists). `VendorService.requireUsableVendorInTransaction` refuses an archived vendor, or a vendor whose party is archived, for new documents; later Purchases documents use it.
- **Web.** Purchases area (`/purchases/vendors`): list with search and status filter; new vendor (a new contact, or an existing one such as a customer); and detail (identity, terms and defaults, archive and restore, addresses, link to the contact record).
  - Permission-aware throughout.
  - Typed i18n keys `purchases.*`, rendered inside `LocaleProvider` for RTL readiness.
  - The default tax code picker shows only when the user can read tax codes. Bill keys gain tax-code viewing in a later stage.
- **Tests.** `test/vendors.test.ts` (14) and `apps/web/test/purchases.test.tsx` (8). The catalog and template pins in `unit`, `organizations` and `database` now include the vendor keys, and `s2-fixes` pins `0029`.

### 4A-4 — Purchases settings, numbering, AP control, catalog purchase fields (P4-05, P4-06, P4-07, P4-08, P4-26, P4-39, P4-41, P4-42, P4-51), 2026-10-01

- **Shared numbering.** `modules/documents/numbering.ts` now holds `formatDocumentNumber`, `numberingView` and `planNumbering` (the "next number cannot go lower" rule). Sales uses them with unchanged behaviour and messages; Purchases reuses them.
- **Migration `0030_purchases_settings_catalog`.**
  - `purchases_settings` has one row per organization, created on the first save. It holds:
    - the AP control account and the default expense and payment accounts;
    - the default tax code, tax treatment and payment terms;
    - `ap_locked_at` and the version.

    Protections:
    - composite tenant FKs;
    - a CHECK that a lock needs an account;
    - a guard trigger: never deleted, identity immutable, and the AP account and lock fixed once `ap_locked_at` is set (mirrors Phase 3B D12);
    - no truncate, tenant RLS, no DELETE grant.

  - `purchases_number_sequences` has one row per document type: `bill` (`BILL-`), `vendor_credit` (`VC-`), `debit_note` (`DN-`), `vendor_payment` (`PAY-`), `vendor_refund` (`VR-`) and `expense` (`EXP-`), each with 5 digits starting at 1. Prefix, digit and range CHECKs match Sales. A guard trigger keeps rows undeleted, identity immutable and the next number from moving backwards.
  - `sales_items` (the shared catalog, P4-05; table name unchanged) gains:
    - `is_sold` (default true) and `is_purchased` (default false);
    - `purchase_description`;
    - `purchase_unit_cost` (numeric 28,4, not negative);
    - `expense_account_id` and `purchase_tax_code_id`, as composite tenant FKs.

    A CHECK requires at least one facet. Existing items stay sold and not purchased.
- **Catalog module.** `modules/catalog` now owns the items table, data access and `CatalogPermissions`; `modules/sales` re-exports it. Audit actions stay `sales_item.*`, unchanged.
- **AP control (P4-08).**
  - `PurchasesSettingsService` claims and releases the AP account only through `accounting.setSubledgerControlInTransaction({ subledger: 'purchases', … })` (4A-1). That operation enforces:
    - LIABILITY / `ACCOUNTS_PAYABLE`, active, leaf, base currency;
    - no designation;
    - not owned by Sales;
    - no postings from outside Purchases.

    It also audits `account.control_marked` and `account.control_released`.

  - Changing the AP account moves the flag; clearing it releases the flag.
  - Once `ap_locked_at` is set, a different AP account is refused at the API, and the database refuses it as well. Nothing in 4A-4 sets the lock; the first Purchases posting will, through `lockApAccount`.
  - The settings view suggests the single eligible unowned AP account with no postings, as Sales does for AR.
- **Settings validation.**
  - The default expense account follows P4-19 (`purchaseAccountProblem`).
  - The default payment account must be an active, non-control leaf of subtype bank, cash or `CREDIT_CARD` (P4-26). Its currency is not restricted here; Decision 42's currency rules apply when a payment is recorded (Sales parity).
  - The default tax code must be active. The P4-11 input-account requirement is checked by the documents that use it.
  - Strict schemas, version CAS, and audit `purchases_settings.created` / `.updated`, with before/after values and numbering changes. An unchanged save neither bumps the version nor writes an audit event.
- **Numbering (P4-51, R37).** `takeNextPurchaseNumber` locks the sequence row with `UPDATE … RETURNING`, so concurrent posters get distinct numbers. It is for posting or recording only, never for drafts. A rolled-back posting leaves a gap, which is allowed. Bills are not implemented, so nothing calls it yet.
- **Permissions, MFA and re-authentication.**
  - `purchases.settings.manage` (P4-39) is needed to read and to change the settings. Bill keys gain read access when Bills exist.
  - It joins `HIGH_PRIVILEGE_PERMISSIONS` (P4-41). Saving is a sensitive action that needs a recent password confirmation (P4-42).
  - The Administrator template holds it, the Member template does not, and Owners receive it through the catalog sync. Existing organizations' Administrator roles receive it through the final 4B Phase 4 backfill.
  - Holders of `purchases.settings.manage` may read tax codes, to choose the default.
- **Catalog permission (P4-06, amended).**
  - `catalog.items.manage` governs creating, editing, archiving and restoring items. `sales.items.manage` is retained and still permits the same actions during the transition.
  - Viewing needs `invoices.view` or either manage key. A vendors-only role cannot see items yet; bill keys join later.
  - Migration `0031_catalog_items_permission_backfill` grants the new key to every role that holds `sales.items.manage`, custom roles included. It is additive and idempotent, audited per role as `role.permissions_backfilled` with request `migration:0031_catalog_items_permission_backfill`. Roles are selected through `roles`, so test replays can scope them. The Administrator template holds the key.
  - Tax codes stay readable for catalog managers. The items import and export keep their Phase 3B permission until the data-exchange stages (P4-47, P4-48).
- **Sales compatibility.** An item that is not sold is refused on Sales document lines ("X is not sold."), except on lines that keep an item already on the document; the line picker hides such items. All other Sales behaviour is unchanged; an item created without facets is sold and not purchased, as before.
- **Web.**
  - `/purchases/settings` covers the AP account (disabled once locked), default accounts, tax code, treatment, terms and a numbering table with a live preview. Saving uses `useSensitiveAction`.
  - The Purchases navigation adds Settings and Items. Items links to the single shared `/sales/items` page.
  - The Purchases area shows for `vendors.view`, `purchases.settings.manage` or a catalog key, and its index opens the first page the user may see.
  - The items page gains the sold/purchased facets, purchase cost, expense account (P4-19 subtypes), purchase tax code and purchase description. Managing needs either catalog key.
- **Interpretations (no decision changed).**
  - Debit notes have their own `DN-` sequence.
  - A duplicate-check mode setting is not added; P4-18 fixes the behaviour, and it belongs to Bills.
  - The AP account may be left empty when saving; missing accounts will block posting, as in Sales D7.
- **Not in 4A-4.**
  - Bills, vendor credits, payments, refunds and expenses; opening bills.
  - P4-10 drill-down, P4-11 to P4-13 input tax, the P4-36 S8 AP guard.
  - AP reports, the revaluation workflow and the remaining permission backfill.
- **Tests.**
  - `test/purchases-setup.test.ts` (13): settings, AP control, numbering including concurrency and gaps, catalog fields, Sales refusal of unsold items, permissions, MFA, re-authentication and RLS.
  - `test/catalog-permissions.test.ts` (2, serial): the 0031 replay.
  - `apps/web/test/purchases.test.tsx` (+6).
  - Pins: the catalog and Administrator template in `unit`; 61 keys in `organizations` and `database`; the MFA set in `mfa-unit`; `0030` and `0031` in `s2-fixes`.

### 4A-5 audit (Bills) — stopped on the input-tax dependency, 2026-10-01

- The Bills impact audit found that taxed bill lines cannot post correctly without P4-11 (input tax account) and P4-12 (recoverability): the bill journal rule debits recoverable tax to an input account and capitalizes non-recoverable tax. The decision maker chose to implement P4-11 to P4-13 first (option A); Bills were not started, and no untaxed-only variant was built.

### Input-tax stage (P4-11, P4-12, P4-13), 2026-10-01

- **Impact audit.**
  - Tax codes (`0020`) have one output account (`tax_account_id`, a liability). Rates are immutable, effective-dated versions; documents snapshot the rate they used. None of this changes.
  - The brief's data model defines the input account as optional on the code and "an asset (application rule)", and each purchase line snapshots `tax_recoverable`, recoverable tax and non-recoverable tax. Bill lines belong to the Bills stage, so the line flag and snapshot columns are created with Bills.
  - **Genuine gap, decided 2026-10-01:** P4-12 defaults recoverability from "the item or vendor default", but the frozen vendor (4A-3) and catalog (4A-4) models had no such field. The decision maker chose to add nullable defaults to both (NULL means no default).
  - Permissions: no new keys. Input-account changes are `tax.codes.manage` with re-authentication (P4-42, unchanged). The per-line override needs `bills.create` and is enforced by Bills. MFA is unchanged.
  - Sales: output tax keeps `tax_account_id`; invoices, credit notes and receipts are unchanged.
  - Existing organizations: nothing is inferred (P4-13, Decision 54); their codes stay unmapped until set explicitly.
  - Interaction with Bills: the pure rules and the purchase journal builder below are ready for Bills to use.
- **Migration `0032_input_tax`** (additive only; no row updated):
  - `tax_codes.input_tax_account_id`: nullable, composite tenant FK.
  - `sales_items.purchase_tax_recoverable` and `vendors.default_tax_recoverable`: nullable booleans.
- **Input tax account rule** (tax service, mirroring the output rule): an active leaf ASSET account in the base currency, not a control account. It is checked on create, on change and when an archived code is restored. Clearing it (`null`) is allowed and audited. The output rule is unchanged.
- **Template (P4-13).** The Maldives chart, where the GST codes are seeded, gains `1160 GST Input Tax Recoverable` (`OTHER_CURRENT_ASSET`, under 1100). New Maldives organizations get GST and TGST mapped to it. Other templates are unchanged; they seed no tax codes. No `PREPAID_EXPENSE` subtype; Decision 53 is unchanged.
- **Pure rules** (`modules/tax/input-tax.ts`):
  - `purchaseTaxCodeProblem`: guidance when a code is archived, has no input account, or its account is missing, archived or no longer a usable asset (P4-11).
  - `gstRegisteredOn` and `defaultTaxRecoverable`: not registered on the document date gives false; otherwise the item default, then the vendor default, otherwise true. The registration date is inclusive.
  - `splitLineTax`: all of a line's tax is either recoverable or not.
  - `PurchaseLineTaxSnapshot`: code, rate version and percentage, recoverability, amounts and the input account resolved at posting, for Bills to persist.
- **Shared engine.** `buildPurchaseJournal` (documents module) reuses the Sales builder and only renames the line roles to `payable`, `expense` and `tax`. A bill debits each line's account with net plus non-recoverable tax, debits input tax per code and credits AP; a vendor credit is the reverse. Grouping, D10 dimension merge, base conversion and rounding are shared, and Sales output is byte-identical (golden test and a direct assertion).
- **API.** `POST /tax/codes` accepts `inputTaxAccountId` (optional, null by default) and `PATCH /tax/codes/:id` can set or clear it; views include it. Vendors accept `defaultTaxRecoverable` and items accept `purchaseTaxRecoverable` (nullable booleans). All schemas are strict, and changes are audited through the existing events.
- **Web.**
  - Tax codes: each card shows its input account, or "Not set: this code cannot be used on purchases yet". Users with `tax.codes.manage` can set or change it (asset accounts only, re-authenticated), and the create form has the field.
  - Vendor and item purchase forms: a "Tax recoverable by default" choice (No default, Recoverable, Not recoverable).
- **Tests.**
  - `test/input-tax.test.ts` (18): template and seed mapping, migration additivity, validation (asset, leaf, base currency, non-control, active, tenant), create/change/clear audit, version conflict, restore re-check, permission and re-authentication, RLS and the composite FK.
  - Also covered there: vendor and item defaults, the defaulting matrix, the split, the purchase journal (recoverable, capitalized, mixed, FX base balance, dimensions, vendor-credit reverse), Sales builder unchanged, effective-dated rates, and an issued invoice crediting 2130 and never 1160.
  - Web: `purchases.test.tsx` (+3).
  - Pin updates: 36 Maldives accounts in `accounting` and `decisions-79-91`; the vendor column list; `0032` in `s2-fixes`.
- **Not in this stage:** Bills (the line flag columns, override enforcement with `bills.create`, posting), the P4-36 AP opening-balance guard, input-tax reporting, vendor credits, payments and anything later.

### 4A-5 — Bills (P4-11, P4-12, P4-15 to P4-22, P4-37, P4-39, P4-40, P4-42, P4-50, P4-51), 2026-10-01

- **Impact audit.** No blocking conflict. P4-11 to P4-13 were completed first (see the input-tax stage). The frozen text left these points open; each is recorded as an interpretation, not a decision change:
  - **Normalized supplier reference (P4-18):** case and whitespace are ignored; punctuation is kept. It is a database-generated `vendor_reference_key`. No statutory validation is invented.
  - **"Non-void bills" (P4-18):** read literally. Other drafts, pending and posted bills of the same vendor all count as duplicates.
  - **Line defaults:** the line's value, then the item's purchase default, then the vendor default, then the Purchases settings default (account and tax code). This matches the approved recoverability chain. The tax treatment defaults from Purchases settings, since vendors have no treatment field.
  - **P4-16 override permission:** setting or changing a manual rate on a draft needs `bills.post`. **P4-12 override:** an explicit per-line recoverability choice needs `bills.create`, which matters on the edit path that only needs `bills.edit_draft`.
  - **P4-22 evidence:** removable only while the bill is a draft (the Sales rule), so evidence an approver saw cannot disappear before posting.
  - **Required dimensions:** enforced at submit and at post, as the architecture rules say. Sales still checks only at issue (unchanged).
  - **Approve and reject:** use the shared approval routes. Rejecting a bill needs a reason, enforced in the bill's rejection callback, which rolls the decision back without changing the engine.
- **Migration `0033_bills`:**
  - `purchases_bills` and `purchases_bill_lines`, with composite tenant FKs (vendor, items, accounts, tax codes and rates, approval request, journals, event), RLS, no truncate and draft-only DELETE.
  - Status-consistency CHECKs. Posting requires the number, supplier reference, journal, rate, base total and open balance; a manual rate requires its reason; the open balance is bounded; void requires a zero balance.
  - The line tax split: recoverable plus non-recoverable equals the tax, all on one side.
  - Guards (the 0022 pattern):
    - lifecycle `DRAFT → PENDING_APPROVAL → POSTED → VOID`;
    - posted bills immutable except the open balance and the void;
    - a bill with a changed open balance cannot be voided;
    - lines immutable once posted.
  - Unique number per organization. Duplicate-check index on (organization, vendor, reference key) for non-void bills.
  - At most 200 lines (P4-50).
  - File link type `bill`.
- **Architecture:**
  - `application/purchase-documents.ts` holds the purchase-side resolution (vendor, P4-19 eligibility, item purchase defaults, tax rate on the date, the frozen P4-12 recoverability default) and posting (rate, input-tax lines, approval facts).
  - All arithmetic is the shared `calculateDocument`; the journal is the shared `buildPurchaseJournal`. Nothing is forked from Sales.
  - Shared helpers reused from Sales: `assertOpenPeriod`, `assertRequiredDimensions` (now also labels the purchase roles; Sales messages unchanged), `documentApprovalState`, `journalLine`.
  - `BillService` mirrors the invoice service's structure.
- **Permissions (P4-39, P4-40):**
  - `bills.view`, `bills.create`, `bills.edit_draft`, `bills.delete_draft`, `bills.post`, `bills.void`, `bills.approve`; the catalog now has 68 keys.
  - Administrator: all bill keys. Member: `bills.view`. Owners get them through the catalog sync. Existing organizations' roles get them through the final 4B permission backfill.
  - Submit and withdraw need `bills.create`.
  - `bills.view` reads the shared catalog (P4-06 amended). `bills.view` and `bills.create` read tax codes.
- **MFA and re-authentication:** void needs a recent password (P4-42). Post and approval have no extra re-authentication, as in the approved list. MFA is unchanged.
- **Approval (P4-15, P4-37):**
  - Action `purchases.bill.post`, types `standard` and `opening`, approver `bills.approve`. The amount is the AP line's base at the bill rate.
  - No matching policy: Post directly (submitting is refused). With a policy, approval is required.
  - No self-approval: the preparer and the submitter are excluded.
  - Steps and facts are snapshotted; policy edits do not change open requests. Post re-checks approval against the recomputed facts (S10-06). Approval never posts.
- **Accounting:**
  - Post locks the bill and the Purchases settings row, then recomputes with current references.
  - It requires the supplier reference (P4-17), the AP account, line accounts, usable input tax accounts (P4-11), a rate, approval, an open period and required dimensions.
  - It runs the duplicate check under a transaction advisory lock (P4-18), takes the number (P4-51, skipping used numbers), and posts the `purchases.bill_posted` event (key `bill:<id>:posted`).
  - The journal source is `purchases`/`bill`/bill id. It is a domain-approved event journal: Dr each line's account (net plus non-recoverable tax), Dr the input tax account per code (recoverable), Cr AP. The AP line's base credit becomes `base_total` and `base_due`.
  - The first post sets `ap_locked_at`.
  - Manual journals to AP stay refused, and the bill journal is reversed only through Purchases.
- **Tax:**
  - Lines store the code, rate version and percentage, the explicit recoverability choice and the resolved flag, and the recoverable and non-recoverable amounts.
  - The input tax account is snapshotted at post. Posted snapshots are immutable.
  - Output tax accounts are never used by purchases.
- **FX:**
  - The currency defaults to the vendor's (P4-20).
  - At post: the table rate on the bill date, or the manual override with its reason. `exchange_rate`, `exchange_rate_source` (`base`, `table`, `manual`) and `table_rate` are stored, and the journal records `manual` or `table`.
  - Audit events `bill.rate_overridden` (at post) and the override in `bill.created` / `bill.updated`. No AP revaluation.
- **Idempotency:** scopes `purchases.bill.create` and `purchases.bill.post` on the Phase 3B mechanism. The event key also prevents a second journal for the same bill.
- **Audit:** `bill.created`, `.updated`, `.deleted`, `.submitted`, `.approved`, `.rejected` (with the reason), `.withdrawn`, `.posted`, `.duplicate_confirmed` (reason and duplicate ids), `.rate_overridden` and `.voided` (reason, reversal journal).
- **Void (P4-21):** posted, unpaid (`amount_due = total`), `bills.void` plus re-authentication. It reverses through `reverseSubledgerJournalInTransaction('purchases', …)` on the bill date, so a closed period is refused. The original journal stays and becomes REVERSED, and the bill keeps its record. Payments will reduce the open balance in a later stage; the guard already refuses voiding a bill whose balance changed.
- **API:**
  - `GET/POST /purchases/bills`; `GET/PUT/DELETE /purchases/bills/:id`; `POST …/submit`, `…/withdraw`, `…/post` (optional `duplicateReason`) and `…/void`.
  - Approve and reject: `POST /approvals/requests/:id/approve|reject`.
  - Strict zod schemas; the `Idempotency-Key` header on create and post. New error code `DUPLICATE_VENDOR_REFERENCE` (409, with the matching bills).
- **Web:**
  - `/purchases/bills`: list, search and status filter, plus an approval queue (approve, or reject with a reason).
  - New and edit: vendor; supplier reference; dates; currency; manual rate and reason, shown to `bills.post` holders for foreign currencies; treatment; document dimensions; lines with purchased items, P4-19 accounts, tax code and recoverability choice.
  - Detail: summary with the rate, table rate and reasons; submit, withdraw, Post (disabled until ready); duplicate confirmation; void with reason; delete draft; version-conflict reload; evidence.
  - The Purchases navigation adds Bills, and the Purchases home opens Bills first.
- **Tests:**
  - `test/bills.test.ts` (27): drafts and defaults, versions and deletion, vendor rules (archived, cross-tenant), P4-19 eligibility and the facet, the recoverability chain and its override permission, GST registration, recoverable vs capitalized journal amounts and frozen snapshots, the P4-11 block, effective-dated rates.
  - Also covered there: event/journal source, AP lock, manual-journal and reversal refusal, database immutability; required fields to post; concurrent numbering and gaps; idempotent create/post and a single event; duplicate block and confirmation, warning-only same amount; table and manual rates with permission and audit.
  - And: no-policy direct post, conditional thresholds, self-approval, separate post, snapshotted steps, reject reason, withdrawal, approval/post race; required dimensions at submit and post and immutability; void with re-authentication, reversal and closed period; the paid-bill guard; evidence; permissions; RLS; templates.
  - `apps/web/test/bills.test.tsx` (8).
  - Pin updates: 68 keys in `organizations` and `database`; the catalog and Member template in `unit`; `0033` in `s2-fixes`.
- **Not yet built** (outside 4A-5):
  - P4-36 AP opening-balance guard. It must be implemented and verified before the 4A checkpoint commit, so the AP control invariant (I-1) cannot be broken by S8 opening lines.
  - P4-10 drill-down UI; the source metadata is in place.
  - Vendor credits, payments, prepayments, refunds, batch Pay Bills, opening bills, direct expenses, AP aging, statements, reconciliation and reports, remittance and debit-note PDFs and email, imports and exports, AP revaluation, vendor bank details, purchase orders, receiving, inventory and 3-way matching, XLSX, production email.

### P4-36 — AP opening-balance guard, 2026-10-03

- **Impact audit.** No conflict. S8-07 is enforced in two places:
  - **Application:** the pure rule `openingLineIssues` (`modules/accounting/opening-balances.ts`). One path feeds it everywhere through `OpeningBalanceService.lineIssues`:
    - draft line save (manual entry);
    - the opening-balance import's row validation (preview of the import);
    - `evaluate` (preview, submit and post), which re-runs inside the posting transaction after the batch is locked.
  - **Database:** the trigger `accounting_guard_opening_balance_line_account` (migration `0017`) on every opening line inserted or re-pointed.
  - Approval (`accounting.opening_balance.post`), re-authentication, MFA, audit, the system-journal posting and the batch reversal do not depend on account subtypes and are unchanged. No permission is added.
- **The rule:** a line whose account has subtype `ACCOUNTS_PAYABLE` is refused. The check is on the subtype, not only on `control_subledger = 'purchases'`, so a payables account is refused before it becomes the AP control account too. Guidance: "Accounts payable cannot be given an opening balance here. Vendor balances are brought in as opening bills and opening vendor credits in the Purchases module…". When the account is already a control account, the existing control message applies; it is checked first, as for receivables.
- **Unchanged:** the receivable, control-account, unclassified (explicit subtype required), OBE, parent, archived, P&L, amount and dimension rules. Ordinary assets and liabilities (cash, prepaid `OTHER_CURRENT_ASSET`, accrued `OTHER_CURRENT_LIABILITY`, long-term liabilities) are unaffected. Decision 53 is unchanged; no `PREPAID_EXPENSE` subtype.
- **Migration `0034_opening_balance_ap_guard`:** required, because S8-07's architecture keeps a database backstop for the same rule (P4-36 says "application rule and trigger"). It `CREATE OR REPLACE`s the 0017 trigger function, adding the `ACCOUNTS_PAYABLE` refusal, and touches no rows. Existing posted AP opening balances, if any, are left for guidance, never converted automatically (P4-36). A draft line saved before an account became payables is caught at preview and post by the application rule; the trigger fires on line writes.
- **Web:** the opening-balance account picker also leaves out payables (display only; the server decides).
- **Tests:**
  - `test/opening-balance-ap-guard.test.ts` (6, serial):
    - AP refused at save (template AP and a new AP account, before any control marking);
    - the Purchases AP control account refused (control rule), with AR and unclassified accounts still refused;
    - ordinary assets and liabilities still save, preview, post and reverse;
    - an account reclassified to AP after saving is refused at preview and at post, with no journal written and the batch left as a draft;
    - an AP row refused in an import;
    - the trigger refuses a direct AP line insert; another tenant's account is unknown; RLS isolates batches.
  - `opening-balances-unit.test.ts` (+1): AP, AP control and an ordinary liability.
  - `s2-fixes` pins `0034`.
  - Required dimensions, approval, re-authentication and reversal stay covered by the existing `opening-balances.test.ts`, unchanged and green.
- **Regression:**
  - Focused tests 21/21, twice.
  - API 52 files / 685 tests, twice. This includes Bills (27/27) with AP control and subledger reconciliation, Sales, accounting and the RLS and security suites.
  - Web 12 files / 122 tests.
  - Typecheck, lint and Prettier clean; migrations 0001–0034 checksums 34/34.
- **Deviations:** none. **Not started:** any 4B functionality, opening bills and opening vendor credits, vendor credits, payments, refunds, AP reports, AP revaluation, remittance, direct expenses and the drill-down.

### Phase 4A checkpoint verification, 2026-10-03

- **Scope (4A):**
  - 4A-0 shared document engine;
  - 4A-1 control-account ownership and the P4-08 integrity guard;
  - 4A-2 generalized subledger reversal;
  - 4A-3 vendors;
  - 4A-4 Purchases settings, numbering and catalog;
  - P4-11 to P4-13 input tax and recoverability;
  - 4A-5 bills;
  - P4-36 AP opening-balance guard.

  Everything else in the decision register (vendor credits, payments, refunds, opening bills, expenses, reports, revaluation workflow, remittance and email, imports and exports, drill-down UI, the final permission backfill) is 4B and not implemented.

- **Migrations actually used:** these replace the planned numbering in "Architecture rules"; numbers stay sequential.

  | Migration | Content                                           |
  | --------- | ------------------------------------------------- |
  | `0027`    | subledger control ownership                       |
  | `0028`    | control-account integrity                         |
  | `0029`    | vendors                                           |
  | `0030`    | Purchases settings, sequences and catalog columns |
  | `0031`    | catalog permission backfill                       |
  | `0032`    | input tax                                         |
  | `0033`    | bills                                             |
  | `0034`    | AP opening-balance guard                          |

  `0001`–`0026` are unmodified. All 34 checksums match, every file is LF, and `db:migrate` is up to date.

- **Results:**

  | Check                                                                                 | Result                                              |
  | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
  | Full API suite, three consecutive runs                                                | 52 files / 685 tests each, no intermittent failures |
  | Full API suite, fourth run (per-file timings)                                         | 685 / 685                                           |
  | Focused 4A, opening-balance, golden, reversal, accounting, report and security suites | 17 files / 254 tests                                |
  | Web suite                                                                             | 12 files / 122 tests                                |
  | Typecheck, lint, Prettier, production build                                           | clean                                               |
  | `pnpm audit --prod`                                                                   | no known vulnerabilities                            |
  | Secret-pattern scan of the changed files                                              | no findings                                         |
  | New dependencies                                                                      | none                                                |

- **Accounting integrity audit** (shared dev/test database):
  - Every POSTED and REVERSED journal balances in transaction currency and in base.
  - Base-only lines appear only in system FX and revaluation journals.
  - 296 posted or void bills match their journals exactly (AP credit, recoverable input tax, capitalized lines).
  - No purchase line posts to an output-tax account.
  - Control-account ownership is consistent, and every `purchases` control account is `ACCOUNTS_PAYABLE`.
  - The seeded dev organization reconciles AR (3,863.63 = 3,863.63) and AP (0 = 0) after the browser E2E's bill post and void.
  - The remaining reconciliation exceptions all come from deliberate raw-SQL test fixtures in the never-truncated test database:
    - the "paid bill" test's `amount_due` reductions;
    - two bills voided by raw SQL in an early draft of that test;
    - synthetic `test-sales` and `test.p4a2` event journals;
    - pre-4A test accounts marked as control after manual postings.
- **Browser E2E (Owner, dev organization):** with the decision maker's approval, the dev organization's accounts 2110 and 5400 were classified and its Purchases settings saved; the AP account is now locked. Then: vendor created, bill drafted, posted (`BILL-00001`) and voided, and every 4A and Sales page swept. No 5xx and no application console errors. The only 4xx were `GET /auth/session` before sign-in and the preview tab opening the API root.
- **Fixed during the checkpoint:** the bill line tables showed the vendor/item label "Tax recoverable by default"; they now say "Tax recoverable".
- **Known notes (not 4A regressions, not changed):**
  - The `0033` bill guard checks lifecycle, balances and immutability, but not that the void journal is the reversal of the bill's journal (the same design as Sales invoices in `0022`). The application always voids through the Purchases reversal.
  - `outbox_events` and `security_events` have no RLS by Phase 1 design (`0001`).
  - The Sales tax-code form's liability picker also lists control accounts; the server refuses them.
  - Full-suite run time has grown to about 200–230 s with the never-truncated test database (about 43k organizations). The serial files take 37 s, and no single file dominates.

Phase 4A was committed as `4dee4cd` and is frozen.

### 4B-1 — vendor credits and debit notes (P4-11, P4-12, P4-23, P4-24, P4-37, P4-39, P4-40, P4-42, P4-46, P4-50, P4-51), 2026-10-03

- **Impact audit.** One conflict was resolved before coding (decided 2026-10-03):
  - The stage instructions said a debit note "increases the vendor liability". The frozen brief and P4-23 define both origins as a vendor credit that "reduces what we owe" with the "same accounting" ("Vendor credit: the reverse of a bill"; `amount_unapplied`).
  - **Decision: debit notes reduce AP**, as frozen.

  Three open points were decided at the same time:
  - **Bill link:** a vendor credit may reference a posted bill of the same vendor, in the bill's currency, but posting does not apply it. Application comes with the later settlement stage; no allocation structure is built now.
  - **Rate:** a linked foreign-currency credit uses the bill's posted rate (source `bill`, Sales credit-note parity). An unlinked one uses the table rate on the credit date, or a manual override with a reason (`vendor_credits.post`, P4-16 parity). A linked credit cannot override.
  - **Reference:** supplier credit notes need the supplier's credit-note number to post (optional on drafts). Duplicates are a warning only; no blocking rule is invented. Debit notes have no supplier reference; they carry our `DN-` number.

- **Reuse:**
  - Resolution and posting reuse `purchase-documents.ts`: the shared calculation engine, the frozen P4-12 recoverability chain, P4-19 eligibility, P4-11 input-tax checks and `buildPurchaseJournal` with direction `vendor_credit`. `purchaseDocumentPosting` gained an optional fixed rate for the bill link; Bills are unchanged except a type-only narrowing.
  - Shared helpers from Sales: `assertOpenPeriod`, `assertRequiredDimensions`, `documentApprovalState`, `journalLine`. Plus the approval engine, Phase 3B idempotency, `takeNextPurchaseNumber`, the `reverseSubledgerJournalInTransaction('purchases', …)` reversal, the file and job services, and the PDFKit renderer.
  - The renderer change is additive: a `DEBIT NOTE` title, an optional bill number and counterparty label. Sales snapshots are unaffected.
- **Migration `0035_vendor_credits`:**
  - `purchases_vendor_credits` and `purchases_vendor_credit_lines`, with composite tenant FKs (vendor, bill, accounts, tax codes and rates, approval, journals, event, PDF file) and status-consistency CHECKs:
    - posting requires the number, journal, rate, base and unapplied amounts; supplier notes also require the reference, and debit notes the render snapshot;
    - a `manual` rate source requires its reason, and a `bill` source requires the bill link;
    - the PDF only on posted debit notes;
    - void only with zero unapplied.
  - Guard triggers: the lifecycle; posted documents immutable except the unapplied balance, the PDF (set once) and the void; void refused once applied or refunded; lines immutable once posted; draft-only delete.
  - `purchases_document_emails`, mirroring `sales_document_emails`.
  - File link type `vendor_credit`.
  - RLS, no truncate, no PUBLIC grants.
- **Permissions:**
  - `vendor_credits.view`, `create`, `post`, `void`, `approve` (P4-39); the catalog now has 73 keys.
  - Administrator: all five. Member: `vendor_credits.view` (P4-40). Existing organizations get them through the final 4B backfill.
  - Drafts are edited, deleted, submitted and withdrawn under `vendor_credits.create`, because the catalog has no separate draft keys (Sales credit-note parity).
  - Vendor-credit users can read tax codes.
- **MFA and re-authentication:** posting and voiding a vendor credit need a recent password (P4-42). MFA is unchanged.
- **Approval:** action `purchases.vendor_credit.post`, transaction types `supplier_credit_note` and `debit_note`, approver `vendor_credits.approve`. The amount is the AP line's base. No self-approval; a rejection needs a reason; steps are snapshotted; Post re-checks approval and approval never posts.
- **Accounting:** Post runs through the `purchases.vendor_credit_posted` event (key `vendor_credit:<id>:posted`).
  - Journal: Dr AP (total) / Cr each line's account (net plus non-recoverable tax) / Cr each code's input-tax account (recoverable tax).
  - Source `purchases`/`vendor_credit`/id. `base_total` and `base_unapplied` come from the AP line's base debit.
  - The first Purchases posting fixes the AP account. The AP invariant is now: AP control = Σ posted bills `base_due` − Σ posted vendor credits `base_unapplied` (verified).
- **Numbering:** `VC-` for supplier credit notes and `DN-` for debit notes, at post, not gapless.
- **Debit-note output (P4-46):**
  - `PurchasesOutputService` (jobs `purchases.document_pdf` and `purchases.document_email`) renders from the frozen snapshot, stores the PDF under legal hold and links it once.
  - Email goes to the vendor (default: the party's email) through the email provider, with the PDF attached; sending needs `vendor_credits.post`. The production email vendor stays deferred (U18).
  - Supplier credit notes get no generated PDF; their evidence is an attachment.
- **API:**
  - `GET/POST /purchases/vendor-credits`; `GET/PUT/DELETE /purchases/vendor-credits/:id`; `POST …/submit`, `…/withdraw`, `…/post`, `…/void`; `GET …/pdf`, `GET …/emails`, `POST …/email`.
  - Strict schemas; `Idempotency-Key` on create and post (scopes `purchases.vendor_credit.create` and `.post`).
- **Web:** `/purchases/vendor-credits`:
  - list with type and status filters and the approval queue;
  - editor with type, vendor, related bill, supplier reference (supplier notes only), date, currency, manual rate, dimensions, lines and recoverability;
  - detail with submit, withdraw, Post (re-authenticated), void, delete, the debit-note PDF and email panel, and evidence;
  - Purchases navigation link.

  The editor deliberately duplicates the Bills editor instead of refactoring the frozen 4A screen.

- **Tests:**
  - `test/vendor-credits.test.ts` (14):
    - both origins and validation (debit-note reference, bill link, strict schema);
    - draft edit, version and delete;
    - the journal shape, VC-/DN- numbering and AP reconciliation;
    - re-authentication on post, idempotency and a single event;
    - bill, table and manual rates with audit;
    - dimensions;
    - approval with conditions, self-approval, reject reason, withdrawal and posting;
    - void with re-authentication, reversal, closed period, and the applied-credit guard;
    - permissions, tenant isolation and RLS, templates.
  - `test/debit-note-output.test.ts` (3, serial): PDF under legal hold, email with attachment, no PDF for supplier credit notes.
  - `apps/web/test/vendor-credits.test.tsx` (6, including PDF polling added after the E2E).
  - Pin updates: 73 keys in `organizations` and `database`, the catalog and Member template in `unit`, `0035` in `s2-fixes`.
- **Regression:**

  | Check                                       | Result                           |
  | ------------------------------------------- | -------------------------------- |
  | API, two full runs                          | 54 files / 702 tests, both runs  |
  | Web                                         | 13 files / 128 tests (after E2E) |
  | Typecheck, lint, Prettier, production build | clean                            |
  | Migrations 0001–0035                        | 35/35 checksums, LF              |

  Integrity audit:
  - 54 posted or void credits match their journals; no output-tax use; no orphans.
  - AP reconciles except 3 organizations where the void test simulated an application by raw SQL.
  - The dev organization reconciles (AR 3,863.63; AP 0).

- **Owner browser E2E (2026-10-03, dev org):** both origins created, linked to posted bills and posted (VC-00001 at the bill rate 15.5 against table 15.6; DN-00001 in MVR). The supplier reference was refused at post when missing. Bills were left unapplied. AP reconciled at every step (final GL 2,705.00 = bills 3,600.00 − credits 895.00), and AR was unchanged. The DN PDF was generated under legal hold and emailed through the mock. VC-00002 was voided via a Purchases reversal. Re-authentication was prompted after the 15-minute window. Bills, Sales and Accounting pages were clean.
  - Fix from the E2E: the debit-note PDF panel now re-checks while the PDF is pending (Sales parity).
  - Noted, unchanged: post-validation details show only the generic headline (shared `ErrorAlert`, same as Bills); the email list shows "queued" until reload (same as Sales).
- **Not implemented (later stages):** credit application to bills, vendor payments, prepayments, refunds (P4-24's "unrefunded" condition is enforced through `amount_unapplied`), batch Pay Bills, AP aging, statements and reconciliation UI, AP revaluation, direct expenses, Purchases imports and exports, the drill-down UI, the final permission backfill.

Phase 4B-1 was committed as `a185451` and is frozen.

### 4B-2 — payments, allocations, prepayments and realized FX (P4-10, P4-25 to P4-29, P4-33, P4-34, P4-37, P4-39, P4-40, P4-42, P4-50, P4-51), 2026-10-04

- **Decisions (approved 2026-10-04 after the impact audit):**
  - **C1:** one **net** realized-FX base-only line per payment or application journal; every allocation keeps its own `fx_difference`. The 497-bill limit fits the 500-line journal cap: 497 AP lines, the prepayment line, the payment-account line and the FX line.
  - **C2:** payment allocations target **posted bills only**; a payment is never allocated to a vendor credit. Vendor credits and prepayments are sources applied to bills later.
  - **C3:** P4-42 unchanged: re-authentication on payment void only. Rate (P4-27) and account (P4-28) overrides need `vendor_payments.create` only.
  - **A1:** drafts, with the idempotency scope `purchases.payment.create`; recording uses `purchases.payment.record`.
  - **A2:** credit application uses `vendor_payments.create`.
  - **A3:** vendor-credit → bill and prepayment → bill application are in 4B-2.
  - **A4:** the approval transaction type is `prepayment` without planned bills, otherwise `payment`.
  - **A5 (amended):** the minimal P4-10 source-document registry is in 4B-2 (below).
  - **A6:** remittance-advice PDF and email stay deferred.
- **Migration `0036_vendor_payments`:**
  - `purchases_payments`: `DRAFT → PENDING_APPROVAL → RECORDED → VOID`.
    - A draft holds the optional account and rate overrides.
    - Record fixes the number, account, rate (with the table rate kept), base amount and the prepayment balance (`amount_unallocated`, `base_unallocated`: the I-1 term).
    - CHECKs: the override reason, the recorded facts, the open balance and the void.
    - Guard trigger: drafts change and may be deleted; recorded payments are immutable except the prepayment balance and the void.
  - `purchases_payment_planned_allocations`: a draft's bills (at most 497, each once). A trigger allows changes only while the payment is a draft; the rows are kept afterwards as the plan.
  - `purchases_allocations`: append-only settlement rows.
    - `source_type` is `payment` or `vendor_credit`.
    - `mode` is `payment` (at record) or `credit` (an application, grouped by `application_id`).
    - CHECK **`fx_difference = base_relieved − source_base`** (the AP sign).
    - Reversal rows negate the original and point at it; a row is reversed at most once.
  - Foreign keys scoped to the organization; tenant RLS, no truncate, no PUBLIC grants. `intuit_app` gets SELECT and INSERT only on allocations.
  - No existing migration or table changed: the 0033 and 0035 guards already let open balances change and refuse voiding paid bills or applied credits.
- **Shared engine:** `settlePayment` and `settleApCredit` in `modules/documents/settlement.ts` wrap the receipt and credit arithmetic and return the AP-sign FX. The Sales functions are unchanged and the golden test passes.
- **Accounting:**
  - Events `purchases.payment_recorded` (key `payment:<id>:recorded`) and `purchases.credit_applied` (key `credit:<type>:<id>:<application>`).
  - **Payment:**
    - Dr AP per bill at the bill's historical base relieved.
    - Dr AP for the excess (prepayment) at the payment rate.
    - Cr the payment account at the payment rate.
    - One net base-only FX line on the `REALIZED_FX_GAIN_LOSS` designation (positive = gain = base credit).
    - With no FX in any part it is an ordinary event journal (source `purchases/payment/<id>`); otherwise a `realized_fx` system journal with explicit bases (E1).
  - **Application:** Dr AP per bill relieved / Cr AP for the credit released at its historical base / the net FX. Without FX it is a base-currency journal (Sales clarification parity).
  - A credit linked to a bill (4B-1, bill rate) applied to that bill realizes nothing.
  - **Rate:** the table rate on the payment date, or a manual override with a reason; base-currency payments use 1. The designation is required only when net FX is posted.
  - **Lock order:** payment (or source), Purchases settings (AP lock), bills by ascending id. The first Purchases posting may be a prepayment (`lockApAccount`).
- **Void (P4-33):**
  - Needs `vendor_payments.void` and re-authentication.
  - Reverses the payment journal, and every application funded by its prepayment, through `reverseSubledgerJournalInTransaction('purchases', …)` on the original dates; a closed period gives `PERIOD_CLOSED`.
  - Realized-FX journals are mirrored by that path, never reversed generically.
  - Writes reversing allocation rows and restores the bills' balances.
  - Vendor-credit applications are not reversible (Sales parity), so an applied credit cannot be voided.
- **Account eligibility (P4-26, Decision 42):** active, leaf, not a control account, subtype BANK, CASH or CREDIT_CARD, in the payment currency or the base currency. Never inferred from names.
- **Permissions:** `vendor_payments.{view,create,void,approve}`; the catalog now has 77 keys. Administrator gets all four and Member gets view (templates); existing organizations get them through the final Phase 4 backfill. The MFA set is unchanged.
- **Approval:** action `purchases.payment.record`, types `payment` and `prepayment`, approver `vendor_payments.approve`. No self-approval; a rejection needs a reason; withdrawal is supported; record re-checks the facts and refuses an outdated approval.
- **Source-document registry (P4-10, A5):** `application/source-documents.ts`.
  - No table: journals already carry an immutable `source_module`, `source_type` and `source_id`. Resolvers read the owning modules through their contracts inside the organization-scoped transaction (RLS), so a reference never crosses tenants.
  - Registered:
    - Purchases: bill, vendor credit, payment, credit application, and realized FX (payment or application).
    - Sales: invoice (and AR opening invoice), credit note, receipt (and a receipt's realized FX).

    Sales credit applications are not stored as documents and do not resolve.

  - The journal detail returns `sourceDocument` with `relation` `source` or `reversal`; a generically reversed event journal resolves through its original.
  - The web journal page links to the document, and the payment, bill and vendor-credit pages link to their journals. Ledger rows link to journals as before, so the path is report → account → journal → document.
- **API:**
  - `GET/POST /purchases/payments`, `GET /purchases/payments/open-bills`, `GET/PUT/DELETE /purchases/payments/:id`;
  - `POST …/submit`, `…/withdraw`, `…/record`, `…/void`;
  - `POST /purchases/credit-applications`;
  - `GET /purchases/bills/:id/allocations`, `GET /purchases/vendor-credits/:id/allocations`.

  Strict schemas; at most 497 allocations.

- **Web:**
  - `/purchases/payments`: list, approval queue, editor with open bills, and a detail page with the settlement, the apply-prepayment panel and void.
  - Vendor-credit detail gains the settlement history and "Apply to bills"; bill detail gains the settlement history and a journal link. Both are additive to the 4A and 4B-1 screens.
  - Purchases navigation link and i18n keys.
- **Tests:**
  - API: `test/vendor-payments.test.ts` (23) and `test/vendor-payment-limit.test.ts` (497 bills, 500 journal lines, one FX line).
  - Unit tests for the registry and the AP settlement.
  - Pin updates: 77 keys, Member templates, `0036`.
  - Web: `vendor-payments.test.tsx` (6) and the journal source-document test.
- **Regression:**

  | Check                            | Result                          |
  | -------------------------------- | ------------------------------- |
  | API, two full runs               | 56 files / 729 tests, both runs |
  | Web                              | 14 files / 135 tests            |
  | Typecheck, lint, Prettier, build | clean                           |
  | Migrations 0001–0036             | 36/36 checksums, LF             |

  Integrity audit:
  - All journals balance; every recorded payment's account line equals its base amount; at most one FX line per journal.
  - Per-allocation FX sums equal each journal's FX line, and reversal rows pair up.
  - AP I-1 reconciles in every organization with payments.
  - The remaining mismatches belong to earlier test fixtures that changed balances by raw SQL (4A bills, 4B-1 credits; none have allocations).
  - 51 orphan `realized_fx` journals come from the 4A-2 reversal test's synthetic sources.

- **Owner and second-user browser E2E (2026-10-04, dev organization):**

  | Step                                                           | Result                                                                                                                                     |
  | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
  | MVR partial payment                                            | PAY-00001                                                                                                                                  |
  | USD payment at 15.60 against a 15.5 bill                       | approved by a second user, then recorded (PAY-00004); one FX line, loss 10.00                                                              |
  | Excess payment                                                 | PAY-00002, with a prepayment                                                                                                               |
  | Applications                                                   | a prepayment application and a vendor-credit application                                                                                   |
  | Credit-card payment with a manual rate and an account override | PAY-00003, loss 1.50                                                                                                                       |
  | Void of PAY-00002 (after the 15-minute window)                 | password prompt shown; payment and prepayment-application journals reversed; BILL-00002 back to 200.00; AP 390.00 = 510.00 − 120.00 − 0.00 |
  | Generic reversal of a realized-FX journal                      | refused (409)                                                                                                                              |
  | Source-document drill-down                                     | working                                                                                                                                    |
  | AP I-1                                                         | reconciled: 140.00 = 360.00 − 120.00 − 100.00                                                                                              |
  | AR                                                             | unchanged                                                                                                                                  |
  | Bills, Vendor credits, Sales and Accounting pages              | clean                                                                                                                                      |

  Dev setup made for it:
  - account 4950 Realized FX Gain/Loss, designated;
  - account 2140 Company Credit Card;
  - a "Payment approver" role for member@;
  - a `purchases.payment.record` policy (≥ 1,000 MVR, type payment).

- **Noted, unchanged:**
  - Allocation rows written in one statement share a timestamp and list in id order.
- **Pre-commit UI fixes (2026-10-04, after the architecture review):**
  - The journal page no longer offers the generic "Reverse…" action for journals the server always refuses: Sales- and Purchases-owned journals and their reversals (E2, P4-09), and FX system journals (Decision 80). It shows why instead. Ordinary journals keep the action, and the server-side 409 protection is unchanged.
  - The shared approval panel takes a context-aware ready message: Sales keeps "The document can be issued"; bills and vendor credits say "can be posted"; payments say "The payment can be recorded".
- **Not implemented (later stages):** vendor refunds (P4-30), batch Pay Bills (P4-32), remittance advice (A6), AP aging, statements and the reconciliation UI, AP revaluation, direct expenses, Purchases imports and exports, opening bills and credits, the final permission backfill.

Phase 4B-2 was committed as `ee040e4` and is frozen.

### 4B-3 — vendor refunds and the payment void/refund rule (P4-24, P4-30, P4-33, P4-34, P4-42, P4-51), 2026-10-05

- **Decisions (approved 2026-10-05 after the impact audit):**
  - **Model:** a refund is a separate accounting transaction, not a reversal of a payment or an allocation.
  - **Sources:** a recorded payment's unallocated (prepayment) balance, or a posted vendor credit's unapplied balance. Refunds never touch bills or bill allocations.
  - **Journal:** Dr the refund account / Cr AP for the source's historical base released / one net base-only realized-FX line. **`fx_difference = base_received − base_released`**, positive = gain.
  - **Currency:** the source's currency.
  - **Amounts:** partial and multiple refunds are allowed up to the open balance; no over-refunds.
  - **Refund accounts (amendment):** **BANK and CASH only**; credit-card refunds are not designed in 4B-3. Payments keep bank, cash and credit card (P4-26). The eligibility is an explicit context, never inherited.
  - **Rate:** the table rate by default, or a manual override with a mandatory reason, under `vendor_payments.create`; the table rate is kept and audited.
  - **Permissions:** reuse `vendor_payments.view`, `.create` and `.void`, plus `vendor_credits.view` for vendor-credit sources. No `vendor_refunds.*` keys.
  - **Re-authentication:** on void only; recording a refund is not a sensitive action.
  - **Lifecycle:** `RECORDED → VOID`, with no draft and no approval.
  - **Payment void (P4-33):** refused while any active refund exists; there is no cascade.
- **Migration `0037_vendor_refunds`:**
  - `purchases_refunds`:
    - `VR-` number, unique per organization; vendor; `source_type` with exactly one of `payment_id` and `vendor_credit_id`;
    - date, currency, amount; refund account and whether it was overridden;
    - rate, rate source, table rate, override reason (CHECK: manual ⇔ reason);
    - `base_amount` (received), `base_released`, `fx_difference` (CHECK `= base_amount − base_released`);
    - journal and event links, void fields (CHECK: VOID ⇔ void fields), version.
  - Foreign keys scoped to the organization; indexes by payment, credit, vendor and date.
  - Guard trigger: no delete; VOID is final; a recorded refund is immutable except the void.
  - Tenant RLS, no truncate, no PUBLIC grants; `intuit_app` gets SELECT, INSERT and UPDATE (no DELETE).
  - **P4-33 backstop:** trigger `purchases_payments_refund_backstop` refuses a RECORDED → VOID change of a payment while a RECORDED refund references it.
  - Migrations 0035 and 0036 are untouched: the existing 0035 vendor-credit guard already refuses voiding a refunded credit, and the 0036 payment guard already allows the prepayment balance to change.
- **Code:**
  - `application/vendor-refund-service.ts` and `modules/purchases/refunds.ts`.
  - `settleRefund` (pure) in `modules/documents/settlement.ts`.
  - In the 4B-2 payment service: `settlementAccountProblem(…, 'payment' | 'refund')` (the explicit eligibility context; `paymentAccountProblem` keeps its messages) and `resolveSettlementRate` (shared rate resolution), with the payment code delegating to both.
  - The payment void now refuses active refunds ("This payment has active refunds. Void the refunds taken from this payment first.").
  - The source-document registry resolves `purchases/refund/<id>`, and refund realized-FX journals, to "Refund VR-…".
- **Accounting:**
  - Event `purchases.refund_recorded`, key `refund:<id>:recorded`, idempotency scope `purchases.refund.record`.
  - Without FX it is an ordinary event journal (source `purchases/refund/<id>`); with FX it is a Purchases `realized_fx` system journal with explicit bases.
  - **Lock order:** the source (payment or vendor credit) and then the refund, both on record and on void.
  - **Void:** `vendor_payments.void` plus re-authentication; the source must still be open and the original period open. It reverses the journal through `reverseSubledgerJournalInTransaction('purchases', …)`, which mirrors FX journals and refuses generic reversal; restores the source's exact amount and base; and audits `vendor_refund.voided`.
  - AP I-1 holds unchanged, because refunds reduce the payment's `base_unallocated` or the credit's `base_unapplied` by exactly the base credited to AP.
- **API:** `GET/POST /purchases/refunds`, `GET /purchases/refunds/:id`, `POST /purchases/refunds/:id/void`. Strict schemas.
- **Web:**
  - `/purchases/refunds`: list, record (with a source picker, pre-selected from a payment or vendor credit), and detail with void (re-authenticated).
  - Refund history on payment and vendor-credit detail, with "Refund prepayment" and "Refund credit" links.
  - The payment void card is replaced by the blocked message while refunds are active.
  - The refund account list offers bank and cash only.
  - Purchases navigation link and i18n keys.
- **Tests:**
  - API: `test/vendor-refunds.test.ts` (14).
  - Unit: `settleRefund`.
  - Pin: `0037` in `s2-fixes`.
  - Web: `vendor-refunds.test.tsx` (5).
- **Regression:**

  | Check                            | Result                          |
  | -------------------------------- | ------------------------------- |
  | API, two full runs               | 57 files / 744 tests, both runs |
  | Web                              | 15 files / 145 tests            |
  | Typecheck, lint, Prettier, build | clean                           |
  | Migrations 0001–0037             | 37/37 checksums, LF             |

  Integrity audit:
  - All journals balance.
  - Every refund: FX identity holds; the account line equals the base received and the AP line the base released; at most one FX line, equal to `fx_difference`.
  - Every void refund's journal is REVERSED; no void payment has an active refund; no refund account outside BANK and CASH.
  - Payment and credit open balances equal amount − applications − active refunds.
  - AP I-1 reconciles in every organization with refunds.

- **Owner and member browser E2E (2026-10-05, dev organization):**

  | Step                                                                 | Result                                                                                                                                |
  | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
  | MVR prepayment PAY-00005                                             | partly refunded (VR-00001: Dr 1120 / Cr 2110 150.00)                                                                                  |
  | USD prepayment PAY-00006 at 15.60                                    | VR-00002 refunded at 15.70: received 785.00, released 780.00, one FX line, gain 5.00                                                  |
  | Payment PAY-00007 (100.00 to BILL-00002, 150.00 prepayment)          | remaining prepayment refunded (VR-00003)                                                                                              |
  | Void PAY-00007 with an active refund                                 | refused in the UI (no void form; message shown) and by the API (409)                                                                  |
  | Credit-card refund account; over-refund                              | refused (400)                                                                                                                         |
  | Vendor-credit refund VR-00004 from DN-00001                          | credit void blocked                                                                                                                   |
  | Member (view only)                                                   | sees payment-source refunds only; recording and voiding refused (403); credit-source refund detail refused (no `vendor_credits.view`) |
  | Void VR-00003 after the 15-minute window                             | password prompt; journal reversed; reversal links to the refund; prepayment restored to exactly 150.00 / 150.0000                     |
  | Void PAY-00007                                                       | now succeeds; BILL-00002 back to 200.00                                                                                               |
  | Void VR-00004                                                        | DN-00001 back to 120.00 unapplied and voidable again (left posted)                                                                    |
  | Drill-down                                                           | journal ↔ refund ↔ source; the refund journal offers no generic "Reverse…"                                                            |
  | AP I-1 after each step                                               | final −640.00 = 510.00 − 120.00 − 1,030.00                                                                                            |
  | AR                                                                   | unchanged                                                                                                                             |
  | Bills, Vendor credits, Payments, Refunds, Sales and Accounting pages | clean; no server errors                                                                                                               |

  Dev setup made for it:
  - a USD rate for 2026-10-05 (15.70);
  - prepayments PAY-00005 and PAY-00006;
  - payment PAY-00007 (now void).

- **Noted, unchanged:**
  - Refunds dated the same day list in id order within that day.
  - Without `vendor_credits.view` the refund list hides credit-source refunds, and their detail is refused.
- **Not implemented (later stages):** credit-card refunds (amendment), customer refunds (P4-31), batch Pay Bills (P4-32), remittance advice, AP aging, statements and the reconciliation UI, AP revaluation, direct expenses, Purchases imports and exports, opening bills and credits, the final permission backfill.

Phase 4B-3 was committed as `29202c6` and is frozen.

### 4B-4 — batch Pay Bills (P4-32, P4-50), 2026-10-05

- **Decisions (approved 2026-10-05 after the impact audit, D1–D9):**
  - **D1 scope:** batch Pay Bills only. Not in scope: remittance advice, AP aging and reports, imports and exports, revaluation, direct expenses, opening bills and credits.
  - **D2 batch record:** a `purchases_payment_batches` table and a nullable, organization-scoped `payment_batch_id` on `purchases_payments`. The link is set once at creation and is immutable; existing payments keep NULL.
  - **D3 approval:** stays per payment (`purchases.payment.record`, `vendor_payments.approve`). If any vendor and currency group needs approval, the whole batch is refused (409 `APPROVAL_REQUIRED`) and the issues name those groups. Nothing is recorded and no drafts are left behind.
  - **D4 grouping:** bills are grouped by vendor and currency, and each group becomes exactly one payment.
    - The payment account is chosen per currency. It defaults from Purchases settings and the existing 4B-2 eligibility applies.
    - The table rate is the default. A manual rate per currency needs a reason and is kept and audited exactly as in 4B-2.
  - **D5 limits:** at most 2,000 bills per batch, 100 vendors per batch and 497 bills per payment. All are checked before anything is created.
  - **D6:** partial payments are allowed (> 0 and ≤ the amount due).
  - **D7:** no excess and no prepayment from a batch.
  - **D8:** no credit or prepayment application inside a batch.
  - **D9:** no batch number. Payments take ordinary `PAY-` numbers.
- **Migration `0038_payment_batches`:**
  - `purchases_payment_batches`:
    - `payment_date`, `payment_count`, `bill_count` (CHECKs 1..2000 and `payment_count ≤ bill_count`);
    - `totals` jsonb (per currency: amount and payment count), `reference`, `memo`, created by and at;
    - `UNIQUE (id, organization_id)` and a list index.
  - The batch record is immutable (`app_reject_history_modification` on UPDATE and DELETE), cannot be truncated, has tenant RLS and no PUBLIC grants; `intuit_app` gets SELECT and INSERT only.
  - `purchases_payments.payment_batch_id`: an FK on `(payment_batch_id, organization_id)` and a partial index.
  - **Separate set-once guard** `purchases_guard_payment_batch_link`: a BEFORE UPDATE OF `payment_batch_id` trigger that refuses any change once the link is set, or while the payment is not DRAFT.
  - Untouched: the 0036 payment guard, the 0037 refund backstop, and migrations 0001–0037.
- **Code:**
  - `application/payment-batch-service.ts` and `modules/purchases/payment-batches.ts`.
  - Behaviour-preserving refactor of the 4B-2 `VendorPaymentService`:
    - `createDraftInTransaction` (with an optional `paymentBatchId`), `recordInTransaction` and `checkTargets` are now public;
    - `approvalRequirement` exposes the existing approval check;
    - the payment summary carries `paymentBatchId`.
    - Single-payment create and record behave as before.
- **Accounting:**
  - The batch posts no journal of its own. Each payment goes through the unchanged 4B-2 path: one event and one journal, with the C1 single net base-only FX line. The orchestration layer makes no direct accounting writes.
  - **One transaction:** any failure (validation, approval, designation, closed period, race) rolls back the batch and every payment.
  - **Idempotency:** one key per batch, scope `purchases.payment_batch.record`. A replay returns the same batch and payments; there are no per-payment idempotency wrappers.
  - **Lock order:** Purchases settings FOR UPDATE, then every selected bill in ascending id order, then revalidation, then the groups in order of first appearance.
  - **Validation:**
    - issue paths are `bills.<index>`, `groups.<n>`, `accounts.<CUR>` and `rateOverrides.<CUR>`;
    - duplicate bills and duplicate per-currency entries are refused;
    - an account or rate for a currency with no selected bill is refused.
  - **Void:** stays per payment (`vendor_payments.void` plus re-authentication). The batch detail shows each payment's current status, and voiding one payment leaves the others untouched.
  - AP I-1 holds unchanged: every batch payment is fully allocated to bills.
- **API:**
  - `POST /purchases/payment-batches` (`vendor_payments.create`, Idempotency-Key, no re-authentication).
  - `GET /purchases/payment-batches` (keyset) and `GET /purchases/payment-batches/:id` (`vendor_payments.view`).
  - `GET /purchases/pay-bills/open-bills` (`vendor_payments.create`; `vendorId`, `currencyCode`, `dueBefore`, `limit` 1–2000, default 500), ordered by due date, bill date and id.
  - No new permission keys. Strict zod schemas.
  - **Approved deviation (architecture review, 2026-10-05):** the POST route has a route-level `bodyLimit` of 512 KB instead of the normal 64 KB route limit, because a valid 2,000-bill body exceeds the app-wide 64 KB limit. Every other route keeps 64 KB.
- **Web:**
  - `/purchases/pay-bills`:
    - open bills with vendor, currency and due-date filters; selection and partial amounts;
    - a per-currency account and a manual rate with its reason;
    - a review grouped by vendor and currency with totals; "Record N payment(s)";
    - the result links each `PAY-` and the batch; refusals list their issues, including the approval groups.
  - Batch history at `/purchases/payment-batches` and the batch detail at `/purchases/payment-batches/:id` (payments, statuses, journal links).
  - The payment detail shows "Batch / View batch".
  - The "Pay bills" navigation entry is shown only with `vendor_payments.create`.
- **Tests:**
  - API: `test/payment-batches.test.ts` (11) and `test/payment-batch-limit.test.ts` (3: 101 vendors, 498 bills per payment, a 2,000-bill body not refused with 413).
  - Pin: `0038` in `s2-fixes`.
  - Web: `pay-bills.test.tsx` (5).
- **Verification (2026-10-05):**

  | Check                            | Result                          |
  | -------------------------------- | ------------------------------- |
  | API, two full runs               | 59 files / 758 tests, both runs |
  | Web                              | 16 files / 150 tests            |
  | Typecheck, lint, Prettier, build | clean                           |
  | Migrations 0001–0038             | 38/38 checksums, LF             |

  Integrity audit:
  - All journals balance.
  - Every batch's payment count, bill count and per-currency totals match its payments.
  - No batch payment has an unallocated balance, and none is unrecorded.
  - AP I-1 reconciles in every organization with batches.
  - RLS, no-truncate, immutability, the link guard, the 0036 guard and the 0037 backstop are all present.

- **Owner and member browser E2E (2026-10-05, dev organization):**

  | Step                                                                                    | Result                                                                                                                 |
  | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
  | Open bills, filters, navigation                                                         | 6 open bills, earliest due first; the USD filter shows 4                                                               |
  | Batch: 2 MVR bills (one partial 150 of 200) and 2 USD bills at manual 15.75 with reason | review: 2 payments, Total MVR 450.00, Total USD 50.00                                                                  |
  | Record                                                                                  | PAY-00008 (MVR 450.00) and PAY-00009 (USD 50.00); BILL-00002 due 50.00, the other three settled                        |
  | PAY-00009 journal                                                                       | AP 471.00 + 312.00 relieved, bank 787.50, one base-only FX debit 4.50 (4950)                                           |
  | Idempotency replay (API)                                                                | same batch and PAY-00010 returned twice; one payment created                                                           |
  | All-or-nothing (API): valid bill + over-amount bill                                     | 400 at `bills.1.amount`; no batch or payment created; balances unchanged                                               |
  | Approval refusal (UI): 100.00 USD ≈ 1,570 MVR ≥ the 1,000 MVR policy                    | whole batch refused; the group issue is shown; nothing recorded                                                        |
  | Void PAY-00008                                                                          | voided within the user's 15-minute re-authentication window; journal reversed; BILL-00002 and BILL-00006 reopened      |
  | Other batch payment                                                                     | PAY-00009 still recorded; the batch detail shows PAY-00008 Void and PAY-00009 Recorded                                 |
  | Drill-down                                                                              | batch → payment → journal; payment → batch                                                                             |
  | AP I-1                                                                                  | 780.00 after recording; 1,152.50 = 2,302.50 − 120.00 − 1,030.00 after the void                                         |
  | AR                                                                                      | unchanged (3,863.63)                                                                                                   |
  | Member (view only)                                                                      | no "Pay bills" link; `/purchases/pay-bills` denied; POST and open bills 403; the batch history and detail are readable |
  | Bills, Vendor credits, Payments, Refunds, Sales and Accounting pages                    | clean; no server errors                                                                                                |

  Dev setup made for it:
  - vendor "E2E Lagoon Imports" (USD);
  - bills BILL-00004 to BILL-00007;
  - batches with PAY-00008 (now void), PAY-00009 and PAY-00010.

- **Not implemented (later stages):** remittance advice, AP aging, statements and the reconciliation UI, AP revaluation, direct expenses, Purchases imports and exports, opening bills and credits, credit-card refunds, customer refunds (P4-31), the final permission backfill.

Phase 4B-4 was committed as `14ab886` and is frozen.

### 4B-5 — AP aging, vendor statement, AP reconciliation and the AP revaluation provider (P4-39, P4-40, P4-49, P4-52 provider, brief §12, §14, §26, §29, §33), 2026-10-06

- **Scope source:** the frozen brief's implementation sequence lists "4B-5: AP aging, statement and reconciliation; AP revaluation provider".
- **Decisions (approved 2026-10-06 after the impact audit, PD1–PD7):**
  - **PD1 scope:** AP aging, the vendor statement, the AP reconciliation and the `purchases.payables` provider only. Not in scope: unpaid bills, purchase reports, the input-tax summary, the payment register, every export (including the AP aging export), search, remittance, statement PDFs and email, direct expenses, opening bills and credits, the revaluation user workflow, customer and credit-card refunds, and the permission backfill.
  - **PD2:** no CSV export here. The AP aging export belongs to the 4B-8 data-exchange pipeline (`ap_aging` snapshot).
  - **PD3 permission:** `purchases.reports.view` is introduced (approved in P4-39).
    - The Administrator and Member templates gain it (P4-40); Owners get it through catalog sync.
    - Existing organizations' roles are **not** backfilled; that is the 4B-12 permission backfill.
    - Custom roles never receive it silently.
    - The role-key count pins move from 77 to 78.
  - **PD4 statement:** the balance is what we owe the vendor.
    - Bills are positive; vendor credits and debit notes, and payments, are negative; refunds are positive.
    - Applications are not lines. Voided documents are omitted.
    - Per currency: brought-forward balance, running balance, open bills at the end date.
    - The closing balance equals the vendor's open position at the end date.
  - **PD5 as-of:** the Phase 3B AR model. Every Purchases void (bill, vendor credit, payment, refund) reverses its journal on the original document date and adds negated allocation rows on the original allocation dates, so a voided document drops out of every as-of view consistently with the GL. Existing reversal dating is unchanged.
  - **PD6 provider:** `purchases.payables`, read-only, registered globally in `app.ts`, so the S9 engine (and the dev CLI, which uses `buildApp`) discovers it.
    - Open foreign bills are credit-negative; unapplied vendor credits and unallocated prepayments are debit-positive; all on the AP control account. Base-currency documents are excluded.
    - Without an AP control account it reports nothing.
    - **From 4B-5 onward every S9 run includes AP exposure when applicable.** The user workflow (routes, UI, approval) stays in 4B-10.
  - **PD7 aging base:** historical carrying base, never revalued, consistent with the AR aging, the AP reconciliation and the subledger.
- **Migration:** none. 0001–0038 are untouched; the existing Purchases indexes cover the as-of queries.
- **Code:**
  - `modules/purchases/ap-positions.ts`: `openBillsAsOf`, `openVendorCreditsAsOf`, `openPrepaymentsAsOf` (allocations and RECORDED refunds dated on or before the date), `vendorActivity`, `apControlBalance` (GL split into S9 revaluation lines and postings outside Purchases, excluding reversals of Purchases journals).
  - `application/ap-report-service.ts` (`ApReportService`): `aging`, `statement`, `reconciliation`, and the provider `listExposures`. Every report runs in `withOrganization(…, { permission: purchases.reports.view, readOnlySnapshot: true })` and writes nothing.
  - `api/v1/purchases-reports.routes.ts`, with strict zod query schemas.
  - The permission key in `modules/purchases/permissions.ts` and both templates.
- **Reconciliation presentation:** AP amounts are shown credit-positive (owed), so `glBalance − revaluationAdjustments − subledger.total = difference` is the frozen I-1, −(AP control GL balance − revaluation adjustments) = Σ bills `base_due` − Σ credits `base_unapplied` − Σ payments `base_unallocated`, with the sign applied once. Without an AP control account the reconciliation returns 409 (AR parity).
- **API:**
  - `GET /purchases/reports/aging?asOf&vendorId?`
  - `GET /purchases/reports/statement?vendorId&from&to` (`from > to` → 400)
  - `GET /purchases/reports/ap-reconciliation?asOf`
  - All need `purchases.reports.view`; unknown query fields are rejected; another organization's vendor is 404 (aging filter and statement).
- **Web:**
  - `/purchases/reports` with tabs for AP aging (per vendor with a base column, the credits-and-prepayments column, expandable rows with drill links to bills, vendor credits or debit notes, and prepayments), vendor statement (vendor picker, running balance, document links, open bills at the end date) and AP reconciliation.
  - A "Reports" link in the Purchases navigation and a "Statement" link on the vendor detail page, both gated by the new key; i18n keys.
- **Tests:** API `test/ap-reports.test.ts` (5) and web `test/ap-reports.test.tsx` (5); the pinned permission lists in `unit`, `database` and `organizations` tests.
- **Verification (2026-10-06):**

  | Check                            | Result                                                                                                                                                                      |
  | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | API, full runs                   | runs 2 and 3: 60 files / 763 tests each, all green. Run 1: 762/763; the S6 import housekeeping test (job worker over the shared queue) failed once and passes alone (26/26) |
  | Web                              | 17 files / 155 tests                                                                                                                                                        |
  | Typecheck, lint, Prettier, build | clean                                                                                                                                                                       |
  | Migrations 0001–0038             | 38/38 checksums, LF; no new migration                                                                                                                                       |

  Integrity audit:
  - The 4B-2 to 4B-4 checks stay clean (refunds, batches, AP I-1 in every organization with refunds or batches).
  - AP I-1 with the revaluation term holds in every organization with settlement activity. The organizations that do not reconcile, and the bills and credits whose derived position differs from the stored one, are all the known legacy fixtures that change balances by raw SQL in guard tests (no allocations, payments, refunds or batches).
  - Every Purchases document void reverses on the original date. The only off-date reversals of Purchases journals come from the 4A-2 engine test that reverses a bare subledger journal with an explicit date; no document void passes a reversal date.

- **Owner and member browser E2E (2026-10-06, dev organization):**

  | Step                                         | Result                                                                                                                                                               |
  | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Reports navigation and AP aging today        | 1,935.50 = AP GL; bills 3,085.50, credits and prepayments −1,150.00                                                                                                  |
  | Earlier as-of dates                          | 2026-10-03: 2,705.00 (the recorded 4B-1 state, VC-00002 void dropped out); 2026-10-04: −1,170.00; each reconciles                                                    |
  | Buckets by hand                              | 2026-12-15: 41–43 days → 31–60; 2027-02-10: 98–100 days → over 90; all bills match                                                                                   |
  | Credits and prepayments column; drill-down   | DN-00001, PAY-00005, PAY-00006 listed; the USD subtotal and bill links; BILL-00004 opens                                                                             |
  | Statements                                   | E2E Island Supplies MVR 130.00 and USD −35.00, each equal to the open position; voided documents omitted; E2E Lagoon Imports brought forward 150.00 = open bills     |
  | AP reconciliation                            | difference 0.00; postings outside Purchases 0.00                                                                                                                     |
  | Dev revaluation (CLI) on 2026-10-06 at 15.80 | AP bills BILL-00003/4/5/7 credit-negative (−4.50, −3.00, −4.00, −10.00); prepayment PAY-00006 debit-positive (+10.00); MVR documents excluded; one AP line, Cr 11.50 |
  | Reconciliation after posting                 | GL 1,947.00 − revaluation 11.50 = subledger 1,935.50; 0.00 again on the D + 1 reversal date                                                                          |
  | AR                                           | unchanged: one exposure (INV-00002, carrying 3,863.63 = AR subledger); AR reconciles with its own 95.22                                                              |
  | Cancel                                       | journals reversed; AP and AR reconciliations back to their prior state                                                                                               |
  | Console, network, regression pages           | no server errors; Purchases, Sales and Accounting pages clean; no revaluation route exists (404)                                                                     |
  | Member (existing organization)               | no key (no early backfill); Reports link and vendor Statement link hidden; page denied; the three report endpoints 403                                               |

  Dev setup made for it: USD rate 15.80 on 2026-10-06; revaluation run `de651eab` posted and cancelled (JE-000064 to JE-000067).

- **Deviations:** none. The dev CLI has no preview mode, so the E2E "preview" read the posted run's recorded exposure lines (the same plan a preview computes); no preview route or CLI option was added.
- **Not implemented (later stages):** unpaid bills, purchase reports, the input-tax summary and payment register (4B-6); remittance and debit-note output (4B-7); the AP aging export and other exports, search (4B-8); direct expenses (4B-9); the revaluation user workflow (4B-10); the permission backfill (4B-12); opening bills and credits; credit-card and customer refunds.

Phase 4B-5 was committed as `125cda5` and is frozen.

### 4B-6 — unpaid bills, purchases by vendor, item and account, input-tax summary and payment register (P4-49, brief §24, §26), 2026-10-06

- **Scope source:** the frozen brief's sequence, "4B-6: purchase reports, input tax summary, payment register". All six reports are read-only.
- **Decisions (approved 2026-10-06 after the impact audit, PD1–PD12):**
  - **PD1 unpaid-bills windows:** relative to the as-of date, not calendar weeks: Overdue, due in 0–7, 8–14, 15–21 and 22–28 days, then Later.
  - **PD2 tax presentation:** by vendor and by item show net, recoverable tax, non-recoverable tax, cost (net + non-recoverable) and total. By account shows the cost posted to each account (non-recoverable tax is capitalized there, P4-12); recoverable input tax stays separate.
  - **PD3:** unpaid bills do not net unapplied vendor credits or prepayments; applied allocations already reduce each bill.
  - **PD4 base conversion:** no report-specific rounding rule. Base values come from the canonical purchase journal, rebuilt from the stored snapshots and rate with `buildPurchaseJournal`.
  - **PD4 clarification — Canonical Group Base Attribution (approved 2026-10-06):**
    - The canonical journal's group bases (per account and dimension set, per tax code, and the AP total) are authoritative.
    - For presentation only, a group's base is attributed to its member lines: provisional bases with `convertToBase`, the group's residue on the largest member, equal sizes broken by line order.
    - Cost decomposition: `costBase` = attributed line base; `nonRecoverableTaxBase` = `convertToBase(nonRecoverableTax)`; `netBase` = `costBase − nonRecoverableTaxBase`.
    - It is a deterministic presentation allocation of an already-authoritative amount, not an accounting rounding rule. It never feeds posting, journals, the GL or stored data.
    - Posting: document lines → canonical journal groups → GL. Reporting: canonical journal groups → presentation attribution → report rows.
  - **PD5:** the document date (bill date, credit or debit-note date); no MIRA tax-point rules.
  - **PD6:** voided payments stay in the register on their original date, marked VOID, excluded from totals.
  - **PD7:** refunds are a separate section.
  - **PD8:** at most 2,000 register rows, **payments and refunds combined**; `truncated: true` when more combined rows match. Full export is 4B-8.
    - **Register order (deterministic, applied before the cap):** date ascending, then payments before refunds on the same date, then document number, then id (`compareRegisterRows`). Filters apply before the cap. Each query fetches at most limit + 1 rows in that order and `limitRegister` merges them, keeps the first 2,000 and splits them back into `payments[]` and `refunds[]` (the response shape is unchanged).
    - When truncated, the subtotals and totals cover the returned rows only; the page says so.
    - _Corrected after the architecture review of 2026-10-06:_ the first implementation capped payment rows only and left refunds uncapped.
  - **PD9:** one Purchases reports page with nine tabs.
  - **PD10:** item-less (account-based) lines form one "No item" row; history is not filtered by the catalog's purchased facet.
  - **PD11:** `purchases.reports.view` alone shows the payment register; it grants no payment write.
  - **PD12:** purchase-analysis reports use `kind = standard` (future opening bills stay excluded); unpaid bills include every bill kind.
- **No migration and no new permission:** 0001–0038 are untouched; the catalog stays at 78 keys; templates and existing organizations are unchanged (the 4B-12 backfill is still pending).
- **Code:**
  - `modules/documents/attribution.ts` (pure, reporting only): `attributeGroupBase` and `attributePurchaseDocument`, which runs the posting's `buildPurchaseJournal` and replays its grouping to attribute group bases.
  - `modules/purchases/purchase-reports.ts`: `purchaseLines` (posted standard bills and posted vendor credits in a period, signed, with attributed bases; dimension types read-only), `registerPayments` (the payment's own allocations and realized FX; later prepayment applications excluded), `registerRefunds`, and the combined PD8 cap (`compareRegisterRows`, `limitRegister`). `paymentRegister` takes an optional limit for tests only; the route always uses 2,000.
  - `ApReportService`: `unpaidBills` (reuses `openBillsAsOf`), `purchasesByVendor`, `purchasesByItem`, `purchasesByAccount`, `inputTaxSummary` (grouped by tax code and snapshotted rate, `reviewOnly: true`) and `paymentRegister`. Every method runs in a read-only snapshot under `purchases.reports.view`.
- **API (strict zod; unknown parameters 400; another organization's vendor, item, account or payment account 404; `from > to` 400):**
  - `GET /purchases/reports/unpaid-bills?asOf&vendorId?`
  - `GET /purchases/reports/purchases-by-vendor?from&to&vendorId?`
  - `GET /purchases/reports/purchases-by-item?from&to&itemId?`
  - `GET /purchases/reports/purchases-by-account?from&to&accountId?`
  - `GET /purchases/reports/input-tax-summary?from&to`
  - `GET /purchases/reports/payment-register?from&to&vendorId?&paymentAccountId?&currencyCode?`
- **Web:** six more tabs on `/purchases/reports` (filters, totals, empty states, drill links to bills, payments, refunds, batches and the vendor statement; the review-only notice on input tax; the truncation notice on the register); i18n keys. No export, search or PDF.
- **Tests:** API `test/purchase-reports.test.ts` (8: the attribution rules including the 0.03 + 0.03 at 15.50 case; unpaid bills with the aging equality; purchase analysis and input tax with exact GL ties; the payment register with its GL tie; the combined PD8 cap — exactly 2,000 rows untruncated, 2,001 truncated, refunds in the same cap, deterministic order regardless of input order — and the cap applied after filters with totals over the returned rows; security); web `test/purchase-reports.test.tsx` (9).
- **Verification (2026-10-06):**

  | Check                            | Result                                                        |
  | -------------------------------- | ------------------------------------------------------------- |
  | API, two full runs               | 61 files / 771 tests, both runs all green (after the PD8 fix) |
  | Web                              | 18 files / 164 tests                                          |
  | Typecheck, lint, Prettier, build | clean                                                         |
  | Migrations 0001–0038             | 38/38 checksums, LF; no new migration                         |

  Integrity audit: no unbalanced journals; every recorded or void payment's base equals its payment-account journal line; AP I-1 holds in every organization with refunds or batches; the remaining I-1 and position mismatches are the known legacy fixtures that change balances by raw SQL (no allocations, payments, refunds or batches).

- **Owner and member browser E2E (2026-10-06, dev organization):**

  | Step                       | Result                                                                                                                                                                     |
  | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Nine tabs                  | all render, with drill links, notes and empty states                                                                                                                       |
  | Unpaid bills (2026-10-06)  | BILL-00002/3 due in 27 days (22–28 days), BILL-00004 to 00007 due in 29 days (Later); base 3,085.50 = the AP aging's bills; vendor filter 2,353.00 for E2E Lagoon Imports  |
  | Purchases by vendor        | E2E Island Supplies 3,005.00 (bills 3,900.00 less DN-00001 120.00 and VC-00001 775.00 at the bill rate); E2E Lagoon Imports 2,353.00; voided BILL-00001 and VC-00002 out   |
  | Purchases by account       | 5400 cost 5,358.00 = the GL movement on 5400 in October                                                                                                                    |
  | By item, input tax         | the dev data has no items or taxed lines: one "No item" row and one untaxed row; input tax shows the review-only notice                                                    |
  | Payment register (October) | 10 payments (4 void, listed and excluded), 4 refunds (2 void); per account the register's payments less refunds equal the GL: 1120 −1,325.00, 1125 −1,638.50, 2140 −466.50 |
  | Register filters and links | USD filter: 5 payments, 3,665.00 recorded base and the 785.00 refund; PAY-00009 opens as Void; batch and refund-source links                                               |
  | Validation, logs           | `from > to` 400; no server errors; regression pages clean                                                                                                                  |
  | Member (existing org)      | no key (no early backfill); no Reports link; the page is denied; all six endpoints 403                                                                                     |

- **Deviations:** none remaining. The PD8 refund-cap gap found in the architecture review was corrected (see PD8 above).
- **Known limitations:**
  - The dev organization has no item or taxed bill lines, so those paths are proven by the API tests rather than the E2E.
  - The 2,000-row cap is proven with 2,000 and 2,001 synthetic rows through the pure merge, and end to end with a small test-only limit; no test records 2,001 real documents.
  - When the register is truncated, its subtotals cover only the returned rows (the full set belongs to the 4B-8 export).
- **Not implemented (later stages):** remittance and debit-note output (4B-7); exports, including purchases by vendor and the AP aging, and search (4B-8); direct expenses (4B-9); the revaluation workflow (4B-10); the permission backfill (4B-12); dimension filters; opening bills and credits; MIRA returns, MIRA FX conversion, reverse charge, customs GST and withholding (OPEN).
