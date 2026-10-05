import { randomUUID } from 'node:crypto';
import type { Decimal } from 'decimal.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import {
  convertToBase,
  decimal,
  isSupportedCurrency,
  minorUnits,
  parseAmount,
  parseRate,
} from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  findApplicableRate,
  getAccount,
  getDesignatedAccountId,
  isBankOrCash,
  isValidIsoDate,
  type AccountWithFacts,
  type AccountingSettings,
  type SystemJournalLineInput,
} from '../modules/accounting/index.js';
import { getApprovalRequest, type ApprovalFacts } from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  settleApCredit,
  settlePayment,
  type ApSettlementPart,
} from '../modules/documents/index.js';
import { getParty, partyIdsMatching } from '../modules/parties/index.js';
import {
  adjustBillBalance,
  adjustVendorCreditBalance,
  BillPermissions,
  countActiveRefunds,
  deletePayment,
  getBill,
  getPayment,
  getPlannedAllocations,
  getPurchasesSettings,
  getVendorCredit,
  insertPayment,
  insertPurchasesAllocations,
  listOpenBills,
  listPayments,
  listPurchasesAllocations,
  lockApAccount,
  lockBills,
  paymentNumberExists,
  replacePlannedAllocations,
  takeNextPurchaseNumber,
  unreversedAllocations,
  updatePayment,
  VendorCreditPermissions,
  VendorPaymentPermissions,
  type Bill,
  type NewPurchasesAllocation,
  type Payment,
  type PaymentStatus,
  type PurchasesAllocation,
  type PurchasesSettings,
} from '../modules/purchases/index.js';
import { getVendor, vendorIdsOfParties } from '../modules/vendors/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { ApprovalService } from './approval-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import { assertOpenPeriod, documentApprovalState } from './sales-documents.js';

/**
 * Vendor payments, prepayments and AP credit application (Phase 4B-2; ADR 0004 P4-25 to P4-29,
 * P4-33, P4-34, P4-37, P4-42, P4-50, P4-51; decisions C1-C3, A1-A6 of 2026-10-04).
 *
 * A payment has one transaction currency. Drafts carry planned allocations to posted bills
 * (never to vendor credits, C2). Submit opens an approval request when a `purchases.payment.record`
 * policy step matches (types `payment` / `prepayment`, A4); approval only authorizes. Record
 * (`vendor_payments.create`, no re-authentication, P4-42) re-checks everything under locks, fixes
 * the rate (the table rate on the payment date, or a manual override with a reason, the table rate
 * kept, P4-27), resolves the payment account (the Purchases default or an override within the
 * bank/cash/credit-card and currency rules, P4-26, P4-28), takes the PAY- number and posts through
 * `purchases.payment_recorded`: Dr AP per bill at its historical base, Dr AP for any excess (the
 * prepayment, a vendor debit balance on AP, P4-29), Cr the payment account at the payment rate,
 * and the net realized FX as ONE base-only line (C1). Each allocation keeps its own FX with the AP
 * sign (base relieved − source base; positive = gain).
 *
 * A vendor credit or a prepayment is applied to posted bills of the same vendor and currency
 * through `purchases.credit_applied` (AP against AP, with FX; A2, A3). Void (`vendor_payments.void`,
 * re-authenticated, P4-33, P4-42) reverses the payment journal and every application funded by its
 * prepayment through the Purchases reversal, appends reversing allocations and restores the bills.
 */

export const PAYMENT_RECORD_ACTION = 'purchases.payment.record';
export const PAYMENT_RECORDED_EVENT = 'purchases.payment_recorded';
export const CREDIT_APPLIED_EVENT = 'purchases.credit_applied';
const RESOURCE = 'purchases_payment';
/** P4-50: the 500-line journal cap less the payment, excess and realized-FX lines (C1). */
export const MAX_PAYMENT_BILLS = 497;

export interface PaymentDraftInput {
  vendorId: string;
  paymentDate: string;
  currencyCode?: string | undefined;
  amount: string;
  /** P4-28: overrides the Purchases default payment account. */
  paymentAccountId?: string | null | undefined;
  /** P4-27: overrides the table rate; needs a reason. */
  rateOverride?: string | null | undefined;
  rateOverrideReason?: string | null | undefined;
  reference?: string | null | undefined;
  memo?: string | undefined;
  allocations: { billId: string; amount: string }[];
}

export interface ApplyApCreditInput {
  /** The credit's source: a posted vendor credit or a recorded payment's prepayment. */
  sourceType: 'vendor_credit' | 'payment';
  sourceId: string;
  date: string;
  allocations: { billId: string; amount: string }[];
}

export interface Rate {
  rate: Decimal;
  source: 'base' | 'table' | 'manual';
  tableRate: Decimal | null;
}

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'This payment was changed by someone else. Reload it and apply your changes again.',
  );
const fixed = (value: Decimal) => value.toFixed(4);
const shown = (value: string | null, currency: string) =>
  value === null ? null : decimal(value).toFixed(minorUnits(currency));
const sum = (values: readonly Decimal[]) => values.reduce((a, b) => a.plus(b), decimal(0));

function encodeCursor(payment: Payment) {
  return Buffer.from(JSON.stringify({ d: payment.paymentDate, i: payment.id })).toString(
    'base64url',
  );
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

/**
 * P4-26 / Decision 42: an active posting (leaf) bank, cash or credit-card account that is not a
 * control account, in the payment currency or the base currency. Classification is never inferred.
 */
export function paymentAccountProblem(
  account: AccountWithFacts | undefined,
  currencyCode: string,
  baseCurrency: string,
): string | null {
  return settlementAccountProblem(account, currencyCode, baseCurrency, 'payment');
}

/**
 * Where money settling AP moves (explicit per context; never inferred): vendor payments may come
 * from bank, cash or credit-card accounts (P4-26); vendor refunds go to bank or cash accounts only
 * (4B-3 amendment: no credit-card refunds).
 */
export type SettlementAccountContext = 'payment' | 'refund';

const SETTLEMENT_ACCOUNTS: Record<
  SettlementAccountContext,
  { eligible: (subtype: AccountWithFacts['subtype']) => boolean; refusal: string; noun: string }
> = {
  payment: {
    eligible: (subtype) => isBankOrCash(subtype) || subtype === 'CREDIT_CARD',
    refusal: 'Choose a bank, cash or credit card account (Decision 42, P4-26).',
    noun: 'payment account',
  },
  refund: {
    eligible: (subtype) => isBankOrCash(subtype),
    refusal: 'Choose a bank or cash account; vendor refunds cannot go to a credit card account.',
    noun: 'refund account',
  },
};

/**
 * Decision 42: an active posting (leaf) account that is not a control account, of a subtype the
 * context allows, in the transaction currency or the base currency.
 */
export function settlementAccountProblem(
  account: AccountWithFacts | undefined,
  currencyCode: string,
  baseCurrency: string,
  context: SettlementAccountContext,
): string | null {
  const rule = SETTLEMENT_ACCOUNTS[context];
  if (!account) return 'Account not found.';
  if (account.status !== 'ACTIVE') return 'Choose an active account.';
  if (!account.isLeaf) return 'Choose a posting (leaf) account.';
  if (account.isControlAccount) return 'A control account cannot be used here.';
  if (!rule.eligible(account.subtype)) return rule.refusal;
  if (account.currencyCode !== currencyCode && account.currencyCode !== baseCurrency) {
    return currencyCode === baseCurrency
      ? `The ${rule.noun} must be in ${currencyCode}.`
      : `The ${rule.noun} must be in ${currencyCode} or ${baseCurrency}.`;
  }
  return null;
}

/**
 * A settlement rate (P4-27; Decision 37 parity): 1 in the base currency, otherwise the manual
 * override or the table rate on the date. The table rate is kept. `strict` refuses a missing
 * table rate; otherwise it returns null.
 */
export async function resolveSettlementRate(
  tx: Transaction,
  organizationId: string,
  accounting: AccountingSettings,
  input: { currencyCode: string; date: string; rateOverride: string | null },
  strict: boolean,
): Promise<Rate | null> {
  if (input.currencyCode === accounting.baseCurrency) {
    return { rate: decimal(1), source: 'base', tableRate: null };
  }
  const table = await findApplicableRate(tx, {
    organizationId,
    fromCurrency: input.currencyCode,
    toCurrency: accounting.baseCurrency,
    onDate: input.date,
  });
  const tableRate = table ? decimal(table.rate) : null;
  if (input.rateOverride) {
    return { rate: decimal(input.rateOverride), source: 'manual', tableRate };
  }
  if (tableRate) return { rate: tableRate, source: 'table', tableRate };
  if (!strict) return null;
  throw new AppError(
    'EXCHANGE_RATE_REQUIRED',
    409,
    `An exchange rate from ${input.currencyCode} to ${accounting.baseCurrency} is required for ${input.date}.`,
  );
}

async function vendorName(tx: Transaction, organizationId: string, vendorId: string) {
  const vendor = await getVendor(tx, organizationId, vendorId);
  const party = vendor ? await getParty(tx, organizationId, vendor.partyId) : undefined;
  return party?.displayName ?? null;
}

export class VendorPaymentService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly approvals: ApprovalService,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
  ) {
    approvals.register({
      actionKey: PAYMENT_RECORD_ACTION,
      label: 'Approve vendor payments before recording',
      subjectType: RESOURCE,
      approverPermission: VendorPaymentPermissions.Approve,
      decisionRequiresReauth: false,
      // P4-37: the payment's base amount; A4: `prepayment` without planned bills, else `payment`.
      conditions: { amount: true, transactionTypes: ['payment', 'prepayment'] },
      onApproved: async (tx, { request, authz, now, origin }) => {
        // P4-25: approval authorizes; the payment stays pending until someone records it.
        await this.audit(tx, authz, 'vendor_payment.approved', request.subjectId, now, origin, {
          approvalRequestId: request.id,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        // A rejection needs a reason; refusing here rolls the whole decision back.
        if (!comment?.trim()) {
          throw new ValidationError([
            { path: 'comment', message: 'Give a reason for rejecting the payment.' },
          ]);
        }
        const payment = await updatePayment(tx, {
          organizationId: authz.organizationId,
          id: request.subjectId,
          from: 'PENDING_APPROVAL',
          set: {
            status: 'DRAFT',
            approvalRequestId: null,
            updatedByUserId: authz.userId,
            updatedAt: now,
          },
        });
        if (!payment) throw invalidState('The payment is no longer awaiting approval.');
        await this.audit(tx, authz, 'vendor_payment.rejected', payment.id, now, origin, {
          approvalRequestId: request.id,
          comment: comment.trim(),
        });
      },
    });
    // The journals Purchases posts for payments and credit applications; Purchases owns the
    // authorization (Decision 13).
    for (const eventType of [PAYMENT_RECORDED_EVENT, CREDIT_APPLIED_EVENT]) {
      journals.registerEventHandler(eventType, (event) => event.payload.journal as never, {
        domainApproval: true,
      });
    }
  }

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: Pick<AuthorizationContext, 'organizationId' | 'userId'>,
    action: string,
    paymentId: string,
    now: Date,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
    resourceType: string = RESOURCE,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType,
      resourceId: paymentId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Shared checks
  // ---------------------------------------------------------------------------

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
   * Checks allocations against bills: posted bills of the same vendor and currency, dated on or
   * before `date`, each once, for at most its open balance. `bills` holds the bills found (locked
   * when the caller is about to settle them).
   */
  checkTargets(
    bills: ReadonlyMap<string, Bill>,
    input: {
      vendorId: string;
      currencyCode: string;
      date: string;
      allocations: readonly { billId: string; amount: string }[];
    },
    issues: ValidationIssue[],
  ) {
    if (input.allocations.length > MAX_PAYMENT_BILLS) {
      issues.push({
        path: 'allocations',
        message: `Settle at most ${MAX_PAYMENT_BILLS} bills at once (P4-50).`,
      });
    }
    const ids = input.allocations.map((a) => a.billId);
    if (new Set(ids).size !== ids.length) {
      issues.push({ path: 'allocations', message: 'Allocate to each bill once.' });
    }
    const targets: { bill: Bill; amount: Decimal }[] = [];
    input.allocations.forEach((a, i) => {
      const path = `allocations.${i}`;
      const bill = bills.get(a.billId);
      const amount = parseAmount(a.amount, input.currencyCode);
      if (!bill) return void issues.push({ path: `${path}.billId`, message: 'Bill not found.' });
      if (bill.status !== 'POSTED') {
        return void issues.push({
          path: `${path}.billId`,
          message: 'Only posted bills can be settled.',
        });
      }
      if (bill.vendorId !== input.vendorId) {
        return void issues.push({
          path: `${path}.billId`,
          message: 'The bill belongs to another vendor.',
        });
      }
      if (bill.currencyCode !== input.currencyCode) {
        return void issues.push({
          path: `${path}.billId`,
          message: `The bill is in ${bill.currencyCode}; a payment and its bills share one currency.`,
        });
      }
      if (bill.billDate > input.date) {
        return void issues.push({
          path: `${path}.billId`,
          message: 'The bill is dated after this payment.',
        });
      }
      if (!amount.ok) {
        return void issues.push({
          path: `${path}.amount`,
          message:
            amount.problem === 'too_many_decimals'
              ? `Use at most ${minorUnits(input.currencyCode)} decimal places.`
              : 'Enter an amount greater than zero.',
        });
      }
      if (decimal(bill.amountDue!).lte(0)) {
        return void issues.push({
          path: `${path}.billId`,
          message: 'The bill is already settled.',
        });
      }
      if (amount.value.gt(decimal(bill.amountDue!))) {
        return void issues.push({
          path: `${path}.amount`,
          message: `The bill has ${shown(bill.amountDue, bill.currencyCode)} outstanding.`,
        });
      }
      targets.push({ bill, amount: amount.value });
    });
    return targets;
  }

  /**
   * The payment rate (P4-27, Decision 37 parity): 1 in the base currency, otherwise the manual
   * override with its reason or the table rate on the payment date. The table rate is kept.
   * `strict` refuses a missing table rate (record and submit); otherwise it returns null.
   */
  private async resolveRate(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    payment: Pick<Payment, 'currencyCode' | 'paymentDate' | 'rateOverride'>,
    strict: boolean,
  ): Promise<Rate | null> {
    return resolveSettlementRate(
      tx,
      organizationId,
      accounting,
      {
        currencyCode: payment.currencyCode,
        date: payment.paymentDate,
        rateOverride: payment.rateOverride,
      },
      strict,
    );
  }

  /**
   * Whether a payment with these facts would need approval (P4-37; A4: `payment` when it settles
   * bills). Pay bills refuses the whole batch when any of its payments would (4B-4 D3).
   */
  async approvalRequirement(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    input: {
      currencyCode: string;
      date: string;
      amount: string;
      rateOverride: string | null;
      settlesBills: boolean;
    },
  ) {
    const rate = (await resolveSettlementRate(
      tx,
      organizationId,
      accounting,
      { currencyCode: input.currencyCode, date: input.date, rateOverride: input.rateOverride },
      true,
    ))!;
    const facts = this.facts(
      { amount: input.amount },
      input.settlesBills ? [true] : [],
      rate,
      accounting,
    );
    const requirement = await this.approvals.requirementFor(
      tx,
      organizationId,
      PAYMENT_RECORD_ACTION,
      facts,
    );
    return { required: requirement.required, facts };
  }

  /** P4-37 / A4: the approval facts of a payment at its rate. */
  private facts(
    payment: Pick<Payment, 'amount'>,
    planned: readonly unknown[],
    rate: Rate,
    accounting: AccountingSettings,
  ): ApprovalFacts {
    return {
      transactionType: planned.length ? 'payment' : 'prepayment',
      baseAmount: convertToBase(
        decimal(payment.amount),
        rate.rate,
        accounting.baseCurrency,
      ).toFixed(minorUnits(accounting.baseCurrency)),
      baseCurrency: accounting.baseCurrency,
    };
  }

  /** Validates a draft's fields and planned allocations against the current bills. */
  private async resolveDraft(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    input: PaymentDraftInput,
  ) {
    const issues: ValidationIssue[] = [];
    if (!isValidIsoDate(input.paymentDate)) {
      throw new ValidationError([
        { path: 'paymentDate', message: 'Enter a valid date (YYYY-MM-DD).' },
      ]);
    }
    const vendor = await getVendor(tx, organizationId, input.vendorId);
    const party = vendor ? await getParty(tx, organizationId, vendor.partyId) : undefined;
    if (!vendor) throw new ValidationError([{ path: 'vendorId', message: 'Vendor not found.' }]);
    if (vendor.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
      issues.push({ path: 'vendorId', message: 'Archived vendors cannot be paid.' });
    }
    const currencyCode = input.currencyCode ?? vendor.currencyCode;
    if (!isSupportedCurrency(currencyCode)) {
      throw new ValidationError([{ path: 'currencyCode', message: 'Unsupported currency.' }]);
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
    }
    const paymentAccountId = input.paymentAccountId ?? null;
    if (paymentAccountId) {
      const problem = paymentAccountProblem(
        await getAccount(tx, organizationId, paymentAccountId),
        currencyCode,
        accounting.baseCurrency,
      );
      if (problem) issues.push({ path: 'paymentAccountId', message: problem });
    }
    const rateOverride = input.rateOverride ?? null;
    const rateOverrideReason = input.rateOverrideReason?.trim() || null;
    if (rateOverride !== null) {
      if (currencyCode === accounting.baseCurrency) {
        issues.push({
          path: 'rateOverride',
          message: 'A base-currency payment has no exchange rate to override.',
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
          message: 'Give a reason for overriding the rate (P4-27).',
        });
      }
    } else if (rateOverrideReason) {
      issues.push({ path: 'rateOverride', message: 'Enter the manual rate the reason is for.' });
    }
    const bills = new Map<string, Bill>();
    for (const id of new Set(input.allocations.map((a) => a.billId))) {
      const bill = await getBill(tx, organizationId, id);
      if (bill) bills.set(id, bill);
    }
    const targets = this.checkTargets(
      bills,
      {
        vendorId: input.vendorId,
        currencyCode,
        date: input.paymentDate,
        allocations: input.allocations,
      },
      issues,
    );
    if (amount.ok && sum(targets.map((t) => t.amount)).gt(amount.value)) {
      issues.push({ path: 'allocations', message: 'The allocations exceed the amount paid.' });
    }
    if (issues.length) throw new ValidationError(issues);
    return {
      header: {
        vendorId: input.vendorId,
        paymentDate: input.paymentDate,
        currencyCode,
        amount: fixed(amount.ok ? amount.value : decimal(0)),
        paymentAccountId,
        rateOverride: rateOverride === null ? null : decimal(rateOverride).toFixed(10),
        rateOverrideReason: rateOverride === null ? null : rateOverrideReason,
        reference: input.reference?.trim() || null,
        memo: input.memo?.trim() ?? '',
      },
      planned: targets.map((t) => ({ billId: t.bill.id, amount: fixed(t.amount) })),
    };
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private summary(payment: Payment, name: string | null) {
    const c = payment.currencyCode;
    return {
      id: payment.id,
      status: payment.status,
      number: payment.number,
      vendorId: payment.vendorId,
      vendorName: name,
      paymentDate: payment.paymentDate,
      currencyCode: c,
      amount: shown(payment.amount, c)!,
      amountUnallocated: shown(payment.amountUnallocated, c),
      baseAmount: payment.baseAmount,
      baseUnallocated: payment.baseUnallocated,
      reference: payment.reference,
      version: payment.version,
      recordedAt: payment.recordedAt?.toISOString() ?? null,
      voidedAt: payment.voidedAt?.toISOString() ?? null,
      paymentBatchId: payment.paymentBatchId,
    };
  }

  private async allocationViews(
    tx: Transaction,
    organizationId: string,
    rows: readonly PurchasesAllocation[],
  ) {
    const billNumbers = new Map<string, string | null>();
    const sourceNumbers = new Map<string, string | null>();
    for (const row of rows) {
      if (!billNumbers.has(row.billId)) {
        billNumbers.set(
          row.billId,
          (await getBill(tx, organizationId, row.billId))?.number ?? null,
        );
      }
      const sourceId = row.paymentId ?? row.vendorCreditId!;
      if (!sourceNumbers.has(sourceId)) {
        sourceNumbers.set(
          sourceId,
          row.paymentId
            ? ((await getPayment(tx, organizationId, row.paymentId))?.number ?? null)
            : ((await getVendorCredit(tx, organizationId, row.vendorCreditId!))?.number ?? null),
        );
      }
    }
    return rows.map((a) => ({
      id: a.id,
      billId: a.billId,
      billNumber: billNumbers.get(a.billId) ?? null,
      sourceType: a.sourceType,
      sourceId: a.paymentId ?? a.vendorCreditId,
      sourceNumber: sourceNumbers.get(a.paymentId ?? a.vendorCreditId!) ?? null,
      mode: a.mode,
      applicationId: a.applicationId,
      allocationDate: a.allocationDate,
      currencyCode: a.currencyCode,
      amount: shown(a.amount, a.currencyCode),
      baseRelieved: a.baseRelieved,
      sourceBase: a.sourceBase,
      fxDifference: a.fxDifference,
      reversesAllocationId: a.reversesAllocationId,
      journalId: a.journalId,
    }));
  }

  private async detail(tx: Transaction, ctx: AuthorizationContext, id: string) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const payment = await getPayment(tx, ctx.organizationId, id);
    if (!payment) throw new NotFoundError('Payment not found.');
    const purchases = await getPurchasesSettings(tx, ctx.organizationId);
    const planned = await getPlannedAllocations(tx, ctx.organizationId, id);
    const open = payment.status === 'DRAFT' || payment.status === 'PENDING_APPROVAL';
    const rate = open
      ? await this.resolveRate(tx, ctx.organizationId, accounting, payment, false)
      : null;
    const facts = open && rate ? this.facts(payment, planned, rate, accounting) : null;
    const plannedViews = [];
    for (const p of planned) {
      const bill = await getBill(tx, ctx.organizationId, p.billId);
      plannedViews.push({
        billId: p.billId,
        billNumber: bill?.number ?? null,
        billDate: bill?.billDate ?? null,
        billStatus: bill?.status ?? null,
        billAmountDue: bill ? shown(bill.amountDue, bill.currencyCode) : null,
        amount: shown(p.amount, payment.currencyCode),
      });
    }
    const allocations = await listPurchasesAllocations(tx, ctx.organizationId, { paymentId: id });
    return {
      ...this.summary(payment, await vendorName(tx, ctx.organizationId, payment.vendorId)),
      paymentAccountId: payment.paymentAccountId,
      defaultPaymentAccountId: purchases?.defaultPaymentAccountId ?? null,
      paymentAccountOverridden: payment.paymentAccountOverridden,
      rateOverride: payment.rateOverride,
      rateOverrideReason: payment.rateOverrideReason,
      exchangeRate: payment.exchangeRate ?? (rate ? rate.rate.toFixed(10) : null),
      exchangeRateSource: payment.exchangeRateSource ?? rate?.source ?? null,
      tableRate: payment.tableRate ?? (rate?.tableRate ? rate.tableRate.toFixed(10) : null),
      memo: payment.memo,
      journalId: payment.journalId,
      voidReason: payment.voidReason,
      voidJournalId: payment.voidJournalId,
      createdByUserId: payment.createdByUserId,
      baseCurrency: accounting.baseCurrency,
      plannedAllocations: plannedViews,
      allocations: await this.allocationViews(tx, ctx.organizationId, allocations),
      approval: await documentApprovalState(
        this.approvals,
        tx,
        ctx.organizationId,
        PAYMENT_RECORD_ACTION,
        payment,
        facts,
      ),
      warnings:
        open && !rate
          ? [
              {
                code: 'EXCHANGE_RATE_REQUIRED',
                message: `No ${payment.currencyCode} rate is recorded for ${payment.paymentDate}; enter one under Accounting or set a manual rate.`,
              },
            ]
          : [],
    };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(
    principal: Principal,
    query: {
      status?: PaymentStatus[] | undefined;
      vendorId?: string | undefined;
      withUnallocated?: boolean | undefined;
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
        const search = query.search?.trim() || null;
        const page = await listPayments(tx, {
          organizationId: ctx.organizationId,
          statuses: query.status?.length ? query.status : null,
          vendorId: query.vendorId ?? null,
          withUnallocated: query.withUnallocated === true,
          search,
          vendorIdsIn: search
            ? vendorIdsOfParties(ctx.organizationId, partyIdsMatching(ctx.organizationId, search))
            : undefined,
          limit: query.limit,
          after: query.after ? decodeCursor(query.after) : null,
        });
        const names = new Map<string, string | null>();
        for (const id of new Set(page.items.map((p) => p.vendorId))) {
          names.set(id, await vendorName(tx, ctx.organizationId, id));
        }
        const last = page.items.at(-1);
        return {
          items: page.items.map((p) => this.summary(p, names.get(p.vendorId) ?? null)),
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

  /** Posted bills of a vendor in a currency with an amount due: the targets to settle. */
  openBills(principal: Principal, query: { vendorId: string; currencyCode: string }) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.Create },
      async (tx, ctx) => {
        const bills = await listOpenBills(tx, {
          organizationId: ctx.organizationId,
          vendorId: query.vendorId,
          currencyCode: query.currencyCode,
          limit: MAX_PAYMENT_BILLS,
        });
        return bills.map((b) => ({
          id: b.id,
          number: b.number,
          vendorReference: b.vendorReference,
          billDate: b.billDate,
          dueDate: b.dueDate,
          currencyCode: b.currencyCode,
          total: shown(b.total, b.currencyCode),
          amountDue: shown(b.amountDue, b.currencyCode),
        }));
      },
    );
  }

  /** The settlement history of a bill (payments and applications, with reversals). */
  billAllocations(principal: Principal, billId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BillPermissions.View },
      async (tx, ctx) => {
        const bill = await getBill(tx, ctx.organizationId, billId);
        if (!bill) throw new NotFoundError('Bill not found.');
        const rows = await listPurchasesAllocations(tx, ctx.organizationId, { billId });
        return this.allocationViews(tx, ctx.organizationId, rows);
      },
    );
  }

  /** The applications of a vendor credit to bills. */
  vendorCreditAllocations(principal: Principal, vendorCreditId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorCreditPermissions.View },
      async (tx, ctx) => {
        const credit = await getVendorCredit(tx, ctx.organizationId, vendorCreditId);
        if (!credit) throw new NotFoundError('Vendor credit not found.');
        const rows = await listPurchasesAllocations(tx, ctx.organizationId, { vendorCreditId });
        return this.allocationViews(tx, ctx.organizationId, rows);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Drafts (P4-25; A1)
  // ---------------------------------------------------------------------------

  /** Creates a draft; with an Idempotency-Key a retry returns the first result (A1). */
  create(
    principal: Principal,
    input: PaymentDraftInput,
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
          { key: options.idempotencyKey, scope: 'purchases.payment.create', request: input },
          async () => {
            const payment = await this.createDraftInTransaction(tx, ctx, input, origin);
            return this.detail(tx, ctx, payment.id);
          },
        ),
    );
  }

  /**
   * Validates and inserts a draft with its planned allocations, in the caller's transaction. The
   * caller has authorized the action and owns the idempotency (single create, or Pay bills, which
   * passes the batch the payment belongs to; 4B-4).
   */
  async createDraftInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: PaymentDraftInput,
    origin: EventOrigin,
    options: { paymentBatchId?: string } = {},
  ): Promise<Payment> {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const { header, planned } = await this.resolveDraft(tx, ctx.organizationId, accounting, input);
    const now = this.now;
    const payment = await insertPayment(tx, {
      ...header,
      organizationId: ctx.organizationId,
      paymentBatchId: options.paymentBatchId ?? null,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedByUserId: ctx.userId,
      updatedAt: now,
    });
    await replacePlannedAllocations(tx, ctx.organizationId, payment.id, planned);
    await this.audit(tx, ctx, 'vendor_payment.created', payment.id, now, origin, {
      vendorId: payment.vendorId,
      paymentDate: payment.paymentDate,
      currencyCode: payment.currencyCode,
      amount: payment.amount,
      paymentAccountId: payment.paymentAccountId,
      plannedAllocations: planned.length,
      ...(payment.paymentBatchId ? { paymentBatchId: payment.paymentBatchId } : {}),
      ...(payment.rateOverride
        ? {
            rateOverride: payment.rateOverride,
            rateOverrideReason: payment.rateOverrideReason,
          }
        : {}),
    });
    return payment;
  }

  update(
    principal: Principal,
    id: string,
    input: PaymentDraftInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.Create },
      async (tx, ctx) => {
        const payment = await this.lockDraft(tx, ctx, id, input.version, 'edited');
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const { header, planned } = await this.resolveDraft(
          tx,
          ctx.organizationId,
          accounting,
          input,
        );
        const now = this.now;
        const updated = await updatePayment(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: input.version,
          set: { ...header, updatedByUserId: ctx.userId, updatedAt: now },
        });
        if (!updated) throw versionConflict();
        await replacePlannedAllocations(tx, ctx.organizationId, id, planned);
        await this.audit(tx, ctx, 'vendor_payment.updated', id, now, origin, {
          version: updated.version,
          amount: { before: payment.amount, after: updated.amount },
          plannedAllocations: planned.length,
          ...(updated.rateOverride !== payment.rateOverride ||
          updated.rateOverrideReason !== payment.rateOverrideReason
            ? {
                rateOverride: {
                  before: payment.rateOverride,
                  after: updated.rateOverride,
                  reason: updated.rateOverrideReason,
                },
              }
            : {}),
          ...(updated.paymentAccountId !== payment.paymentAccountId
            ? {
                paymentAccountId: {
                  before: payment.paymentAccountId,
                  after: updated.paymentAccountId,
                },
              }
            : {}),
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  delete(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.Create },
      async (tx, ctx) => {
        const payment = await this.lockDraft(tx, ctx, id, input.version, 'deleted');
        await deletePayment(tx, ctx.organizationId, id);
        await this.audit(tx, ctx, 'vendor_payment.deleted', id, this.now, origin, {
          vendorId: payment.vendorId,
          amount: payment.amount,
          currencyCode: payment.currencyCode,
        });
        return { id, deleted: true };
      },
    );
  }

  private async lockDraft(
    tx: Transaction,
    ctx: AuthorizationContext,
    id: string,
    version: number,
    verb: 'edited' | 'deleted',
  ) {
    const payment = await getPayment(tx, ctx.organizationId, id, { forUpdate: true });
    if (!payment) throw new NotFoundError('Payment not found.');
    if (payment.version !== version) throw versionConflict();
    if (payment.status !== 'DRAFT') {
      throw invalidState(
        payment.status === 'PENDING_APPROVAL'
          ? `The payment is awaiting approval. Withdraw it before it can be ${verb}.`
          : verb === 'deleted'
            ? 'Only draft payments can be deleted; recorded ones are voided.'
            : 'Only draft payments can be edited.',
      );
    }
    return payment;
  }

  // ---------------------------------------------------------------------------
  // Approval (P4-25, P4-37) and record
  // ---------------------------------------------------------------------------

  submit(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.Create },
      async (tx, ctx) => {
        const payment = await getPayment(tx, ctx.organizationId, id, { forUpdate: true });
        if (!payment) throw new NotFoundError('Payment not found.');
        if (payment.version !== input.version) throw versionConflict();
        if (payment.status !== 'DRAFT') throw invalidState('Only draft payments can be submitted.');
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const planned = await getPlannedAllocations(tx, ctx.organizationId, id);
        const rate = (await this.resolveRate(tx, ctx.organizationId, accounting, payment, true))!;
        const facts = this.facts(payment, planned, rate, accounting);
        const now = this.now;
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: PAYMENT_RECORD_ACTION,
          subjectId: id,
          // No self-approval: neither the preparer nor the submitter.
          excludedUserIds: [...new Set([ctx.userId, payment.createdByUserId])],
          reason: null,
          facts,
          now,
        });
        if (!request) {
          throw invalidState('No approval step applies to this payment; record it directly.');
        }
        const updated = await updatePayment(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: payment.version,
          set: {
            status: 'PENDING_APPROVAL',
            approvalRequestId: request.id,
            submittedByUserId: ctx.userId,
            submittedAt: now,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'vendor_payment.submitted', id, now, origin, {
          approvalRequestId: request.id,
          facts,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  withdraw(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPaymentPermissions.Create },
      async (tx, ctx) => {
        const payment = await getPayment(tx, ctx.organizationId, id, { forUpdate: true });
        if (!payment) throw new NotFoundError('Payment not found.');
        if (payment.version !== input.version) throw versionConflict();
        if (payment.status !== 'PENDING_APPROVAL') {
          throw invalidState('Only a payment awaiting approval can be withdrawn.');
        }
        const now = this.now;
        const request = payment.approvalRequestId
          ? await getApprovalRequest(tx, ctx.organizationId, payment.approvalRequestId, {
              forUpdate: true,
            })
          : undefined;
        if (request?.status === 'pending') {
          await this.approvals.withdrawRequest(tx, ctx.organizationId, request.id, now);
        }
        const updated = await updatePayment(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'PENDING_APPROVAL',
          set: {
            status: 'DRAFT',
            approvalRequestId: null,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'vendor_payment.withdrawn', id, now, origin, {
          approvalRequestId: request?.id ?? null,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  /**
   * Record: one transaction that re-checks the payment under locks (payment, Purchases settings,
   * then bills by ascending id), fixes the rate and account, takes the number and posts through the
   * accounting event. No re-authentication (P4-42); the approval policy controls it.
   */
  record(
    principal: Principal,
    id: string,
    input: { version: number },
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
          {
            key: options.idempotencyKey,
            scope: 'purchases.payment.record',
            request: { id, ...input },
          },
          () => this.recordInTransaction(tx, ctx, id, input, origin),
        ),
    );
  }

  /**
   * Records a draft in the caller's transaction (no request-level idempotency of its own): the
   * single Record action wraps it in `purchases.payment.record`; Pay bills (4B-4) calls it for
   * each batch payment under the batch's key.
   */
  async recordInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    id: string,
    input: { version: number },
    origin: EventOrigin,
  ) {
    // 1. Lock, version and state; then the Purchases settings row (the AP lock is set under it).
    const payment = await getPayment(tx, ctx.organizationId, id, { forUpdate: true });
    if (!payment) throw new NotFoundError('Payment not found.');
    if (payment.version !== input.version) throw versionConflict();
    if (payment.status !== 'DRAFT' && payment.status !== 'PENDING_APPROVAL') {
      throw invalidState(`A ${payment.status.toLowerCase()} payment cannot be recorded.`);
    }
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const purchases = this.requireAp(
      await getPurchasesSettings(tx, ctx.organizationId, { forUpdate: true }),
    );

    // 2. Re-check everything against today's references.
    const issues: ValidationIssue[] = [];
    const vendor = await getVendor(tx, ctx.organizationId, payment.vendorId);
    const party = vendor ? await getParty(tx, ctx.organizationId, vendor.partyId) : undefined;
    if (vendor?.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
      issues.push({ path: 'vendorId', message: 'Archived vendors cannot be paid.' });
    }
    const accountId = payment.paymentAccountId ?? purchases.defaultPaymentAccountId;
    if (!accountId) {
      issues.push({
        path: 'paymentAccountId',
        message: 'Choose a payment account or set the default in Purchases settings.',
      });
    } else {
      const problem = paymentAccountProblem(
        await getAccount(tx, ctx.organizationId, accountId),
        payment.currencyCode,
        accounting.baseCurrency,
      );
      if (problem) issues.push({ path: 'paymentAccountId', message: problem });
    }
    const planned = await getPlannedAllocations(tx, ctx.organizationId, id);
    const bills = new Map(
      (
        await lockBills(tx, ctx.organizationId, [...new Set(planned.map((p) => p.billId))].sort())
      ).map((b) => [b.id, b]),
    );
    const targets = this.checkTargets(
      bills,
      {
        vendorId: payment.vendorId,
        currencyCode: payment.currencyCode,
        date: payment.paymentDate,
        allocations: planned.map((p) => ({ billId: p.billId, amount: p.amount })),
      },
      issues,
    );
    const amount = decimal(payment.amount);
    if (sum(targets.map((t) => t.amount)).gt(amount)) {
      issues.push({ path: 'allocations', message: 'The allocations exceed the amount paid.' });
    }
    if (issues.length) throw new ValidationError(issues, 'The payment cannot be recorded yet.');

    // 3. Rate (fixed now) and approval, re-checked against the recomputed facts (S10-06).
    const rate = (await this.resolveRate(tx, ctx.organizationId, accounting, payment, true))!;
    const approval = await documentApprovalState(
      this.approvals,
      tx,
      ctx.organizationId,
      PAYMENT_RECORD_ACTION,
      payment,
      this.facts(payment, planned, rate, accounting),
    );
    if (!approval.readyToIssue) {
      throw new AppError(
        'APPROVAL_REQUIRED',
        409,
        payment.status === 'DRAFT'
          ? 'This payment needs approval: submit it for approval first.'
          : approval.approvalOutdated
            ? 'The payment now needs further approval. Withdraw it and submit it again.'
            : 'The payment has not received all required approvals.',
      );
    }
    await assertOpenPeriod(tx, ctx.organizationId, payment.paymentDate);

    // 4. Settlement: parts at the payment rate, bills relieved at their historical base.
    const settlement = settlePayment({
      amount,
      rate: rate.rate,
      baseCurrency: accounting.baseCurrency,
      allocations: targets.map((t) => ({
        billId: t.bill.id,
        amount: t.amount,
        open: { amountDue: decimal(t.bill.amountDue!), baseDue: decimal(t.bill.baseDue!) },
      })),
    });
    const netFx = sum(settlement.parts.map((p) => p.fx));
    const fxAccountId = await this.fxAccount(tx, ctx.organizationId, netFx);

    // 5. Number (P4-51): PAY-, not gapless.
    const number = await this.nextNumber(tx, ctx.organizationId);
    const label = `Payment ${number}`;
    const billsById = new Map(targets.map((t) => [t.bill.id, t.bill]));
    const lines: SystemJournalLineInput[] = [
      ...settlement.parts.map((p): SystemJournalLineInput => ({
        accountId: purchases.apAccountId,
        description: `${label} — ${billsById.get(p.billId)?.number ?? ''}`,
        kind: 'normal',
        debit: fixed(p.amount),
        credit: null,
        baseDebit: fixed(p.baseRelieved),
        baseCredit: null,
      })),
    ];
    if (settlement.unallocated.gt(0)) {
      // The excess stays on the AP control account as a vendor debit balance (P4-29).
      lines.push({
        accountId: purchases.apAccountId,
        description: `${label} — prepayment`,
        kind: 'normal',
        debit: fixed(settlement.unallocated),
        credit: null,
        baseDebit: fixed(settlement.baseUnallocated),
        baseCredit: null,
      });
    }
    lines.push({
      accountId: accountId!,
      description: `${label} — ${party!.displayName}`.slice(0, 500),
      kind: 'normal',
      debit: null,
      credit: fixed(amount),
      baseDebit: null,
      baseCredit: fixed(settlement.baseAmount),
    });
    lines.push(...this.fxLines(netFx, fxAccountId, label));
    const journal = this.journalPayload({
      id,
      type: 'payment',
      date: payment.paymentDate,
      description: `${label} — ${party!.displayName}`,
      reference: payment.reference ?? number,
      currencyCode: payment.currencyCode,
      baseCurrency: accounting.baseCurrency,
      rate,
      lines,
      explicitBase: settlement.parts.some((p) => !p.fx.isZero()),
    });
    const now = this.now;
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'purchases',
      eventType: PAYMENT_RECORDED_EVENT,
      eventKey: `payment:${id}:recorded`,
      payload: { paymentId: id, number, journal },
      occurredAt: now,
      origin,
    });
    if (!event.journalId) {
      throw new AppError('CONFLICT', 409, 'The payment was not recorded; try again.');
    }

    // 6. Recorded: immutable from here except the prepayment balance and the void.
    const overridden = accountId !== purchases.defaultPaymentAccountId;
    const recorded = await updatePayment(tx, {
      organizationId: ctx.organizationId,
      id,
      from: payment.status,
      version: payment.version,
      set: {
        status: 'RECORDED',
        number,
        paymentAccountId: accountId!,
        paymentAccountOverridden: overridden,
        exchangeRate: rate.rate.toFixed(10),
        exchangeRateSource: rate.source,
        tableRate: rate.tableRate ? rate.tableRate.toFixed(10) : null,
        baseAmount: fixed(settlement.baseAmount),
        amountUnallocated: fixed(settlement.unallocated),
        baseUnallocated: fixed(settlement.baseUnallocated),
        recordedByUserId: ctx.userId,
        recordedAt: now,
        journalId: event.journalId,
        accountingEventId: event.eventId,
        updatedByUserId: ctx.userId,
        updatedAt: now,
      },
    });
    if (!recorded) throw versionConflict();
    await lockApAccount(tx, ctx.organizationId, now);
    await this.settle(tx, ctx, {
      parts: settlement.parts,
      source: { type: 'payment', id },
      mode: 'payment',
      applicationId: null,
      date: payment.paymentDate,
      currencyCode: payment.currencyCode,
      journalId: event.journalId,
    });
    if (rate.source === 'manual') {
      await this.audit(tx, ctx, 'vendor_payment.rate_overridden', id, now, origin, {
        currencyCode: recorded.currencyCode,
        rate: recorded.exchangeRate,
        tableRate: recorded.tableRate,
        reason: recorded.rateOverrideReason,
      });
    }
    if (overridden) {
      await this.audit(tx, ctx, 'vendor_payment.account_overridden', id, now, origin, {
        paymentAccountId: accountId,
        defaultPaymentAccountId: purchases.defaultPaymentAccountId,
      });
    }
    await this.audit(tx, ctx, 'vendor_payment.recorded', id, now, origin, {
      number,
      vendorId: recorded.vendorId,
      amount: recorded.amount,
      currencyCode: recorded.currencyCode,
      exchangeRate: recorded.exchangeRate,
      exchangeRateSource: recorded.exchangeRateSource,
      paymentAccountId: recorded.paymentAccountId,
      baseAmount: recorded.baseAmount,
      unallocated: recorded.amountUnallocated,
      allocations: settlement.parts.map((p) => ({
        billId: p.billId,
        amount: fixed(p.amount),
        realizedFx: fixed(p.fx),
      })),
      realizedFx: fixed(netFx),
      journalId: event.journalId,
      approvalRequestId: recorded.approvalRequestId,
    });
    return this.detail(tx, ctx, id);
  }

  private async nextNumber(tx: Transaction, organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const taken = await takeNextPurchaseNumber(tx, organizationId, 'vendor_payment');
      if (!taken) {
        throw new ValidationError([
          { path: 'numbering', message: 'Save the Purchases settings before recording payments.' },
        ]);
      }
      if (!(await paymentNumberExists(tx, organizationId, taken.number))) return taken.number;
    }
    throw new AppError(
      'CONFLICT',
      409,
      'Could not find a free payment number; check the numbering.',
    );
  }

  /** The designated Realized FX account, needed only when net realized FX is posted. */
  private async fxAccount(tx: Transaction, organizationId: string, netFx: Decimal) {
    if (netFx.isZero()) return null;
    const account = await getDesignatedAccountId(tx, organizationId, 'REALIZED_FX_GAIN_LOSS');
    if (!account) {
      throw new AppError(
        'DESIGNATION_REQUIRED',
        409,
        'Designate a Realized FX gain/loss account under Accounting before settling at a different rate.',
      );
    }
    return account;
  }

  /** C1: the net realized FX as one base-only line (positive = gain = a base credit). */
  private fxLines(netFx: Decimal, fxAccountId: string | null, label: string) {
    if (netFx.isZero()) return [];
    return [
      {
        accountId: fxAccountId!,
        description: `Realized FX — ${label}`,
        kind: 'base_only' as const,
        debit: null,
        credit: null,
        baseDebit: netFx.isNegative() ? fixed(netFx.negated()) : null,
        baseCredit: netFx.isPositive() ? fixed(netFx) : null,
      },
    ];
  }

  /**
   * The accounting-event journal: an ordinary event journal when every part settles at its own
   * base (the engine's conversion then equals the settlement values), otherwise a `realized_fx`
   * system journal with explicit base amounts and the net base-only FX line (E1, C1).
   */
  private journalPayload(input: {
    id: string;
    type: 'payment' | 'credit_application';
    date: string;
    description: string;
    reference: string;
    currencyCode: string;
    baseCurrency: string;
    rate: { rate: Decimal; source: 'base' | 'table' | 'manual' };
    lines: SystemJournalLineInput[];
    explicitBase: boolean;
  }) {
    const foreign = input.currencyCode !== input.baseCurrency;
    if (input.explicitBase) {
      return {
        system: {
          source: { module: 'purchases', type: 'realized_fx', id: input.id },
          entryDate: input.date,
          description: input.description.slice(0, 500),
          reference: input.reference,
          currency: input.currencyCode,
          exchangeRate: foreign ? input.rate.rate.toFixed(10) : null,
          exchangeRateSource:
            input.rate.source === 'table' ? ('table' as const) : ('manual' as const),
          lines: input.lines,
        },
      };
    }
    return {
      entryDate: input.date,
      description: input.description.slice(0, 500),
      reference: input.reference,
      currency: input.currencyCode,
      exchangeRate: foreign ? input.rate.rate.toFixed(10) : null,
      ...(foreign
        ? { exchangeRateSource: input.rate.source === 'table' ? 'table' : 'manual' }
        : {}),
      sourceRef: { module: 'purchases', type: input.type, id: input.id },
      lines: input.lines.map((l) => ({
        accountId: l.accountId,
        description: l.description,
        debit: l.debit,
        credit: l.credit,
      })),
    };
  }

  /** Allocation rows and the bills' open balances. */
  private async settle(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: {
      parts: readonly ApSettlementPart[];
      source: { type: 'payment' | 'vendor_credit'; id: string };
      mode: 'payment' | 'credit';
      applicationId: string | null;
      date: string;
      currencyCode: string;
      journalId: string;
    },
  ) {
    const now = this.now;
    const rows = await insertPurchasesAllocations(
      tx,
      input.parts.map((p): NewPurchasesAllocation => ({
        organizationId: ctx.organizationId,
        sourceType: input.source.type,
        paymentId: input.source.type === 'payment' ? input.source.id : null,
        vendorCreditId: input.source.type === 'vendor_credit' ? input.source.id : null,
        billId: p.billId,
        mode: input.mode,
        applicationId: input.applicationId,
        allocationDate: input.date,
        currencyCode: input.currencyCode,
        amount: fixed(p.amount),
        baseRelieved: fixed(p.baseRelieved),
        sourceBase: fixed(p.sourceBase),
        fxDifference: fixed(p.fx),
        journalId: input.journalId,
        createdByUserId: ctx.userId,
        createdAt: now,
      })),
    );
    for (const p of input.parts) {
      const updated = await adjustBillBalance(tx, {
        organizationId: ctx.organizationId,
        billId: p.billId,
        amount: fixed(p.amount.negated()),
        base: fixed(p.baseRelieved.negated()),
        now,
        userId: ctx.userId,
      });
      if (!updated) throw invalidState('A bill changed while settling it; try again.');
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Credit application (A2, A3): vendor credits and prepayments to bills
  // ---------------------------------------------------------------------------

  applyCredit(
    principal: Principal,
    input: ApplyApCreditInput,
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
          { key: options.idempotencyKey, scope: 'purchases.credit.apply', request: input },
          () => this.applyCreditInTransaction(tx, ctx, input, origin),
        ),
    );
  }

  /** Locks the credit's source and describes its open credit. */
  private async lockSource(tx: Transaction, organizationId: string, input: ApplyApCreditInput) {
    if (input.sourceType === 'payment') {
      const payment = await getPayment(tx, organizationId, input.sourceId, { forUpdate: true });
      if (!payment) throw new NotFoundError('Payment not found.');
      if (payment.status !== 'RECORDED') {
        throw invalidState('Only a recorded payment has a prepayment to apply.');
      }
      return {
        type: 'payment' as const,
        id: payment.id,
        number: payment.number!,
        vendorId: payment.vendorId,
        currencyCode: payment.currencyCode,
        date: payment.paymentDate,
        open: {
          amountDue: decimal(payment.amountUnallocated!),
          baseDue: decimal(payment.baseUnallocated!),
        },
        rate: {
          rate: decimal(payment.exchangeRate!),
          source: payment.exchangeRateSource === 'table' ? ('table' as const) : ('manual' as const),
        },
        resource: RESOURCE,
      };
    }
    const credit = await getVendorCredit(tx, organizationId, input.sourceId, { forUpdate: true });
    if (!credit) throw new NotFoundError('Vendor credit not found.');
    if (credit.status !== 'POSTED') {
      throw invalidState('Only a posted vendor credit can be applied.');
    }
    return {
      type: 'vendor_credit' as const,
      id: credit.id,
      number: credit.number!,
      vendorId: credit.vendorId,
      currencyCode: credit.currencyCode,
      date: credit.creditDate,
      open: {
        amountDue: decimal(credit.amountUnapplied!),
        baseDue: decimal(credit.baseUnapplied!),
      },
      rate: {
        rate: decimal(credit.exchangeRate!),
        source: credit.exchangeRateSource === 'table' ? ('table' as const) : ('manual' as const),
      },
      resource: 'purchases_vendor_credit',
    };
  }

  /**
   * Applies open credit (a posted vendor credit or a recorded payment's prepayment) to posted bills
   * of the same vendor and currency: AP against AP — each bill relieved at its historical base, the
   * credit released at its own historical base — with the net difference as one realized-FX line.
   */
  private async applyCreditInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: ApplyApCreditInput,
    origin: EventOrigin,
  ) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const purchases = this.requireAp(await getPurchasesSettings(tx, ctx.organizationId));
    if (!isValidIsoDate(input.date)) {
      throw new ValidationError([{ path: 'date', message: 'Enter a valid date (YYYY-MM-DD).' }]);
    }
    const source = await this.lockSource(tx, ctx.organizationId, input);
    const issues: ValidationIssue[] = [];
    if (input.allocations.length === 0) {
      issues.push({ path: 'allocations', message: 'Choose at least one bill.' });
    }
    if (input.date < source.date) {
      issues.push({
        path: 'date',
        message: 'Credit cannot be applied before it was received or paid.',
      });
    }
    const bills = new Map(
      (
        await lockBills(
          tx,
          ctx.organizationId,
          [...new Set(input.allocations.map((a) => a.billId))].sort(),
        )
      ).map((b) => [b.id, b]),
    );
    const targets = this.checkTargets(
      bills,
      {
        vendorId: source.vendorId,
        currencyCode: source.currencyCode,
        date: input.date,
        allocations: input.allocations,
      },
      issues,
    );
    const total = sum(targets.map((t) => t.amount));
    if (total.gt(source.open.amountDue)) {
      issues.push({
        path: 'allocations',
        message: `Only ${source.open.amountDue.toFixed(minorUnits(source.currencyCode))} of credit is available.`,
      });
    }
    if (issues.length) throw new ValidationError(issues);
    await assertOpenPeriod(tx, ctx.organizationId, input.date);

    const parts = settleApCredit({
      source: source.open,
      baseCurrency: accounting.baseCurrency,
      allocations: targets.map((t) => ({
        billId: t.bill.id,
        amount: t.amount,
        open: { amountDue: decimal(t.bill.amountDue!), baseDue: decimal(t.bill.baseDue!) },
      })),
    });
    const released = sum(parts.map((p) => p.sourceBase));
    if (released.isZero()) {
      throw new ValidationError([
        { path: 'allocations', message: 'The amount is too small to apply.' },
      ]);
    }
    const netFx = sum(parts.map((p) => p.fx));
    const fxAccountId = await this.fxAccount(tx, ctx.organizationId, netFx);
    const applicationId = randomUUID();
    const billsById = new Map(targets.map((t) => [t.bill.id, t.bill]));
    const label = `Credit from ${source.number}`;
    const explicitBase = parts.some((p) => !p.fx.isZero());
    // With FX the journal is in the credit's currency with explicit bases; without, in base.
    const lines: SystemJournalLineInput[] = explicitBase
      ? [
          ...parts.map((p): SystemJournalLineInput => ({
            accountId: purchases.apAccountId,
            description: `${label} — ${billsById.get(p.billId)?.number ?? ''}`,
            kind: 'normal',
            debit: fixed(p.amount),
            credit: null,
            baseDebit: fixed(p.baseRelieved),
            baseCredit: null,
          })),
          {
            accountId: purchases.apAccountId,
            description: `${label} — credit released`,
            kind: 'normal',
            debit: null,
            credit: fixed(total),
            baseDebit: null,
            baseCredit: fixed(released),
          },
          ...this.fxLines(netFx, fxAccountId, label),
        ]
      : [
          ...parts.map((p): SystemJournalLineInput => ({
            accountId: purchases.apAccountId,
            description: `${label} — ${billsById.get(p.billId)?.number ?? ''}`,
            kind: 'normal',
            debit: fixed(p.baseRelieved),
            credit: null,
            baseDebit: null,
            baseCredit: null,
          })),
          {
            accountId: purchases.apAccountId,
            description: `${label} — credit released`,
            kind: 'normal',
            debit: null,
            credit: fixed(released),
            baseDebit: null,
            baseCredit: null,
          },
        ];
    const journal = this.journalPayload({
      id: applicationId,
      type: 'credit_application',
      date: input.date,
      description: label,
      reference: source.number,
      currencyCode: explicitBase ? source.currencyCode : accounting.baseCurrency,
      baseCurrency: accounting.baseCurrency,
      rate: source.rate,
      lines,
      explicitBase,
    });
    const now = this.now;
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'purchases',
      eventType: CREDIT_APPLIED_EVENT,
      eventKey: `credit:${source.type}:${source.id}:${applicationId}`,
      payload: { sourceType: source.type, sourceId: source.id, applicationId, journal },
      occurredAt: now,
      origin,
    });
    if (!event.journalId) {
      throw new AppError('CONFLICT', 409, 'The credit was not applied; try again.');
    }
    const allocations = await this.settle(tx, ctx, {
      parts,
      source: { type: source.type, id: source.id },
      mode: 'credit',
      applicationId,
      date: input.date,
      currencyCode: source.currencyCode,
      journalId: event.journalId,
    });
    const remaining = {
      amount: source.open.amountDue.minus(total),
      base: source.open.baseDue.minus(released),
    };
    const updated =
      source.type === 'payment'
        ? await updatePayment(tx, {
            organizationId: ctx.organizationId,
            id: source.id,
            from: 'RECORDED',
            set: {
              amountUnallocated: fixed(remaining.amount),
              baseUnallocated: fixed(remaining.base),
              updatedByUserId: ctx.userId,
              updatedAt: now,
            },
          })
        : await adjustVendorCreditBalance(tx, {
            organizationId: ctx.organizationId,
            vendorCreditId: source.id,
            amount: fixed(total.negated()),
            base: fixed(released.negated()),
            now,
            userId: ctx.userId,
          });
    if (!updated) throw invalidState('The credit changed while applying it; try again.');
    await this.audit(
      tx,
      ctx,
      'ap_credit.applied',
      source.id,
      now,
      origin,
      {
        applicationId,
        sourceType: source.type,
        date: input.date,
        allocations: parts.map((p) => ({
          billId: p.billId,
          amount: fixed(p.amount),
          realizedFx: fixed(p.fx),
        })),
        realizedFx: fixed(netFx),
        journalId: event.journalId,
      },
      source.resource,
    );
    return {
      applicationId,
      sourceType: source.type,
      sourceId: source.id,
      sourceNumber: source.number,
      date: input.date,
      currencyCode: source.currencyCode,
      amountApplied: total.toFixed(minorUnits(source.currencyCode)),
      amountRemaining: remaining.amount.toFixed(minorUnits(source.currencyCode)),
      baseRemaining: fixed(remaining.base),
      journalId: event.journalId,
      allocations: await this.allocationViews(tx, ctx.organizationId, allocations),
    };
  }

  // ---------------------------------------------------------------------------
  // Void (P4-33, P4-42)
  // ---------------------------------------------------------------------------

  /**
   * Voids a recorded payment: reverses its journal and every application funded by its
   * prepayment through the Purchases reversal (P4-09) on their original dates, appends reversing
   * allocations and restores the bills' open balances. Needs `vendor_payments.void` and a recent
   * password confirmation (P4-42). Realized-FX system journals are mirrored by the Purchases
   * reversal, never reversed generically (Decision 80).
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
        const payment = await getPayment(tx, ctx.organizationId, id, { forUpdate: true });
        if (!payment) throw new NotFoundError('Payment not found.');
        if (payment.version !== input.version) throw versionConflict();
        if (payment.status !== 'RECORDED') {
          throw invalidState(
            payment.status === 'VOID'
              ? 'The payment is already void.'
              : 'Only recorded payments can be voided; delete a draft instead.',
          );
        }
        // P4-33: refunds taken from the payment are voided first; there is no cascade (4B-3).
        // Refunds lock the payment row before they are recorded, so none can appear meanwhile.
        if ((await countActiveRefunds(tx, ctx.organizationId, { paymentId: id })) > 0) {
          throw invalidState(
            'This payment has active refunds. Void the refunds taken from this payment first.',
          );
        }
        const reason = input.reason.trim();
        const open = unreversedAllocations(
          await listPurchasesAllocations(tx, ctx.organizationId, { paymentId: id }),
        );
        await lockBills(tx, ctx.organizationId, [...new Set(open.map((a) => a.billId))].sort());

        // Reverse the payment journal and each application journal funded by it (P4-09).
        const reversals = new Map<string, string>();
        const journalIds = [
          payment.journalId!,
          ...new Set(open.filter((a) => a.mode === 'credit').map((a) => a.journalId)),
        ];
        for (const journalId of journalIds) {
          const reversal = await this.journals.reverseSubledgerJournalInTransaction(
            tx,
            ctx,
            'purchases',
            journalId,
            { reason: `Payment ${payment.number} voided: ${reason}` },
            origin,
          );
          reversals.set(journalId, reversal.id);
        }
        const now = this.now;
        await insertPurchasesAllocations(
          tx,
          open.map((a): NewPurchasesAllocation => ({
            organizationId: ctx.organizationId,
            sourceType: a.sourceType,
            paymentId: a.paymentId,
            vendorCreditId: a.vendorCreditId,
            billId: a.billId,
            mode: a.mode,
            applicationId: a.applicationId,
            allocationDate: a.allocationDate,
            currencyCode: a.currencyCode,
            amount: fixed(decimal(a.amount).negated()),
            baseRelieved: fixed(decimal(a.baseRelieved).negated()),
            sourceBase: fixed(decimal(a.sourceBase).negated()),
            fxDifference: fixed(decimal(a.fxDifference).negated()),
            reversesAllocationId: a.id,
            journalId: reversals.get(a.journalId)!,
            createdByUserId: ctx.userId,
            createdAt: now,
          })),
        );
        for (const a of open) {
          const restored = await adjustBillBalance(tx, {
            organizationId: ctx.organizationId,
            billId: a.billId,
            amount: a.amount,
            base: a.baseRelieved,
            now,
            userId: ctx.userId,
          });
          if (!restored) throw invalidState('A bill changed while voiding; try again.');
        }
        const voided = await updatePayment(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'RECORDED',
          version: input.version,
          set: {
            status: 'VOID',
            amountUnallocated: '0',
            baseUnallocated: '0',
            voidedByUserId: ctx.userId,
            voidedAt: now,
            voidReason: reason,
            voidJournalId: reversals.get(payment.journalId!)!,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!voided) throw invalidState('The payment changed while voiding; try again.');
        await this.audit(tx, ctx, 'vendor_payment.voided', id, now, origin, {
          number: payment.number,
          reason,
          reversalJournalIds: [...reversals.values()],
          allocationsReversed: open.length,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }
}
