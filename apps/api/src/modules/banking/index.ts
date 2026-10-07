/**
 * Public contract of the banking module: bank accounts, statement imports (CSV and OFX behind a
 * provider abstraction), matching, bank entries and transfers (accounting source documents),
 * reconciliation and categorization rules. Banking never writes ledger tables and a
 * reconciliation never changes a posted journal line.
 */
export * from './data.js';
export * from './permissions.js';
export * from './statement-parsers.js';
export { bankTransactionStatuses, bankingDocumentStatuses } from './schema.js';
export type { BankTransactionStatus, BankingDocumentStatus } from './schema.js';
