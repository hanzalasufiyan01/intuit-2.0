/**
 * Public contract of the quotes module (FP-28, migration 0068): sales quotes, recurring invoice
 * schedules, the recurrence arithmetic and the permissions. Neither posts to the ledger: a quote
 * converts into, and a schedule generates, DRAFT sales invoices through the Sales module.
 */
export * from './data.js';
export * from './permissions.js';
export * from './recurrence.js';
export { quoteStatuses, scheduleStatuses } from './schema.js';
export type { QuoteStatus, ScheduleStatus } from './schema.js';
