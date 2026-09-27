/**
 * Public contract of the accounting module: chart of accounts, fiscal years and periods,
 * the journal engine, exchange rates, accounting events and the general ledger.
 * Operational modules integrate through accounting events, never by writing ledger tables.
 */
export * from './accounts.js';
export * from './coa-templates.js';
export * from './events.js';
export * from './exchange-rates.js';
export * from './journals.js';
export * from './ledger.js';
export * from './periods.js';
export * from './permissions.js';
export * from './rules.js';
export * from './setup.js';
export { accountTypes, journalStatuses } from './schema.js';
export type { AccountType, JournalStatus, PeriodStatus } from './schema.js';
