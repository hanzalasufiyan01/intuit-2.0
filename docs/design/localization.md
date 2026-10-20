# Design: localization and translation infrastructure (FP-30, FP-23 inputs)

Status: infrastructure built (2026-10-19). **No Dhivehi text is shipped** and no MIRA rule is encoded.

## What exists

- `apps/web/src/i18n/i18n.tsx`: a typed locale registry. Each locale has a BCP 47 tag, a native name, a text direction (`ltr`/`rtl`), a review **status** (`approved` or `draft`) and a catalog. Only `approved` locales can be chosen; the choice is stored in this browser only. `translate()` falls back to English for any key the locale lacks, so a half-translated catalog never shows blanks.
- `messages.en.ts` is the complete source catalog. `messages.dv.ts` (Dhivehi, Thaana, right-to-left) is **empty on purpose**, status `draft`, so it is not offered.
- A language selector in the top bar appears only when at least two locales are approved. `LocaleProvider` sets `lang` and `dir`; styles use logical CSS properties.
- Tests (`apps/web/test/i18n.test.tsx`): every non-English key must exist in English with identical `{placeholders}`; draft locales are not offered; fallback and direction work. `catalogCoverage(locale)` reports translated/total keys for the translation workflow.

## What is NOT done (and why)

1. **Translations.** A financial UI needs a qualified Dhivehi translator and a reviewer; machine or guessed text is not acceptable for accounting terms. Needed: the translator, the reviewer, and an approved glossary (debit, credit, journal, receivable, payable, GST, ...).
2. **String extraction (English) is complete.** On the 2026-10-20 count, 99 of the 100 page files use the catalog (`t()`); the English catalog holds 3,437 keys (1,479 before the final pass) and Dhivehi still holds 0. The one page left on `apps/web/test/i18n-baseline.json` is `src/features/sales/SalesSection.tsx`, which renders no text (it is a route outlet and permission lists), so it needs no `useT`. The ratchet (`i18n-coverage.test.ts`) still fails when a page off the list lacks `useT`, so new pages cannot add untranslatable text. The final pass moved the remaining 36 pages with a syntax-aware codemod and checked that the English did not change: a temporary harness rendered all 178 routes before and after and found 0 differences in visible text and in `aria-label`, `placeholder`, `title` and `alt`; every label map rewritten by hand was compared value by value with the original; the existing page tests passed unmodified, and the 16 Playwright journeys passed. The shared approval wording (`src/features/approvals/conditions.tsx`) now takes the translator as a parameter and is pinned by `apps/web/test/approval-conditions-text.test.tsx`, written and run before the change. Earlier batches are pinned by `accounting-setup-periods.test.tsx` and `counts-ownership-text.test.tsx`.
   - **Kept in English on purpose (not display text):** values sent to or stored by the server, which must not change with the language: the ownership-transfer default reasons 'Declined' and 'Withdrawn'; the approval policy editor's default step name `Step n`; the bank-statement CSV header-matching keywords 'posting date' and 'transaction date'. Also left as they are: CSS values and the technical file-format name 'CSV UTF-8'.
   - **Notes for the translator (R-44):** some sentences are split around inline markup (the extraction keeps any element such as a `<strong>` or a link where it is, so the text on either side becomes its own key; the import wizard has examples), so they are stored as two or three adjacent keys and must be translated together. The classification cards compose messages around a noun passed in from the catalog (`sales.classificationPages.noun.*`: group, variant group, category); a language with gender or case may need whole-sentence keys instead. Keys under the accounting, reports, tax/GST (company profile), payroll and clinic privacy pages carry accounting, tax and privacy terms and need the approved glossary before translation. Server error messages shown on screen remain English (item 4).
   - **Catalog checks (2026-10-20):** no duplicate keys; no key called with a literal is missing from the catalog (the type checker enforces this too); one key, `purchases.refunds.sourceType`, is unused and predates this pass. Keys created by the codemod for the import wizard use the folder name `data-exchange.*`.
3. **Thaana font and layout review.** A Thaana-capable web font must be chosen and rtl layouts reviewed page by page.
4. **Server text.** API error messages, e-mail templates and PDF documents are English only; each needs its own catalog (PDF output also needs Thaana font embedding).
5. **Number and date formats.** `useFormatters()` formats dates/numbers with Intl in the chosen locale. Money formatting still uses the existing currency rules; Dhivehi digit shaping is not enabled and needs a decision.

## Maldives tax localization: precisely what needs authoritative confirmation (FP-23)

Nothing below is implemented; each item must be confirmed from MIRA's own publications or a tax adviser, in writing, before it is built (full list: `docs/design/tax-localization-open-decisions.md`):

1. Which taxes apply to which kinds of business (GST, TGST, Green Tax, others) and the rate table with effective dates.
2. The exact boxes of the periodic GST return and what feeds each box; filing periods.
3. Zero-rated versus exempt treatment and input-tax apportionment.
4. Withholding tax: payments in scope, rates, who withholds, remittance, certificates.
5. Rounding rule (per line, document or return) and treatment of credit notes and bad debts across periods.
6. Whether filing is by file export or a submission format, and any e-filing identifiers.
7. Official Dhivehi/English terminology for tax terms used on documents.

What the system already provides without inventing rules: configurable tax codes and rates (frozen per document), inclusive/exclusive treatment, recoverable/non-recoverable input tax, a Maldives chart-of-accounts template (account structure only), a GST/tax summary labelled "for review, not a tax return", MVR base currency and multi-currency.
