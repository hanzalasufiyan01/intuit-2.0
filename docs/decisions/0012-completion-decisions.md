# ADR 0012: Completion-phase decisions

Status: **ACCEPTED LOCALLY** (2026-10-17), not pushed. Records the decisions taken while closing the gaps found in the full-product completeness audit. Each decision is the safest reversible default; nothing here changes an earlier ADR except where a "known deviation" is closed.

## 1. Ownership transfer

- The Owner is the `membership_roles` row of the Owner role (one per organization). A transfer is a two-party, step-up-protected workflow: the Owner initiates, the addressee (an active member with MFA enrolled) accepts. The change of Owner happens in one transaction; the previous Owner receives the replacement role chosen at initiation.
- One open transfer per organization (unique index). A transfer expires after `OWNERSHIP_TRANSFER_EXPIRY_HOURS` (default 72). Terminal states are final (database trigger).
- Events: `ownership_transfer.*`, `organization.owner_changed`, security events, outbox `organizations.ownership_transferred`, e-mails to both parties and to administrators. Migration 0060.

## 2. Cash-flow statement and changes in equity

- Indirect method. Cash is the BANK/CASH account subtypes. Operating / investing / financing are assigned by account subtype; accumulated depreciation of fixed-asset categories is added back. Unclassified accounts are placed by nature and reported as warnings. Integrity checks must tie to the balance sheet. No new tables.
- Changes in equity shows one column per equity account plus a virtual accumulated-earnings column (the system has no closing entries).

## 3. SMTP e-mail provider

- Dependency-free SMTP client (STARTTLS, implicit TLS, or none; AUTH PLAIN/LOGIN). Header injection is refused; credentials are never sent over an unencrypted non-loopback connection. The mock provider is still refused in production. The production vendor is an open decision (U18).

## 4. Operational metrics

- `GET /api/v1/metrics` (Prometheus text) behind a bearer `METRICS_TOKEN`; disabled when unset. Job, outbox and webhook counts come from a `SECURITY DEFINER` function that returns aggregates only (migration 0061).

## 5. Inventory returns (closes the ADR 0006 deviation)

- **Customer returns** are a source document (`RET-`, migration 0062) that references an ISSUED credit note. Quantity per item cannot exceed credited minus returned (void returns do not count). Cost is the linked invoice's sale-movement cost, else the current average. Posting is Dr inventory / Cr cost of goods sold through the `inventory.sales_return_posted` accounting event with the credit note's dimensions. The credit note's own journal is not touched. Voiding reverses the journal and removes the stock (refused when it is not there).
- **Supplier returns** (migration 0063): a tracked item on a posted vendor credit or debit note must post to the item's inventory account; stock leaves at the value the credit's journal booked to that account so stock stays equal to the ledger. Voiding the credit restores the stock at the same value. Opening vendor credits still refuse tracked items.
- Permissions are reused (`inventory.adjustments.create` / `.void`); no permission key was added. Approval: none (domain approval, as for other inventory postings).

## 6. Deferred / unresolved (not decided here)

Branches and legal entities, payroll, projects and job costing, clinic, advanced inventory: designs are in `docs/design/`. MIRA tax-return data and withholding tax: `docs/design/tax-localization-open-decisions.md`.
