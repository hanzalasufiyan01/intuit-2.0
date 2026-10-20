/**
 * Public contract of the projects module (FP-26, migration 0067): projects, members and time
 * entries, plus the project permissions. A project's revenue and cost live in the ledger under its
 * PROJECT dimension value; this module only holds the project facts and the time.
 */
export * from './data.js';
export * from './permissions.js';
export { billingMethods, projectStatuses, timeEntryStatuses } from './schema.js';
export type { BillingMethod, ProjectStatus, TimeEntryStatus } from './schema.js';
