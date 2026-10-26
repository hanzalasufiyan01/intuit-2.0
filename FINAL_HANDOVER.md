# Final handover: Intuit 2.0

Written 2026-10-27 against `origin/main` `2652a64b96272d2bb22757b68319ec67cde15b73` ("Merge pull request #13", 92 commits since 2026-09-27). This is a dated snapshot: re-check every state fact (commands in `RESUME.md`) before relying on it. **Intuit 2.0 is not production-ready.** Nothing below claims that backups, restore, TLS, monitoring or external providers have been verified in a real environment, because none has.

Read `PROJECT_CONTEXT.md` for what the system is, `RESUME.md` for how to continue, and the documents listed in section 8 for detail.

## 1. State

| Item                                | State (evidence)                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code                                | 96 migrations, 132 application services, 63 route files, 138 web `.tsx` files, 144 API test files, 76 web test files, 12 Playwright spec files (22 journeys).                                          |
| Local verification of `2652a64`     | `pnpm verify` exit 0 on a throwaway PostgreSQL 16.15 (API 135 files, 1909 passed, 4 skipped; web 71 files, 829 passed); Playwright 22 of 22 twice. Run on 2026-10-26 on Node 22.15.1 and pnpm 10.28.0. |
| GitHub, `deploy-smoke` on `2652a64` | Passed (run 40366991677): both images build, the compose stack and the review-port job (demo seed, three registration modes) pass on a disposable runner.                                              |
| GitHub, `ci` on `2652a64`           | Run 40366991696: **attempt 1 failed** in the Playwright step; **attempt 2 passed** (reported by the owner, 16m 5s). The failing test of attempt 1 is **unknown**.                                      |
| Deployment                          | None. No staging or production host exists.                                                                                                                                                            |
| Production readiness                | **No.** See `docs/production-readiness-audit.md`.                                                                                                                                                      |

### Merged pull requests

#1 deployment smoke (M1), #2 depreciation methods (R-11), #3 browser reversals (R-05), #4 browser refund sources (R-05), #5 UI redesign, #6 `zod` audit fix, #7 AI assistant and tutorial centre, #8 post-merge handover docs, #9 registration access control, #10 guarded demo-data seed, #11 review database port and `review-port` CI job, #12 demo-seed production refusal and registration gate in the stack, #13 refund-link layout-shift fix. The pull request that adds this handover is the next one.

## 2. What is built

See `docs/feature-completion-matrix.md`: 19 areas, all `Built` or `Built, partial`; specification coverage 53 of 84 rows DONE, 15 PARTIAL, 5 NOT DONE, 5 NEEDS DECISION, 3 BLOCKED, 3 DEFERRED (audit of 2026-10-19, updated for later work in the matrix). No area has been verified with real external providers.

## 3. Production blockers

**P0 (nothing goes live until these are settled):**

1. No real deployment: TLS, HSTS, a real host name, a load balancer, a real SMTP provider and S3 bucket are unverified (`docs/operations.md` sections 7 and 9).
2. Backups are unencrypted `pg_dump` files with no scheduler and no off-site copy (`deploy/backup.sh`).
3. Restore has been drilled only on development data (2026-10-19, 1 GB) and a small fresh database; no production volume, no measured time to recover.
4. Rollback is a restore of the pre-upgrade backup: migrations are forward-only.
5. The encryption keys (`MFA_ENCRYPTION_KEYS`, `WEBHOOK_ENCRYPTION_KEYS`) have no tested backup or rotation drill.

**P1:** no error reporting or alerting; the unexplained Playwright failures (below); S3 and SMTP verified only against fakes; nine known production-dependency advisories (below); no container-image scan, dependency bot or code scanning, no penetration test or external audit; no HSTS or Content-Security-Policy for the web app; a single API instance with local file storage.

Full list with severity, evidence and actions: `docs/production-readiness-audit.md`.

## 4. Unexplained Playwright failures

- `ci` run 40366991696, attempt 1 (2026-10-26, on `2652a64`): failed in step "Browser end-to-end smoke tests (Playwright)", all earlier steps passed. Artifact `playwright-failure-40366991696-1` (84,160 bytes) expires **2026-11-02**. The failing test, assertion and values were **not obtained** (GitHub sign-in needed); attempt 2 passing does not explain it.
- `accounting.spec.ts:11` failed once in `ci` run 40279914371; it did not reproduce in 15 local runs and has no refund link.
- Earlier, also unexplained: runs #15 and #16, the `reversals.spec.ts` "Posted" failure (run 39565353761), and a reported `restricted-user.spec.ts:32` failure (run #21).
- The refund-link layout shift (the "Refund date" field never appeared because a click landed on the card) **was reproduced and fixed** in PR #13 (commit `acaa571`). Do not generalize that fix to the others.

Details and how to diagnose: `docs/known-flaky-tests.md`.

## 5. Dependency advisories

`pnpm audit --prod --audit-level high` exits 0 but reports **9 advisories (5 low, 4 moderate)** on 2026-10-26: `fast-uri` (several, through `fastify` and `@fastify/ajv-compiler`; patched in 3.1.9 and 4.2.3) and a low `fastify` header-validation advisory (patched in 5.12.6). None is high. Not fixed in this handover. Table: `docs/production-readiness-audit.md`.

## 6. Owner decisions waiting

19 Tier 2 items (compound taxes, impairment and write-off, approval for exports, named role templates, custom fields, tax defaults, cash-basis balance sheet, group consolidation, clinical records and scheduling, FIFO and lot costing, payslip e-mail, projects scope, the delivery stage, and the ADR 0015 defaults) and 7 Tier 3 items that need outside input (MIRA, statutory payroll, real providers, portal sign-in, Dhivehi). Source: `docs/remaining-scope.md`. Infrastructure decisions needed for go-live: host, domain, TLS, SMTP, backup storage, error reporting.

## 7. Local machine notes (2026-10-27)

- Primary checkout `C:\Users\hanza\Documents\intuit-2.0` is on `feat/ui-redesign` (`d7d2547`), 5 commits behind its remote, with one untracked file `e2e/refund-sources.spec.ts` that equals the version in `main`. It was deliberately left untouched.
- Other worktrees next to it (`git worktree list`): `-assistant`, `-demo-seed`, `-handover`, `-hardening`, `-r05`, `-review-port`, `-sprint`, `-stage1`, `-stage2`, `-ui-update`, `-zod`, and this handover's `-final`. The branch of every one of them (except `-final`, this work) was checked on 2026-10-26 and is already contained in `origin/main`; they can be removed with `git worktree remove` when no longer needed. None was removed in this work.
- No throwaway PostgreSQL cluster is left running. The standard PostgreSQL service on port 5432 was never used by tests.

## 8. Document index

`docs/README.md` lists every document with its purpose and last-reviewed date. The ones to read first: `docs/production-readiness-audit.md`, `docs/feature-completion-matrix.md`, `docs/remaining-scope.md`, `docs/known-flaky-tests.md`, `docs/operations.md`, `docs/database.md`, `docs/testing.md`, `docs/environment.md`, `docs/architecture.md`, `docs/security.md`, `docs/decisions/`.

## 9. How to resume

`RESUME.md`. In short: re-read `origin/main` and the CI state, diagnose the unexplained Playwright failure from its artifact, then take the production blockers and the owner decisions in order. Prompt for a new AI session: `docs/handover/AI_CONTINUATION_PROMPT.md`.

## 10. Honest limits of this handover

The feature matrix reconciles dated audits with file counts; it is not a new line-by-line audit. The production audit read documents, scripts and migrations and ran the test commands; it did not deploy anything, scan images, penetrate the system or read GitHub logs. Where evidence was missing this document says so.
