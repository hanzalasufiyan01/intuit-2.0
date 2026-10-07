# Integration plan

Owned by the integrator. Streams record here, before they write code, every claim on a shared resource. Nothing below changes a decision in an ADR.

## Migration numbers

Migrations are strictly sequential (no reserved gaps). Before creating one, a stream reads the highest number here and in `apps/api/src/database/migrations`, claims the next, and adds a row. An applied migration is never edited.

| Number | Name                            | Stream / stage | Status                       |
| ------ | ------------------------------- | -------------- | ---------------------------- |
| 0039   | `remittance_advice`             | A / 4B-7       | committed (`8d162be`)        |
| 0040   | `purchases_exports`             | A / 4B-8       | committed (`f9cc34b`, local) |
| 0041   | `expenses`                      | A / 4B-9       | committed (`501db90`, local) |
| 0042   | `opening_ap_documents`          | A / opening AP | committed (`cd44d29`, local) |
| 0043   | `purchases_imports`             | A / imports    | committed (`0603922`, local) |
| 0044   | `purchases_permission_backfill` | A / 4B-12      | committed (`01078df`, local) |
| 0045   | `banking`                       | B / Banking    | committed (`003233f`, local) |
| 0046   | `inventory`                     | B / Inventory  | committed (`dd25ce4`, local) |
| 0047   | `purchase_orders`               | B / PO         | committed (local)            |
| 0048   | (next free: claim before use)   | —              |                              |

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
