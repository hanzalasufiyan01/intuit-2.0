/**
 * Public contract of the data-exchange module (Decisions 7, 24, 61, 75; S6-01): import batches,
 * staged rows, saved mappings, exports, the in-house CSV reader/writer, formula neutralization
 * and cell normalization. It never writes other modules' tables; domain rules and record
 * creation belong to the application layer's import/export domain registry.
 */
export * from './batches.js';
export * from './csv.js';
export * as normalize from './normalize.js';
export {
  exportDomainKeys,
  exportStatuses,
  finishedImportStatuses,
  importDomainKeys,
  importRowStatuses,
  importStatuses,
} from './schema.js';
export type {
  ExportDomainKey,
  ExportStatus,
  ImportDomainKey,
  ImportOptions,
  ImportRowStatus,
  ImportStatus,
  RowMessage,
} from './schema.js';

/** Decision 61 maxima and S6-40 defaults (configuration may lower, never raise, the maxima). */
export const IMPORT_LIMITS = {
  maxRows: 25_000,
  previewRows: 500,
  maxColumns: 200,
  maxCellChars: 10_000,
  maxRecordChars: 1_000_000,
} as const;
