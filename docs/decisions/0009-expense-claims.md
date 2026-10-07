# ADR 0009 — Employee expense claims

Status: implemented (migration 0049). Scope approved 2026-10-07: an Employee party role, the claim, receipt attachments, submission, approval, posting Dr Expense / Cr Employee Payable, and the payment engine reused for reimbursement.

## Decisions

- **EC-01 Employees.** An employee is a Party with the existing `employee` role (managed on the Contacts screens). A claim names the employee, a claim date and a memo, and lists lines (expense date not after the claim date, description, expense account, amount in the base currency). The account defaults to the claim settings' default expense account, then the Purchases default; it must be an account Purchases may post to (the bill rules). Up to 100 lines.
- **EC-02 Receipts.** Receipts are attachments (file link type `expense_claim`): added while the claim is a draft or awaiting approval, removed only from a draft. The organization can require a receipt for a claim that has a line at or above an amount (`receiptRequiredOver`, checked at submit).
- **EC-03 Lifecycle and approval.** DRAFT → PENDING_APPROVAL → APPROVED → POSTED, CANCELLED (an approved claim with no bill) or VOID (a posted claim). Submitting numbers the claim (`EC-`, kept if it returns to draft) and opens an approval request when a policy step matches (`expense_claims.approve`, type `expense_claim`, the claim total; no self-approval, a rejection needs a comment and returns the claim to draft); with no matching step it is approved at once. A submitted claim is immutable apart from its lifecycle (database triggers).
- **EC-04 Posting reuses the AP engine.** An approved claim is posted by creating and posting a bill from the employee as a vendor (the vendor record is created from the employee's Party when it does not exist yet): Dr each claim line's expense account / Cr the AP control account, subledgered by employee, with the claim number as the supplier reference and no tax. This is what "Dr Expense / Cr Employee Payable" means in the ledger: the employee payable **is** the AP control account, and the employee's balance is their vendor balance (it appears in the AP aging, statements and reconciliation). Posting therefore needs `expense_claims.post` plus `bills.create`, `bills.post` and `bills.view` (and `vendors.create` the first time for an employee).
- **EC-05 Idempotent posting.** The bill is created once (an idempotency key and the stored link on the claim) and posted with its own key. If the bill stops for the bill approval policy, the claim stays APPROVED with its draft bill; once the bill is approved and posted in Bills, posting the claim again finishes it.
- **EC-06 Reimbursement.** Reimbursing a claim is an ordinary vendor payment (or Pay bills) against its bill: bank/cash or card, FX, remittance advice and voids all come from the payment engine. The claim shows its bill and whether it is reimbursed (the bill's amount due is zero).
- **EC-07 Void.** Voiding a posted claim (`expense_claims.void` and a recent password confirmation) voids its bill first (`bills.void`), which refuses while payments or credits are applied, then marks the claim VOID.
- **EC-08 Permissions.** `expense_claims.view|create|approve|post|void|settings.manage`. Owner and Administrator hold all; Member holds the view key. Migration 0049 backfills existing organizations additively with audit events.

## Known deviations and open points

- **Employee payable is the AP control account.** A separate employee payable account (outside AP) would need its own subledger and payment path; the architects approved reusing the payment engine, which is AP-based.
- **No self-service.** Claims are entered by users with `expense_claims.create` for any employee; an "own claims only" scope is not implemented.
- **Base currency, no tax.** Foreign-currency claims, tax and dimensions on claim lines are not supported in v1.
- **Posting is several transactions** (claim, bill create, bill post, claim) made safe to repeat; the claim's own and the bill's approval are separate.
