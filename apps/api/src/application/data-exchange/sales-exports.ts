import { z } from 'zod';
import { decimal } from '../../domain/money.js';
import type { Transaction } from '../../database/client.js';
import { listAccounts } from '../../modules/accounting/index.js';
import {
  CustomerPermissions,
  customerPartyIds,
  listCustomersByParty,
} from '../../modules/customers/index.js';
import { listParties } from '../../modules/parties/index.js';
import {
  invoiceStatuses,
  listInvoices,
  listItems,
  listReceipts,
  receiptStatuses,
  SalesPermissions,
} from '../../modules/sales/index.js';
import { listTaxCodes } from '../../modules/tax/index.js';
import { hasPermission } from '../authorization.js';
import { customerName } from '../sales-documents.js';
import type { ExportCell, ExportDomain } from './types.js';

/**
 * Sales exports (Phase 3B step 18; brief §AC): customers, items, invoices, receipts and AR aging,
 * as CSV (XLSX awaits its Decision 62 approval). Each export requires the view permission of its
 * screen, re-checked on every access (Decision 65).
 */

const PAGE = 500;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const num = (value: string | null | undefined): ExportCell => ({ number: value ?? null });
const day = (value: string | null | undefined): ExportCell => ({ date: value ?? null });
const today = (now: Date) => now.toISOString().slice(0, 10);
const statusParams = z
  .object({ status: z.enum(['active', 'archived', 'all']).default('active') })
  .strict();

async function names(
  tx: Transaction,
  organizationId: string,
  ids: readonly string[],
  cache: Map<string, string | null>,
) {
  for (const id of ids)
    if (!cache.has(id)) cache.set(id, await customerName(tx, organizationId, id));
}

const customersExport: ExportDomain<z.infer<typeof statusParams>> = {
  key: 'customers',
  label: 'Customers',
  params: statusParams,
  permission: async () => CustomerPermissions.View,
  snapshot: false,
  fileName: (_p, now) => `customers-${today(now)}.csv`,
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
      'status',
    ]);
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
        partyIdsIn: customerPartyIds(env.ctx.organizationId, status),
      });
      const rows = await listCustomersByParty(
        env.tx,
        env.ctx.organizationId,
        page.items.map((i) => i.party.id),
      );
      const byParty = new Map(rows.map((c) => [c.partyId, c]));
      for (const { party } of page.items) {
        const c = byParty.get(party.id)!;
        await env.write([
          party.kind,
          party.displayName,
          party.companyName,
          party.reference,
          party.tin,
          party.email,
          party.phone,
          c.currencyCode,
          c.paymentTermsDays === null ? null : String(c.paymentTermsDays),
          num(c.creditLimit),
          c.status.toLowerCase(),
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

const itemsExport: ExportDomain<z.infer<typeof statusParams>> = {
  key: 'sales_items',
  label: 'Items',
  params: statusParams,
  // D8: items are visible to invoice viewers and to item managers.
  permission: async (_p, env) =>
    hasPermission(env.ctx, SalesPermissions.ItemsManage)
      ? SalesPermissions.ItemsManage
      : SalesPermissions.InvoicesView,
  snapshot: false,
  fileName: (_p, now) => `items-${today(now)}.csv`,
  async generate(env, params) {
    await env.write([
      'sku',
      'name',
      'type',
      'description',
      'unit_price',
      'revenue_account',
      'tax_code',
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
      const page = await listItems(env.tx, {
        organizationId: env.ctx.organizationId,
        status,
        search: null,
        limit: PAGE,
        after,
      });
      for (const item of page.items) {
        await env.write([
          item.sku,
          item.name,
          item.itemType,
          item.description,
          num(item.unitPrice),
          item.revenueAccountId ? (accounts.get(item.revenueAccountId) ?? null) : null,
          item.taxCodeId ? (codes.get(item.taxCodeId) ?? null) : null,
          item.status.toLowerCase(),
        ]);
        count += 1;
      }
      if (!page.hasMore) break;
      const last = page.items.at(-1)!;
      after = { name: last.name.toLowerCase(), id: last.id };
    }
    return count;
  },
};

const invoicesParams = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    status: z.enum(invoiceStatuses).optional(),
  })
  .strict();

const invoicesExport: ExportDomain<z.infer<typeof invoicesParams>> = {
  key: 'invoices',
  label: 'Invoices',
  params: invoicesParams,
  permission: async () => SalesPermissions.InvoicesView,
  snapshot: false,
  fileName: (_p, now) => `invoices-${today(now)}.csv`,
  async generate(env, params) {
    await env.write([
      'number',
      'kind',
      'status',
      'customer',
      'invoice_date',
      'due_date',
      'currency',
      'subtotal',
      'discount',
      'tax',
      'total',
      'amount_due',
      'exchange_rate',
      'base_total',
      'base_due',
      'reference',
    ]);
    const cache = new Map<string, string | null>();
    let after: { date: string; id: string } | null = null;
    let count = 0;
    for (;;) {
      const page = await listInvoices(env.tx, {
        organizationId: env.ctx.organizationId,
        statuses: params.status ? [params.status] : null,
        customerId: null,
        search: null,
        from: params.from ?? null,
        to: params.to ?? null,
        openOnly: false,
        limit: PAGE,
        after,
      });
      await names(
        env.tx,
        env.ctx.organizationId,
        page.items.map((i) => i.customerId),
        cache,
      );
      for (const i of page.items) {
        await env.write([
          i.number,
          i.kind,
          i.status.toLowerCase(),
          cache.get(i.customerId) ?? null,
          day(i.invoiceDate),
          day(i.dueDate),
          i.currencyCode,
          num(i.subtotal),
          num(i.discountTotal),
          num(i.taxTotal),
          num(i.total),
          num(i.amountDue),
          num(i.exchangeRate),
          num(i.baseTotal),
          num(i.baseDue),
          i.reference,
        ]);
        count += 1;
      }
      if (!page.hasMore) break;
      const last = page.items.at(-1)!;
      after = { date: last.invoiceDate, id: last.id };
    }
    return count;
  },
};

const receiptsParams = z.object({ status: z.enum(receiptStatuses).optional() }).strict();

const receiptsExport: ExportDomain<z.infer<typeof receiptsParams>> = {
  key: 'receipts',
  label: 'Receipts',
  params: receiptsParams,
  permission: async () => SalesPermissions.ReceiptsView,
  snapshot: false,
  fileName: (_p, now) => `receipts-${today(now)}.csv`,
  async generate(env, params) {
    await env.write([
      'number',
      'status',
      'customer',
      'receipt_date',
      'currency',
      'amount',
      'exchange_rate',
      'rate_source',
      'base_amount',
      'unallocated',
      'deposit_account',
      'reference',
    ]);
    const accounts = new Map(
      (await listAccounts(env.tx, env.ctx.organizationId)).map((a) => [a.id, a.code]),
    );
    const cache = new Map<string, string | null>();
    let after: { date: string; id: string } | null = null;
    let count = 0;
    for (;;) {
      const page = await listReceipts(env.tx, {
        organizationId: env.ctx.organizationId,
        status: params.status ?? null,
        customerId: null,
        search: null,
        withCredit: false,
        limit: PAGE,
        after,
      });
      await names(
        env.tx,
        env.ctx.organizationId,
        page.items.map((r) => r.customerId),
        cache,
      );
      for (const r of page.items) {
        await env.write([
          r.number,
          r.status.toLowerCase(),
          cache.get(r.customerId) ?? null,
          day(r.receiptDate),
          r.currencyCode,
          num(r.amount),
          num(r.exchangeRate),
          r.exchangeRateSource,
          num(r.baseAmount),
          num(r.amountUnallocated),
          accounts.get(r.depositAccountId) ?? null,
          r.reference,
        ]);
        count += 1;
      }
      if (!page.hasMore) break;
      const last = page.items.at(-1)!;
      after = { date: last.receiptDate, id: last.id };
    }
    return count;
  },
};

const agingParams = z.object({ asOf: isoDate }).strict();

const agingExport: ExportDomain<z.infer<typeof agingParams>> = {
  key: 'ar_aging',
  label: 'AR aging',
  params: agingParams,
  permission: async () => SalesPermissions.ReportsView,
  snapshot: true,
  fileName: (p) => `ar-aging-${p.asOf}.csv`,
  async generate(env, params) {
    await env.write([
      'customer',
      'document_type',
      'number',
      'date',
      'due_date',
      'days_overdue',
      'bucket',
      'currency',
      'open_amount',
      'open_base',
    ]);
    const aging = await env.services.arReports.agingInTransaction(
      env.tx,
      env.ctx.organizationId,
      params,
    );
    let count = 0;
    for (const c of aging.customers) {
      for (const i of c.invoices) {
        await env.write([
          c.customerName,
          'invoice',
          i.number,
          day(i.invoiceDate),
          day(i.dueDate),
          String(i.daysOverdue),
          i.bucket,
          i.currencyCode,
          num(i.openAmount),
          num(i.openBase),
        ]);
        count += 1;
      }
      for (const cr of c.credits) {
        await env.write([
          c.customerName,
          cr.type,
          cr.number,
          day(cr.date),
          null,
          null,
          'credit',
          cr.currencyCode,
          num(decimal(cr.openAmount).negated().toFixed()),
          num(decimal(cr.openBase).negated().toFixed()),
        ]);
        count += 1;
      }
    }
    return count;
  },
};

export const salesExportDomains = [
  customersExport,
  itemsExport,
  invoicesExport,
  receiptsExport,
  agingExport,
];
