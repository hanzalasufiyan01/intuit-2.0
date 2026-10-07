import { boolean, char, date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Banking tables (migration 0045). */

export const bankTransactionStatuses = ['UNMATCHED', 'MATCHED', 'EXCLUDED'] as const;
export type BankTransactionStatus = (typeof bankTransactionStatuses)[number];
export const bankingDocumentStatuses = ['POSTED', 'VOID'] as const;
export type BankingDocumentStatus = (typeof bankingDocumentStatuses)[number];

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });
const rate = (name: string) => numeric(name, { precision: 28, scale: 10 });

export const bankingNumberSequences = pgTable('banking_number_sequences', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['bank_entry', 'bank_transfer'] }).notNull(),
  prefix: text('prefix').notNull().default(''),
  minDigits: integer('min_digits').notNull().default(5),
  nextNumber: numeric('next_number', { precision: 20, scale: 0 }).notNull().default('1'),
});

export const bankingAccounts = pgTable('banking_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  accountId: uuid('account_id').notNull(),
  name: text('name').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  status: text('status', { enum: ['ACTIVE', 'ARCHIVED'] })
    .notNull()
    .default('ACTIVE'),
  openingBalance: money('opening_balance').notNull().default('0'),
  openingBalanceDate: date('opening_balance_date', { mode: 'string' }),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const bankingStatementImports = pgTable('banking_statement_imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  bankingAccountId: uuid('banking_account_id').notNull(),
  source: text('source', { enum: ['csv', 'ofx'] }).notNull(),
  contentSha256: text('content_sha256').notNull(),
  periodStart: date('period_start', { mode: 'string' }),
  periodEnd: date('period_end', { mode: 'string' }),
  transactionCount: integer('transaction_count').notNull(),
  duplicateCount: integer('duplicate_count').notNull(),
  importedByUserId: uuid('imported_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export const bankingTransactions = pgTable('banking_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  bankingAccountId: uuid('banking_account_id').notNull(),
  importId: uuid('import_id').notNull(),
  txnDate: date('txn_date', { mode: 'string' }).notNull(),
  description: text('description').notNull(),
  reference: text('reference'),
  amount: money('amount').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  balance: money('balance'),
  externalId: text('external_id'),
  fingerprint: text('fingerprint').notNull(),
  status: text('status', { enum: bankTransactionStatuses }).notNull().default('UNMATCHED'),
  excludedReason: text('excluded_reason'),
  excludedByUserId: uuid('excluded_by_user_id'),
  excludedAt: timestamptz('excluded_at'),
  createdAt: timestamptz('created_at').notNull(),
});

export const bankingMatches = pgTable('banking_matches', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  bankingTransactionId: uuid('banking_transaction_id').notNull(),
  journalId: uuid('journal_id').notNull(),
  journalLineId: uuid('journal_line_id').notNull(),
  source: text('source', { enum: ['manual', 'entry', 'transfer'] }).notNull(),
  matchedByUserId: uuid('matched_by_user_id').notNull(),
  matchedAt: timestamptz('matched_at').notNull(),
  unmatchedByUserId: uuid('unmatched_by_user_id'),
  unmatchedAt: timestamptz('unmatched_at'),
});

export const bankingEntries = pgTable('banking_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  bankingTransactionId: uuid('banking_transaction_id').notNull(),
  bankingAccountId: uuid('banking_account_id').notNull(),
  entryDate: date('entry_date', { mode: 'string' }).notNull(),
  direction: text('direction', { enum: ['in', 'out'] }).notNull(),
  amount: money('amount').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  categoryAccountId: uuid('category_account_id').notNull(),
  memo: text('memo').notNull().default(''),
  dimensionValueIds: uuid('dimension_value_ids').array().notNull().default([]),
  exchangeRate: rate('exchange_rate').notNull(),
  exchangeRateSource: text('exchange_rate_source', { enum: ['base', 'table'] }).notNull(),
  baseAmount: money('base_amount').notNull(),
  status: text('status', { enum: bankingDocumentStatuses }).notNull().default('POSTED'),
  journalId: uuid('journal_id').notNull(),
  accountingEventId: uuid('accounting_event_id').notNull(),
  voidedByUserId: uuid('voided_by_user_id'),
  voidedAt: timestamptz('voided_at'),
  voidReason: text('void_reason'),
  voidJournalId: uuid('void_journal_id'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const bankingTransfers = pgTable('banking_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  transferDate: date('transfer_date', { mode: 'string' }).notNull(),
  fromBankingAccountId: uuid('from_banking_account_id').notNull(),
  toBankingAccountId: uuid('to_banking_account_id').notNull(),
  fromCurrencyCode: char('from_currency_code', { length: 3 }).notNull(),
  toCurrencyCode: char('to_currency_code', { length: 3 }).notNull(),
  fromAmount: money('from_amount').notNull(),
  toAmount: money('to_amount').notNull(),
  journalCurrencyCode: char('journal_currency_code', { length: 3 }).notNull(),
  exchangeRate: rate('exchange_rate').notNull(),
  exchangeRateSource: text('exchange_rate_source', {
    enum: ['base', 'table', 'implied'],
  }).notNull(),
  baseAmount: money('base_amount').notNull(),
  memo: text('memo').notNull().default(''),
  dimensionValueIds: uuid('dimension_value_ids').array().notNull().default([]),
  status: text('status', { enum: bankingDocumentStatuses }).notNull().default('POSTED'),
  journalId: uuid('journal_id').notNull(),
  accountingEventId: uuid('accounting_event_id').notNull(),
  voidedByUserId: uuid('voided_by_user_id'),
  voidedAt: timestamptz('voided_at'),
  voidReason: text('void_reason'),
  voidJournalId: uuid('void_journal_id'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const bankingReconciliations = pgTable('banking_reconciliations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  bankingAccountId: uuid('banking_account_id').notNull(),
  status: text('status', { enum: ['COMPLETED', 'REOPENED'] })
    .notNull()
    .default('COMPLETED'),
  statementDate: date('statement_date', { mode: 'string' }).notNull(),
  statementBalance: money('statement_balance').notNull(),
  openingBalance: money('opening_balance').notNull(),
  clearedTotal: money('cleared_total').notNull(),
  itemCount: integer('item_count').notNull(),
  completedByUserId: uuid('completed_by_user_id').notNull(),
  completedAt: timestamptz('completed_at').notNull(),
  reopenedByUserId: uuid('reopened_by_user_id'),
  reopenedAt: timestamptz('reopened_at'),
  reopenReason: text('reopen_reason'),
  version: integer('version').notNull().default(1),
});

export const bankingReconciliationItems = pgTable('banking_reconciliation_items', {
  organizationId: uuid('organization_id').notNull(),
  reconciliationId: uuid('reconciliation_id').notNull(),
  bankingTransactionId: uuid('banking_transaction_id').notNull(),
  amount: money('amount').notNull(),
  counted: boolean('counted').notNull().default(true),
});

export const bankingRules = pgTable('banking_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  bankingAccountId: uuid('banking_account_id'),
  name: text('name').notNull(),
  priority: integer('priority').notNull().default(100),
  direction: text('direction', { enum: ['in', 'out', 'any'] })
    .notNull()
    .default('any'),
  descriptionContains: text('description_contains'),
  minAmount: money('min_amount'),
  maxAmount: money('max_amount'),
  categoryAccountId: uuid('category_account_id').notNull(),
  memo: text('memo').notNull().default(''),
  status: text('status', { enum: ['ACTIVE', 'ARCHIVED'] })
    .notNull()
    .default('ACTIVE'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});
