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
import { getCustomer } from '../modules/customers/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  adjustCreditNoteBalance,
  customerRefundNumberExists,
  getCreditNote,
  getCustomerRefund,
  getReceipt,
  getSalesSettings,
  insertCustomerRefund,
  listCustomerRefunds,
  SalesPermissions,
  settleRefund,
  takeNextCustomerRefundNumber,
  updateCustomerRefund,
  updateReceipt,
  type CustomerRefund,
  type CustomerRefundStatus,
  type SalesSettings,
} from '../modules/sales/index.js';
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
import { assertOpenPeriod, customersMatching } from './sales-documents.js';
import { resolveSettlementRate, settlementAccountProblem } from './vendor-payment-service.js';

/**
 * Customer refunds (priority list of 2026-10-07; mirrors vendor refunds, ADR 0004 P4-30). A
 * refund is a separate accounting transaction — not a receipt or allocation reversal: the company
 * pays back part of an open customer credit balance on AR, either a recorded receipt's
 * unallocated amount or an issued credit note's unapplied amount. It never touches invoices or
 * allocations.
 *
 * Recording (`receipts.create`, plus `credit_notes.view` for a credit-note source; no
 * re-authentication) locks the source, fixes the rate (the table rate on the refund date or a
 * manual override with a mandatory reason, the table rate kept), takes the RF- number and posts
 * through `sales.refund_recorded`: Dr AR for the source's historical base released / Cr the
 * refund account (bank or cash only) at the refund rate / one net base-only realized-FX line,
 * fx = base released − base paid (positive = gain). Partial and multiple refunds are allowed up
 * to the source's open balance. Void (`receipts.void`, re-authenticated) reverses the journal
 * through the Sales reversal and restores the source's exact amount and base.
 */

export const CUSTOMER_REFUND_RECORDED_EVENT = 'sales.refund_recorded';
const RESOURCE = 'sales_refund';

export interface CustomerRefundInput {
  sourceType: 'receipt' | 'credit_note';
  sourceId: string;
  refundDate: string;
  amount: string;
  /** Overrides the Sales default deposit account; bank or cash only. */
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

function encodeCursor(refund: CustomerRefund) {
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

async function customerName(tx: Transaction, organizationId: string, customerId: string) {
  const customer = await getCustomer(tx, organizationId, customerId);
  const party = customer ? await getParty(tx, organizationId, customer.partyId) : undefined;
  return party?.displayName ?? null;
}

type LockedSource = Awaited<ReturnType<CustomerRefundService['lockSource']>>;

export class CustomerRefundService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
  ) {
    // The journal a refund posts; Sales owns the authorization (Decision 13).
    journals.registerEventHandler(
      CUSTOMER_REFUND_RECORDED_EVENT,
      (event) => event.payload.journal as never,
      { domainApproval: true },
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

  private requireAr(sales: SalesSettings | undefined) {
    if (!sales?.arAccountId) {
      throw new ValidationError([
        { path: 'arAccountId', message: 'Choose the AR control account in Sales settings first.' },
      ]);
    }
    return sales as SalesSettings & { arAccountId: string };
  }

  /**
   * Locks a refund source (the source comes before refunds in the lock order) and describes its
   * open customer credit balance. A credit-note source needs `credit_notes.view`.
   */
  private async lockSource(
    tx: Transaction,
    ctx: AuthorizationContext,
    source: { type: 'receipt' | 'credit_note'; id: string },
  ) {
    if (source.type === 'receipt') {
      const receipt = await getReceipt(tx, ctx.organizationId, source.id, { forUpdate: true });
      if (!receipt) throw new NotFoundError('Receipt not found.');
      return {
        type: 'receipt' as const,
        id: receipt.id,
        number: receipt.number,
        customerId: receipt.customerId,
        currencyCode: receipt.currencyCode,
        date: receipt.receiptDate,
        open: receipt.status === 'RECORDED',
        balance: {
          amountDue: decimal(receipt.amountUnallocated),
          baseDue: decimal(receipt.baseUnallocated),
        },
      };
    }
    requirePermission(ctx, SalesPermissions.CreditNotesView);
    const note = await getCreditNote(tx, ctx.organizationId, source.id, { forUpdate: true });
    if (!note) throw new NotFoundError('Credit note not found.');
    return {
      type: 'credit_note' as const,
      id: note.id,
      number: note.number,
      customerId: note.customerId,
      currencyCode: note.currencyCode,
      date: note.creditDate,
      open: note.status === 'ISSUED',
      balance: {
        amountDue: decimal(note.amountUnapplied ?? '0'),
        baseDue: decimal(note.baseUnapplied ?? '0'),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private summary(refund: CustomerRefund, name: string | null) {
    const c = refund.currencyCode;
    return {
      id: refund.id,
      status: refund.status,
      number: refund.number,
      customerId: refund.customerId,
      customerName: name,
      sourceType: refund.sourceType,
      sourceId: refund.receiptId ?? refund.creditNoteId!,
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
    const refund = await getCustomerRefund(tx, ctx.organizationId, id);
    if (!refund) throw new NotFoundError('Refund not found.');
    if (refund.sourceType === 'credit_note') {
      requirePermission(ctx, SalesPermissions.CreditNotesView);
    }
    const sourceNumber = refund.receiptId
      ? ((await getReceipt(tx, ctx.organizationId, refund.receiptId))?.number ?? null)
      : ((await getCreditNote(tx, ctx.organizationId, refund.creditNoteId!))?.number ?? null);
    return {
      ...this.summary(refund, await customerName(tx, ctx.organizationId, refund.customerId)),
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
      status?: CustomerRefundStatus[] | undefined;
      customerId?: string | undefined;
      receiptId?: string | undefined;
      creditNoteId?: string | undefined;
      search?: string | undefined;
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.ReceiptsView },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const canCredits = hasPermission(ctx, SalesPermissions.CreditNotesView);
        if (query.creditNoteId) requirePermission(ctx, SalesPermissions.CreditNotesView);
        const search = query.search?.trim() || null;
        const page = await listCustomerRefunds(tx, {
          organizationId: ctx.organizationId,
          statuses: query.status?.length ? query.status : null,
          customerId: query.customerId ?? null,
          receiptId: query.receiptId ?? null,
          creditNoteId: query.creditNoteId ?? null,
          includeCreditNoteSources: canCredits,
          search,
          customerIdsIn: customersMatching(ctx.organizationId, search),
          limit: query.limit,
          after: query.after ? decodeCursor(query.after) : null,
        });
        const names = new Map<string, string | null>();
        for (const id of new Set(page.items.map((r) => r.customerId))) {
          names.set(id, await customerName(tx, ctx.organizationId, id));
        }
        const last = page.items.at(-1);
        return {
          items: page.items.map((r) => this.summary(r, names.get(r.customerId) ?? null)),
          nextCursor: page.hasMore && last ? encodeCursor(last) : null,
        };
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.ReceiptsView },
      (tx, ctx) => this.detail(tx, ctx, id),
    );
  }

  // ---------------------------------------------------------------------------
  // Record
  // ---------------------------------------------------------------------------

  /** Records a refund at once (no draft, no approval); retry-safe with an Idempotency-Key. */
  record(
    principal: Principal,
    input: CustomerRefundInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.ReceiptsCreate },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'sales.refund.record', request: input },
          () => this.recordInTransaction(tx, ctx, input, origin),
        ),
    );
  }

  private async recordInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: CustomerRefundInput,
    origin: EventOrigin,
  ) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const sales = this.requireAr(await getSalesSettings(tx, ctx.organizationId));
    if (!isValidIsoDate(input.refundDate)) {
      throw new ValidationError([
        { path: 'refundDate', message: 'Enter a valid date (YYYY-MM-DD).' },
      ]);
    }
    const source = await this.lockSource(tx, ctx, { type: input.sourceType, id: input.sourceId });
    if (!source.open) {
      throw invalidState(
        source.type === 'receipt'
          ? 'Only a recorded receipt can be refunded.'
          : 'Only an issued credit note can be refunded.',
      );
    }
    const issues: ValidationIssue[] = [];
    const currencyCode = source.currencyCode;
    if (source.balance.amountDue.lte(0)) {
      issues.push({
        path: 'sourceId',
        message:
          source.type === 'receipt'
            ? 'The receipt has no unallocated amount left to refund.'
            : 'The credit note has nothing left to refund.',
      });
    }
    if (input.refundDate < source.date) {
      issues.push({
        path: 'refundDate',
        message: 'A refund cannot be dated before the receipt or credit note it refunds.',
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
    // Refund account: bank or cash only, in the source or base currency.
    const accountId = input.refundAccountId ?? sales.defaultDepositAccountId;
    if (!accountId) {
      issues.push({
        path: 'refundAccountId',
        message: 'Choose a refund account or set the default deposit account in Sales settings.',
      });
    } else {
      const problem = settlementAccountProblem(
        await getAccount(tx, ctx.organizationId, accountId),
        currencyCode,
        accounting.baseCurrency,
        'customer_refund',
      );
      if (problem) issues.push({ path: 'refundAccountId', message: problem });
    }
    // Rate: a manual rate needs a reason; base-currency refunds have none.
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

    // Settlement: paid at the refund rate, released at the source's historical base.
    const value = amount.ok ? amount.value : decimal(0);
    const settled = settleRefund({
      amount: value,
      rate: rate.rate,
      baseCurrency: accounting.baseCurrency,
      source: source.balance,
    });
    const basePaid = settled.baseReceived;
    const baseReleased = settled.baseReleased;
    // Gain when the liability released exceeds the cash paid out (opposite of a vendor refund).
    const fx = baseReleased.minus(basePaid);
    let fxAccountId: string | null = null;
    if (!fx.isZero()) {
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
    const customer = await getCustomer(tx, ctx.organizationId, source.customerId);
    const party = customer ? await getParty(tx, ctx.organizationId, customer.partyId) : undefined;
    const label = `Refund ${number}`;
    const lines: SystemJournalLineInput[] = [
      {
        accountId: sales.arAccountId,
        description: `${label} — to ${party?.displayName ?? ''} (${source.number ?? ''})`.slice(
          0,
          500,
        ),
        kind: 'normal',
        debit: fixed(value),
        credit: null,
        baseDebit: fixed(baseReleased),
        baseCredit: null,
      },
      {
        accountId: accountId!,
        description: `${label} — ${party?.displayName ?? ''}`.slice(0, 500),
        kind: 'normal',
        debit: null,
        credit: fixed(value),
        baseDebit: null,
        baseCredit: fixed(basePaid),
      },
    ];
    if (!fx.isZero()) {
      // One net base-only line: a gain is a base credit, a loss a base debit.
      lines.push({
        accountId: fxAccountId!,
        description: `Realized FX — ${label}`,
        kind: 'base_only',
        debit: null,
        credit: null,
        baseDebit: fx.isNegative() ? fixed(fx.negated()) : null,
        baseCredit: fx.isPositive() ? fixed(fx) : null,
      });
    }
    const id = randomUUID();
    const foreign = currencyCode !== accounting.baseCurrency;
    const description = `${label} — ${party?.displayName ?? ''}`.slice(0, 500);
    const journal = fx.isZero()
      ? {
          entryDate: input.refundDate,
          description,
          reference: input.reference?.trim() || number,
          currency: currencyCode,
          exchangeRate: foreign ? rate.rate.toFixed(10) : null,
          ...(foreign ? { exchangeRateSource: rate.source === 'table' ? 'table' : 'manual' } : {}),
          sourceRef: { module: 'sales', type: 'refund', id },
          lines: lines.map((l) => ({
            accountId: l.accountId,
            description: l.description,
            debit: l.debit,
            credit: l.credit,
          })),
        }
      : {
          system: {
            source: { module: 'sales', type: 'realized_fx', id },
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
      sourceModule: 'sales',
      eventType: CUSTOMER_REFUND_RECORDED_EVENT,
      eventKey: `customer-refund:${id}:recorded`,
      payload: { refundId: id, number, journal },
      occurredAt: now,
      origin,
    });
    if (!event.journalId) {
      throw new AppError('CONFLICT', 409, 'The refund was not recorded; try again.');
    }
    const overridden = accountId !== sales.defaultDepositAccountId;
    const refund = await insertCustomerRefund(tx, {
      id,
      organizationId: ctx.organizationId,
      number,
      customerId: source.customerId,
      sourceType: source.type,
      receiptId: source.type === 'receipt' ? source.id : null,
      creditNoteId: source.type === 'credit_note' ? source.id : null,
      refundDate: input.refundDate,
      currencyCode,
      amount: fixed(value),
      refundAccountId: accountId!,
      refundAccountOverridden: overridden,
      exchangeRate: rate.rate.toFixed(10),
      exchangeRateSource: rate.source,
      tableRate: rate.tableRate ? rate.tableRate.toFixed(10) : null,
      rateOverrideReason: rate.source === 'manual' ? rateOverrideReason : null,
      baseAmount: fixed(basePaid),
      baseReleased: fixed(baseReleased),
      fxDifference: fixed(fx),
      reference: input.reference?.trim() || null,
      memo: input.memo?.trim() ?? '',
      journalId: event.journalId,
      accountingEventId: event.eventId,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedByUserId: ctx.userId,
      updatedAt: now,
    });
    await this.adjustSource(tx, ctx, source, value.negated(), baseReleased.negated(), now);
    if (rate.source === 'manual') {
      await this.audit(tx, ctx, 'customer_refund.rate_overridden', id, now, origin, {
        currencyCode,
        rate: refund.exchangeRate,
        tableRate: refund.tableRate,
        reason: refund.rateOverrideReason,
      });
    }
    if (overridden) {
      await this.audit(tx, ctx, 'customer_refund.account_overridden', id, now, origin, {
        refundAccountId: accountId,
        defaultDepositAccountId: sales.defaultDepositAccountId,
      });
    }
    await this.audit(tx, ctx, 'customer_refund.recorded', id, now, origin, {
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
    source: LockedSource,
    amount: Decimal,
    base: Decimal,
    now: Date,
  ) {
    const updated =
      source.type === 'receipt'
        ? await updateReceipt(tx, {
            organizationId: ctx.organizationId,
            id: source.id,
            set: {
              amountUnallocated: fixed(source.balance.amountDue.plus(amount)),
              baseUnallocated: fixed(source.balance.baseDue.plus(base)),
              updatedByUserId: ctx.userId,
              updatedAt: now,
            },
          })
        : await adjustCreditNoteBalance(tx, {
            organizationId: ctx.organizationId,
            id: source.id,
            amount: fixed(amount),
            base: fixed(base),
            now,
            userId: ctx.userId,
          });
    if (!updated) throw invalidState('The refunded document changed meanwhile; try again.');
  }

  private async nextNumber(tx: Transaction, organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const number = await takeNextCustomerRefundNumber(tx, organizationId);
      if (!(await customerRefundNumberExists(tx, organizationId, number))) return number;
    }
    throw new AppError(
      'CONFLICT',
      409,
      'Could not find a free refund number; check the numbering.',
    );
  }

  // ---------------------------------------------------------------------------
  // Void
  // ---------------------------------------------------------------------------

  /**
   * Voids a recorded refund: reverses its journal through the Sales reversal on its date
   * (realized-FX system journals are mirrored, never reversed generically) and restores the
   * source's exact amount and base. Needs `receipts.void` and a recent password confirmation.
   * The source is locked before the refund (the lock order).
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
      { permission: SalesPermissions.ReceiptsVoid, sensitive: true },
      async (tx, ctx) => {
        const peek = await getCustomerRefund(tx, ctx.organizationId, id);
        if (!peek) throw new NotFoundError('Refund not found.');
        const source = await this.lockSource(tx, ctx, {
          type: peek.sourceType,
          id: peek.receiptId ?? peek.creditNoteId!,
        });
        const refund = await getCustomerRefund(tx, ctx.organizationId, id, { forUpdate: true });
        if (!refund) throw new NotFoundError('Refund not found.');
        if (refund.version !== input.version) {
          throw new ConflictError(
            'VERSION_CONFLICT',
            'The refund changed; reload it and try again.',
          );
        }
        if (refund.status !== 'RECORDED') throw invalidState('The refund is already void.');
        if (!source.open) {
          throw invalidState('The refunded receipt or credit note is no longer open.');
        }
        const reason = input.reason.trim();
        const reversal = await this.journals.reverseSubledgerJournalInTransaction(
          tx,
          ctx,
          'sales',
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
        const voided = await updateCustomerRefund(tx, {
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
        await this.audit(tx, ctx, 'customer_refund.voided', id, now, origin, {
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
