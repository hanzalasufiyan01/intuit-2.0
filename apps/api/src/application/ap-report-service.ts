import type { Decimal } from 'decimal.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { getAccount, isValidIsoDate } from '../modules/accounting/index.js';
import { getItem } from '../modules/catalog/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  apControlBalance,
  getPurchasesSettings,
  openBillsAsOf,
  openPrepaymentsAsOf,
  openVendorCreditsAsOf,
  limitRegister,
  PAYMENT_REGISTER_LIMIT,
  purchaseLines,
  PurchasesPermissions,
  registerPayments,
  registerRefunds,
  vendorActivity,
  type PurchaseLine,
  type OpenBill,
  type OpenVendorCredit,
} from '../modules/purchases/index.js';
import { getTaxCode } from '../modules/tax/index.js';
import { getVendor } from '../modules/vendors/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';
import type { DocumentExposure, RevaluationExposureProvider } from './revaluation-exposures.js';

/**
 * AP aging, vendor statements and the AP subledger ↔ GL reconciliation (Phase 4B-5; ADR 0004
 * P4-49, brief §26, PD1–PD7). Everything is read-only and derives from posted documents and the
 * ledger as of a date, in a read-only snapshot. Also the read-only S9 revaluation exposure provider
 * `purchases.payables` for open foreign-currency AP (PD6): it reports, S9 posts.
 *
 * AP amounts read "what we owe the vendor": bills positive, credits and prepayments negative
 * (PD4). Bases are historical carrying values, never revalued (PD7).
 */

export const AP_AGING_BUCKETS = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
] as const;
type Bucket = (typeof AP_AGING_BUCKETS)[number];

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Due-date buckets (ADR 0003 D9, P4-49): due today or later is current. */
export function apBucketOf(dueDate: string, asOf: string): Bucket {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return 'current';
  if (overdue <= 30) return 'days1to30';
  if (overdue <= 60) return 'days31to60';
  if (overdue <= 90) return 'days61to90';
  return 'over90';
}

const zeroBuckets = () =>
  Object.fromEntries(
    [...AP_AGING_BUCKETS, 'credit', 'total'].map((b) => [b, decimal(0)]),
  ) as Record<Bucket | 'credit' | 'total', Decimal>;

const show = (values: Record<string, Decimal>, places: number) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.toFixed(places)]));

function requireDate(value: string, path: string) {
  if (!isValidIsoDate(value)) {
    throw new ValidationError([{ path, message: 'Enter a valid date (YYYY-MM-DD).' }]);
  }
}

async function vendorName(tx: Transaction, organizationId: string, vendorId: string) {
  const vendor = await getVendor(tx, organizationId, vendorId);
  const party = vendor ? await getParty(tx, organizationId, vendor.partyId) : undefined;
  return party?.displayName ?? null;
}

/** Unapplied vendor credits and unallocated prepayments: both reduce what is owed. */
async function openCreditsAsOf(
  tx: Transaction,
  filter: { organizationId: string; asOf: string; vendorId?: string | null },
): Promise<OpenVendorCredit[]> {
  return [...(await openVendorCreditsAsOf(tx, filter)), ...(await openPrepaymentsAsOf(tx, filter))];
}

// ---------------------------------------------------------------------------
// Phase 4B-6 helpers
// ---------------------------------------------------------------------------

/** PD1: relative cash-planning buckets by days until due (not calendar weeks). */
export const UNPAID_BUCKETS = [
  { key: 'overdue', fromDays: null, toDays: -1 },
  { key: 'days0to7', fromDays: 0, toDays: 7 },
  { key: 'days8to14', fromDays: 8, toDays: 14 },
  { key: 'days15to21', fromDays: 15, toDays: 21 },
  { key: 'days22to28', fromDays: 22, toDays: 28 },
  { key: 'later', fromDays: 29, toDays: null },
] as const;

export function unpaidBucketIndex(dueDate: string, asOf: string): number {
  const until = daysBetween(asOf, dueDate);
  if (until < 0) return 0;
  if (until <= 7) return 1;
  if (until <= 14) return 2;
  if (until <= 21) return 3;
  if (until <= 28) return 4;
  return 5;
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function unpaidRow(bill: OpenBill, asOf: string, base: string, vendor: string | null) {
  return {
    id: bill.id,
    number: bill.number,
    vendorId: bill.vendorId,
    vendorName: vendor,
    vendorReference: bill.vendorReference,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    daysUntilDue: daysBetween(asOf, bill.dueDate),
    currencyCode: bill.currencyCode,
    openAmount: decimal(bill.openAmount).toFixed(minorUnits(bill.currencyCode)),
    openBase: decimal(bill.openBase).toFixed(minorUnits(base)),
  };
}

interface Sums {
  net: Decimal;
  recoverable: Decimal;
  nonRecoverable: Decimal;
}

const zeroSums = (): Sums => ({
  net: decimal(0),
  recoverable: decimal(0),
  nonRecoverable: decimal(0),
});

function addLine(sums: Sums, line: PurchaseLine) {
  sums.net = sums.net.plus(decimal(line.netBase));
  sums.recoverable = sums.recoverable.plus(decimal(line.recoverableTaxBase));
  sums.nonRecoverable = sums.nonRecoverable.plus(decimal(line.nonRecoverableTaxBase));
}

/** PD2: net, recoverable and non-recoverable tax, cost (net + non-recoverable) and total. */
function showSums(sums: Sums, base: string) {
  const places = minorUnits(base);
  return {
    net: sums.net.toFixed(places),
    recoverableTax: sums.recoverable.toFixed(places),
    nonRecoverableTax: sums.nonRecoverable.toFixed(places),
    cost: sums.net.plus(sums.nonRecoverable).toFixed(places),
    tax: sums.recoverable.plus(sums.nonRecoverable).toFixed(places),
    total: sums.net.plus(sums.nonRecoverable).plus(sums.recoverable).toFixed(places),
  };
}

interface RegisterInput {
  from: string;
  to: string;
  vendorId?: string | undefined;
  paymentAccountId?: string | undefined;
  currencyCode?: string | undefined;
}

export class ApReportService implements RevaluationExposureProvider {
  readonly key = 'purchases.payables';

  constructor(private readonly deps: AppDependencies) {}

  /** Aging by due date in Current, 1–30, 31–60, 61–90 and 90+ days (P4-49, D9). */
  aging(principal: Principal, input: { asOf: string; vendorId?: string | undefined }) {
    requireDate(input.asOf, 'asOf');
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchasesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (input.vendorId && !(await getVendor(tx, ctx.organizationId, input.vendorId))) {
          throw new NotFoundError('Vendor not found.');
        }
        return this.agingInTransaction(tx, ctx.organizationId, input);
      },
    );
  }

  async agingInTransaction(
    tx: Transaction,
    organizationId: string,
    input: { asOf: string; vendorId?: string | undefined },
  ) {
    const accounting = await requireAccountingSettings(tx, organizationId);
    const base = accounting.baseCurrency;
    const filter = { organizationId, asOf: input.asOf, vendorId: input.vendorId ?? null };
    const bills = await openBillsAsOf(tx, filter);
    const credits = await openCreditsAsOf(tx, filter);
    const vendors = new Map<
      string,
      {
        currencies: Map<string, ReturnType<typeof zeroBuckets>>;
        base: ReturnType<typeof zeroBuckets>;
        bills: OpenBill[];
        credits: OpenVendorCredit[];
      }
    >();
    const entry = (vendorId: string) => {
      let found = vendors.get(vendorId);
      if (!found) {
        found = { currencies: new Map(), base: zeroBuckets(), bills: [], credits: [] };
        vendors.set(vendorId, found);
      }
      return found;
    };
    const totals = zeroBuckets();
    for (const bill of bills) {
      const v = entry(bill.vendorId);
      v.bills.push(bill);
      const bucket = apBucketOf(bill.dueDate, input.asOf);
      const row = v.currencies.get(bill.currencyCode) ?? zeroBuckets();
      v.currencies.set(bill.currencyCode, row);
      row[bucket] = row[bucket].plus(decimal(bill.openAmount));
      row.total = row.total.plus(decimal(bill.openAmount));
      for (const target of [v.base, totals]) {
        target[bucket] = target[bucket].plus(decimal(bill.openBase));
        target.total = target.total.plus(decimal(bill.openBase));
      }
    }
    for (const credit of credits) {
      const v = entry(credit.vendorId);
      v.credits.push(credit);
      const row = v.currencies.get(credit.currencyCode) ?? zeroBuckets();
      v.currencies.set(credit.currencyCode, row);
      row.credit = row.credit.minus(decimal(credit.openAmount));
      row.total = row.total.minus(decimal(credit.openAmount));
      for (const target of [v.base, totals]) {
        target.credit = target.credit.minus(decimal(credit.openBase));
        target.total = target.total.minus(decimal(credit.openBase));
      }
    }
    const rows = [];
    for (const [vendorId, v] of vendors) {
      rows.push({
        vendorId,
        vendorName: await vendorName(tx, organizationId, vendorId),
        currencies: [...v.currencies].map(([currencyCode, values]) => ({
          currencyCode,
          ...show(values, minorUnits(currencyCode)),
        })),
        base: show(v.base, minorUnits(base)),
        bills: v.bills.map((b) => ({
          id: b.id,
          number: b.number,
          vendorReference: b.vendorReference,
          billDate: b.billDate,
          dueDate: b.dueDate,
          daysOverdue: Math.max(0, daysBetween(b.dueDate, input.asOf)),
          bucket: apBucketOf(b.dueDate, input.asOf),
          currencyCode: b.currencyCode,
          openAmount: decimal(b.openAmount).toFixed(minorUnits(b.currencyCode)),
          openBase: decimal(b.openBase).toFixed(minorUnits(base)),
        })),
        credits: v.credits.map((c) => ({
          type: c.type,
          id: c.id,
          number: c.number,
          origin: c.origin,
          date: c.date,
          currencyCode: c.currencyCode,
          openAmount: decimal(c.openAmount).toFixed(minorUnits(c.currencyCode)),
          openBase: decimal(c.openBase).toFixed(minorUnits(base)),
        })),
      });
    }
    rows.sort((a, b) => (a.vendorName ?? '').localeCompare(b.vendorName ?? ''));
    return {
      asOf: input.asOf,
      baseCurrency: base,
      buckets: AP_AGING_BUCKETS,
      vendors: rows,
      totals: show(totals, minorUnits(base)),
    };
  }

  /**
   * A vendor statement per currency (PD4): the balance brought forward, each bill, vendor credit or
   * debit note, payment and refund in the period with a running balance of what we owe the vendor,
   * and the open bills at the end date. Applications move value between documents and are not
   * lines; the closing balance equals the vendor's open position at the end date.
   */
  statement(principal: Principal, vendorId: string, input: { from: string; to: string }) {
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
      { permission: PurchasesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const vendor = await getVendor(tx, ctx.organizationId, vendorId);
        if (!vendor) throw new NotFoundError('Vendor not found.');
        const activity = await vendorActivity(tx, {
          organizationId: ctx.organizationId,
          vendorId,
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
              origin: string | null;
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
              origin: a.origin,
              date: a.date,
              reference: a.reference,
              amount,
              balance: previous.plus(amount),
            });
          }
        }
        const open = await openBillsAsOf(tx, {
          organizationId: ctx.organizationId,
          asOf: input.to,
          vendorId,
        });
        return {
          vendorId,
          vendorName: await vendorName(tx, ctx.organizationId, vendorId),
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
              openBills: open
                .filter((b) => b.currencyCode === currencyCode)
                .map((b) => ({
                  id: b.id,
                  number: b.number,
                  dueDate: b.dueDate,
                  bucket: apBucketOf(b.dueDate, input.to),
                  openAmount: decimal(b.openAmount).toFixed(places),
                })),
            };
          }),
        };
      },
    );
  }

  /**
   * The AP invariant (I-1): −(AP control GL balance − revaluation adjustments) = Σ POSTED bills
   * base_due − Σ POSTED vendor credits base_unapplied − Σ RECORDED payments base_unallocated, as
   * of a date. AP amounts are shown credit-positive (owed), so the GL side reads directly as the
   * liability. Postings from outside Purchases are shown (they should be none).
   */
  reconciliation(principal: Principal, input: { asOf: string }) {
    requireDate(input.asOf, 'asOf');
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchasesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const purchases = await getPurchasesSettings(tx, ctx.organizationId);
        if (!purchases?.apAccountId) {
          throw new ConflictError(
            'CONFLICT',
            'Choose the AP control account in Purchases settings first.',
          );
        }
        return this.reconcile(
          tx,
          ctx.organizationId,
          purchases.apAccountId,
          input.asOf,
          accounting.baseCurrency,
        );
      },
    );
  }

  async reconcile(
    tx: Transaction,
    organizationId: string,
    apAccountId: string,
    asOf: string,
    baseCurrency: string,
  ) {
    const places = minorUnits(baseCurrency);
    const filter = { organizationId, asOf };
    const sum = (rows: readonly { openBase: string }[]) =>
      rows.reduce((s, r) => s.plus(decimal(r.openBase)), decimal(0));
    const bills = sum(await openBillsAsOf(tx, filter));
    const credits = sum(await openVendorCreditsAsOf(tx, filter));
    const prepayments = sum(await openPrepaymentsAsOf(tx, filter));
    const subledger = bills.minus(credits).minus(prepayments);
    const gl = await apControlBalance(tx, { organizationId, accountId: apAccountId, asOf });
    const difference = decimal(gl.total).minus(decimal(gl.revaluation)).minus(subledger);
    return {
      asOf,
      baseCurrency,
      apAccountId,
      glBalance: decimal(gl.total).toFixed(places),
      revaluationAdjustments: decimal(gl.revaluation).toFixed(places),
      postingsOutsidePurchases: decimal(gl.other).toFixed(places),
      subledger: {
        openBills: bills.toFixed(places),
        unappliedCredits: credits.negated().toFixed(places),
        prepayments: prepayments.negated().toFixed(places),
        total: subledger.toFixed(places),
      },
      difference: difference.toFixed(places),
      reconciled: difference.isZero(),
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 4B-6: unpaid bills, purchase analysis, input tax, payment register (P4-49)
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

  private async requireVendor(tx: Transaction, organizationId: string, vendorId?: string) {
    if (vendorId && !(await getVendor(tx, organizationId, vendorId))) {
      throw new NotFoundError('Vendor not found.');
    }
  }

  /**
   * Unpaid bills by due date for cash planning (PD1, PD3): open POSTED bills as of a date (the AP
   * aging's bills), grouped Overdue, due in 0–7, 8–14, 15–21 and 22–28 days, then Later. Applied
   * credits and prepayments have already reduced each bill; unapplied ones are not netted.
   */
  unpaidBills(principal: Principal, input: { asOf: string; vendorId?: string | undefined }) {
    requireDate(input.asOf, 'asOf');
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchasesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        await this.requireVendor(tx, ctx.organizationId, input.vendorId);
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const base = accounting.baseCurrency;
        const bills = await openBillsAsOf(tx, {
          organizationId: ctx.organizationId,
          asOf: input.asOf,
          vendorId: input.vendorId ?? null,
        });
        const names = new Map<string, string | null>();
        for (const id of new Set(bills.map((b) => b.vendorId))) {
          names.set(id, await vendorName(tx, ctx.organizationId, id));
        }
        const buckets = UNPAID_BUCKETS.map((b) => ({
          key: b.key,
          from: b.fromDays === null ? null : addDays(input.asOf, b.fromDays),
          to: b.toDays === null ? null : addDays(input.asOf, b.toDays),
          currencies: new Map<string, Decimal>(),
          base: decimal(0),
          bills: [] as ReturnType<typeof unpaidRow>[],
        }));
        const currencies = new Map<string, Decimal>();
        let baseTotal = decimal(0);
        for (const bill of bills) {
          const bucket = buckets[unpaidBucketIndex(bill.dueDate, input.asOf)]!;
          const open = decimal(bill.openAmount);
          bucket.currencies.set(
            bill.currencyCode,
            (bucket.currencies.get(bill.currencyCode) ?? decimal(0)).plus(open),
          );
          currencies.set(
            bill.currencyCode,
            (currencies.get(bill.currencyCode) ?? decimal(0)).plus(open),
          );
          bucket.base = bucket.base.plus(decimal(bill.openBase));
          baseTotal = baseTotal.plus(decimal(bill.openBase));
          bucket.bills.push(unpaidRow(bill, input.asOf, base, names.get(bill.vendorId) ?? null));
        }
        const money = (m: Map<string, Decimal>) =>
          [...m].map(([currencyCode, amount]) => ({
            currencyCode,
            amount: amount.toFixed(minorUnits(currencyCode)),
          }));
        return {
          asOf: input.asOf,
          baseCurrency: base,
          buckets: buckets.map((b) => ({
            key: b.key,
            from: b.from,
            to: b.to,
            currencies: money(b.currencies),
            base: b.base.toFixed(minorUnits(base)),
            bills: b.bills,
          })),
          totals: { currencies: money(currencies), base: baseTotal.toFixed(minorUnits(base)) },
        };
      },
    );
  }

  /** Signed purchase lines in a period with canonical bases (PD2, PD4, PD5, PD12). */
  private async lines(
    tx: Transaction,
    organizationId: string,
    input: { from: string; to: string; vendorId?: string | undefined },
  ) {
    const accounting = await requireAccountingSettings(tx, organizationId);
    const result = await purchaseLines(tx, {
      organizationId,
      from: input.from,
      to: input.to,
      baseCurrency: accounting.baseCurrency,
      vendorId: input.vendorId ?? null,
    });
    return { ...result, base: accounting.baseCurrency };
  }

  /** Posted bills less vendor credits and debit notes per vendor, in base (PD2). */
  purchasesByVendor(
    principal: Principal,
    input: { from: string; to: string; vendorId?: string | undefined },
  ) {
    this.period(input);
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchasesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        await this.requireVendor(tx, ctx.organizationId, input.vendorId);
        const { lines, base } = await this.lines(tx, ctx.organizationId, input);
        const groups = new Map<string, { bills: Set<string>; credits: Set<string>; sums: Sums }>();
        const totals = zeroSums();
        for (const l of lines) {
          const g = groups.get(l.vendorId) ?? {
            bills: new Set(),
            credits: new Set(),
            sums: zeroSums(),
          };
          groups.set(l.vendorId, g);
          (l.documentType === 'bill' ? g.bills : g.credits).add(l.documentId);
          addLine(g.sums, l);
          addLine(totals, l);
        }
        const vendors = [];
        for (const [vendorId, g] of groups) {
          vendors.push({
            vendorId,
            vendorName: await vendorName(tx, ctx.organizationId, vendorId),
            bills: g.bills.size,
            credits: g.credits.size,
            ...showSums(g.sums, base),
          });
        }
        vendors.sort((a, b) => (a.vendorName ?? '').localeCompare(b.vendorName ?? ''));
        return {
          from: input.from,
          to: input.to,
          baseCurrency: base,
          vendors,
          totals: showSums(totals, base),
        };
      },
    );
  }

  /** Purchase lines per item; account-based lines form one "No item" row (PD10). */
  purchasesByItem(
    principal: Principal,
    input: { from: string; to: string; itemId?: string | undefined },
  ) {
    this.period(input);
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchasesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (input.itemId && !(await getItem(tx, ctx.organizationId, input.itemId))) {
          throw new NotFoundError('Item not found.');
        }
        const { lines, base } = await this.lines(tx, ctx.organizationId, input);
        const groups = new Map<string | null, { quantity: Decimal; lines: number; sums: Sums }>();
        const totals = zeroSums();
        for (const l of lines) {
          if (input.itemId && l.itemId !== input.itemId) continue;
          const g = groups.get(l.itemId) ?? { quantity: decimal(0), lines: 0, sums: zeroSums() };
          groups.set(l.itemId, g);
          g.quantity = g.quantity.plus(decimal(l.quantity));
          g.lines += 1;
          addLine(g.sums, l);
          addLine(totals, l);
        }
        const items = [];
        for (const [itemId, g] of groups) {
          const item = itemId ? await getItem(tx, ctx.organizationId, itemId) : undefined;
          items.push({
            itemId,
            name: item?.name ?? null,
            sku: item?.sku ?? null,
            quantity: g.quantity.toFixed(),
            lines: g.lines,
            ...showSums(g.sums, base),
          });
        }
        items.sort((a, b) =>
          a.itemId === null
            ? 1
            : b.itemId === null
              ? -1
              : (a.name ?? '').localeCompare(b.name ?? ''),
        );
        return {
          from: input.from,
          to: input.to,
          baseCurrency: base,
          items,
          totals: showSums(totals, base),
        };
      },
    );
  }

  /**
   * Cost per line account (PD2): net plus non-recoverable tax (capitalized into the account,
   * P4-12) — the amount posted to the account. Recoverable input tax stays separate.
   */
  purchasesByAccount(
    principal: Principal,
    input: { from: string; to: string; accountId?: string | undefined },
  ) {
    this.period(input);
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchasesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (input.accountId && !(await getAccount(tx, ctx.organizationId, input.accountId))) {
          throw new NotFoundError('Account not found.');
        }
        const { lines, base } = await this.lines(tx, ctx.organizationId, input);
        const groups = new Map<string | null, Sums>();
        const totals = zeroSums();
        for (const l of lines) {
          if (input.accountId && l.accountId !== input.accountId) continue;
          const g = groups.get(l.accountId) ?? zeroSums();
          groups.set(l.accountId, g);
          addLine(g, l);
          addLine(totals, l);
        }
        const accounts = [];
        for (const [accountId, g] of groups) {
          const account = accountId
            ? await getAccount(tx, ctx.organizationId, accountId)
            : undefined;
          const s = showSums(g, base);
          accounts.push({
            accountId,
            code: account?.code ?? null,
            name: account?.name ?? null,
            net: s.net,
            nonRecoverableTax: s.nonRecoverableTax,
            cost: s.cost,
          });
        }
        accounts.sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
        const t = showSums(totals, base);
        return {
          from: input.from,
          to: input.to,
          baseCurrency: base,
          accounts,
          totals: {
            net: t.net,
            nonRecoverableTax: t.nonRecoverableTax,
            cost: t.cost,
            recoverableTax: t.recoverableTax,
          },
        };
      },
    );
  }

  /**
   * Input tax per code and snapshotted rate (PD5): document-date posted snapshots, never the
   * current tax-code configuration. Review only (R31): not a tax return.
   */
  inputTaxSummary(principal: Principal, input: { from: string; to: string }) {
    this.period(input);
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchasesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const { lines, base } = await this.lines(tx, ctx.organizationId, input);
        const groups = new Map<
          string,
          { taxCodeId: string | null; rate: string | null; sums: Sums }
        >();
        const totals = zeroSums();
        for (const l of lines) {
          const rate = l.taxRate === null ? null : decimal(l.taxRate).toFixed();
          const key = `${l.taxCodeId ?? '-'}|${rate ?? '-'}`;
          const g = groups.get(key) ?? { taxCodeId: l.taxCodeId, rate, sums: zeroSums() };
          groups.set(key, g);
          addLine(g.sums, l);
          addLine(totals, l);
        }
        const codes = [];
        for (const g of groups.values()) {
          const code = g.taxCodeId
            ? await getTaxCode(tx, ctx.organizationId, g.taxCodeId)
            : undefined;
          const s = showSums(g.sums, base);
          codes.push({
            taxCodeId: g.taxCodeId,
            code: code?.code ?? null,
            rate: g.rate,
            taxable: s.net,
            recoverableTax: s.recoverableTax,
            nonRecoverableTax: s.nonRecoverableTax,
            tax: s.tax,
          });
        }
        codes.sort((a, b) =>
          a.taxCodeId === null
            ? 1
            : b.taxCodeId === null
              ? -1
              : (a.code ?? '').localeCompare(b.code ?? '') ||
                decimal(a.rate ?? 0).comparedTo(decimal(b.rate ?? 0)),
        );
        const t = showSums(totals, base);
        return {
          from: input.from,
          to: input.to,
          baseCurrency: base,
          reviewOnly: true,
          codes,
          totals: {
            taxable: t.net,
            recoverableTax: t.recoverableTax,
            nonRecoverableTax: t.nonRecoverableTax,
            tax: t.tax,
          },
        };
      },
    );
  }

  /**
   * Vendor payments by date (PD6–PD8, PD11): RECORDED and VOID payments with their own
   * allocations and realized FX; voided ones keep their date and are excluded from the totals.
   * Refunds are a separate section. At most 2,000 rows, payments and refunds combined, in one
   * deterministic order (PD8); `truncated` says when more exist, and the summaries then cover only
   * the rows returned.
   */
  paymentRegister(
    principal: Principal,
    input: RegisterInput,
    // Tests only: the route always uses PD8's 2,000 rows.
    options: { limit?: number } = {},
  ) {
    const limit = options.limit ?? PAYMENT_REGISTER_LIMIT;
    this.period(input);
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchasesPermissions.ReportsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        await this.requireVendor(tx, ctx.organizationId, input.vendorId);
        if (
          input.paymentAccountId &&
          !(await getAccount(tx, ctx.organizationId, input.paymentAccountId))
        ) {
          throw new NotFoundError('Account not found.');
        }
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const base = accounting.baseCurrency;
        const filter = {
          organizationId: ctx.organizationId,
          from: input.from,
          to: input.to,
          vendorId: input.vendorId ?? null,
          paymentAccountId: input.paymentAccountId ?? null,
          currencyCode: input.currencyCode ?? null,
        };
        // PD8: one cap over payments and refunds together, in register order.
        const { payments, refunds, truncated } = limitRegister(
          await registerPayments(tx, filter, limit),
          await registerRefunds(tx, filter, limit),
          limit,
        );
        const names = new Map<string, string | null>();
        const accounts = new Map<string, { code: string; name: string } | null>();
        const lookup = async (vendorId: string, accountId: string) => {
          if (!names.has(vendorId))
            names.set(vendorId, await vendorName(tx, ctx.organizationId, vendorId));
          if (!accounts.has(accountId)) {
            const a = await getAccount(tx, ctx.organizationId, accountId);
            accounts.set(accountId, a ? { code: a.code, name: a.name } : null);
          }
          return {
            vendorName: names.get(vendorId) ?? null,
            account: accounts.get(accountId) ?? null,
          };
        };
        const subtotal = (
          rows: readonly {
            status: string;
            accountId: string;
            currencyCode: string;
            amount: string;
            baseAmount: string;
            fx: string;
          }[],
        ) => {
          const groups = new Map<
            string,
            {
              accountId: string;
              currencyCode: string;
              count: number;
              amount: Decimal;
              base: Decimal;
              fx: Decimal;
            }
          >();
          let baseTotal = decimal(0);
          let count = 0;
          let voided = 0;
          for (const r of rows) {
            if (r.status !== 'RECORDED') {
              voided += 1;
              continue;
            }
            const key = `${r.accountId}|${r.currencyCode}`;
            const g = groups.get(key) ?? {
              accountId: r.accountId,
              currencyCode: r.currencyCode,
              count: 0,
              amount: decimal(0),
              base: decimal(0),
              fx: decimal(0),
            };
            groups.set(key, g);
            g.count += 1;
            g.amount = g.amount.plus(decimal(r.amount));
            g.base = g.base.plus(decimal(r.baseAmount));
            g.fx = g.fx.plus(decimal(r.fx));
            baseTotal = baseTotal.plus(decimal(r.baseAmount));
            count += 1;
          }
          return {
            subtotals: [...groups.values()].map((g) => ({
              accountId: g.accountId,
              account: accounts.get(g.accountId) ?? null,
              currencyCode: g.currencyCode,
              count: g.count,
              amount: g.amount.toFixed(minorUnits(g.currencyCode)),
              baseAmount: g.base.toFixed(minorUnits(base)),
              realizedFx: g.fx.toFixed(minorUnits(base)),
            })),
            totals: { count, voided, baseAmount: baseTotal.toFixed(minorUnits(base)) },
          };
        };
        const paymentRows = [];
        for (const p of payments) {
          const { vendorName: name, account } = await lookup(p.vendorId, p.paymentAccountId);
          const places = minorUnits(p.currencyCode);
          paymentRows.push({
            id: p.id,
            number: p.number,
            status: p.status,
            paymentDate: p.paymentDate,
            vendorId: p.vendorId,
            vendorName: name,
            paymentAccountId: p.paymentAccountId,
            account,
            paymentBatchId: p.paymentBatchId,
            currencyCode: p.currencyCode,
            amount: decimal(p.amount).toFixed(places),
            exchangeRate: decimal(p.exchangeRate).toFixed(),
            exchangeRateSource: p.exchangeRateSource,
            baseAmount: decimal(p.baseAmount).toFixed(minorUnits(base)),
            appliedToBills: decimal(p.appliedToBills).toFixed(places),
            prepayment: decimal(p.prepayment).toFixed(places),
            realizedFx: decimal(p.realizedFx).toFixed(minorUnits(base)),
            voidedAt: p.voidedAt,
          });
        }
        const refundRows = [];
        for (const r of refunds) {
          const { vendorName: name, account } = await lookup(r.vendorId, r.refundAccountId);
          refundRows.push({
            id: r.id,
            number: r.number,
            status: r.status,
            refundDate: r.refundDate,
            vendorId: r.vendorId,
            vendorName: name,
            refundAccountId: r.refundAccountId,
            account,
            sourceType: r.sourceType,
            sourceId: r.sourceId,
            sourceNumber: r.sourceNumber,
            currencyCode: r.currencyCode,
            amount: decimal(r.amount).toFixed(minorUnits(r.currencyCode)),
            exchangeRate: decimal(r.exchangeRate).toFixed(),
            baseAmount: decimal(r.baseAmount).toFixed(minorUnits(base)),
            realizedFx: decimal(r.fxDifference).toFixed(minorUnits(base)),
            voidedAt: r.voidedAt,
          });
        }
        return {
          from: input.from,
          to: input.to,
          baseCurrency: base,
          limit,
          truncated,
          payments: paymentRows,
          paymentSummary: subtotal(
            paymentRows.map((p) => ({
              status: p.status,
              accountId: p.paymentAccountId,
              currencyCode: p.currencyCode,
              amount: p.amount,
              baseAmount: p.baseAmount,
              fx: p.realizedFx,
            })),
          ),
          refunds: refundRows,
          refundSummary: subtotal(
            refundRows.map((r) => ({
              status: r.status,
              accountId: r.refundAccountId,
              currencyCode: r.currencyCode,
              amount: r.amount,
              baseAmount: r.baseAmount,
              fx: r.realizedFx,
            })),
          ),
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // PD6: S9 revaluation exposure provider `purchases.payables` (read-only)
  // ---------------------------------------------------------------------------

  async listExposures(
    tx: Transaction,
    input: { organizationId: string; revaluationDate: string; baseCurrency: string },
  ): Promise<DocumentExposure[]> {
    const purchases = await getPurchasesSettings(tx, input.organizationId);
    if (!purchases?.apAccountId) return [];
    const apAccountId = purchases.apAccountId;
    const filter = { organizationId: input.organizationId, asOf: input.revaluationDate };
    const foreign = <T extends { currencyCode: string }>(rows: T[]) =>
      rows.filter((r) => r.currencyCode !== input.baseCurrency);
    const bills = foreign(await openBillsAsOf(tx, filter));
    const credits = foreign(await openCreditsAsOf(tx, filter));
    return [
      // A bill is a credit balance on the AP control account (debit-positive convention).
      ...bills.map((b): DocumentExposure => ({
        documentModule: 'purchases',
        documentType: 'bill',
        documentId: b.id,
        controlAccountId: apAccountId,
        currency: b.currencyCode,
        foreignBalance: decimal(b.openAmount).negated().toFixed(4),
        carryingBase: decimal(b.openBase).negated().toFixed(4),
      })),
      // Unapplied vendor credits and prepayments are vendor debit balances.
      ...credits.map((c): DocumentExposure => ({
        documentModule: 'purchases',
        documentType: c.type,
        documentId: c.id,
        controlAccountId: apAccountId,
        currency: c.currencyCode,
        foreignBalance: decimal(c.openAmount).toFixed(4),
        carryingBase: decimal(c.openBase).toFixed(4),
      })),
    ];
  }
}
