/** Public contract of the purchases module (Phase 4): settings, numbering and bills. */
export * from './bills.js';
export * from './permissions.js';
export * from './settings.js';
export { billKinds, billStatuses, purchaseDocumentTypes } from './schema.js';
export type { BillKind, BillStatus, PurchaseDocumentType } from './schema.js';
