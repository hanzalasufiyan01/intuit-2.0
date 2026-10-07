# ADR 0008 — Fixed assets

Status: implemented (migration 0048). Scope approved 2026-10-07: cost model, straight-line depreciation, register, categories, acquisition, capitalization, accumulated depreciation, disposal with gain or loss, transfers, schedule, depreciation journals and reports. No revaluation.

## Decisions

- **FA-01 Categories.** A category names the cost, accumulated-depreciation and depreciation-expense accounts (active posting accounts, not control or designated; the first two assets, the third an expense) and a default useful life. The three accounts are different. A category with assets keeps its accounts (database trigger); it can be renamed and archived (an archived category takes no new assets).
- **FA-02 Assets.** An asset (`FA-`) has a cost in the base currency, a salvage value (at most the cost), a life in months, an acquisition date and an in-service date (not before the acquisition). Its financial terms are fixed once capitalized (database trigger); name, description, location, custodian and serial number can be edited. Assets are never deleted.
- **FA-03 Acquisition and capitalization.** Registering an asset posts Dr cost account / Cr the funding account (bank, cash, payable or clearing) through the `fixed_assets.acquisition_posted` accounting event. When the cost is already in the ledger (for example a bill line posted to the asset account) the asset is registered with `alreadyInLedger` and nothing is posted; the reconciliation report shows any gap between the register and the ledger.
- **FA-04 Straight-line schedule.** Cost less salvage is spread over the life in months; the in-service month counts as the first. Each month's charge is the difference of two rounded cumulative amounts, so the life total is exactly the depreciable amount. The schedule is a pure function of the asset's terms.
- **FA-05 Depreciation runs.** A run (`DEP-`) is dated a month end and books, per asset, the schedule's accumulated depreciation to that date less what is booked, so months not yet run are caught up in one run. One journal is posted per run: Dr each category's expense account / Cr its accumulated-depreciation account (`fixed_assets.depreciation_posted`). A run is refused for a future month, an earlier or equal month than the latest run, a closed period, or when nothing is owing. Only the latest run can be voided (`fixed_assets.void` and a recent password confirmation), by reversing its journal; it is refused while an asset of the run has been disposed of.
- **FA-06 Disposal.** Disposing of an asset catches depreciation up to the end of the month before the disposal date, removes cost and accumulated depreciation, takes the proceeds into a chosen account and posts the gain or loss to the organization's gain/loss account (a revenue or expense account in the fixed asset settings), all in one journal (`fixed_assets.disposal_posted`). A disposal is refused when depreciation has been booked beyond the disposal month. A disposal can be voided (reversal; the asset is in use again with its earlier depreciation) and the asset disposed of again.
- **FA-07 Transfers.** A transfer changes an asset's category and/or location. When the category's accounts differ it moves the cost and the accumulated depreciation to the new accounts (`fixed_assets.transfer_posted`); a location-only change posts nothing. Later depreciation uses the new category's accounts.
- **FA-08 The asset ledger.** `fixed_asset_entries` records every change to an asset's cost and accumulated depreciation (acquisition, depreciation, its void, disposal, its void). It is immutable. The register can be read as of any date from it, and the reconciliation compares its totals with the ledger balance of the cost and accumulated-depreciation accounts.
- **FA-09 Journal ownership.** Fixed asset journals are reversed only by Fixed assets (`JournalOwner`); the generic journal reversal refuses them.
- **FA-10 Permissions.** `fixed_assets.view|manage|depreciate|dispose|void`. Owner and Administrator hold all; Member holds the view key. Migration 0048 backfills existing organizations additively with audit events.

## Known deviations and open points

- Costs are in the base currency; a foreign-currency purchase is converted before it is registered.
- Depreciation, disposal and transfer journals carry no dimensions. The posting accounts' required dimensions are not applied to them.
- The disposal month itself is not depreciated and the in-service month is a full month (convention, not configurable).
- Journals post under the permission of the action without a separate approval step.
- The register reconciliation groups assets by their current category's accounts.
