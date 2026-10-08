# ADR 0011 — Public API (`/public/v1`) and webhooks (decisions FROZEN; implementation not started)

Status: **ALL NINE DECISIONS (D1–D9) ARE FROZEN (2026-10-08). Nothing is implemented, no migration exists and no code has been written.** Implementation starts only after the final pre-implementation audit (section 18) is approved. Sections marked _proposed_ below (section 18, and implementation sketches) are not decisions.

### Decision outcome

| ID    | Subject                                                                                                                            | State                                                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| D1    | No ledger-posting scope; draft-only write set; coarse `resource:read` / `resource:write`; scope names are public contracts         | **FROZEN** (3.1)                                     |
| D2    | Organization-owned service principal; webhook subscriptions bounded by the integration's read permissions                          | **FROZEN** (3.2)                                     |
| D3    | `RateLimit-*` headers, 429 and `Retry-After`; store and numbers configurable                                                       | **FROZEN contract** (4)                              |
| D4    | Thin payload default, full opt-in; envelope and mode names                                                                         | **FROZEN** (11.2)                                    |
| D5    | Secret overlap and history retention configurable (24 h / 30 d documented defaults)                                                | **FROZEN as configurable** (11.4, 11.5)              |
| D6    | Auto-disable after 10 consecutive dead deliveries or 3 days without success; re-enable needs re-auth and ping; no automatic replay | **FROZEN** (11.5)                                    |
| D7    | SSRF requirements; optional IP allow-list; egress proxy is guidance only                                                           | **FROZEN** (11.3)                                    |
| D8    | No journal events; `<resource>.<action>`; explicit voids; no global ordering; **the 27 event types**                               | **FROZEN** (11.2)                                    |
| D9    | OAuth and sandbox/test mode deferred; never an accounting test mode in a real organization                                         | **FROZEN** (17)                                      |
| Audit | `api_token` actor distinct from user, system, anonymous, through a new migration                                                   | **FROZEN direction; migration not written** (10, 18) |

Scope: a stable, versioned, token-authenticated HTTP API for external systems, and signed outbound webhooks. It reuses the existing outbox, job queue, idempotency service, audit trail, permission model, MFA and re-authentication. It exposes **public DTOs**, never internal tables or internal view models.

## 1. Principles

1. **Separate surface.** `/public/v1` is its own Fastify plugin with its own authentication hook, error mapper, rate limiter and DTOs. The internal `/api/v1` (cookie session + CSRF) never accepts bearer tokens, and `/public/v1` never accepts session cookies. No route is shared.
2. **A token is not a user and not a person.** It is bound to one organization and can do no more than its explicitly granted scopes allow. Its runtime authority is an **organization-owned service principal** (D2, section 3.2), never an employee.
3. **Additive only.** Inside `v1`, fields and endpoints are only added. Anything else is `v2`.
4. **DTOs are an explicit allow-list** (section 8). A new internal column is invisible to the public API until a DTO maps it.
5. **Provider independence.** Rate limiting, secret encryption, outbound HTTP and event sourcing sit behind small interfaces (section 13). No gateway, queue or KMS product is assumed.
6. **Everything is tenant-isolated by RLS first, then by code.** The organization comes from the token alone — never from a header, path or body.

## 2. Token model

| Item                 | Decision                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind                 | "API token", created in the web app by a user with `api_tokens.manage` (Owner and Administrator by default).                                                                                                                                                                                      |
| Format               | `itk_` + 8-char public id + `_` + 43-char base64url secret (256 bits of CSPRNG). The prefix lets secret scanners and log filters recognize it.                                                                                                                                                    |
| Storage              | Only `SHA-256(secret)` is stored (the secret has 256 bits of entropy, so a slow hash adds nothing) plus the public id, name, scopes, creator, organization, `created_at`, `expires_at`, `last_used_at`, `last_used_ip`, `revoked_at/by/reason`. Lookup is by public id, comparison constant-time. |
| Display              | The full token is shown **once**, at creation, in the response of the create call. It can never be revealed again; losing it means rotating. The list shows name, public id, scopes, expiry, last use.                                                                                            |
| Expiration           | Mandatory. Choices 30 / 90 / 180 / 365 days; default 90; maximum 365. Expired tokens are rejected (`401 token_expired`). The owner is notified (in-app and email) 14 and 3 days before expiry.                                                                                                    |
| Revocation           | Immediate: every request reads the token row, so revocation takes effect on the next request. Revoke needs `api_tokens.manage` + re-authentication and is audited with a reason. A token does **not** stop when the person who created it, or the responsible administrator, leaves (D2).         |
| Rotation             | Create a new token, switch the integration, revoke the old one. There is no in-place secret change. Up to 10 active tokens per organization.                                                                                                                                                      |
| Organization binding | Fixed at creation; a token never switches organizations.                                                                                                                                                                                                                                          |
| Network              | Optional per-token IP allow-list (CIDR). TLS only (HSTS); `Authorization: Bearer itk_…`. Tokens in query strings are rejected.                                                                                                                                                                    |
| Org switch           | The public API is **off by default**; an Owner enables it in organization settings (audited). Disabling it makes every token answer `403 api_disabled`.                                                                                                                                           |

Creating, rotating, revoking a token and changing a scope are **sensitive actions**: they need `api_tokens.manage`, a recent password confirmation (15 min) and, when the organization enforces MFA, a satisfied MFA step-up (existing `MFA_STEP_UP_REQUIRED` flow). The human actor is audited on every one of them. A token can never manage tokens or webhooks, change roles, approve anything, or perform a sensitive action.

## 3. Scopes and authorization

### 3.1 Scopes and the v1 write set — D1, FROZEN

- **v1 has no ledger-posting scope.** No public API scope may post, approve, void, refund, reverse, or otherwise directly mutate the accounting ledger. Nothing that today requires `*.issue`, `*.post`, `*.record`, `*.void`, `*.approve`, settings, period, reconciliation or re-authentication is reachable through a token.
- **The v1 write set creates and updates allowed draft resources only** (initial proposal: customers, items and draft invoices). A draft is turned into a ledger document only by a person in the web application. Adding write capabilities later is additive.
- **Scope model: coarse `resource:read` / `resource:write`** (for example `customers:read`, `customers:write`, `invoices:read`, `invoices:write` meaning drafts only). Each scope maps to a fixed list of existing internal permission keys; each endpoint declares the one scope it needs; the check runs before the handler and again inside the service (`requirePermission`).
- **Scope names are public compatibility contracts**: they can be added, never renamed, removed or widened in meaning inside `v1`.
- A token can never hold a scope outside the organization's **API policy** (section 3.2): a ceiling the organization sets on what any integration may be granted.

### 3.2 Token ownership and runtime permission model — D2, FROZEN: organization-owned service principal

**Frozen architecture**

1. API integrations (service principals) are **organization-owned, not employee-owned.**
2. Employee lifecycle (leaving, disabling, demotion) **never silently disables** an organization's integration.
3. The **responsible administrator** is a separate human relationship, recorded on the integration and reassignable by any holder of `api_tokens.manage`.
4. **Any holder of `api_tokens.manage` can revoke or disable any integration**, whoever created it.
5. Creating or changing an integration needs `api_tokens.manage` **plus re-authentication, and MFA step-up where the organization enforces it.** At that moment the actor may grant only scopes whose permission keys the actor currently holds. This is checked at configuration time only.
6. **Mandatory token expiry remains** (section 2).
7. The integration **never acts as a human** and never impersonates one.
8. The integration **cannot be an approver, an Owner or a normal interactive Member.**
9. The API authentication and audit identity is the **API token / service principal**, not the responsible administrator.
10. The human creator and the responsible administrator remain recorded as **human actors** for lifecycle actions (create, rotate, revoke, scope change, reassignment).

Scopes stay explicitly granted and are bounded by the organization's **API policy** (an Owner-managed ceiling: maximum scopes, whether write scopes are allowed, maximum token lifetime, whether IP allow-lists are mandatory).

**Service-principal representation (frozen):**

- The existing user/principal infrastructure is reused with an explicit **non-human service principal**: it is marked as non-human/service in the principal model, has **no password and no interactive login**, and is **not a fake human account.**
- Existing foreign-key columns (`created_by_user_id` and the like) may reference this principal where technically required. Existing RLS and organization-ownership semantics stay intact. Unrelated domain schemas are **not** changed, and no existing `created_by_user_id` column is redesigned unless genuinely required.
- A service principal can never be an Owner or an approver, and can never hold an interactive membership.
- Runtime identity stays distinguishable as `api_token` (section 10).

**Webhook rule (D2 addition, frozen):** _Webhook subscriptions may only subscribe to event types whose underlying resource read permission is granted to that integration._ The rule is checked when an endpoint is created or its subscriptions change, and again when events are fanned out (a later narrowing of the integration's scopes suspends the affected deliveries).

Comparison considered (kept for the record):

|                                         | 1. Creator-bound                              | 2. Independent service permissions                                    | 3. Organization-owned service principal                                                                                                                |
| --------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime authority                       | Scopes ∩ creator's current permissions        | Permission keys chosen at creation, stored on the token               | The integration (a named, organization-owned identity); scopes granted to it, capped by the organization's API policy                                  |
| Creator leaves, is disabled or demoted  | Token stops or narrows silently               | Token keeps working                                                   | Token keeps working; the integration shows its responsible administrator as needing reassignment                                                       |
| Privilege-escalation risk               | Lowest (never above the creator)              | Highest unless creation checks are strict; stale grants outlive roles | Low if the creator can grant **only scopes the creator currently holds** and the policy ceiling applies; no later elevation without a new human action |
| Independent revoke by any administrator | Yes, but the token also dies with its creator | Yes                                                                   | Yes — the integration is listed and revocable by any holder of `api_tokens.manage`, regardless of who created it                                       |
| Fit with the permission catalog         | Direct                                        | Needs a parallel permission store                                     | Reuses the catalog through the scope → permission-key map; needs an identity to attach to (see conflicts below)                                        |
| Audit                                   | Token + creator                               | Token + creator                                                       | Integration + token + the human who configured it; runtime actions attributed to the integration                                                       |
| Operational fragility                   | High                                          | Low                                                                   | Low                                                                                                                                                    |
| Main weakness                           | Breaks real integrations                      | Over-broad, drifting grants                                           | A new identity concept; orphaned long-lived credentials if nobody owns the integration                                                                 |

The earlier creator-bound proposal and the independent-permissions option are **not adopted.** The remaining mechanics (columns, constraints, migrations) are listed as _proposals_ in section 18 for the final pre-implementation audit.

## 4. Rate limiting

- Limits per token (token bucket): **600 requests/minute** for reads, **120/minute** for writes, plus a per-organization ceiling (**3,000/minute**) and a per-IP limit for unauthenticated failures (token guessing: 20/minute, then back-off). Limits are configurable per organization later.
- **FROZEN contract (D3, final):** responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a rejection is `429` with `Retry-After` (seconds until the client may retry) and the standard error body (section 9, `type: rate_limited`). These headers, the 429 semantics and the `Retry-After` behavior are public compatibility contracts. The **store and every numeric threshold remain configurable** and are not contracts.
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

- **Frozen direction:** public API activity is distinguishable from human activity, and the audit invariant distinguishes **`user`, `system`, `anonymous` and `api_token`.** A new audit actor type `api_token` is added through a **new migration only** (never editing migrations 0001–0039; the existing `user` / `system` / `anonymous` semantics and the `user` ⇔ `actor_user_id` rule are preserved, with the new type governed by its own consistency check and an `actor_token_id`/integration reference). The migration is **not written yet.** Every write through the public API is audited like a user write, with the integration and token ids, public id and IP; configuration actions (create, rotate, revoke, scope change) carry the human actor. Token lifecycle events (`api_token.created|revoked|expired|ip_blocked|scope_changed`, `public_api.enabled|disabled`) are audited and also recorded as security events.
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

### 11.2 Event rules and the v1 event catalog — D4 and D8, FROZEN

**Frozen rules**

- Public events are **document / business-resource level only.** Journal-level events, accounting-event events and system or realized-FX journals are **never public in v1.**
- Event type = `<resource>.<action>`. A void or cancellation is always its **own explicit event.** A single business operation may legitimately emit several related events (for example `expense_claim.voided` and `bill.voided`).
- **No global ordering guarantee.** Consumers must use the event id, `occurred_at`, the resource identity and, where applicable, its `version`, and must **reconcile by retrieving the current resource** instead of assuming event order. Delivery is at least once.
- **Event types are immutable public contracts**: additions are additive; removing or renaming a type is breaking (`v2`).
- Update events carry **no changed-field names** in v1; consumers retrieve the current resource.
- Vendor events apply to all vendor records **including employee vendor records**; there is no separate employee-vendor event family.
- **Envelope and mode names are FROZEN.** Envelope fields: `id` (the event id, `evt_…`), `type`, `api_version`, `occurred_at` (when the business change committed), `organization_id`, `resource` (`{ "type", "id", "version" }` where the resource has a version) and `data`. Payload mode per endpoint: **`thin`** (the default) or **`full`** (opt-in).
- **Thin** `data` = `{ "object_type", "object_id", "url" }` and nothing else. Retrieval through the URL is authorized exactly like any other API call (the integration's scopes, tenant isolation, RLS); a thin event grants nothing by itself.
- **Full** `data.object` is the versioned public DTO (section 8). It **never contains journal internals** (journal ids or numbers, accounting events, base-only or FX line mechanics, tax-snapshot internals, system-journal links) and is available only for resources whose read permission the integration holds.
- Opening documents (opening invoices, bills, vendor credits), imported drafts and draft-lifecycle changes emit **no** events.

**The frozen v1 catalog — 27 event types**

| Resource        | Event types                                                 |
| --------------- | ----------------------------------------------------------- |
| customer        | `customer.created`, `customer.updated`, `customer.archived` |
| vendor          | `vendor.created`, `vendor.updated`, `vendor.archived`       |
| item            | `item.created`, `item.updated`, `item.archived`             |
| invoice         | `invoice.issued`, `invoice.voided`                          |
| credit note     | `credit_note.issued`                                        |
| receipt         | `receipt.recorded`, `receipt.voided`                        |
| customer refund | `customer_refund.recorded`, `customer_refund.voided`        |
| bill            | `bill.posted`, `bill.voided`                                |
| vendor credit   | `vendor_credit.posted`, `vendor_credit.voided`              |
| vendor payment  | `vendor_payment.recorded`, `vendor_payment.voided`          |
| vendor refund   | `vendor_refund.recorded`, `vendor_refund.voided`            |
| expense claim   | `expense_claim.posted`, `expense_claim.voided`              |
| test            | `webhook.ping`                                              |

**Explicitly excluded from v1:** journal events; accounting-event events; `invoice.paid`; approval events; period events; banking transfer events; reconciliation events; opening and imported-draft events; purchase-order events; fixed-asset events; inventory events (also bank-transaction import, goods receipts, depreciation, `*.updated` for issued or posted documents, and user, role, organization and settings events). Purchase orders and fixed assets can be added later as additive contracts.

### 11.3 Endpoint rules and SSRF protection

**D7: the SSRF requirements below are FROZEN for v1.** The per-token IP allow-list is **optional**. A production egress proxy is **deployment/infrastructure guidance only**; the application's own SSRF protections (public-address-only resolution, IP pinning, no redirects, validation on create/update and on every delivery) **must be sufficient without any proxy** and may not rely on one.

- Created by `webhooks.manage` + re-authentication (+ MFA step-up when enforced). Max **10 endpoints** per organization; an endpoint subscribes to a list of event types; name, URL, status (`active`, `disabled`, `auto_disabled`), `api_version`, payload mode.
- **HTTPS only**, port 443 (allow-list configurable), no userinfo in the URL, host must be a DNS name — IP literals, `localhost` and internal suffixes (`.local`, `.internal`, `.lan`) are refused.
- Validated **on create/update and again on every delivery**: the hostname is resolved at delivery time and **every** returned address must be public (blocking loopback, RFC 1918, link-local incl. `169.254.169.254`, CGNAT `100.64.0.0/10`, multicast, reserved, IPv6 loopback/ULA/link-local, and IPv4-mapped IPv6 forms). The connection is made to the validated IP (pinned, preventing DNS-rebinding between check and connect) with the original hostname for TLS SNI and `Host`.
- **Redirects are never followed** (a 3xx is a failure). Connect timeout 5 s, total timeout 10 s; the response body is read up to 64 KB and only a 1 KB excerpt is stored. TLS certificate verification is mandatory (no opt-out). In production, deliveries should leave through a dedicated egress proxy/NAT with a stable IP list that customers can allow-list.
- A `webhook.ping` event can be sent on demand to test an endpoint.

### 11.4 Signing, timestamp and replay protection

- Per-endpoint secret `whsec_…` (256-bit CSPRNG), **shown once** at creation. It must be recoverable to sign, so it is stored **encrypted** (AES-256-GCM, key id + key from `SecretCipher`, section 13), never logged.
- Headers: `Intuit-Webhook-Id` (the delivery id, stable across retries), `Intuit-Webhook-Event`, `Intuit-Webhook-Timestamp` (Unix seconds, refreshed on every attempt) and `Intuit-Webhook-Signature: t=<ts>,v1=<hex>`.
- `v1 = HMAC-SHA256(secret, "<timestamp>.<delivery id>.<raw body>")`. Consumers must verify against the **raw** body, compare in constant time, **reject timestamps older than 5 minutes** (replay window) and **deduplicate on the event id**. The documentation ships verification samples for common languages.
- **Secret rotation:** rotating creates a new secret and keeps the previous one valid for an overlap that is **configurable** (default **24 hours**, a documented default and not a compatibility contract); during the overlap both signatures are sent (`v1=<new>,v1=<old>`). Rotation is sensitive (re-auth) and audited.

### 11.5 Retries, backoff, dead letter, history

- Success = HTTP 2xx within the timeout. Anything else (non-2xx, timeout, TLS/DNS error, blocked address) is a failed attempt.
- Retry schedule with exponential backoff and ±20% jitter: **30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h, 24 h** (10 attempts over about two days). The job queue (`max_attempts`, `run_after`) carries the schedule. After the last attempt the delivery is **dead-lettered** (`status = dead`) and remains visible and re-deliverable.
- `webhook_deliveries` (one per event and endpoint) and `webhook_delivery_attempts` (one per try: time, status code, duration, error class, response excerpt) form the **delivery history**, kept for a **configurable** retention (default **30 days**, not a compatibility contract; then redacted/purged by the existing cleanup job). The history never stores the signing secret.
- **Auto-disable (D6, frozen):** an endpoint is set to `auto_disabled` after **10 consecutive failed deliveries or 3 days without a successful delivery**, whichever comes first; fan-out stops creating deliveries for it, the owners are notified and it is audited. **Frozen meaning:** a _failed delivery_ for auto-disable counting is a delivery that has **exhausted its configured retry attempts and been dead-lettered**; individual retry attempts are **not** counted as separate failed deliveries, and a successful delivery resets the consecutive count. **There is no automatic replay-from-time in v1**: events produced while an endpoint is disabled are not backfilled. Webhook delivery is **not a guaranteed historical backfill mechanism**; the pull API (`updated_since`, section 7) is the **authoritative reconciliation path**, and the documentation must say so. The history shows the gap.
- **Disable / re-enable:** manual disable is immediate; re-enabling needs `webhooks.manage` + re-authentication and a successful `ping` first. Manual **redelivery of an individual delivery** (including dead ones) may exist and is audited.

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

## 16. Decision register

All of D1–D9 and the audit-actor direction are **FROZEN** (see the outcome table at the top). The open items are implementation-level and are listed in section 18 for the final pre-implementation audit; they are proposals, not decisions.

## 17. Out of scope (D9, frozen)

Posting/voiding/approving/refunding/reversing documents through the API (D1); OAuth 2.0 client credentials and any sandbox or test mode inside a real organization (D9 — **a flag that changes accounting behavior inside a real organization is never to be created**); file upload/download; user, role and settings management; tax returns and MIRA (blocked on statutory material); inbound webhooks; OAuth.

## 18. Pre-implementation consistency audit (architecture only; everything here is a proposal)

Checked against the repository at `2ee3484` (code and migrations read, nothing changed). Items below are **proposals for the final pre-implementation audit**, not decisions beyond D1–D9.

### 18.1 Remaining contradictions with the existing architecture

1. **`users` cannot hold a service principal today.** `users.email`, `email_normalized` and `password_hash` are `NOT NULL`, `password_hash` must start with `$argon2id$`, and `email_normalized` is unique. A non-human principal with no password and no e-mail needs these relaxed **for service principals only**, by a new migration (migration 0001 is never edited).
2. **`Principal` and `withOrganization` are session-based.** `Principal = { user, session }`; `withOrganization` resolves the organization from `session.activeOrganizationId`, looks the membership up, enforces organization MFA on the session and applies the re-authentication window. A token has no session. The repository already has a precedent for a session-less context: `resolveActingUserContext` (background jobs, `sessionId: null`). The public API needs an equivalent `resolveIntegrationContext` (organization taken from the token only), not a change to the interactive path.
3. **MFA policy would block a service principal.** `enforceActingUserMfa` fails for any member whose role requires MFA and who has no enrolled factor. Service principals must be exempt by kind (they hold no roles, so the privileged-role rule does not apply, but the organization-wide policy would).
4. **Audit invariant.** `audit_events` allows `actor_type IN ('user','system','anonymous')` with `(actor_type = 'user') = (actor_user_id IS NOT NULL)`. A runtime write by an integration cannot be recorded as `user` without hiding the distinction D2 requires. Needs a new migration (18.6).
5. **Members, invitations and approvals assume humans.** `listOrganizationMemberships` (organization-service) lists every membership; role assignment, disable/enable, invitations, per-member MFA status and "seats" would show or act on service principals unless filtered. Approval steps are eligible by role (`approval_step_eligible_roles`) and, where used, explicit memberships; a service principal must be excluded by construction.
6. **Envelope field names.** The earlier draft envelope used `created_at`; the D8 decision requires `event_id`, `occurred_at` and resource identity/version. Section 11.2 now freezes `id`, `occurred_at`, `resource`. Confirm in this audit that this reading matches the intended frozen envelope.
7. **Full-payload snapshots versus fan-out time.** If the DTO is built when events are fanned out (asynchronously) it can reflect a later state than the event. Needs the rule in 18.9.
8. **Idempotency table.** `idempotency_keys` is unique on `(organization_id, scope, idempotency_key)` and a replay must come from the same `user_id`. Two integrations in one organization using the same key and scope would collide (18.7).
9. **No existing rate limiter and no outbound-HTTP client with address pinning** (only login back-off exists). Both are new components behind the interfaces of section 13, not extensions of existing code.

None of these requires editing migrations 0001–0039 or redesigning domain tables.

### 18.2 Existing tables and columns affected by the service-principal representation

**Schema changes (proposed):**

| Table                                                                                         | Change                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                                                                                       | new `kind` (`human` / `service`, default `human`); `email`, `email_normalized`, `password_hash` become nullable with CHECKs that require them for `human` and forbid them for `service`; `display_name` carries the integration name. The unique e-mail index is unaffected (nulls do not collide). |
| `memberships`                                                                                 | no column change. A service principal has exactly one membership (it is the object permissions and `membership_id` references hang from); a trigger forbids a service membership from being used where a human is required (below).                                                                 |
| `membership_roles`                                                                            | guard trigger: a service membership can hold **no** role (so never Owner, never a role-based approver). Its permissions come from its scopes, not roles.                                                                                                                                            |
| approval eligibility tables (`approval_step_eligible_roles`, any explicit-member eligibility) | guard: a service membership can never be listed as an approver.                                                                                                                                                                                                                                     |
| `audit_events`                                                                                | `actor_type` gains `api_token`; new `actor_token_id`; replacement consistency check (18.6).                                                                                                                                                                                                         |
| `security_events`                                                                             | no change needed (`user_id` is nullable); token events use metadata and, optionally, the service user id.                                                                                                                                                                                           |
| `idempotency_keys`                                                                            | no column change (18.7).                                                                                                                                                                                                                                                                            |

**Columns that will simply hold the service principal's user id (no schema change):** the roughly 160 `*_by_user_id uuid REFERENCES users` columns across the migrations (for example `created_by_user_id` and `updated_by_user_id` on customers, vendors, items and draft invoices; `created_by_user_id` on `jobs`; `requested_by_user_id` on `approval_requests`; `idempotency_keys.user_id`). Their foreign keys, RLS policies and organization ownership are untouched; `NOT NULL` constraints are satisfied by the principal's id.

**Code paths that must treat `kind = 'service'` specially:** sign-in and password reset (a service principal can never authenticate with a password; the generic failure is kept), session creation, member lists and counts, invitations, role assignment, membership disable/enable UI, per-member MFA status, `resolveActingUserContext` (a service principal is not resolved as a background-job user), approval-eligibility resolution.

### 18.3 Proposed service-principal and integration schema (new tables, by purpose)

- **`api_integrations`**: the organization-owned integration. Organization, name, description, status (`active`, `disabled`, `revoked`), the service principal's `user_id` and `membership_id`, the **responsible administrator** (a membership, nullable when unassigned, reassignable), creator and timestamps (human actors), `disabled/revoked` by and reason.
- **`api_integration_scopes`**: the scopes granted to the integration (one row per scope), with who granted them and when. Scope names are the public contract of D1.
- **`api_tokens`**: tokens of an integration (public id, SHA-256 of the secret, expiry, last use and IP, optional IP allow-list, revoked by/at/reason). Several tokens per integration allow rotation without downtime.
- **`public_api_settings`**: per-organization switch and API policy (maximum scopes, write scopes allowed, maximum token lifetime, IP allow-list required).
- **`api_token_usage`** and **`api_rate_windows`**: aggregates and rate-limit counters.
- **Webhooks:** `webhook_endpoints` (organization, optionally the integration it belongs to, URL, subscribed event types, payload mode, status, encrypted current and previous secrets), `webhook_deliveries`, `webhook_delivery_attempts`.

All with `organization_id`, composite foreign keys, RLS, no PUBLIC grants, no TRUNCATE, like every tenant table.

### 18.4 Proposed new migrations (purpose only; none created)

1. **Service principal kind**: `users.kind` and the relaxed constraints, guards on `membership_roles` and approval eligibility, sign-in refusal support.
2. **Audit actor**: `audit_events` gains `api_token`, `actor_token_id` and the four-way consistency check; unchanged semantics for `user`, `system`, `anonymous`.
3. **Public API core**: `public_api_settings`, `api_integrations`, scopes, tokens, usage, rate windows, the four permission keys and the additive role backfill.
4. **Webhooks**: endpoints, deliveries, attempts, the event-type catalog table and the subscription link.
5. **(If chosen in 18.9)** nothing for event emission itself: events reuse `outbox_events`.

Numbering continues from 0053 and each is independent and additive. Migrations 0001–0039 are never modified.

### 18.5 Permission keys required

New keys: `api_tokens.view`, `api_tokens.manage`, `webhooks.view`, `webhooks.manage`. Proposed, to be confirmed: `public_api.settings.manage` for the Owner-only switch and API policy (otherwise folded into `api_tokens.manage` with an Owner check). Owner and Administrator hold them; Member holds the two `.view` keys at most (decision to confirm). Each gets the usual additive backfill with audit events, and the permission counts in the existing role tests change accordingly. **Scopes map onto existing permission keys** (for example `invoices:read` → `invoices.view`, `customers:write` → `customers.create`/`customers.update`, `invoices:write` → `invoices.create`/`invoices.edit_draft`); no scope maps to any `*.issue`, `*.post`, `*.record`, `*.void`, `*.approve` or settings key.

### 18.6 Audit changes required

- `audit_events.actor_type` adds `api_token`; new `actor_token_id`; check: `user` ⇒ `actor_user_id` set and `actor_token_id` null; `api_token` ⇒ `actor_token_id` set and `actor_user_id` null; `system`/`anonymous` ⇒ both null.
- The single insertion point is `recordAuditEvent` (about 82 call sites pass `actorUserId: ctx.userId`). Two ways to attribute runtime writes: (a) a database trigger that, when the session variable `app.api_token_id` (set by `setDbContext`) is present, normalizes the row to `api_token`; (b) every call site passes the token. **Proposal: (a)**, so no call site changes and an integration can never be recorded as a user. To be confirmed in the audit.
- Lifecycle actions (integration created/changed/revoked/reassigned, token created/rotated/revoked, scope change, webhook endpoint changes, API enabled/disabled) are recorded with the **human** actor (`user`), plus the integration id in metadata.
- Audit viewers and exports must display the new type; security events record token authentication failures without revealing whether a public id exists.

### 18.7 Idempotency identity changes required

- Keep `IdempotencyService` and the table; the owner (`user_id`) is the integration's service principal. Replay requires the same principal, which matches D2 (all tokens of one integration share the namespace, so a retry after token rotation still replays).
- **Isolate integrations from each other:** include a short integration id in the scope (for example `public.<integration>.<resource>.<action>`; the scope pattern and the 100-character limit allow it) so one integration cannot see or collide with another's keys. Otherwise an unrelated integration reusing a key in the same scope receives a conflict that reveals its existence.
- Retention stays the existing 24 hours (`IDEMPOTENCY_RETENTION_MS`); the key is required on every public write.

### 18.8 Webhook permission and subscription checks required

1. **Create/update endpoint:** `webhooks.manage` + re-authentication (+ MFA step-up where enforced); every subscribed event type must map to a resource whose **read permission the integration holds** (the D2 rule); an unsubscribable type is refused with a clear error. The acting human must hold the same read permission (so nobody can subscribe to what they cannot see).
2. **Fan-out time:** re-check the integration's current scopes; if a scope was narrowed or the integration is disabled or revoked, no delivery is created for those types. Full-mode payloads are built only for resources the integration may read.
3. **Delivery time:** re-validate the destination (SSRF, 11.3) and the endpoint status; thin retrieval is authorized by the API at call time.
4. **Tenant isolation:** the organization of an endpoint, a delivery and its payload must match; the job runs in that organization's context only.

### 18.9 Event-emission integration points (proposed; do not implement until approved)

Mechanism: an optional, additive publisher passed as a trailing constructor parameter (the pattern already used for `InventoryHooks` and `PurchaseOrderHooks`), which enqueues an outbox row in the **same transaction** with an internal type namespace (for example `public.invoice.issued`) so nothing existing subscribes to it. The payload holds only the event id, type, `occurred_at`, resource type, id and `version`.

| Event types                                   | Service methods that commit the change                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer.*`, `vendor.*`, `item.*`            | create, update and archive paths of `CustomerService`, `VendorService`, `ItemService`, including their `createInTransaction` variants (so an employee's vendor record created by an expense claim, and imports, emit consistently) |
| `invoice.issued/voided`, `credit_note.issued` | `InvoiceService` issue and void; `CreditNoteService` issue                                                                                                                                                                         |
| `receipt.recorded/voided`                     | `ReceiptService` record and void                                                                                                                                                                                                   |
| `customer_refund.*`                           | `CustomerRefundService` record and void                                                                                                                                                                                            |
| `bill.posted/voided`                          | `BillService` post (also reached by expense claims and, in-transaction, batch payments' bills) and void                                                                                                                            |
| `vendor_credit.*`                             | `VendorCreditService` post and void                                                                                                                                                                                                |
| `vendor_payment.*`                            | `VendorPaymentService.recordInTransaction` (also used by Pay bills batches, so one event per payment) and void                                                                                                                     |
| `vendor_refund.*`                             | `VendorRefundService` record and void                                                                                                                                                                                              |
| `expense_claim.posted/voided`                 | `ExpenseClaimService` post and void (a void also emits `bill.voided` through `BillService`, which is intended)                                                                                                                     |

Rules: skip bills, invoices and vendor credits of kind `opening` and imported drafts; emit only when the transaction commits (it is part of the transaction); never emit for revaluation, journal, banking, inventory, fixed-asset or approval activity. **Full-mode snapshot rule (proposal):** the emitter records resource id and `version` only; the fan-out builds the DTO for `full` endpoints and includes the `version`, and a consumer who finds a newer version re-reads the resource. The documentation states that a full payload is "the state at or after the event", never a guaranteed historical snapshot.

### 18.10 Remaining accounting and security risks

- **Accounting:** none of the frozen v1 scopes can post, void or reverse, so the ledger chain (source document, accounting event, journal, GL) is untouched. Remaining care points: API-created drafts must be identifiable by origin in the UI; draft creation must reuse the service rules (numbering, tax snapshots, FX, dimensions) and add no parallel logic; adding emit hooks must not change any posting service's behavior (regression tests on every touched service); event volume from bulk imports needs an explicit decision (emit per record or suppress during import).
- **Security:** a long-lived organization-owned credential with no human owner: mitigated by mandatory expiry, a responsible administrator of record, reminders to all `api_tokens.manage` holders and independent revocation. A service principal in `users` increases the blast radius of any code path that assumes "every user can sign in": every identity lookup that selects users must be reviewed (sign-in, reset, invitations, member and MFA lists, approvals) and covered by tests. SSRF, signing, secret encryption and rate limiting are new, security-critical components that need dedicated tests (section 15). Audit attribution through a trigger must be tested so an integration can never appear as a user.
- **Compatibility:** scope names, event types, the envelope, `RateLimit-*` and the 429 contract become public the day the first external customer connects; they are frozen precisely for that reason.

**Next step:** the final pre-implementation audit approves 18.1–18.10 (in particular 18.1 item 6, 18.6 option (a), 18.7 and 18.9). No implementation, migration or code change happens before then.
