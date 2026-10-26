# Documentation index

Index of the documentation set at `origin/main` `2652a64` (reviewed 2026-10-27). Start with `../PROJECT_CONTEXT.md`, `../FINAL_HANDOVER.md` and `../RESUME.md`. **Status words:** `current` (checked against the code on 2026-10-26/27), `dated` (accurate when written; the date is inside the file; re-check before relying on it), `frozen` (an approved specification or record; changes only through a new decision), `generated` (rebuild from the code).

## Handover and state

| Document                             | Purpose                                                                                   | Status                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `../PROJECT_CONTEXT.md`              | What the system is, its rules and layout                                                  | current                                             |
| `../RESUME.md`                       | How to continue development                                                               | current                                             |
| `../FINAL_HANDOVER.md`               | State, blockers, unexplained failures, owner decisions                                    | dated 2026-10-27                                    |
| `handover/AI_CONTINUATION_PROMPT.md` | Prompt for starting an AI session                                                         | current                                             |
| `HANDOVER.md`                        | Earlier handover; section 0 is a dated snapshot of 2026-10-25, sections 1 to 11 are older | dated; superseded where `FINAL_HANDOVER.md` differs |
| `production-readiness-audit.md`      | P0 to P3 findings, verified versus unknown                                                | dated 2026-10-27                                    |
| `feature-completion-matrix.md`       | Area-level completion with evidence counts                                                | dated 2026-10-27                                    |

## Scope and requirements

| Document                                              | Purpose                                                              | Status                    |
| ----------------------------------------------------- | -------------------------------------------------------------------- | ------------------------- |
| `master-spec-coverage.md`                             | The master specification's bullets, status per requirement (84 rows) | dated 2026-10-19          |
| `remaining-scope.md`                                  | Prioritized remaining work and owner decisions (Tiers 1 to 5)        | dated 2026-10-20          |
| `requirements-matrix.md`                              | Finishing-plan (FP-nn) status list                                   | dated                     |
| `open-decisions.md`, `open-points.md`                 | Decisions needed from the owner; recorded product decisions          | dated                     |
| `known-limitations.md`                                | Honest list of what is limited or missing                            | dated, updated 2026-10-26 |
| `decisions/0001` to `0015`                            | Architecture decision records, one per phase or module               | frozen                    |
| `phase-3-brief.md`, `phase-3a-implementation-plan.md` | Approved Phase 3 and 3A specifications                               | frozen                    |
| `integration-plan.md`                                 | Claims on shared resources by work stream                            | dated                     |

## Architecture and engineering

| Document                                                              | Purpose                                                                                                                                                                   | Status                                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `architecture.md`                                                     | Request flow, principles, outbox, accounting overview                                                                                                                     | current in structure; its phase-status list is dated                                                                                                 |
| `module-boundaries.md`                                                | Module ownership rules                                                                                                                                                    | current                                                                                                                                              |
| `database.md`                                                         | Roles, migrations, row-level security, integrity triggers                                                                                                                 | current                                                                                                                                              |
| `api.md`, `openapi-compatibility.md`, `openapi/public-v1.json`        | API conventions, the Public API contract and its compatibility check                                                                                                      | current; the JSON is generated                                                                                                                       |
| `security.md`, `security-review.md`                                   | Security design; internal review of 2026-10-17 with addenda                                                                                                               | `security.md` current; the review is dated and says "no known vulnerabilities" for 2026-10-17, which is no longer true (see its 2026-10-27 addendum) |
| `environment.md`                                                      | Every environment variable, generated from the config schema                                                                                                              | generated 2026-10-27                                                                                                                                 |
| `design/*.md`                                                         | Per-feature designs (clinic, payroll, projects, localization, tax, payment gateway, branches and legal entities, advanced inventory, cash-basis reports, customer portal) | dated; each file states its status                                                                                                                   |
| `pdf-evaluation.md`, `qr-library-evaluation.md`, `xlsx-evaluation.md` | Library evaluations behind decisions                                                                                                                                      | frozen                                                                                                                                               |

## Operating and testing

| Document               | Purpose                                                                                                      | Status                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `development.md`       | Local development, tools, scripts                                                                            | current                                                 |
| `testing.md`           | Test commands, results, the throwaway-database procedure, CI                                                 | current 2026-10-27                                      |
| `operations.md`        | Deployment, configuration, backup and restore, monitoring, release; its section 9 lists what is NOT verified | dated; the demo-seed and registration parts are current |
| `known-flaky-tests.md` | Test failures, causes, fixes, and the unexplained ones                                                       | dated; updated 2026-10-26 and 2026-10-27                |

## Feature guides

| Document                                                  | Purpose                                                                         | Status  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | ------- |
| `assistant.md`, `assistant-user-guide.md`, `tutorials.md` | The help assistant and tutorial centre (developer guide, user guide, catalogue) | current |

## Reconciliation notes (2026-10-27)

- Where a dated document and the code disagree, the code and tests win. The disagreements found while writing this index: `security-review.md` predates today's nine production advisories; `HANDOVER.md` section 0 describes `b5ce5ef`, not `2652a64`; `operations.md` section 9 mentions CI runs that are older than the current ones.
- None of the dated documents was rewritten wholesale: each keeps its original text, with dated addenda where a fact changed. A future clean-up could fold the addenda into the bodies.
- The master specification PDF is not in the repository; `master-spec-coverage.md` is the only record of its bullets here.
