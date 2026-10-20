# Design: advanced inventory (FP-29)

Status: implemented per ADR 0014 (warehouses A3, transfers A4, counts A5 per warehouse, lots/serials/expiry A6, bundles A7, landed cost A8, units of measure A2). Builds on ADR 0006 (average costing, immutable stock ledger) and ADR 0012 (returns). Items below were explicitly deferred in ADR 0006.

## Requirements and proposed order

| #   | Feature                                            | Proposal                                                                                                                                                                                                                                |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Reorder points and low-stock                       | Reorder point exists on tracked items. Add a low-stock report (FP-22) and a notification job later.                                                                                                                                     |
| A2  | Units of measure                                   | `inventory_units` and per-item conversion factors to a base unit; documents carry a unit and quantity is converted to the base unit at posting; ledger stays in base units.                                                             |
| A3  | Warehouses / locations                             | `inventory_warehouses`; the balance key becomes (item, warehouse). Costing stays per item across warehouses (one average) unless per-warehouse costing is approved. Needs a default warehouse so existing data migrates without change. |
| A4  | Transfers between warehouses                       | A transfer document moves quantity at the current average (no journal when both warehouses share inventory accounts).                                                                                                                   |
| A5  | Stock counts                                       | A count sheet snapshots expected quantities, records counted quantities, and posts the differences as an adjustment (reuses adjustments and their journal).                                                                             |
| A6  | Lots / serials / expiry                            | Lot table with quantity per lot; issue picks by FEFO/FIFO policy; valuation remains average unless lot costing is approved. Serial numbers are one-quantity lots.                                                                       |
| A7  | Bundles (DONE, migration 0077) and variants (open) | Bundle: a sales item that expands to tracked components at issue (COGS per component). Variants: items sharing a parent with attributes.                                                                                                |
| A8  | Landed cost                                        | Allocate freight/duty to bill lines before receipt; extends `receiveBill`.                                                                                                                                                              |

## Invariants that must survive every step

Stock value equals the inventory account balance (the valuation report must show a zero difference); the ledger is append-only (voids add reversing rows); negative-stock policy is honoured; every posting is idempotent and period-checked.

## Open decisions

Per-warehouse versus global average cost; lot-level costing; whether serials are required on sale; unit-of-measure rounding policy.
