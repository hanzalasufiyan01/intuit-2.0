import { decimal, isSupportedCurrency, minorUnits } from '../../../domain/money.js';
import type { Transaction } from '../../../database/client.js';
import { normalize } from '../../../modules/data-exchange/index.js';
import { listParties } from '../../../modules/parties/index.js';
import { BillPermissions, VendorCreditPermissions } from '../../../modules/purchases/index.js';
import {
  listVendorsByParty,
  VendorPermissions,
  vendorPartyIds,
} from '../../../modules/vendors/index.js';
import { requireAccountingSettings } from '../../accounting-service.js';
import type { BillDraftInput } from '../../bill-service.js';
import type { CreatePartyInput } from '../../party-service.js';
import type { VendorCreditDraftInput } from '../../vendor-credit-service.js';
import type { CreateVendorInput } from '../../vendor-service.js';
import { appErrorMessages, Collector, field, outcome } from '../helpers.js';
import type { ImportDomain, ImportEnv, ImportField, RowOutcome } from '../types.js';
import { partiesImport } from './parties.js';

/**
 * Purchases imports (Phase 4B; ADR 0004 P4-47, Decisions 24, 65): vendors, and AP opening bills
 * and opening vendor credits as drafts (imports never post). Every row is validated with the same
 * rules as the screens and committed through the owning service in the batch transaction
 * (S6-08, L-7). Mirrors the Sales imports.
 */

// ---------------------------------------------------------------------------
// Vendors: the parties import columns plus currency, terms, credit limit and account number
// ---------------------------------------------------------------------------

export const vendorsImport: ImportDomain = {
  key: 'vendors',
  label: 'Vendors',
  permission: VendorPermissions.Create,
  groupsRows: false,

  async fields(env) {
    const partyFields = (await partiesImport.fields(env)).filter((f) => f.key !== 'roles');
    const vendorFields: ImportField[] = [
      field('currency', 'Currency', {
        description: 'The vendor currency (ISO 4217); defaults to the base currency.',
        example: 'USD',
        synonyms: ['currency code', 'vendor currency'],
      }),
      field('payment_terms_days', 'Payment terms (days)', {
        description: 'Days to pay, 0–365; blank uses the Purchases default.',
        example: '30',
        synonyms: ['terms', 'payment terms', 'net days'],
      }),
      field('credit_limit', 'Credit limit', {
        description: 'In the vendor currency; informational.',
        example: '50000',
        synonyms: ['limit', 'credit'],
      }),
      field('account_number', 'Our account number', {
        description: 'Our account number with the vendor, if any.',
        example: 'ACC-9921',
        synonyms: ['account', 'account no', 'customer number'],
      }),
    ];
    return [...partyFields, ...vendorFields];
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
      const accountNumber = v('account_number');
      if (accountNumber && accountNumber.length > 100) {
        c.error('INVALID_VALUE', 'account_number', 'Use at most 100 characters.');
      }
      const normalized = party.normalized
        ? ({
            party: { ...(party.normalized as unknown as CreatePartyInput), roles: ['vendor'] },
            ...(currency ? { currencyCode: currency } : {}),
            paymentTermsDays: terms,
            creditLimit: limit,
            accountNumber,
          } satisfies CreateVendorInput)
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
      const { vendor } = await env.services.vendors.createInTransaction(
        env.tx,
        env.ctx,
        row.normalized as unknown as CreateVendorInput,
        context.origin,
      );
      results.push({ rowNumber: row.rowNumber, recordId: vendor.id });
    }
    return results;
  },
};

// ---------------------------------------------------------------------------
// AP opening documents as drafts (P4-35): one open document per row
// ---------------------------------------------------------------------------

/** Vendors by party reference and by display name (lower case), for matching rows. */
async function vendorLookup(tx: Transaction, organizationId: string) {
  const page = await listParties(tx, {
    organizationId,
    status: 'ALL',
    role: null,
    search: null,
    limit: 100_000,
    after: null,
    partyIdsIn: vendorPartyIds(organizationId, 'ACTIVE'),
  });
  const vendors = await listVendorsByParty(
    tx,
    organizationId,
    page.items.map((i) => i.party.id),
  );
  const byParty = new Map(vendors.map((v) => [v.partyId, v.id]));
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

const openingFields = (noun: 'bill' | 'credit'): ImportField[] => [
  field('vendor', 'Vendor', {
    required: true,
    description: 'Vendor reference, or its exact name.',
    example: 'V-001',
    synonyms: ['vendor name', 'vendor code', 'supplier'],
  }),
  field('date', noun === 'bill' ? 'Bill date' : 'Credit date', {
    required: true,
    description: 'On or before the opening date (conversion date − 1).',
    example: '2025-12-15',
    synonyms: ['bill date', 'credit date', 'document date', 'invoice date'],
  }),
  ...(noun === 'bill'
    ? [
        field('due_date', 'Due date', {
          description: 'Blank uses the vendor terms.',
          example: '2026-01-14',
          synonyms: ['due'],
        }),
      ]
    : []),
  field('currency', 'Currency', {
    description: 'Blank uses the vendor currency.',
    example: 'USD',
    synonyms: ['currency code'],
  }),
  field('amount', noun === 'bill' ? 'Open amount' : 'Credit amount', {
    required: true,
    description:
      noun === 'bill'
        ? 'The amount still owed, in the bill currency.'
        : 'The credit still held, in the credit currency.',
    example: '1250.00',
    synonyms: ['balance', 'open balance', 'amount due', 'outstanding'],
  }),
  field('carrying_value', 'Carrying value (base)', {
    description: 'Foreign currency only: the base value carried at conversion.',
    example: '19275.00',
    synonyms: ['base amount', 'base value'],
  }),
  field('reference', noun === 'bill' ? 'Supplier invoice number' : 'Supplier credit-note number', {
    description: 'Shown as the supplier reference.',
    example: 'OLD-1042',
    synonyms: ['invoice number', 'number', 'ref', 'supplier reference'],
  }),
  field('description', 'Description', {
    description: 'Defaults to "Opening balance".',
    example: 'Opening balance',
    synonyms: ['memo', 'details'],
  }),
];

const OPENING_PATHS: Record<string, string> = {
  kind: 'date',
  vendorId: 'vendor',
  billDate: 'date',
  creditDate: 'date',
  dueDate: 'due_date',
  currencyCode: 'currency',
  openingBaseTotal: 'carrying_value',
  'lines.0.unitPrice': 'amount',
  'lines.0.description': 'description',
};

interface OpeningRow {
  vendorId: string;
  date: string;
  dueDate: string | null;
  currency: string | null;
  amount: string;
  carrying: string | null;
  reference: string | null;
  description: string | null;
}

/** Reads and checks one row's shared columns; returns null when it already has errors. */
function readOpeningRow(
  c: Collector,
  row: { values: Record<string, string | null> },
  lookup: Awaited<ReturnType<typeof vendorLookup>>,
  options: ImportEnv['options'],
  withDueDate: boolean,
): OpeningRow | null {
  const v = (key: string) => normalize.text(row.values[key] ?? null);
  const vendorRaw = c.require(v('vendor'), 'vendor', 'Vendor');
  let vendorId: string | null = null;
  if (vendorRaw) {
    const key = vendorRaw.toLowerCase();
    const byName = lookup.byName.get(key) ?? [];
    vendorId = lookup.byReference.get(key) ?? (byName.length === 1 ? byName[0]! : null);
    if (!vendorId) {
      c.error(
        'INVALID_VALUE',
        'vendor',
        byName.length > 1
          ? 'Several vendors have this name; use the reference.'
          : 'No active vendor matches.',
      );
    }
  }
  const date = c.take(
    normalize.date(c.require(v('date'), 'date', 'Date'), options.dateFormat, 'date'),
    null,
  );
  const dueDate = withDueDate
    ? c.take(normalize.date(v('due_date'), options.dateFormat, 'due_date'), null)
    : null;
  const amount = c.take(
    normalize.decimal(
      c.require(v('amount'), 'amount', 'Amount'),
      options.decimalSeparator,
      'amount',
    ),
    null,
  );
  if (amount !== null && decimal(amount).lte(0)) {
    c.error('INVALID_VALUE', 'amount', 'The amount must be greater than zero.');
  }
  const carrying = c.take(
    normalize.decimal(v('carrying_value'), options.decimalSeparator, 'carrying_value'),
    null,
  );
  if (c.failed) return null;
  return {
    vendorId: vendorId!,
    date: date!,
    dueDate,
    currency: v('currency')?.toUpperCase() ?? null,
    amount: amount!,
    carrying,
    reference: v('reference'),
    description: v('description'),
  };
}

export const openingBillsImport: ImportDomain = {
  key: 'opening_bills',
  label: 'AP opening bills (as drafts)',
  permission: BillPermissions.Create,
  groupsRows: false,

  async fields() {
    return openingFields('bill');
  },

  async validate(env, rows) {
    const { tx, ctx } = env;
    const lookup = await vendorLookup(tx, ctx.organizationId);
    const results: RowOutcome[] = [];
    for (const row of rows) {
      const c = new Collector();
      const read = readOpeningRow(c, row, lookup, env.options, true);
      if (!read) {
        results.push(outcome(row.rowNumber, null, c.messages));
        continue;
      }
      const input: BillDraftInput = {
        kind: 'opening',
        vendorId: read.vendorId,
        billDate: read.date,
        ...(read.dueDate ? { dueDate: read.dueDate } : {}),
        ...(read.currency ? { currencyCode: read.currency } : {}),
        vendorReference: read.reference,
        openingBaseTotal: read.carrying,
        lines: [
          {
            description:
              read.description ?? `Opening balance${read.reference ? ` — ${read.reference}` : ''}`,
            quantity: '1',
            unitPrice: read.amount,
          },
        ],
      };
      try {
        const resolved = await env.services.bills.validateDraftInTransaction(tx, ctx, input);
        if (decimal(resolved.header.total).toFixed() !== decimal(read.amount).toFixed()) {
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
      const bill = await env.services.bills.createDraftInTransaction(
        env.tx,
        env.ctx,
        row.normalized as unknown as BillDraftInput,
        context.origin,
      );
      results.push({ rowNumber: row.rowNumber, recordId: bill.id });
    }
    return results;
  },
};

export const openingVendorCreditsImport: ImportDomain = {
  key: 'opening_vendor_credits',
  label: 'AP opening vendor credits (as drafts)',
  permission: VendorCreditPermissions.Create,
  groupsRows: false,

  async fields() {
    return openingFields('credit');
  },

  async validate(env, rows) {
    const { tx, ctx } = env;
    const lookup = await vendorLookup(tx, ctx.organizationId);
    const results: RowOutcome[] = [];
    for (const row of rows) {
      const c = new Collector();
      const read = readOpeningRow(c, row, lookup, env.options, false);
      if (!read) {
        results.push(outcome(row.rowNumber, null, c.messages));
        continue;
      }
      const input: VendorCreditDraftInput & { origin: 'supplier_credit_note' } = {
        kind: 'opening',
        origin: 'supplier_credit_note',
        vendorId: read.vendorId,
        creditDate: read.date,
        ...(read.currency ? { currencyCode: read.currency } : {}),
        vendorReference: read.reference,
        openingBaseTotal: read.carrying,
        lines: [
          {
            description:
              read.description ?? `Opening balance${read.reference ? ` — ${read.reference}` : ''}`,
            quantity: '1',
            unitPrice: read.amount,
          },
        ],
      };
      try {
        const resolved = await env.services.vendorCredits.validateDraftInTransaction(
          tx,
          ctx,
          input,
        );
        if (decimal(resolved.header.total).toFixed() !== decimal(read.amount).toFixed()) {
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
      const credit = await env.services.vendorCredits.createDraftInTransaction(
        env.tx,
        env.ctx,
        row.normalized as unknown as VendorCreditDraftInput & { origin: 'supplier_credit_note' },
        context.origin,
      );
      results.push({ rowNumber: row.rowNumber, recordId: credit.id });
    }
    return results;
  },
};
