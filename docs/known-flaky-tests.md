# Known flaky tests

The API suite shares one development database, and its test files run in parallel processes. Two tests were seen failing only inside the full parallel run. Both pass alone and repeatedly (checked 2026-10-08).

| Test                                                                                     | Class                                             | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Status                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outbox.test.ts` "delivers events to subscribers…" and "retries failures with back-off…" | **B/C — harness race under shared-database load** | The outbox dispatcher claimed every due event of the shared database (a backlog of several thousand pending events, plus concurrent producers in other test files). Under load the first test's drain exceeded the 30 s test timeout; its drain loop kept running in the background and marked the second test's event, which has no subscriber for that type, as processed — so the second test saw `processed` instead of `pending`. Not a production defect: the dispatcher behaves as designed. | **Fixed deterministically.** `OutboxDispatcher` gained an optional `eventTypes` filter (default: all types, unchanged for the server). Each outbox test claims only its own event type. Assertions are unchanged. |
| `imports.test.ts` "housekeeping (S6-36, L-11)"                                           | **C — infrastructure/queue contention**           | The test drives `ctx.worker.runOnce()` ten times; the job queue is shared with the other test files running at the same time, and the worker claims any due job, so under load the cleanup job can be reached too late. Passed 3 of 3 times alone and in earlier full runs.                                                                                                                                                                                                                         | **Known flaky.** No safe deterministic fix without changing job claiming; not weakened. If it fails in a full run, rerun the file alone.                                                                          |

Also seen under load, pass alone: `mfa.test.ts` secret-hygiene scan (once; its timeout was raised to 180 s). The web `app.test.tsx` sign-in failure listed here earlier turned out to be a product race, fixed on 2026-10-21 (see its section below).

2026-10-17 full run: `webhooks.test.ts` "ping throttle" failed once (Retry-After 9 instead of 10, a wall-clock boundary under load); it passes alone and in the rerun. Same class as above; not weakened.

## web `app.test.tsx` > "signs in, returns to the requested page, and signs out" (fixed: product race)

**Symptom.** In four full runs the redirect assertion read `/login` instead of `/members`: first
when the web suite had 38 test files (date not recorded), then runs 15 and 17 on 2026-10-20, and the
first GitHub Actions run (39469371252, 2026-10-20, on a runner with nothing else running). It passed
in runs 16 and 18 and every time alone, which is why it was first classed as a load-dependent
flake. That classification was wrong.

**Cause (a real race in the sign-in code).** `login()` stores the new session with `setQueryData`,
but TanStack Query 5 tells its observers one macrotask later (`notifyManager` schedules with
`setTimeout(0)`). The login page also navigated to the requested page from the mutation's
`onSuccess`, which runs earlier. When React rendered `/members` in that window, `RequireAuth` still
saw "signed out" and redirected to `/login`; a moment later `RedirectIfAuthenticated` sent the user
back. In the app this is a brief bounce `/members` -> `/login` -> `/members`; the test caught the
moment in between. Registration (`RegisterPage`) had the same pattern. A probe that recorded every
router navigation reproduced it locally: 16 of 200 runs with random API delays of up to 50 ms, each
with a late `navigate('/login')` from `RequireAuth`.

**Fix (2026-10-21).** `LoginPage` and `RegisterPage` no longer navigate from the mutation callback;
the session-driven route guard (`RedirectIfAuthenticated`) continues to the requested page, as the
two-step-verification path already did. The test and its assertions are unchanged. New regression
guard: `apps/web/test/auth-redirect.test.tsx` records every navigation after submitting and requires
that none happens while the sign-in or registration form is still shown and none leads to `/login`;
it failed 10 of 10 times on the old code and passes on the fix. After the fix: the probe passed
200 of 200 under the same delays, `app.test.tsx` 10 of 10, the web suite 57 files / 371 tests, and
the 16 Playwright journeys.

## Web test time limits (stabilization, 2026-10-16)

Two web test deadlines were raised on 2026-10-16, test-side only, while full parallel runs were
being stabilized: `apps/web/vitest.config.ts` sets `testTimeout: 30_000` (Vitest's default is 5 s
per test) and `apps/web/test/setup.ts` sets `configure({ asyncUtilTimeout: 5000 })` (Testing
Library's default wait for `findBy…`/`waitFor` is 1 s; the file's comment: under the load of a full
parallel run a page can need more than the default to settle). Both apply to every web test. They
change how long a test may wait, not what it asserts: no assertion was removed or loosened. The
cost is that a page that became genuinely slow would pass instead of failing, so a slow-render
regression shows up as a longer run, not a failure. The sign-in failure above was not hidden by them:
it failed on an immediate route assertion, not on a wait. To check a suspect file against the
defaults, run it alone with `pnpm --filter @intuit-2/web exec vitest run <file> --testTimeout=5000`
(the 5 s wait in `setup.ts` still applies). The values are unchanged and stay until the suite is
shown to pass reliably without them.

## 2026-10-20 full runs

- `exports.test.ts` "list exports" (three tests, run 12): the exports stayed `queued` because the shared job queue held about 200 due document-PDF jobs left by earlier test files, and the worker takes the oldest first. **Fixed deterministically:** the file processes already-due jobs before its first test; the 30-pass budget per export and all assertions are unchanged. Passes 16/16 alone and in runs 14 and 16.
- `public-api.test.ts` "frozen contract: 429 with RateLimit-*" (run 14): `RateLimit-Remaining` read `2, 2, 1` instead of `2, 1, 0` because the three counted requests straddled a fixed one-minute window. **Fixed deterministically:** the test moves its own clock to just after a window opens before counting; assertions unchanged.
- `expense-claims.test.ts` R-04 audit order (run 8): two audit events written in one transaction at the same instant have no defined order (uuid tie-break). **Fixed:** the test compares them as a set; creation first and the later approval last are still asserted.
- Run 17 (web `app.test.tsx` sign-in again, the redirect assertion read `/login` instead of `/members` while the API suite ran alongside): the session code was re-read and no path that clears the session after sign-in was found (a 401 does not trigger the session reload; nothing else refetches the session on this route). The file passed 10 of 10 times alone and the next full run (18) was green, so it stayed classed as a load-dependent timing flake; nothing was changed and no assertion was weakened. (Superseded on 2026-10-21: the cause was a sign-in race, now fixed; see the entry above.) Note: when `pnpm -r test` stops on the first failing package, the other package's `vitest run` keeps running in the background; wait for it to exit before starting another full run, or the runs overlap.
- Run 13 (61 timeouts in 25 files) and run 15 (web `app.test.tsx` sign-in) both happened while the machine was busy with other programs (a video call among them), and both files passed alone. Run 13 was machine load, not a code defect: run the full suite on a quiet machine. Run 15 was first put down to the same load, but it was the sign-in redirect race confirmed and fixed on 2026-10-21 (see the entry above): a code defect that load made more likely.

## `sales-extras.test.ts` > "runs the automatic schedule in stages" (fixed)

The test asserted the GLOBAL return value of `reminders.runAuto()`, which sends reminders for every organization with the schedule on; leftovers or a parallel test file could make it return 1 instead of 0 (seen once, 2026-10-18). It now counts only its own organization's reminders.
