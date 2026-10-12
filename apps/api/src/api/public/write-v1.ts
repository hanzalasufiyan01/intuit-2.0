import { z } from 'zod';
import type {
  CreateCustomerInput,
  UpdateCustomerInTransactionInput,
} from '../../application/customer-service.js';
import type { InvoiceDraftInput } from '../../application/invoice-service.js';
import type { ItemInput } from '../../application/item-service.js';
import { salesItemTypes } from '../../modules/catalog/index.js';
import { discountTypes } from '../../modules/documents/index.js';
import { taxTreatments } from '../../modules/tax/index.js';

/**
 * Public API v1 request bodies for the D1 draft write set (ADR 0011 sections 3.1 and 22):
 * customers, items and DRAFT invoices. Like the response DTOs these are hand-written allow-lists,
 * separate from every internal input type. Every body is strict: an unknown field (an account, a
 * tax code, a dimension, a status, an invoice kind, ...) is a 400, never ignored. Money and
 * quantities are decimal strings. The mappers below only rename fields; every rule (currency,
 * tax, totals, item and customer checks, numbering, conversion date) stays in the domain services.
 */

const uuid = z.uuid();
const text = (max: number) => z.string().trim().max(max);
const decimalString = (places: number, message: string) =>
  z.string().regex(new RegExp(`^(0|[1-9]\\d{0,21})(\\.\\d{1,${places}})?$`), message);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const version = z.number().int().min(1);
const currency = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.');
const discount = z
  .object({
    type: z.enum(discountTypes),
    value: decimalString(4, 'Enter a non-negative discount with up to 4 decimals.'),
  })
  .strict();

/** A partial update must change something besides the version it is checked against. */
const hasChange = (body: Record<string, unknown>) => Object.keys(body).some((k) => k !== 'version');
const CHANGE_REQUIRED = { error: 'Send at least one field to change.' };

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const customerFields = {
  kind: z.enum(['organization', 'individual']),
  name: text(200).nullable(),
  company_name: text(200).nullable(),
  first_name: text(100).nullable(),
  last_name: text(100).nullable(),
  reference: text(50).nullable(),
  tin: text(50).nullable(),
  email: z.email({ error: 'Enter a valid email address.' }).max(254).nullable(),
  phone: text(40).nullable(),
  website: text(200).nullable(),
  currency_code: currency,
  payment_terms_days: z.number().int().min(0).max(365).nullable(),
  credit_limit: decimalString(4, 'Enter a non-negative amount.').nullable(),
};

export const CustomerCreateBody = z
  .object({
    ...customerFields,
    name: customerFields.name.optional(),
    company_name: customerFields.company_name.optional(),
    first_name: customerFields.first_name.optional(),
    last_name: customerFields.last_name.optional(),
    reference: customerFields.reference.optional(),
    tin: customerFields.tin.optional(),
    email: customerFields.email.optional(),
    phone: customerFields.phone.optional(),
    website: customerFields.website.optional(),
    currency_code: customerFields.currency_code.optional(),
    payment_terms_days: customerFields.payment_terms_days.optional(),
    credit_limit: customerFields.credit_limit.optional(),
  })
  .strict()
  .meta({ id: 'CustomerCreate' });

export const CustomerUpdateBody = z
  .object({
    version,
    ...Object.fromEntries(Object.entries(customerFields).map(([k, v]) => [k, v.optional()])),
  } as { version: typeof version } & {
    [K in keyof typeof customerFields]: z.ZodOptional<(typeof customerFields)[K]>;
  })
  .strict()
  .refine(hasChange, CHANGE_REQUIRED)
  .meta({ id: 'CustomerUpdate' });

type Loose<T> = { [K in keyof T]?: T[K] | undefined };

const blank = <T extends string | null | undefined>(v: T) => (v === '' ? null : v);

type CustomerIdentity = Partial<
  Record<
    | 'kind'
    | 'displayName'
    | 'companyName'
    | 'firstName'
    | 'lastName'
    | 'reference'
    | 'tin'
    | 'email'
    | 'phone'
    | 'website',
    unknown
  >
>;

/** The party identity fields the body names (omitted stays omitted; blank text clears). */
function identity(body: Loose<z.infer<typeof CustomerCreateBody>>): CustomerIdentity {
  const named: CustomerIdentity = {
    kind: body.kind,
    displayName: blank(body.name),
    companyName: blank(body.company_name),
    firstName: blank(body.first_name),
    lastName: blank(body.last_name),
    reference: blank(body.reference),
    tin: blank(body.tin),
    email: blank(body.email),
    phone: blank(body.phone),
    website: blank(body.website),
  };
  return Object.fromEntries(Object.entries(named).filter(([, v]) => v !== undefined));
}

export function toCreateCustomerInput(
  body: z.infer<typeof CustomerCreateBody>,
): CreateCustomerInput {
  const given = identity(body) as Record<string, string | null>;
  return {
    party: {
      kind: body.kind,
      displayName: given.displayName ?? null,
      companyName: given.companyName ?? null,
      firstName: given.firstName ?? null,
      lastName: given.lastName ?? null,
      reference: given.reference ?? null,
      tin: given.tin ?? null,
      email: given.email ?? null,
      phone: given.phone ?? null,
      website: given.website ?? null,
      notes: null,
      roles: [],
      contacts: [],
      addresses: [],
    },
    ...(body.currency_code !== undefined && { currencyCode: body.currency_code }),
    ...(body.payment_terms_days !== undefined && { paymentTermsDays: body.payment_terms_days }),
    ...(body.credit_limit !== undefined && { creditLimit: body.credit_limit }),
  };
}

export function toUpdateCustomerInput(
  body: z.infer<typeof CustomerUpdateBody>,
): UpdateCustomerInTransactionInput {
  const party = identity(body);
  return {
    version: body.version,
    ...(body.currency_code !== undefined && { currencyCode: body.currency_code }),
    ...(body.payment_terms_days !== undefined && { paymentTermsDays: body.payment_terms_days }),
    ...(body.credit_limit !== undefined && { creditLimit: body.credit_limit }),
    ...(Object.keys(party).length > 0 && { party }),
  } as UpdateCustomerInTransactionInput;
}

// ---------------------------------------------------------------------------
// Items (no account, tax-code or other accounting reference is accepted in v1)
// ---------------------------------------------------------------------------

const itemFields = {
  sku: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/#-]{0,49}$/, 'Use up to 50 letters, digits or . _ / # -.')
    .nullable(),
  name: z.string().trim().min(1, 'The name is required.').max(200),
  item_type: z.enum(salesItemTypes),
  description: text(1000),
  unit_price: decimalString(4, 'Enter a non-negative price.').nullable(),
  is_sold: z.boolean(),
  is_purchased: z.boolean(),
  purchase_description: text(1000),
  purchase_unit_cost: decimalString(4, 'Enter a non-negative cost.').nullable(),
};

export const ItemCreateBody = z
  .object({
    ...itemFields,
    sku: itemFields.sku.optional(),
    description: itemFields.description.optional(),
    unit_price: itemFields.unit_price.optional(),
    is_sold: itemFields.is_sold.optional(),
    is_purchased: itemFields.is_purchased.optional(),
    purchase_description: itemFields.purchase_description.optional(),
    purchase_unit_cost: itemFields.purchase_unit_cost.optional(),
  })
  .strict()
  .meta({ id: 'ItemCreate' });

export const ItemUpdateBody = z
  .object({
    version,
    ...Object.fromEntries(Object.entries(itemFields).map(([k, v]) => [k, v.optional()])),
  } as { version: typeof version } & {
    [K in keyof typeof itemFields]: z.ZodOptional<(typeof itemFields)[K]>;
  })
  .strict()
  .refine(hasChange, CHANGE_REQUIRED)
  .meta({ id: 'ItemUpdate' });

type ItemBody = Loose<z.infer<typeof ItemCreateBody>>;

/** Only the fields the body names; the domain keeps the current value of everything else. */
function itemFieldsOf(body: ItemBody) {
  const named = {
    sku: body.sku,
    name: body.name,
    itemType: body.item_type,
    description: body.description,
    unitPrice: body.unit_price,
    isSold: body.is_sold,
    isPurchased: body.is_purchased,
    purchaseDescription: body.purchase_description,
    purchaseUnitCost: body.purchase_unit_cost,
  };
  return Object.fromEntries(Object.entries(named).filter(([, v]) => v !== undefined));
}

export function toCreateItemInput(body: z.infer<typeof ItemCreateBody>): ItemInput {
  return {
    sku: null,
    description: '',
    unitPrice: null,
    revenueAccountId: null,
    taxCodeId: null,
    ...itemFieldsOf(body),
  } as ItemInput;
}

export function toUpdateItemInput(body: z.infer<typeof ItemUpdateBody>) {
  return { version: body.version, ...itemFieldsOf(body) };
}

// ---------------------------------------------------------------------------
// Draft invoices (never kind=opening; no account, tax-code or dimension reference)
// ---------------------------------------------------------------------------

const InvoiceLineBody = z
  .object({
    item_id: uuid.nullable().optional(),
    description: text(1000).optional(),
    quantity: decimalString(6, 'Enter a quantity with up to 6 decimals.').refine(
      (v) => Number(v) > 0,
      'The quantity must be greater than zero.',
    ),
    unit_price: decimalString(6, 'Enter a non-negative price with up to 6 decimals.').optional(),
    discount: discount.nullable().optional(),
  })
  .strict()
  .meta({ id: 'InvoiceLineInput' });

const invoiceDraftFields = {
  customer_id: uuid,
  invoice_date: isoDate,
  due_date: isoDate.nullable().optional(),
  payment_terms_days: z.number().int().min(0).max(365).nullable().optional(),
  currency_code: currency.optional(),
  tax_treatment: z.enum(taxTreatments).optional(),
  discount: discount.nullable().optional(),
  reference: text(100).nullable().optional(),
  memo: text(2000).optional(),
  lines: z.array(InvoiceLineBody).min(1, 'Add at least one line.').max(500),
};

export const InvoiceDraftCreateBody = z
  .object(invoiceDraftFields)
  .strict()
  .meta({ id: 'InvoiceDraftCreate' });
export const InvoiceDraftReplaceBody = z
  .object({ version, ...invoiceDraftFields })
  .strict()
  .meta({ id: 'InvoiceDraftReplace' });

export function toInvoiceDraftInput(
  body: z.infer<typeof InvoiceDraftCreateBody>,
): InvoiceDraftInput {
  return {
    customerId: body.customer_id,
    invoiceDate: body.invoice_date,
    ...(body.due_date !== undefined && { dueDate: body.due_date }),
    ...(body.payment_terms_days !== undefined && { paymentTermsDays: body.payment_terms_days }),
    ...(body.currency_code !== undefined && { currencyCode: body.currency_code }),
    ...(body.tax_treatment !== undefined && { taxTreatment: body.tax_treatment }),
    ...(body.discount !== undefined && { discount: body.discount }),
    ...(body.reference !== undefined && { reference: blank(body.reference) }),
    ...(body.memo !== undefined && { memo: body.memo }),
    lines: body.lines.map((line) => ({
      quantity: line.quantity,
      ...(line.item_id !== undefined && { itemId: line.item_id }),
      ...(line.description !== undefined && { description: line.description }),
      ...(line.unit_price !== undefined && { unitPrice: line.unit_price }),
      ...(line.discount !== undefined && { discount: line.discount }),
    })),
  };
}
