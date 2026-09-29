# Phase 3A Implementation Plan (Foundations)

- **Status:** APPROVED specification; S1–S10 implemented and verified; Checkpoint 3A (S11) is the release gate and single local commit.
- **Authority:** Decisions 1–92, S3-01–S3-24, S4-01–S4-22, K-1–K-7, S5-01–S5-22, L-1–L-12, S6-01–S6-46, S7-01–S7-46, S8-01–S8-23, the S9 decisions (with amendments N1–N9), S10-01–S10-12, C1–C3 and D1–D16 ([ADR 0003](decisions/0003-phase-3-sales-receivables.md)), [ADR 0002 Amendment 1](decisions/0002-phase-2-accounting.md#amendment-1-phase-3--fx-journal-architecture-and-related-changes), [brief v2.1](phase-3-brief.md).
- **Baseline:** commit `644cf09` (143 API tests, 16 web tests).
- **Staging (Decision 19):** internal checkpoints after S1, S3, S6, S7 and S10 run the full suite. **There are no commits until Checkpoint 3A**, which ends with **one local commit**. Phase 3B isn't started in this plan.

## 1. Stages

| Stage                                  | Register step | Decisions                                                   | Deliverables                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S1 Accounting core**                 | 2–7           | 1, 2, 10, 11, 12, 14, 26, 53, 54, 64, 70, 71, 79–83, C1, C3 | ISO currency reference table; account `currency_code` (immutable after the first non-draft line), subtype (Decision 53 catalog; existing accounts unclassified), bank/cash = Bank/Cash subtype, `is_control_account`; designation map and template accounts 3200/3900/4950/4960/5950; `normal`/`base_only` line model and replaced DB guards; source references; transaction-aware intake; control accounts rejected in manual journals; base-currency change rule |
| **S2 Dimensions**                      | 8             | 3, 16, 55, 67, 78, 84–92                                    | Types (required flag), values, line assignments (one per type, immutable after posting), journal editor support, filtering. Required enforcement per **Decisions 78, 84–91**: account-classification scope per required type (empty = not enforced; no per-account rules in 3A); manual journals line-level only; validated at submission and again at posting (authoritative); no guessing. System journals follow their originating module rules.                |
| **S3 Financial statements**            | 9             | 4, 18, 65, S3-01–S3-24                                      | TB, P&L, BS; virtual year-end; filters; currency-aware view; drill-down; CSV export via S6 once available                                                                                                                                                                                                                                                                                                                                                          |
| **S4 Org legal profile, Party master** | 10–11         | 8, 17, 28, 65, S4-01–S4-22                                  | `organizations` profile; `parties` module (roles, contacts, addresses, TIN)                                                                                                                                                                                                                                                                                                                                                                                        |
| **S5 File storage, Job runner**        | 12–13         | 6, 20, 29, 61, 65, 75, 76, K-1–K-7, S5-01–S5-22             | `files` (service, provider interface, local provider, signed tokens, purge), `jobs` (runner, registry)                                                                                                                                                                                                                                                                                                                                                             |
| **S6 Import/export**                   | 14            | 7, 24, 61, 65, 75, L-1–L-12, S6-01–S6-46                    | `data-exchange` (batches, rows, in-house CSV, mapping, preview 500 rows); COA, parties, party contacts, dimension values, exchange rates and draft journal imports; COA, parties, dimension values, journals/GL and TB/P&L/BS CSV exports; XLSX evaluation                                                                                                                                                                                                         |
| **S7 MFA**                             | 15            | 5, 25, 49, 57, 72, 74, 76, S7-01–S7-46                      | TOTP, recovery codes, MFA-pending sessions, enforcement, organization policy (incl. remembered devices), trusted devices, step-up, admin reset (not the Owner; S7-37 cross-tenant rule), enrollment with QR (`qrcode-generator`, Decision 62 verified)                                                                                                                                                                                                             |
| **S8 Opening balances**                | 16            | 27, 68, 69, 73, 14, S8-01–S8-23                             | Conversion date; one journal per currency in one batch, balanced to OBE; no AR or control lines; re-auth; optional approval (no READY state); batch-level reversal; S6 import/export and S5 attachments                                                                                                                                                                                                                                                            |
| **S9 Revaluation support**             | 17            | 9, 11, 53, 71, S9 (N1–N9)                                   | Calculation engine, exposure model and provider interface; run, line and run-journal tables; base-only revaluation journal per currency with the D + 1 reversal; cancellation; development trigger. No UI or user API (Phase 4).                                                                                                                                                                                                                                   |
| **S10 Conditional approvals**          | 18            | 22, 56, 77, S10-01–S10-12                                   | Step conditions (base-currency amount bands, transaction types); server-derived facts; snapshot of matching steps; no match = direct action; posting-time re-check; request immutability                                                                                                                                                                                                                                                                           |
| **S11 Regression and Checkpoint 3A**   | 19            | 19                                                          | Full verification, then one local commit                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 2. Dependency order

- **S1 first.** Currency, subtypes, designations and the FX line model with the new guard underpin every later stage.
- **S2 → S1.** Assignments attach to lines.
- **S3 → S1 + S2.** Needs the Retained Earnings designation, account currency and dimension filters.
- **S5 storage core before the S4 logo.** The register order is kept otherwise.
- **S6 → S5 + S4.**
- **S8 → S1 + S6.**
- **S9 → S1.**
- **S10 → the Phase 2 approvals engine.**
- **S7** is independent and is ordered per the register.

## 3. Affected modules and files

- **API, extended:**
  - `modules/accounting/`: schema, accounts, journals, rules, setup, ledger, index; new designations, dimensions, currencies, revaluation and statements files;
  - `domain/money.ts`: validation against the reference table;
  - `application/journal-service.ts`: system-journal path, C1, currency/control rules, dimensions;
  - `application/accounting-service.ts`;
  - `application/approval-service.ts` and `modules/approvals/`: step conditions;
  - `modules/identity/`: MFA;
  - `modules/organizations/`: profile;
  - `api/http/session.ts`: MFA-pending state;
  - `app.ts`, `server.ts`: job runner and storage;
  - `infrastructure/config`;
  - `infrastructure/security`: TOTP and AES-256-GCM on `node:crypto`.
- **API, new:** `modules/parties`, `modules/files`, `modules/jobs`, `modules/data-exchange`, `modules/reports`; routes under `api/v1/`.
- **Database:** migrations `0004`–`0018` (no `0019`, S10-12); `seed.ts` (currencies, templates with subtypes and designation accounts, permissions).
- **Web:**
  - account form (currency, subtype), designations, dimensions and journal-editor dimension pickers;
  - statements with drill-down, opening balances;
  - organization profile, parties, file upload (binary), import wizard, export actions;
  - MFA enrollment/verify/recovery/trusted devices, organization security settings;
  - approval-policy condition editor.
  - **Broad i18n is Phase 3B** (Decision 74); new 3A strings are written in a way that is ready for extraction.
- **Docs:** architecture, security, API and development docs updated at Checkpoint 3A.

## 4. Database and migration plan

All migrations are additive. Each includes RLS, composite tenant foreign keys and least-privilege grants. No posted row is ever updated.

| Migration                                 | Contents                                                                                                                                                                                                                                                                                                                                      | Existing data                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `0004_accounting_currency_classification` | `accounting_currencies` reference table (code, minor units, active), seeded from the ISO list; `accounting_accounts.currency_code` (FK), `subtype` (Decision 53; NULL = unclassified), `is_control_account`; subtype↔nature check; trigger making currency immutable after any non-draft line (Decision 70); template accounts gain `subtype` | Currency backfilled to base; subtype stays NULL (Decision 54)                 |
| `0005_accounting_designations`            | Designations per organization (Retained Earnings, Realized FX, Unrealized FX, Rounding, Opening Balance Equity)                                                                                                                                                                                                                               | Organizations start undesignated                                              |
| `0006_journal_fx_lines_source_refs`       | Line `line_kind` (`normal`/`base_only`); journal `source_module`/`source_type`/`source_id`; **replaced guard functions** (§6.1); account-currency rule trigger with the Decision 71 exception                                                                                                                                                 | Existing lines become `normal`; posted journals keep NULL sources             |
| `0007_dimensions`                         | Dimension types (`is_required`), values, line assignments (unique per line and type; immutable once posted)                                                                                                                                                                                                                                   | —                                                                             |
| `0008_dimension_permission_backfill`      | Additive, audited backfill of `accounting.dimensions.view`/`manage` for existing organizations: Administrator both, Member view, Owner both (granted by the migration itself); custom roles untouched (Decision 90)                                                                                                                           | Existing organizations                                                        |
| `0009_reports_permission_backfill`        | Additive, audited backfill of `accounting.reports.view` for Owner, Administrator and Member of existing organizations (S3-01, S3-02, Decision 90)                                                                                                                                                                                             | Existing organizations                                                        |
| `0010_organization_profile`               | Organization profiles (legal name, address, TIN, GST registration, logo file id, contacts, identifiers jsonb)                                                                                                                                                                                                                                 | Empty                                                                         |
| `0011_parties`                            | Parties, party roles, contacts, addresses                                                                                                                                                                                                                                                                                                     | —                                                                             |
| `0012_files`                              | File metadata (storage key, name, detected MIME, size ≤ 25 MB, sha256, status, legal_hold, deleted_at, purge_after) and file links                                                                                                                                                                                                            | —                                                                             |
| `0013_jobs`                               | Jobs (type, payload, status, attempts ≤ 5, run_after, locks, progress, result, error, job key unique per organization + type)                                                                                                                                                                                                                 | —                                                                             |
| `0014_data_exchange`                      | Import batches (type, status, file, mapping, summary) and import rows (≤ 25,000 per batch)                                                                                                                                                                                                                                                    | —                                                                             |
| `0015_mfa`                                | MFA factors (`totp` now, `webauthn` later; encrypted secret, key id), recovery codes (hash, used_at), trusted devices (hashed token, 30-day expiry, revoked); `sessions` MFA state columns; organization security policy (require MFA for all members)                                                                                        | Existing sessions not MFA-verified; privileged users enforced at next sign-in |
| `0016_opening_balances`                   | `accounting_settings.conversion_date`; opening batch ↔ per-currency journal links                                                                                                                                                                                                                                                             | —                                                                             |
| `0017_revaluation_support`                | Revaluation runs, lines and run-journal links; S8-07 opening-line guard; Decision 53 N9 monetary CHECK                                                                                                                                                                                                                                        | —                                                                             |
| `0018_approval_conditions`                | Step conditions (`min_base_amount`, `max_base_amount`, `transaction_types`, `threshold_currency`); approval-request immutability guard                                                                                                                                                                                                        | Existing steps unconditional                                                  |
| `0019_phase3a_permission_backfill`        | **Not created (S10-12):** nothing remains to backfill; every Phase 3A key was backfilled by 0008, 0009 and 0011                                                                                                                                                                                                                               | Custom roles untouched                                                        |

Idempotency-key storage for Sales consumers is **Phase 3B** (Decision 74). The job table's own job key covers job idempotency (Decision 20).

## 5. API and domain-service plan

- **Accounting:**
  - account create/update accept `currencyCode` and `subtype`;
  - `GET/PUT /accounting/designations` (`accounting.setup`, audited);
  - `/accounting/dimensions` types and values (`accounting.dimensions.manage`);
  - journal lines accept `dimensions` (one per type, organization-owned active values; required enforcement per Decisions 78, 84–89; view/select per Decision 91; `accounting.dimensions.view`/`manage`);
  - `JournalService.receiveEventInTransaction` (C1) and `postSystemJournal` (approved handler keys only).
- **Reports** (`accounting.reports.view`):
  - `GET /accounting/reports/trial-balance|profit-and-loss|balance-sheet` with `asOf`/`from`/`to`/`periodId`, dimension filters and a currency view;
  - returns base amounts plus account-currency balances for foreign accounts, opening and closing balances, computed Retained Earnings and Current-Year Earnings, and a `taggedActivityOnly` flag;
  - drill-down through the ledger, journal detail and source reference;
  - `409 DESIGNATION_REQUIRED` when Retained Earnings isn't designated.
- **Opening balances** (`accounting.setup` + **re-auth**):
  - preview/dry-run and confirm through an import batch;
  - one journal per currency;
  - AR control lines rejected;
  - optional approval as a registered action.
- **Organization profile:** `GET/PUT /organizations/current/profile` (`organization.update`).
- **Parties:** `/parties` CRUD and archive, roles, contacts, addresses (`parties.view/create/update/archive`).
- **Files:**
  - `POST /files`: raw `application/octet-stream` upload, which forces a CORS preflight and needs no multipart dependency;
  - `GET /files/:id/download-url`: 5-minute signed token bound to user, organization and file;
  - `GET /files/content?token=`;
  - `DELETE /files/:id`: soft delete, blocked under legal hold;
  - access inherits the linked record's permission.
- **Import/export:**
  - `POST /imports` (upload → validate → preview up to 500 rows), `PUT /imports/:id/mapping`, `POST /imports/:id/confirm`, `GET /imports/:id`;
  - `POST /exports` runs a job that produces a file;
  - imports need the target's create permission, exports its view permission (Decision 65).
- **MFA:**
  - `/auth/mfa/totp/enroll|verify|disable`, `/auth/mfa/recovery-codes`, `/auth/mfa/challenge`, `/auth/trusted-devices`;
  - `/organizations/current/security` (`members.manage` + re-auth);
  - `/organizations/current/members/:id/mfa-reset` (`members.manage` + re-auth; the Owner can't be reset).
- **Approvals:** step `conditions: { minBaseAmount, maxBaseAmount, transactionTypes }`; each action supplies `getFacts()` (base-currency equivalent at the document rate, transaction type).
- **Jobs:** `GET /jobs/:id` status and progress, for the creator or an authorized user.

## 6. Security, permission, jobs, storage and import/export controls

### 6.1 FX journal guard (Decision 10, ADR 0002 A1.1/A1.7)

- **Line kinds:** `normal` lines keep the Phase 2 rules. `base_only` lines have NULL transaction amounts and exactly one positive base side.
- **Manual journals:** the engine, API schemas, imports and the DB guard all reject `base_only` lines and explicit base amounts.
- **System journals:** go through `postSystemJournal`, with the approved `source_type` allowlist (realized FX, revaluation, revaluation reversal; opening balances as a normal system journal).
- **Guard on POSTED:**
  - at least two lines;
  - base debits = base credits across all lines;
  - transaction debits = transaction credits across `normal` lines;
  - `base_only` lines only on approved source types;
  - open period;
  - Phase 2 immutability unchanged.
- **Account-currency trigger:** journal or base currency, except approved `base_only` lines on foreign monetary accounts (Decision 71).

### 6.2 Permissions (Decision 65, complete)

- **New keys:** `accounting.reports.view`, `accounting.dimensions.manage`, `parties.view`, `parties.create`, `parties.update`, `parties.archive`.
- **Reused keys:**
  - `accounting.setup`: designations, opening balances, conversion date;
  - `organization.update`: profile;
  - `members.manage` + re-auth: MFA policy, admin MFA reset.
- **Files:** linked record's permission.
- **Import/export:** target's create/view permission.
- **Backfill:**
  - Administrator: all new keys;
  - Member: `accounting.reports.view`, `parties.view`;
  - Owner: all via sync;
  - custom roles never overwritten; audited.

### 6.3 MFA (Decisions 5, 25, 57, 72, 76)

- **Enforcement:**
  - the Owner and holders of `roles.manage`, `members.manage`, `approvals.manage`, `accounting.setup` or `sales.settings.manage`;
  - plus the organization toggle;
  - evaluated for the active organization on each request and on organization switch;
  - MFA-pending sessions can reach only the MFA and sign-out endpoints.
- **TOTP:** RFC 6238 on `node:crypto`, 30 s step with ±1 window; attempts throttled by the existing login protection.
- **Recovery codes:** 10 codes, Argon2id-hashed, single-use.
- **Secrets:** AES-256-GCM with the keyed `MFA_ENCRYPTION_KEYS` set (active key id, rotation).
- **Trusted devices:** 30 days, hashed cookie token, revocable, invalidated by password reset.
- **Admin reset:** not available for the Owner.

### 6.4 Files, jobs, import/export (Decisions 6, 20, 24, 29, 61, 75, 76)

- **Files:**
  - magic-byte detection plus the allowlist PDF/PNG/JPEG/JPG/WebP/CSV/XLSX, 25 MB;
  - tenant-prefixed storage keys;
  - `Content-Disposition: attachment` and `nosniff`;
  - legal hold;
  - `files.purge` job after 90 days;
  - scanning hook interface;
  - local provider under git-ignored `.data/storage`;
  - S3 adapter after Decision 62 approval.
- **Jobs:**
  - `FOR UPDATE SKIP LOCKED`, tenant RLS context per job, handler registry;
  - 5 attempts with 5 s → 15 min backoff, then dead letter;
  - progress, job keys, audit on failure;
  - first handlers `import.validate`, `import.commit`, `export.generate`, `files.purge`.
- **Import/export:**
  - in-house RFC 4180 CSV with BOM output;
  - 25 MB import file, 25,000 rows, 500-row preview;
  - formula-injection neutralization;
  - malformed-file handling, transactional commit, batch audit;
  - XLSX after Decision 62 approval.

### 6.5 Audit

Designations, dimensions, profile, parties, files, imports, MFA, security policy and approval conditions are all audited. Personal data is kept out of logs. RLS and tenant keys cover every new table.

## 7. Test and verification plan

- **Regression:** the 143 API + 16 web tests run unchanged at every internal checkpoint.
- **New integration tests (real PostgreSQL):**
  - **Currency:** posting-rule matrix, including the Decision 71 exception; currency immutability after a non-draft line; base-currency change before and after the first posting.
  - **Classification:** subtype/nature rules; existing accounts unclassified.
  - **Designations:** required and audited.
  - **FX guard:** balanced/unbalanced base; transaction balance; `base_only` rejected from manual/API/import; forged SQL as the application role.
  - **Journal plumbing:** source references immutable; C1 atomic rollback; control accounts rejected in manual journals.
  - **Dimensions:** one per type; immutable after posting; cross-tenant; Decisions 78, 84–91 enforcement (in-scope/out-of-scope/empty scope; submit and post; requirement changed after submission).
  - **Statements:** TB balances; BS balances with computed earnings; P&L per fiscal year; dimension filters and tagged flag; drill-down including legacy NULL-source journals.
  - **Profile and parties.**
  - **Files:** isolation; allowlist including WebP; magic-byte spoofing; 25 MB limit; signed-token expiry and tampering; soft delete; purge; legal hold.
  - **Jobs:** concurrency, retry and backoff, dead letter, tenant context.
  - **Import/export:** 25 MB and 25,000-row limits; 500-row preview; dry-run; mapping; conflicts; formula injection; transactional rollback.
  - **Opening balances:** per-currency journals in one batch; AR control rejected; re-auth; approval.
  - **MFA:** enroll/verify/throttle; recovery single-use; pending sessions; enforcement for privileged users and organization policy across organizations; trusted devices; admin reset refused for the Owner; encrypted secrets.
  - **Revaluation:** engine calculations, journals and reversal.
  - **Conditional approvals:** base-currency thresholds, transaction type, no-match direct.
  - **Permission backfill.**
- **Unit tests:** TOTP RFC 6238 vectors; AES-GCM rotation; CSV reader/writer; magic bytes; revaluation math; condition evaluation.
- **Web tests:** account form; designations; statements; MFA flows; import wizard; permission-aware rendering.
- **Checkpoint 3A:**
  - format, lint, typecheck, all tests, build;
  - `pnpm audit`, secret scan, migration re-run;
  - browser end-to-end pass;
  - then **one local commit**.

## 8. Risks

1. **Guard replacement (S1).** Mitigated by the unchanged Phase 2 immutability suite plus bypass tests.
2. **Scope size.** Mitigated by internal checkpoints.
3. **Decision 62 approvals** gate the QR display, XLSX and the S3 adapter.
4. **Existing dev data:** currency backfill and unclassified accounts. No posted data is touched.
5. **MFA rollout** requires privileged dev users to enroll at next sign-in (the seed and docs will cover it).
6. **Report performance** is acceptable now; snapshots are deferred (R29).

## 9. Progress log

### S1–S2 internal checkpoint (2026-09-28)

- S1–S2 implementation is audited and currently clean.
- Decisions 79–92 are reconciled and verified.
- API tests 205/205; web tests 24/24.
- Format, lint, typecheck and build pass.
- Migrations 0001–0008 are contiguous and up to date.
- RLS, security and tenant-isolation checks pass.
- No S3 implementation exists.
- No secrets or temporary artifacts found.
- No commit has been made and nothing has been pushed; the single Phase 3A commit remains at Checkpoint 3A / S11 (Decision 19).

### S3 and S4 (2026-09-28)

- S3 financial statements (S3-01–S3-24, migration 0009) and S4 organization legal profile and Party master (S4-01–S4-22, migrations 0010–0011) implemented, verified and accepted. After S4: API tests 253/253, web tests 36/36.

### S5 File storage and background job runner (2026-09-28)

- Implemented per K-1–K-7 and S5-01–S5-22 (recorded in ADR 0003): `files` and `jobs` modules, attachment-target registry (organization logo, party, journal), local storage provider, signed download links, soft delete with 90-day retention and system-managed legal hold, PostgreSQL job runner with idempotent enqueue, retries, stale-lock recovery and dead letter, hourly `files.purge` scheduler, `GET /jobs/:id`, `FileUpload`, `AttachmentsCard`, company logo and `useJob`.
- Migrations 0012 (files, file links, profile logo, purge discovery) and 0013 (jobs, claim function) applied; 0001–0013 contiguous and up to date.
- No new permission keys, no new dependencies, nothing from S6–S10.
- API tests 306/306 (three consecutive full runs); web tests 51/51.
- Format, lint, typecheck, build and dependency audit pass.
- Browser E2E passed: party and journal attachments (upload, list, download, removal rules), organization logo (upload, replace, remove), view-only Member UI with server-side 403s, and a real `files.purge` run by the in-process worker. No JavaScript or server errors on the final build.
- Test harness: the S2 Decision 90 backfill test now retries its transaction when PostgreSQL reports a deadlock (40P01) against parallel test files; test code only.
- No commit has been made and nothing has been pushed; the single Phase 3A commit remains at Checkpoint 3A / S11 (Decision 19).

### S6 Import and export (2026-09-28)

- Implemented per L-1–L-12 and S6-01–S6-46 (recorded in ADR 0003, with the three approval corrections):
  - the `data-exchange` module: batches, staged rows, saved mappings, exports, the streaming CSV reader/writer and formula neutralization;
  - six import domains and nine export domains;
  - the `import.validate`, `import.commit`, `export.generate` and `data_exchange.cleanup` jobs, with the acting-user context;
  - the `DISCARDED` workflow for never-submitted imported drafts;
  - the import wizard, history, the Exports page and export actions;
  - the [XLSX evaluation](xlsx-evaluation.md) (no library approved).
- Migration 0014 applied; 0001–0014 contiguous and up to date.
- No new permission keys, no new dependencies, no XLSX, nothing from S7–S10 or Phase 3B.
- S1–S4 services gained in-transaction variants (L-7); their HTTP behaviour is unchanged.
- Test harness: job-worker and backfill-replay test files run in a serial Vitest project.
- No commit has been made and nothing has been pushed; the single Phase 3A commit remains at Checkpoint 3A / S11 (Decision 19).

### S7 Multi-factor authentication (2026-09-28)

- Implemented per S7-01–S7-46 and the S7 rulings (recorded in ADR 0003, including the S7-37 amendment to Decision 72):
  - TOTP and base32 on `node:crypto`;
  - the AES-256-GCM key ring with a rotation command;
  - Argon2id recovery codes;
  - MFA-pending sessions (default-deny) and the sign-in challenge;
  - remembered devices (rotation, reuse detection, 30-day cap);
  - step-up for MFA management and security actions;
  - organization policy (require for all, allow remembered devices);
  - Decision 57a privileged enforcement per request and for background jobs;
  - admin reset through a definer function with the Owner, self and cross-tenant refusals;
  - security events and email notices;
  - QR rendering with `qrcode-generator` 2.0.4 ([evaluation](qr-library-evaluation.md));
  - Account security, organization Security, and the Members MFA column and reset.
- Migration 0015 applied; 0001–0015 contiguous and up to date.
- No new permission keys. One new dependency, the approved `qrcode-generator` (exact pin). No WebAuthn, SMS, email OTP, SSO, or anything from S8–S10 or Phase 3B.
- The dev seed enrolls the Owner and Administrator with `DEV_SEED_TOTP_SECRET`.
- No commit has been made and nothing has been pushed; the single Phase 3A commit remains at Checkpoint 3A / S11 (Decision 19).

### S8 Opening balances (2026-09-29)

- Implemented per S8-01–S8-23 (recorded in ADR 0003, including the no-`READY` clarification):
  - the conversion date (opening date = conversion date − 1), set with `accounting.setup` and re-authentication;
  - one opening batch at a time, with states `DRAFT`, `PENDING_APPROVAL`, `POSTED` and `REVERSED`;
  - the entry grid with currency tabs, explicit carrying values and line dimensions;
  - preview of one journal per currency balanced to the OBE designation, with the S8-04 to S8-09 and S8-19 rules;
  - optional approval (`accounting.opening_balance.post`, approver `accounting.journals.approve`, no self-approval);
  - re-authenticated posting through `postSystemJournal` in one transaction;
  - batch-level reversal (generic reversal of an opening journal is refused);
  - S6 import into the draft and export; S5 attachments while `DRAFT`; audit events.
- Migration 0016 applied; 0001–0016 contiguous and up to date.
- No new permission keys and no new dependencies.
- Decision 80's S2 test now expects `SYSTEM_JOURNAL` for `opening_balance` journals (S8-14).
- S8 accepted 2026-09-29 with a final S8-07 ruling: accounts without an explicit subtype are rejected from opening balances, and no classification is inferred (ADR 0003). Enforced with S9 (N1).
- Test harness: the opening-balance integration file runs in the serial Vitest project.
- No commit has been made and nothing has been pushed; the single Phase 3A commit remains at Checkpoint 3A / S11 (Decision 19).

### S9 Foreign currency revaluation support (2026-09-29)

- Implemented per the frozen S9 architecture and amendments N1–N9 (recorded in ADR 0003):
  - S8-07 enforcement: unclassified accounts rejected from opening balances (line rules, grid, DB trigger);
  - Decision 53 amendment: Other Current Asset and Other Asset accounts may be marked monetary explicitly;
  - the pure calculation (A = round(F × rate) − B) and journal plan, the GL exposure query and the read-only document provider registry;
  - `RevaluationService`: preview, post (one base-only revaluation journal per currency on D, its mirrored reversal on D + 1, links, audit) and cancel, all atomic;
  - `JournalService.reverseRevaluationJournalInTransaction`, the dedicated reversal path (generic reversal still refuses these journals);
  - the development/testing trigger `revaluation:dev-run`.
- Migration 0017 applied; 0001–0017 contiguous and up to date.
- No new permission keys and no new dependencies. No HTTP routes or UI (Phase 4).
- No commit has been made and nothing has been pushed; the single Phase 3A commit remains at Checkpoint 3A / S11 (Decision 19).

### S10 Conditional approvals (2026-09-29)

- Implemented per S10-01–S10-12 and the final amendments (recorded in ADR 0003):
  - step conditions (half-open base-currency bands, transaction types) with strict validation;
  - server-derived facts per action: journal posting (`manual`, `imported`, `accounting_event`), opening balances (the canonical S8 amount, OBE never double-counted) and period reopening (`period_reopen`, no amount);
  - snapshots of matching steps with the facts; no matching step = direct action (Decision 77); fail-closed rules;
  - the requirement re-checked inside every posting path;
  - policy row locking; approval-request immutability;
  - the policy editor, requirement notes on journals and opening balances, and facts with applied steps in the approval queue.
- Migration 0018 applied; 0001–0018 contiguous and up to date. **No migration 0019** (nothing to backfill) and no `allowUncovered`.
- No new permission keys and no new dependencies.
- No commit has been made and nothing has been pushed; the single Phase 3A commit remains at Checkpoint 3A / S11 (Decision 19).
