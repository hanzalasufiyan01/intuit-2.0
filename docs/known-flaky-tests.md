# Known flaky tests

The API suite shares one development database, and its test files run in parallel processes. Two tests were seen failing only inside the full parallel run. Both pass alone and repeatedly (checked 2026-10-08).

| Test                                                                                     | Class                                             | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Status                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outbox.test.ts` "delivers events to subscribers…" and "retries failures with back-off…" | **B/C — harness race under shared-database load** | The outbox dispatcher claimed every due event of the shared database (a backlog of several thousand pending events, plus concurrent producers in other test files). Under load the first test's drain exceeded the 30 s test timeout; its drain loop kept running in the background and marked the second test's event, which has no subscriber for that type, as processed — so the second test saw `processed` instead of `pending`. Not a production defect: the dispatcher behaves as designed. | **Fixed deterministically.** `OutboxDispatcher` gained an optional `eventTypes` filter (default: all types, unchanged for the server). Each outbox test claims only its own event type. Assertions are unchanged. |
| `imports.test.ts` "housekeeping (S6-36, L-11)"                                           | **C — infrastructure/queue contention**           | The test drives `ctx.worker.runOnce()` ten times; the job queue is shared with the other test files running at the same time, and the worker claims any due job, so under load the cleanup job can be reached too late. Passed 3 of 3 times alone and in earlier full runs.                                                                                                                                                                                                                         | **Known flaky.** No safe deterministic fix without changing job claiming; not weakened. If it fails in a full run, rerun the file alone.                                                                          |

Also seen under load, pass alone: the web `app.test.tsx` sign-in test (three full runs so far, see its section below) and `mfa.test.ts` secret-hygiene scan (once; its timeout was raised to 180 s).

2026-10-17 full run: `webhooks.test.ts` "ping throttle" failed once (Retry-After 9 instead of 10, a wall-clock boundary under load); it passes alone and in the rerun. Same class as above; not weakened.

## web `app.test.tsx` > "signs in, returns to the requested page, and signs out"

Seen in three full `pnpm verify` runs, always with the same symptom: the redirect assertion read
`/login` instead of `/members`. First when the web suite had 38 test files (date not recorded; it
then passed 9/9 alone), then run 15 on 2026-10-20 (machine busy with a video call; 3/3 alone) and
run 17 on 2026-10-20 (alongside the API suite on a quiet machine; 10/10 alone). It passed in every
other full run, including runs 16 and 18. Treated as a load-dependent timing flake, not a product
defect: after run 17 the sign-in and session code was re-read and no path that clears the session
after sign-in was found. The test and its assertions are unchanged. It recurs, so it stays on this
list; re-run the file in isolation first, and if it fails alone, investigate it as a defect.

## Web test time limits (stabilization, 2026-10-16)

Two web test deadlines were raised on 2026-10-16, test-side only, while full parallel runs were
being stabilized: `apps/web/vitest.config.ts` sets `testTimeout: 30_000` (Vitest's default is 5 s
per test) and `apps/web/test/setup.ts` sets `configure({ asyncUtilTimeout: 5000 })` (Testing
Library's default wait for `findBy…`/`waitFor` is 1 s; the file's comment: under the load of a full
parallel run a page can need more than the default to settle). Both apply to every web test. They
change how long a test may wait, not what it asserts: no assertion was removed or loosened. The
cost is that a page that became genuinely slow would pass instead of failing, so a slow-render
regression shows up as a longer run, not a failure. The sign-in flake above is not hidden by them:
it fails on an immediate route assertion, not on a wait. To check a suspect file against the
defaults, run it alone with `pnpm --filter @intuit-2/web exec vitest run <file> --testTimeout=5000`
(the 5 s wait in `setup.ts` still applies). The values are unchanged and stay until the suite is
shown to pass reliably without them.

## 2026-10-20 full runs

- `exports.test.ts` "list exports" (three tests, run 12): the exports stayed `queued` because the shared job queue held about 200 due document-PDF jobs left by earlier test files, and the worker takes the oldest first. **Fixed deterministically:** the file processes already-due jobs before its first test; the 30-pass budget per export and all assertions are unchanged. Passes 16/16 alone and in runs 14 and 16.
- `public-api.test.ts` "frozen contract: 429 with RateLimit-*" (run 14): `RateLimit-Remaining` read `2, 2, 1` instead of `2, 1, 0` because the three counted requests straddled a fixed one-minute window. **Fixed deterministically:** the test moves its own clock to just after a window opens before counting; assertions unchanged.
- `expense-claims.test.ts` R-04 audit order (run 8): two audit events written in one transaction at the same instant have no defined order (uuid tie-break). **Fixed:** the test compares them as a set; creation first and the later approval last are still asserted.
- Run 17 (web `app.test.tsx` sign-in again, the redirect assertion read `/login` instead of `/members` while the API suite ran alongside): the session code was re-read and no path that clears the session after sign-in was found (a 401 does not trigger the session reload; nothing else refetches the session on this route). The file passed 10 of 10 times alone and the next full run (18) was green, so it stays classed as a load-dependent timing flake; nothing was changed and no assertion was weakened. Note: when `pnpm -r test` stops on the first failing package, the other package's `vitest run` keeps running in the background; wait for it to exit before starting another full run, or the runs overlap.
- Run 13 (61 timeouts in 25 files) and run 15 (web `app.test.tsx` sign-in, the same flake as above) happened while the machine was busy with other programs (a video call among them). Not code defects; both files pass alone. Run the full suite on a quiet machine.

## `sales-extras.test.ts` > "runs the automatic schedule in stages" (fixed)

The test asserted the GLOBAL return value of `reminders.runAuto()`, which sends reminders for every organization with the schedule on; leftovers or a parallel test file could make it return 1 instead of 0 (seen once, 2026-10-18). It now counts only its own organization's reminders.
