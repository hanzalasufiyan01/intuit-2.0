# Resume development

How to pick Intuit 2.0 up again, from a cold start. Verified commands only; where something was not verified it says so.

## 1. Get the code and the baseline

```sh
git clone https://github.com/hanzalasufiyan01/intuit-2.0.git   # or: git fetch origin
cd intuit-2.0
git log --oneline -5 origin/main           # expect 2652a64 or later
node -v && pnpm -v                          # Node >= 22.12, pnpm 10.28
pnpm install --frozen-lockfile
```

Never trust a remembered commit hash or CI status: re-read them from GitHub (Actions page of the repository, `ci` and `deploy-smoke`).

## 2. Run it locally

Prerequisites: PostgreSQL 16 (a native service is fine; Docker is not required), Git Bash on Windows.

```sh
cp .env.example .env            # replace every CHANGE_ME; see docs/environment.md
pnpm db:bootstrap               # once: roles and the intuit2_dev database (needs the postgres password)
pnpm db:setup                   # migrations 0001 to 0096 and reference-data seed
pnpm db:seed:dev                # optional example data (needs DEV_SEED_PASSWORD)
pnpm dev                        # API :3000, web http://localhost:5173
```

Register in the browser: the first user is the Owner and must enrol an authenticator app. For tests use a **throwaway** PostgreSQL cluster instead of the development database (`docs/testing.md`).

## 3. Verify

```sh
pnpm verify                     # format, lint, typecheck, OpenAPI check, all tests, build (needs a database)
pnpm e2e:install && pnpm e2e    # browser journeys (12 spec files, 22 journeys)
pnpm audit --prod --audit-level high
```

Last results (2026-10-26, throwaway database): `pnpm verify` exit 0 (API 135 files, 1909 passed, 4 skipped; web 71 files, 829 passed); Playwright 22 of 22, twice. The first run of CI on `2652a64` failed in the Playwright step on attempt 1 (unknown test) and passed on attempt 2.

## 4. Where to start

1. **Read the blockers:** `docs/production-readiness-audit.md` (P0 and P1) and `FINAL_HANDOVER.md`.
2. **Diagnose the unexplained Playwright failure first** (see below); a red `main` costs every other task.
3. Then choose from `docs/remaining-scope.md`: Tier 1 is done; Tier 2 needs the owner's decision before building; Tier 3 is blocked on outside input.
4. **Do not start a new product feature without the owner's decision** on the item. Do not claim production readiness.

### The unexplained failure

`ci` run 40366991696, attempt 1, step "Browser end-to-end smoke tests (Playwright)". The artifact `playwright-failure-40366991696-1` expires 2026-11-02. Sign in to GitHub, download it, read `error-context.md` (and the screenshot), and open step 16's log for the failure block (test name, line, `Error:`, expected and received, the "waiting for" call log). Record the result in `docs/known-flaky-tests.md` before changing any code. If it has expired, the next failure must be captured at once.

## 5. Ways of working that matter

- **Branches and PRs:** branch from the latest `origin/main`, one focused change per branch, push the branch, the owner opens and merges the PR (no `gh` CLI). Never push to `main`.
- **Worktrees:** the project keeps several `git worktree` directories next to the primary checkout; `git worktree list` shows them. The primary checkout has an untracked `e2e/refund-sources.spec.ts` identical to the one in `main`; delete it only deliberately.
- **Migrations:** forward-only; a new file number (next 0097); never edit an applied file; applying one to a database is a deliberate operator action.
- **Database safety:** never point tests or seeds at a shared or personal database. Check the server's own answer for database, port and role first. `bootstrap.sql` resets the passwords of the two shared roles, so run it only on a throwaway cluster.
- **Windows quirks:** use Git Bash; `psql` options go before the connection string or file; avoid heredocs for scripts with backslashes (write the script to a file); MSYS can mangle paths that start with `/` (set `MSYS_NO_PATHCONV=1` for `.github` paths); `pg_ctl` may hang unless its streams are redirected; Python cannot open `/c/...` paths (use `C:/...`).
- **Reporting:** state exactly what ran and what did not. Missing evidence is "unknown", not "fine".

## 6. Files to read, in order

`PROJECT_CONTEXT.md`, `FINAL_HANDOVER.md`, `docs/README.md` (the index), `docs/production-readiness-audit.md`, `docs/feature-completion-matrix.md`, `docs/remaining-scope.md`, `docs/known-flaky-tests.md`, `docs/operations.md`, then the area documents you need.

A ready-made prompt for starting a new AI session is in `docs/handover/AI_CONTINUATION_PROMPT.md`.
