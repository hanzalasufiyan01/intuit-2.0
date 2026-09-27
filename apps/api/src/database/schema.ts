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
