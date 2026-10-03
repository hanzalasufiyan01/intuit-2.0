/**
 * Aggregated Drizzle schema for the shared database client.
 * Each module owns and defines its own tables; this file only re-exports them.
 * SQL migrations in ./migrations are the source of truth for the physical schema.
 */
export * from '../modules/identity/schema.js';
export * from '../modules/organizations/schema.js';
export * from '../modules/access-control/schema.js';
export * from '../modules/audit/schema.js';
export * from '../modules/outbox/schema.js';
export * from '../modules/approvals/schema.js';
export * from '../modules/accounting/schema.js';
export * from '../modules/parties/schema.js';
export * from '../modules/files/schema.js';
export * from '../modules/jobs/schema.js';
export * from '../modules/data-exchange/schema.js';
export * from '../modules/idempotency/schema.js';
export * from '../modules/tax/schema.js';
export * from '../modules/customers/schema.js';
export * from '../modules/catalog/schema.js';
export * from '../modules/sales/schema.js';
export * from '../modules/vendors/schema.js';
export * from '../modules/purchases/schema.js';
