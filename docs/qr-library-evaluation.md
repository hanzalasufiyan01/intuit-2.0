# QR Library Evaluation (Decision 62, S7-10)

- **Status:** **`qrcode-generator` 2.0.4 approved** for S7 (ruling S7-10, "subject to Decision 62 verification"). This report is that verification. It is used only by the API, to render the TOTP enrollment QR code (Decision 49).
- **Date:** 2026-09-28 (registry and advisory data as of this date).

## 1. Candidates checked

| Candidate          | Version | Licence | Runtime deps                       | Unpacked size | Advisories (GitHub Advisory Database) |
| ------------------ | ------- | ------- | ---------------------------------- | ------------- | ------------------------------------- |
| `qrcode-generator` | 2.0.4   | MIT     | 0                                  | 0.56 MB       | None                                  |
| `lean-qr`          | 2.7.4   | MIT     | 0                                  | 69 KB         | None                                  |
| `uqr`              | 0.1.3   | MIT     | 0                                  | 79 KB         | None                                  |
| `qrcode`           | 1.5.4   | MIT     | 3 (`pngjs`, `yargs`, `dijkstrajs`) | 135 KB        | None                                  |

## 2. Verification of the approved library

| Criterion        | Result                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licence          | MIT (Kazuhiko Arase). Compatible with commercial distribution.                                                                                      |
| Dependencies     | None at runtime; nothing transitive.                                                                                                                |
| Security         | No GitHub advisories. It only encodes an in-memory string into a module matrix: no parsing of untrusted input, no I/O, no network, no dynamic code. |
| Maintenance      | Long-standing project; 2.0.x released in 2025; ships its own TypeScript declarations and ESM build.                                                 |
| Size / placement | API only (server-side rendering), so the web bundle is unchanged.                                                                                   |
| Fit              | Byte mode, error-correction level M, automatic version: fits an `otpauth://` URI with a 32-character secret.                                        |
| Supply chain     | Pinned exactly (`"qrcode-generator": "2.0.4"`) with the lockfile; `pnpm audit` clean.                                                               |

## 3. How it is used (S7-10)

- `apps/api/src/infrastructure/security/qr.ts` asks the library only for the module matrix (`isDark`). The SVG is built in-house from rectangles, so the image contains no text, no script and nothing taken from the encoded value except dark and light modules. The library's own HTML/SVG helpers are not used.
- The SVG is returned once, as a `data:image/svg+xml` URI, in the enrollment response (`Cache-Control: no-store`), and displayed in an `<img>`, where SVG cannot run scripts. Nothing is stored.
- The manual key (grouped base32) is always shown as well (S7-13).
