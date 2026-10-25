# Help assistant and tutorials (developer guide)

The Help centre has two parts: **tutorials** (guided, per-member progress) and an **assistant** that answers questions about how Intuit 2.0 works. This page describes how they are built, how to configure them, and what they will and will not do. User-facing guides: `assistant-user-guide.md` and `tutorials.md`.

## What it does and does not do

- Explains the product from a fixed help catalogue (`apps/api/src/application/assistant/knowledge.ts`). Every statement there must describe a feature that exists; things that do not exist (tax filing, statutory payroll, live bank feeds, receipt scanning) are written as such.
- May quote **aggregate figures** from the member's own books: receivables, payables and the year-to-date profit and loss. They are read by the server through the existing report services under the member's own permissions. A model never produces or computes a number.
- **Writes no financial data.** It cannot post, refund, pay, file or change anything, and it has no tools. Its only writes are the rate-limit counters and, when figures are shown, one audit event (see Audit).
- Without a configured AI provider it runs in **documentation mode** and says so. It never pretends a live model is answering. This matches `architecture.md` ("AI is assistive only") and keeps R-61 (OCR and receipt scanning) deferred: this feature is a help assistant, not document AI.

## Request flow

`POST /api/v1/assistant/messages` (body: `message`, optional `history`, optional `path`):

1. `requirePrincipal` (a session is needed) and strict zod validation (`api/v1/assistant.routes.ts`): message 1 to 2000 characters, at most 10 history turns, unknown fields rejected. The global body limit (64 KB) also applies.
2. **Rate limits** (before any other work): per member and per organization, per minute, through the existing `RateLimiter` (PostgreSQL windows, keys `assistant:u:<userId>` and `assistant:o:<organizationId>`). The member's own budget is spent first; then the member's **current** active membership is confirmed from the database (not just the session), and only then is the budget of the organization that membership resolves to spent, so a member who has left or been disabled cannot use up an organization's budget. Over a limit: `429` `TOO_MANY_ATTEMPTS` with `Retry-After`.
3. Input is cleaned (control characters removed, lengths bounded); history keeps the last 8 turns, starting with a person's turn.
4. A short `withOrganization` transaction re-checks the active membership and roles. If the question asks about the member's own numbers (a keyword intent that also needs an ownership cue such as "our", "my", "how much" or "this year"), `summaries.ts` reads them through `ReportService.profitAndLossInTransaction`, `ArReportService.agingInTransaction` and `ApReportService.agingInTransaction`. Each figure needs its normal permission (`accounting.reports.view`, `sales.reports.view`, `purchases.reports.view`); without it the figure is reported as unavailable, never estimated. Each figure is read under its own savepoint: a recoverable failure (accounting not set up, a missing fiscal year, a query error) rolls back to the savepoint, leaves the other figures and the audit write intact, and shows that figure as unavailable. Permission, authentication, row-level-security and other privilege errors, and unexpected bugs, are not recovered: they propagate and end the request. The transaction is released **before** the provider is called.
5. The provider (documentation or AI) is given the cleaned question, history, the matching catalogue topics, the verified figures and a fixed page label. It is not given identifiers, names, document numbers, e-mail addresses, the organization, or raw URLs.
6. If the provider fails or returns nothing usable, the documentation provider answers and the reply carries `degraded: true`.
7. Reply: `reply`, `mode`, `degraded`, `figures`, `unavailable`, `sources` (topic, tutorial) and `generatedAt`. The browser shows the text as plain text.

`GET /assistant/status` returns the mode, provider name, suggested questions and the message limit; it never returns configuration or secrets.

Tutorial progress (`GET /tutorials/progress`, `PUT` and `DELETE /tutorials/progress/:tutorialId`) needs only an active membership and touches only the caller's own rows.

## Configuration

All in `apps/api/src/infrastructure/config/config.ts`; placeholders are in `.env.example`.

| Variable                      | Default                     | Meaning                                                                         |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------------------- |
| `ASSISTANT_PROVIDER`          | `docs`                      | `docs` (built-in catalogue) or `anthropic` (AI wording)                         |
| `ASSISTANT_API_KEY`           | none                        | Provider key. Required for `anthropic`. Server only; never logged or returned.  |
| `ASSISTANT_MODEL`             | none                        | Model id from your provider account. Required for `anthropic`; none is assumed. |
| `ASSISTANT_BASE_URL`          | `https://api.anthropic.com` | Must be `https` when `APP_ENV=production`                                       |
| `ASSISTANT_TIMEOUT_MS`        | `20000`                     | Provider call timeout (max 120000)                                              |
| `ASSISTANT_MAX_OUTPUT_TOKENS` | `700`                       | Reply length cap (max 4096)                                                     |
| `ASSISTANT_USER_PER_MINUTE`   | `20`                        | Questions per member per minute                                                 |
| `ASSISTANT_ORG_PER_MINUTE`    | `120`                       | Questions per organization per minute                                           |

### Enabling AI wording

1. Create a key and choose a model in your provider account (this repository does not pick one).
2. Set `ASSISTANT_PROVIDER=anthropic`, `ASSISTANT_API_KEY` and `ASSISTANT_MODEL` in the API environment (never in the web app, never committed). Startup fails with a message naming the missing variable if either is absent.
3. Restart the API. The panel then shows "AI-assisted wording"; `GET /assistant/status` returns `mode: "ai"`.
4. To go back, unset `ASSISTANT_PROVIDER` (or set it to `docs`).

The adapter (`provider.ts`) calls the Anthropic Messages API with plain `fetch` (no SDK dependency), an abort-controller timeout, and maps failures to `timeout`, `rate_limited`, `auth`, `unavailable` or `bad_response` without echoing the response body or key. Another provider is a new class implementing `AssistantProvider` plus a branch in `createAssistantProvider`.

**Status of the live path:** the adapter is covered by unit tests with an injected `fetch`; it has **not** been exercised against the real provider from this repository (no key was available). Do a manual check with a real key before relying on it.

## Security model

- **Authentication and tenancy.** Every route needs a session. The organization comes from the session, never from the request. Progress rows are protected by row-level security on both the organization and the member (`app_current_organization_id()`, `app_current_user_id()`), and every query repeats both conditions.
- **Authorization of figures.** Enforced on the server per figure (above). The web UI's visibility rules are a convenience only.
- **Prompt injection.** The system prompt is fixed on the server; the question, history and page text are untrusted data and are labelled as such; the model has no tools and sees only what the server chose for this member (catalogue text and at most three aggregate figures). Model output is treated as untrusted: control characters removed, length capped, shown as plain text, never executed, never parsed as SQL, code or markup.
- **No cross-tenant or unnecessary personal data.** No names, e-mail addresses, document numbers, party records or free-text accounting data leave the server. The page is sent as a fixed label from a table (`resolvePage`), never the URL, which can hold record ids.
- **Secrets.** The key lives in the API environment only. It is read once into `config.assistant`, sent only as a request header to the configured base URL, and appears in no log, error, audit event or response. Config validation errors name variables, not values.
- **Limits.** Input size, history size, output tokens, timeout and rate limits are enforced server-side. A provider failure is not retried automatically.
- **Logging.** The question and answer are not logged. A provider failure logs the provider name and failure kind only.
- **Storage.** The conversation is held in the browser's memory only and is cleared on sign-out or organization switch. The server stores no message text.

## Audit

When figures are produced, one audit event `assistant.financial_summary_shown` is written in the same transaction with metadata `{ kinds, mode }` (for example `["profit_and_loss"]`). It holds no amounts and no question text. Reads of ordinary help topics are not audited.

## Database

Migration `0096_tutorial_progress.sql` adds `tutorial_progress` (owned by `modules/learning`): primary key `(organization_id, user_id, tutorial_id)`, a composite foreign key to `memberships`, check constraints on the status, step (0 to 100) and the id format, `completed_at` set exactly when completed, a 50-row limit per member, and the row-level-security policy above. It is registered in `apps/api/test/s2-fixes.test.ts` and `docs/integration-plan.md`. It has **not been applied** to any database by this change; apply it with the project's normal migration process.

## Web

`apps/web/src/features/help/`: `tutorials.ts` (catalogue; text lives in `i18n/messages.help.en.ts` as `help.t.<id>.*`), `HelpPages.tsx` (Help centre and tutorial player), `AssistantPanel.tsx` (provider, button and dialog), `HelpLinks.tsx` (contextual help link and the first-sign-in prompt), `helpApi.ts`, `useHelpAccess.ts`. Navigation has a "Help" group (`Help centre`); the top bar has the contextual link and the Assistant button. The panel uses the shared accessible `Dialog`.

Assistant replies are English: the catalogue is English and the server returns its wording. The interface around it uses the message catalog.

## Tests

- `apps/api/test/assistant-unit.test.ts`: catalogue, input hygiene, summary intents and permissions, provider adapters with a fake `fetch`, configuration. No database needed.
- `apps/api/test/assistant-api.test.ts`: routes over HTTP with a fake provider (authentication, validation, tenant isolation, permissions on figures, fallback, rate limit, audit, no message text in logs). Needs the test database like every API test.
- `apps/web/test/help-tutorials.test.tsx` and `assistant-panel.test.tsx`: catalogue integrity, availability, player navigation and progress, assistant states (loading, error, retry, rate limit, figures, clear, plain-text rendering).
- A paid or live provider call is never needed by any test.

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| API will not start: `ASSISTANT_API_KEY: required` | `ASSISTANT_PROVIDER=anthropic` without a key or model. Set both, or unset the provider.                |
| Panel says "Built-in help"                        | `ASSISTANT_PROVIDER` is `docs` or unset. This is the safe default.                                     |
| Replies carry "AI service could not answer"       | Provider timeout, auth, rate limit or outage. The log has `assistant provider failed` with a `kind`.   |
| `429` from the assistant                          | Per-member or per-organization limit. `Retry-After` gives the seconds; raise the two limits if needed. |
| Tutorial progress does not load                   | Migration 0096 has not been applied to that database.                                                  |
| A figure shows as unavailable                     | The member lacks the report permission, or accounting is not set up / no fiscal year is open.          |
