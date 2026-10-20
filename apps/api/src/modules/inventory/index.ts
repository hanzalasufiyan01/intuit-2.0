/**
 * Public contract of the inventory module: tracked items, the immutable stock ledger, running
 * balances (perpetual weighted-average cost), stock adjustments and valuation. Inventory never
 * writes ledger tables: postings go through accounting events.
 */
export * from './bundles.js';
export * from './counts.js';
export * from './landed-cost.js';
export * from './lots.js';
export * from './warehouses.js';
export * from './data.js';
export * from './permissions.js';
export { movementKinds, negativeStockPolicies } from './schema.js';
export type { MovementKind, NegativeStockPolicy } from './schema.js';
