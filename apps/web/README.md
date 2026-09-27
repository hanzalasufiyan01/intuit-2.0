# @intuit-2/web

Frontend for Intuit 2.0: React, TypeScript, Vite, React Router and TanStack Query.

## Layout

| Folder | Responsibility |
| --- | --- |
| `src/app` | Application shell: providers, router, layout, top-level error boundary. |
| `src/features` | Feature folders (one per business area), each with its own screens, hooks and components. |
| `src/shared` | Reusable UI components and design-system foundation, hooks and utilities. |
| `src/services` | API client, request/response handling, error mapping to the platform error format. |
| `src/auth` | Authentication state, login/registration screens, protected routes. |
| `src/permissions` | Permission-aware UI helpers (for display only — the server always enforces authorization). |

## Security note

The active organization selected in the UI is only a preference. The server independently verifies membership and permissions on every request.
