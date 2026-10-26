# Security review (WS3): findings of 2026-10-17

Scope: an internal review of the code added since commit `c0b61cb` and a set of repository-wide checks. **This is not a penetration test and not an external audit.** No claim of production readiness follows from it.

## Checks run

| Check                                                | Result                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm audit --prod`                                  | No known vulnerabilities.                                                                                                                                                                                                                                                                                                    |
| `pnpm audit` (all)                                   | 1 high: `source-map-js` < 1.2.2 (GHSA-68fv-2mgg-jv7q, event-loop DoS from a crafted source map) through `apps/web > jsdom > css-tree`. **Development/test only** (jsdom in the web test runner); not in any shipped bundle. Not fixed: needs a dependency override and a network install. Tracked in `known-limitations.md`. |
| Secret scan (regex over tracked and untracked files) | No private keys, cloud keys, tokens or live-looking secrets in source. The only hit is an audit reason string. `.env.example` holds placeholders only; no `.env` file is tracked.                                                                                                                                            |
| Migration integrity                                  | 63 migration files (0001–0063). The migrator verifies checksums of applied migrations on every start and every test run; the full API suite passes, so no applied migration (including 0059) was edited. New migrations 0060–0063 are forward-only.                                                                          |
| Typecheck, lint, Prettier                            | Clean (API and web).                                                                                                                                                                                                                                                                                                         |

## New surface reviewed

| Surface                                                                                 | Authorization                                                                                                                                                                         | Evidence                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Ownership transfer (7 routes)                                                           | Owner only to initiate/cancel, addressee only to accept/decline, step-up on every state change, MFA required of target                                                                | `ownership-transfer.test.ts`                             |
| `GET /metrics`                                                                          | Bearer `METRICS_TOKEN`, constant-time compare, 404 when unset, aggregate counts only (SECURITY DEFINER function)                                                                      | `metrics.test.ts`                                        |
| Customer returns and supplier returns                                                   | `inventory.adjustments.create` / `.void`, step-up on void, RLS, tenant tests, DB immutability triggers                                                                                | `inventory-returns.test.ts`                              |
| Management reports (sales trend, inventory, tax liability)                              | Per-report permission; COGS profitability needs both `inventory.view` and `sales.reports.view`; tax liability both sales and purchases report rights; read-only                       | `management-reports.test.ts`                             |
| SMTP provider                                                                           | Header-injection refusal; credentials never over unencrypted non-loopback connections; secrets not logged                                                                             | `smtp-provider.test.ts`                                  |
| Online payment gateway (staff routes)                                                   | `payments.view` / `.intents.create` / `.reconcile` / `.settings.manage` (owner and administrator by default); settings need step-up; RLS, tenant and permission tests                 | `payment-gateway.test.ts`                                |
| Payment webhook `POST /payments/webhooks/:provider`                                     | Unauthenticated; HMAC signature over the RAW body (constant-time), then confirmed against the provider's own record; unique event ledger; rate limited; unknown payments acknowledged | `payment-gateway.test.ts`                                |
| Public pay and statement routes (`/public/invoices/:token/pay`, `/public/statements/*`) | Unguessable token (hash stored), expiry, revocation, uniform 404, per-address rate limit, no-store; a statement can only pay its own customer's invoices                              | `payment-gateway.test.ts`, `customer-statements.test.ts` |
| Integrations and webhooks UI                                                            | Same permissions as the existing API (`api_tokens.*`, `webhooks.*`); secrets shown once, in memory only, never cached; all writes behind the re-authentication prompt                 | web `integrations.test.tsx`                              |

## Open items (honest list)

1. Real-TLS behavior of the webhook transport and the SMTP client is untested on this machine (antivirus interception); two webhook and two SMTP tests skip.
2. No dynamic scan, fuzzing or penetration test has been done.
3. The CI workflow runs on GitHub (green in run 39574210127, 2026-10-21, including `pnpm audit --prod`); it has no container image scan.
4. Rate-limit and lock-out behavior under real load is untested. A read-only load script exists and passed once on a development machine (see `docs/operations.md`); write paths and the authentication limits were not load tested.
5. Backup: a `pg_dump` of the development database was taken and its table of contents verified with `pg_restore --list` (2026-10-18). Restore and key rotation drills have NOT been exercised (a restore needs a superuser to create a database; see `docs/open-decisions.md`).
6. The development-only `source-map-js` advisory above.

## Addendum: review of 2026-10-19 (migrations 0075–0086)

Still an internal review, NOT a penetration test or external audit; no production-readiness claim follows.

| Check               | Result                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm audit --prod` | No known vulnerabilities (run 2026-10-19).                                                                                      |
| `pnpm audit` (all)  | Same single high as before: `source-map-js` through `apps/web > jsdom > css-tree`, test tooling only.                           |
| Secret scan         | One hit: `apps/api/test/webhook-tls-fixture.ts`, a documented self-signed test key that protects nothing. No `.env` is tracked. |
| Migrations          | 86 files (0001–0086), forward-only, checksum-protected; registry asserted in `s2-fixes.test.ts`.                                |
| Full `pnpm verify`  | Exit 0 before the clinic/branch-leak/payroll-audit batch (API 1713 passed, 4 skipped; web 305); re-run at the next checkpoint.  |

Findings and fixes in this period:

1. **Cross-branch file leak (FIXED).** `GET /files/:id` and its download link authorized by the permission of the linked document only. A member limited to a branch could read the metadata and a download link of a file attached to another branch's invoice if they knew its id. File access now also requires the linked record to be visible under row-level security (`file-service.ts`, test `branch-scopes.test.ts`).
2. **Salary reads were not audited (FIXED).** Employee list/detail, salary history, pay run, payslip and register reads now write audit events with counts and numbers only (`payroll.test.ts`).
3. **Duplicate supplier-reference check is branch-blind for restricted members (ACCEPTED, documented).** Warning them would reveal another branch's bill.
4. **Draft warehouse/lot side tables use the document's `create` permission, not `edit_draft` (OPEN, low).** Roles that have one normally have the other.

New surface reviewed: branch scopes (RLS policies on invoices, bills and their lines; scope set after access is resolved; owners and self cannot be limited), organization groups (user-guarded tables, owner-only add, 404 for strangers, no cross-organization sums), clinic consent register (append-only trigger, audit without wording or names) and retention review (audited list, nothing removed), payment gateway (simulated provider only, `live` refused), customer statement links (signed, scoped to one customer).

Not done: penetration test, external audit, load test of write paths, rate-limit behaviour under load, real-TLS tests (4 skipped here), container image scan (no container runtime here).

## Addendum: deployment smoke (2026-10-21)

Still an internal review on disposable CI runners, NOT a penetration test, an external audit or a production deployment.

1. **Client-chosen rate-limit address behind nginx (FIXED).** `deploy/nginx.conf` appended to the client's `X-Forwarded-For` header and the API (with `TRUST_PROXY=true`) takes the first address of it, so a caller could pick the key of the per-address limits (public invoice and statement views, payment webhooks, Public API failed sign-ins) and the address recorded on sessions. nginx now overwrites the header with `$remote_addr`. Verified in deploy-smoke [run 39574210093](https://github.com/hanzalasufiyan01/intuit-2.0/actions/runs/39574210093): 61 requests with forged addresses gave 429 x0 through a deliberately vulnerable variant of the configuration and 429 x31 (first at request 31) through the real one. Behind a load balancer the `real_ip` setup in `docs/operations.md` section 2 is needed; it is not tested.
2. **Production configuration refusals (verified):** the API image refuses to start without `WEB_ORIGIN`, with a short `SESSION_SECRET`, and with the mock e-mail provider under `APP_ENV=production`.
3. **Mail in tests cannot leave the runner (verified):** the SMTP path delivered the password-reset e-mail to a Mailpit catcher on an internal-only network with no outbound route.
4. **Backup and restore (verified on a small, fresh database):** restore into an empty database, row counts, migration checksums, ledger, inventory and RLS checks, 214 policies; an API on the restored copy served it.

Not done: container image scan, penetration test, external audit, TLS termination and HSTS on a real host, real SMTP and S3, load test of write paths.

## Addendum: dependency advisories and open items (2026-10-27)

Still an internal review, NOT a penetration test, an external audit or a production deployment. Read-only audit of `origin/main` `2652a64` (`production-readiness-audit.md`).

1. **The "no known vulnerabilities" result above is out of date.** `pnpm audit --prod` on 2026-10-26 reports **9 advisories (5 low, 4 moderate, none high)**, all through `fastify` and `@fastify/ajv-compiler`: several `fast-uri` advisories (scheme spoofing, host confusion, path equivalence, scheme injection; patched in 3.1.9 and 4.2.3) and a low `fastify` header-validation bypass (patched in 5.12.6). CI runs `pnpm audit --prod --audit-level high`, so it stays green. Not fixed yet.
2. **Still not done:** container image scan, dependency bot, code scanning, penetration test, external audit, TLS and HSTS on a real host, real SMTP and S3, write-path load test, production-like restore drill, key backup and rotation drill, error reporting and alerting.
3. **Web hardening:** `deploy/nginx.conf` sets four security headers but no HSTS and no Content-Security-Policy for the web app.
4. **Registration and demo seed:** registration is public unless `REGISTRATION_MODE` is `code` or `closed` (proven through the running compose stack by `deploy-smoke`); the demo seed refuses `APP_ENV=production` and any database but `intuit2_review`, but the `APP_ENV=staging` override is an operator statement.
