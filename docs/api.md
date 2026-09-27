# API Conventions (v1)

- Base path: **`/api/v1`**. Breaking changes go into a new version.
- JSON only (`Content-Type: application/json`). Bodies are limited to 64 KiB.
- Success responses use the envelope `{ "data": ... }`. Some list responses also include `page`. `204` responses have no body.
- Error responses use the envelope below:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request is invalid.",
    "requestId": "8a1c…",
    "details": { "issues": [{ "path": "email", "message": "Enter a valid email address." }] }
  }
}
```

- Every response carries `x-request-id`. Quote it when reporting problems.
- Authentication uses the session cookie. Writes also need `X-CSRF-Token` (see [security](security.md)).
- Input is validated with Zod: request bodies, path parameters and query strings.

## Error codes

| Status | Code                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `VALIDATION_FAILED`, `MALFORMED_REQUEST`, `INVALID_TOKEN` (password reset)                                                                             |
| 401    | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`                                                                                                               |
| 403    | `PERMISSION_DENIED`, `FORBIDDEN`, `REAUTHENTICATION_REQUIRED`, `CSRF_REJECTED`, `INVITATION_EMAIL_MISMATCH`, `INVALID_CREDENTIALS` (re-authentication) |
| 404    | `NOT_FOUND`, `INVALID_TOKEN` (invitation)                                                                                                              |
| 409    | `CONFLICT`, `EMAIL_UNAVAILABLE`, `ALREADY_MEMBER`, `LOGIN_REQUIRED`, `PROTECTED_RESOURCE`, `INVITATION_NOT_PENDING`, `NO_ACTIVE_ORGANIZATION`          |
| 410    | `INVITATION_EXPIRED`                                                                                                                                   |
| 415    | `UNSUPPORTED_MEDIA_TYPE`                                                                                                                               |
| 429    | `TOO_MANY_ATTEMPTS` (with `Retry-After`)                                                                                                               |
| 500    | `INTERNAL_ERROR`                                                                                                                                       |

## Endpoints

| Method | Path                                                 | Auth | Permission / notes                                               |
| ------ | ---------------------------------------------------- | ---- | ---------------------------------------------------------------- |
| GET    | `/health`                                            | —    | Includes a database check                                        |
| POST   | `/auth/register`                                     | —    | Creates user + organization (Owner)                              |
| POST   | `/auth/login`                                        | —    | Login protection applies                                         |
| POST   | `/auth/logout`                                       | ✓    | Revokes the session                                              |
| GET    | `/auth/session`                                      | ✓    | Session state + CSRF token                                       |
| POST   | `/auth/reauthenticate`                               | ✓    | Opens the 15-minute window                                       |
| PUT    | `/auth/session/organization`                         | ✓    | Switch organization (membership re-verified)                     |
| GET    | `/auth/sessions`                                     | ✓    | Own active sessions                                              |
| DELETE | `/auth/sessions/:sessionId`                          | ✓    | Own session; another one is sensitive                            |
| POST   | `/auth/password-reset/request`                       | —    | Always `202`                                                     |
| POST   | `/auth/password-reset/complete`                      | —    | Single-use token; revokes sessions                               |
| GET    | `/organizations`                                     | ✓    | Own organizations                                                |
| POST   | `/organizations`                                     | ✓    | New organization; caller is Owner                                |
| GET    | `/organizations/current`                             | ✓    | `organization.read`                                              |
| PATCH  | `/organizations/current`                             | ✓    | `organization.update`                                            |
| GET    | `/organizations/current/members`                     | ✓    | `members.read`                                                   |
| PUT    | `/organizations/current/members/:membershipId/roles` | ✓    | `members.manage` + re-auth                                       |
| PATCH  | `/organizations/current/members/:membershipId`       | ✓    | `members.manage` + re-auth (status)                              |
| GET    | `/organizations/current/invitations`                 | ✓    | `members.invite`                                                 |
| POST   | `/organizations/current/invitations`                 | ✓    | `members.invite`                                                 |
| POST   | `/organizations/current/invitations/:id/revoke`      | ✓    | `members.invite`                                                 |
| GET    | `/organizations/current/roles`                       | ✓    | `roles.read`                                                     |
| POST   | `/organizations/current/roles`                       | ✓    | `roles.manage` + re-auth                                         |
| PUT    | `/organizations/current/roles/:roleId`               | ✓    | `roles.manage` + re-auth                                         |
| DELETE | `/organizations/current/roles/:roleId`               | ✓    | `roles.manage` + re-auth                                         |
| GET    | `/permissions`                                       | ✓    | `roles.read`                                                     |
| GET    | `/organizations/current/audit-events?limit&before`   | ✓    | `audit.read`                                                     |
| POST   | `/invitations/lookup`                                | —    | Token in the body                                                |
| POST   | `/invitations/accept`                                | opt. | Signed in: the email must match. Signed out: creates the account |
