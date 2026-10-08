# Open points and recorded product decisions

Recorded 2026-10-08 after the accounting integrity checkpoint. None of these is built; each needs an explicit decision or a later architecture review.

## Banking

- **Foreign-to-foreign bank transfers are unsupported.** A transfer is between two accounts in the same currency, or between a foreign account and the base-currency account at the implied rate. Moving money between two different non-base currencies needs a rate for each leg and a realized-FX rule. The bank account and transfer model (`banking_transfers` with a source and a destination account, each with its currency) can carry it later, so this is a **future extension point only**; nothing was changed.

## Approval semantics

- **Banking, Inventory and Fixed Asset postings have no separate approval step.** Their journals post under the permission of the action (`banking.*`, `inventory.*`, `fixed_assets.*`) and the generic journal approval policy does not apply to them (domain approval, Decision 13). This is an explicit product/ADR decision (ADRs 0005, 0006, 0008) and stays so unless a later architecture review changes it. No approval requirement was invented.

## Localization cleanup list (before the final product freeze)

- **Customer refund pages** (`apps/web/src/features/sales/RefundPages.tsx`, the Refunds link in `SalesNav`) and the **expense claim pages** (`features/claims`) and the **fixed-asset capitalization controls** (`features/assets/AssetPages.tsx`) use literal English strings. Move them to the message catalog (`i18n/messages.en.ts`) without redesigning the screens.
- The data-exchange pages (`features/data-exchange`) already use literal English by design of Phase 3A; include them in the same pass.
