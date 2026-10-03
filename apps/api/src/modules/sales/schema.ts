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
import { taxTreatments } from '../tax/index.js';

/** Phase 3B: Sales settings, numbering and the items catalog (migration 0021). */

export const salesSettings = pgTable('sales_settings', {
  organizationId: uuid('organization_id').primaryKey(),
  arAccountId: uuid('ar_account_id'),
  defaultRevenueAccountId: uuid('default_revenue_account_id'),
  defaultDepositAccountId: uuid('default_deposit_account_id'),
  defaultTaxCodeId: uuid('default_tax_code_id'),
  defaultTaxTreatment: text('default_tax_treatment', { enum: taxTreatments })
    .notNull()
    .default('exclusive'),
  defaultPaymentTermsDays: integer('default_payment_terms_days').notNull().default(30),
  arLockedAt: timestamptz('ar_locked_at'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const salesDocumentTypes = ['invoice', 'credit_note', 'receipt'] as const;
export type SalesDocumentType = (typeof salesDocumentTypes)[number];

export const salesNumberSequences = pgTable(
  'sales_number_sequences',
  {
    organizationId: uuid('organization_id').notNull(),
    documentType: text('document_type', { enum: salesDocumentTypes }).notNull(),
    prefix: text('prefix').notNull().default(''),
    minDigits: integer('min_digits').notNull().default(5),
    nextNumber: bigint('next_number', { mode: 'number' }).notNull().default(1),
    version: integer('version').notNull().default(1),
    updatedByUserId: uuid('updated_by_user_id'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.documentType] })],
);

// ---------------------------------------------------------------------------
// Documents (migration 0022)
// ---------------------------------------------------------------------------

export const invoiceKinds = ['standard', 'opening'] as const;
export type InvoiceKind = (typeof invoiceKinds)[number];
export const invoiceStatuses = ['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'VOID'] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];
export const creditNoteStatuses = ['DRAFT', 'PENDING_APPROVAL', 'ISSUED'] as const;
export type CreditNoteStatus = (typeof creditNoteStatuses)[number];
const discountTypeValues = ['percent', 'amount'] as const;

const documentColumns = {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  number: text('number'),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  exchangeRate: numeric('exchange_rate', { precision: 28, scale: 10 }),
  taxTreatment: text('tax_treatment', { enum: taxTreatments }).notNull(),
  discountType: text('discount_type', { enum: discountTypeValues }),
  discountValue: numeric('discount_value', { precision: 28, scale: 4 }),
  reference: text('reference'),
  memo: text('memo').notNull().default(''),
  dimensionValueIds: uuid('dimension_value_ids').array().notNull().default([]),
  subtotal: numeric('subtotal', { precision: 28, scale: 4 }).notNull().default('0'),
  discountTotal: numeric('discount_total', { precision: 28, scale: 4 }).notNull().default('0'),
  taxTotal: numeric('tax_total', { precision: 28, scale: 4 }).notNull().default('0'),
  total: numeric('total', { precision: 28, scale: 4 }).notNull().default('0'),
  baseTotal: numeric('base_total', { precision: 28, scale: 4 }),
  approvalRequestId: uuid('approval_request_id'),
  submittedByUserId: uuid('submitted_by_user_id'),
  submittedAt: timestamptz('submitted_at'),
  issuedByUserId: uuid('issued_by_user_id'),
  issuedAt: timestamptz('issued_at'),
  journalId: uuid('journal_id'),
  accountingEventId: uuid('accounting_event_id'),
  renderSnapshot: jsonb('render_snapshot').$type<Record<string, unknown>>(),
  pdfFileId: uuid('pdf_file_id'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
};

export const salesInvoices = pgTable('sales_invoices', {
  ...documentColumns,
  kind: text('kind', { enum: invoiceKinds }).notNull().default('standard'),
  status: text('status', { enum: invoiceStatuses }).notNull().default('DRAFT'),
  invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  paymentTermsDays: integer('payment_terms_days'),
  exchangeRateSource: text('exchange_rate_source', { enum: ['base', 'table', 'carrying'] }),
  openingBaseTotal: numeric('opening_base_total', { precision: 28, scale: 4 }),
  amountDue: numeric('amount_due', { precision: 28, scale: 4 }),
  baseDue: numeric('base_due', { precision: 28, scale: 4 }),
  voidedByUserId: uuid('voided_by_user_id'),
  voidedAt: timestamptz('voided_at'),
  voidReason: text('void_reason'),
  voidJournalId: uuid('void_journal_id'),
});

export const salesCreditNotes = pgTable('sales_credit_notes', {
  ...documentColumns,
  status: text('status', { enum: creditNoteStatuses }).notNull().default('DRAFT'),
  invoiceId: uuid('invoice_id'),
  creditDate: date('credit_date', { mode: 'string' }).notNull(),
  exchangeRateSource: text('exchange_rate_source', { enum: ['base', 'table', 'invoice'] }),
  amountUnapplied: numeric('amount_unapplied', { precision: 28, scale: 4 }),
  baseUnapplied: numeric('base_unapplied', { precision: 28, scale: 4 }),
});

const lineColumns = {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id'),
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 28, scale: 6 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 28, scale: 6 }).notNull(),
  discountType: text('discount_type', { enum: discountTypeValues }),
  discountValue: numeric('discount_value', { precision: 28, scale: 4 }),
  amount: numeric('amount', { precision: 28, scale: 4 }).notNull(),
  lineDiscount: numeric('line_discount', { precision: 28, scale: 4 }).notNull().default('0'),
  documentDiscount: numeric('document_discount', { precision: 28, scale: 4 })
    .notNull()
    .default('0'),
  netAmount: numeric('net_amount', { precision: 28, scale: 4 }).notNull(),
  taxCodeId: uuid('tax_code_id'),
  taxRateId: uuid('tax_rate_id'),
  taxRate: numeric('tax_rate', { precision: 7, scale: 4 }),
  taxAmount: numeric('tax_amount', { precision: 28, scale: 4 }).notNull().default('0'),
  total: numeric('total', { precision: 28, scale: 4 }).notNull(),
  revenueAccountId: uuid('revenue_account_id'),
  dimensionValueIds: uuid('dimension_value_ids').array().notNull().default([]),
};

export const salesInvoiceLines = pgTable('sales_invoice_lines', {
  ...lineColumns,
  invoiceId: uuid('invoice_id').notNull(),
});

export const salesCreditNoteLines = pgTable('sales_credit_note_lines', {
  ...lineColumns,
  creditNoteId: uuid('credit_note_id').notNull(),
});

// ---------------------------------------------------------------------------
// Receipts and allocations (migration 0023)
// ---------------------------------------------------------------------------

export const receiptStatuses = ['RECORDED', 'VOID'] as const;
export type ReceiptStatus = (typeof receiptStatuses)[number];

export const salesReceipts = pgTable('sales_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  status: text('status', { enum: receiptStatuses }).notNull().default('RECORDED'),
  number: text('number').notNull(),
  customerId: uuid('customer_id').notNull(),
  receiptDate: date('receipt_date', { mode: 'string' }).notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  amount: numeric('amount', { precision: 28, scale: 4 }).notNull(),
  exchangeRate: numeric('exchange_rate', { precision: 28, scale: 10 }).notNull(),
  exchangeRateSource: text('exchange_rate_source', { enum: ['base', 'table', 'manual'] }).notNull(),
  tableRate: numeric('table_rate', { precision: 28, scale: 10 }),
  rateOverrideReason: text('rate_override_reason'),
  depositAccountId: uuid('deposit_account_id').notNull(),
  depositAccountOverridden: boolean('deposit_account_overridden').notNull().default(false),
  baseAmount: numeric('base_amount', { precision: 28, scale: 4 }).notNull(),
  amountUnallocated: numeric('amount_unallocated', { precision: 28, scale: 4 }).notNull(),
  baseUnallocated: numeric('base_unallocated', { precision: 28, scale: 4 }).notNull(),
  reference: text('reference'),
  memo: text('memo').notNull().default(''),
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

export const allocationSourceTypes = ['receipt', 'credit_note'] as const;
export type AllocationSourceType = (typeof allocationSourceTypes)[number];

export const salesAllocations = pgTable('sales_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  sourceType: text('source_type', { enum: allocationSourceTypes }).notNull(),
  receiptId: uuid('receipt_id'),
  creditNoteId: uuid('credit_note_id'),
  invoiceId: uuid('invoice_id').notNull(),
  mode: text('mode', { enum: ['receipt', 'credit'] }).notNull(),
  allocationDate: date('allocation_date', { mode: 'string' }).notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  amount: numeric('amount', { precision: 28, scale: 4 }).notNull(),
  baseRelieved: numeric('base_relieved', { precision: 28, scale: 4 }).notNull(),
  sourceBase: numeric('source_base', { precision: 28, scale: 4 }).notNull(),
  fxDifference: numeric('fx_difference', { precision: 28, scale: 4 }).notNull(),
  reversesAllocationId: uuid('reverses_allocation_id'),
  journalId: uuid('journal_id').notNull(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

// ---------------------------------------------------------------------------
// Document email (migration 0024)
// ---------------------------------------------------------------------------

export const salesDocumentEmails = pgTable('sales_document_emails', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['invoice', 'credit_note'] }).notNull(),
  documentId: uuid('document_id').notNull(),
  recipient: text('recipient').notNull(),
  subject: text('subject').notNull(),
  message: text('message').notNull().default(''),
  status: text('status', { enum: ['queued', 'sent', 'failed'] })
    .notNull()
    .default('queued'),
  jobId: uuid('job_id'),
  fileId: uuid('file_id'),
  requestedByUserId: uuid('requested_by_user_id').notNull(),
  requestedAt: timestamptz('requested_at').notNull(),
  sentAt: timestamptz('sent_at'),
});
