# Integration plan

Owned by the integrator. Streams record here, before they write code, every claim on a shared resource. Nothing below changes a decision in an ADR.

## Migration numbers

Migrations are strictly sequential (no reserved gaps). Before creating one, a stream reads the highest number here and in `apps/api/src/database/migrations`, claims the next, and adds a row. An applied migration is never edited.

| Number | Name                               | Stream / stage        | Status                       |
| ------ | ---------------------------------- | --------------------- | ---------------------------- |
| 0039   | `remittance_advice`                | A / 4B-7              | committed (`8d162be`)        |
| 0040   | `purchases_exports`                | A / 4B-8              | committed (`f9cc34b`, local) |
| 0041   | `expenses`                         | A / 4B-9              | committed (`501db90`, local) |
| 0042   | `opening_ap_documents`             | A / opening AP        | committed (`cd44d29`, local) |
| 0043   | `purchases_imports`                | A / imports           | committed (`0603922`, local) |
| 0044   | `purchases_permission_backfill`    | A / 4B-12             | committed (`01078df`, local) |
| 0045   | `banking`                          | B / Banking           | committed (`003233f`, local) |
| 0046   | `inventory`                        | B / Inventory         | committed (`dd25ce4`, local) |
| 0047   | `purchase_orders`                  | B / PO                | committed (`f25b305`, local) |
| 0048   | `fixed_assets`                     | C / Fixed assets      | committed (`8099887`, local) |
| 0049   | `expense_claims`                   | D / Claims            | committed (local)            |
| 0050   | `customer_refunds`                 | E / Refunds           | committed (local)            |
| 0051   | `fixed_asset_source_bill`          | C / FA guard          | committed (local)            |
| 0052   | `xlsx_format`                      | F / XLSX              | committed (local)            |
| 0053   | `service_principals`               | G / Public API 1      | committed (local)            |
| 0054   | `audit_api_token_actor`            | G / Public API 1      | committed (local)            |
| 0055   | `public_api_permissions`           | G / Public API 2      | committed (local)            |
| 0056   | `api_integrations`                 | G / Public API 2      | committed (local)            |
| 0057   | `api_rate_windows`                 | G / Public API 3      | committed (local)            |
| 0058   | `webhooks`                         | G / Public API 6      | committed (`c0b61cb`, local) |
| 0059   | `webhook_enabled_at`               | G / Public API 6      | merged to main (`7a7bb4c`)   |
| 0060   | `ownership_transfer_workflow`      | H / Completion 1      | merged to main (`7a7bb4c`)   |
| 0061   | `operational_metrics`              | H / Completion 2      | merged to main (`7a7bb4c`)   |
| 0062   | `inventory_returns`                | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0063   | `vendor_returns`                   | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0064   | `storage_provider_s3`              | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0065   | `organization_modules`             | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0066   | `payroll`                          | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0067   | `projects`                         | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0068   | `quotes_recurring`                 | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0069   | `clinic`                           | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0070   | `sales_extras`                     | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0071   | `stock_counts`                     | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0072   | `project_tasks`                    | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0073   | `payroll_leave_advances`           | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0074   | `leave_cancel_constraint`          | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0075   | `payment_gateway`                  | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0076   | `customer_statement_links`         | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0077   | `inventory_bundles`                | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0078   | `warehouses`                       | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0079   | `lots_serials`                     | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0080   | `lot_levels_fix`                   | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0081   | `landed_cost`                      | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0082   | `item_units`                       | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0083   | `payroll_salary_history`           | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0084   | `branch_scopes`                    | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0085   | `organization_groups`              | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0086   | `clinic_consent_retention`         | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0087   | `tax_treatment`                    | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0088   | `classification`                   | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0089   | `payroll_run_adjustments`          | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0090   | `variants_bins`                    | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0091   | `delivery_reservations`            | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0092   | `expense_policies`                 | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0093   | `petty_cash`                       | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0094   | `expense_trend_export`             | H / Completion 3      | merged to main (`7a7bb4c`)   |
| 0095   | `fixed_asset_depreciation_methods` | H / Completion 3      | merged to main (PR #2)       |
| 0096   | `tutorial_progress`                | Assistant / Tutorials | merged to main (PR #7)       |
| 0097   | (next free: claim before use)      | —                     |                              |

0058 is committed in the local commit `c0b61cb` (not pushed). 0059 is an uncommitted file, applied to the local development/test database only; no migration has been deployed or pushed. **(Superseded 2026-10-25, verified with git: migrations 0059 to 0094 were committed together in `7a7bb4c` and are on `origin/main`; 0095 was merged by pull request #2 and 0096 by pull request #7. None has been deployed, and being in Git says nothing about which databases have applied them. The rows for 0001 to 0058 and this paragraph's remaining history were not re-verified in this pass.)** ADR 0011 Step 6 (including CR-0011-S6-01) was accepted locally on 2026-10-15: not committed, not pushed, not deployed and not production-certified. Migration 0060 (ownership transfer workflow, ADR 0012) belongs to the completion mandate of 2026-10-17 and is also local only.

## Collision files

The integrator owns these. Other streams add their own modules and hand over a manifest (permissions, routes, source-document resolvers, job handlers, message keys); the integrator wires it in.

- `permission-catalog.ts`, `role-templates.ts`
- `app.ts`, `api/v1/index.ts`
- `source-documents.ts`, `attachment-targets.ts`
- `modules/jobs/jobs.ts`
- `messages.en.ts`, `vitest.config.ts`
- ADR 0004 and the migration list in `test/s2-fixes.test.ts`
- `journal-service.ts` (`JournalOwner`: Banking journals are reversed only by Banking)

## Approved architecture decisions (2026-10-07)

Weighted-average inventory costing; negative stock blocked by default; immutable stock movements; additive Sales COGS integration only; POs create no journal; no GRNI in v1; three-way match OFF, WARNING or BLOCK per organization with quantity and price tolerance; banking as a separate module (CSV and OFX behind a provider abstraction; reconciliation never changes posted journal lines; transfers are an accounting source document); fixed assets on the cost model with straight-line depreciation; expense claims posting Dr expense / Cr employee payable; `/public/v1` with tokens and signed, retried webhooks; XLSX approved; customer refunds unfrozen (mirror vendor refunds); tax returns blocked on statutory material.
