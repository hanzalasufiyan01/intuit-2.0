import {
  bigint,
  boolean,
  char,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Monetary columns are PostgreSQL numeric, read and written as exact decimal strings. */
const amount = (name: string) => numeric(name, { precision: 28, scale: 4 });
const rate = (name: string) => numeric(name, { precision: 28, scale: 10 });
const isoDate = (name: string) => date(name, { mode: 'string' });

export const accountTypes = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
export type AccountType = (typeof accountTypes)[number];

export const accountingCoaTemplates = pgTable('accounting_coa_templates', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  sortOrder: integer('sort_order').notNull(),
});

export const accountingCoaTemplateAccounts = pgTable(
  'accounting_coa_template_accounts',
  {
    templateKey: text('template_key').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    accountType: text('account_type', { enum: accountTypes }).notNull(),
    parentCode: text('parent_code'),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [primaryKey({ columns: [t.templateKey, t.code] })],
);

export const accountingSettings = pgTable('accounting_settings', {
  organizationId: uuid('organization_id').primaryKey(),
  baseCurrency: char('base_currency', { length: 3 }).notNull(),
  coaTemplateKey: text('coa_template_key').notNull(),
  nextJournalNumber: bigint('next_journal_number', { mode: 'number' }).notNull().default(1),
  setupByUserId: uuid('setup_by_user_id').notNull(),
  setupAt: timestamptz('setup_at').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const accountStatuses = ['ACTIVE', 'ARCHIVED'] as const;

export const accountingAccounts = pgTable('accounting_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  accountType: text('account_type', { enum: accountTypes }).notNull(),
  parentId: uuid('parent_id'),
  status: text('status', { enum: accountStatuses }).notNull().default('ACTIVE'),
  isSystem: boolean('is_system').notNull().default(false),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  archivedByUserId: uuid('archived_by_user_id'),
  archivedAt: timestamptz('archived_at'),
});

export const accountingExchangeRates = pgTable('accounting_exchange_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  fromCurrency: char('from_currency', { length: 3 }).notNull(),
  toCurrency: char('to_currency', { length: 3 }).notNull(),
  rateDate: isoDate('rate_date').notNull(),
  rate: rate('rate').notNull(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const accountingFiscalYears = pgTable('accounting_fiscal_years', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  name: text('name').notNull(),
  startDate: isoDate('start_date').notNull(),
  endDate: isoDate('end_date').notNull(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const periodStatuses = ['OPEN', 'CLOSED'] as const;
export type PeriodStatus = (typeof periodStatuses)[number];

export const accountingPeriods = pgTable('accounting_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  fiscalYearId: uuid('fiscal_year_id').notNull(),
  periodNumber: integer('period_number').notNull(),
  name: text('name').notNull(),
  startDate: isoDate('start_date').notNull(),
  endDate: isoDate('end_date').notNull(),
  status: text('status', { enum: periodStatuses }).notNull().default('OPEN'),
  closedAt: timestamptz('closed_at'),
  closedByUserId: uuid('closed_by_user_id'),
  reopenedAt: timestamptz('reopened_at'),
  reopenedByUserId: uuid('reopened_by_user_id'),
  reopenReason: text('reopen_reason'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const journalStatuses = ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REVERSED'] as const;
export type JournalStatus = (typeof journalStatuses)[number];
export const journalSources = ['manual', 'reversal', 'event'] as const;

export const accountingJournalEntries = pgTable('accounting_journal_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  journalNumber: bigint('journal_number', { mode: 'number' }),
  status: text('status', { enum: journalStatuses }).notNull().default('DRAFT'),
  source: text('source', { enum: journalSources }).notNull().default('manual'),
  entryDate: isoDate('entry_date'),
  periodId: uuid('period_id'),
  description: text('description').notNull().default(''),
  reference: text('reference').notNull().default(''),
  currency: char('currency', { length: 3 }).notNull(),
  exchangeRate: rate('exchange_rate'),
  exchangeRateSource: text('exchange_rate_source', { enum: ['base', 'manual', 'table'] }),
  baseCurrency: char('base_currency', { length: 3 }),
  totalDebit: amount('total_debit'),
  totalCredit: amount('total_credit'),
  totalBaseDebit: amount('total_base_debit'),
  totalBaseCredit: amount('total_base_credit'),
  approvalRequestId: uuid('approval_request_id'),
  accountingEventId: uuid('accounting_event_id'),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  submittedByUserId: uuid('submitted_by_user_id'),
  submittedAt: timestamptz('submitted_at'),
  postedByUserId: uuid('posted_by_user_id'),
  postedAt: timestamptz('posted_at'),
  reversedByUserId: uuid('reversed_by_user_id'),
  reversedAt: timestamptz('reversed_at'),
});

export const accountingJournalLines = pgTable('accounting_journal_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  journalId: uuid('journal_id').notNull(),
  lineNumber: integer('line_number').notNull(),
  accountId: uuid('account_id'),
  description: text('description').notNull().default(''),
  debit: amount('debit'),
  credit: amount('credit'),
  baseDebit: amount('base_debit'),
  baseCredit: amount('base_credit'),
  roundingAdjustment: amount('rounding_adjustment').notNull().default('0'),
});

export const accountingJournalReversals = pgTable('accounting_journal_reversals', {
  organizationId: uuid('organization_id').notNull(),
  originalJournalId: uuid('original_journal_id').primaryKey(),
  reversalJournalId: uuid('reversal_journal_id').notNull(),
  reason: text('reason').notNull(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export const accountingEventStatuses = ['received', 'processed', 'failed'] as const;

export const accountingEvents = pgTable('accounting_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  sourceModule: text('source_module').notNull(),
  eventType: text('event_type').notNull(),
  eventKey: text('event_key').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  payloadHash: text('payload_hash').notNull(),
  status: text('status', { enum: accountingEventStatuses }).notNull().default('received'),
  journalId: uuid('journal_id'),
  error: text('error'),
  occurredAt: timestamptz('occurred_at').notNull(),
  receivedAt: timestamptz('received_at').notNull(),
  processedAt: timestamptz('processed_at'),
});
