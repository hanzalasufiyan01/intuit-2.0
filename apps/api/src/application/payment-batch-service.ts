import {
  AppError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { isValidIsoDate } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  getPaymentBatch,
  getPurchasesSettings,
  insertPaymentBatch,
  listBatchPayments,
  listPayableBills,
  listPaymentBatches,
  lockBills,
  VendorPaymentPermissions,
  type Bill,
  type PaymentBatch,
} from '../modules/purchases/index.js';
import { getVendor } from '../modules/vendors/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import { withOrganization } from './organization-service.js';
import { MAX_PAYMENT_BILLS, type VendorPaymentService } from './vendor-payment-service.js';

/**
 * Batch "Pay bills" (Phase 4B-4; ADR 0004 P4-32, P4-50; decisions D1-D9 of 2026-10-05). An
 * orchestration over the 4B-2 payment pipeline: the selected posted bills are grouped by vendor
 * and currency, and each group becomes exactly one payment — a draft created and recorded through
 * `VendorPaymentService` (its own validation, approval re-check, rate, settlement, C1 net FX,
 * accounting event, journal, PAY- number and source link). The batch posts nothing itself and
 * writes no payment, allocation or ledger table directly.
 *
 * Everything happens in one transaction under one idempotency key
 * (`purchases.payment_batch.record`): any failure rolls back every payment, event, journal,
 * allocation and the batch record. Lock order: the Purchases settings row, then every selected
 * bill in ascending id order, then the groups. If any payment would need approval, the whole batch
 * is refused before anything is recorded (D3). No excess or prepayment (D7), no credit application
 * (D8), no batch number (D9). Recording needs `vendor_payments.create` and no re-authentication.
 */

export const MAX_BATCH_VENDORS = 100;
export const MAX_BATCH_BILLS = 2000;
const RESOURCE = 'purchases_payment_batch';

export interface PaymentBatchInput {
  paymentDate: string;
  /** Payment account per currency (default: the Purchases default payment account). */
  accounts?: { currencyCode: string; paymentAccountId: string }[] | undefined;
  /** Manual rate per currency, with a mandatory reason (P4-27). */
  rateOverrides?: { currencyCode: string; rate: string; reason: string }[] | undefined;
  reference?: string | null | undefined;
  memo?: string | undefined;
  bills: { billId: string; amount: string }[];
}

interface Group {
  vendorId: string;
  currencyCode: string;
  /** The positions of the group's bills in the request. */
  entries: { index: number; billId: string; amount: string }[];
}

function encodeCursor(batch: PaymentBatch) {
  return Buffer.from(JSON.stringify({ d: batch.paymentDate, i: batch.id })).toString('base64url');
}

function decodeCursor(cursor: string): { date: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      d?: unknown;
      i?: unknown;
    };
    if (
      typeof parsed.d === 'string' &&
      isValidIsoDate(parsed.d) &&
      typeof parsed.i === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed.i)
    ) {
      return { date: parsed.d, id: parsed.i };
    }
  } catch {
    // fall through
  }
  throw new ValidationError([{ path: 'after', message: 'Invalid cursor.' }]);
}

async function vendorName(tx: Transaction, organizationId: string, vendorId: string) {
  const vendor = await getVendor(tx, organizationId, vendorId);
  const party = vendor ? await getParty(tx, organizationId, vendor.partyId) : undefined;
  return party?.displayName ?? null;
}

export class PaymentBatchService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly payments: VendorPaymentService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** Open posted bills across vendors to choose from (earliest due first). */
  payableBills(
    principal: Principal,
    query: {
      vendorId?: string | undefined;
      currencyCode?: string | undefined;
      dueBefore?: string | undefined;
      limit: number;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.Create },
      async (tx, ctx) => {
        const bills = await listPayableBills(tx, {
          organizationId: ctx.organizationId,
          vendorId: query.vendorId ?? null,
          currencyCode: query.currencyCode ?? null,
          dueBefore: query.dueBefore ?? null,
          limit: query.limit,
        });
        const names = new Map<string, string | null>();
        for (const id of new Set(bills.map((b) => b.vendorId))) {
          names.set(id, await vendorName(tx, ctx.organizationId, id));
        }
        return bills.map((b) => ({
          id: b.id,
          number: b.number,
          vendorId: b.vendorId,
          vendorName: names.get(b.vendorId) ?? null,
          vendorReference: b.vendorReference,
          billDate: b.billDate,
          dueDate: b.dueDate,
          currencyCode: b.currencyCode,
          total: decimal(b.total).toFixed(minorUnits(b.currencyCode)),
          amountDue: decimal(b.amountDue!).toFixed(minorUnits(b.currencyCode)),
        }));
      },
    );
  }

  private summary(batch: PaymentBatch) {
    return {
      id: batch.id,
      paymentDate: batch.paymentDate,
      paymentCount: batch.paymentCount,
      billCount: batch.billCount,
      totals: batch.totals,
      reference: batch.reference,
      createdAt: batch.createdAt.toISOString(),
      createdByUserId: batch.createdByUserId,
    };
  }

  private async detail(tx: Transaction, ctx: AuthorizationContext, id: string) {
    const batch = await getPaymentBatch(tx, ctx.organizationId, id);
    if (!batch) throw new NotFoundError('Payment batch not found.');
    const payments = await listBatchPayments(tx, ctx.organizationId, id);
    const names = new Map<string, string | null>();
    for (const vendorId of new Set(payments.map((p) => p.vendorId))) {
      names.set(vendorId, await vendorName(tx, ctx.organizationId, vendorId));
    }
    return {
      ...this.summary(batch),
      memo: batch.memo,
      payments: payments.map((p) => ({
        id: p.id,
        number: p.number,
        status: p.status,
        vendorId: p.vendorId,
        vendorName: names.get(p.vendorId) ?? null,
        currencyCode: p.currencyCode,
        amount: decimal(p.amount).toFixed(minorUnits(p.currencyCode)),
        baseAmount: p.baseAmount,
        exchangeRate: p.exchangeRate,
        exchangeRateSource: p.exchangeRateSource,
        paymentAccountId: p.paymentAccountId,
        journalId: p.journalId,
        voidedAt: p.voidedAt?.toISOString() ?? null,
      })),
    };
  }

  list(principal: Principal, query: { limit: number; after?: string | undefined }) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.View },
      async (tx, ctx) => {
        const page = await listPaymentBatches(tx, {
          organizationId: ctx.organizationId,
          limit: query.limit,
          after: query.after ? decodeCursor(query.after) : null,
        });
        const last = page.items.at(-1);
        return {
          items: page.items.map((b) => this.summary(b)),
          nextCursor: page.hasMore && last ? encodeCursor(last) : null,
        };
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.View },
      (tx, ctx) => this.detail(tx, ctx, id),
    );
  }

  // ---------------------------------------------------------------------------
  // Record (P4-32)
  // ---------------------------------------------------------------------------

  record(
    principal: Principal,
    input: PaymentBatchInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.Create },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'purchases.payment_batch.record', request: input },
          () => this.recordInTransaction(tx, ctx, input, origin),
        ),
    );
  }

  private async recordInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: PaymentBatchInput,
    origin: EventOrigin,
  ) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    if (!isValidIsoDate(input.paymentDate)) {
      throw new ValidationError([
        { path: 'paymentDate', message: 'Enter a valid date (YYYY-MM-DD).' },
      ]);
    }
    const issues: ValidationIssue[] = [];
    if (input.bills.length === 0)
      issues.push({ path: 'bills', message: 'Choose at least one bill.' });
    if (input.bills.length > MAX_BATCH_BILLS) {
      issues.push({
        path: 'bills',
        message: `A batch pays at most ${MAX_BATCH_BILLS} bills.`,
      });
    }
    const seen = new Set<string>();
    input.bills.forEach((b, i) => {
      if (seen.has(b.billId)) {
        issues.push({ path: `bills.${i}.billId`, message: 'Choose each bill once.' });
      }
      seen.add(b.billId);
    });
    const accounts = new Map<string, string>();
    (input.accounts ?? []).forEach((a, i) => {
      if (accounts.has(a.currencyCode)) {
        issues.push({ path: `accounts.${i}.currencyCode`, message: 'One account per currency.' });
      }
      accounts.set(a.currencyCode, a.paymentAccountId);
    });
    const overrides = new Map<string, { rate: string; reason: string }>();
    (input.rateOverrides ?? []).forEach((r, i) => {
      if (overrides.has(r.currencyCode)) {
        issues.push({ path: `rateOverrides.${i}.currencyCode`, message: 'One rate per currency.' });
      }
      overrides.set(r.currencyCode, { rate: r.rate, reason: r.reason });
    });
    if (issues.length) throw new ValidationError(issues, 'The batch cannot be recorded.');

    // 1. The Purchases settings row (every Purchases posting serializes on it), then 2. every
    // selected bill in ascending id order, before any group is processed.
    await getPurchasesSettings(tx, ctx.organizationId, { forUpdate: true });
    const bills = new Map<string, Bill>(
      (await lockBills(tx, ctx.organizationId, [...seen].sort())).map((b) => [b.id, b]),
    );

    // 3. Group by vendor and currency, after re-reading every bill under its lock.
    const groups: Group[] = [];
    const byKey = new Map<string, Group>();
    input.bills.forEach((b, index) => {
      const bill = bills.get(b.billId);
      if (!bill)
        return void issues.push({ path: `bills.${index}.billId`, message: 'Bill not found.' });
      const key = `${bill.vendorId}|${bill.currencyCode}`;
      let group = byKey.get(key);
      if (!group) {
        group = { vendorId: bill.vendorId, currencyCode: bill.currencyCode, entries: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      group.entries.push({ index, billId: b.billId, amount: b.amount });
    });
    const vendors = new Set(groups.map((g) => g.vendorId));
    if (vendors.size > MAX_BATCH_VENDORS) {
      issues.push({
        path: 'bills',
        message: `A batch pays at most ${MAX_BATCH_VENDORS} vendors (P4-50).`,
      });
    }
    groups.forEach((g, n) => {
      if (g.entries.length > MAX_PAYMENT_BILLS) {
        issues.push({
          path: `groups.${n}`,
          message: `A payment settles at most ${MAX_PAYMENT_BILLS} bills (P4-50); this vendor has ${g.entries.length} ${g.currencyCode} bills selected.`,
        });
      }
    });
    const currencies = new Set(groups.map((g) => g.currencyCode));
    (input.accounts ?? []).forEach((a, i) => {
      if (!currencies.has(a.currencyCode)) {
        issues.push({
          path: `accounts.${i}.currencyCode`,
          message: `No selected bill is in ${a.currencyCode}.`,
        });
      }
    });
    (input.rateOverrides ?? []).forEach((r, i) => {
      if (!currencies.has(r.currencyCode)) {
        issues.push({
          path: `rateOverrides.${i}.currencyCode`,
          message: `No selected bill is in ${r.currencyCode}.`,
        });
      }
    });
    if (issues.length) throw new ValidationError(issues, 'The batch cannot be recorded.');

    // Every bill against the single-payment settlement rules (posted, dated on or before the
    // payment, 0 < amount <= amount due), reported at its position in the request.
    for (const group of groups) {
      const groupIssues: ValidationIssue[] = [];
      this.payments.checkTargets(
        bills,
        {
          vendorId: group.vendorId,
          currencyCode: group.currencyCode,
          date: input.paymentDate,
          allocations: group.entries.map((e) => ({ billId: e.billId, amount: e.amount })),
        },
        groupIssues,
      );
      issues.push(...groupIssues.map((issue) => this.remap(issue, group, groups.indexOf(group))));
    }
    if (issues.length) throw new ValidationError(issues, 'The batch cannot be recorded.');

    // D3: approval stays per payment; if any payment would need it, nothing is recorded.
    const amounts = groups.map((g) =>
      g.entries
        .reduce((sum, e) => sum.plus(decimal(e.amount)), decimal(0))
        .toFixed(minorUnits(g.currencyCode)),
    );
    const needsApproval: ValidationIssue[] = [];
    for (const [n, group] of groups.entries()) {
      const override = overrides.get(group.currencyCode);
      const requirement = await this.payments.approvalRequirement(
        tx,
        ctx.organizationId,
        accounting,
        {
          currencyCode: group.currencyCode,
          date: input.paymentDate,
          amount: amounts[n]!,
          rateOverride: override ? override.rate : null,
          settlesBills: true,
        },
      );
      if (requirement.required) {
        const name = (await vendorName(tx, ctx.organizationId, group.vendorId)) ?? group.vendorId;
        needsApproval.push({
          path: `groups.${n}`,
          message: `${name}: ${amounts[n]} ${group.currencyCode} (${requirement.facts.baseAmount} ${requirement.facts.baseCurrency}) needs approval.`,
        });
      }
    }
    if (needsApproval.length) {
      throw new AppError(
        'APPROVAL_REQUIRED',
        409,
        'Some payments in this batch need approval, so nothing was recorded. Remove them and pay them individually through approval.',
        { issues: needsApproval },
      );
    }

    // 4. The batch record, then one draft per group recorded through the payment pipeline.
    const now = this.now;
    const totals = [...currencies].map((currencyCode) => {
      const of = groups
        .map((g, n) => ({ g, amount: amounts[n]! }))
        .filter(({ g }) => g.currencyCode === currencyCode);
      return {
        currencyCode,
        amount: of
          .reduce((sum, x) => sum.plus(decimal(x.amount)), decimal(0))
          .toFixed(minorUnits(currencyCode)),
        payments: of.length,
      };
    });
    const batch = await insertPaymentBatch(tx, {
      organizationId: ctx.organizationId,
      paymentDate: input.paymentDate,
      paymentCount: groups.length,
      billCount: input.bills.length,
      totals,
      reference: input.reference?.trim() || null,
      memo: input.memo?.trim() ?? '',
      createdByUserId: ctx.userId,
      createdAt: now,
    });
    const recorded: { id: string; number: string | null }[] = [];
    for (const [n, group] of groups.entries()) {
      const override = overrides.get(group.currencyCode);
      try {
        const draft = await this.payments.createDraftInTransaction(
          tx,
          ctx,
          {
            vendorId: group.vendorId,
            paymentDate: input.paymentDate,
            currencyCode: group.currencyCode,
            amount: amounts[n]!,
            paymentAccountId: accounts.get(group.currencyCode) ?? null,
            rateOverride: override?.rate ?? null,
            rateOverrideReason: override?.reason ?? null,
            reference: input.reference ?? null,
            memo: input.memo,
            allocations: group.entries.map((e) => ({ billId: e.billId, amount: e.amount })),
          },
          origin,
          { paymentBatchId: batch.id },
        );
        const payment = await this.payments.recordInTransaction(
          tx,
          ctx,
          draft.id,
          { version: draft.version },
          origin,
        );
        recorded.push({ id: payment.id, number: payment.number });
      } catch (error) {
        // Any failure aborts the whole transaction; validation is reported against the batch.
        if (error instanceof ValidationError) {
          throw new ValidationError(
            (error.details?.issues ?? []).map((issue) => this.remap(issue, group, n)),
            'The batch cannot be recorded.',
          );
        }
        throw error;
      }
    }
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'vendor_payment_batch.recorded',
      resourceType: RESOURCE,
      resourceId: batch.id,
      metadata: {
        paymentDate: batch.paymentDate,
        billCount: batch.billCount,
        totals,
        payments: recorded,
      },
      origin,
    });
    return this.detail(tx, ctx, batch.id);
  }

  /** Maps a single-payment issue path to the batch request (bills by position, per currency). */
  private remap(issue: ValidationIssue, group: Group, n: number): ValidationIssue {
    const allocation = /^allocations\.(\d+)(.*)$/.exec(issue.path);
    if (allocation) {
      const entry = group.entries[Number(allocation[1])];
      return { path: `bills.${entry?.index ?? 0}${allocation[2]}`, message: issue.message };
    }
    if (issue.path === 'paymentAccountId') {
      return { path: `accounts.${group.currencyCode}`, message: issue.message };
    }
    if (issue.path === 'rateOverride' || issue.path === 'rateOverrideReason') {
      return { path: `rateOverrides.${group.currencyCode}`, message: issue.message };
    }
    return { path: `groups.${n}.${issue.path}`, message: issue.message };
  }
}
