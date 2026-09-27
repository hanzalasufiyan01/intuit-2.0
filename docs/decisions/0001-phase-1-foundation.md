# ADR 0001 — Phase 1 Foundation Decisions

- **Status:** Approved
- **Date:** 2026-09-27
- **Source:** Intuit 2.0 Phase 1 Implementation Command v1.0 and Phase 1 Decision Approval

Where specifications overlap, the most recent approved decision takes precedence.

## Project

- Name: **Intuit 2.0**.
- Initial working-release target: **10–15 days**.
- Source control: private GitHub repository `hanzalasufiyan01/intuit-2.0`, with progressive, meaningful commits.

## Stack

- pnpm workspace monorepo
- Backend: Node.js, TypeScript, Fastify, Drizzle ORM, SQL-based migrations, Zod, REST
- Tests: Vitest, with integration tests against real PostgreSQL
- Frontend: React, TypeScript, Vite, React Router, TanStack Query
- Password hashing: Argon2id
- Modular monolith with a PostgreSQL-backed outbox; no external broker

No other major framework or ORM without approval.

## Sessions

- Opaque server-side sessions stored in PostgreSQL
- httpOnly cookie, Secure in production, appropriate SameSite, CSRF protection on cookie-authenticated state-changing requests
- Immediate revocation; JWT is not the primary browser session mechanism
- Architecture must allow API tokens / service accounts later

## Roles and permissions

- Roles are organization-scoped, seeded from system role templates
- Organizations may customize roles and role-permission assignments within protected system constraints
- Permissions are a global catalog that modules extend
- Effective authorization: User → Membership → Organization roles → Permissions → Resource/scope
- The Owner role is protected

## Joining organizations

- Registration creates a user, an organization, a membership, and assigns Owner
- Other users join by invitation: invited email, organization, inviter, expiry, secure token, acceptance, membership creation, audit event
- Email goes through a provider abstraction; a mock provider is used in Phase 1

## Financial deletion

- No `invoices.delete` permission. Use `invoices.delete_draft` and `invoices.void`.
- Issued/posted financial records are never physically deleted. Corrections use void, reversal, credit notes or adjustments. The same applies to all financial records.

## Ownership

- Exactly one active Owner per organization
- Transfer workflow: initiate → security verification → new owner accepts → audit → notifications → ownership changes → previous owner receives configured replacement role
- The full transfer workflow is not built in Phase 1, but the data model must support it

## Audit immutability

- Application-level prohibition on modification and deletion
- The application database role has INSERT/SELECT only on audit and security-event tables
- Database-level protection (trigger) rejects UPDATE/DELETE
- Reading audit data is permission-controlled
- Database superusers are acknowledged as outside application controls

## Security defaults (configuration-driven)

| Setting                            | Value                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| Session idle timeout               | 30 minutes                                                                            |
| Session absolute lifetime          | 7 days                                                                                |
| Sensitive-action re-authentication | 15 minutes                                                                            |
| Password minimum length            | 12 characters, no arbitrary complexity rules                                          |
| Login protection                   | 5 failed attempts within 15 minutes per account/IP; progressive, no permanent lockout |
| Password-reset token lifetime      | 60 minutes (approved and frozen 2026-09-27; see below)                                |

All significant authentication-security events are auditable.

## Email verification — DEFERRED

Not required for the Phase 1 flow. The user model carries verification status, invitations can support verified acceptance later, and the email provider abstraction exists.

## Invitations — APPROVED (Phase 1 Implementation Specification v1.0)

- Invitation expiry: **72 hours**, configuration-driven (`INVITATION_EXPIRY_HOURS=72`).
- Resolves the previously open "invitation expiry period" item.

## Local development database — APPROVED (Phase 1 Implementation Specification v1.0)

- Standard development database name: **`intuit2_dev`** (replaces the earlier inconsistent `intuit_dev`).
- Local development uses the existing **native Windows PostgreSQL 16** service on port 5432. Docker is not required.
- Database roles: `intuit_owner` (owns the schema, runs migrations and catalog seeding) and `intuit_app` (runtime, least privilege; INSERT/SELECT only on audit and security-event tables).
- Credentials come only from environment configuration (git-ignored `.env`); none are committed.

## Phase 1 RBAC seed — APPROVED (implementation clarification, 2026-09-27)

- Permission catalog (Phase 1): `organization.read`, `organization.update`, `members.read`, `members.invite`, `members.manage`, `roles.read`, `roles.manage`, `audit.read`.
- System role templates:
  - **Owner** — all permissions (kept in sync with the catalog); protected: not editable, not assignable, not deletable.
  - **Administrator** — all eight Phase 1 permissions; editable per organization.
  - **Member** — `organization.read`, `members.read`.
- Custom organization roles may hold any subset of the catalog.
- The catalog rejects `invoices.delete` (code and a database CHECK constraint). Invoice permissions are not seeded in Phase 1; they are added with the invoicing phase.

## Sensitive actions — APPROVED (implementation clarification, 2026-09-27)

Require password re-authentication within the last 15 minutes:

- creating, editing or deleting roles (including role-permission changes);
- assigning or removing member roles;
- disabling or re-enabling a membership;
- revoking another of one's own sessions.

Invitations and organization profile updates do not require it.

## Login protection keying — APPROVED (implementation clarification, 2026-09-27)

- Failures are counted **per account and per IP** independently within the 15-minute window; either reaching 5 triggers protection.
- Progressive back-off: 1, 2, 4 … minutes per additional failure (base and cap configurable; cap 15 minutes).
- No permanent lockout: failures age out of the window. A successful sign-in does not erase failure history.
- Failed sensitive-action re-authentication attempts count as failed sign-ins.

## Password-reset token lifetime — APPROVED and FROZEN (2026-09-27)

- A password-reset token expires **60 minutes** after it is issued.
- Configured as `PASSWORD_RESET_TOKEN_TTL_MINUTES=60`; the application default is also 60.
- The value is frozen: changing it requires a new approved decision. The setting exists so every environment reads the approved value from one place, not so environments can diverge.
- Tokens remain single-use and are stored only as a SHA-256 hash. A successful reset also invalidates the user's other outstanding reset tokens and revokes all of their sessions.

## Open items

None for Phase 1.
