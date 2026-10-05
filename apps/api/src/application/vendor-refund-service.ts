import { randomUUID } from 'node:crypto';
import type { Decimal } from 'decimal.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal, minorUnits, parseAmount, parseRate } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  getAccount,
  getDesignatedAccountId,
  isValidIsoDate,
  type SystemJournalLineInput,
} from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { settleRefund } from '../modules/documents/index.js';
import { getParty, partyIdsMatching } from '../modules/parties/index.js';
import {
  adjustVendorCreditBalance,
  getPayment,
  getPurchasesSettings,
  getRefund,
  getVendorCredit,
  insertRefund,
  listRefunds,
  refundNumberExists,
  takeNextPurchaseNumber,
  updatePayment,
  updateRefund,
  VendorCreditPermissions,
  VendorPaymentPermissions,
  type PurchasesSettings,
  type Refund,
  type RefundStatus,
} from '../modules/purchases/index.js';
import { getVendor, vendorIdsOfParties } from '../modules/vendors/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import {
  hasPermission,
  requirePermission,
  type AuthorizationContext,
  type Principal,
} from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import { assertOpenPeriod } from './sales-documents.js';
import { resolveSettlementRate, settlementAccountProblem } from './vendor-payment-service.js';

/**
 * Vendor refunds (Phase 4B-3; ADR 0004 P4-24, P4-30, P4-33, P4-34, P4-42, P4-51; decisions of
 * 2026-10-05). A refund is a separate accounting transaction — not a payment or allocation
 * reversal: the vendor pays back part of an open vendor debit balance on AP, either a recorded
 * payment's unallocated prepayment or a posted vendor credit's unapplied amount. It never touches
 * bills or bill allocations.
 *
 * Recording (`vendor_payments.create`, plus `vendor_credits.view` for a credit source; no
 * re-authentication, P4-42) locks the source, fixes the rate (the table rate on the refund date or
 * a manual override with a mandatory reason, the table rate kept), takes the VR- number and posts
 * through `purchases.refund_recorded`: Dr the refund account (bank or cash only) at the refund
 * rate / Cr AP for the source's historical base released / one net base-only realized-FX line,
 * fx = base received − base released (positive = gain). Partial and multiple refunds are allowed
 * up to the source's open balance. Void (`vendor_payments.void`, re-authenticated) reverses the
 * journal through the Purchases reversal and restores the source's exact amount and base.
 */

export const REFUND_RECORDED_EVENT = 'purchases.refund_recorded';
const RESOURCE = 'purchases_refund';

export interface RefundInput {
  sourceType: 'payment' | 'vendor_credit';
  sourceId: string;
  refundDate: string;
  amount: string;
  /** Overrides the Purchases default payment account; bank or cash only. */
  refundAccountId?: string | null | undefined;
  /** Overrides the table rate; needs a reason. */
  rateOverride?: string | null | undefined;
  rateOverrideReason?: string | null | undefined;
  reference?: string | null | undefined;
  memo?: string | undefined;
}

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const fixed = (value: Decimal) => value.toFixed(4);
const shown = (value: string, currency: string) => decimal(value).toFixed(minorUnits(currency));

function encodeCursor(refund: Refund) {
  return Buffer.from(JSON.stringify({ d: refund.refundDate, i: refund.id })).toString('base64url');
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

export class VendorRefundService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
  ) {
    // The journal a refund posts; Purchases owns the authorization (Decision 13).
    journals.registerEventHandler(
      REFUND_RECORDED_EVENT,
      (event) => event.payload.journal as never,
      {
        domainApproval: true,
      },
    );
  }

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    refundId: string,
    now: Date,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: RESOURCE,
      resourceId: refundId,
      metadata,
      origin,
    });
  }

  private requireAp(purchases: PurchasesSettings | undefined) {
    if (!purchases?.apAccountId) {
      throw new ValidationError([
        {
          path: 'apAccountId',
          message: 'Choose the AP control account in Purchases settings first.',
        },
      ]);
    }
    return purchases as PurchasesSettings & { apAccountId: string };
  }

  /**
   * Locks a refund source (the source comes before refunds in the frozen lock order) and
   * describes its open vendor debit balance. A vendor-credit source needs `vendor_credits.view`.
   */
  private async lockSource(
    tx: Transaction,
    ctx: AuthorizationContext,
    source: { type: 'payment' | 'vendor_credit'; id: string },
  ) {
    if (source.type === 'payment') {
      const payment = await getPayment(tx, ctx.organizationId, source.id, { forUpdate: true });
      if (!payment) throw new NotFoundError('Payment not found.');
      return {
        type: 'payment' as const,
        id: payment.id,
        number: payment.number,
        vendorId: payment.vendorId,
        currencyCode: payment.currencyCode,
        date: payment.paymentDate,
        open: payment.status === 'RECORDED',
        balance: {
          amountDue: decimal(payment.amountUnallocated ?? '0'),
          baseDue: decimal(payment.baseUnallocated ?? '0'),
        },
      };
    }
    requirePermission(ctx, VendorCreditPermissions.View);
    const credit = await getVendorCredit(tx, ctx.organizationId, source.id, { forUpdate: true });
    if (!credit) throw new NotFoundError('Vendor credit not found.');
    return {
      type: 'vendor_credit' as const,
      id: credit.id,
      number: credit.number,
      vendorId: credit.vendorId,
      currencyCode: credit.currencyCode,
      date: credit.creditDate,
      open: credit.status === 'POSTED',
      balance: {
        amountDue: decimal(credit.amountUnapplied ?? '0'),
        baseDue: decimal(credit.baseUnapplied ?? '0'),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private summary(refund: Refund, name: string | null) {
    const c = refund.currencyCode;
    return {
      id: refund.id,
      status: refund.status,
      number: refund.number,
      vendorId: refund.vendorId,
      vendorName: name,
      sourceType: refund.sourceType,
      sourceId: refund.paymentId ?? refund.vendorCreditId!,
      refundDate: refund.refundDate,
      currencyCode: c,
      amount: shown(refund.amount, c),
      baseAmount: refund.baseAmount,
      reference: refund.reference,
      version: refund.version,
      voidedAt: refund.voidedAt?.toISOString() ?? null,
    };
  }

  private async detail(tx: Transaction, ctx: AuthorizationContext, id: string) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const refund = await getRefund(tx, ctx.organizationId, id);
    if (!refund) throw new NotFoundError('Refund not found.');
    if (refund.sourceType === 'vendor_credit') {
      requirePermission(ctx, VendorCreditPermissions.View);
    }
    const sourceNumber = refund.paymentId
      ? ((await getPayment(tx, ctx.organizationId, refund.paymentId))?.number ?? null)
      : ((await getVendorCredit(tx, ctx.organizationId, refund.vendorCreditId!))?.number ?? null);
    return {
      ...this.summary(refund, await vendorName(tx, ctx.organizationId, refund.vendorId)),
      sourceNumber,
      refundAccountId: refund.refundAccountId,
      refundAccountOverridden: refund.refundAccountOverridden,
      exchangeRate: refund.exchangeRate,
      exchangeRateSource: refund.exchangeRateSource,
      tableRate: refund.tableRate,
      rateOverrideReason: refund.rateOverrideReason,
      baseReleased: refund.baseReleased,
      fxDifference: refund.fxDifference,
      memo: refund.memo,
      journalId: refund.journalId,
      voidReason: refund.voidReason,
      voidJournalId: refund.voidJournalId,
      baseCurrency: accounting.baseCurrency,
    };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(
    principal: Principal,
    query: {
      status?: RefundStatus[] | undefined;
      vendorId?: string | undefined;
      paymentId?: string | undefined;
      vendorCreditId?: string | undefined;
      search?: string | undefined;
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.View },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const canCredits = hasPermission(ctx, VendorCreditPermissions.View);
        if (query.vendorCreditId) requirePermission(ctx, VendorCreditPermissions.View);
        const search = query.search?.trim() || null;
        const page = await listRefunds(tx, {
          organizationId: ctx.organizationId,
          statuses: query.status?.length ? query.status : null,
          vendorId: query.vendorId ?? null,
          paymentId: query.paymentId ?? null,
          vendorCreditId: query.vendorCreditId ?? null,
          includeCreditSources: canCredits,
          search,
          vendorIdsIn: search
            ? vendorIdsOfParties(ctx.organizationId, partyIdsMatching(ctx.organizationId, search))
            : undefined,
          limit: query.limit,
          after: query.after ? decodeCursor(query.after) : null,
        });
        const names = new Map<string, string | null>();
        for (const id of new Set(page.items.map((r) => r.vendorId))) {
          names.set(id, await vendorName(tx, ctx.organizationId, id));
        }
        const last = page.items.at(-1);
        return {
          items: page.items.map((r) => this.summary(r, names.get(r.vendorId) ?? null)),
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
  // Record (P4-30)
  // ---------------------------------------------------------------------------

  /** Records a refund at once (no draft, no approval); retry-safe with an Idempotency-Key. */
  record(
    principal: Principal,
    input: RefundInput,
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
          { key: options.idempotencyKey, scope: 'purchases.refund.record', request: input },
          () => this.recordInTransaction(tx, ctx, input, origin),
        ),
    );
  }

  private async recordInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: RefundInput,
    origin: EventOrigin,
  ) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const purchases = this.requireAp(await getPurchasesSettings(tx, ctx.organizationId));
    if (!isValidIsoDate(input.refundDate)) {
      throw new ValidationError([
        { path: 'refundDate', message: 'Enter a valid date (YYYY-MM-DD).' },
      ]);
    }
    const source = await this.lockSource(tx, ctx, { type: input.sourceType, id: input.sourceId });
    if (!source.open) {
      throw invalidState(
        source.type === 'payment'
          ? 'Only a recorded payment can be refunded.'
          : 'Only a posted vendor credit can be refunded.',
      );
    }
    const issues: ValidationIssue[] = [];
    const currencyCode = source.currencyCode;
    if (source.balance.amountDue.lte(0)) {
      issues.push({
        path: 'sourceId',
        message:
          source.type === 'payment'
            ? 'The payment has no prepayment left to refund.'
            : 'The vendor credit has nothing left to refund.',
      });
    }
    if (input.refundDate < source.date) {
      issues.push({
        path: 'refundDate',
        message: 'A refund cannot be dated before the payment or credit it refunds.',
      });
    }
    const amount = parseAmount(input.amount, currencyCode);
    if (!amount.ok) {
      issues.push({
        path: 'amount',
        message:
          amount.problem === 'too_many_decimals'
            ? `Use at most ${minorUnits(currencyCode)} decimal places.`
            : 'Enter an amount greater than zero.',
      });
    } else if (amount.value.gt(source.balance.amountDue) && source.balance.amountDue.gt(0)) {
      issues.push({
        path: 'amount',
        message: `Only ${source.balance.amountDue.toFixed(minorUnits(currencyCode))} ${currencyCode} is available to refund.`,
      });
    }
    // Refund account: bank or cash only (4B-3 amendment), in the source or base currency.
    const accountId = input.refundAccountId ?? purchases.defaultPaymentAccountId;
    if (!accountId) {
      issues.push({
        path: 'refundAccountId',
        message:
          'Choose a refund account or set the default payment account in Purchases settings.',
      });
    } else {
      const problem = settlementAccountProblem(
        await getAccount(tx, ctx.organizationId, accountId),
        currencyCode,
        accounting.baseCurrency,
        'refund',
      );
      if (problem) issues.push({ path: 'refundAccountId', message: problem });
    }
    // Rate (P4-27 parity): a manual rate needs a reason; base-currency refunds have none.
    const rateOverride = input.rateOverride ?? null;
    const rateOverrideReason = input.rateOverrideReason?.trim() || null;
    if (rateOverride !== null) {
      if (currencyCode === accounting.baseCurrency) {
        issues.push({
          path: 'rateOverride',
          message: 'A base-currency refund has no exchange rate to override.',
        });
      } else if (!parseRate(rateOverride).ok) {
        issues.push({
          path: 'rateOverride',
          message: 'Rates are positive decimals with at most 10 decimal places.',
        });
      }
      if (!rateOverrideReason) {
        issues.push({
          path: 'rateOverrideReason',
          message: 'Give a reason for overriding the rate.',
        });
      }
    } else if (rateOverrideReason) {
      issues.push({ path: 'rateOverride', message: 'Enter the manual rate the reason is for.' });
    }
    if (issues.length) throw new ValidationError(issues, 'The refund cannot be recorded.');
    await assertOpenPeriod(tx, ctx.organizationId, input.refundDate);
    const rate = (await resolveSettlementRate(
      tx,
      ctx.organizationId,
      accounting,
      {
        currencyCode,
        date: input.refundDate,
        rateOverride: rateOverride === null ? null : decimal(rateOverride).toFixed(10),
      },
      true,
    ))!;

    // Settlement: received at the refund rate, released at the source's historical base.
    const value = amount.ok ? amount.value : decimal(0);
    const settled = settleRefund({
      amount: value,
      rate: rate.rate,
      baseCurrency: accounting.baseCurrency,
      source: source.balance,
    });
    let fxAccountId: string | null = null;
    if (!settled.fx.isZero()) {
      fxAccountId =
        (await getDesignatedAccountId(tx, ctx.organizationId, 'REALIZED_FX_GAIN_LOSS')) ?? null;
      if (!fxAccountId) {
        throw new AppError(
          'DESIGNATION_REQUIRED',
          409,
          'Designate a Realized FX gain/loss account under Accounting before refunding at a different rate.',
        );
      }
    }
    const number = await this.nextNumber(tx, ctx.organizationId);
    const party = await getParty(
      tx,
      ctx.organizationId,
      (await getVendor(tx, ctx.organizationId, source.vendorId))!.partyId,
    );
    const label = `Refund ${number}`;
    const lines: SystemJournalLineInput[] = [
      {
        accountId: accountId!,
        description: `${label} — ${party?.displayName ?? ''}`.slice(0, 500),
        kind: 'normal',
        debit: fixed(value),
        credit: null,
        baseDebit: fixed(settled.baseReceived),
        baseCredit: null,
      },
      {
        accountId: purchases.apAccountId,
        description: `${label} — from ${source.number ?? ''}`,
        kind: 'normal',
        debit: null,
        credit: fixed(value),
        baseDebit: null,
        baseCredit: fixed(settled.baseReleased),
      },
    ];
    if (!settled.fx.isZero()) {
      // One net base-only line (C1 parity): a gain is a base credit, a loss a base debit.
      lines.push({
        accountId: fxAccountId!,
        description: `Realized FX — ${label}`,
        kind: 'base_only',
        debit: null,
        credit: null,
        baseDebit: settled.fx.isNegative() ? fixed(settled.fx.negated()) : null,
        baseCredit: settled.fx.isPositive() ? fixed(settled.fx) : null,
      });
    }
    const id = randomUUID();
    const foreign = currencyCode !== accounting.baseCurrency;
    const description = `${label} — ${party?.displayName ?? ''}`.slice(0, 500);
    const journal = settled.fx.isZero()
      ? {
          entryDate: input.refundDate,
          description,
          reference: input.reference?.trim() || number,
          currency: currencyCode,
          exchangeRate: foreign ? rate.rate.toFixed(10) : null,
          ...(foreign ? { exchangeRateSource: rate.source === 'table' ? 'table' : 'manual' } : {}),
          sourceRef: { module: 'purchases', type: 'refund', id },
          lines: lines.map((l) => ({
            accountId: l.accountId,
            description: l.description,
            debit: l.debit,
            credit: l.credit,
          })),
        }
      : {
          system: {
            source: { module: 'purchases', type: 'realized_fx', id },
            entryDate: input.refundDate,
            description,
            reference: input.reference?.trim() || number,
            currency: currencyCode,
            exchangeRate: foreign ? rate.rate.toFixed(10) : null,
            exchangeRateSource: rate.source === 'table' ? ('table' as const) : ('manual' as const),
            lines,
          },
        };
    const now = this.now;
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'purchases',
      eventType: REFUND_RECORDED_EVENT,
      eventKey: `refund:${id}:recorded`,
      payload: { refundId: id, number, journal },
      occurredAt: now,
      origin,
    });
    if (!event.journalId) {
      throw new AppError('CONFLICT', 409, 'The refund was not recorded; try again.');
    }
    const overridden = accountId !== purchases.defaultPaymentAccountId;
    const refund = await insertRefund(tx, {
      id,
      organizationId: ctx.organizationId,
      number,
      vendorId: source.vendorId,
      sourceType: source.type,
      paymentId: source.type === 'payment' ? source.id : null,
      vendorCreditId: source.type === 'vendor_credit' ? source.id : null,
      refundDate: input.refundDate,
      currencyCode,
      amount: fixed(value),
      refundAccountId: accountId!,
      refundAccountOverridden: overridden,
      exchangeRate: rate.rate.toFixed(10),
      exchangeRateSource: rate.source,
      tableRate: rate.tableRate ? rate.tableRate.toFixed(10) : null,
      rateOverrideReason: rate.source === 'manual' ? rateOverrideReason : null,
      baseAmount: fixed(settled.baseReceived),
      baseReleased: fixed(settled.baseReleased),
      fxDifference: fixed(settled.fx),
      reference: input.reference?.trim() || null,
      memo: input.memo?.trim() ?? '',
      journalId: event.journalId,
      accountingEventId: event.eventId,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedByUserId: ctx.userId,
      updatedAt: now,
    });
    await this.adjustSource(tx, ctx, source, value.negated(), settled.baseReleased.negated(), now);
    if (rate.source === 'manual') {
      await this.audit(tx, ctx, 'vendor_refund.rate_overridden', id, now, origin, {
        currencyCode,
        rate: refund.exchangeRate,
        tableRate: refund.tableRate,
        reason: refund.rateOverrideReason,
      });
    }
    if (overridden) {
      await this.audit(tx, ctx, 'vendor_refund.account_overridden', id, now, origin, {
        refundAccountId: accountId,
        defaultPaymentAccountId: purchases.defaultPaymentAccountId,
      });
    }
    await this.audit(tx, ctx, 'vendor_refund.recorded', id, now, origin, {
      number,
      sourceType: source.type,
      sourceId: source.id,
      amount: refund.amount,
      currencyCode,
      exchangeRate: refund.exchangeRate,
      exchangeRateSource: refund.exchangeRateSource,
      baseAmount: refund.baseAmount,
      baseReleased: refund.baseReleased,
      realizedFx: refund.fxDifference,
      journalId: event.journalId,
    });
    return this.detail(tx, ctx, id);
  }

  /** Changes the source's open balance by exactly the refund's amount and released base. */
  private async adjustSource(
    tx: Transaction,
    ctx: AuthorizationContext,
    source: Awaited<ReturnType<VendorRefundService['lockSource']>>,
    amount: Decimal,
    base: Decimal,
    now: Date,
  ) {
    const updated =
      source.type === 'payment'
        ? await updatePayment(tx, {
            organizationId: ctx.organizationId,
            id: source.id,
            from: 'RECORDED',
            set: {
              amountUnallocated: fixed(source.balance.amountDue.plus(amount)),
              baseUnallocated: fixed(source.balance.baseDue.plus(base)),
              updatedByUserId: ctx.userId,
              updatedAt: now,
            },
          })
        : await adjustVendorCreditBalance(tx, {
            organizationId: ctx.organizationId,
            vendorCreditId: source.id,
            amount: fixed(amount),
            base: fixed(base),
            now,
            userId: ctx.userId,
          });
    if (!updated) throw invalidState('The refunded document changed meanwhile; try again.');
  }

  private async nextNumber(tx: Transaction, organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const taken = await takeNextPurchaseNumber(tx, organizationId, 'vendor_refund');
      if (!taken) {
        throw new ValidationError([
          { path: 'numbering', message: 'Save the Purchases settings before recording refunds.' },
        ]);
      }
      if (!(await refundNumberExists(tx, organizationId, taken.number))) return taken.number;
    }
    throw new AppError(
      'CONFLICT',
      409,
      'Could not find a free refund number; check the numbering.',
    );
  }

  // ---------------------------------------------------------------------------
  // Void (P4-30, P4-42)
  // ---------------------------------------------------------------------------

  /**
   * Voids a recorded refund: reverses its journal through the Purchases reversal on its date
   * (realized-FX system journals are mirrored, never reversed generically) and restores the
   * source's exact amount and base. Needs `vendor_payments.void` and a recent password
   * confirmation. The source is locked before the refund (the frozen lock order).
   */
  void(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.Void, sensitive: true },
      async (tx, ctx) => {
        const peek = await getRefund(tx, ctx.organizationId, id);
        if (!peek) throw new NotFoundError('Refund not found.');
        const source = await this.lockSource(tx, ctx, {
          type: peek.sourceType,
          id: peek.paymentId ?? peek.vendorCreditId!,
        });
        const refund = await getRefund(tx, ctx.organizationId, id, { forUpdate: true });
        if (!refund) throw new NotFoundError('Refund not found.');
        if (refund.version !== input.version) {
          throw new ConflictError(
            'VERSION_CONFLICT',
            'The refund changed; reload it and try again.',
          );
        }
        if (refund.status !== 'RECORDED') throw invalidState('The refund is already void.');
        if (!source.open) {
          throw invalidState('The refunded payment or vendor credit is no longer open.');
        }
        const reason = input.reason.trim();
        const reversal = await this.journals.reverseSubledgerJournalInTransaction(
          tx,
          ctx,
          'purchases',
          refund.journalId,
          { reason: `Refund ${refund.number} voided: ${reason}` },
          origin,
        );
        const now = this.now;
        await this.adjustSource(
          tx,
          ctx,
          source,
          decimal(refund.amount),
          decimal(refund.baseReleased),
          now,
        );
        const voided = await updateRefund(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'VOID',
            voidedByUserId: ctx.userId,
            voidedAt: now,
            voidReason: reason,
            voidJournalId: reversal.id,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!voided) throw invalidState('The refund changed while voiding; try again.');
        await this.audit(tx, ctx, 'vendor_refund.voided', id, now, origin, {
          number: refund.number,
          reason,
          reversalJournalId: reversal.id,
          sourceType: refund.sourceType,
          sourceId: source.id,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }
}
