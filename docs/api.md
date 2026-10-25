# API Conventions (v1)

- Base path: **`/api/v1`**. Breaking changes go into a new version.
- JSON only (`Content-Type: application/json`). Bodies are limited to 64 KiB.
- Success responses use the envelope `{ "data": ... }`. Some list responses also include `page`. `204` responses have no body.
- Error responses use the envelope below:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request is invalid.",
    "requestId": "8a1c…",
    "details": { "issues": [{ "path": "email", "message": "Enter a valid email address." }] }
  }
}
```

- Every response carries `x-request-id`. Quote it when reporting problems.
- Authentication uses the session cookie. Writes also need `X-CSRF-Token` (see [security](security.md)).
- Input is validated with Zod: request bodies, path parameters and query strings.

## Error codes

| Status | Code                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `VALIDATION_FAILED`, `MALFORMED_REQUEST`, `INVALID_TOKEN` (password reset)                                                                                                                                                                                                                                                                                                                             |
| 401    | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`                                                                                                                                                                                                                                                                                                                                                               |
| 403    | `SELF_APPROVAL_PROHIBITED`, `NOT_ELIGIBLE_APPROVER`, `PERMISSION_DENIED`, `FORBIDDEN`, `REAUTHENTICATION_REQUIRED`, `CSRF_REJECTED`, `INVITATION_EMAIL_MISMATCH`, `INVALID_CREDENTIALS` (re-authentication)                                                                                                                                                                                            |
| 404    | `NOT_FOUND`, `INVALID_TOKEN` (invitation)                                                                                                                                                                                                                                                                                                                                                              |
| 409    | `ACCOUNTING_NOT_SET_UP`, `ACCOUNTING_ALREADY_SET_UP`, `ACCOUNT_IN_USE`, `INVALID_STATE_TRANSITION`, `PERIOD_CLOSED`, `PERIOD_NOT_FOUND`, `EXCHANGE_RATE_REQUIRED`, `APPROVAL_REQUIRED`, `ALREADY_DECIDED`, `IDEMPOTENCY_CONFLICT`, `INSUFFICIENT_STOCK`, `CONFLICT`, `EMAIL_UNAVAILABLE`, `ALREADY_MEMBER`, `LOGIN_REQUIRED`, `PROTECTED_RESOURCE`, `INVITATION_NOT_PENDING`, `NO_ACTIVE_ORGANIZATION` |
| 410    | `INVITATION_EXPIRED`                                                                                                                                                                                                                                                                                                                                                                                   |
| 415    | `UNSUPPORTED_MEDIA_TYPE`                                                                                                                                                                                                                                                                                                                                                                               |
| 429    | `TOO_MANY_ATTEMPTS` (with `Retry-After`)                                                                                                                                                                                                                                                                                                                                                               |
| 500    | `INTERNAL_ERROR`                                                                                                                                                                                                                                                                                                                                                                                       |

## Endpoints

| Method  | Path                                                     | Auth                                   | Permission / notes                                               |
| ------- | -------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| GET     | `/health`                                                | —                                      | Includes a database check                                        |
| POST    | `/auth/register`                                         | —                                      | Creates user + organization (Owner)                              |
| POST    | `/auth/login`                                            | —                                      | Login protection applies                                         |
| POST    | `/auth/logout`                                           | ✓                                      | Revokes the session                                              |
| GET     | `/auth/session`                                          | ✓                                      | Session state + CSRF token                                       |
| POST    | `/auth/reauthenticate`                                   | ✓                                      | Opens the 15-minute window                                       |
| PUT     | `/auth/session/organization`                             | ✓                                      | Switch organization (membership re-verified)                     |
| GET     | `/auth/sessions`                                         | ✓                                      | Own active sessions                                              |
| DELETE  | `/auth/sessions/:sessionId`                              | ✓                                      | Own session; another one is sensitive                            |
| POST    | `/auth/password-reset/request`                           | —                                      | Always `202`                                                     |
| POST    | `/auth/password-reset/complete`                          | —                                      | Single-use token; revokes sessions and remembered browsers       |
| POST    | `/auth/mfa/challenge`                                    | MFA-pending                            | `{method, code, rememberDevice}`; rotates the session token      |
| GET     | `/auth/mfa`                                              | ✓                                      | Factors, recovery-code count, organizations requiring MFA        |
| POST    | `/auth/mfa/totp/enroll`                                  | ✓ re-auth                              | Secret, `otpauth` URI and QR code, shown once                    |
| POST    | `/auth/mfa/totp/verify`                                  | ✓                                      | Activates; recovery codes shown once                             |
| POST    | `/auth/mfa/totp/disable`                                 | ✓ re-auth + code                       | Only when no organization requires MFA of the user               |
| POST    | `/auth/mfa/step-up`                                      | ✓                                      | Fresh code for security actions                                  |
| POST    | `/auth/mfa/recovery-codes`                               | ✓ re-auth + code                       | New set; the old set stops working                               |
| GET     | `/auth/trusted-devices`                                  | ✓                                      | Remembered browsers                                              |
| DELETE  | `/auth/trusted-devices/:deviceId`                        | ✓                                      | Forget one                                                       |
| DELETE  | `/auth/trusted-devices`                                  | ✓ re-auth + code                       | Forget all                                                       |
| GET/PUT | `/organizations/current/security`                        | `members.manage` (PUT: re-auth + code) | MFA policy with `version`                                        |
| POST    | `/organizations/current/members/:membershipId/mfa-reset` | `members.manage` + re-auth + code      | Admin MFA reset (S7-37 rules)                                    |
| GET     | `/organizations`                                         | ✓                                      | Own organizations                                                |
| POST    | `/organizations`                                         | ✓                                      | New organization; caller is Owner                                |
| GET     | `/organizations/current`                                 | ✓                                      | `organization.read`                                              |
| PATCH   | `/organizations/current`                                 | ✓                                      | `organization.update`                                            |
| GET     | `/organizations/current/members`                         | ✓                                      | `members.read`                                                   |
| PUT     | `/organizations/current/members/:membershipId/roles`     | ✓                                      | `members.manage` + re-auth                                       |
| PATCH   | `/organizations/current/members/:membershipId`           | ✓                                      | `members.manage` + re-auth (status)                              |
| GET     | `/organizations/current/invitations`                     | ✓                                      | `members.invite`                                                 |
| POST    | `/organizations/current/invitations`                     | ✓                                      | `members.invite`                                                 |
| POST    | `/organizations/current/invitations/:id/revoke`          | ✓                                      | `members.invite`                                                 |
| GET     | `/organizations/current/roles`                           | ✓                                      | `roles.read`                                                     |
| POST    | `/organizations/current/roles`                           | ✓                                      | `roles.manage` + re-auth                                         |
| PUT     | `/organizations/current/roles/:roleId`                   | ✓                                      | `roles.manage` + re-auth                                         |
| DELETE  | `/organizations/current/roles/:roleId`                   | ✓                                      | `roles.manage` + re-auth                                         |
| GET     | `/permissions`                                           | ✓                                      | `roles.read`                                                     |
| GET     | `/organizations/current/audit-events?limit&before`       | ✓                                      | `audit.read`                                                     |
| POST    | `/invitations/lookup`                                    | —                                      | Token in the body                                                |
| POST    | `/invitations/accept`                                    | opt.                                   | Signed in: the email must match. Signed out: creates the account |

## Accounting endpoints (Phase 2, `/api/v1/accounting`)

Amounts and rates are **decimal strings** (for example `"125.50"`), never JSON numbers. Dates use `YYYY-MM-DD`. "Re-auth" means a sensitive action.

| Method             | Path                                                 | Permission / notes                                                                             |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET                | `/accounting/setup`                                  | `accounting.setup` or `accounting.accounts.view`; status and COA templates                     |
| POST               | `/accounting/setup`                                  | `accounting.setup` + re-auth; `{ baseCurrency, templateKey }`                                  |
| PATCH              | `/accounting/settings`                               | `accounting.setup` + re-auth; base currency, only before the first posting                     |
| GET                | `/accounting/dashboard`                              | journals and/or periods view                                                                   |
| GET, POST          | `/accounting/accounts`                               | view / create                                                                                  |
| GET, PATCH, DELETE | `/accounting/accounts/:id`                           | view / update / `accounting.accounts.delete` + re-auth (unused accounts only)                  |
| POST               | `/accounting/accounts/:id/archive`                   | archive                                                                                        |
| GET, POST          | `/accounting/exchange-rates`                         | `accounting.journals.view` / `accounting.setup`                                                |
| GET, POST          | `/accounting/fiscal-years`                           | `accounting.periods.view` / `accounting.setup` (optional custom `periods`)                     |
| GET                | `/accounting/fiscal-years/:id`                       | `accounting.periods.view`                                                                      |
| GET                | `/accounting/periods?fiscalYearId`                   | `accounting.periods.view`                                                                      |
| POST               | `/accounting/periods/:id/close`                      | `accounting.periods.close` + re-auth                                                           |
| POST               | `/accounting/periods/:id/reopen`                     | `accounting.periods.reopen` + re-auth; `{ reason }`; `202` when an approval request was opened |
| GET, POST          | `/accounting/journals?status&limit&before`           | view / create (draft)                                                                          |
| GET, PATCH         | `/accounting/journals/:id`                           | view / `edit_draft` (drafts only)                                                              |
| POST               | `/accounting/journals/:id/submit`                    | `submit`                                                                                       |
| POST               | `/accounting/journals/:id/approve`, `/reject`        | `approve` (eligible, not one's own)                                                            |
| POST               | `/accounting/journals/:id/withdraw`                  | `submit` (back to draft)                                                                       |
| POST               | `/accounting/journals/:id/post`                      | `post` + re-auth                                                                               |
| POST               | `/accounting/journals/:id/reverse`                   | `reverse` + re-auth; `{ reason, reversalDate? }`                                               |
| GET                | `/accounting/ledger?accountId&fromDate&toDate&limit` | `accounting.ledger.view`                                                                       |

## Opening balances (Phase 3A S8, `/api/v1/accounting`)

Read with `accounting.journals.view`; every change needs `accounting.setup` (S8-15). Request bodies are strict: unknown fields are rejected.

| Method | Path                                        | Permission / notes                                                                                    |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET    | `/accounting/settings/conversion-date`      | view; `{ conversionDate, openingDate }`                                                               |
| PUT    | `/accounting/settings/conversion-date`      | `accounting.setup` + re-auth; `{ conversionDate }`; refused while a batch is pending or posted        |
| GET    | `/accounting/opening-balances`              | view; batches, newest first                                                                           |
| POST   | `/accounting/opening-balances`              | `accounting.setup`; `{ notes? }`; one open batch at a time (`409 CONFLICT`)                           |
| GET    | `/accounting/opening-balances/:id`          | view; lines, per-currency totals with the OBE result, approval state (`readyToPost`), journals        |
| PUT    | `/accounting/opening-balances/:id/lines`    | `accounting.setup`; `{ version, lines }` replaces the draft's lines (`409 VERSION_CONFLICT` if stale) |
| POST   | `/accounting/opening-balances/:id/preview`  | `accounting.setup`; the journals posting would create, with errors and warnings                       |
| POST   | `/accounting/opening-balances/:id/submit`   | `accounting.setup`; `{ version }`; only when an approval policy applies                               |
| POST   | `/accounting/opening-balances/:id/withdraw` | `accounting.setup`; back to draft                                                                     |
| POST   | `/accounting/opening-balances/:id/post`     | `accounting.setup` + re-auth; `{ version }`; one system journal per currency, in one transaction      |
| POST   | `/accounting/opening-balances/:id/reverse`  | `accounting.setup` + re-auth; `{ reason }`; reverses every journal of the batch                       |
| DELETE | `/accounting/opening-balances/:id`          | `accounting.setup`; drafts only                                                                       |

- A line is `{ accountId, debit | credit, baseAmount?, description?, dimensions? }`. Amounts are in the account's currency; `baseAmount` is only for foreign-currency accounts, on every line of that currency or on none.
- Approval decisions use the generic `/approvals/requests/:id/approve` and `/reject` routes (action `accounting.opening_balance.post`, approver `accounting.journals.approve`).
- `POST /accounting/journals/:id/reverse` on an opening-balance journal returns `409 SYSTEM_JOURNAL`: opening journals are reversed only with their batch.
- Import domain `opening_balances` (into the draft batch only; never posts), export domain `opening_balances`, attachment target `opening_balance_batch` (changes only while the batch is a draft).

## Revaluation (Phase 3A S9 engine; Phase 4B-10 workflow, ADR 0004 P4-52)

Revaluation journals appear in the journal, ledger and report endpoints with `source: "system"` and `sourceType` `revaluation` (dated D) or `revaluation_reversal` (dated D + 1, or a cancellation). `POST /accounting/journals/:id/reverse` on either returns `409 SYSTEM_JOURNAL`; a run is corrected only by cancelling it. Closing rates come from the exchange-rate table; the routes accept no manual rates.

| Method | Path                                    | Permission / notes                                                                                                                        |
| ------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/accounting/revaluations[/:id]`        | `accounting.journals.view`; a run with its exposures (accounts and open AR/AP documents), journals and approval state                     |
| POST   | `/accounting/revaluations/preview`      | `accounting.journals.view`; `{ revaluationDate }`; writes nothing; `approvalRequired` says whether a policy applies                       |
| POST   | `/accounting/revaluations`              | `accounting.journals.post` + re-auth; posts directly (an `Idempotency-Key` is the run key); `409 APPROVAL_REQUIRED` when a policy applies |
| POST   | `/accounting/revaluations/submit`       | `accounting.journals.post`; saves the calculation as `PENDING_APPROVAL` with an approval request (action `accounting.revaluation.post`)   |
| POST   | `/accounting/revaluations/:id/post`     | `accounting.journals.post` + re-auth; `{ version }`; posts an approved run if the recalculation equals the approved one                   |
| POST   | `/accounting/revaluations/:id/withdraw` | `accounting.journals.post`; removes a pending run and frees its date                                                                      |
| POST   | `/accounting/revaluations/:id/cancel`   | `accounting.journals.reverse` + re-auth; `{ version, reason }`; reverses the run's journals on their own dates                            |

Approve and reject use the shared `/approvals/requests/:id/approve|reject` routes (`accounting.journals.approve`).

## Sales and receivables (Phase 3B, ADR 0003 D1–D15)

Every Sales posting goes sales document → accounting event → journal; Sales never writes ledger tables. Amounts are decimal strings. Writes that change a document take its `version`; `POST` creates and lifecycle actions accept an optional `Idempotency-Key` header (Decision 23), and a replay returns the first result.

| Method              | Path                                                                                  | Permission / notes                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GET, POST           | `/customers`                                                                          | `customers.view` / `customers.create` (a customer is a Party with the `customer` role, D6)                                  |
| GET, PATCH          | `/customers/:id`                                                                      | `customers.view` / `customers.update` (identity at the party's version)                                                     |
| POST                | `/customers/:id/archive`, `/restore`                                                  | `customers.archive`                                                                                                         |
| POST, PATCH, DELETE | `/customers/:id/contacts[/:contactId]`, `/customers/:id/addresses[/:addressId]`       | `customers.update`                                                                                                          |
| GET                 | `/tax/codes`                                                                          | any Sales or tax permission; codes with their dated rate versions                                                           |
| POST, PATCH         | `/tax/codes`, `/tax/codes/:id`                                                        | `tax.codes.manage` + re-auth                                                                                                |
| POST                | `/tax/codes/:id/archive`, `/restore`, `/rates`; DELETE `/tax/codes/:id/rates/:rateId` | `tax.codes.manage` + re-auth; a rate version has a start date only                                                          |
| GET, PUT            | `/sales/settings`                                                                     | view: Sales view/create keys; change: `sales.settings.manage` + re-auth (MFA set). AR account, defaults, numbering          |
| GET, POST, PATCH    | `/sales/items[/:id]`, POST `/sales/items/:id/archive`, `/restore`                     | view: `invoices.view` or `sales.items.manage`; change: `sales.items.manage` (D8)                                            |
| GET, POST           | `/sales/invoices`                                                                     | `invoices.view` / `invoices.create`; filters `status`, `customerId`, `search`, `from`, `to`, `open`; `kind: "opening"` (D5) |
| GET, PUT, DELETE    | `/sales/invoices/:id`                                                                 | `invoices.view` / `invoices.edit_draft` / `invoices.delete_draft` (drafts only)                                             |
| POST                | `/sales/invoices/:id/submit`, `/withdraw`, `/issue`, `/void`                          | `invoices.create` (submit/withdraw), `invoices.issue` (D1: re-checks approval and posts), `invoices.void` + re-auth         |
| GET, POST           | `/sales/credit-notes`, GET/PUT/DELETE `/sales/credit-notes/:id`                       | `credit_notes.view` / `credit_notes.create` (drafts, D7)                                                                    |
| POST                | `/sales/credit-notes/:id/submit`, `/withdraw`, `/issue`                               | `credit_notes.create`; issue: `credit_notes.issue`                                                                          |
| GET, POST           | `/sales/receipts`, GET `/sales/receipts/:id`                                          | `receipts.view` / `receipts.create` (allocations; rate and deposit overrides D2, D3)                                        |
| POST                | `/sales/receipts/:id/void`                                                            | `receipts.void` + re-auth                                                                                                   |
| GET, POST           | `/sales/refunds[/:id]`, POST `/:id/void`                                              | `receipts.view` / `receipts.create` (+ `credit_notes.view` for a credit-note source) / `receipts.void` + re-auth (ADR 0010) |
| POST                | `/sales/customer-credit/apply`                                                        | `receipts.create`; applies a receipt's unallocated amount or an issued credit note to open invoices                         |
| GET                 | `/sales/{invoices,credit-notes}/:id/pdf`, `/emails`; POST `/email`                    | view key; email: `invoices.issue` / `credit_notes.issue` (queued job; PDF attached)                                         |
| GET                 | `/sales/search?q&limit`                                                               | `q` ≥ 2 characters; sections only for what the caller may view (D15)                                                        |
| GET                 | `/sales/reports/aging?asOf&customerId`, `/statement?customerId&from&to`               | `sales.reports.view`                                                                                                        |
| GET                 | `/sales/reports/ar-reconciliation?asOf`                                               | `sales.reports.view`; GL balance vs subledger, with revaluation adjustments as a reconciling item                           |
| GET                 | `/sales/reports/sales-by-customer`, `/sales-by-item`, `/tax-summary` `?from&to`       | `sales.reports.view`; base currency; opening invoices excluded; the tax summary is not a tax return (U19 open)              |

Import domains `customers`, `sales_items` and `opening_invoices` (drafts only) and export domains `customers`, `sales_items`, `invoices`, `receipts` and `ar_aging` use the S6 endpoints.

## Purchases and payables (Phase 4, ADR 0004 P4-01 to P4-53)

Every Purchases posting goes purchases document → accounting event → journal; Purchases never writes ledger tables. Amounts are decimal strings. Writes that change a document take its `version`; creating and posting actions accept an optional `Idempotency-Key` header, and a replay returns the first result. Approve and reject use the shared approval routes.

| Method           | Path                                                                                     | Permission / notes                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET, POST, PATCH | `/vendors[/:id]` and `/vendors/:id/contacts`, `/addresses`                               | `vendors.view` / `vendors.create` / `vendors.update` (a vendor is a Party with the `vendor` role)                        |
| GET, PUT         | `/purchases/settings`                                                                    | view: Purchases keys; change: `purchases.settings.manage` + re-auth. AP control account, defaults, numbering             |
| GET, POST        | `/purchases/bills`                                                                       | `bills.view` / `bills.create`; `kind: "opening"` and `openingBaseTotal` (P4-35)                                          |
| GET, PUT, DELETE | `/purchases/bills/:id`                                                                   | view / `bills.edit_draft` / `bills.delete_draft`                                                                         |
| POST             | `/purchases/bills/:id/submit`, `/withdraw`, `/post`, `/void`                             | `bills.create`; `bills.post`; `bills.void` + re-auth                                                                     |
| GET, POST        | `/purchases/expenses`, GET/PUT/DELETE `/:id`; POST `/:id/submit`, `/withdraw`, `/post`   | `expenses.view` / `expenses.create` (direct expenses: Dr expense / Cr bank, cash or card, P4-44)                         |
| POST             | `/purchases/expenses/:id/void`                                                           | `expenses.void` + re-auth                                                                                                |
| GET, POST        | `/purchases/vendor-credits`, GET/PUT/DELETE `/:id`; POST `/:id/submit`, `/withdraw`      | `vendor_credits.view` / `vendor_credits.create`; `origin` is `supplier_credit_note` or `debit_note`                      |
| POST             | `/purchases/vendor-credits/:id/post`, `/void`                                            | `vendor_credits.post` + re-auth; `vendor_credits.void` + re-auth                                                         |
| GET, POST        | `/purchases/vendor-credits/:id/pdf`, `/emails`, `/email`                                 | debit notes only: the immutable PDF and its email (P4-46)                                                                |
| GET, POST        | `/purchases/payments`, GET/PUT/DELETE `/:id`; POST `/:id/submit`, `/withdraw`, `/record` | `vendor_payments.view` / `vendor_payments.create`; prepayments, rate and account overrides                               |
| POST             | `/purchases/payments/:id/void`, `/purchases/credit-applications`                         | `vendor_payments.void` + re-auth; `vendor_payments.create`                                                               |
| GET, POST        | `/purchases/payments/:id/remittance`, `/remittance/email`, GET `/remittance/emails`      | the remittance advice PDF and its email (frozen snapshot, P4-46)                                                         |
| GET, POST        | `/purchases/refunds[/:id]`, POST `/:id/void`                                             | `vendor_payments.view` / `vendor_payments.create` / `vendor_payments.void` + re-auth                                     |
| GET, POST        | `/purchases/pay-bills/open-bills`, `/purchases/payment-batches[/:id]`                    | batch Pay bills: one payment per vendor and currency, all or nothing (P4-32)                                             |
| GET              | `/purchases/search?q&limit`                                                              | `q` ≥ 2 characters; sections for vendors, bills, expenses, vendor credits and payments only for what the caller may view |
| GET              | `/purchases/reports/aging`, `/statement`, `/ap-reconciliation`, `/unpaid-bills`          | `purchases.reports.view`; AP aging, vendor statements, reconciliation (AP subledger vs GL)                               |
| GET              | `/purchases/reports/purchases-by-vendor`, `/purchases-by-item`, `/purchases-by-account`  | `purchases.reports.view`; opening documents excluded                                                                     |
| GET              | `/purchases/reports/input-tax-summary`, `/payment-register`                              | `purchases.reports.view`; the summary is not a tax return (MIRA, reverse charge and withholding are open, P4-14)         |

Import domains `vendors`, `opening_bills` and `opening_vendor_credits` (drafts only, never posted) and the purchase columns of `sales_items`; export domains `vendors`, `bills`, `vendor_credits`, `vendor_payments`, `expenses`, `ap_aging`, `purchases_by_vendor` and `payment_register` use the S6 endpoints.

## Banking (ADR 0005)

Banking reads the ledger and never writes it. Entries and transfers post through accounting events; a reconciliation never changes a posted journal line. Amounts are decimal strings; statements are posted as JSON text (up to 5 MB). `Idempotency-Key` is accepted on the statement import, categorize and transfer routes.

| Method         | Path                                                                        | Permission / notes                                                                                         |
| -------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET, POST      | `/banking/accounts`, GET/PATCH `/banking/accounts/:id`                      | `banking.transactions.view` / `banking.accounts.manage`; a bank, cash or card posting account of the chart |
| POST           | `/banking/accounts/:id/archive`, `/restore`                                 | `banking.accounts.manage`; `{ version }`                                                                   |
| POST           | `/banking/statements/preview`                                               | `banking.transactions.import`; `{ content }`: the CSV header and a sample                                  |
| GET, POST      | `/banking/accounts/:id/statements`                                          | import: `{ format: "csv" \| "ofx", content, mapping? }`; all or nothing; duplicates skipped and counted    |
| GET            | `/banking/accounts/:id/transactions`                                        | `status`, `search`, `from`, `to`, `limit`, `after`; each unmatched row carries a rule suggestion           |
| GET            | `/banking/accounts/:id/register`, `/unreconciled`                           | the account's journal lines with a running balance; transactions not yet reconciled                        |
| POST           | `/banking/accounts/:id/auto-match`                                          | `banking.transactions.match`; only unambiguous matches                                                     |
| GET            | `/banking/transactions/:id`, `/:id/suggestions`                             | posted journal lines with the same amount                                                                  |
| POST           | `/banking/transactions/:id/match`, `/unmatch`, `/exclude`, `/restore`       | `banking.transactions.match`; `match` takes `{ journalLineId }`, `exclude` takes `{ reason }`              |
| POST           | `/banking/transactions/:id/categorize`                                      | `banking.transactions.categorize`; `{ categoryAccountId, memo?, dimensionValueIds? }`; posts a bank entry  |
| GET            | `/banking/entries[/:id]`, POST `/banking/entries/:id/void`                  | view; `banking.transfers.void` + re-auth, `{ version, reason }`                                            |
| GET, POST      | `/banking/transfers[/:id]`, POST `/banking/transfers/:id/void`              | `banking.transfers.create`; `toAmount` when the currencies differ; void as above                           |
| POST           | `/banking/accounts/:id/reconciliation/preview`                              | view; `{ statementDate, statementBalance }`; writes nothing                                                |
| GET, POST      | `/banking/accounts/:id/reconciliations`, GET `/banking/reconciliations/:id` | `banking.reconcile`; completes only when the difference is zero                                            |
| POST           | `/banking/reconciliations/:id/reopen`                                       | `banking.reconcile` + re-auth; the latest only; `{ version, reason }`                                      |
| GET, POST, PUT | `/banking/rules`, `/banking/rules/:id`; POST `/archive`, `/restore`         | view / `banking.rules.manage`; rules only suggest                                                          |

## Inventory (ADR 0006)

Inventory is additive to Sales and Purchases: bills bring stock in, invoices take it out at the average cost and post the cost of goods sold through an accounting event. Inventory never writes ledger tables. Quantities and costs are decimal strings; every cost comes from the server.

| Method              | Path                                                       | Permission / notes                                                                                                                                  |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET, PUT            | `/inventory/settings`                                      | view / `inventory.settings.manage` + re-auth; `{ version, negativeStockPolicy: "block" \| "allow", adjustmentAccountId }`                           |
| GET                 | `/inventory/items`, `/inventory/items/:itemId`             | `inventory.view`; quantity, average cost, value and reorder flag                                                                                    |
| POST, PATCH, DELETE | `/inventory/items/:itemId`                                 | `inventory.items.manage`; track a product (`inventoryAccountId`, `cogsAccountId`), change the reorder point, stop tracking an item that never moved |
| GET                 | `/inventory/items/:itemId/movements`                       | the immutable stock ledger, newest first (`limit`, `after`)                                                                                         |
| GET                 | `/inventory/valuation`                                     | stock value per item and per inventory account against the general ledger                                                                           |
| GET, POST           | `/inventory/adjustments`, GET `/inventory/adjustments/:id` | `inventory.adjustments.create`; `Idempotency-Key`; lines `{ itemId, quantityChange, unitCost? }`                                                    |
| POST                | `/inventory/adjustments/:id/void`                          | `inventory.adjustments.void` + re-auth; `{ version, reason }`                                                                                       |

`409 INSUFFICIENT_STOCK` is returned when an invoice, a bill void, an adjustment or its void would take stock below zero while negative stock is blocked.

## Purchase orders and three-way matching (ADR 0007)

An order creates no journal. Approve and reject use the shared approval routes (`purchases.order.approve`). A bill linked to an order is matched when it posts (mode, quantity and price tolerance from the matching settings). Totals come from the server; an `Idempotency-Key` is accepted on create, receive and create-bill.

| Method           | Path                                              | Permission / notes                                                                                                                                   |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET, POST        | `/purchases/orders`                               | `purchase_orders.view` / `purchase_orders.create`; `status`, `vendorId`, `search`, `from`, `to`, `limit`, `after`                                    |
| GET, PUT, DELETE | `/purchases/orders/:id`                           | view / `purchase_orders.create` (drafts only)                                                                                                        |
| POST             | `/purchases/orders/:id/submit`, `/withdraw`       | `purchase_orders.create`; `{ version }`; submit numbers the order and approves it or opens an approval                                               |
| POST             | `/purchases/orders/:id/close`, `/cancel`          | `purchase_orders.close`; `{ version, reason }` (reason optional on close)                                                                            |
| POST             | `/purchases/orders/:id/receipts`                  | `purchase_orders.receive`; `{ receiptDate, lines: [{ orderLineId, quantity }] }`                                                                     |
| GET              | `/purchases/receipts[/:id]`                       | view; `orderId` filters the list                                                                                                                     |
| POST             | `/purchases/receipts/:id/void`                    | `purchase_orders.receive`; `{ version, reason }`                                                                                                     |
| POST             | `/purchases/orders/:id/create-bill`, `/link-bill` | `purchase_orders.create` + `bills.create`; `{ basis: "received" \| "ordered", billDate, vendorReference? }` / `{ billId }`                           |
| GET, PUT         | `/purchases/order-settings`                       | view / `purchase_orders.settings.manage` + re-auth; `{ version, matchMode: "off" \| "warning" \| "block", quantityTolerancePct, priceTolerancePct }` |
| GET              | `/purchases/reports/commitments`                  | `purchase_orders.view`; what is still to be billed, by vendor and currency                                                                           |

## Fixed assets (ADR 0008)

Every posting goes asset document → accounting event → journal. Costs are in the base currency; depreciation is computed by the server (straight line by month). `Idempotency-Key` is accepted on registration, depreciation runs and disposals.

| Method           | Path                                                               | Permission / notes                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET, PUT         | `/fixed-assets/settings`                                           | view / `fixed_assets.manage` + re-auth; `{ version, gainLossAccountId }`                                                                                                                                                             |
| GET, POST, PATCH | `/fixed-assets/categories[/:id]`, POST `/:id/archive`, `/restore`  | view / `fixed_assets.manage`; cost, accumulated depreciation and expense accounts, default life                                                                                                                                      |
| GET, POST        | `/fixed-assets/assets`                                             | view / `fixed_assets.manage`; `creditAccountId` or `alreadyInLedger` (+ `sourceBillId`; `duplicateOverrideReason`, ADR 0008 FA-11; `depreciationMethod`, `decliningRate`, FA-12); `status`, `categoryId`, `search`, `limit`, `after` |
| GET, PATCH       | `/fixed-assets/assets/:id`                                         | view (with schedule, entries, transfers, disposals) / `fixed_assets.manage` (descriptive fields)                                                                                                                                     |
| POST             | `/fixed-assets/assets/schedule-preview`                            | `fixed_assets.manage`; the schedule and warnings an unsaved asset would get (`STRAIGHT_LINE_EQUIVALENT`, `NOTHING_TO_DEPRECIATE`); writes nothing                                                                                    |
| POST             | `/fixed-assets/assets/:id/transfer`                                | `fixed_assets.manage`; `{ version, transferDate, toCategoryId?, toLocation?, memo? }`                                                                                                                                                |
| POST             | `/fixed-assets/assets/:id/dispose`                                 | `fixed_assets.dispose`; `{ version, disposalDate, proceeds?, proceedsAccountId?, memo? }`                                                                                                                                            |
| GET, POST        | `/fixed-assets/disposals`, POST `/fixed-assets/disposals/:id/void` | view; `fixed_assets.void` + re-auth, `{ version, reason }`                                                                                                                                                                           |
| GET              | `/fixed-assets/depreciation/preview?monthEnd`                      | view; what is owing at a month end; writes nothing                                                                                                                                                                                   |
| GET, POST        | `/fixed-assets/depreciation/runs[/:id]`                            | view / `fixed_assets.depreciate`; `{ monthEnd }`; later than the latest run                                                                                                                                                          |
| POST             | `/fixed-assets/depreciation/runs/:id/void`                         | `fixed_assets.void` + re-auth; the latest run only; `{ version, reason }`                                                                                                                                                            |
| GET              | `/fixed-assets/reports/register?asOf`, `/reconciliation?asOf`      | view; the register from the entries; register against the ledger accounts                                                                                                                                                            |

## Expense claims (ADR 0009)

Employees are Parties with the `employee` role. A claim posts as a bill from the employee as a vendor (Dr expense / Cr AP control); reimbursement is an ordinary vendor payment. Approve and reject use the shared approval routes (`expense_claims.approve`). `Idempotency-Key` is accepted on create.

| Method           | Path                                      | Permission / notes                                                                                                       |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET, PUT         | `/expense-claims/settings`                | view / `expense_claims.settings.manage`; `{ version, defaultExpenseAccountId, receiptRequiredOver }`                     |
| GET, POST        | `/expense-claims`                         | `expense_claims.view` / `expense_claims.create`; `status`, `employeePartyId`, `search`, `limit`, `after`                 |
| GET, PUT, DELETE | `/expense-claims/:id`                     | view / `expense_claims.create` (drafts only); the detail includes receipts and the bill                                  |
| POST             | `/expense-claims/:id/submit`, `/withdraw` | `expense_claims.create`; `{ version }`; submit numbers the claim and approves it or opens an approval                    |
| POST             | `/expense-claims/:id/cancel`              | `expense_claims.create`; `{ version, reason }`; an approved claim with no bill                                           |
| POST             | `/expense-claims/:id/post`                | `expense_claims.post` + `bills.create`, `bills.post`, `bills.view` (and `vendors.create` the first time); safe to repeat |
| POST             | `/expense-claims/:id/void`                | `expense_claims.void` + re-auth + `bills.void`; `{ version, reason }`; refused while the bill has payments               |

Receipts are uploaded to `/files` with `linkType=expense_claim&linkId=<claim id>`.

## Approvals endpoints (Phase 2, `/api/v1/approvals`)

| Method      | Path                                         | Permission / notes                                                                                                     |
| ----------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET         | `/approvals/policies`                        | `approvals.manage`; approvable actions (with their supported `conditions`), `baseCurrency` and policies                |
| PUT, DELETE | `/approvals/policies/:actionKey`             | `approvals.manage` + re-auth; `{ steps: [{ name, requiredApprovals, roleIds, membershipIds, conditions? }] }` (strict) |
| GET         | `/approvals/requests`                        | pending requests for actions the caller can approve (`canDecide`, `facts`, `appliedSteps` per request)                 |
| POST        | `/approvals/requests/:id/approve`, `/reject` | the action's approver permission (+ re-auth for period reopening)                                                      |

**Conditional approvals (Phase 3A S10).**

- **Step `conditions`:** `{ minBaseAmount?, maxBaseAmount?, transactionTypes? }`. Amounts are decimal strings in the base currency: the minimum is inclusive and the maximum exclusive. Types must come from the action's list. The server stores `thresholdCurrency`, which is read-only.
- **Validation:** unknown fields at any level return `400 VALIDATION_FAILED`, as do amounts on an action without amounts, a maximum not above the minimum, too many decimals, and unknown types.
- **Facts are derived on the server:**
  - journal posting: types `manual`, `imported` or `accounting_event`, with the posted base total;
  - opening balances: type `opening_balance`, with the canonical S8 amount;
  - period reopening: type `period_reopen`, with no amount.
- A request keeps only the matching steps. With no matching step there is no request, and the action proceeds directly.
- Journal detail adds `approvalFacts` and `approvalSteps`; `approvalRequiredForPosting` reflects the journal's facts. The opening-balance `approval` adds `facts` and `appliedSteps`.

## Imports and exports (CSV and XLSX, Decision 62)

| Method | Path                                                                           | Notes                                                                                                                        |
| ------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/imports`                                                                     | `{ domain, options }`; the domain's create permission                                                                        |
| POST   | `/files?linkType=import_batch&linkId=`                                         | upload one `.csv` or `.xlsx` (content-detected; 415 otherwise); the batch records its `format`                               |
| POST   | `/imports/:id/inspect`, PUT `/imports/:id/mapping`, POST `/imports/:id/commit` | the same for both formats; a workbook has no delimiter, its first sheet is read, values only (formulas are never evaluated)  |
| POST   | `/exports`                                                                     | `{ domain, params, format?: "csv" \| "xlsx" }` (default `csv`); the view reports `format`; workbooks are formula-neutralized |
| GET    | `/exports/:id`, `/exports/:id/download-url`                                    | permissions re-checked on every access                                                                                       |

Import limits are the Decision 61 maxima for both formats (25 MB, 25,000 rows, 200 columns); a workbook that is macro-enabled, declares a DTD, or unpacks suspiciously (zip bomb) is refused with `400`.

## Help assistant and tutorial progress (any signed-in member; see `assistant.md`)

| Method | Path                      | Notes                                                                                                                                                                                     |
| ------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/assistant/status`       | `{ mode: documentation or ai, provider, suggestions, limits }`; never configuration or secrets                                                                                            |
| POST   | `/assistant/messages`     | `{ message (1 to 2000), history? (up to 10 turns), path? }`; reply `{ reply, mode, degraded, notice, figures, unavailable, sources, generatedAt }`; `429` with `Retry-After` over a limit |
| GET    | `/tutorials/progress`     | the caller's own progress in the active organization                                                                                                                                      |
| PUT    | `/tutorials/progress/:id` | `{ status: in_progress, completed or skipped, step 0 to 100 }`; `:id` matches `^[a-z0-9][a-z0-9-]{0,59}$`                                                                                 |
| DELETE | `/tutorials/progress/:id` | forgets the caller's progress for that tutorial; `{ reset: boolean }`                                                                                                                     |

## API integrations (ADR 0011, management by administrators)

| Method     | Path                                               | Notes                                                                                                                             |
| ---------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| GET        | `/api-integrations/scopes`                         | `api_tokens.view`; the v1 scope catalog                                                                                           |
| GET, POST  | `/api-integrations`                                | view / `api_tokens.manage` + re-auth (+ MFA step-up where it applies); `{ name, description?, scopes, responsibleMembershipId? }` |
| GET, PATCH | `/api-integrations/:id`                            | `{ version, name?, description?, scopes? }`; only scopes the actor holds can be added                                             |
| POST       | `/api-integrations/:id/disable`, `/enable`         | `{ version, reason? }`                                                                                                            |
| POST       | `/api-integrations/:id/revoke`                     | `{ version, reason }`; terminal; revokes its tokens                                                                               |
| POST       | `/api-integrations/:id/reassign`                   | `{ version, responsibleMembershipId }`; the new person must be allowed to manage tokens                                           |
| GET, POST  | `/api-integrations/:id/tokens`                     | list (never a secret) / create `{ name, expiresInDays? }` (1 to 365, default 90); the credential is returned once                 |
| POST       | `/api-tokens/:id/rotate`, `/api-tokens/:id/revoke` | rotate creates a replacement token; revoke needs `{ reason }`                                                                     |

## Public API v1 (`/public/v1`, ADR 0011)

Reads, plus draft writes for customers, items and draft invoices (see below); bearer-token only (`Authorization: Bearer itk_…`); cookies are never accepted. The contract is `docs/openapi/public-v1.json` (also served at `GET /public/v1/openapi.json`); `pnpm openapi:check` keeps it in step with the code and classifies changes as breaking or additive (`docs/openapi-compatibility.md`). Resources: `customers`, `vendors`, `invoices`, `bills`, `accounts`, each as a list and `/:id`. Items are not a public v1 resource (no `items:read` scope exists). Five further read scopes — `credit_notes:read`, `receipts:read`, `vendor_credits:read`, `vendor_payments:read` and `expense_claims:read` — exist **only to subscribe to webhook events** about those resources (customer refund events use `receipts:read`, vendor refund events `vendor_payments:read`); they grant no Public API read endpoint, and no `/public/v1` route requires them. Lists use `limit` (1–100) and an opaque `cursor`; responses are `{ data, page: { next_cursor, has_more } }`; errors are `{ error: { type, code, message, request_id, details? } }`; rate limits are reported in `RateLimit-*` headers with `429` and `Retry-After`.

Draft writes (scope `customers:write`, `items:write`, `invoices:write`; ADR 0011 section 22): `POST /customers`, `PATCH /customers/:id`, `POST /items`, `PATCH /items/:id`, `POST /invoices`, `PUT /invoices/:id`. Bodies are strict snake_case (unknown fields are a 400); no account, tax code or dimension reference is accepted. Creates take an optional `Idempotency-Key` (same key and request replays the first response, a different request is `409 idempotency_conflict`; keys belong to the integration). Updates take the resource `version` (`409 version_conflict` when stale; customers also return an `identity_version` of the contact record that you may send back to avoid overwriting a Contacts-screen edit); only a DRAFT invoice can be replaced (`409 invalid_state` otherwise). Item writes return the item but there is still no item read endpoint. There is no endpoint that issues, posts, approves, voids, refunds or records a payment, or that reads or writes a journal or ledger: an invoice created here stays a draft until a person issues it in the application.

## Webhooks (ADR 0011 section 11; Step 6)

Webhook endpoints are managed by people under `/api/v1/webhooks/*` (cookie session; `webhooks.view` to read, `webhooks.manage` plus a recent password confirmation to change). `GET /webhooks/event-types` lists the catalog and which types can be subscribed to with the current scopes; `POST /webhooks/endpoints` creates an endpoint for one integration (`name`, `url`, `integrationId`, `eventTypes`, `payloadMode` `thin` or `full`) and returns the signing secret **once**; further actions: `PATCH`/`DELETE /webhooks/endpoints/:id`, `POST .../rotate-secret`, `.../disable`, `.../enable` (needs a successful `.../ping` since the disablement), `.../ping`, `GET /webhooks/deliveries[/:id]` and `POST /webhooks/deliveries/:id/redeliver`.

**Delivery.** `POST` of the event JSON to your HTTPS URL (port 443, a public DNS name; redirects are not followed). Success is any 2xx within 10 s. Anything else is retried after 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h and 24 h (about two days, ±20% jitter) and then dead-lettered; the same delivery id and event id are used for every retry. After 10 consecutive dead-lettered deliveries, or 3 days without a success (counted from the later of the last success and the last time the endpoint was enabled; see below), the endpoint is disabled automatically and nothing is replayed: **webhooks are a notification channel, not a guaranteed backfill. Reconcile with the pull API (`updated_since`).** Delivery is at least once and not ordered: de-duplicate on the event `id`, and treat events as notifications (a Contacts edit can repeat the same `resource.version`).

**Envelope** (`thin` default): `{ id, type, api_version, occurred_at, organization_id, resource: { type, id, version }, data: { object_type, object_id, url } }`; `url` is a path under `/public/v1` for customers, vendors, invoices and bills and `null` for other resources. The credit note, receipt, customer refund, vendor credit, vendor payment, vendor refund and expense claim events are **always thin, also for a `full` endpoint** (`data.object` is only added for customers, vendors, invoices and bills): the consumer receives the reference and cannot retrieve these resources through the Public API. Item events cannot be subscribed to (`items:read` is deferred). A `full` endpoint also gets `data.object`, the public DTO "as of at or after the event". Headers: `Intuit-Webhook-Id` (the delivery), `Intuit-Webhook-Event`, `Intuit-Webhook-Timestamp`, `Intuit-Webhook-Signature: t=<unix seconds>,v1=<hex>` (two `v1` values while a rotated secret overlaps).

**Test ping.** `POST /webhooks/endpoints/:id/ping` sends one signed `webhook.ping` to the endpoint, in any status, and returns `{ deliveryId, success, statusCode, errorClass, durationMs }`. It needs `webhooks.manage` only: no recent password confirmation and no second factor. It is limited to **one ping per endpoint per 10 seconds**, measured from the endpoint's latest ping whether it succeeded or failed, whoever sent it and whatever the endpoint's status; simultaneous requests are serialized, so only one is sent. A request inside the interval is refused with **HTTP 429**, error code `TOO_MANY_ATTEMPTS`, the message "Too many attempts. Please wait and try again." and a `Retry-After` header with the remaining whole seconds (rounded up, at least 1 and at most 10); nothing is sent and neither a delivery nor an audit event is created. A sent ping is audited (`webhook_endpoint.pinged`), never counts toward automatic disablement, and a successful ping is what allows `.../enable`.

**Delivery history visibility.** `GET /webhooks/deliveries` and `GET /webhooks/deliveries/:id` need `webhooks.view`, and show a delivery only if you may read its resource family: customer, vendor, invoice and bill deliveries need `customers.view`, `vendors.view`, `invoices.view` and `bills.view`; credit note `credit_notes.view`; receipt and customer refund `receipts.view`; vendor credit `vendor_credits.view`; vendor payment and vendor refund `vendor_payments.view`; expense claim `expense_claims.view`; item (none can exist while items are unsubscribable) any of `invoices.view`, `bills.view`, `catalog.items.manage`, `sales.items.manage`. Test pings are visible to every `webhooks.view` holder. The filter is applied in the database query before `limit`, `status` and `endpointId`, so a page is never shortened by hidden rows and no total or gap reveals them. A delivery outside your families answers **404 exactly like a missing delivery** on `GET /webhooks/deliveries/:id` and on `POST /webhooks/deliveries/:id/redeliver` (redelivery needs `webhooks.manage` first: 403 without it). The stored **response excerpt** of an attempt is returned only to holders of `webhooks.manage`; everyone else gets the attempt with `responseExcerpt: null`. The endpoint list and detail, including their health fields (`consecutiveFailures`, `lastSuccessAt`, `lastFailureAt`), stay visible to every `webhooks.view` holder. Payloads, signatures and secrets are never part of the history. Vendor refunds follow the family-level `vendor_payments.view`: a viewer without `vendor_credits.view` sees the history row of a credit-funded vendor refund that the internal screen would hide.

**Automatic disablement.** After 10 consecutive dead-lettered deliveries, or when an `active` endpoint that has failed deliveries has had no success for 3 days, the endpoint becomes `auto_disabled` (audited as `webhook_endpoint.auto_disabled` with the system actor). The 3-day window starts at the **later of the endpoint's last successful delivery and its `enabled_at`**, the time it was created or last returned to `active`; with no success yet it starts at `enabled_at`. Re-enabling therefore restarts the window, and an endpoint re-enabled after a 3-day disablement is not disabled again by its first failure. The people notified by e-mail are the integration's **responsible administrator** and the **endpoint's creator**, one e-mail per person (a person who is both receives one). A person is notified only if their **user account is active and their membership in the organization is active**; e-mail verification is not required. If nobody is eligible no e-mail is sent, **organization Owners are not used as a fallback**, and the audit event is written regardless. Disabling an endpoint manually sends no e-mail.

**Verify the signature** over the RAW body: `HMAC-SHA256(secret, "<t>.<Intuit-Webhook-Id>.<raw body>")`, compare in constant time and reject `t` older than 5 minutes.

```js
// Node.js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, headers, rawBody) {
  const parts = headers['intuit-webhook-signature'].split(',');
  const t = Number(parts.find((p) => p.startsWith('t=')).slice(2));
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret)
    .update(`${t}.${headers['intuit-webhook-id']}.${rawBody}`)
    .digest();
  return parts
    .filter((p) => p.startsWith('v1='))
    .some((p) => {
      const given = Buffer.from(p.slice(3), 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
```

```python
# Python
import hashlib, hmac, time
def verify(secret: str, headers: dict, raw_body: bytes) -> bool:
    parts = headers["intuit-webhook-signature"].split(",")
    t = int(next(p[2:] for p in parts if p.startswith("t=")))
    if abs(time.time() - t) > 300:
        return False
    msg = f"{t}.{headers['intuit-webhook-id']}.".encode() + raw_body
    expected = hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(p[3:], expected) for p in parts if p.startswith("v1="))
```
