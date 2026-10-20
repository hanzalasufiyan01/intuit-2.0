# Customer portal (FP-28): design and open decisions

Status: version 1 (statement links) is designed here for implementation; accounts are an open decision.

## What exists

- Read-only share link for ONE issued invoice (migration 0070): unguessable token, hash stored, expiry, revocation, view counter.
- Online payment gateway with a simulated provider (migration 0075): a customer holding an invoice link can start a payment; the receipt is recorded only after a verified, provider-confirmed event.

## Version 1: customer statement links (no customer accounts)

A **statement link** is a share link for a CUSTOMER instead of one invoice. Whoever holds it sees, read-only:

- the customer name and the organization name,
- open issued invoices (number, dates, currency, total, open amount) with a per-currency balance,
- the last receipts applied (date, amount, reference), most recent 20,
- a "Pay" action per open invoice, which uses the same payment flow as an invoice link (the gateway rules apply unchanged).

Rules (same posture as invoice links):

- Token: 32 random bytes, base64url, hash (SHA-256) stored, shown once. Expiry 1 to 90 days. Revocable. View counter.
- Invalid, expired and revoked tokens are indistinguishable (one "not valid" answer).
- The public read goes through a narrow SECURITY DEFINER function that resolves the token hash to (organization, customer) and counts the view; everything else is read under that organization's row-level security.
- Only ISSUED invoices appear; drafts, voided documents, journals, internal ids of other documents, e-mail addresses and tax identifiers are never returned.
- Creating and revoking needs the existing `invoice_links.manage` permission (sensitive action: password re-confirmation). Audit: `customer.statement_link_created` / `_revoked`; the token and hash are never audited.
- Rate limited per address like the invoice link.

## Decisions NOT taken (need the owner of the product)

1. **Customer accounts** (sign-in for customers: e-mail magic link vs password vs none). Until decided, there are no customer accounts, no customer-side document history beyond the statement, and no customer-initiated changes of any kind.
2. **Downloadable PDFs** for customers (reuses the invoice PDF; needs a decision on whether a link may download).
3. **Disputes / messages** from customers: out of scope until accounts exist.
4. **Real payment provider and its account model** (see the payment gateway notes in the matrix).

## Out of scope in v1

Anything that changes data on behalf of a customer other than starting a payment; multi-customer ("group") statements; statement e-mail scheduling.
