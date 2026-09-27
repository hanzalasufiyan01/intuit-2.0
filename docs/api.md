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

| Method | Path                                                 | Auth | Permission / notes                                               |
| ------ | ---------------------------------------------------- | ---- | ---------------------------------------------------------------- |
| GET    | `/health`                                            | —    | Includes a database check                                        |
| POST   | `/auth/register`                                     | —    | Creates user + organization (Owner)                              |
| POST   | `/auth/login`                                        | —    | Login protection applies                                         |
| POST   | `/auth/logout`                                       | ✓    | Revokes the session                                              |
| GET    | `/auth/session`                                      | ✓    | Session state + CSRF token                                       |
| POST   | `/auth/reauthenticate`                               | ✓    | Opens the 15-minute window                                       |
| PUT    | `/auth/session/organization`                         | ✓    | Switch organization (membership re-verified)                     |
| GET    | `/auth/sessions`                                     | ✓    | Own active sessions                                              |
| DELETE | `/auth/sessions/:sessionId`                          | ✓    | Own session; another one is sensitive                            |
| POST   | `/auth/password-reset/request`                       | —    | Always `202`                                                     |
| POST   | `/auth/password-reset/complete`                      | —    | Single-use token; revokes sessions                               |
| GET    | `/organizations`                                     | ✓    | Own organizations                                                |
| POST   | `/organizations`                                     | ✓    | New organization; caller is Owner                                |
| GET    | `/organizations/current`                             | ✓    | `organization.read`                                              |
| PATCH  | `/organizations/current`                             | ✓    | `organization.update`                                            |
| GET    | `/organizations/current/members`                     | ✓    | `members.read`                                                   |
| PUT    | `/organizations/current/members/:membershipId/roles` | ✓    | `members.manage` + re-auth                                       |
| PATCH  | `/organizations/current/members/:membershipId`       | ✓    | `members.manage` + re-auth (status)                              |
| GET    | `/organizations/current/invitations`                 | ✓    | `members.invite`                                                 |
| POST   | `/organizations/current/invitations`                 | ✓    | `members.invite`                                                 |
| POST   | `/organizations/current/invitations/:id/revoke`      | ✓    | `members.invite`                                                 |
| GET    | `/organizations/current/roles`                       | ✓    | `roles.read`                                                     |
| POST   | `/organizations/current/roles`                       | ✓    | `roles.manage` + re-auth                                         |
| PUT    | `/organizations/current/roles/:roleId`               | ✓    | `roles.manage` + re-auth                                         |
| DELETE | `/organizations/current/roles/:roleId`               | ✓    | `roles.manage` + re-auth                                         |
| GET    | `/permissions`                                       | ✓    | `roles.read`                                                     |
| GET    | `/organizations/current/audit-events?limit&before`   | ✓    | `audit.read`                                                     |
| POST   | `/invitations/lookup`                                | —    | Token in the body                                                |
| POST   | `/invitations/accept`                                | opt. | Signed in: the email must match. Signed out: creates the account |

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

## Approvals endpoints (Phase 2, `/api/v1/approvals`)

| Method      | Path                                         | Permission / notes                                                                               |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET         | `/approvals/policies`                        | `approvals.manage`; approvable actions and configured policies                                   |
| PUT, DELETE | `/approvals/policies/:actionKey`             | `approvals.manage` + re-auth; `{ steps: [{ name, requiredApprovals, roleIds, membershipIds }] }` |
| GET         | `/approvals/requests`                        | pending requests for actions the caller can approve (`canDecide` per request)                    |
| POST        | `/approvals/requests/:id/approve`, `/reject` | the action's approver permission (+ re-auth for period reopening)                                |
