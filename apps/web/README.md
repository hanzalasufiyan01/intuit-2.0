# @intuit-2/web

Frontend for Intuit 2.0: React, TypeScript, Vite, React Router and TanStack Query.

## Layout

| Folder            | Responsibility                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `src/app`         | Application shell: providers, router, layout, top-level error boundary.                    |
| `src/features`    | Feature folders (one per business area), each with its own screens, hooks and components.  |
| `src/shared`      | Reusable UI components and design-system foundation, hooks and utilities.                  |
| `src/services`    | API client, request/response handling, error mapping to the platform error format.         |
| `src/auth`        | Authentication state, login/registration screens, protected routes.                        |
| `src/permissions` | Permission-aware UI helpers (for display only — the server always enforces authorization). |

## Security note

The active organization selected in the UI is only a preference. The server independently verifies membership and permissions on every request.

- The session is an httpOnly cookie. The app never sees or stores the session token.
- The per-session CSRF token comes from `GET /api/v1/auth/session` and is kept in memory only. It is sent as `X-CSRF-Token` on writes.
- One-time tokens (password reset, invitation) arrive in the URL fragment (`#token=…`) and are posted in JSON bodies. They never appear in request URLs.
- Organization-scoped query caches are dropped whenever the session or active organization changes.

## Development

`pnpm dev` starts Vite on http://localhost:5173 and proxies `/api` to the API (`API_HOST`/`API_PORT` from the root `.env`), so the browser sees a single origin. `pnpm test` runs the jsdom tests.
