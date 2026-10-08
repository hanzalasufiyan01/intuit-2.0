# XLSX Library Evaluation (Decision 62)

- **Status:** **implemented in-house, no dependency (2026-10-08)** under Decision 62; see section 7. The library recommendation below stays on record; section 5.1 could not be demonstrated for `read-excel-file`, so the documented fallback was taken.
- **Date:** 2026-09-28 (registry and advisory data as of this date).
- **Scope:** reading `.xlsx` for imports (S6) and writing `.xlsx` for list and statement exports (S3-20, S6).

## 1. Where XLSX plugs in

- Domain code (`application/data-exchange/imports/*`, `exports.ts`) already works on typed cells and never sees CSV text.
- CSV parsing is confined to `ImportService` (`readCsv`, `detectDelimiter`); CSV writing is confined to `ExportService.writeFile` and the error report (`csvRecord`, `CSV_BOM`).
- XLSX therefore needs:
  - a reader that yields `CsvRecord`-shaped records of strings from the first worksheet;
  - a writer that accepts the same `CsvCell` values (text, `{number}`, `{date}`).
- Other changes:
  - the `import_batches.format` and `exports.format` CHECK constraints (currently `'csv'` only) get the `xlsx` value;
  - the `import_batch` upload allowlist adds XLSX (S5-06 already detects it);
  - `POST /exports` gets an optional `format` field (the strict body currently rejects one).

## 2. Mandatory safety criteria (any option)

1. **Zip-bomb limits:** total uncompressed size, entry count, per-entry size and compression ratio, enforced while inflating, not after.
2. **No DTD or entity resolution** in any XML parser; reject `<!DOCTYPE`.
3. **`.xlsx` only.** Reject macro-enabled workbooks (`vbaProject.bin`, `.xlsm` content types) and legacy `.xls`.
4. **Formulas are never evaluated.** Only cached values are read; a formula cell without a cached value is an empty cell with a warning.
5. **Exported cells are typed as strings or numbers**, never written as formulas. Text is still neutralized, because spreadsheet users copy values into other tools.
6. **Dates:** support both the 1900 and 1904 date systems. Date serials become `YYYY-MM-DD` strings, and the existing date normalizer still runs.
7. **Streaming or bounded memory** within the Decision 61 limits (25 MB file, 25,000 rows).
8. **Licence** compatible with commercial distribution (MIT, Apache-2.0 or BSD). No open advisories affecting the used version.

## 3. Candidates

| Candidate                                          | Latest (npm)    | Licence    | Unpacked size | Runtime dependencies                                                                               | Advisories (GitHub Advisory Database)                                                                                                                                                                                       |
| -------------------------------------------------- | --------------- | ---------- | ------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ExcelJS** (`exceljs`)                            | 4.4.0 (2023-10) | MIT        | 21.8 MB       | 9: `jszip`, `unzipper`, `archiver`, `saxes`, `tmp`, `uuid`, `dayjs`, `fast-csv`, `readable-stream` | None open for 4.4.0. Transitive: `tmp` had path-traversal advisories in 2026 (fixed in 0.2.7, within ExcelJS's `^0.2.0` range); `jszip`/`unzipper` history fixed in the resolved versions. No stable release since 2023-10. |
| **SheetJS CE** (`xlsx` on npm)                     | 0.18.5          | Apache-2.0 | 7.5 MB        | 7 (`cfb`, `ssf`, `codepage`, …)                                                                    | **GHSA-4r6h-8v6p-xvw6** prototype pollution (high, < 0.19.3) and **GHSA-5pgg-2g8v-p4x9** ReDoS (high, < 0.20.2). **No fixed version on npm**; fixes are published only on the vendor's own CDN.                             |
| **read-excel-file**                                | 9.3.10          | MIT        | 2.5 MB        | 4: `fflate`, `saxen`, `unzipper-esm`, `worker-f`                                                   | None. `fflate` had a ZIP64 infinite-loop advisory (GHSA-px8p-9vwx-vf98), fixed in 0.8.3; the required `^0.8.3` range excludes it.                                                                                           |
| **write-excel-file**                               | 4.1.1           | MIT        | 1.8 MB        | 1: `fflate`                                                                                        | None.                                                                                                                                                                                                                       |
| **In-house** (`node:zlib` + minimal SpreadsheetML) | —               | —          | —             | 0                                                                                                  | Own security surface: a ZIP central-directory reader, raw inflate with size caps, and a restricted XML tokenizer for `sharedStrings.xml` and one sheet.                                                                     |

## 4. Assessment

- **SheetJS CE (npm): rejected.** The npm package carries two unfixed high-severity advisories. Its fixed builds come from a vendor CDN outside the npm registry, which breaks the lockfile and audit supply-chain controls.
- **ExcelJS: not recommended.**
  - Large (21.8 MB) with nine runtime dependencies, including archive and temp-file libraries with an advisory history.
  - No stable release since October 2023.
  - Feature-rich (styles, formulas, streaming), but most of that is not needed.
- **read-excel-file + write-excel-file: recommended for approval, subject to the checks below.**
  - Small, MIT, actively released in 2026, few dependencies.
  - Built on `fflate`.
  - Cover exactly what's needed: first-sheet values on import, typed cells on export.
- **In-house: fallback.**
  - Viable for **writing** (a fixed SpreadsheetML package deflated with `node:zlib`; small, but still to be sized).
  - Reading is riskier to own: ZIP parsing, inflate limits and XML parsing.

## 5. Checks required before approval of read-excel-file / write-excel-file

1. Confirm the reader can enforce the §2.1 limits while inflating. If it can't, pre-scan the ZIP central directory in-house, reusing the S5-06 detector, and reject oversized or high-ratio entries before handing the file over.
2. Confirm the XML parser (`saxen`) doesn't resolve entities or DTDs, and that `<!DOCTYPE` is rejected or inert.
3. Confirm formula cells return cached values only, and that the reader handles 1904-date workbooks.
4. Confirm `worker-f` isn't used, or can be disabled, on the server.
5. Measure memory and time for a 25 MB / 25,000-row workbook against the CSV baseline.
6. Confirm `pnpm audit` stays clean and the licences of all transitive dependencies.
7. Confirm `write-excel-file` emits values, never formulas, for text starting with `=`, `+`, `-` or `@`.

## 6. Recommendation

Approve **read-excel-file** (import) and **write-excel-file** (export) under Decision 62, conditional on §5, as a follow-up after S6.

- **If §5.1 or §5.2 fails:** use the in-house writer for exports, and keep XLSX import disabled until a reader passes.

Until approval:

- CSV (UTF-8) remains the only format;
- XLSX uploads to an import batch are refused with 415;
- exports are CSV only (the database allows only `'csv'`).

## 7. Implementation (2026-10-08)

The in-house fallback of section 4 was implemented in `modules/data-exchange/xlsx.ts`. **No dependency was added** (`pnpm audit` and the lockfile are unchanged).

| Safety criterion (section 2) | How it is met                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Zip-bomb limits            | Declared sizes are checked against limits before anything is inflated (200 parts, 128 MB per part, 256 MB in total, ratio 200 for parts of 64 KiB or more), `inflateRawSync` runs with `maxOutputLength` equal to the declared size, the produced length must equal it, and the CRC is verified. ZIP64, multi-disk, encrypted and duplicate parts are refused. |
| 2 No DTD or entities         | `<!DOCTYPE` and `<!ENTITY` are refused in every part; only the five XML entities and numeric references are decoded; any other `&` is refused. There is no entity expansion.                                                                                                                                                                                   |
| 3 `.xlsx` only               | Macro-enabled content types, `vbaProject.bin`, `.xlsb` and binary workbook content types are refused (400). Upload detection (S5-06) refuses anything that is not an OOXML package (415).                                                                                                                                                                      |
| 4 No formula evaluation      | Only the cached `<v>` of a cell is read; a formula without a cached value is an empty cell.                                                                                                                                                                                                                                                                    |
| 5 Exported cells             | Text is written as inline strings after formula neutralization (`'` prefix, Decision 24); numbers and dates are typed; the package contains no `<f>` element.                                                                                                                                                                                                  |
| 6 Dates                      | Number cells with a date number format (built-in ids and custom formats) become `YYYY-MM-DD`; the 1900 system (with Excel's phantom 1900-02-29 refused) and the 1904 system are supported; `t="d"` cells are read. Time-of-day is dropped.                                                                                                                     |
| 7 Limits                     | The file is bounded by the 25 MB upload limit and read once into memory (measured: 25,000 rows x 12 columns, 1.2 MB, written in 0.1 s, read in 0.2 s, 240 MB RSS including the test runtime); rows (25,000), columns (200) and characters per row follow Decision 61 and are enforced by the same import pipeline as CSV.                                      |
| 8 Licence                    | None needed.                                                                                                                                                                                                                                                                                                                                                   |

Pipeline integration: the first sheet becomes the same `CsvRecord`s as a CSV, so batches, mapping, saved mappings, validation, staging, error reports and commit are the existing ones. Migration 0052 adds `xlsx` to `import_batches.format` and `exports.format`. `POST /exports` accepts `format: "csv" | "xlsx"` (default `csv`). Limits of the reader: first sheet only, values only, no hidden-sheet logic, no rich-text formatting, shared strings held in memory.
