import { date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Expense claim tables (migration 0049). */

export const claimStatuses = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'POSTED',
  'CANCELLED',
  'VOID',
] as const;
export type ClaimStatus = (typeof claimStatuses)[number];

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });

export const expenseClaimSettings = pgTable('expense_claim_settings', {
  organizationId: uuid('organization_id').primaryKey(),
  defaultExpenseAccountId: uuid('default_expense_account_id'),
  receiptRequiredOver: money('receipt_required_over'),
  version: integer('version').notNull().default(1),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const expenseClaimNumberSequences = pgTable('expense_claim_number_sequences', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['claim'] }).notNull(),
  prefix: text('prefix').notNull().default(''),
  minDigits: integer('min_digits').notNull().default(5),
  nextNumber: numeric('next_number', { precision: 20, scale: 0 }).notNull().default('1'),
});

export const expenseClaims = pgTable('expense_claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  status: text('status', { enum: claimStatuses }).notNull().default('DRAFT'),
  number: text('number'),
  employeePartyId: uuid('employee_party_id').notNull(),
  claimDate: date('claim_date', { mode: 'string' }).notNull(),
  memo: text('memo').notNull().default(''),
  total: money('total').notNull().default('0'),
  approvalRequestId: uuid('approval_request_id'),
  submittedByUserId: uuid('submitted_by_user_id'),
  submittedAt: timestamptz('submitted_at'),
  approvedAt: timestamptz('approved_at'),
  billId: uuid('bill_id'),
  postedByUserId: uuid('posted_by_user_id'),
  postedAt: timestamptz('posted_at'),
  cancelledByUserId: uuid('cancelled_by_user_id'),
  cancelledAt: timestamptz('cancelled_at'),
  cancelReason: text('cancel_reason'),
  voidedByUserId: uuid('voided_by_user_id'),
  voidedAt: timestamptz('voided_at'),
  voidReason: text('void_reason'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const expenseClaimLines = pgTable('expense_claim_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  claimId: uuid('claim_id').notNull(),
  lineNo: integer('line_no').notNull(),
  expenseDate: date('expense_date', { mode: 'string' }).notNull(),
  description: text('description').notNull(),
  accountId: uuid('account_id').notNull(),
  amount: money('amount').notNull(),
});
