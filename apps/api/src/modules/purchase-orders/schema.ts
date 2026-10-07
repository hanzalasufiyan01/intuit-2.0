import {
  boolean,
  char,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Purchase orders, goods receipts and three-way matching (migration 0047). */

export const orderStatuses = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof orderStatuses)[number];
export const matchModes = ['off', 'warning', 'block'] as const;
export type MatchMode = (typeof matchModes)[number];

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });

export const purchaseOrderSettings = pgTable('purchase_order_settings', {
  organizationId: uuid('organization_id').primaryKey(),
  matchMode: text('match_mode', { enum: matchModes }).notNull().default('off'),
  quantityTolerancePct: numeric('quantity_tolerance_pct', { precision: 7, scale: 4 })
    .notNull()
    .default('0'),
  priceTolerancePct: numeric('price_tolerance_pct', { precision: 7, scale: 4 })
    .notNull()
    .default('0'),
  version: integer('version').notNull().default(1),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const purchaseOrderNumberSequences = pgTable('purchase_order_number_sequences', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['order', 'receipt'] }).notNull(),
  prefix: text('prefix').notNull().default(''),
  minDigits: integer('min_digits').notNull().default(5),
  nextNumber: numeric('next_number', { precision: 20, scale: 0 }).notNull().default('1'),
});

export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  status: text('status', { enum: orderStatuses }).notNull().default('DRAFT'),
  number: text('number'),
  vendorId: uuid('vendor_id').notNull(),
  orderDate: date('order_date', { mode: 'string' }).notNull(),
  expectedDate: date('expected_date', { mode: 'string' }),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
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
  approvalRequestId: uuid('approval_request_id'),
  submittedByUserId: uuid('submitted_by_user_id'),
  submittedAt: timestamptz('submitted_at'),
  approvedAt: timestamptz('approved_at'),
  closedByUserId: uuid('closed_by_user_id'),
  closedAt: timestamptz('closed_at'),
  closeReason: text('close_reason'),
  cancelledByUserId: uuid('cancelled_by_user_id'),
  cancelledAt: timestamptz('cancelled_at'),
  cancelReason: text('cancel_reason'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  orderId: uuid('order_id').notNull(),
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
  receivedQuantity: numeric('received_quantity', { precision: 28, scale: 6 })
    .notNull()
    .default('0'),
  billedQuantity: numeric('billed_quantity', { precision: 28, scale: 6 }).notNull().default('0'),
});

export const purchaseReceipts = pgTable('purchase_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  orderId: uuid('order_id').notNull(),
  receiptDate: date('receipt_date', { mode: 'string' }).notNull(),
  reference: text('reference'),
  memo: text('memo').notNull().default(''),
  status: text('status', { enum: ['POSTED', 'VOID'] })
    .notNull()
    .default('POSTED'),
  voidedByUserId: uuid('voided_by_user_id'),
  voidedAt: timestamptz('voided_at'),
  voidReason: text('void_reason'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const purchaseReceiptLines = pgTable('purchase_receipt_lines', {
  organizationId: uuid('organization_id').notNull(),
  receiptId: uuid('receipt_id').notNull(),
  lineNo: integer('line_no').notNull(),
  orderLineId: uuid('order_line_id').notNull(),
  quantity: numeric('quantity', { precision: 28, scale: 6 }).notNull(),
});

export const purchaseOrderBills = pgTable('purchase_order_bills', {
  organizationId: uuid('organization_id').notNull(),
  billId: uuid('bill_id').notNull(),
  orderId: uuid('order_id').notNull(),
  linkedByUserId: uuid('linked_by_user_id').notNull(),
  linkedAt: timestamptz('linked_at').notNull(),
});

export const purchaseOrderBillings = pgTable('purchase_order_billings', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  billId: uuid('bill_id').notNull(),
  orderLineId: uuid('order_line_id').notNull(),
  quantity: numeric('quantity', { precision: 28, scale: 6 }).notNull(),
  reversedAt: timestamptz('reversed_at'),
});

export interface MatchIssue {
  kind: 'quantity' | 'price' | 'not_on_order';
  lineNo: number | null;
  message: string;
}

export const purchaseBillMatches = pgTable('purchase_bill_matches', {
  organizationId: uuid('organization_id').notNull(),
  billId: uuid('bill_id').notNull(),
  orderId: uuid('order_id').notNull(),
  mode: text('mode', { enum: matchModes }).notNull(),
  status: text('status', { enum: ['matched', 'warning'] }).notNull(),
  issues: jsonb('issues').$type<MatchIssue[]>().notNull().default([]),
  createdAt: timestamptz('created_at').notNull(),
});
