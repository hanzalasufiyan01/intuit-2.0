# ADR 0011 (PROPOSAL) — Public API (`/public/v1`) and webhooks

Status: **PROPOSAL / REVIEW DOCUMENT. Nothing is implemented.** Revised 2026-10-08 after the product decisions on D1–D9. Two items are still **pending approval and block implementation: the final D2 token-ownership model (section 3.2) and the exact D8 event catalog (section 11.2).** No migration, route or code may be written from this document yet.

### Review outcome (2026-10-08)

| ID          | Subject                                                                   | State                                                                                     |
| ----------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| D1          | Scopes and write set                                                      | **APPROVED / FROZEN** (section 3.1)                                                       |
| D2          | Token ownership and runtime permission model                              | **NOT FROZEN — revised, PENDING PRODUCT APPROVAL** (section 3.2)                          |
| D3          | Rate-limit headers, 429, `Retry-After`                                    | **APPROVED; contract FROZEN**; store and numbers configurable (section 4)                 |
| D4          | Thin default, full opt-in, envelope and mode names                        | **APPROVED; envelope and mode names FROZEN** (section 11.2)                               |
| D5          | Secret overlap and history retention                                      | **APPROVED; configurable**, 24 h / 30 d are documented defaults only (section 11.4, 11.5) |
| D6          | Auto-disable, re-enable, no automatic replay                              | **APPROVED** (section 11.5)                                                               |
| D7          | SSRF protection, optional IP allow-list, egress proxy as guidance         | **APPROVED; SSRF requirements FROZEN** (section 11.3)                                     |
| D8          | Event rules approved in principle; **exact catalog pending final review** | **APPROVED IN PRINCIPLE — catalog not frozen** (section 11.2)                             |
| D9          | OAuth and sandbox deferred                                                | **APPROVED** (section 17)                                                                 |
| Audit actor | `api_token` actor through a new migration                                 | **APPROVED FOR ARCHITECTURE; migration not written** (section 10)                         |

Not approved for implementation: the final D2 ownership model, the exact D8 catalog, the API itself, webhooks.

Scope: a stable, versioned, token-authenticated HTTP API for external systems, and signed outbound webhooks. It reuses the existing outbox, job queue, idempotency service, audit trail, permission model, MFA and re-authentication. It exposes **public DTOs**, never internal tables or internal view models.

## 1. Principles

1. **Separate surface.** `/public/v1` is its own Fastify plugin with its own authentication hook, error mapper, rate limiter and DTOs. The internal `/api/v1` (cookie session + CSRF) never accepts bearer tokens, and `/public/v1` never accepts session cookies. No route is shared.
2. **A token is not a user and not a person.** It is bound to one organization and can do no more than its explicitly granted scopes allow. Whose authority backs a token at runtime (the creator, independent permissions, or an organization-owned service principal) is **decision D2, still pending** (section 3.2).
3. **Additive only.** Inside `v1`, fields and endpoints are only added. Anything else is `v2`.
4. **DTOs are an explicit allow-list** (section 8). A new internal column is invisible to the public API until a DTO maps it.
5. **Provider independence.** Rate limiting, secret encryption, outbound HTTP and event sourcing sit behind small interfaces (section 13). No gateway, queue or KMS product is assumed.
6. **Everything is tenant-isolated by RLS first, then by code.** The organization comes from the token alone — never from a header, path or body.

## 2. Token model

| Item                 | Decision                                                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind                 | "API token", created in the web app by a user with `api_tokens.manage` (Owner and Administrator by default).                                                                                                                                                                                                     |
| Format               | `itk_` + 8-char public id + `_` + 43-char base64url secret (256 bits of CSPRNG). The prefix lets secret scanners and log filters recognize it.                                                                                                                                                                   |
| Storage              | Only `SHA-256(secret)` is stored (the secret has 256 bits of entropy, so a slow hash adds nothing) plus the public id, name, scopes, creator, organization, `created_at`, `expires_at`, `last_used_at`, `last_used_ip`, `revoked_at/by/reason`. Lookup is by public id, comparison constant-time.                |
| Display              | The full token is shown **once**, at creation, in the response of the create call. It can never be revealed again; losing it means rotating. The list shows name, public id, scopes, expiry, last use.                                                                                                           |
| Expiration           | Mandatory. Choices 30 / 90 / 180 / 365 days; default 90; maximum 365. Expired tokens are rejected (`401 token_expired`). The owner is notified (in-app and email) 14 and 3 days before expiry.                                                                                                                   |
| Revocation           | Immediate: every request reads the token row, so revocation takes effect on the next request. Revoke needs `api_tokens.manage` + re-authentication and is audited with a reason. Whether a token also stops when its creator leaves is decided by D2 (section 3.2); under the recommended model it does **not**. |
| Rotation             | Create a new token, switch the integration, revoke the old one. There is no in-place secret change. Up to 10 active tokens per organization.                                                                                                                                                                     |
| Organization binding | Fixed at creation; a token never switches organizations.                                                                                                                                                                                                                                                         |
| Network              | Optional per-token IP allow-list (CIDR). TLS only (HSTS); `Authorization: Bearer itk_…`. Tokens in query strings are rejected.                                                                                                                                                                                   |
| Org switch           | The public API is **off by default**; an Owner enables it in organization settings (audited). Disabling it makes every token answer `403 api_disabled`.                                                                                                                                                          |

Creating, rotating, revoking a token and changing a scope are **sensitive actions**: they need `api_tokens.manage`, a recent password confirmation (15 min) and, when the organization enforces MFA, a satisfied MFA step-up (existing `MFA_STEP_UP_REQUIRED` flow). The human actor is audited on every one of them. A token can never manage tokens or webhooks, change roles, approve anything, or perform a sensitive action.

## 3. Scopes and authorization

### 3.1 Scopes and the v1 write set — D1, APPROVED / FROZEN

- **v1 has no ledger-posting scope.** No public API scope may post, approve, void, refund, reverse, or otherwise directly mutate the accounting ledger. Nothing that today requires `*.issue`, `*.post`, `*.record`, `*.void`, `*.approve`, settings, period, reconciliation or re-authentication is reachable through a token.
- **The v1 write set creates and updates allowed draft resources only** (initial proposal: customers, items and draft invoices). A draft is turned into a ledger document only by a person in the web application. Adding write capabilities later is additive.
- **Scope model: coarse `resource:read` / `resource:write`** (for example `customers:read`, `customers:write`, `invoices:read`, `invoices:write` meaning drafts only). Each scope maps to a fixed list of existing internal permission keys; each endpoint declares the one scope it needs; the check runs before the handler and again inside the service (`requirePermission`).
- **Scope names are public compatibility contracts**: they can be added, never renamed, removed or widened in meaning inside `v1`.
- A token can never hold a scope outside the organization's **API policy** (section 3.2): a ceiling the organization sets on what any integration may be granted.

### 3.2 Token ownership and runtime permission model — D2, **PENDING PRODUCT APPROVAL (not frozen)**

The earlier proposal (effective permissions = scopes ∩ the creator's current permissions) is **withdrawn as the final design.** A company integration must not stop working because the employee who created its token left, was disabled or was demoted. Required behavior from the product decision:

- the human creator must hold the permission to create and manage tokens (`api_tokens.manage`);
- the creator's authorization is checked **when the token is created or configured**;
- at runtime the token belongs to the **organization/integration**, not to an employee's lifecycle;
- organization administrators can revoke or disable the integration independently of anyone else;
- scopes stay explicitly granted and bounded by the organization's API policy;
- creation, revocation and scope changes stay audited with the human actor.

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

**Recommendation (PENDING PRODUCT APPROVAL — not a decision): option 3, an organization-owned service principal**, with these guardrails:

1. Creating or changing an integration needs `api_tokens.manage`, re-authentication and, when enforced, MFA step-up, and the actor **may grant only scopes whose permission keys the actor currently holds**. This is checked at configuration time only; later changes to the actor do not affect the integration.
2. An organization **API policy** (Owner-managed, audited) sets the maximum scopes any integration may hold, whether tokens may carry write scopes at all, the maximum token lifetime and whether IP allow-lists are mandatory.
3. Every integration has a **responsible administrator of record**, reassignable by any `api_tokens.manage` holder. If that person's membership ends, the integration keeps running and is flagged for reassignment; unattended integrations still expire with their token (mandatory expiry is retained) and expiry reminders go to all holders of `api_tokens.manage`.
4. Any administrator with `api_tokens.manage` can disable or revoke any integration at once, independent of its creator; the Owner can disable the whole public API.
5. Runtime requests act as the integration. They never impersonate a person and never inherit a person's MFA or session state.

**Unresolved by this proposal (must be answered with D2):**

- _Identity representation._ Many domain tables carry `created_by_user_id uuid NOT NULL REFERENCES users`. A service principal therefore needs either (a) a backing, non-interactive `users` row of a new kind (no password, cannot sign in, one per integration, with a membership and an integration-owned role), or (b) a schema change to those columns. (a) reuses `withOrganization`, memberships, roles, RLS context and audit unchanged but widens the meaning of "user"; (b) is invasive across the schema. No choice is made here.
- _Audit._ Attributing runtime writes to the integration needs the new `api_token` actor (section 10) in addition to whatever user id the domain row stores.
- _Approvals._ Self-approval rules compare users; a draft created by an integration must be approvable by any eligible person (it normally will be, since the integration is not the approver).

Until D2 is approved, nothing in `authorization.ts`, `withOrganization` or the schema changes. For comparison only: the `Principal` variant `{ kind: 'api_token', … }` of the earlier text remains an implementation sketch, not a decision.

## 4. Rate limiting

- Limits per token (token bucket): **600 requests/minute** for reads, **120/minute** for writes, plus a per-organization ceiling (**3,000/minute**) and a per-IP limit for unauthenticated failures (token guessing: 20/minute, then back-off). Limits are configurable per organization later.
- **FROZEN contract (D3):** responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a rejection is `429` with `Retry-After` (seconds until the client may retry) and the standard error body (section 9, `type: rate_limited`). These headers, the 429 semantics and the `Retry-After` behavior are public compatibility contracts. The **store and every numeric threshold remain configurable** and are not contracts.
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

- **Approved for architecture:** public API activity must be distinguishable from human activity. A new audit actor type `api_token` is added through a **new migration only** (never editing migrations 0001–0039; the existing `user` / `system` / `anonymous` semantics and the `user` ⇔ `actor_user_id` rule are preserved, with the new type governed by its own consistency check and an `actor_token_id`/integration reference). The migration is **not written yet.** Every write through the public API is audited like a user write, with the integration and token ids, public id and IP; configuration actions (create, rotate, revoke, scope change) carry the human actor. Token lifecycle events (`api_token.created|revoked|expired|ip_blocked|scope_changed`, `public_api.enabled|disabled`) are audited and also recorded as security events.
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

### 11.2 Event rules and the proposed v1 catalog — D4 and D8

**Approved and frozen rules (D4, D8 in principle):**

- Public events are **document / business-resource level only.** Journal-level events (journals, accounting events, system or realized-FX journals, reversals, approvals) are **never public in v1.**
- Event type = `<resource>.<action>`. A void or cancellation is always its **own explicit event** (`invoice.voided`), never a mutation of an earlier event.
- **Envelope and mode names are FROZEN:** `{ "id": "evt_…", "type": "invoice.issued", "api_version": "v1", "created_at": "…", "organization_id": "…", "data": { … } }`. Payload mode per endpoint is **`thin`** (default) or **`full`** (opt-in).
- **Thin** `data` = `{ "object_type": "invoice", "object_id": "…", "url": "/public/v1/invoices/…" }`, nothing else. The consumer retrieves the object through the normal API, so **retrieval is authorized exactly like any other API call** (the integration's scopes, tenant isolation, RLS); a thin event grants nothing by itself.
- **Full** `data.object` is the versioned public DTO (section 8) as of the event. It **never contains journal internals** (journal ids or numbers, accounting events, base-only/FX mechanics, tax-snapshot internals, system-journal links). Full mode is available only for resources whose scope the integration holds.
- Events are produced in the business transaction (emit hooks), at least once, **without a global ordering guarantee**; the DTO carries a resource `version` so consumers can discard stale snapshots.
- Opening documents (opening invoices, bills, vendor credits) and imported drafts emit **no** events.

**PROPOSED exact v1 catalog — FOR FINAL REVIEW, NOT FROZEN, NOT IMPLEMENTABLE YET (27 types):**

| #   | Event type                 | Fires when                                                      | Source in Intuit 2.0 | Notes                                            |
| --- | -------------------------- | --------------------------------------------------------------- | -------------------- | ------------------------------------------------ |
| 1   | `customer.created`         | a customer is created (UI, import or API)                       | Customers            | contact fields only in full mode                 |
| 2   | `customer.updated`         | a customer's fields change                                      | Customers            |                                                  |
| 3   | `customer.archived`        | a customer is archived                                          | Customers            | customers are archived, never deleted            |
| 4   | `vendor.created`           | a vendor is created (including an employee's vendor record)     | Vendors              | employee vendors are indistinguishable by design |
| 5   | `vendor.updated`           | a vendor's fields change                                        | Vendors              |                                                  |
| 6   | `vendor.archived`          | a vendor is archived                                            | Vendors              |                                                  |
| 7   | `item.created`             | an item is created                                              | Items catalog        |                                                  |
| 8   | `item.updated`             | an item's fields change                                         | Items catalog        |                                                  |
| 9   | `item.archived`            | an item is archived                                             | Items catalog        |                                                  |
| 10  | `invoice.issued`           | an invoice is issued (ledger document exists)                   | Sales                | not on draft creation                            |
| 11  | `invoice.voided`           | an issued invoice is voided                                     | Sales                |                                                  |
| 12  | `credit_note.issued`       | a credit note is issued                                         | Sales                | credit notes cannot be voided                    |
| 13  | `receipt.recorded`         | a customer receipt is recorded                                  | Sales                |                                                  |
| 14  | `receipt.voided`           | a receipt is voided                                             | Sales                |                                                  |
| 15  | `customer_refund.recorded` | a customer refund is recorded                                   | Sales (ADR 0010)     |                                                  |
| 16  | `customer_refund.voided`   | a customer refund is voided                                     | Sales                |                                                  |
| 17  | `bill.posted`              | a bill is posted (including a bill created by an expense claim) | Purchases            | opening bills excluded                           |
| 18  | `bill.voided`              | a bill is voided                                                | Purchases            | also fires when a claim void voids its bill      |
| 19  | `vendor_credit.posted`     | a vendor credit or debit note is posted                         | Purchases            | opening credits excluded                         |
| 20  | `vendor_credit.voided`     | a vendor credit is voided                                       | Purchases            |                                                  |
| 21  | `vendor_payment.recorded`  | a vendor payment is recorded (single or batch)                  | Purchases            | one event per payment                            |
| 22  | `vendor_payment.voided`    | a vendor payment is voided                                      | Purchases            |                                                  |
| 23  | `vendor_refund.recorded`   | a vendor refund is recorded                                     | Purchases            |                                                  |
| 24  | `vendor_refund.voided`     | a vendor refund is voided                                       | Purchases            |                                                  |
| 25  | `expense_claim.posted`     | an approved claim is posted                                     | Expense claims       |                                                  |
| 26  | `expense_claim.voided`     | a posted claim is voided                                        | Expense claims       |                                                  |
| 27  | `webhook.ping`             | an administrator tests an endpoint                              | Webhooks             | no business data                                 |

**Considered and NOT proposed for v1:** `bank_transaction.imported` (bank data is sensitive and counts alone have little value; was in the first draft and is removed), purchase-order, goods-receipt, fixed-asset, inventory-movement, depreciation, bank-transfer and reconciliation events, period or approval events, `invoice.paid` (derived from receipts and allocations; consumers use `receipt.recorded` and the pull API), any `*.updated` for ledger documents (issued/posted documents are immutable; changes are voids), draft-lifecycle events, user, role, organization and settings events.

**Open questions for the final review of the catalog:** (a) whether vendor events should include employee-vendors at all; (b) whether `customer.updated` / `vendor.updated` / `item.updated` carry changed-field names in thin mode (proposal: no); (c) whether purchase orders or fixed assets belong in v1 (proposal: no).

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
- **Auto-disable (D6, approved):** an endpoint is set to `auto_disabled` after **10 consecutive failed deliveries or 3 days without a successful delivery**, whichever comes first; fan-out stops creating deliveries for it, the owners are notified and it is audited. Here a _failed delivery_ is one that exhausted its retries (dead-lettered); this reading is to be confirmed in the review. **There is no automatic replay-from-time in v1**: events produced while an endpoint is disabled are not backfilled. Webhook delivery is **not a guaranteed historical backfill mechanism**; the pull API (`updated_since`, section 7) is the **authoritative reconciliation path**, and the documentation must say so. The history shows the gap.
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

| ID  | Decision                                                                                                                                                                            | State                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| D1  | No ledger-posting scope in v1; draft-only write set; coarse `resource:read` / `resource:write`; scope names are public contracts                                                    | **APPROVED / FROZEN**                                                 |
| D2  | Token ownership and runtime permission model (creator-bound / independent / organization-owned service principal)                                                                   | **PENDING PRODUCT APPROVAL** — recommendation: option 3 (section 3.2) |
| D3  | `RateLimit-*` headers, 429 semantics, `Retry-After`; store and numbers configurable                                                                                                 | **APPROVED; contract FROZEN**                                         |
| D4  | Thin default, full opt-in; envelope and mode names; thin retrieval keeps normal API authorization; no journal internals in full payloads                                            | **APPROVED; envelope and mode names FROZEN**                          |
| D5  | Secret overlap (24 h) and history retention (30 d)                                                                                                                                  | **APPROVED; configurable, defaults only**                             |
| D6  | Auto-disable (10 consecutive failed deliveries or 3 days without success), re-enable needs re-auth and ping, no automatic replay, manual redelivery allowed, pull API authoritative | **APPROVED**                                                          |
| D7  | SSRF protection frozen; optional IP allow-list; egress proxy is deployment guidance only                                                                                            | **APPROVED; SSRF requirements FROZEN**                                |
| D8  | Journal-level events never public; `<resource>.<action>`; explicit void events; exact catalog (section 11.2)                                                                        | **APPROVED IN PRINCIPLE — catalog pending final review**              |
| D9  | OAuth client credentials and in-organization sandbox/test mode deferred; **never a test-mode flag that changes accounting behavior inside a real organization**                     | **APPROVED**                                                          |
| —   | Audit actor `api_token` through a new migration (never 0001–0039)                                                                                                                   | **APPROVED FOR ARCHITECTURE; migration not written**                  |

Open for the next review: the final D2 model; the exact D8 catalog; the reading of "failed delivery" in D6.

## 17. Out of scope

Posting/voiding/approving/refunding/reversing documents through the API (D1); OAuth 2.0 client credentials and any sandbox or test mode inside a real organization (D9 — **a flag that changes accounting behavior inside a real organization is never to be created**); file upload/download; user, role and settings management; tax returns and MIRA (blocked on statutory material); inbound webhooks; OAuth.
