/**
 * Public contract of the purchase-orders module: orders (no journal), goods receipts, the links
 * between orders and bills, the quantities billed and the recorded three-way match.
 */
export * from './data.js';
export * from './permissions.js';
export { matchModes, orderStatuses } from './schema.js';
export type { MatchIssue, MatchMode, OrderStatus } from './schema.js';
