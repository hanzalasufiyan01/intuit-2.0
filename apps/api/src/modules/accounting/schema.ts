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
  smallint,
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

/**
 * Decision 53 account subtype catalog. Each subtype belongs to exactly one account nature.
 * NULL means unclassified (Decision 54).
 */
export const accountSubtypesByType = {
  ASSET: [
    'BANK',
    'CASH',
    'ACCOUNTS_RECEIVABLE',
    'OTHER_CURRENT_ASSET',
    'FIXED_ASSET',
    'OTHER_ASSET',
  ],
  LIABILITY: ['ACCOUNTS_PAYABLE', 'CREDIT_CARD', 'OTHER_CURRENT_LIABILITY', 'LONG_TERM_LIABILITY'],
  EQUITY: ['EQUITY'],
  REVENUE: ['OPERATING_REVENUE', 'OTHER_INCOME'],
  EXPENSE: ['COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_EXPENSE'],
} as const satisfies Record<AccountType, readonly string[]>;
export type AccountSubtype = (typeof accountSubtypesByType)[AccountType][number];
export const accountSubtypes = Object.values(accountSubtypesByType).flat() as AccountSubtype[];

/**
 * Subledgers that maintain a control account (ADR 0004 P4-08): Sales owns the AR control account
 * (Phase 3B E3) and Purchases the AP control account (Phase 4).
 */
export const subledgers = ['sales', 'purchases'] as const;
export type Subledger = (typeof subledgers)[number];

export const accountingCurrencies = pgTable('accounting_currencies', {
  code: char('code', { length: 3 }).primaryKey(),
  minorUnits: smallint('minor_units').notNull(),
  isActive: boolean('is_active').notNull().default(true),
});

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
    subtype: text('subtype').$type<AccountSubtype>(),
    designation: text('designation').$type<Designation>(),
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
  /** Phase 3A S8 (S8-04, S8-13): explicit conversion date; opening journals are dated the day before. */
  conversionDate: isoDate('conversion_date'),
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
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  subtype: text('subtype').$type<AccountSubtype>(),
  isMonetary: boolean('is_monetary').notNull().default(false),
  isControlAccount: boolean('is_control_account').notNull().default(false),
  /** The subledger that maintains this control account (P4-08); NULL when not a control account. */
  controlSubledger: text('control_subledger').$type<Subledger>(),
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

// DISCARDED (S6, L-9): terminal status for never-submitted imported drafts; never deleted.
export const journalStatuses = [
  'DRAFT',
  'PENDING_APPROVAL',
  'POSTED',
  'REVERSED',
  'DISCARDED',
] as const;
export type JournalStatus = (typeof journalStatuses)[number];
export const journalSources = ['manual', 'reversal', 'event', 'system'] as const;
export type JournalSource = (typeof journalSources)[number];
export const journalLineKinds = ['normal', 'base_only'] as const;
export type JournalLineKind = (typeof journalLineKinds)[number];

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
  sourceModule: text('source_module'),
  sourceType: text('source_type'),
  sourceId: uuid('source_id'),
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
  discardedByUserId: uuid('discarded_by_user_id'),
  discardedAt: timestamptz('discarded_at'),
});

export const accountingJournalLines = pgTable('accounting_journal_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  journalId: uuid('journal_id').notNull(),
  lineNumber: integer('line_number').notNull(),
  lineKind: text('line_kind', { enum: journalLineKinds }).notNull().default('normal'),
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

export const designations = [
  'RETAINED_EARNINGS',
  'REALIZED_FX_GAIN_LOSS',
  'UNREALIZED_FX_GAIN_LOSS',
  'ROUNDING_DIFFERENCE',
  'OPENING_BALANCE_EQUITY',
] as const;
export type Designation = (typeof designations)[number];

export const accountingDesignations = pgTable(
  'accounting_designations',
  {
    organizationId: uuid('organization_id').notNull(),
    designation: text('designation', { enum: designations }).notNull(),
    accountId: uuid('account_id').notNull(),
    updatedByUserId: uuid('updated_by_user_id').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.designation] })],
);

export const dimensionStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type DimensionStatus = (typeof dimensionStatuses)[number];

export const accountingDimensionTypes = pgTable('accounting_dimension_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  isRequired: boolean('is_required').notNull().default(false),
  scopeAccountTypes: text('scope_account_types')
    .array()
    .$type<AccountType[]>()
    .notNull()
    .default([]),
  scopeAccountSubtypes: text('scope_account_subtypes')
    .array()
    .$type<AccountSubtype[]>()
    .notNull()
    .default([]),
  status: text('status', { enum: dimensionStatuses }).notNull().default('ACTIVE'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  archivedByUserId: uuid('archived_by_user_id'),
  archivedAt: timestamptz('archived_at'),
});

export const accountingDimensionValues = pgTable('accounting_dimension_values', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  dimensionTypeId: uuid('dimension_type_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: dimensionStatuses }).notNull().default('ACTIVE'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  archivedByUserId: uuid('archived_by_user_id'),
  archivedAt: timestamptz('archived_at'),
});

export const accountingJournalLineDimensions = pgTable(
  'accounting_journal_line_dimensions',
  {
    organizationId: uuid('organization_id').notNull(),
    journalLineId: uuid('journal_line_id').notNull(),
    dimensionTypeId: uuid('dimension_type_id').notNull(),
    dimensionValueId: uuid('dimension_value_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.journalLineId, t.dimensionTypeId] })],
);

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

// ---------------------------------------------------------------------------
// Phase 3A S8: opening balances (S8-02, S8-03)
// ---------------------------------------------------------------------------

export const openingBatchStatuses = ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REVERSED'] as const;
export type OpeningBatchStatus = (typeof openingBatchStatuses)[number];

export const accountingOpeningBalanceBatches = pgTable('accounting_opening_balance_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  status: text('status', { enum: openingBatchStatuses }).notNull().default('DRAFT'),
  conversionDate: isoDate('conversion_date').notNull(),
  openingDate: isoDate('opening_date').notNull(),
  version: integer('version').notNull().default(1),
  notes: text('notes').notNull().default(''),
  approvalRequestId: uuid('approval_request_id'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
  submittedByUserId: uuid('submitted_by_user_id'),
  submittedAt: timestamptz('submitted_at'),
  postedByUserId: uuid('posted_by_user_id'),
  postedAt: timestamptz('posted_at'),
  reversedByUserId: uuid('reversed_by_user_id'),
  reversedAt: timestamptz('reversed_at'),
  reversalReason: text('reversal_reason'),
});

export interface OpeningLineDimension {
  dimensionTypeId: string;
  dimensionValueId: string;
}

export const accountingOpeningBalanceLines = pgTable('accounting_opening_balance_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  lineNumber: integer('line_number').notNull(),
  accountId: uuid('account_id').notNull(),
  description: text('description').notNull().default(''),
  debit: amount('debit'),
  credit: amount('credit'),
  baseAmount: amount('base_amount'),
  dimensions: jsonb('dimensions').$type<OpeningLineDimension[]>().notNull().default([]),
});

// ---------------------------------------------------------------------------
// Phase 3A S9: revaluation runs (Decision 9)
// ---------------------------------------------------------------------------

export const revaluationRunStatuses = ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REVERSED'] as const;
export type RevaluationRunStatus = (typeof revaluationRunStatuses)[number];
export const revaluationMethods = ['REVERSING', 'ADJUSTING'] as const;
export type RevaluationMethod = (typeof revaluationMethods)[number];
export const revaluationJournalRoles = [
  'REVALUATION',
  'SCHEDULED_REVERSAL',
  'CANCELLATION',
] as const;
export type RevaluationJournalRole = (typeof revaluationJournalRoles)[number];

export const accountingRevaluationRuns = pgTable('accounting_revaluation_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  status: text('status', { enum: revaluationRunStatuses }).notNull().default('DRAFT'),
  method: text('method', { enum: revaluationMethods }).notNull().default('REVERSING'),
  revaluationDate: isoDate('revaluation_date').notNull(),
  reversalDate: isoDate('reversal_date'),
  baseCurrency: char('base_currency', { length: 3 }).notNull(),
  unrealizedAccountId: uuid('unrealized_account_id').notNull(),
  version: integer('version').notNull().default(1),
  runKey: text('run_key'),
  approvalRequestId: uuid('approval_request_id'),
  jobId: uuid('job_id'),
  trigger: text('trigger', { enum: ['user', 'job'] })
    .notNull()
    .default('user'),
  netAdjustment: amount('net_adjustment').notNull().default('0'),
  totalGain: amount('total_gain').notNull().default('0'),
  totalLoss: amount('total_loss').notNull().default('0'),
  lineCount: integer('line_count').notNull().default(0),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
  postedByUserId: uuid('posted_by_user_id'),
  postedAt: timestamptz('posted_at'),
  reversedByUserId: uuid('reversed_by_user_id'),
  reversedAt: timestamptz('reversed_at'),
  reversalReason: text('reversal_reason'),
});

export const accountingRevaluationLines = pgTable('accounting_revaluation_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  runId: uuid('run_id').notNull(),
  lineNumber: integer('line_number').notNull(),
  exposureKind: text('exposure_kind', { enum: ['ACCOUNT', 'DOCUMENT'] }).notNull(),
  accountId: uuid('account_id').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  documentModule: text('document_module'),
  documentType: text('document_type'),
  documentId: uuid('document_id'),
  foreignBalance: amount('foreign_balance').notNull(),
  carryingBase: amount('carrying_base').notNull(),
  rate: rate('rate').notNull(),
  rateDate: isoDate('rate_date').notNull(),
  rateSource: text('rate_source', { enum: ['table', 'manual'] }).notNull(),
  revaluedBase: amount('revalued_base').notNull(),
  adjustment: amount('adjustment').notNull(),
});

export const accountingRevaluationRunJournals = pgTable(
  'accounting_revaluation_run_journals',
  {
    organizationId: uuid('organization_id').notNull(),
    runId: uuid('run_id').notNull(),
    journalId: uuid('journal_id').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    role: text('role', { enum: revaluationJournalRoles }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.journalId] })],
);
