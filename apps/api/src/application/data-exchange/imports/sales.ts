import { decimal, isSupportedCurrency, minorUnits } from '../../../domain/money.js';
import type { Transaction } from '../../../database/client.js';
import { findAccountByCode } from '../../../modules/accounting/index.js';
import {
  CustomerPermissions,
  customerPartyIds,
  listCustomersByParty,
} from '../../../modules/customers/index.js';
import { normalize } from '../../../modules/data-exchange/index.js';
import { listParties } from '../../../modules/parties/index.js';
import { salesItemTypes, SalesPermissions } from '../../../modules/sales/index.js';
import { listTaxCodes } from '../../../modules/tax/index.js';
import { requireAccountingSettings } from '../../accounting-service.js';
import type { CreateCustomerInput } from '../../customer-service.js';
import type { InvoiceDraftInput } from '../../invoice-service.js';
import type { ItemInput } from '../../item-service.js';
import type { CreatePartyInput } from '../../party-service.js';
import { appErrorMessages, Collector, field, outcome } from '../helpers.js';
import type { ImportDomain, ImportField, RowOutcome } from '../types.js';
import { partiesImport } from './parties.js';

/**
 * Sales imports (Phase 3B step 18; brief §AC; Decisions 24, 65). Customers, items, and AR opening
 * invoices as drafts — imports never issue. Every row is validated with the same rules as the
 * screens and committed through the owning service in the batch transaction (S6-08, L-7).
 */

// ---------------------------------------------------------------------------
// Customers: the parties import columns plus currency, terms and credit limit
// ---------------------------------------------------------------------------

export const customersImport: ImportDomain = {
  key: 'customers',
  label: 'Customers',
  permission: CustomerPermissions.Create,
  groupsRows: false,

  async fields(env) {
    const partyFields = (await partiesImport.fields(env)).filter((f) => f.key !== 'roles');
    const customerFields: ImportField[] = [
      field('currency', 'Currency', {
        description: 'The customer currency (ISO 4217); defaults to the base currency.',
        example: 'USD',
        synonyms: ['currency code', 'customer currency'],
      }),
      field('payment_terms_days', 'Payment terms (days)', {
        description: 'Days to pay, 0–365; blank uses the Sales default.',
        example: '30',
        synonyms: ['terms', 'payment terms', 'net days'],
      }),
      field('credit_limit', 'Credit limit', {
        description: 'In the customer currency; a warning only.',
        example: '50000',
        synonyms: ['limit', 'credit'],
      }),
    ];
    return [...partyFields, ...customerFields];
  },

  async validate(env, rows) {
    const { baseCurrency } = await requireAccountingSettings(env.tx, env.ctx.organizationId);
    const parties = await partiesImport.validate(env, rows);
    const results: RowOutcome[] = [];
    for (const [i, row] of rows.entries()) {
      const party = parties[i]!;
      const c = new Collector();
      c.messages.push(...party.messages);
      const v = (key: string) => normalize.text(row.values[key] ?? null);
      const currency = v('currency')?.toUpperCase() ?? null;
      if (currency && !isSupportedCurrency(currency)) {
        c.error('INVALID_VALUE', 'currency', 'Unsupported currency.');
      }
      const termsRaw = v('payment_terms_days');
      let terms: number | null = null;
      if (termsRaw !== null) {
        terms = /^\d{1,3}$/.test(termsRaw) ? Number(termsRaw) : NaN;
        if (Number.isNaN(terms) || terms > 365) {
          c.error('INVALID_VALUE', 'payment_terms_days', 'Enter whole days between 0 and 365.');
        }
      }
      const limit = c.take(
        normalize.decimal(v('credit_limit'), env.options.decimalSeparator, 'credit_limit'),
        null,
      );
      if (limit !== null) {
        const places = minorUnits(currency ?? baseCurrency);
        if (decimal(limit).isNegative()) {
          c.error('INVALID_VALUE', 'credit_limit', 'The credit limit cannot be negative.');
        } else if (decimal(limit).decimalPlaces() > places) {
          c.error('INVALID_VALUE', 'credit_limit', `Use at most ${places} decimal places.`);
        }
      }
      const normalized = party.normalized
        ? ({
            party: { ...(party.normalized as unknown as CreatePartyInput), roles: ['customer'] },
            ...(currency ? { currencyCode: currency } : {}),
            paymentTermsDays: terms,
            creditLimit: limit,
          } satisfies CreateCustomerInput)
        : null;
      results.push(
        outcome(row.rowNumber, normalized as Record<string, unknown> | null, c.messages),
      );
    }
    return results;
  },

  async commit(env, rows, context) {
    const results = [];
    for (const row of rows) {
      const { customer } = await env.services.customers.createInTransaction(
        env.tx,
        env.ctx,
        row.normalized as unknown as CreateCustomerInput,
        context.origin,
      );
      results.push({ rowNumber: row.rowNumber, recordId: customer.id });
    }
    return results;
  },
};

// ---------------------------------------------------------------------------
// Items (D4, Decision 31)
// ---------------------------------------------------------------------------

const ITEM_PATHS: Record<string, string> = {
  sku: 'sku',
  name: 'name',
  itemType: 'type',
  description: 'description',
  unitPrice: 'unit_price',
  revenueAccountId: 'revenue_account',
  taxCodeId: 'tax_code',
};

export const salesItemsImport: ImportDomain = {
  key: 'sales_items',
  label: 'Items (products and services)',
  permission: SalesPermissions.ItemsManage,
  groupsRows: false,

  async fields() {
    return [
      field('sku', 'SKU', {
        description: 'Your item code; unique (not case-sensitive).',
        example: 'SNK-01',
        synonyms: ['code', 'item code', 'product code'],
      }),
      field('name', 'Name', {
        required: true,
        description: 'Item name.',
        example: 'Snorkel trip',
        synonyms: ['item', 'item name', 'product', 'service'],
      }),
      field('type', 'Type', {
        required: true,
        description: 'service or product.',
        example: 'service',
        synonyms: ['item type', 'kind'],
      }),
      field('description', 'Description', {
        description: 'Up to 1000 characters.',
        example: 'Half-day trip',
        synonyms: ['details'],
      }),
      field('unit_price', 'Unit price', {
        description: 'Default price in the base currency.',
        example: '750.00',
        synonyms: ['price', 'rate', 'sales price'],
      }),
      field('revenue_account', 'Revenue account', {
        description: 'Account code; blank uses the Sales default.',
        example: '4100',
        synonyms: ['account', 'income account', 'sales account'],
      }),
      field('tax_code', 'Tax code', {
        description: 'Tax code, e.g. GST; blank for no default tax.',
        example: 'GST',
        synonyms: ['tax', 'gst code'],
      }),
    ];
  },

  async validate(env, rows) {
    const { tx, ctx } = env;
    const codes = new Map(
      (await listTaxCodes(tx, ctx.organizationId)).map((t) => [t.code.toUpperCase(), t]),
    );
    const skus = new Map<string, number>();
    for (const row of rows) {
      const sku = normalize.text(row.values.sku ?? null)?.toLowerCase();
      if (sku) skus.set(sku, (skus.get(sku) ?? 0) + 1);
    }
    const results: RowOutcome[] = [];
    for (const row of rows) {
      const c = new Collector();
      const v = (key: string) => normalize.text(row.values[key] ?? null);
      const name = c.require(v('name'), 'name', 'Name');
      const typeRaw = c.require(v('type'), 'type', 'Type');
      const itemType = typeRaw
        ? c.take(normalize.oneOf(typeRaw, salesItemTypes, 'type'), null)
        : null;
      const price = c.take(
        normalize.decimal(v('unit_price'), env.options.decimalSeparator, 'unit_price'),
        null,
      );
      const sku = v('sku');
      if (sku && (skus.get(sku.toLowerCase()) ?? 0) > 1) {
        c.error('DUPLICATE_IN_FILE', 'sku', 'This SKU appears more than once in the file.');
      }
      let revenueAccountId: string | null = null;
      const accountCode = v('revenue_account');
      if (accountCode) {
        const account = await findAccountByCode(tx, ctx.organizationId, accountCode);
        if (!account)
          c.error('INVALID_VALUE', 'revenue_account', `No account has the code ${accountCode}.`);
        else revenueAccountId = account.id;
      }
      let taxCodeId: string | null = null;
      const taxCode = v('tax_code');
      if (taxCode) {
        const code = codes.get(taxCode.toUpperCase());
        if (!code) c.error('INVALID_VALUE', 'tax_code', `No tax code ${taxCode}.`);
        else taxCodeId = code.id;
      }
      if (c.failed) {
        results.push(outcome(row.rowNumber, null, c.messages));
        continue;
      }
      const input: ItemInput = {
        sku,
        name: name!,
        itemType: itemType!,
        description: v('description') ?? '',
        unitPrice: price,
        revenueAccountId,
        taxCodeId,
      };
      try {
        await env.services.items.validateInTransaction(tx, ctx, input);
      } catch (error) {
        c.messages.push(
          ...appErrorMessages(error, (path) => ITEM_PATHS[path] ?? (path === '' ? null : 'sku')),
        );
      }
      results.push(outcome(row.rowNumber, input as unknown as Record<string, unknown>, c.messages));
    }
    return results;
  },

  async commit(env, rows, context) {
    const results = [];
    for (const row of rows) {
      const item = await env.services.items.createInTransaction(
        env.tx,
        env.ctx,
        row.normalized as unknown as ItemInput,
        context.origin,
      );
      results.push({ rowNumber: row.rowNumber, recordId: item.id });
    }
    return results;
  },
};

// ---------------------------------------------------------------------------
// AR opening invoices as drafts (D5): one open invoice per row
// ---------------------------------------------------------------------------

/** Customers by party reference and by display name (lower case), for matching rows. */
async function customerLookup(tx: Transaction, organizationId: string) {
  const page = await listParties(tx, {
    organizationId,
    status: 'ALL',
    role: null,
    search: null,
    limit: 100_000,
    after: null,
    partyIdsIn: customerPartyIds(organizationId, 'ACTIVE'),
  });
  const customers = await listCustomersByParty(
    tx,
    organizationId,
    page.items.map((i) => i.party.id),
  );
  const byParty = new Map(customers.map((c) => [c.partyId, c.id]));
  const byReference = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const { party } of page.items) {
    const id = byParty.get(party.id);
    if (!id) continue;
    if (party.reference) byReference.set(party.reference.toLowerCase(), id);
    const key = party.displayName.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), id]);
  }
  return { byReference, byName };
}

const OPENING_PATHS: Record<string, string> = {
  customerId: 'customer',
  invoiceDate: 'invoice_date',
  dueDate: 'due_date',
  currencyCode: 'currency',
  openingBaseTotal: 'carrying_value',
  'lines.0.unitPrice': 'amount',
  'lines.0.description': 'description',
};

export const openingInvoicesImport: ImportDomain = {
  key: 'opening_invoices',
  label: 'AR opening invoices (as drafts)',
  permission: SalesPermissions.InvoicesCreate,
  groupsRows: false,

  async fields() {
    return [
      field('customer', 'Customer', {
        required: true,
        description: 'Customer reference, or its exact name.',
        example: 'C-001',
        synonyms: ['customer name', 'customer code', 'client'],
      }),
      field('invoice_date', 'Invoice date', {
        required: true,
        description: 'On or before the opening date (conversion date − 1).',
        example: '2025-12-15',
        synonyms: ['date', 'document date'],
      }),
      field('due_date', 'Due date', {
        description: 'Blank uses the customer terms.',
        example: '2026-01-14',
        synonyms: ['due'],
      }),
      field('currency', 'Currency', {
        description: 'Blank uses the customer currency.',
        example: 'USD',
        synonyms: ['currency code'],
      }),
      field('amount', 'Open amount', {
        required: true,
        description: 'The amount still owed, in the invoice currency.',
        example: '1250.00',
        synonyms: ['balance', 'open balance', 'amount due', 'outstanding'],
      }),
      field('carrying_value', 'Carrying value (base)', {
        description: 'Foreign currency only: the base value carried at conversion.',
        example: '19275.00',
        synonyms: ['base amount', 'base value'],
      }),
      field('reference', 'Original invoice number', {
        description: 'Shown as the reference.',
        example: 'OLD-1042',
        synonyms: ['invoice number', 'number', 'ref'],
      }),
      field('description', 'Description', {
        description: 'Defaults to "Opening balance".',
        example: 'Opening balance',
        synonyms: ['memo', 'details'],
      }),
    ];
  },

  async validate(env, rows) {
    const { tx, ctx } = env;
    const lookup = await customerLookup(tx, ctx.organizationId);
    const results: RowOutcome[] = [];
    for (const row of rows) {
      const c = new Collector();
      const v = (key: string) => normalize.text(row.values[key] ?? null);
      const customerRaw = c.require(v('customer'), 'customer', 'Customer');
      let customerId: string | null = null;
      if (customerRaw) {
        const key = customerRaw.toLowerCase();
        const byName = lookup.byName.get(key) ?? [];
        customerId = lookup.byReference.get(key) ?? (byName.length === 1 ? byName[0]! : null);
        if (!customerId) {
          c.error(
            'INVALID_VALUE',
            'customer',
            byName.length > 1
              ? 'Several customers have this name; use the reference.'
              : 'No active customer matches.',
          );
        }
      }
      const invoiceDate = c.take(
        normalize.date(
          c.require(v('invoice_date'), 'invoice_date', 'Invoice date'),
          env.options.dateFormat,
          'invoice_date',
        ),
        null,
      );
      const dueDate = c.take(
        normalize.date(v('due_date'), env.options.dateFormat, 'due_date'),
        null,
      );
      const amount = c.take(
        normalize.decimal(
          c.require(v('amount'), 'amount', 'Open amount'),
          env.options.decimalSeparator,
          'amount',
        ),
        null,
      );
      if (amount !== null && decimal(amount).lte(0))
        c.error('INVALID_VALUE', 'amount', 'The open amount must be greater than zero.');
      const carrying = c.take(
        normalize.decimal(v('carrying_value'), env.options.decimalSeparator, 'carrying_value'),
        null,
      );
      if (c.failed) {
        results.push(outcome(row.rowNumber, null, c.messages));
        continue;
      }
      const reference = v('reference');
      const input: InvoiceDraftInput = {
        kind: 'opening',
        customerId: customerId!,
        invoiceDate: invoiceDate!,
        ...(dueDate ? { dueDate } : {}),
        ...(v('currency') ? { currencyCode: v('currency')!.toUpperCase() } : {}),
        reference,
        openingBaseTotal: carrying,
        lines: [
          {
            description: v('description') ?? `Opening balance${reference ? ` — ${reference}` : ''}`,
            quantity: '1',
            unitPrice: amount!,
          },
        ],
      };
      try {
        const resolved = await env.services.invoices.validateDraftInTransaction(tx, ctx, input);
        if (decimal(resolved.header.total).toFixed() !== decimal(amount!).toFixed()) {
          c.error(
            'INVALID_VALUE',
            'amount',
            `Use at most ${minorUnits(resolved.header.currencyCode)} decimal places.`,
          );
        }
      } catch (error) {
        c.messages.push(...appErrorMessages(error, (path) => OPENING_PATHS[path] ?? null));
      }
      results.push(outcome(row.rowNumber, input as unknown as Record<string, unknown>, c.messages));
    }
    return results;
  },

  async commit(env, rows, context) {
    const results = [];
    for (const row of rows) {
      const invoice = await env.services.invoices.createDraftInTransaction(
        env.tx,
        env.ctx,
        row.normalized as unknown as InvoiceDraftInput,
        context.origin,
      );
      results.push({ rowNumber: row.rowNumber, recordId: invoice.id });
    }
    return results;
  },
};
