# Known limitations

Honest list, kept next to `requirements-matrix.md`. Updated 2026-10-17.

## Accounting

- **Cash-flow classification** uses account subtypes (BANK/CASH = cash; fixed and other assets = investing; long-term liabilities and equity = financing; the rest operating). An account whose subtype does not fit its real activity is placed by nature and reported with a warning. An explicit per-account override does not exist.
- **Customer returns** cost goods at the linked invoice's sale movement cost; with no invoice, at the current average. A credit note whose invoice sold the item at several costs uses the invoice's average.
- **Supplier returns** remove stock at the value the vendor credit booked to the inventory account, not at the average. If the credit value differs from the carrying cost, the average cost of the remaining stock moves; stock always equals the ledger. Debit notes on tracked items follow the same rule, so a price-only adjustment on a tracked item is not supported (use a stock adjustment).
- Inventory, banking and fixed-asset postings have no separate approval step (open-points.md).
- Foreign-to-foreign bank transfers are unsupported.

## Operations

- Docker, compose, nginx and the CI workflow are unexecuted (no container runtime on the development machine).
- Backup and restore: one restore drill was performed on 2026-10-19, on the DEVELOPMENT database only (`deploy/restore-drill.sh`: dump, restore into a separate empty database, validation of tables, row counts, checksums, policies, balanced journals and inventory levels; details in `docs/operations.md`). That proves the scripts and the restore procedure on this machine. It is NOT production disaster-recovery validation: no production or production-like environment exists, and no backup schedule, off-site copy, key recovery or recovery-time objective has been tested.
- One API instance when the local file store is used. The S3-compatible adapter exists but has only been tested against a fake store, never a real bucket.
- One advisory remains in the full dependency audit (development-only `source-map-js` through `jsdom`); `pnpm audit --prod` is clean.
- The two real-TLS webhook tests and two SMTP TLS tests skip on this machine (antivirus TLS interception) and must be run on a clean one.
- Browser end-to-end coverage exists locally only: 16 Playwright journeys in `e2e/` (sign-in and two-step verification, roles, branch access and groups, a manual journal, sales and purchases with reconciliation, AR and AP aging, invoice and bill voids, paid-document reversals, cross-organization isolation) passed 16/16 on the development machine on 2026-10-20, against the local dev servers and database. They have never run in CI: the workflow in `.github/workflows/ci.yml` (which includes them) has not been executed, and no deployed or production-like environment has been tested (see the Docker/CI line above). Credit notes, refunds, vendor credits and role-restricted users have no browser journey yet.
- One read-only load test was run locally (see `docs/operations.md`); it is not capacity evidence. No write-path load test, no penetration test.
- The web app ships as one JavaScript bundle: 1,460.05 kB minified (323.68 kB gzip) in the 2026-10-20 build (run 18), over Vite's 500 kB warning limit, so every build prints the large-chunk warning. Nothing is code-split by route, and the whole English message catalog (3,437 keys) is in it. Not a functional defect; it costs first-load time on slow connections. Route-level `import()` splitting is the usual fix and has not been decided or measured.
- The production e-mail vendor and credentials are not chosen.

## Payroll

- No statutory rules: pension, income tax, overtime, gratuity/end-of-service and unpaid-leave deduction are NOT built in. Organizations configure their own pay components; the Maldives rules are an open decision (`docs/open-decisions.md`, `docs/design/payroll.md`). Leave does not change a payslip automatically.
- Monthly runs only; proration is by calendar days (or none), and a dated salary change is split by day inside a run. A run is per organization (not per branch). No foreign-currency salaries.
- Advances are recovered by a fixed monthly instalment; a run is refused when an instalment exceeds that month's pay. A paid run cannot be voided (correct with a manual journal).
- Reads of salary data (employee list/detail, salary history, pay run, payslip, register) are audited with counts and numbers only, never names or amounts. Own-payslip reads by the employee are not audited.
- Payslip PDF download exists; the payslip itself is not e-mailed (needs the employee-consent and privacy decision). "Announce payslips" sends a notice without amounts, once per payslip.
- Payroll and expense-claim cost is not allocated to projects. No statutory filing or export.

## Projects (v1)

- No tasks, budgets by cost category or rate cards; one default rate per project with an optional rate per member.
- Time approval has no separation-of-duties rule (a manager may approve their own time).
- Billed time is linked to a draft invoice by a plain reference (not a foreign key) so that drafts can still be deleted; a manager releases the time afterwards.
- Project cost on the books comes from tagged bills, expenses and journals; payroll and expense-claim costs are not allocated to projects yet.

## Quotes and recurring invoices (v1)

- A quote shows net amounts only; tax is calculated when it becomes an invoice. No quote PDF or e-mail yet.
- Recurring schedules create DRAFT invoices only (never issue or send). The background run uses the permissions of the person who last saved the schedule; if they lose `invoices.create` the schedule pauses with the reason.
- A schedule that was behind catches up at most 24 periods per check; the check runs every `RECURRING_INVOICE_INTERVAL_MINUTES` (default 60).

## Sales orders, reminders and share links (v1)

- A sales order shows net amounts; tax is calculated on the invoice. Invoicing creates DRAFT invoices only; a deleted draft releases its quantity, a voided invoice too.
- A reminder is a fixed plain-text e-mail in English; no template editor, no per-customer opt-out beyond switching the schedule off or leaving the address empty.
- A share link shows one issued invoice to anyone who holds it; it is the first step of a customer portal, not the portal (no customer accounts, statements, payments or downloads of the PDF).
- The public view is rate limited per address (30 reads a minute).

## Online payments and customer portal (v1)

- Only a SIMULATED payment provider exists; no real provider is configured and `live` mode is refused. Nothing moves real money. Refunds and chargebacks through a provider, provider fees and payout reconciliation are not built.
- The simulated provider keeps charges in memory: after a server restart a pending simulated charge is unknown to it and the periodic sweep expires the attempt.
- A customer statement link shows one customer's open invoices, recent receipts (20) and a pay action to whoever holds it; there are no customer accounts, no PDFs, no disputes. Payments recorded from a confirmed event are posted under the member who switched the gateway on.
- Cash-basis profit and loss only (no balance sheet); depreciation, inventory cost of sales and payroll are recognised as booked (see `docs/design/cash-basis-reports.md`).

## Advanced inventory (ADR 0014)

- Cost is one weighted average per item across warehouses and lots; a warehouse's value is quantity times that average and is informational. Per-warehouse and lot-level costing are not built.
- A draft invoice, bill or vendor credit chooses its warehouse (and a bill its lots) through the inventory endpoints while it is a draft; documents completed through an approval keep that choice; with no choice, stock in goes to the default warehouse and stock out comes from the default warehouse first.
- Lots are taken first-expired-first-out automatically; choosing specific lots or serials on a sale is not built. Expired lots are skipped for sales and written off by an adjustment that names them. Lot- and serial-tracked items never go negative.
- Counts exclude lot- and serial-tracked items; adjust those with a stock adjustment naming the lots.
- Landed cost spreads an amount over one posted bill; units "still on hand" are the smaller of the quantity on hand now and the bill quantity (average cost does not track units). Voiding is refused once the added value has been used.
- Units of measure change the meaning of document quantities for an item, so units cannot be changed while a draft document carries the item. A quantity that does not convert to an exact six-decimal base quantity is refused at posting.

## Bundles (v1)

- A bundle is a non-tracked product with tracked components; revenue is the bundle line and the components leave stock at their own average cost when the invoice is issued. Bundles do not nest and cannot be tracked.
- Selling a bundle and later crediting it does not return stock by itself: return the component items with a customer return.

## Not built (see the matrix)

The authoritative, prioritized list is `docs/remaining-scope.md` (updated 2026-10-20). In short:

- Partly built: branch-scoped access (invoices, bills, their lines and files only; R-25), legal-entity groups (side-by-side profit and loss, no consolidation; R-19), the clinic (administrative, billing, consent and retention only; clinical records and scheduling extras are R-20 and R-21), localization (catalog and fallback only; R-01, R-44).
- Not built, owner decision needed: payslip e-mail (R-23), project tasks, budgets and WIP (R-26), expense by employee (R-29, the specification does not define it), per-warehouse cost and lot-level or FIFO costing (R-22), compound taxes (R-10), depreciation methods beyond straight line (R-11).
- Not built, blocked on outside input: MIRA tax-return data and withholding tax (R-40), statutory payroll (R-41), a real payment provider (R-42), customer and vendor portal sign-in (R-43), Dhivehi translation by a qualified translator (R-44).

## Test infrastructure

Real-database test startup takes about seven minutes and the full API suite about fifteen; under that load a few tests have flaked (`known-flaky-tests.md`). Test-side stabilizations were applied. Green full `pnpm verify` runs have been demonstrated (latest 2026-10-20, run 18; history in `docs/HANDOVER.md`), but the suite is still sensitive to machine load: runs during a video call or other heavy work have failed on timeouts.
