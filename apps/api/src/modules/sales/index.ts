/** Public contract of the sales module (Phase 3B). */
export * from './ar-positions.js';
export * from './calculation.js';
export * from './credit-notes.js';
export * from './document-output.js';
export * from './invoices.js';
export * from './items.js';
export * from './permissions.js';
export * from './posting.js';
export * from './receipts.js';
export * from './sales-reports.js';
export * from './settlement.js';
export * from './settings.js';
export {
  creditNoteStatuses,
  invoiceKinds,
  invoiceStatuses,
  receiptStatuses,
  salesDocumentTypes,
  salesItemStatuses,
  salesItemTypes,
} from './schema.js';
export type {
  CreditNoteStatus,
  InvoiceKind,
  InvoiceStatus,
  ReceiptStatus,
  SalesDocumentType,
  SalesItemStatus,
  SalesItemType,
} from './schema.js';
