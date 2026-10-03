/** Public contract of the sales module (Phase 3B). */
// The document arithmetic moved to the shared `documents` engine (Phase 4 P4-04); Sales keeps
// re-exporting it so its contract is unchanged.
export * from '../documents/index.js';
// The items catalog moved to the shared `catalog` module (Phase 4 P4-05); re-exported likewise.
export * from '../catalog/index.js';
export * from './ar-positions.js';
export * from './credit-notes.js';
export * from './document-output.js';
export * from './invoices.js';
export * from './permissions.js';
export * from './receipts.js';
export * from './sales-reports.js';
export * from './settings.js';
export {
  creditNoteStatuses,
  invoiceKinds,
  invoiceStatuses,
  receiptStatuses,
  salesDocumentTypes,
} from './schema.js';
export type {
  CreditNoteStatus,
  InvoiceKind,
  InvoiceStatus,
  ReceiptStatus,
  SalesDocumentType,
} from './schema.js';
