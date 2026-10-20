# Online payment gateway (FP-28): design and open decisions

Status: implemented against a SIMULATED provider (migration 0075). No real provider is configured anywhere, and the application refuses `live` mode.

## Model

- `PaymentProvider` (`infrastructure/payments/provider.ts`) is the only way the application talks to a provider: `createCharge`, `retrieveCharge`, `cancelCharge`, `verifyWebhook` (signature over the RAW body, constant-time compare).
- `MockPaymentProvider` is deterministic, keeps charges in memory, signs webhooks with HMAC-SHA256 (`x-mock-signature: sha256=<hex>`) so the real verification path runs, and never moves money. It is on by default outside production; in production it needs `PAYMENTS_MOCK_ENABLED=true` and its own `PAYMENTS_MOCK_WEBHOOK_SECRET`.
- `payment_gateway_settings` per organization: mode `disabled` (default) | `mock` | `live` (reserved; refused), intent time to live, and the **acting user**: the member under whom confirmed payments are recorded as receipts (re-resolved with their current permissions when an event is applied).
- `payment_intents`: one attempt to collect one invoice (full open amount, or a part). Status: CREATED, PENDING, SUCCEEDED, FAILED, CANCELLED, EXPIRED, REQUIRES_REVIEW. At most one open (CREATED/PENDING) attempt per invoice (unique index). SUCCEEDED is final and requires a receipt id. Database trigger enforces the transitions and freezes the terms.
- `payment_events`: append-only ledger of provider events. `(provider, provider_event_id)` is unique, which is the duplicate-delivery guard.

## Rules

1. A payment is recorded only from a verified provider event that is CONFIRMED against the provider's own record of the charge (status, amount, currency). A browser redirect or status poll can only trigger the same confirmation, never assert success.
2. The intent row is locked while an event is applied; duplicates and parallel deliveries produce one receipt.
3. Money received is never dropped. If a confirmed payment cannot be recorded (closed period, no deposit account, the acting user lost the permission), the intent becomes REQUIRES_REVIEW with the reason; a person fixes the cause and uses "Check with provider". If the invoice was settled meanwhile, the receipt is recorded as customer credit.
4. An amount/currency mismatch, or a signed "succeeded" the provider does not confirm, never records anything (mismatch: REQUIRES_REVIEW; unconfirmed: rejected, intent unchanged).
5. Unexpected failures answer 5xx so the provider redelivers; unknown payments are acknowledged (200) so it stops.
6. Pending attempts that never report back are checked by a periodic sweep and expired after their time to live (`app_stale_payment_intents`).
7. Mock and live are separate states of the same settings row; the UI states "simulated" wherever the mock is involved, and the receipt memo says SIMULATED.

## Entry points

- Staff: `POST /payments/intents` (idempotent), cancel, reconcile; list and detail with the event history.
- Customer: `POST /public/invoices/:token/pay` (invoice share link) and the statement link pay action; status polls re-check pending payments with the provider.
- Provider: `POST /payments/webhooks/:provider` (raw body, signature only, rate limited).
- Simulated checkout: `POST /public/mock-pay/:ref/settle` exists only while the mock provider is enabled.

## Decisions NOT taken (blockers for going live)

1. **Which real provider** (and its Maldives availability, currencies, fees, settlement account).
2. **Account model**: one merchant account for the platform vs one per organization; where provider keys are stored (the application must hold them encrypted, like MFA keys, and never log them).
3. **Fees and payouts accounting**: whether provider fees are booked per payment and how payouts are reconciled to the bank.
4. **Refunds and chargebacks** through the provider (the interface has no refund call yet; customer refunds remain manual).
5. **Card-data scope**: the design uses hosted checkout only, so the application never sees card data (PCI SAQ-A style). A different integration needs a new review.
6. **Partial payments policy** and **surcharges** (allowed in the API; the product policy is not decided).
