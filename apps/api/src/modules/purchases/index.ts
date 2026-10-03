/** Public contract of the purchases module (Phase 4): settings, numbering, bills and vendor credits. */
export * from './bills.js';
export * from './permissions.js';
export * from './settings.js';
export * from './vendor-credits.js';
export {
  billKinds,
  billStatuses,
  purchaseDocumentTypes,
  vendorCreditOrigins,
  vendorCreditStatuses,
} from './schema.js';
export type {
  BillKind,
  BillStatus,
  PurchaseDocumentType,
  VendorCreditOrigin,
  VendorCreditStatus,
} from './schema.js';
