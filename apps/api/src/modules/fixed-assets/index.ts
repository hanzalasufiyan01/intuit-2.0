/**
 * Public contract of the fixed-assets module: categories, the asset register, the immutable
 * ledger of cost and accumulated depreciation, depreciation runs, disposals and transfers.
 * Posting goes through accounting events; this module never writes ledger tables.
 */
export * from './data.js';
export * from './permissions.js';
export { assetEntryKinds, assetStatuses, depreciationMethods } from './schema.js';
export type { DepreciationMethod } from './schema.js';
export type { AssetEntryKind, AssetStatus } from './schema.js';
