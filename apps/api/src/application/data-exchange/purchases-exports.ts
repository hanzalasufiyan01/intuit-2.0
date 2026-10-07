import { z } from 'zod';
import { decimal } from '../../domain/money.js';
import type { Transaction } from '../../database/client.js';
import { listAccounts } from '../../modules/accounting/index.js';
import { listParties } from '../../modules/parties/index.js';
import {
  billStatuses,
  BillPermissions,
  ExpensePermissions,
  expenseStatuses,
  listBills,
  listExpenses,
  listPayments,
  listVendorCredits,
  paymentStatuses,
  PurchasesPermissions,
  VendorCreditPermissions,
  vendorCreditOrigins,
  vendorCreditStatuses,
  VendorPaymentPermissions,
} from '../../modules/purchases/index.js';
import { listTaxCodes } from '../../modules/tax/index.js';
import {
  listVendorsByParty,
  VendorPermissions,
  vendorPartyIds,
} from '../../modules/vendors/index.js';
import { getParty } from '../../modules/parties/index.js';
import { getVendor } from '../../modules/vendors/index.js';
import type { ExportCell, ExportDomain } from './types.js';

/**
 * Purchases exports (Phase 4B-8; P4-48, ADR 0004 PD2 and PD8): vendors, bills, vendor credits,
 * vendor payments, AP aging, purchases by vendor and the full payment register, as CSV. Each export
 * requires the view permission of its screen (re-checked on every access, Decision 65); the report
 * exports reuse the report services inside the export's snapshot, so they equal the screens.
 */

const PAGE = 500;
/** The payment register export is not capped at the screen's 2,000 rows (PD8); the file-size cap applies. */
const REGISTER_EXPORT_ROWS = 1_000_000;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const num = (value: string | null | undefined): ExportCell => ({ number: value ?? null });
const day = (value: string | null | undefined): ExportCell => ({ date: value ?? null });
const today = (now: Date) => now.toISOString().slice(0, 10);
const statusParams = z
  .object({ status: z.enum(['active', 'archived', 'all']).default('active') })
  .strict();

async function vendorNames(
  tx: Transaction,
  organizationId: string,
  ids: readonly string[],
  cache: Map<string, string | null>,
) {
  for (const id of ids) {
    if (cache.has(id)) continue;
    const vendor = await getVendor(tx, organizationId, id);
    const party = vendor ? await getParty(tx, organizationId, vendor.partyId) : undefined;
    cache.set(id, party?.displayName ?? null);
  }
}

const vendorsExport: ExportDomain<z.infer<typeof statusParams>> = {
  key: 'vendors',
  label: 'Vendors',
  params: statusParams,
  permission: async () => VendorPermissions.View,
  snapshot: false,
  fileName: (_p, now) => `vendors-${today(now)}.csv`,
  async generate(env, params) {
    await env.write([
      'kind',
      'display_name',
      'company_name',
      'reference',
      'tin',
      'email',
      'phone',
      'currency',
      'payment_terms_days',
      'credit_limit',
      'account_number',
      'default_expense_account',
      'default_tax_code',
      'status',
    ]);
    const accounts = new Map(
      (await listAccounts(env.tx, env.ctx.organizationId)).map((a) => [a.id, a.code]),
    );
    const codes = new Map(
      (await listTaxCodes(env.tx, env.ctx.organizationId)).map((t) => [t.id, t.code]),
    );
    const status =
      params.status === 'all' ? 'ALL' : params.status === 'archived' ? 'ARCHIVED' : 'ACTIVE';
    let after: { name: string; id: string } | null = null;
    let count = 0;
    for (;;) {
      const page = await listParties(env.tx, {
        organizationId: env.ctx.organizationId,
        status: 'ALL',
        role: null,
        search: null,
        limit: PAGE,
        after,
        partyIdsIn: vendorPartyIds(env.ctx.organizationId, status),
      });
      const rows = await listVendorsByParty(
        env.tx,
        env.ctx.organizationId,
        page.items.map((i) => i.party.id),
      );
      const byParty = new Map(rows.map((v) => [v.partyId, v]));
      for (const { party } of page.items) {
        const v = byParty.get(party.id)!;
        await env.write([
          party.kind,
          party.displayName,
          party.companyName,
          party.reference,
          party.tin,
          party.email,
          party.phone,
          v.currencyCode,
          v.paymentTermsDays === null ? null : String(v.paymentTermsDays),
          num(v.creditLimit),
          v.accountNumber,
          v.defaultExpenseAccountId ? (accounts.get(v.defaultExpenseAccountId) ?? null) : null,
          v.defaultTaxCodeId ? (codes.get(v.defaultTaxCodeId) ?? null) : null,
          v.status.toLowerCase(),
        ]);
        count += 1;
      }
      if (!page.hasMore) break;
      const last = page.items.at(-1)!.party;
      after = { name: last.displayName.toLowerCase(), id: last.id };
    }
    return count;
  },
};

const billsParams = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    status: z.enum(billStatuses).optional(),
  })
  .strict();

const billsExport: ExportDomain<z.infer<typeof billsParams>> = {
  key: 'bills',
  label: 'Bills',
  params: billsParams,
  permission: async () => BillPermissions.View,
  snapshot: false,
  fileName: (_p, now) => `bills-${today(now)}.csv`,
  async generate(env, params) {
    await env.write([
      'number',
      'kind',
      'status',
      'vendor',
      'vendor_reference',
      'bill_date',
      'due_date',
      'currency',
      'subtotal',
      'discount',
      'tax',
      'recoverable_tax',
      'total',
      'amount_due',
      'exchange_rate',
      'base_total',
      'base_due',
      'memo',
    ]);
    const cache = new Map<string, string | null>();
    let after: { date: string; id: string } | null = null;
    let count = 0;
    for (;;) {
      const page = await listBills(env.tx, {
        organizationId: env.ctx.organizationId,
        statuses: params.status ? [params.status] : null,
        vendorId: null,
        search: null,
        from: params.from ?? null,
        to: params.to ?? null,
        limit: PAGE,
        after,
      });
      await vendorNames(
        env.tx,
        env.ctx.organizationId,
        page.items.map((b) => b.vendorId),
        cache,
      );
      for (const b of page.items) {
        await env.write([
          b.number,
          b.kind,
          b.status.toLowerCase(),
          cache.get(b.vendorId) ?? null,
          b.vendorReference,
          day(b.billDate),
          day(b.dueDate),
          b.currencyCode,
          num(b.subtotal),
          num(b.discountTotal),
          num(b.taxTotal),
          num(b.recoverableTaxTotal),
          num(b.total),
          num(b.amountDue),
          num(b.exchangeRate),
          num(b.baseTotal),
          num(b.baseDue),
          b.memo,
        ]);
        count += 1;
      }
      if (!page.hasMore) break;
      const last = page.items.at(-1)!;
      after = { date: last.billDate, id: last.id };
    }
    return count;
  },
};

const creditsParams = z
  .object({
    status: z.enum(vendorCreditStatuses).optional(),
    origin: z.enum(vendorCreditOrigins).optional(),
  })
  .strict();

const creditsExport: ExportDomain<z.infer<typeof creditsParams>> = {
  key: 'vendor_credits',
  label: 'Vendor credits and debit notes',
  params: creditsParams,
  permission: async () => VendorCreditPermissions.View,
  snapshot: false,
  fileName: (_p, now) => `vendor-credits-${today(now)}.csv`,
  async generate(env, params) {
    await env.write([
      'number',
      'origin',
      'status',
      'vendor',
      'vendor_reference',
      'credit_date',
      'currency',
      'subtotal',
      'discount',
      'tax',
      'total',
      'amount_unapplied',
      'exchange_rate',
      'base_total',
      'base_unapplied',
      'memo',
    ]);
    const cache = new Map<string, string | null>();
    let after: { date: string; id: string } | null = null;
    let count = 0;
    for (;;) {
      const page = await listVendorCredits(env.tx, {
        organizationId: env.ctx.organizationId,
        statuses: params.status ? [params.status] : null,
        origin: params.origin ?? null,
        vendorId: null,
        billId: null,
        search: null,
        limit: PAGE,
        after,
      });
      await vendorNames(
        env.tx,
        env.ctx.organizationId,
        page.items.map((c) => c.vendorId),
        cache,
      );
      for (const c of page.items) {
        await env.write([
          c.number,
          c.origin,
          c.status.toLowerCase(),
          cache.get(c.vendorId) ?? null,
          c.vendorReference,
          day(c.creditDate),
          c.currencyCode,
          num(c.subtotal),
          num(c.discountTotal),
          num(c.taxTotal),
          num(c.total),
          num(c.amountUnapplied),
          num(c.exchangeRate),
          num(c.baseTotal),
          num(c.baseUnapplied),
          c.memo,
        ]);
        count += 1;
      }
      if (!page.hasMore) break;
      const last = page.items.at(-1)!;
      after = { date: last.creditDate, id: last.id };
    }
    return count;
  },
};

const paymentsParams = z.object({ status: z.enum(paymentStatuses).optional() }).strict();

const paymentsExport: ExportDomain<z.infer<typeof paymentsParams>> = {
  key: 'vendor_payments',
  label: 'Vendor payments',
  params: paymentsParams,
  permission: async () => VendorPaymentPermissions.View,
  snapshot: false,
  fileName: (_p, now) => `vendor-payments-${today(now)}.csv`,
  async generate(env, params) {
    await env.write([
      'number',
      'status',
      'vendor',
      'payment_date',
      'currency',
      'amount',
      'exchange_rate',
      'rate_source',
      'base_amount',
      'unallocated',
      'payment_account',
      'reference',
    ]);
    const accounts = new Map(
      (await listAccounts(env.tx, env.ctx.organizationId)).map((a) => [a.id, a.code]),
    );
    const cache = new Map<string, string | null>();
    let after: { date: string; id: string } | null = null;
    let count = 0;
    for (;;) {
      const page = await listPayments(env.tx, {
        organizationId: env.ctx.organizationId,
        statuses: params.status ? [params.status] : null,
        vendorId: null,
        withUnallocated: false,
        search: null,
        limit: PAGE,
        after,
      });
      await vendorNames(
        env.tx,
        env.ctx.organizationId,
        page.items.map((p) => p.vendorId),
        cache,
      );
      for (const p of page.items) {
        await env.write([
          p.number,
          p.status.toLowerCase(),
          cache.get(p.vendorId) ?? null,
          day(p.paymentDate),
          p.currencyCode,
          num(p.amount),
          num(p.exchangeRate),
          p.exchangeRateSource,
          num(p.baseAmount),
          num(p.amountUnallocated),
          p.paymentAccountId ? (accounts.get(p.paymentAccountId) ?? null) : null,
          p.reference,
        ]);
        count += 1;
      }
      if (!page.hasMore) break;
      const last = page.items.at(-1)!;
      after = { date: last.paymentDate, id: last.id };
    }
    return count;
  },
};

const agingParams = z.object({ asOf: isoDate, vendorId: z.uuid().optional() }).strict();

const agingExport: ExportDomain<z.infer<typeof agingParams>> = {
  key: 'ap_aging',
  label: 'AP aging',
  params: agingParams,
  permission: async () => PurchasesPermissions.ReportsView,
  snapshot: true,
  fileName: (p) => `ap-aging-${p.asOf}.csv`,
  async generate(env, params) {
    await env.write([
      'vendor',
      'document_type',
      'number',
      'vendor_reference',
      'date',
      'due_date',
      'days_overdue',
      'bucket',
      'currency',
      'open_amount',
      'open_base',
    ]);
    const aging = await env.services.apReports.agingInTransaction(
      env.tx,
      env.ctx.organizationId,
      params,
    );
    let count = 0;
    for (const v of aging.vendors) {
      for (const b of v.bills) {
        await env.write([
          v.vendorName,
          'bill',
          b.number,
          b.vendorReference,
          day(b.billDate),
          day(b.dueDate),
          String(b.daysOverdue),
          b.bucket,
          b.currencyCode,
          num(b.openAmount),
          num(b.openBase),
        ]);
        count += 1;
      }
      for (const c of v.credits) {
        await env.write([
          v.vendorName,
          c.type,
          c.number,
          null,
          day(c.date),
          null,
          null,
          'credit',
          c.currencyCode,
          num(decimal(c.openAmount).negated().toFixed()),
          num(decimal(c.openBase).negated().toFixed()),
        ]);
        count += 1;
      }
    }
    return count;
  },
};

const byVendorParams = z
  .object({ from: isoDate, to: isoDate, vendorId: z.uuid().optional() })
  .strict();

const byVendorExport: ExportDomain<z.infer<typeof byVendorParams>> = {
  key: 'purchases_by_vendor',
  label: 'Purchases by vendor',
  params: byVendorParams,
  permission: async () => PurchasesPermissions.ReportsView,
  snapshot: true,
  fileName: (p) => `purchases-by-vendor-${p.from}-${p.to}.csv`,
  async generate(env, params) {
    await env.write([
      'vendor',
      'bills',
      'credits',
      'net',
      'recoverable_tax',
      'non_recoverable_tax',
      'cost',
      'tax',
      'total',
    ]);
    const report = await env.services.apReports.purchasesByVendorInTransaction(
      env.tx,
      env.ctx.organizationId,
      params,
    );
    for (const v of report.vendors) {
      await env.write([
        v.vendorName,
        String(v.bills),
        String(v.credits),
        num(v.net),
        num(v.recoverableTax),
        num(v.nonRecoverableTax),
        num(v.cost),
        num(v.tax),
        num(v.total),
      ]);
    }
    return report.vendors.length;
  },
};

const registerParams = z
  .object({
    from: isoDate,
    to: isoDate,
    vendorId: z.uuid().optional(),
    paymentAccountId: z.uuid().optional(),
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.')
      .optional(),
  })
  .strict();

const registerExport: ExportDomain<z.infer<typeof registerParams>> = {
  key: 'payment_register',
  label: 'Payment register',
  params: registerParams,
  permission: async () => PurchasesPermissions.ReportsView,
  snapshot: true,
  fileName: (p) => `payment-register-${p.from}-${p.to}.csv`,
  async generate(env, params) {
    await env.write([
      'record',
      'number',
      'status',
      'date',
      'vendor',
      'account_code',
      'account_name',
      'source',
      'currency',
      'amount',
      'exchange_rate',
      'base_amount',
      'applied_to_bills',
      'prepayment',
      'realized_fx',
    ]);
    const register = await env.services.apReports.paymentRegisterInTransaction(
      env.tx,
      env.ctx.organizationId,
      params,
      REGISTER_EXPORT_ROWS,
    );
    let count = 0;
    for (const p of register.payments) {
      await env.write([
        'payment',
        p.number,
        p.status.toLowerCase(),
        day(p.paymentDate),
        p.vendorName,
        p.account?.code ?? null,
        p.account?.name ?? null,
        null,
        p.currencyCode,
        num(p.amount),
        num(p.exchangeRate),
        num(p.baseAmount),
        num(p.appliedToBills),
        num(p.prepayment),
        num(p.realizedFx),
      ]);
      count += 1;
    }
    for (const r of register.refunds) {
      await env.write([
        'refund',
        r.number,
        r.status.toLowerCase(),
        day(r.refundDate),
        r.vendorName,
        r.account?.code ?? null,
        r.account?.name ?? null,
        `${r.sourceType}:${r.sourceNumber ?? ''}`,
        r.currencyCode,
        num(r.amount),
        num(r.exchangeRate),
        num(r.baseAmount),
        null,
        null,
        num(r.realizedFx),
      ]);
      count += 1;
    }
    return count;
  },
};

const expensesParams = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    status: z.enum(expenseStatuses).optional(),
  })
  .strict();

const expensesExport: ExportDomain<z.infer<typeof expensesParams>> = {
  key: 'expenses',
  label: 'Expenses',
  params: expensesParams,
  permission: async () => ExpensePermissions.View,
  snapshot: false,
  fileName: (_p, now) => `expenses-${today(now)}.csv`,
  async generate(env, params) {
    await env.write([
      'number',
      'status',
      'payee',
      'receipt_number',
      'expense_date',
      'currency',
      'subtotal',
      'discount',
      'tax',
      'recoverable_tax',
      'total',
      'exchange_rate',
      'base_total',
      'paid_from',
      'memo',
    ]);
    const accounts = new Map(
      (await listAccounts(env.tx, env.ctx.organizationId)).map((a) => [a.id, a.code]),
    );
    const cache = new Map<string, string | null>();
    let after: { date: string; id: string } | null = null;
    let count = 0;
    for (;;) {
      const page = await listExpenses(env.tx, {
        organizationId: env.ctx.organizationId,
        statuses: params.status ? [params.status] : null,
        vendorId: null,
        search: null,
        from: params.from ?? null,
        to: params.to ?? null,
        limit: PAGE,
        after,
      });
      await vendorNames(
        env.tx,
        env.ctx.organizationId,
        page.items.map((e) => e.vendorId),
        cache,
      );
      for (const e of page.items) {
        await env.write([
          e.number,
          e.status.toLowerCase(),
          cache.get(e.vendorId) ?? null,
          e.vendorReference,
          day(e.expenseDate),
          e.currencyCode,
          num(e.subtotal),
          num(e.discountTotal),
          num(e.taxTotal),
          num(e.recoverableTaxTotal),
          num(e.total),
          num(e.exchangeRate),
          num(e.baseTotal),
          e.paymentAccountId ? (accounts.get(e.paymentAccountId) ?? null) : null,
          e.memo,
        ]);
        count += 1;
      }
      if (!page.hasMore) break;
      const last = page.items.at(-1)!;
      after = { date: last.expenseDate, id: last.id };
    }
    return count;
  },
};

export const purchasesExportDomains = [
  expensesExport,
  vendorsExport,
  billsExport,
  creditsExport,
  paymentsExport,
  agingExport,
  byVendorExport,
  registerExport,
];
