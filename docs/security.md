# Security Architecture (Phase 1)

The approved decisions are in [ADR 0001](decisions/0001-phase-1-foundation.md). This page describes how they are implemented.

## Authentication

- **Registration** creates, in one transaction: a user, a new organization, a membership, the organization's roles (copied from the system role templates), the Owner role assignment, audit events, a security event, outbox events and a session.
- **Passwords** are hashed with Argon2id (19 MiB, t=2, p=1) via `@node-rs/argon2`. The minimum length is 12 characters, the maximum is 1024 (to bound hashing cost), and there are no complexity rules. A database CHECK constraint accepts only `$argon2id$` hashes.
- **Login** returns the same generic error for an unknown account, a wrong password and a disabled account. Unknown accounts run a dummy hash verification so response times match.
- **Account disablement** (`AuthService.disableAccount`) blocks sign-in and revokes every session immediately. Phase 1 exposes it as a service only; there is no platform-admin endpoint yet.
- **Email verification** is deferred. `users.email_verified_at` exists for it.

## Sessions

- Opaque 256-bit random tokens. The cookie holds the raw token; PostgreSQL (`sessions.token_hash`) stores only its SHA-256.
- Cookie: `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` in `staging` and `production`. Local `http://` development and tests cannot use `Secure`.
- Every request validates the session in PostgreSQL, so revocation is immediate. A session is rejected if it is revoked, if its user is disabled, if it is past its **7-day absolute lifetime**, or if it has been idle for **30 minutes**. Expired sessions are marked revoked with reason `expired`.
- Logout revokes the session. Users can list their sessions and revoke other ones; revoking another session is a sensitive action.
- A completed password reset revokes **all** of the user's sessions.
- Sign-in revokes any session the browser was already presenting.
- The active organization is a server-side session attribute, re-verified on every request.

## CSRF

Three layers apply to every `POST`, `PUT`, `PATCH` and `DELETE`:

1. **Origin check:** a request with an `Origin` header other than `WEB_ORIGIN`, or with `Sec-Fetch-Site: cross-site`, is rejected with `403 CSRF_REJECTED`.
2. **Session-bound token:** cookie-authenticated writes must send `X-CSRF-Token`. Its value is `HMAC-SHA256(SESSION_SECRET, "csrf:" + sessionId)`, is compared in constant time, and is returned in the session payload. The web app keeps it in memory only.
3. **JSON only:** the API accepts only `application/json` bodies. The `text/plain` parser is removed, so cross-site forms cannot produce an accepted request without a CORS preflight.

`SameSite=Strict` adds a further layer on top.

## Sensitive-action re-authentication

`POST /auth/reauthenticate` with the password sets `sessions.reauthenticated_at`. A fresh sign-in also counts. Actions that require a re-authentication within the last **15 minutes** return `403 REAUTHENTICATION_REQUIRED` otherwise:

- role create, edit or delete (including permission changes)
- member role assignment
- membership disable or re-enable
- revoking another session

## Login protection

Failed sign-ins and failed re-authentications are recorded as `auth.login_failed` security events. Before verifying a password, the server counts failures in the last **15 minutes** separately **per account** and **per IP**. If either count reaches **5**, the attempt must wait out a back-off from the last failure: 1 minute, then doubling for each further failure (2, 4, … up to 15 minutes). A throttled attempt returns `429 TOO_MANY_ATTEMPTS` with `Retry-After`, and records `auth.login_throttled`. There is no permanent lockout, because failures age out of the window. All thresholds are configurable.

## Password reset

- `POST /auth/password-reset/request` always returns the same `202` response, whether or not the account exists, so it cannot be used to discover accounts.
- For an active account, the server issues a 256-bit random, single-use token and stores only its SHA-256. The token expires after **60 minutes** (approved and frozen; `PASSWORD_RESET_TOKEN_TTL_MINUTES=60`).
- The link is `WEB_ORIGIN/reset-password#token=…`. The token is in the URL **fragment**, so browsers never send it to servers, to logs or in `Referer` headers. The web app posts it in a JSON body.
- `POST /auth/password-reset/complete` consumes the token atomically (unused and unexpired, in a single `UPDATE … RETURNING`), sets the new password, invalidates the user's other outstanding reset tokens and revokes all sessions.
- Tokens are never logged, never stored raw and never returned by any API.

## Authorization

The flow for every organization-scoped request:

```
Authentication (session) → Membership (active, in the session's active organization)
  → Roles → Permissions → Resource/scope
```

- `application/authorization.ts` resolves an `AuthorizationContext` on the server. It never uses an organization ID supplied by the client. `/organizations/current/...` always means the session's active organization.
- Permission checks use the global catalog keys (for example `members.invite`). Missing permissions return `403 PERMISSION_DENIED`, and disabled memberships return `403 FORBIDDEN`.
- Resource/scope checks: every query is filtered by the context organization. An ID from another organization therefore behaves as not found (`404`), and the response never reveals that the resource exists.
- **Owner protections:**
  - Exactly one Owner per organization, enforced by a unique partial index on `membership_roles`.
  - The Owner role cannot be assigned, invited to, edited or deleted.
  - The Owner's roles and membership cannot be changed.
  - Ownership changes will go through the controlled transfer workflow. Its data model exists in `ownership_transfers`; the workflow itself is not built in Phase 1.
- System roles (templates) cannot be renamed or deleted, but organizations can customize their permissions. Custom roles are fully editable. A role cannot be deleted while it is assigned or referenced by an invitation.
- Frontend permission checks are for UX only. The API is the authority.

## Row-Level Security (defence-in-depth)

RLS is enabled on `organizations`, `memberships`, `roles`, `role_permissions`, `membership_roles`, `invitations`, `ownership_transfers` and `audit_events`. It applies to `intuit_app`.

- Each transaction sets `app.user_id` and `app.organization_id` with `set_config(..., true)`, so the settings are transaction-local.
- Policies allow rows of the context organization only. A user can additionally read their own memberships and the organizations they actively belong to, which the organization switcher needs.
- Invitation acceptance must find an invitation by token before any organization context exists. It uses a narrow `SECURITY DEFINER` function (`app_resolve_invitation_token`) that returns identifiers only.
- RLS never replaces application authorization. Integration tests verify both layers independently.

## Audit and security history

- `audit_events` records business changes: organization, membership, invitation and role changes, with before and after metadata.
- `security_events` records authentication and session events: registration, sign-in success, failure and throttling, logout, session revocation and expiry, re-authentication, password reset, account disablement and organization switching.
- **Immutability:**
  - `intuit_app` has only INSERT and SELECT on both tables.
  - `BEFORE UPDATE/DELETE` row triggers and `BEFORE TRUNCATE` statement triggers reject changes for every role, including the table owner.
  - Database superusers remain outside application controls, as the ADR acknowledges.
- **No secrets are stored:** metadata keys that look like secrets (`password`, `token`, `secret`, `hash`, `cookie`, …) are stripped before insert, as defence-in-depth.
- Reading organization audit history requires `audit.read`. RLS additionally limits reads to the active organization.

## Logging

- Structured JSON (pino), with a request ID on every log line and response (`x-request-id`). A well-formed incoming ID is reused.
- Request bodies are never logged. Cookie, authorization and CSRF headers, and any `password`, `token` or `passwordHash` field, are redacted.
- Client errors return stable codes. Unexpected errors return a generic `500 INTERNAL_ERROR` with no stack traces, SQL or driver messages; the details are logged on the server only.
- Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.

## Accounting security (Phase 2)

- **Tenant isolation:** every accounting and approval table carries `organization_id` and is protected by RLS. Composite foreign keys pin lines, accounts, periods, approvals and reversals to the same organization. A resource ID from another organization returns `404`.
- **Authorization:** the accounting permissions in [ADR 0002](decisions/0002-phase-2-accounting.md) are checked on every endpoint. The frontend offers only the actions the user is allowed to perform.
- **Sensitive actions** (re-authentication within 15 minutes):
  - accounting setup and base-currency changes
  - period close
  - period reopen, including approving a reopen request
  - journal post
  - journal reverse
  - approval-policy changes
  - account deletion
- **Approvals:** self-approval is prohibited (preparer and submitter), and each person can decide once per request. Every decision is recorded in the append-only `approval_decisions` table and in the audit log.
- **Posted journal immutability:** the application exposes no edit or delete for posted journals, and database triggers reject such changes even for the owning database role. The application role has no DELETE privilege on journals.
- **Audit:** every account, journal, period and approval-policy change writes an audit event with before/after context, for example `account.created`, `journal.posted`, `journal.reversed` and `period.reopened`. Audit history stays append-only (ADR 0001).
- **Idempotency:** accounting events are deduplicated on (organization, source module, event key), and a conflicting replay is rejected.
