# PDF Library Evaluation (Decisions 43, 62; Phase 3B D14)

- **Status:** **PDFKit 0.20.2 approved 2026-10-01** (ADR 0003, implementation clarifications) and adopted behind `PdfRenderer` (`infrastructure/pdf/pdf-renderer.ts`, `PdfkitRenderer`). The interim dependency-free renderer was removed. Fonts bundled in `apps/api/assets/fonts` (Noto Sans, Noto Sans Thaana; SIL OFL, `OFL.txt`).
- **Date:** 2026-09-30 (npm registry data as of this date; advisories to be re-checked at approval).
- **Scope:** rendering issued invoices and credit notes from their frozen render snapshot (Decision 21, brief §Z).

## 1. Where the library plugs in

The immutable-PDF architecture is implemented and does not depend on the library choice:

- At issue, the document stores a `render_snapshot` (seller, customer, lines, totals, dates). It is immutable.
- Issue enqueues a `sales.document_pdf` job (idempotent by job key). The job renders **only** from the snapshot, stores the file with `legal_hold = true`, and links it to the document (`pdf_file_id`, set once; migration 0024 guard).
- Rendering is behind the `PdfRenderer` provider interface (`infrastructure/pdf/pdf-renderer.ts`): `render(snapshot) → Buffer`.
- The renderer embeds subset fonts, draws the seller logo (PNG/JPEG) referenced by the snapshot, and lays out lines containing Thaana with a right-to-left base direction, run by run (fontkit shapes each Thaana run).

## 2. Mandatory criteria (any option)

1. Unicode text with embedded, subset TrueType/OpenType fonts (Latin plus Thaana for Dhivehi, Decision 50).
2. RTL and complex-script shaping for Thaana (at minimum right-to-left runs; ideally via OpenType shaping).
3. Tables with page breaks, repeated headers, totals; images (PNG/JPEG logo).
4. Server-side Node rendering, no headless browser, bounded memory, no network access at render time.
5. Deterministic output from a snapshot (the same snapshot renders the same document).
6. Licence compatible with commercial distribution (MIT/Apache-2.0/BSD); maintained; no open advisories affecting the used version.

## 3. Candidates

| Candidate                                    | Latest (npm) | Licence    | Unpacked size   | Runtime dependencies                                                             | Notes                                                                                                                          |
| -------------------------------------------- | ------------ | ---------- | --------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **PDFKit** (`pdfkit`)                        | 0.20.2       | MIT        | 10.5 MB         | 6: `fontkit`, `linebreak`, `png-js`, `fflate`, `@noble/hashes`, `@noble/ciphers` | Low-level drawing API; `fontkit` provides OpenType subsetting and shaping (incl. RTL runs); actively released.                 |
| **pdfmake**                                  | 0.3.11       | MIT        | 15.3 MB         | 3: `pdfkit` (^0.19), `xmldoc`, `linebreak`                                       | Declarative document definitions (tables, columns, headers/footers) on top of PDFKit; lags PDFKit by one minor.                |
| **pdf-lib**                                  | 1.17.1       | MIT        | 18.6 MB         | 4: `pako`, `tslib`, `@pdf-lib/upng`, `@pdf-lib/standard-fonts`                   | Good for editing/filling existing PDFs; weak text layout (no line breaking, no shaping); last release several years ago.       |
| **Headless Chromium** (Puppeteer/Playwright) | —            | Apache-2.0 | 150+ MB browser | many                                                                             | Best HTML/CSS and script support, but a browser runtime on the server: large attack and ops surface. Rejected for criterion 4. |
| **In-house** (current interim)               | —            | —          | —               | 0                                                                                | Only standard-14 fonts; no Unicode/RTL. Not viable for Decision 50.                                                            |

## 4. Recommendation

- **PDFKit 0.20.x is recommended for approval**, used directly behind `PdfRenderer` (a small layout helper for the invoice table is ours).
  - It meets criteria 1–6 with the fewest dependencies, and its font stack (`fontkit`) is what pdfmake uses anyway.
  - Bundle two font families with the application: a Latin sans (e.g. Noto Sans, OFL) and Noto Sans Thaana (OFL).
- **pdfmake** is an acceptable alternative if a declarative layout is preferred; it adds `xmldoc` and trails PDFKit releases.
- **pdf-lib**: not recommended (layout and maintenance).

## 5. Checks before approval

1. `npm audit` / GitHub Advisory Database for `pdfkit`, `fontkit`, `linebreak`, `png-js`, `fflate` at the exact resolved versions.
2. Render a Thaana sample and confirm correct RTL order and glyph shaping.
3. Confirm no network or filesystem access beyond the bundled fonts; fonts loaded from the application directory only.
4. Memory and time for a 500-line invoice within the job limits.

## 6. Check results (2026-10-01, PDFKit 0.20.2)

1. **Advisories:** `pnpm audit --prod` — no known vulnerabilities (pdfkit 0.20.2, fontkit 2.0.4 and the rest of the tree). TypeScript declarations are local (`infrastructure/pdf/pdfkit.d.ts`); no `@types` package added.
2. **Thaana:** fontkit identifies the script as `thaa`, direction `rtl`; glyphs are returned in visual order with zero-advance vowel marks (fili) attached to their consonants, and no glyph is missing from Noto Sans Thaana. A rendered sample shows Thaana text and mixed Thaana/Latin lines in the correct order. A review by a Dhivehi reader of a printed invoice is still recommended before production.
3. **No network access:** fonts are read from the application directory; the logo comes from the file store through the job. The renderer performs no other I/O.
4. **Size and time:** a 500-line invoice renders in about 170 ms (12 pages, 53 KB, about 50 MB heap). Output is byte-identical for the same snapshot (fixed document dates).
