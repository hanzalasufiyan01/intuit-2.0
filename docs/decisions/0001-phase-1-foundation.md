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

| Setting | Value |
| --- | --- |
| Session idle timeout | 30 minutes |
| Session absolute lifetime | 7 days |
| Sensitive-action re-authentication | 15 minutes |
| Password minimum length | 12 characters, no arbitrary complexity rules |
| Login protection | 5 failed attempts within 15 minutes per account/IP; progressive, no permanent lockout |

All significant authentication-security events are auditable.

## Email verification — DEFERRED

Not required for the Phase 1 flow. The user model carries verification status, invitations can support verified acceptance later, and the email provider abstraction exists.

## Open items (UNDECIDED)

- Invitation expiry period
