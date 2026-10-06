import type { Decimal } from 'decimal.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { isValidIsoDate } from '../modules/accounting/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  apControlBalance,
  getPurchasesSettings,
  openBillsAsOf,
  openPrepaymentsAsOf,
  openVendorCreditsAsOf,
  PurchasesPermissions,
  vendorActivity,
  type OpenBill,
  type OpenVendorCredit,
} from '../modules/purchases/index.js';
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
