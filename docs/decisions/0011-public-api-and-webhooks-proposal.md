# ADR 0011 (PROPOSAL) — Public API (`/public/v1`) and webhooks

Status: **proposed, for architecture review. Nothing is implemented.** Do not build until the decisions in section 14 are answered. Date: 2026-10-08.

Scope: a stable, versioned, token-authenticated HTTP API for external systems, and signed outbound webhooks. It reuses the existing outbox, job queue, idempotency service, audit trail, permission model, MFA and re-authentication. It exposes **public DTOs**, never internal tables or internal view models.

## 1. Principles

1. **Separate surface.** `/public/v1` is its own Fastify plugin with its own authentication hook, error mapper, rate limiter and DTOs. The internal `/api/v1` (cookie session + CSRF) never accepts bearer tokens, and `/public/v1` never accepts session cookies. No route is shared.
2. **A token is a service principal, not a user.** It is bound to one organization and can do no more than its scopes and its creator's current permissions allow (section 3).
3. **Additive only.** Inside `v1`, fields and endpoints are only added. Anything else is `v2`.
4. **DTOs are an explicit allow-list** (section 8). A new internal column is invisible to the public API until a DTO maps it.
5. **Provider independence.** Rate limiting, secret encryption, outbound HTTP and event sourcing sit behind small interfaces (section 13). No gateway, queue or KMS product is assumed.
6. **Everything is tenant-isolated by RLS first, then by code.** The organization comes from the token alone — never from a header, path or body.

## 2. Token model

| Item                 | Decision                                                                                                                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind                 | "API token", created in the web app by a user with `api_tokens.manage` (Owner and Administrator by default).                                                                                                                                                                                                |
| Format               | `itk_` + 8-char public id + `_` + 43-char base64url secret (256 bits of CSPRNG). The prefix lets secret scanners and log filters recognize it.                                                                                                                                                              |
| Storage              | Only `SHA-256(secret)` is stored (the secret has 256 bits of entropy, so a slow hash adds nothing) plus the public id, name, scopes, creator, organization, `created_at`, `expires_at`, `last_used_at`, `last_used_ip`, `revoked_at/by/reason`. Lookup is by public id, comparison constant-time.           |
| Display              | The full token is shown **once**, at creation, in the response of the create call. It can never be revealed again; losing it means rotating. The list shows name, public id, scopes, expiry, last use.                                                                                                      |
| Expiration           | Mandatory. Choices 30 / 90 / 180 / 365 days; default 90; maximum 365. Expired tokens are rejected (`401 token_expired`). The owner is notified (in-app and email) 14 and 3 days before expiry.                                                                                                              |
| Revocation           | Immediate: every request reads the token row, so revocation takes effect on the next request. Revoke needs `api_tokens.manage` + re-authentication and is audited with a reason. A token is also suspended while its creator's membership is disabled, or the creator lacks the permissions behind a scope. |
| Rotation             | Create a new token, switch the integration, revoke the old one. There is no in-place secret change. Up to 10 active tokens per organization.                                                                                                                                                                |
| Organization binding | Fixed at creation; a token never switches organizations.                                                                                                                                                                                                                                                    |
| Network              | Optional per-token IP allow-list (CIDR). TLS only (HSTS); `Authorization: Bearer itk_…`. Tokens in query strings are rejected.                                                                                                                                                                              |
| Org switch           | The public API is **off by default**; an Owner enables it in organization settings (audited). Disabling it makes every token answer `403 api_disabled`.                                                                                                                                                     |

Creating, rotating, revoking a token and changing a scope are **sensitive actions**: they need `api_tokens.manage`, a recent password confirmation (15 min) and, when the organization enforces MFA, a satisfied MFA step-up (existing `MFA_STEP_UP_REQUIRED` flow). A token can never manage tokens or webhooks, change roles, approve anything, or perform a sensitive action.

## 3. Scopes and authorization

- Scopes are coarse, human-readable and stable: `customers:read`, `customers:write`, `invoices:read`, `items:read`, `vendors:read`, `bills:read`, `payments:read`, `accounts:read`, `reports:read`, … Each scope maps to a fixed list of existing internal permission keys (e.g. `invoices:read` → `invoices.view`).
- **Effective permissions of a request = scopes' permission keys ∩ the creator's current permissions** in that organization. Demoting the creator immediately narrows the token. This keeps the existing permission catalog as the single source of truth.
- **Phase 1 of the public API is read-only plus a minimal write set** (create/update customers and items, create draft invoices). **No scope posts to the ledger, voids, refunds, approves or touches settings.** Accounting-affecting writes need a separate review.
- Each endpoint declares the one scope it needs; the check runs before the handler and again inside the service (`requirePermission`) against the token's effective context.
- Internal implementation: a new `Principal` variant `{ kind: 'api_token', tokenId, organizationId, permissions }` is accepted by `withOrganization`, so services, RLS context and audit work unchanged. Membership checks are replaced by the creator checks above.

## 4. Rate limiting

- Limits per token (token bucket): **600 requests/minute** for reads, **120/minute** for writes, plus a per-organization ceiling (**3,000/minute**) and a per-IP limit for unauthenticated failures (token guessing: 20/minute, then back-off). Limits are configurable per organization later.
- Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; a rejection is `429` with `Retry-After` and the standard error body (section 9).
- Store behind `RateLimiter` (section 13). Default implementation: PostgreSQL fixed-window counters (UPSERT per token per minute, no extra infrastructure, correct with several API instances); an in-memory pre-aggregation reduces writes. A Redis implementation can replace it without touching handlers.
- Hard request limits: body 1 MB (uploads are not part of v1), request timeout 30 s, `limit` ≤ 100, response size cap.

## 5. Idempotency

- Every `POST`/`PUT`/`DELETE` requires `Idempotency-Key` (8–200 chars). It is stored with the existing `IdempotencyService` using scope `public.<resource>.<action>`, the organization and the token as the owner, and a hash of the request. Same key + same request replays the stored response with `Idempotent-Replayed: true`; same key + different request is `409 idempotency_key_reused`; an in-flight duplicate is `409 request_in_progress`. Retention 24 hours.
- Idempotency does not replace business uniqueness (document numbers, supplier references still apply).

## 6. Versioning and deprecation

- Major version in the path (`/public/v1`). `v1` is additive: new optional fields, new endpoints, new enum values (clients must tolerate unknown values — documented).
- Deprecation: `Deprecation` and `Sunset` response headers, a changelog, at least **12 months** of overlap between `v1` and `v2`.
- Webhook payloads carry `api_version`; an endpoint is pinned to the version it was created with.

## 7. Pagination, filtering, ordering

- Cursor pagination only: `?limit=25&cursor=…` (default 25, max 100). Response `{ data: [...], page: { next_cursor, has_more } }`. The cursor is an opaque, signed keyset token (never an offset); a tampered cursor is `400 invalid_cursor`.
- Ordering is fixed per resource and stable (`created_at, id` or the natural document order); no client-chosen sort in v1.
- Filters are an allow-list per resource (`status`, `customer_id`, `date_from`/`date_to`, `updated_since`). `updated_since` (by `updated_at, id`) supports incremental sync. No totals/counts by default (they are costly under RLS); `page.has_more` is enough.
- `Accept-Language` does not change data; all text is as stored.

## 8. DTO isolation

- `modules/public-api` owns `dto/v1/*.ts`: one mapper per resource from the internal application view to a **hand-written public shape**. Mappers never spread internal objects.
- Public shapes: ids are the existing UUIDs; amounts are decimal strings with the currency code; dates are ISO 8601; enums are a documented subset; no internal ids of journals, events, files, audit or approvals; no base-amount internals, no tax snapshot internals, no storage keys, no personal data beyond the resource's own fields (a customer's email and phone are included only under `customers:read`).
- Each DTO has a zod response schema; the same schemas generate the OpenAPI document and are used in **golden contract tests** (stored JSON per resource) so a field cannot be added, removed or retyped by accident.
- Money, rounding, FX and tax values come from the existing services; the public API computes nothing.

## 9. Error format

```json
{
  "error": {
    "type": "invalid_request",
    "code": "validation_failed",
    "message": "…",
    "request_id": "…",
    "details": [{ "field": "lines.0.quantity", "issue": "…" }],
    "doc_url": "https://…/errors#validation_failed"
  }
}
```

- `type` ∈ `authentication_error`, `permission_error`, `invalid_request`, `not_found`, `conflict`, `rate_limited`, `api_error`. `code` is a stable, documented snake_case value; internal error codes map to a public subset (an unknown internal error becomes `api_error` with no internal text). Messages never include SQL, stack traces or other tenants' data. Cross-tenant ids return `404 not_found`.
- `request_id` matches the internal request id for support.

## 10. Audit and monitoring

- A new audit actor type `api_token` (migration: extend `audit_events.actor_type`; `actor_token_id`): every write through the public API is audited like a user write, with the token id, public id and IP. Token lifecycle events (`api_token.created|revoked|expired|ip_blocked|scope_changed`, `public_api.enabled|disabled`) are audited and also recorded as security events.
- Reads are not individually audited; a daily aggregate per token (`api_token_usage`: requests, errors, last IP) supports review and anomaly alerts (sudden volume, new IP).
- Failed authentication is a security event (rate-limited), never revealing whether a public id exists.

## 11. Webhooks

### 11.1 Architecture (on the existing outbox and jobs)

```
service (same DB transaction) ──► outbox_events ──► OutboxDispatcher
                                                    └─ "webhook fan-out" subscriber
                                                         ├─ maps internal event → public event type (catalog, versioned)
                                                         ├─ builds the public DTO snapshot (section 8)
                                                         └─ for each active endpoint subscribed in that organization:
                                                              INSERT webhook_deliveries + enqueue job webhook.deliver
webhook.deliver job ──► HTTPS POST (pinned IP, no redirects) ──► records an attempt, retries or dead-letters
```

- Domain events are written to the outbox **in the business transaction** by additive emit calls (the same hook style as Inventory/Orders), so an event exists if and only if the change committed. No event is produced for an uncommitted change.
- The fan-out is idempotent (`event id + endpoint id` is unique). Delivery is **at least once**; consumers dedupe on the event id.

### 11.2 Event catalog (v1, versioned and documented)

`customer.created|updated`, `vendor.created|updated`, `item.created|updated`, `invoice.issued|voided`, `credit_note.issued`, `receipt.recorded|voided`, `customer_refund.recorded|voided`, `bill.posted|voided`, `vendor_credit.posted|voided`, `vendor_payment.recorded|voided`, `vendor_refund.recorded|voided`, `expense_claim.posted|voided`, `bank_transaction.imported` (counts only), `webhook.ping`. Journal-level and approval events are **not** public in v1. A type is `<resource>.<action>`; a payload shape change that is not additive is a new `api_version`.

Envelope (stable): `{ "id": "evt_…", "type": "invoice.issued", "api_version": "v1", "created_at": "…", "organization_id": "…", "data": { "object": { …public DTO… } } }`. Payload mode per endpoint: **full** (DTO snapshot at event time) or **thin** (`id`, `type`, resource URL only; the consumer fetches the object). Thin is recommended for sensitive resources.

### 11.3 Endpoint rules and SSRF protection

- Created by `webhooks.manage` + re-authentication (+ MFA step-up when enforced). Max **10 endpoints** per organization; an endpoint subscribes to a list of event types; name, URL, status (`active`, `disabled`, `auto_disabled`), `api_version`, payload mode.
- **HTTPS only**, port 443 (allow-list configurable), no userinfo in the URL, host must be a DNS name — IP literals, `localhost` and internal suffixes (`.local`, `.internal`, `.lan`) are refused.
- Validated **on create/update and again on every delivery**: the hostname is resolved at delivery time and **every** returned address must be public (blocking loopback, RFC 1918, link-local incl. `169.254.169.254`, CGNAT `100.64.0.0/10`, multicast, reserved, IPv6 loopback/ULA/link-local, and IPv4-mapped IPv6 forms). The connection is made to the validated IP (pinned, preventing DNS-rebinding between check and connect) with the original hostname for TLS SNI and `Host`.
- **Redirects are never followed** (a 3xx is a failure). Connect timeout 5 s, total timeout 10 s; the response body is read up to 64 KB and only a 1 KB excerpt is stored. TLS certificate verification is mandatory (no opt-out). In production, deliveries should leave through a dedicated egress proxy/NAT with a stable IP list that customers can allow-list.
- A `webhook.ping` event can be sent on demand to test an endpoint.

### 11.4 Signing, timestamp and replay protection

- Per-endpoint secret `whsec_…` (256-bit CSPRNG), **shown once** at creation. It must be recoverable to sign, so it is stored **encrypted** (AES-256-GCM, key id + key from `SecretCipher`, section 13), never logged.
- Headers: `Intuit-Webhook-Id` (the delivery id, stable across retries), `Intuit-Webhook-Event`, `Intuit-Webhook-Timestamp` (Unix seconds, refreshed on every attempt) and `Intuit-Webhook-Signature: t=<ts>,v1=<hex>`.
- `v1 = HMAC-SHA256(secret, "<timestamp>.<delivery id>.<raw body>")`. Consumers must verify against the **raw** body, compare in constant time, **reject timestamps older than 5 minutes** (replay window) and **deduplicate on the event id**. The documentation ships verification samples for common languages.
- **Secret rotation:** rotating creates a new secret and keeps the previous one valid for **24 hours**; during the overlap both signatures are sent (`v1=<new>,v1=<old>`). Rotation is sensitive (re-auth) and audited.

### 11.5 Retries, backoff, dead letter, history

- Success = HTTP 2xx within the timeout. Anything else (non-2xx, timeout, TLS/DNS error, blocked address) is a failed attempt.
- Retry schedule with exponential backoff and ±20% jitter: **30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h, 24 h** (10 attempts over about two days). The job queue (`max_attempts`, `run_after`) carries the schedule. After the last attempt the delivery is **dead-lettered** (`status = dead`) and remains visible and re-deliverable.
- `webhook_deliveries` (one per event and endpoint) and `webhook_delivery_attempts` (one per try: time, status code, duration, error class, response excerpt) form the **delivery history**, kept 30 days (then redacted/purged by the existing cleanup job). The history never stores the signing secret.
- **Auto-disable:** an endpoint with 10 consecutive dead deliveries (or no success for 3 days under load) becomes `auto_disabled`; fan-out stops creating deliveries for it, the owners are notified and it is audited. Events skipped while disabled are **not** backfilled automatically; the history shows the gap and a replay from a chosen time is offered after re-enabling (bounded window).
- **Disable / re-enable:** manual disable is immediate; re-enabling needs `webhooks.manage` + re-authentication and runs a `ping` first. Manual **redelivery** of one delivery (including dead ones) is audited.

### 11.6 Tenant isolation and permissions

- `webhook_endpoints`, deliveries and attempts carry `organization_id` with composite foreign keys, RLS and no PUBLIC grants, like every tenant table. The delivery job runs under the endpoint's organization context only. A payload is built from that organization's data under RLS; there is no path by which another tenant's object can be placed in a delivery.
- Permissions: `webhooks.view` (list endpoints, history), `webhooks.manage` (create/edit/delete, rotate, disable/enable, redeliver, ping). Owner and Administrator hold both; Member holds neither. Secrets are never returned after creation or rotation.

## 12. Data model (additive; migrations from 0053)

`api_tokens`, `api_token_usage`, `public_api_settings` (per-organization enabled flag), `api_rate_windows`, `webhook_endpoints` (encrypted secret + previous secret + expiry), `webhook_event_types` (catalog), `webhook_deliveries`, `webhook_delivery_attempts`; extend `audit_events.actor_type`; new permission keys `api_tokens.view|manage`, `webhooks.view|manage` with the usual additive role backfill. No existing table or migration is changed except the audit actor check.

## 13. Provider-independent seams

| Interface                                                 | Default                                                    | Replaceable by          |
| --------------------------------------------------------- | ---------------------------------------------------------- | ----------------------- |
| `RateLimiter`                                             | PostgreSQL counters                                        | Redis, an API gateway   |
| `SecretCipher` (encrypt/decrypt webhook secrets, key ids) | AES-256-GCM with a key ring from environment configuration | a cloud KMS / HSM       |
| `WebhookTransport` (resolve, validate, pin, POST)         | Node `https` with a pinned lookup                          | an egress proxy service |
| `DomainEventSource`                                       | the existing outbox                                        | a message broker later  |
| `TokenStore`                                              | PostgreSQL                                                 | —                       |

All have in-memory test doubles; no handler imports a vendor SDK.

## 14. Documentation and OpenAPI

- `GET /public/v1/openapi.json` (OpenAPI 3.1) is generated from the response/request zod schemas of section 8; a CI check diffs it against the committed spec and fails on breaking changes inside `v1`.
- A human guide covers authentication, scopes, errors, pagination, idempotency, rate limits, the webhook catalog, signature verification samples, retry behavior and a changelog.

## 15. Test plan (required before merge)

Token hashing/expiry/revocation/IP rules; scope and creator-permission intersection; cross-tenant 404s for every endpoint; session/bearer surface separation; rate-limit headers and 429; idempotency replay/conflict; DTO golden files; cursor tampering; error mapping (no internal leakage); audit actor `api_token`; webhook SSRF matrix (private ranges, IPv6 forms, DNS rebinding with a swapped resolver, redirects, ports, userinfo); signature, timestamp skew and dual-secret rotation; retry/backoff schedule with a fake clock; dead-letter, redelivery, auto-disable and re-enable; delivery isolation per tenant; secret never in logs/responses; MFA/re-auth on sensitive actions; load test of the fan-out.

## 16. Decisions needed from review

1. Scope granularity and the exact first write set (section 3); confirm that **no ledger-posting scope** is in v1.
2. Tokens bound to the creator's current permissions (recommended) versus independent service permissions.
3. Rate-limit store (PostgreSQL counters first) and the default numbers in section 4.
4. Webhook payload default: **thin** or **full** (recommended default: thin for financial documents).
5. Secret-rotation overlap (24 h) and delivery history retention (30 days).
6. Auto-disable thresholds and whether a bounded replay after re-enable is required in v1.
7. Whether an IP allow-list per token is required in v1, and the egress-proxy requirement for production webhooks.
8. Event catalog for v1 (section 11.2), in particular whether any journal-level event may ever be public.
9. Whether OAuth 2.0 client-credentials or a sandbox/test mode is needed later (out of scope for v1).

## 17. Out of scope

Posting/voiding/approving documents through the API; file upload/download; user, role and settings management; tax returns and MIRA (blocked on statutory material); inbound webhooks; OAuth.
