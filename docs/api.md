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

| Status | Code                                                                                                                                                                                                                                                                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`, `MALFORMED_REQUEST`, `INVALID_TOKEN` (password reset)                                                                                                                                                                                                                                                                                                       |
| 401    | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`                                                                                                                                                                                                                                                                                                                                         |
| 403    | `SELF_APPROVAL_PROHIBITED`, `NOT_ELIGIBLE_APPROVER`, `PERMISSION_DENIED`, `FORBIDDEN`, `REAUTHENTICATION_REQUIRED`, `CSRF_REJECTED`, `INVITATION_EMAIL_MISMATCH`, `INVALID_CREDENTIALS` (re-authentication)                                                                                                                                                                      |
| 404    | `NOT_FOUND`, `INVALID_TOKEN` (invitation)                                                                                                                                                                                                                                                                                                                                        |
| 409    | `ACCOUNTING_NOT_SET_UP`, `ACCOUNTING_ALREADY_SET_UP`, `ACCOUNT_IN_USE`, `INVALID_STATE_TRANSITION`, `PERIOD_CLOSED`, `PERIOD_NOT_FOUND`, `EXCHANGE_RATE_REQUIRED`, `APPROVAL_REQUIRED`, `ALREADY_DECIDED`, `IDEMPOTENCY_CONFLICT`, `CONFLICT`, `EMAIL_UNAVAILABLE`, `ALREADY_MEMBER`, `LOGIN_REQUIRED`, `PROTECTED_RESOURCE`, `INVITATION_NOT_PENDING`, `NO_ACTIVE_ORGANIZATION` |
| 410    | `INVITATION_EXPIRED`                                                                                                                                                                                                                                                                                                                                                             |
| 415    | `UNSUPPORTED_MEDIA_TYPE`                                                                                                                                                                                                                                                                                                                                                         |
| 429    | `TOO_MANY_ATTEMPTS` (with `Retry-After`)                                                                                                                                                                                                                                                                                                                                         |
| 500    | `INTERNAL_ERROR`                                                                                                                                                                                                                                                                                                                                                                 |

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

## Revaluation (Phase 3A S9)

There are no revaluation endpoints yet; the user workflow and its routes arrive in Phase 4. Revaluation journals appear in the existing journal, ledger and report endpoints with `source: "system"` and `sourceType` `revaluation` (dated D) or `revaluation_reversal` (dated D + 1, or a cancellation). `POST /accounting/journals/:id/reverse` on either returns `409 SYSTEM_JOURNAL`.

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
