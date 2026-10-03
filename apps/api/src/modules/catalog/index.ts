/** Public contract of the catalog module (ADR 0004 P4-05): the shared items catalog. */
export * from './items.js';
export * from './permissions.js';
export { salesItemStatuses, salesItemTypes } from './schema.js';
export type { SalesItemStatus, SalesItemType } from './schema.js';
