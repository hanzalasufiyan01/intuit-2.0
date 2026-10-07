/**
 * Public contract of the expense-claims module: employee claims with lines, their lifecycle and
 * the link to the reimbursable bill. The module never writes ledger tables: a posted claim is a
 * bill from the employee as a vendor, created through Purchases.
 */
export * from './data.js';
export * from './permissions.js';
export { claimStatuses } from './schema.js';
export type { ClaimStatus } from './schema.js';
