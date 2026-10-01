import type { Decimal } from 'decimal.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { isValidIsoDate } from '../modules/accounting/index.js';
import { getCustomer } from '../modules/customers/index.js';
import {
  arControlBalance,
  customerActivity,
  getItem,
  getSalesSettings,
  openCreditsAsOf,
  openInvoicesAsOf,
  salesByCustomer,
  salesByItem,
  SalesPermissions,
  taxSummary,
  type OpenCredit,
  type OpenInvoice,
} from '../modules/sales/index.js';
import { getTaxCode } from '../modules/tax/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';
import type { DocumentExposure, RevaluationExposureProvider } from './revaluation-exposures.js';
import { customerName } from './sales-documents.js';

/**
 * AR aging, customer statements and the AR subledger ↔ GL reconciliation (Phase 3B step 16;
 * ADR 0003 D9 buckets; Decisions 11, 45). Everything derives from issued documents and the ledger,
 * as of a date. Also the read-only revaluation exposure provider for open foreign-currency AR
 * (Phase 3B E5, D11): S9 revalues these on the AR control account; the workflow is Phase 4.
 */

export const AGING_BUCKETS = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
] as const;
type Bucket = (typeof AGING_BUCKETS)[number];

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function bucketOf(dueDate: string, asOf: string): Bucket {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return 'current';
  if (overdue <= 30) return 'days1to30';
  if (overdue <= 60) return 'days31to60';
  if (overdue <= 90) return 'days61to90';
  return 'over90';
}

const zeroBuckets = () =>
  Object.fromEntries([...AGING_BUCKETS, 'credit', 'total'].map((b) => [b, decimal(0)])) as Record<
    Bucket | 'credit' | 'total',
    Decimal
  >;

const show = (values: Record<string, Decimal>, places: number) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.toFixed(places)]));

function requireDate(value: string, path: string) {
  if (!isValidIsoDate(value)) {
    throw new ValidationError([{ path, message: 'Enter a valid date (YYYY-MM-DD).' }]);
  }
}

export class ArReportService implements RevaluationExposureProvider {
  readonly key = 'sales.receivables';

  constructor(private readonly deps: AppDependencies) {}

  /** Aging by due date in Current, 1–30, 31–60, 61–90 and 90+ days (ADR 0003 D9). */
  aging(principal: Principal, input: { asOf: string; customerId?: string | undefined }) {
    requireDate(input.asOf, 'asOf');
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.ReportsView, readOnlySnapshot: true },
      (tx, ctx) => this.agingInTransaction(tx, ctx.organizationId, input),
    );
  }

  /** The aging inside the caller's transaction (step 18: the AR aging export). */
  async agingInTransaction(
    tx: Transaction,
    organizationId: string,
    input: { asOf: string; customerId?: string | undefined },
  ) {
    const ctx = { organizationId };
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const base = accounting.baseCurrency;
    const filter = {
      organizationId: ctx.organizationId,
      asOf: input.asOf,
      customerId: input.customerId ?? null,
    };
    const invoices = await openInvoicesAsOf(tx, filter);
    const credits = await openCreditsAsOf(tx, filter);
    const customers = new Map<
      string,
      {
        currencies: Map<string, ReturnType<typeof zeroBuckets>>;
        base: ReturnType<typeof zeroBuckets>;
        invoices: OpenInvoice[];
        credits: OpenCredit[];
      }
    >();
    const entry = (customerId: string) => {
      let found = customers.get(customerId);
      if (!found) {
        found = { currencies: new Map(), base: zeroBuckets(), invoices: [], credits: [] };
        customers.set(customerId, found);
      }
      return found;
    };
    const totals = zeroBuckets();
    for (const invoice of invoices) {
      const c = entry(invoice.customerId);
      c.invoices.push(invoice);
      const bucket = bucketOf(invoice.dueDate, input.asOf);
      const row = c.currencies.get(invoice.currencyCode) ?? zeroBuckets();
      c.currencies.set(invoice.currencyCode, row);
      for (const target of [row]) {
        target[bucket] = target[bucket].plus(decimal(invoice.openAmount));
        target.total = target.total.plus(decimal(invoice.openAmount));
      }
      for (const target of [c.base, totals]) {
        target[bucket] = target[bucket].plus(decimal(invoice.openBase));
        target.total = target.total.plus(decimal(invoice.openBase));
      }
    }
    for (const credit of credits) {
      const c = entry(credit.customerId);
      c.credits.push(credit);
      const row = c.currencies.get(credit.currencyCode) ?? zeroBuckets();
      c.currencies.set(credit.currencyCode, row);
      row.credit = row.credit.minus(decimal(credit.openAmount));
      row.total = row.total.minus(decimal(credit.openAmount));
      for (const target of [c.base, totals]) {
        target.credit = target.credit.minus(decimal(credit.openBase));
        target.total = target.total.minus(decimal(credit.openBase));
      }
    }
    const rows = [];
    for (const [customerId, c] of customers) {
      rows.push({
        customerId,
        customerName: await customerName(tx, ctx.organizationId, customerId),
        currencies: [...c.currencies].map(([currencyCode, values]) => ({
          currencyCode,
          ...show(values, minorUnits(currencyCode)),
        })),
        base: show(c.base, minorUnits(base)),
        invoices: c.invoices.map((i) => ({
          id: i.id,
          number: i.number,
          kind: i.kind,
          invoiceDate: i.invoiceDate,
          dueDate: i.dueDate,
          daysOverdue: Math.max(0, daysBetween(i.dueDate, input.asOf)),
          bucket: bucketOf(i.dueDate, input.asOf),
          currencyCode: i.currencyCode,
          openAmount: decimal(i.openAmount).toFixed(minorUnits(i.currencyCode)),
          openBase: decimal(i.openBase).toFixed(minorUnits(base)),
        })),
        credits: c.credits.map((cr) => ({
          type: cr.type,
          id: cr.id,
          number: cr.number,
          date: cr.date,
          currencyCode: cr.currencyCode,
          openAmount: decimal(cr.openAmount).toFixed(minorUnits(cr.currencyCode)),
          openBase: decimal(cr.openBase).toFixed(minorUnits(base)),
        })),
      });
    }
    rows.sort((a, b) => (a.customerName ?? '').localeCompare(b.customerName ?? ''));
    return {
      asOf: input.asOf,
      baseCurrency: base,
      buckets: AGING_BUCKETS,
      customers: rows,
      totals: show(totals, minorUnits(base)),
    };
  }

  /**
   * A customer statement per currency: the balance brought forward, each invoice, credit note and
   * receipt in the period with a running balance, and the closing balance. Credit applications move
   * credit between documents and do not change the balance.
   */
  statement(principal: Principal, customerId: string, input: { from: string; to: string }) {
    requireDate(input.from, 'from');
    requireDate(input.to, 'to');
    if (input.from > input.to) {
      throw new ValidationError([
        { path: 'from', message: 'The start date is after the end date.' },
      ]);
    }
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const customer = await getCustomer(tx, ctx.organizationId, customerId);
        if (!customer) throw new NotFoundError('Customer not found.');
        const activity = await customerActivity(tx, {
          organizationId: ctx.organizationId,
          customerId,
          to: input.to,
        });
        const currencies = new Map<
          string,
          {
            opening: Decimal;
            lines: {
              type: string;
              id: string;
              number: string;
              date: string;
              reference: string | null;
              amount: Decimal;
              balance: Decimal;
            }[];
          }
        >();
        for (const a of activity) {
          const c = currencies.get(a.currencyCode) ?? { opening: decimal(0), lines: [] };
          currencies.set(a.currencyCode, c);
          const amount = decimal(a.amount);
          if (a.date < input.from) c.opening = c.opening.plus(amount);
          else {
            const previous = c.lines.at(-1)?.balance ?? c.opening;
            c.lines.push({
              type: a.type,
              id: a.id,
              number: a.number,
              date: a.date,
              reference: a.reference,
              amount,
              balance: previous.plus(amount),
            });
          }
        }
        const open = await openInvoicesAsOf(tx, {
          organizationId: ctx.organizationId,
          asOf: input.to,
          customerId,
        });
        return {
          customerId,
          customerName: await customerName(tx, ctx.organizationId, customerId),
          from: input.from,
          to: input.to,
          currencies: [...currencies].map(([currencyCode, c]) => {
            const places = minorUnits(currencyCode);
            return {
              currencyCode,
              openingBalance: c.opening.toFixed(places),
              lines: c.lines.map((l) => ({
                ...l,
                amount: l.amount.toFixed(places),
                balance: l.balance.toFixed(places),
              })),
              closingBalance: (c.lines.at(-1)?.balance ?? c.opening).toFixed(places),
              openInvoices: open
                .filter((i) => i.currencyCode === currencyCode)
                .map((i) => ({
                  id: i.id,
                  number: i.number,
                  dueDate: i.dueDate,
                  bucket: bucketOf(i.dueDate, input.to),
                  openAmount: decimal(i.openAmount).toFixed(places),
                })),
            };
          }),
        };
      },
    );
  }

  /**
   * The AR invariant (Decision 11): the AR control account's GL balance equals the subledger —
   * open invoices at their historical bases less unapplied customer credit — plus any S9
   * revaluation adjustment in effect on the date. Postings from outside Sales are shown (they
   * should be none: the account is a control account, C3/E3).
   */
  reconciliation(principal: Principal, input: { asOf: string }) {
    requireDate(input.asOf, 'asOf');
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const sales = await getSalesSettings(tx, ctx.organizationId);
        if (!sales?.arAccountId) {
          throw new ConflictError(
            'CONFLICT',
            'Choose the AR control account in Sales settings first.',
          );
        }
        return this.reconcile(
          tx,
          ctx.organizationId,
          sales.arAccountId,
          input.asOf,
          accounting.baseCurrency,
        );
      },
    );
  }

  async reconcile(
    tx: Transaction,
    organizationId: string,
    arAccountId: string,
    asOf: string,
    baseCurrency: string,
  ) {
    const places = minorUnits(baseCurrency);
    const invoices = await openInvoicesAsOf(tx, { organizationId, asOf });
    const credits = await openCreditsAsOf(tx, { organizationId, asOf });
    const invoiceBase = invoices.reduce((s, i) => s.plus(decimal(i.openBase)), decimal(0));
    const creditBase = credits.reduce((s, c) => s.plus(decimal(c.openBase)), decimal(0));
    const subledger = invoiceBase.minus(creditBase);
    const gl = await arControlBalance(tx, { organizationId, accountId: arAccountId, asOf });
    const difference = decimal(gl.total).minus(decimal(gl.revaluation)).minus(subledger);
    return {
      asOf,
      baseCurrency,
      arAccountId,
      glBalance: decimal(gl.total).toFixed(places),
      revaluationAdjustments: decimal(gl.revaluation).toFixed(places),
      postingsOutsideSales: decimal(gl.other).toFixed(places),
      subledger: {
        openInvoices: invoiceBase.toFixed(places),
        unappliedCredit: creditBase.negated().toFixed(places),
        total: subledger.toFixed(places),
      },
      difference: difference.toFixed(places),
      reconciled: difference.isZero(),
    };
  }

  // ---------------------------------------------------------------------------
  // Sales reports (step 17; Decision 45)
  // ---------------------------------------------------------------------------

  private period(input: { from: string; to: string }) {
    requireDate(input.from, 'from');
    requireDate(input.to, 'to');
    if (input.from > input.to) {
      throw new ValidationError([
        { path: 'from', message: 'The start date is after the end date.' },
      ]);
    }
  }

  /** Net sales (before tax), tax and document counts per customer, in the base currency. */
  salesByCustomer(principal: Principal, input: { from: string; to: string }) {
    this.period(input);
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const places = minorUnits(accounting.baseCurrency);
        const rows = await salesByCustomer(tx, {
          organizationId: ctx.organizationId,
          ...input,
          places,
        });
        const out = [];
        let net = decimal(0);
        let tax = decimal(0);
        for (const r of rows) {
          net = net.plus(decimal(r.net));
          tax = tax.plus(decimal(r.tax));
          out.push({
            customerId: r.customer_id,
            customerName: await customerName(tx, ctx.organizationId, r.customer_id),
            invoices: r.invoices,
            creditNotes: r.credit_notes,
            netSales: decimal(r.net).toFixed(places),
            tax: decimal(r.tax).toFixed(places),
            total: decimal(r.net).plus(decimal(r.tax)).toFixed(places),
          });
        }
        return {
          ...input,
          baseCurrency: accounting.baseCurrency,
          customers: out,
          totals: {
            netSales: net.toFixed(places),
            tax: tax.toFixed(places),
            total: net.plus(tax).toFixed(places),
          },
        };
      },
    );
  }

  /** Quantity and net sales per item (lines without an item are grouped together). */
  salesByItem(principal: Principal, input: { from: string; to: string }) {
    this.period(input);
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const places = minorUnits(accounting.baseCurrency);
        const rows = await salesByItem(tx, {
          organizationId: ctx.organizationId,
          ...input,
          places,
        });
        const out = [];
        for (const r of rows) {
          const item = r.item_id ? await getItem(tx, ctx.organizationId, r.item_id) : undefined;
          out.push({
            itemId: r.item_id,
            name: item?.name ?? null,
            sku: item?.sku ?? null,
            quantity: decimal(r.quantity).toFixed(),
            lines: r.lines,
            netSales: decimal(r.net).toFixed(places),
          });
        }
        return {
          ...input,
          baseCurrency: accounting.baseCurrency,
          items: out,
          totals: {
            netSales: rows.reduce((sum, r) => sum.plus(decimal(r.net)), decimal(0)).toFixed(places),
          },
        };
      },
    );
  }

  /**
   * Taxable sales and output tax per tax code and rate, in the base currency at each document's
   * rate. A review summary, not a tax return (R31); the statutory rule for converting
   * foreign-currency tax (U19) remains open.
   */
  taxSummary(principal: Principal, input: { from: string; to: string }) {
    this.period(input);
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const places = minorUnits(accounting.baseCurrency);
        const rows = await taxSummary(tx, { organizationId: ctx.organizationId, ...input, places });
        const out = [];
        for (const r of rows) {
          const code = r.tax_code_id
            ? await getTaxCode(tx, ctx.organizationId, r.tax_code_id)
            : undefined;
          out.push({
            taxCodeId: r.tax_code_id,
            code: code?.code ?? null,
            rate: r.tax_rate === null ? null : decimal(r.tax_rate).toFixed(),
            taxable: decimal(r.taxable).toFixed(places),
            tax: decimal(r.tax).toFixed(places),
          });
        }
        return {
          ...input,
          baseCurrency: accounting.baseCurrency,
          note: 'Summary for review only; not a tax return. Foreign-currency tax uses the document rate pending the MIRA conversion rule.',
          codes: out,
          totals: {
            taxable: rows
              .reduce((sum, r) => sum.plus(decimal(r.taxable)), decimal(0))
              .toFixed(places),
            tax: rows.reduce((sum, r) => sum.plus(decimal(r.tax)), decimal(0)).toFixed(places),
          },
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // E5: S9 revaluation exposure provider (read-only)
  // ---------------------------------------------------------------------------

  async listExposures(
    tx: Transaction,
    input: { organizationId: string; revaluationDate: string; baseCurrency: string },
  ): Promise<DocumentExposure[]> {
    const sales = await getSalesSettings(tx, input.organizationId);
    if (!sales?.arAccountId) return [];
    const filter = { organizationId: input.organizationId, asOf: input.revaluationDate };
    const invoices = (await openInvoicesAsOf(tx, filter)).filter(
      (i) => i.currencyCode !== input.baseCurrency,
    );
    const credits = (await openCreditsAsOf(tx, filter)).filter(
      (c) => c.currencyCode !== input.baseCurrency,
    );
    return [
      ...invoices.map((i): DocumentExposure => ({
        documentModule: 'sales',
        documentType: 'invoice',
        documentId: i.id,
        controlAccountId: sales.arAccountId!,
        currency: i.currencyCode,
        foreignBalance: decimal(i.openAmount).toFixed(4),
        carryingBase: decimal(i.openBase).toFixed(4),
      })),
      ...credits.map((c): DocumentExposure => ({
        documentModule: 'sales',
        documentType: c.type,
        documentId: c.id,
        controlAccountId: sales.arAccountId!,
        currency: c.currencyCode,
        // Customer credit is a credit balance on the AR control account.
        foreignBalance: decimal(c.openAmount).negated().toFixed(4),
        carryingBase: decimal(c.openBase).negated().toFixed(4),
      })),
    ];
  }
}
