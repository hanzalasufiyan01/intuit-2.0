# ADR 0010 — Customer refunds

Status: implemented (migration 0050). Unfrozen 2026-10-07 as a mirror of vendor refunds (ADR 0004 P4-30); vendor refunds are unchanged.

## Decisions

- **CR-01 A separate transaction.** A refund pays back part of an open customer credit balance on AR: a recorded receipt's unallocated amount or an issued credit note's unapplied amount. It never touches invoices or allocations. Recorded at once (no draft, no approval); `RECORDED → VOID`; recorded refunds are immutable except the void (database guard); never deleted.
- **CR-02 Posting.** Through the accounting event `sales.refund_recorded`: Dr AR (the AR control account) for the source's historical base released / Cr the refund account (bank or cash only, in the source or base currency) at the refund rate / one net base-only realized-FX line. `fx_difference = base_released − base_amount` (positive = gain: the liability released exceeded the cash paid). With no FX the journal is an ordinary event journal (source `sales/refund`); with FX it is a `realized_fx` system journal of module Sales that resolves to the refund in the source-document registry. The ledger is only written through the journal engine.
- **CR-03 Rate.** The table rate on the refund date, or a manual override with a mandatory reason (the table rate is kept); base-currency refunds have no rate.
- **CR-04 Partial and multiple refunds** up to the source's open balance; the final refund releases whatever base remains (proportional release, like vendor refunds). A refund cannot be dated before its source.
- **CR-05 Void.** `receipts.void` plus a recent password confirmation. The journal is reversed through Sales (`reverseSubledgerJournalInTransaction`; FX journals are mirrored, never reversed generically) and the source's exact amount and base are restored. A receipt cannot be voided while a recorded refund references it (application check and database backstop trigger).
- **CR-06 Permissions.** Reuses the receipts keys: view `receipts.view`, record `receipts.create`, void `receipts.void`; a credit-note source additionally needs `credit_notes.view` (the list hides credit-note refunds from callers without it). No new permission keys, so no backfill.
- **CR-07 Numbering.** `RF-00001`, from its own lazily created sequence table (`sales_refund_number_sequences`) so Sales numbering settings are untouched.
- **CR-08 Reports.** Open customer credit, the AR aging, the AR reconciliation inputs and the customer statement subtract recorded refunds dated on or before the report date (the statement shows a refund as a positive line, like a vendor refund). Voided refunds drop out.
- **CR-09 Idempotency and concurrency.** `Idempotency-Key` replays the same refund; the source row is locked before the refund so concurrent refunds cannot over-draw it.

## Known deviations and open points

- Refunds cannot go to credit card accounts (bank or cash only), as for vendor refunds.
- The AR positions query and the receipt void were extended; the vendor refund code was not redesigned (only a `customer_refund` account-eligibility context was added beside `payment` and `refund`).
- The refund page strings are literal English (like the claims pages), not yet in the message catalog.
