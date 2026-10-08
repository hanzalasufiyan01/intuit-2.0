# ADR 0011 — Public API (`/public/v1`) and webhooks (decisions FROZEN; implementation not started)

Status: **ADR 0011 IS FULLY FROZEN (2026-10-08): D1–D9, section 19 and the D2 policy wording are approved. Nothing is implemented, no migration exists and no code has been written.** The final pre-implementation audit (sections 18 and 19) is approved, so implementation may begin in the order of section 19.10. Sections marked _proposed_ below (section 18, and implementation sketches) are not decisions.

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
| Org switch           | **None in v1** (section 19.3): the API is available once an integration with a token exists; the emergency stop is revoking or disabling integrations.                                                                                                                                            |

Creating, rotating, revoking a token and changing a scope are **sensitive actions**: they need `api_tokens.manage`, a recent password confirmation (15 min) and, when the organization enforces MFA, a satisfied MFA step-up (existing `MFA_STEP_UP_REQUIRED` flow). The human actor is audited on every one of them. A token can never manage tokens or webhooks, change roles, approve anything, or perform a sensitive action.

## 3. Scopes and authorization

### 3.1 Scopes and the v1 write set — D1, FROZEN

- **v1 has no ledger-posting scope.** No public API scope may post, approve, void, refund, reverse, or otherwise directly mutate the accounting ledger. Nothing that today requires `*.issue`, `*.post`, `*.record`, `*.void`, `*.approve`, settings, period, reconciliation or re-authentication is reachable through a token.
- **The v1 write set creates and updates allowed draft resources only** (initial proposal: customers, items and draft invoices). A draft is turned into a ledger document only by a person in the web application. Adding write capabilities later is additive.
- **Scope model: coarse `resource:read` / `resource:write`** (for example `customers:read`, `customers:write`, `invoices:read`, `invoices:write` meaning drafts only). Each scope maps to a fixed list of existing internal permission keys; each endpoint declares the one scope it needs; the check runs before the handler and again inside the service (`requirePermission`).
- **Scope names are public compatibility contracts**: they can be added, never renamed, removed or widened in meaning inside `v1`.
- A token can never hold a scope outside the platform's **fixed Public API policy** (section 3.2, 19.3).

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

Scopes stay explicitly granted. **Frozen wording (D2): In v1, integration scopes are bounded by the platform's fixed Public API policy and the existing organization permission model. There is no separate editable per-organization API policy.** Organization administrators control which integrations exist, their scopes, the responsible administrator, token expiry and revocation, and integration/webhook management according to the frozen permissions. The fixed platform policy is: the v1 scope list, writes limited to the D1 draft set, and a maximum token lifetime of 365 days. There is no `public_api.settings.manage` permission, no `public_api_settings` table and no per-organization API policy engine.

**Service-principal representation (frozen):**

- The existing user/principal infrastructure is reused with an explicit **non-human service principal**: it is marked as non-human/service in the principal model, has **no password and no interactive login**, and is **not a fake human account.**
- Existing foreign-key columns (`created_by_user_id` and the like) may reference this principal where technically required. Existing RLS and organization-ownership semantics stay intact. Unrelated domain schemas are **not** changed, and no existing `created_by_user_id` column is redesigned unless genuinely required.
- A service principal can never be an Owner or an approver, and can never hold an interactive membership.
- Runtime identity stays distinguishable as `api_token` (section 10).

**Webhook rule (D2 addition, frozen):** _Webhook subscriptions may only subscribe to event types whose underlying resource read permission is granted to that integration._ The rule is checked when an endpoint is created or its subscriptions change, and again when events are fanned out (a later narrowing of the integration's scopes suspends the affected deliveries).

Comparison considered (kept for the record):

|                                         | 1. Creator-bound                              | 2. Independent service permissions                                    | 3. Organization-owned service principal                                                                                                                                        |
| --------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime authority                       | Scopes ∩ creator's current permissions        | Permission keys chosen at creation, stored on the token               | The integration (a named, organization-owned identity); scopes granted to it, bounded by the platform's fixed Public API policy and the existing organization permission model |
| Creator leaves, is disabled or demoted  | Token stops or narrows silently               | Token keeps working                                                   | Token keeps working; the integration shows its responsible administrator as needing reassignment                                                                               |
| Privilege-escalation risk               | Lowest (never above the creator)              | Highest unless creation checks are strict; stale grants outlive roles | Low if the creator can grant **only scopes the creator currently holds** and the policy ceiling applies; no later elevation without a new human action                         |
| Independent revoke by any administrator | Yes, but the token also dies with its creator | Yes                                                                   | Yes — the integration is listed and revocable by any holder of `api_tokens.manage`, regardless of who created it                                                               |
| Fit with the permission catalog         | Direct                                        | Needs a parallel permission store                                     | Reuses the catalog through the scope → permission-key map; needs an identity to attach to (see conflicts below)                                                                |
| Audit                                   | Token + creator                               | Token + creator                                                       | Integration + token + the human who configured it; runtime actions attributed to the integration                                                                               |
| Operational fragility                   | High                                          | Low                                                                   | Low                                                                                                                                                                            |
| Main weakness                           | Breaks real integrations                      | Over-broad, drifting grants                                           | A new identity concept; orphaned long-lived credentials if nobody owns the integration                                                                                         |

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
- **Envelope and mode names are FROZEN** (final form in section 19.1): `id` (the immutable unique **event** id, never the resource id), `type`, `api_version`, `occurred_at`, `organization_id`, `resource` (`{ "type", "id", "version" }`) and `data`. `created_at` is not a public envelope field. Payload mode per endpoint: **`thin`** (the default) or **`full`** (opt-in).
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

`api_integrations` (+ scopes), `api_tokens`, `api_token_usage`, `api_rate_windows`, `webhook_endpoints` (encrypted secret + previous secret + expiry), `webhook_event_types` (catalog), `webhook_deliveries`, `webhook_delivery_attempts`; extend `audit_events` with the `api_token` actor (section 19.5); new permission keys `api_tokens.view|manage`, `webhooks.view|manage` with the usual additive role backfill (no `public_api_settings` table and no settings permission in v1, section 19.3). No existing table or migration is changed except the audit actor check and the `users` kind (section 19.2).

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
6. **Envelope field names.** Resolved and frozen in section 19.1 (`id`, `occurred_at`, `resource`; no `created_at`).
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
| `audit_events`                                                                                | `actor_type` gains `api_token` with integration/token columns and an integrity trigger that verifies attribution (final design in section 19.5).                                                                                                                                                    |
| `security_events`                                                                             | no change needed (`user_id` is nullable); token events use metadata and, optionally, the service user id.                                                                                                                                                                                           |
| `idempotency_keys`                                                                            | no column change (18.7).                                                                                                                                                                                                                                                                            |

**Columns that will simply hold the service principal's user id (no schema change):** the roughly 160 `*_by_user_id uuid REFERENCES users` columns across the migrations (for example `created_by_user_id` and `updated_by_user_id` on customers, vendors, items and draft invoices; `created_by_user_id` on `jobs`; `requested_by_user_id` on `approval_requests`; `idempotency_keys.user_id`). Their foreign keys, RLS policies and organization ownership are untouched; `NOT NULL` constraints are satisfied by the principal's id.

**Code paths that must treat `kind = 'service'` specially:** sign-in and password reset (a service principal can never authenticate with a password; the generic failure is kept), session creation, member lists and counts, invitations, role assignment, membership disable/enable UI, per-member MFA status, `resolveActingUserContext` (a service principal is not resolved as a background-job user), approval-eligibility resolution.

### 18.3 Proposed service-principal and integration schema (new tables, by purpose)

- **`api_integrations`**: the organization-owned integration. Organization, name, description, status (`active`, `disabled`, `revoked`), the service principal's `user_id` and `membership_id`, the **responsible administrator** (a membership, nullable when unassigned, reassignable), creator and timestamps (human actors), `disabled/revoked` by and reason.
- **`api_integration_scopes`**: the scopes granted to the integration (one row per scope), with who granted them and when. Scope names are the public contract of D1.
- **`api_tokens`**: tokens of an integration (public id, SHA-256 of the secret, expiry, last use and IP, optional IP allow-list, revoked by/at/reason). Several tokens per integration allow rotation without downtime.
- **No `public_api_settings` table in v1** (section 19.3): the API policy is a fixed platform policy.
- **`api_token_usage`** and **`api_rate_windows`**: aggregates and rate-limit counters.
- **Webhooks:** `webhook_endpoints` (organization, optionally the integration it belongs to, URL, subscribed event types, payload mode, status, encrypted current and previous secrets), `webhook_deliveries`, `webhook_delivery_attempts`.

All with `organization_id`, composite foreign keys, RLS, no PUBLIC grants, no TRUNCATE, like every tenant table.

### 18.4 Proposed new migrations (purpose only; none created)

1. **Service principal kind**: `users.kind` and the relaxed constraints, guards on `membership_roles` and approval eligibility, sign-in refusal support.
2. **Audit actor**: `audit_events` gains `api_token`, `actor_token_id` and the four-way consistency check; unchanged semantics for `user`, `system`, `anonymous`.
3. **Public API core**: `api_integrations`, scopes, tokens, usage, rate windows, the four permission keys and the additive role backfill (no settings table, section 19.3).
4. **Webhooks**: endpoints, deliveries, attempts, the event-type catalog table and the subscription link.
5. **(If chosen in 18.9)** nothing for event emission itself: events reuse `outbox_events`.

Numbering continues from 0053 and each is independent and additive. Migrations 0001–0039 are never modified.

### 18.5 Permission keys required

Frozen keys (section 19.3): `api_tokens.view`, `api_tokens.manage`, `webhooks.view`, `webhooks.manage`. **`public_api.settings.manage` is not added in v1.** Owner and Administrator hold them; Member holds the two `.view` keys at most (to confirm). Each gets the usual additive backfill with audit events, and the permission counts in the existing role tests change accordingly. **Scopes map onto existing permission keys** (for example `invoices:read` → `invoices.view`, `customers:write` → `customers.create`/`customers.update`, `invoices:write` → `invoices.create`/`invoices.edit_draft`); no scope maps to any `*.issue`, `*.post`, `*.record`, `*.void`, `*.approve` or settings key.

### 18.6 Audit changes required

- **Superseded by section 19.5.** Final row shape: `api_token` ⇒ `actor_user_id` = the service principal, plus `actor_integration_id` (and optionally `actor_token_id`); attribution is derived from the identity in `recordAuditEvent` and enforced by an integrity trigger that verifies, never rewrites.
- Attribution mechanism: see the comparison and recommendation in section 19.5 (identity-derived attribution enforced by a database invariant; not a session-variable trigger).
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

**Next step:** section 19 is the final gate; implementation starts only after it is approved.

## 19. Final pre-implementation audit — clarifications (2026-10-08)

This section is the last architecture gate. Where it differs from section 18, **this section governs**; the affected lines of sections 2, 11.2 and 18 were updated to point here. Everything below is architecture only: no implementation, migration or code exists.

### 19.1 Public event envelope — FROZEN

```json
{
  "id": "evt_…",
  "type": "invoice.issued",
  "api_version": "v1",
  "occurred_at": "2026-10-08T09:30:12.431Z",
  "organization_id": "…",
  "resource": { "type": "invoice", "id": "…", "version": 3 },
  "data": { … }
}
```

- `id` is the **immutable, unique event id.** It is **not** the resource id: the resource is identified only by `resource.type` and `resource.id`. An event id is never reused, never changes across retries or redelivery, and is the consumer's de-duplication key.
- `occurred_at` is when the originating business change committed.
- `resource.version` is the resource's own version (omitted only for resources that have none).
- `created_at` is **not** part of the public envelope and there is no documented compatibility reason to keep it. (Internal delivery timestamps live in the delivery history, not in the payload.)
- The webhook header `Intuit-Webhook-Id` identifies the **delivery** (stable across that delivery's retries); the event id is in the body. A redelivery of the same delivery keeps both.

### 19.2 Service principal — strengthened invariant

The human-user security invariants are **not weakened globally.** The distinction is enforced in the database by explicit constraints, not only in code.

**Proposed shape (for the future migration; nothing created):**

- `users.kind text NOT NULL DEFAULT 'human' CHECK (kind IN ('human','service'))`, **immutable** after insert (guard trigger).
- `email`, `email_normalized` and `password_hash` may become nullable at the storage level **only together with** a CHECK that makes the distinction exact:
  - `kind = 'human'` ⇒ `email`, `email_normalized` and `password_hash` are all `NOT NULL`, with every existing format rule (length, `email_normalized = lower(btrim(...))`, `$argon2id$` prefix) still applying;
  - `kind = 'service'` ⇒ `email`, `email_normalized` and `password_hash` are all `NULL`.
    A human therefore cannot omit any of them, and a service principal cannot carry any of them. The existing unique e-mail rule is unchanged for humans.
- **Service principal rules, each with a database guard and a service-level check:**
  - no interactive login, no password authentication, no password reset, no normal session: a trigger refuses `sessions` and `password_reset_tokens` rows for a service user, sign-in and reset refuse it explicitly (with the existing generic failure), and no MFA factor can be enrolled for it;
  - **cannot be Owner, cannot hold any role** (`membership_roles` guard), **cannot be an approver** (approval eligibility guards and the approver-resolution query exclude it), **cannot be an interactive Member**: exactly one membership, in its own organization, created only by the integration service;
  - **not usable as a human** by member, invitation or role flows: member lists, invitation acceptance, role assignment, membership disable/enable, per-member MFA status and seat counts filter or refuse `kind = 'service'`;
  - `kind` and the one-membership rule are tested at the database level (negative tests that insert a human with no password, a service with a password, a service with a role, a service in an approval step).

### 19.3 Public API settings permission — `public_api.settings.manage` NOT added

There is no existing requirement for an organization-wide enable/disable switch, so **v1 does not add `public_api.settings.manage` and does not add a `public_api_settings` table.**

- Frozen permission keys: **`api_tokens.view`, `api_tokens.manage`, `webhooks.view`, `webhooks.manage`.** Scopes keep mapping to existing resource permissions.
- Consequences: the public API is available in an organization once an integration with a token exists; creating the first integration (`api_tokens.manage`, re-authentication, MFA step-up where enforced) is the gate. There is no `api_disabled` organization state. The organization-level emergency stop is **revoking or disabling integrations** (any `api_tokens.manage` holder).
- **D2 wording (FROZEN, final):** "In v1, integration scopes are bounded by the platform's fixed Public API policy and the existing organization permission model. There is no separate editable per-organization API policy." The fixed platform policy is the v1 scope list, writes limited to the D1 draft set, and tokens that expire within 365 days; it lives in configuration and is not editable per organization. Organization administrators control which integrations exist, integration scopes, the responsible administrator, token expiry and revocation, and integration and webhook management according to the frozen permissions. Not added in v1: `public_api.settings.manage`, `public_api_settings`, any per-organization API policy engine. A per-organization policy would need a new, separately approved decision.

### 19.4 Bulk-import event semantics — resolved

- A bulk import that creates actual, active/posted resources emits the **normal per-resource events**: 5,000 customers created by an import emit 5,000 `customer.created` events. **No bulk-import event semantic exists in v1.**
- The existing rule stands: **imported drafts emit nothing** (imported purchase and opening drafts, draft invoices), as do opening documents.
- **The import never waits for webhook delivery.** The import's commit transaction only inserts outbox rows (the same atomic insert every event uses); delivery happens later through the existing outbox dispatcher and job queue. A 5,000-row import adds 5,000 small outbox rows to its own transaction and returns.
- **Batching and backpressure to document and implement with the fan-out** (the outbox today has no subscribers and marks every event processed, so these are new behaviors of the first real subscriber):
  1. **Cheap short-circuit:** the fan-out looks up the organization's active, subscribed endpoints once per batch; events with no subscribed endpoint are marked processed without creating any delivery. Emission may also skip the outbox insert when the organization has no endpoint (a per-transaction cached check), which keeps volume down for organizations that do not use webhooks.
  2. **Bounded dispatch:** the dispatcher already claims at most `outbox.batchSize` events per poll (`FOR UPDATE SKIP LOCKED`, safe with several workers); fan-out work per event is small (rows, no HTTP). The `eventTypes` filter added to the dispatcher lets the webhook fan-out claim only public event types.
  3. **Per-organization fairness:** claim order is `available_at, created_at`, so one organization's large import could delay others. The fan-out batch is capped per organization (round-robin across organizations within a batch) so no organization can monopolize it.
  4. **Delivery throttling:** deliveries are jobs with `run_after`; a per-endpoint concurrency and rate cap (configurable, default a few deliveries per second, concurrency 1 for ordering-insensitive endpoints) spaces a burst out instead of hammering the consumer.
  5. **Queue ceiling:** a per-endpoint cap on undelivered deliveries (configurable). Beyond it, new deliveries for that endpoint are dead-lettered immediately as `queue_full` (counted toward D6 auto-disable) rather than growing without bound; the consumer reconciles through the pull API.
  6. **Retention:** processed outbox rows and delivery history follow the existing cleanup jobs.

### 19.5 Audit actor — architecture comparison and recommendation

Context: `recordAuditEvent` is the single insertion point (about 82 call sites pass `actorUserId: ctx.userId`); the `audit_events` actor check currently allows `user`, `system`, `anonymous`. The runtime principal of a public API request is a service principal whose `users` row is `kind = 'service'`.

| Criterion                                  | A. Application-level actor resolution in `recordAuditEvent`                                                                                                                               | B. Request/application context carries the token identity                                                                 | C. Database trigger driven by a session variable                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mechanism                                  | `recordAuditEvent` derives the actor type from the **identity itself**: it looks up `users.kind` of `actorUserId` (cached per transaction) and writes `api_token` for a service principal | `AuthorizationContext` gains the actor/token; every call site must pass it                                                | A transaction-local setting (`app.api_token_id`) set at request start; a `BEFORE INSERT` trigger rewrites the row                                                              |
| Attribution correctness                    | Correct by construction: attribution follows the **user id**, not a request flag; cannot be forgotten at a call site                                                                      | Correct only where each of 82 call sites passes the context; a forgotten site silently records the service user as `user` | Correct only if the variable is set on every path; if unset, the row is recorded as `user` (silent mis-attribution)                                                            |
| Risk an API action is recorded as a human  | None for rows naming a service principal                                                                                                                                                  | **High** unless the type system forces the parameter (large refactor)                                                     | **Medium**: depends on the session variable being set and not leaked                                                                                                           |
| Tenant isolation / transaction correctness | No effect; same transaction as the write                                                                                                                                                  | No effect                                                                                                                 | The variable must be **transaction-local** (`set_config(..., true)`); a non-local setting on a pooled connection could leak an identity to another request. Needs strict tests |
| Background jobs / system actions           | Jobs acting for a human keep `user`; system work stays `system`; a job never acts as a service principal in v1                                                                            | Same, but each job path must pass the context                                                                             | A job inheriting a stale variable is a risk; jobs must reset it                                                                                                                |
| Existing 82 call sites                     | Unchanged                                                                                                                                                                                 | All change                                                                                                                | Unchanged                                                                                                                                                                      |
| Token id (which token)                     | Not known from the user id; the integration id is (1:1 with the principal). Token id is optional supplementary metadata                                                                   | Known                                                                                                                     | Known via the variable                                                                                                                                                         |
| Testability                                | Unit-testable with a plain transaction                                                                                                                                                    | Compile-time + unit tests                                                                                                 | Requires database tests; behavior is invisible in application code                                                                                                             |
| Failure modes                              | An extra indexed lookup per event (cached per transaction); if the user row cannot be read, the insert fails closed                                                                       | Silent mis-attribution by omission                                                                                        | Silent mis-attribution by omission or leakage                                                                                                                                  |

**Recommendation (to be approved): A as the attribution rule, enforced by a database invariant, with the token id as supplementary data.**

1. **Attribution is derived from the identity** (A): a service principal can only ever be recorded as `api_token`. This removes the "forgotten call site" and "unset variable" failure modes of B and C.
2. **A database invariant makes misattribution impossible, regardless of application code:** a `BEFORE INSERT` trigger on `audit_events` **verifies, never rewrites**: a row with `actor_type = 'user'` whose `actor_user_id` is a service principal is **rejected**; a row with `actor_type = 'api_token'` must name a service principal and its integration. This is the safe use of a trigger (an integrity check), not the attribution mechanism, so the choice of mechanism is not driven by call-site count.
3. **Row shape** (replaces the earlier 18.6 wording): `api_token` ⇒ `actor_user_id` = the service principal (NOT NULL), `actor_integration_id` NOT NULL, `actor_token_id` optional; `user` ⇒ a human `actor_user_id`; `system` and `anonymous` ⇒ no user. The four types stay mutually exclusive and existing rows are unaffected.
4. **Token id** (supplementary) is passed by the public API layer where cheaply available (for example as a field of the audit input read from the integration context in the public request path); a missing token id never changes the actor type.
5. **Lifecycle actions** (create, rotate, revoke, scope change, reassignment) are recorded with the **human** actor, as before.
6. **Tests required:** the trigger rejects misattribution in both directions; a public write is `api_token`; a human write is `user`; an acting-user job is `user`; a tenant-isolation test with pooled connections shows no identity leakage.

### 19.6 Webhook authorization — FROZEN

1. **Creating or changing a subscription** requires `webhooks.manage` (+ re-authentication and MFA step-up where enforced) **and** that the acting human holds the read permission of every subscribed event type's resource.
2. **The integration must also hold the corresponding resource read permission** (scope) for every subscribed type.
3. **A subscription cannot exceed the integration's current readable resources.** An attempt to subscribe beyond them is refused with a clear error.
4. **Fan-out re-checks** the integration's current scopes and status for every event; an event whose type requires a scope the integration no longer holds creates **no delivery.**
5. **Removing a scope immediately prevents future delivery** of events requiring it (the next fan-out); already-created pending deliveries for those types are cancelled at delivery time by the same check.
6. **RLS and tenant isolation remain authoritative:** endpoints, deliveries and payloads are organization-scoped; the fan-out and delivery run under the endpoint's organization; thin retrieval is authorized by the normal API call.

### 19.7 Idempotency — confirmed

- The **integration's service principal is the owner identity** of API idempotency (the existing `idempotency_keys.user_id` holds the principal's user id).
- All tokens of one integration share that identity, so an integration **keeps its idempotency identity across token rotation.**
- Keys of one integration **cannot collide with or probe** another's: the idempotency scope includes a short integration id (`public.<i…>.<resource>.<action>`, within the existing scope pattern and 100-character limit), so the unique `(organization_id, scope, key)` never meets another integration's key; the owner check remains as a second guard.
- Retention remains the existing 24 hours; `Idempotency-Key` is required on every public write.

### 19.8 Accounting safety — confirmed

- **No ledger-posting scope** exists in v1 (D1); no scope maps to `*.issue`, `*.post`, `*.record`, `*.void`, `*.approve` or settings permissions.
- **No journal-level public event** exists (D8); no accounting-event, approval, period, banking-transfer or reconciliation event.
- **API-created drafts go through the existing domain services** (`CustomerService`, `ItemService`, `InvoiceService` draft paths) with an integration context; the public layer adds no parallel pricing, numbering, tax, FX or dimension logic.
- **Validations stay where they are.** Tax-code, account, dimension and currency checks that apply when a draft is saved in the web application apply identically to an API draft. Checks that today apply only at issue time (period open, FX rate availability, required dimensions, approval policy) still apply when a **person** issues the draft; the API cannot issue, so it cannot bypass them.
- **The API cannot approve its own documents:** no approve scope; a service principal can never be an approver (database guards, 19.2); the self-approval exclusion list still names the requesting principal.
- **Webhook emission is additive:** the publisher is an optional trailing dependency (the `InventoryHooks` pattern); it only inserts an outbox row and never alters posting inputs, outputs or order. Each touched service gets a regression test that its journals and numbers are unchanged with the publisher enabled and disabled.
- **Event insertion is atomic with the originating business transaction:** the outbox row is inserted with the same transaction handle (`enqueueOutboxEvent(tx, …)`), so a rolled-back change emits nothing and a committed change cannot lose its event.

### 19.9 Final implementation surface

Migration numbers continue from 0053 (the next free number); "Migration" is YES/NO only, and a migration is described by purpose in 19.10.

| Component             | Existing object / code path                                                                                                                                                                                                 | Required change                                                                                                       | Migration?              | Security impact                                                                     | Accounting impact                                                   | Test requirement                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Service principal     | `users`, `memberships`, `sessions`, sign-in/reset/invitation/member services, `membership_roles`, approval eligibility                                                                                                      | `kind`, exact CHECKs, guards, filters (19.2)                                                                          | YES                     | High: touches the human-user invariants; must be proven not weakened                | None directly (it is only an id in existing `*_by_user_id` columns) | Database negative tests for every invariant; sign-in/reset/invite/member regression; role and approval guards                           |
| API integrations      | new; `resolveActingUserContext` is the precedent                                                                                                                                                                            | `api_integrations`, scopes, responsible administrator, `resolveIntegrationContext` (organization from the token only) | YES                     | High: org binding, scope grants limited to what the actor holds, independent revoke | None                                                                | Tenant isolation, grant-limit, revoke and reassignment tests, employee-lifecycle independence                                           |
| API tokens            | new; session token hashing as the model                                                                                                                                                                                     | `api_tokens`: hashed secret, expiry, revoke, IP allow-list, usage                                                     | YES                     | High: hashing, one-time display, expiry, constant-time compare                      | None                                                                | Hash/expiry/revocation/IP tests, secret never logged or returned again                                                                  |
| Audit actor           | `audit_events`, `recordAuditEvent` (82 call sites)                                                                                                                                                                          | `api_token` actor, integration/token columns, invariant trigger (19.5)                                                | YES                     | High: misattribution must be impossible                                             | None                                                                | Misattribution rejection both ways; attribution tests; pooled-connection leak test                                                      |
| Permissions           | `permission-catalog`, role templates, additive backfill pattern                                                                                                                                                             | Add `api_tokens.view                                                                                                  | manage`, `webhooks.view | manage` only; backfill Owner/Administrator (view for Member to confirm)             | YES (backfill)                                                      | Medium                                                                                                                                  | None | Catalog/role count tests; backfill with audit; Member/Admin behavior |
| Idempotency           | `IdempotencyService`, `idempotency_keys`                                                                                                                                                                                    | Integration owner identity and integration-scoped scope string                                                        | NO                      | Medium: cross-integration probing prevented                                         | None                                                                | Replay across token rotation; cross-integration non-collision; conflict responses                                                       |
| Rate limiting         | none (login back-off only)                                                                                                                                                                                                  | `RateLimiter` interface + PostgreSQL counters, `RateLimit-*`, 429                                                     | YES (counters)          | Medium: token-guess throttling                                                      | None                                                                | Header/429/`Retry-After` contract tests; multi-instance correctness                                                                     |
| Webhook endpoints     | new                                                                                                                                                                                                                         | `webhook_endpoints`, encrypted secrets (`SecretCipher`), status, payload mode                                         | YES                     | High: SSRF validation, secret handling                                              | None                                                                | SSRF matrix, secret never exposed, rotation overlap, re-auth/MFA on changes                                                             |
| Webhook subscriptions | new                                                                                                                                                                                                                         | subscription rows with the 19.6 checks                                                                                | YES                     | High: cannot exceed readable resources                                              | None                                                                | Subscribe-beyond-scope refusal; scope removal stops fan-out                                                                             |
| Webhook deliveries    | new; job queue (`jobs`, `run_after`, `max_attempts`)                                                                                                                                                                        | `webhook_deliveries`, delivery job, backoff, dead letter, redelivery                                                  | YES                     | High: per-tenant isolation, pinned-IP transport                                     | None                                                                | Retry schedule with a fake clock, dead-letter, auto-disable (D6), queue ceiling                                                         |
| Webhook attempts      | new                                                                                                                                                                                                                         | `webhook_delivery_attempts`: status, duration, error class, response excerpt                                          | YES                     | Medium: no secrets, size-capped excerpts, retention                                 | None                                                                | History content/retention tests                                                                                                         |
| Outbox                | `outbox_events`, `OutboxDispatcher` (no subscribers today; `eventTypes` filter exists)                                                                                                                                      | First real subscriber: fan-out for `public.*` types, per-organization batch cap                                       | NO                      | Medium                                                                              | None                                                                | Backlog/backpressure test (5,000-event import), fairness test                                                                           |
| Event emission        | `InvoiceService`, `CreditNoteService`, `ReceiptService`, `CustomerRefundService`, `BillService`, `VendorCreditService`, `VendorPaymentService`, `VendorRefundService`, `ExpenseClaimService`, customer/vendor/item services | Optional trailing publisher; same-transaction `enqueueOutboxEvent` (19.4, 19.8); skip opening documents and drafts    | NO                      | Medium                                                                              | **Must prove no change to journals, numbers or order**              | Per-service regression (publisher on/off identical journals); atomicity (rollback emits nothing); catalog coverage test of the 27 types |
| DTOs                  | none public; services' application views are internal                                                                                                                                                                       | `modules/public-api/dto/v1/*`, explicit allow-lists, zod response schemas, golden files                               | NO                      | High: no internal leakage                                                           | None (no computation)                                               | Golden contract tests per resource; field-leak scan                                                                                     |
| Public API routes     | `/api/v1` internal plugin                                                                                                                                                                                                   | Separate `/public/v1` plugin: bearer auth, error format, pagination, OpenAPI, no cookie/CSRF                          | NO                      | High: surface separation                                                            | Draft writes only through existing services                         | Surface-separation, 404 cross-tenant on every route, error mapping, cursor tamper, OpenAPI diff                                         |

### 19.10 Implementation order (recommended)

Each step is a separate local commit with its own tests; nothing is pushed.

1. **Service principal and audit actor (one unit, two migrations).** `users.kind` with exact CHECKs and guards, then the `audit_events` actor invariant and `recordAuditEvent` identity-based attribution. Nothing else can start without these, and they are the changes that touch existing security invariants, so they ship alone with the heaviest negative tests. _May be implemented together; nothing else with them._
2. **Permissions, integrations and tokens (migration), with the integration context.** Four permission keys and backfill, `api_integrations`, scopes, `api_tokens`, `resolveIntegrationContext`, token authentication, the management endpoints for administrators (human `/api/v1`), idempotency identity. _The management web pages can follow immediately after._
3. **Public API plumbing and read endpoints.** Separate plugin, error format, `RateLimiter` (counters migration), pagination, DTO framework, OpenAPI, read endpoints (customers, vendors, items, invoices first). _The rate limiter and the DTO/pagination framework are independent of step 2's identity work and can be built in parallel by the same unit, but ship after step 2._
4. **Draft write endpoints** (customers, items, draft invoices) through the existing services, with idempotency. _Separate commit after the read endpoints._
5. **Event emission hooks.** The optional publisher in the services of 19.9, with per-service regression tests, no webhook yet. _May be combined with step 6 only in testing; keep a separate commit because it touches posting services._
6. **Webhooks.** Endpoints, subscriptions, `SecretCipher`, SSRF transport, fan-out subscriber with the 19.4 backpressure rules, delivery job, attempts, auto-disable, re-enable, redelivery, ping, then the web pages. _Endpoints/subscriptions/secrets and the transport can be developed together; the fan-out follows._
7. **Hardening.** Documentation, OpenAPI diff in CI, load test of fan-out, security review, known-limitations list.

**Safe to implement together:** (1a) service principal + audit actor; (3) rate limiter + DTO/pagination framework + read endpoints; (6) endpoints + subscriptions + secrets + transport. **Must not be combined:** event emission hooks (5) with any posting-service change; step 1 with anything else.

## 20. Implementation notes — Step 2 (2026-10-08)

Implemented: the four permission keys (migration 0055), organization-owned integrations, scopes and tokens (migration 0056), the integration authentication context, integration-scoped idempotency and automatic audit resolution of the integration and token. Not implemented (later steps): Public API routes, drafts, rate limiter, DTOs, OpenAPI, webhooks, event emission.

- **Effective permission (final, confirmed 2026-10-08)** = the integration's granted scopes ∩ the fixed platform policy (`modules/api-integrations/scopes.ts`; unknown scopes grant nothing) ∩ the **current organization permission boundary**, evaluated on every request. The boundary is the set of permission keys that at least one **non-Owner role** of the organization currently holds (the Owner role is immutable and holds every key, so it is excluded). It is never derived from the creator or the responsible administrator. Nothing stored is changed when it moves: if the organization stops permitting a capability, the API denies it at runtime (403) with scopes and token untouched, and the stored scope is effective again when the organization permits it again.
- **Scope catalog in this step:** `customers:read|write`, `items:write`, `vendors:read`, `invoices:read|write` (drafts only), `bills:read`, `accounts:read`. Deferred and additive: `items:read` (the catalog has no separate view permission, so a read scope would widen into invoice or bill access), `payments:read`. No scope maps to an issue, post, record, void, approve or settings permission (tested).
- **Per-token IP allow-list** (optional in D7) is not part of Step 2 and can be added additively.
- **Rotation** creates a replacement token of the same integration (recording what it replaces); the old token works until revoked or expired, so the integration identity, scopes and idempotency namespace never change.
- **Audit:** `recordAuditEvent` no longer accepts integration or token identities from callers. It resolves the integration from the service principal and the token from the authenticated request, and fails closed when a service principal has no integration. The Step 1 database verification trigger is unchanged.
- **Idempotency:** a request whose context carries an integration is stored under `public.i<12 hex of the integration id>.<scope>` with the service principal as owner; browser requests are unchanged.
- **Management routes** (`/api/v1/api-integrations…`, cookie-authenticated, for administrators) exist for people to manage integrations; they are not the Public API.

## 21. Implementation notes — Step 3 (2026-10-08)

Implemented: the Public API foundation at `/public/v1` and its first read resources (customers, vendors, items, invoices, bills, accounts). No write endpoint, event emission, webhook, OAuth, sandbox or ledger/journal endpoint exists.

- **Namespace and authentication:** a separate Fastify plugin registered at `/public/v1` with its own error contract; the cookie/CSRF session security of `/api/v1` is not registered there, and `/api/v1` ignores bearer tokens. Authentication is `Authorization: Bearer` through `IntegrationAuthService` only (query-string tokens are never read). Every request is authenticated before its query is validated.
- **Authorization:** each endpoint needs one of the permissions behind its scope in the integration context (scopes ∩ fixed platform policy ∩ the current non-Owner organization boundary, evaluated per request). `customers:read`, `vendors:read`, `invoices:read`, `bills:read`, `accounts:read` map as in `scopes.ts`. **Items:** no `items:read` scope exists and none was invented; `/items` follows the catalog's own rule (ItemService): it is available to a token whose effective permissions include `invoices.view`, `bills.view` or `catalog.items.manage`, i.e. scopes `invoices:read`, `bills:read` or `items:write`.
- **Rate limiting:** `RateLimiter` interface with a PostgreSQL fixed-window implementation (`api_rate_windows`, migration 0057) and an in-memory implementation. Defaults 600 read/min per token, 120 write/min per token (configured; unused until writes exist), 3,000/min per organization and 20 failed authentications/min per IP; all configurable through `PUBLIC_API_*` settings. Frozen contract: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on every authenticated response, and `429` with `Retry-After` when over a limit. The ADR's in-memory write pre-aggregation was not built (one counter write per authenticated request).
- **Errors:** `{ "error": { type, code, message, request_id, details? } }` with the types and stable codes of section 9; generic messages (no credential reason, no tenant existence — a foreign id is a plain 404, identical to a missing id).
- **Pagination:** cursor only. Ordering `(created_at, id)`; the cursor is an opaque signed token bound to the resource, organization and filters; `limit` 1–100 (default 25); unknown query parameters (including `offset`, `page`) are refused. Filters: `status`, `updated_since`, and per resource `item_type`, `customer_id`, `vendor_id`, `date_from`, `date_to`, `type`.
- **DTOs:** `src/api/public/dto-v1.ts` (Zod, snake_case, strict allow-lists); read queries select explicit columns only. Money is a decimal string in the document currency.
- **OpenAPI:** `GET /public/v1/openapi.json` (no credentials), generated from the DTO schemas; the committed copy `docs/openapi/public-v1.json` (`pnpm --filter @intuit-2/api openapi:generate`) is compared by a test.
- **Audit:** ordinary reads write no audit rows; authentication failures are security events; last use is recorded at most once a minute.
