/**
 * Public contract of the purchases module (Phase 4): settings, numbering, bills, vendor credits,
 * vendor payments and allocations.
 */
export * from './bills.js';
export * from './payments.js';
export * from './permissions.js';
export * from './settings.js';
export * from './vendor-credits.js';
export {
  billKinds,
  billStatuses,
  paymentStatuses,
  purchaseDocumentTypes,
  vendorCreditOrigins,
  vendorCreditStatuses,
} from './schema.js';
export type {
  BillKind,
  BillStatus,
  PaymentStatus,
  PurchaseDocumentType,
  VendorCreditOrigin,
  VendorCreditStatus,
} from './schema.js';
