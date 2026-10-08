-- 0052_xlsx_format — XLSX import and export (Decision 62).
--
-- Imports and exports gain the 'xlsx' format beside 'csv'. Existing rows stay 'csv'. The workbook is
-- read and written by the in-house reader/writer (modules/data-exchange/xlsx.ts); everything else
-- (staging, mapping, validation, limits, permissions) is the existing data-exchange pipeline.

ALTER TABLE import_batches DROP CONSTRAINT import_batches_format_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_format_check CHECK (format IN ('csv', 'xlsx'));
ALTER TABLE exports DROP CONSTRAINT exports_format_check;
ALTER TABLE exports ADD CONSTRAINT exports_format_check CHECK (format IN ('csv', 'xlsx'));
