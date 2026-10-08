import { z } from 'zod';
import { decimal, minorUnits } from '../../domain/money.js';

/**
 * Public API v1 data transfer objects (ADR 0011 section 8). These shapes are hand-written
 * allow-lists, separate from every internal table, domain object and application view: a new
 * internal column is invisible until a DTO maps it. They never carry password or secret material,
 * authentication or session fields, audit internals, journal ids or lines, base-currency or
 * exchange-rate mechanics, tax-snapshot internals, dimension or account ids, RLS fields, or any
 * detail of the service principal behind an integration.
 *
 * Money is a decimal string rounded to the document currency; dates are ISO 8601; ids are UUIDs.
 * The Zod schemas are the single source for both the mappers (unknown keys are stripped) and the
 * OpenAPI document. Fields are only ever added inside v1; clients must tolerate unknown fields and
 * unknown enum values.
 */

const id = z.uuid();
const iso = z.iso.datetime();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.string();
const status = z.enum(['ACTIVE', 'ARCHIVED']);

export const CustomerDto = z
  .object({
    id,
    name: z.string(),
    company_name: z.string().nullable(),
    kind: z.enum(['organization', 'individual']),
    reference: z.string().nullable(),
    tin: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    website: z.string().nullable(),
    currency_code: z.string().length(3),
    payment_terms_days: z.number().int().nullable(),
    credit_limit: money.nullable(),
    status,
    version: z.number().int(),
    created_at: iso,
    updated_at: iso,
  })
  .strict()
  .meta({ id: 'Customer' });

export const VendorDto = CustomerDto.extend({ account_number: z.string().nullable() })
  .strict()
  .meta({ id: 'Vendor' });

export const ItemDto = z
  .object({
    id,
    sku: z.string().nullable(),
    name: z.string(),
    item_type: z.enum(['service', 'product']),
    description: z.string(),
    unit_price: money.nullable(),
    is_sold: z.boolean(),
    is_purchased: z.boolean(),
    purchase_description: z.string().nullable(),
    purchase_unit_cost: money.nullable(),
    status,
    version: z.number().int(),
    created_at: iso,
    updated_at: iso,
  })
  .strict()
  .meta({ id: 'Item' });

const DocumentLine = {
  line_no: z.number().int(),
  item_id: id.nullable(),
  description: z.string(),
  quantity: z.string(),
  unit_price: z.string(),
  discount: z
    .object({ type: z.enum(['percent', 'amount']), value: z.string() })
    .strict()
    .nullable(),
  net_amount: money,
  tax_rate: z.string().nullable(),
  tax_amount: money,
  total: money,
};
export const InvoiceLineDto = z.object(DocumentLine).strict().meta({ id: 'InvoiceLine' });
export const BillLineDto = z.object(DocumentLine).strict().meta({ id: 'BillLine' });

const documentSummary = {
  id,
  number: z.string().nullable(),
  status: z.string(),
  currency_code: z.string().length(3),
  tax_treatment: z.enum(['exclusive', 'inclusive', 'no_tax']),
  subtotal: money,
  discount_total: money,
  tax_total: money,
  total: money,
  amount_due: money.nullable(),
  memo: z.string(),
  version: z.number().int(),
  created_at: iso,
  updated_at: iso,
};

export const InvoiceSummaryDto = z
  .object({
    ...documentSummary,
    status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'VOID']),
    customer_id: id,
    invoice_date: date,
    due_date: date,
    reference: z.string().nullable(),
    issued_at: iso.nullable(),
    voided_at: iso.nullable(),
  })
  .strict()
  .meta({ id: 'InvoiceSummary' });
export const InvoiceDto = InvoiceSummaryDto.extend({ lines: z.array(InvoiceLineDto) })
  .strict()
  .meta({ id: 'Invoice' });

export const BillSummaryDto = z
  .object({
    ...documentSummary,
    status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'VOID']),
    vendor_id: id,
    vendor_reference: z.string().nullable(),
    bill_date: date,
    due_date: date,
    posted_at: iso.nullable(),
    voided_at: iso.nullable(),
  })
  .strict()
  .meta({ id: 'BillSummary' });
export const BillDto = BillSummaryDto.extend({ lines: z.array(BillLineDto) })
  .strict()
  .meta({ id: 'Bill' });

export const AccountDto = z
  .object({
    id,
    code: z.string(),
    name: z.string(),
    description: z.string(),
    type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
    subtype: z.string().nullable(),
    parent_id: id.nullable(),
    currency_code: z.string().length(3).nullable(),
    status,
    created_at: iso,
    updated_at: iso,
  })
  .strict()
  .meta({ id: 'Account' });

export const PageDto = z
  .object({ next_cursor: z.string().nullable(), has_more: z.boolean() })
  .strict()
  .meta({ id: 'Page' });

export const ErrorDto = z
  .object({
    error: z
      .object({
        type: z.enum([
          'authentication_error',
          'permission_error',
          'invalid_request',
          'not_found',
          'conflict',
          'rate_limited',
          'api_error',
        ]),
        code: z.string(),
        message: z.string(),
        request_id: z.string(),
        details: z.array(z.object({ field: z.string(), issue: z.string() }).strict()).optional(),
      })
      .strict(),
  })
  .strict()
  .meta({ id: 'Error' });

// ---------------------------------------------------------------------------
// Mappers: explicit allow-lists from the rows the read queries select
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
const iso8601 = (v: unknown) =>
  v === null || v === undefined ? null : new Date(v as Date).toISOString();
const amount = (v: unknown, currency: string) =>
  v === null || v === undefined ? null : decimal(String(v)).toFixed(minorUnits(currency));
const plain = (v: unknown) => decimal(String(v)).toFixed();
const day = (v: unknown) => String(v).slice(0, 10);

export function toCustomer(r: Row) {
  const currency = String(r.currency_code);
  return CustomerDto.parse({
    id: r.id,
    name: r.display_name,
    company_name: text(r.company_name),
    kind: r.kind,
    reference: text(r.reference),
    tin: text(r.tin),
    email: text(r.email),
    phone: text(r.phone),
    website: text(r.website),
    currency_code: currency,
    payment_terms_days: r.payment_terms_days ?? null,
    credit_limit: amount(r.credit_limit, currency),
    status: r.status,
    version: r.version,
    created_at: iso8601(r.created_at),
    updated_at: iso8601(r.updated_at),
  });
}

export function toVendor(r: Row) {
  return VendorDto.parse({ ...toCustomer(r), account_number: text(r.account_number) });
}

export function toItem(r: Row) {
  return ItemDto.parse({
    id: r.id,
    sku: text(r.sku),
    name: r.name,
    item_type: r.item_type,
    description: r.description,
    unit_price: r.unit_price === null ? null : plain(r.unit_price),
    is_sold: r.is_sold,
    is_purchased: r.is_purchased,
    purchase_description: text(r.purchase_description),
    purchase_unit_cost: r.purchase_unit_cost === null ? null : plain(r.purchase_unit_cost),
    status: r.status,
    version: r.version,
    created_at: iso8601(r.created_at),
    updated_at: iso8601(r.updated_at),
  });
}

function toLine(r: Row, currency: string) {
  return {
    line_no: r.line_no,
    item_id: r.item_id ?? null,
    description: r.description,
    quantity: plain(r.quantity),
    unit_price: plain(r.unit_price),
    discount:
      r.discount_type === null || r.discount_type === undefined
        ? null
        : { type: r.discount_type, value: plain(r.discount_value ?? 0) },
    net_amount: amount(r.net_amount, currency),
    tax_rate: r.tax_rate === null || r.tax_rate === undefined ? null : plain(r.tax_rate),
    tax_amount: amount(r.tax_amount, currency),
    total: amount(r.total, currency),
  };
}

function toDocument(r: Row) {
  const currency = String(r.currency_code);
  return {
    id: r.id,
    number: text(r.number),
    status: r.status,
    currency_code: currency,
    tax_treatment: r.tax_treatment,
    subtotal: amount(r.subtotal, currency),
    discount_total: amount(r.discount_total, currency),
    tax_total: amount(r.tax_total, currency),
    total: amount(r.total, currency),
    amount_due: amount(r.amount_due, currency),
    memo: r.memo,
    version: r.version,
    created_at: iso8601(r.created_at),
    updated_at: iso8601(r.updated_at),
  };
}

export function toInvoiceSummary(r: Row) {
  return InvoiceSummaryDto.parse({
    ...toDocument(r),
    customer_id: r.customer_id,
    invoice_date: day(r.invoice_date),
    due_date: day(r.due_date),
    reference: text(r.reference),
    issued_at: iso8601(r.issued_at),
    voided_at: iso8601(r.voided_at),
  });
}

export function toInvoice(r: Row, lines: readonly Row[]) {
  const currency = String(r.currency_code);
  return InvoiceDto.parse({
    ...toInvoiceSummary(r),
    lines: lines.map((l) => toLine(l, currency)),
  });
}

export function toBillSummary(r: Row) {
  return BillSummaryDto.parse({
    ...toDocument(r),
    vendor_id: r.vendor_id,
    vendor_reference: text(r.vendor_reference),
    bill_date: day(r.bill_date),
    due_date: day(r.due_date),
    posted_at: iso8601(r.posted_at),
    voided_at: iso8601(r.voided_at),
  });
}

export function toBill(r: Row, lines: readonly Row[]) {
  const currency = String(r.currency_code);
  return BillDto.parse({ ...toBillSummary(r), lines: lines.map((l) => toLine(l, currency)) });
}

export function toAccount(r: Row) {
  return AccountDto.parse({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    type: r.account_type,
    subtype: text(r.subtype),
    parent_id: r.parent_id ?? null,
    currency_code: text(r.currency_code),
    status: r.status,
    created_at: iso8601(r.created_at),
    updated_at: iso8601(r.updated_at),
  });
}
