import { boolean, char, date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Direct expenses (migration 0041; ADR 0004 P4-37, P4-44). */

export const expenseStatuses = ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'VOID'] as const;
export type ExpenseStatus = (typeof expenseStatuses)[number];

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });

export const purchasesExpenses = pgTable('purchases_expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  status: text('status', { enum: expenseStatuses }).notNull().default('DRAFT'),
  vendorId: uuid('vendor_id').notNull(),
  number: text('number'),
  /** The supplier's receipt or invoice number; optional, kept as entered. */
  vendorReference: text('vendor_reference'),
  expenseDate: date('expense_date', { mode: 'string' }).notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  /** The bank, cash or card account paid from; null on a draft until chosen or defaulted at post. */
  paymentAccountId: uuid('payment_account_id'),
  rateOverride: numeric('rate_override', { precision: 28, scale: 10 }),
  rateOverrideReason: text('rate_override_reason'),
  exchangeRate: numeric('exchange_rate', { precision: 28, scale: 10 }),
  exchangeRateSource: text('exchange_rate_source', { enum: ['base', 'table', 'manual'] }),
  tableRate: numeric('table_rate', { precision: 28, scale: 10 }),
  taxTreatment: text('tax_treatment', { enum: ['exclusive', 'inclusive', 'no_tax'] }).notNull(),
  discountType: text('discount_type', { enum: ['percent', 'amount'] }),
  discountValue: money('discount_value'),
  memo: text('memo').notNull().default(''),
  dimensionValueIds: uuid('dimension_value_ids').array().notNull().default([]),
  subtotal: money('subtotal').notNull().default('0'),
  discountTotal: money('discount_total').notNull().default('0'),
  taxTotal: money('tax_total').notNull().default('0'),
  recoverableTaxTotal: money('recoverable_tax_total').notNull().default('0'),
  total: money('total').notNull().default('0'),
  baseTotal: money('base_total'),
  approvalRequestId: uuid('approval_request_id'),
  submittedByUserId: uuid('submitted_by_user_id'),
  submittedAt: timestamptz('submitted_at'),
  postedByUserId: uuid('posted_by_user_id'),
  postedAt: timestamptz('posted_at'),
  journalId: uuid('journal_id'),
  accountingEventId: uuid('accounting_event_id'),
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

/** The same line columns as a bill's (P4-11, P4-12, P4-19). */
export const purchasesExpenseLines = pgTable('purchases_expense_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  expenseId: uuid('expense_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id'),
  description: text('description').notNull(),
  accountId: uuid('account_id'),
  quantity: numeric('quantity', { precision: 28, scale: 6 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 28, scale: 6 }).notNull(),
  discountType: text('discount_type', { enum: ['percent', 'amount'] }),
  discountValue: money('discount_value'),
  amount: money('amount').notNull(),
  lineDiscount: money('line_discount').notNull().default('0'),
  documentDiscount: money('document_discount').notNull().default('0'),
  netAmount: money('net_amount').notNull(),
  taxCodeId: uuid('tax_code_id'),
  taxRateId: uuid('tax_rate_id'),
  taxRate: numeric('tax_rate', { precision: 7, scale: 4 }),
  taxAmount: money('tax_amount').notNull().default('0'),
  taxRecoverableOverride: boolean('tax_recoverable_override'),
  taxRecoverable: boolean('tax_recoverable').notNull().default(false),
  recoverableTax: money('recoverable_tax').notNull().default('0'),
  nonRecoverableTax: money('non_recoverable_tax').notNull().default('0'),
  inputTaxAccountId: uuid('input_tax_account_id'),
  total: money('total').notNull(),
  dimensionValueIds: uuid('dimension_value_ids').array().notNull().default([]),
});
