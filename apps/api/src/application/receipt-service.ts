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
  decimal,
  isSupportedCurrency,
  minorUnits,
  parseAmount,
  parseRate,
} from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  findApplicableRate,
  findPeriodForDate,
  getAccount,
  getDesignatedAccountId,
  isBankOrCash,
  isValidIsoDate,
  type AccountingSettings,
  type SystemJournalLineInput,
} from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getCustomer } from '../modules/customers/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  adjustCreditNoteBalance,
  adjustInvoiceBalance,
  getCreditNote,
  getReceipt,
  getSalesSettings,
  insertAllocations,
  insertReceipt,
  listAllocations,
  listReceipts,
  lockInvoices,
  receiptNumberExists,
  SalesPermissions,
  settleCredit,
  settleReceipt,
  takeNextNumber,
  unreversed,
  updateReceipt,
  type Allocation,
  type Invoice,
  type NewAllocation,
  type Receipt,
  type ReceiptPart,
  type ReceiptStatus,
  type SalesSettings,
} from '../modules/sales/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import { customersMatching } from './sales-documents.js';

/**
 * Receipts, allocations and customer credit (Phase 3B steps 8–11; Decisions 10, 36–40, 42; D2,
 * D3, E1, E2). A receipt is recorded and posted in one transaction through the
 * `sales.receipt_recorded` accounting event: Dr deposit at the receipt rate, Cr AR per invoice at
 * its historical base, Cr AR for the excess (customer credit), and realized FX on the difference
 * as base-only lines of a `realized_fx` system journal (E1). Voids reverse through Sales (E2).
 */

export const RECEIPT_RECORDED_EVENT = 'sales.receipt_recorded';
export const CREDIT_APPLIED_EVENT = 'sales.credit_applied';
const RESOURCE = 'sales_receipt';

export interface ReceiptInput {
  customerId: string;
  receiptDate: string;
  currencyCode?: string | undefined;
  amount: string;
  /** D3: overrides the Sales settings default. */
  depositAccountId?: string | undefined;
  /** D2: overrides the table rate; needs a reason. */
  exchangeRate?: string | undefined;
  rateOverrideReason?: string | undefined;
  reference?: string | null | undefined;
  memo?: string | undefined;
  allocations: { invoiceId: string; amount: string }[];
}

export interface ApplyCreditInput {
  /** The credit's source: a receipt's unallocated amount or an issued credit note. */
  sourceType: 'receipt' | 'credit_note';
  sourceId: string;
  date: string;
  allocations: { invoiceId: string; amount: string }[];
}

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const fixed = (value: Decimal) => value.toFixed(4);
const shown = (value: string, currency: string) => decimal(value).toFixed(minorUnits(currency));

export class ReceiptService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
  ) {
    // The journals Sales posts for receipts and credit applications; receipts have no separate
    // accounting approval (Decision 13: the originating module owns the authorization).
    for (const eventType of [RECEIPT_RECORDED_EVENT, CREDIT_APPLIED_EVENT]) {
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
    ctx: AuthorizationContext,
    action: string,
    receiptId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: RESOURCE,
      resourceId: receiptId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Shared checks
  // ---------------------------------------------------------------------------

  private async requireSales(tx: Transaction, organizationId: string) {
    const sales = await getSalesSettings(tx, organizationId);
    if (!sales?.arAccountId) {
      throw new ValidationError([
        { path: 'arAccountId', message: 'Choose the AR control account in Sales settings first.' },
      ]);
    }
    return sales as SalesSettings & { arAccountId: string };
  }

  private async assertOpenPeriod(tx: Transaction, organizationId: string, date: string) {
    const period = await findPeriodForDate(tx, organizationId, date);
    if (!period)
      throw new AppError('PERIOD_NOT_FOUND', 409, `No accounting period covers ${date}.`);
    if (period.status !== 'OPEN') {
      throw new AppError('PERIOD_CLOSED', 409, `The accounting period ${period.name} is closed.`);
    }
  }

  /**
   * Locks the target invoices (id order) and checks each allocation: an issued invoice of the
   * same customer and currency, dated on or before `date`, for at most its open balance.
   */
  private async lockTargets(
    tx: Transaction,
    organizationId: string,
    input: {
      customerId: string;
      currencyCode: string;
      date: string;
      allocations: readonly { invoiceId: string; amount: string }[];
    },
    issues: ValidationIssue[],
  ) {
    const ids = input.allocations.map((a) => a.invoiceId);
    if (new Set(ids).size !== ids.length) {
      issues.push({ path: 'allocations', message: 'Allocate to each invoice once.' });
    }
    const invoices = new Map(
      (await lockInvoices(tx, organizationId, [...new Set(ids)])).map((i) => [i.id, i]),
    );
    const targets: { invoice: Invoice; amount: Decimal }[] = [];
    input.allocations.forEach((a, i) => {
      const path = `allocations.${i}`;
      const invoice = invoices.get(a.invoiceId);
      const amount = parseAmount(a.amount, input.currencyCode);
      if (!invoice)
        return void issues.push({ path: `${path}.invoiceId`, message: 'Invoice not found.' });
      if (invoice.status !== 'ISSUED') {
        return void issues.push({
          path: `${path}.invoiceId`,
          message: 'Only issued invoices can be paid.',
        });
      }
      if (invoice.customerId !== input.customerId) {
        return void issues.push({
          path: `${path}.invoiceId`,
          message: 'The invoice belongs to another customer.',
        });
      }
      if (invoice.currencyCode !== input.currencyCode) {
        return void issues.push({
          path: `${path}.invoiceId`,
          message: `The invoice is in ${invoice.currencyCode}; a receipt has one currency (Decision 36).`,
        });
      }
      if (invoice.invoiceDate > input.date) {
        return void issues.push({
          path: `${path}.invoiceId`,
          message: 'The invoice is dated after this payment.',
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
      if (amount.value.gt(decimal(invoice.amountDue!))) {
        return void issues.push({
          path: `${path}.amount`,
          message: `The invoice has ${shown(invoice.amountDue!, invoice.currencyCode)} outstanding.`,
        });
      }
      targets.push({ invoice, amount: amount.value });
    });
    return targets;
  }

  /** Journal lines for settled parts: AR relieved per invoice, and realized FX per part. */
  private settlementLines(
    parts: readonly ReceiptPart[],
    invoices: ReadonlyMap<string, Invoice>,
    arAccountId: string,
    fxAccountId: string | null,
    label: string,
  ): SystemJournalLineInput[] {
    const lines: SystemJournalLineInput[] = [];
    for (const part of parts) {
      const number = invoices.get(part.invoiceId)?.number ?? '';
      lines.push({
        accountId: arAccountId,
        description: `${label} — ${number}`,
        kind: 'normal',
        debit: null,
        credit: fixed(part.amount),
        baseDebit: null,
        baseCredit: fixed(part.baseRelieved),
      });
    }
    for (const part of parts) {
      if (part.fx.isZero()) continue;
      const number = invoices.get(part.invoiceId)?.number ?? '';
      lines.push({
        accountId: fxAccountId!,
        description: `Realized FX — ${number}`,
        kind: 'base_only',
        debit: null,
        credit: null,
        baseDebit: part.fx.isNegative() ? fixed(part.fx.negated()) : null,
        baseCredit: part.fx.isPositive() ? fixed(part.fx) : null,
      });
    }
    return lines;
  }

  private async fxAccount(tx: Transaction, organizationId: string, parts: readonly ReceiptPart[]) {
    if (parts.every((p) => p.fx.isZero())) return null;
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

  private async nextNumber(tx: Transaction, organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const taken = await takeNextNumber(tx, organizationId, 'receipt');
      if (!taken) {
        throw new ValidationError([
          { path: 'numbering', message: 'Save the Sales settings before recording receipts.' },
        ]);
      }
      if (!(await receiptNumberExists(tx, organizationId, taken.number))) return taken.number;
    }
    throw new AppError(
      'CONFLICT',
      409,
      'Could not find a free receipt number; check the numbering.',
    );
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private view(receipt: Receipt, customerName: string | null) {
    const c = receipt.currencyCode;
    return {
      id: receipt.id,
      status: receipt.status,
      number: receipt.number,
      customerId: receipt.customerId,
      customerName,
      receiptDate: receipt.receiptDate,
      currencyCode: c,
      amount: shown(receipt.amount, c),
      exchangeRate: receipt.exchangeRate,
      exchangeRateSource: receipt.exchangeRateSource,
      tableRate: receipt.tableRate,
      rateOverrideReason: receipt.rateOverrideReason,
      depositAccountId: receipt.depositAccountId,
      depositAccountOverridden: receipt.depositAccountOverridden,
      baseAmount: receipt.baseAmount,
      amountUnallocated: shown(receipt.amountUnallocated, c),
      baseUnallocated: receipt.baseUnallocated,
      reference: receipt.reference,
      memo: receipt.memo,
      journalId: receipt.journalId,
      voidedAt: receipt.voidedAt?.toISOString() ?? null,
      voidReason: receipt.voidReason,
      voidJournalId: receipt.voidJournalId,
      version: receipt.version,
      createdAt: receipt.createdAt.toISOString(),
    };
  }

  private allocationView(a: Allocation) {
    return {
      id: a.id,
      invoiceId: a.invoiceId,
      mode: a.mode,
      allocationDate: a.allocationDate,
      amount: shown(a.amount, a.currencyCode),
      baseRelieved: a.baseRelieved,
      sourceBase: a.sourceBase,
      fxDifference: a.fxDifference,
      reversesAllocationId: a.reversesAllocationId,
      journalId: a.journalId,
    };
  }

  private async customerName(tx: Transaction, organizationId: string, customerId: string) {
    const customer = await getCustomer(tx, organizationId, customerId);
    const party = customer ? await getParty(tx, organizationId, customer.partyId) : undefined;
    return party?.displayName ?? null;
  }

  private async detail(tx: Transaction, organizationId: string, id: string) {
    const receipt = await getReceipt(tx, organizationId, id);
    if (!receipt) throw new NotFoundError('Receipt not found.');
    const allocations = await listAllocations(tx, organizationId, { receiptId: id });
    return {
      ...this.view(receipt, await this.customerName(tx, organizationId, receipt.customerId)),
      allocations: allocations.map((a) => this.allocationView(a)),
    };
  }

  list(
    principal: Principal,
    query: {
      status?: ReceiptStatus | undefined;
      customerId?: string | undefined;
      search?: string | undefined;
      withCredit?: boolean | undefined;
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.ReceiptsView },
      async (tx, ctx) => {
        let after: { date: string; id: string } | null = null;
        if (query.after) {
          try {
            const parsed = JSON.parse(Buffer.from(query.after, 'base64url').toString('utf8')) as {
              d: string;
              i: string;
            };
            if (!isValidIsoDate(parsed.d) || !/^[0-9a-f-]{36}$/i.test(parsed.i)) throw new Error();
            after = { date: parsed.d, id: parsed.i };
          } catch {
            throw new ValidationError([{ path: 'after', message: 'Invalid cursor.' }]);
          }
        }
        const page = await listReceipts(tx, {
          organizationId: ctx.organizationId,
          status: query.status ?? null,
          customerId: query.customerId ?? null,
          search: query.search?.trim() || null,
          customerIdsIn: customersMatching(ctx.organizationId, query.search?.trim() || null),
          withCredit: query.withCredit === true,
          limit: query.limit,
          after,
        });
        const items = [];
        for (const r of page.items) {
          items.push(this.view(r, await this.customerName(tx, ctx.organizationId, r.customerId)));
        }
        const last = page.items.at(-1);
        return {
          items,
          nextCursor:
            page.hasMore && last
              ? Buffer.from(JSON.stringify({ d: last.receiptDate, i: last.id })).toString(
                  'base64url',
                )
              : null,
        };
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.ReceiptsView },
      (tx, ctx) => this.detail(tx, ctx.organizationId, id),
    );
  }

  // ---------------------------------------------------------------------------
  // Record (steps 8–10)
  // ---------------------------------------------------------------------------

  record(
    principal: Principal,
    input: ReceiptInput,
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
          { key: options.idempotencyKey, scope: 'sales.receipt.record', request: input },
          () => this.recordInTransaction(tx, ctx, input, origin),
        ),
    );
  }

  private async recordInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: ReceiptInput,
    origin: EventOrigin,
  ) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const sales = await this.requireSales(tx, ctx.organizationId);
    const issues: ValidationIssue[] = [];
    if (!isValidIsoDate(input.receiptDate)) {
      throw new ValidationError([
        { path: 'receiptDate', message: 'Enter a valid date (YYYY-MM-DD).' },
      ]);
    }
    const customer = await getCustomer(tx, ctx.organizationId, input.customerId);
    const party = customer ? await getParty(tx, ctx.organizationId, customer.partyId) : undefined;
    if (!customer)
      throw new ValidationError([{ path: 'customerId', message: 'Customer not found.' }]);
    if (customer.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
      issues.push({
        path: 'customerId',
        message: 'Archived customers cannot record new receipts.',
      });
    }
    const currencyCode = input.currencyCode ?? customer.currencyCode;
    if (!isSupportedCurrency(currencyCode)) {
      throw new ValidationError([{ path: 'currencyCode', message: 'Unsupported currency.' }]);
    }
    const amount = parseAmount(input.amount, currencyCode);
    if (!amount.ok) {
      throw new ValidationError([
        {
          path: 'amount',
          message:
            amount.problem === 'too_many_decimals'
              ? `Use at most ${minorUnits(currencyCode)} decimal places.`
              : 'Enter an amount greater than zero.',
        },
      ]);
    }

    // Rate (Decision 37, D2): the table rate on the receipt date, or an override with a reason.
    const rate = await this.resolveRate(
      tx,
      ctx.organizationId,
      accounting,
      {
        currencyCode,
        date: input.receiptDate,
        override: input.exchangeRate,
        reason: input.rateOverrideReason,
      },
      issues,
    );

    // Deposit account (Decision 42, D3).
    const depositAccountId = input.depositAccountId ?? sales.defaultDepositAccountId;
    if (!depositAccountId) {
      issues.push({
        path: 'depositAccountId',
        message: 'Choose a deposit account or set the default in Sales settings.',
      });
    } else {
      const account = await getAccount(tx, ctx.organizationId, depositAccountId);
      if (!account) issues.push({ path: 'depositAccountId', message: 'Account not found.' });
      else if (account.status !== 'ACTIVE' || !account.isLeaf || account.isControlAccount) {
        issues.push({ path: 'depositAccountId', message: 'Choose an active posting account.' });
      } else if (!isBankOrCash(account.subtype)) {
        issues.push({
          path: 'depositAccountId',
          message: 'Choose a bank or cash account (Decision 42).',
        });
      } else if (
        account.currencyCode !== currencyCode &&
        account.currencyCode !== accounting.baseCurrency
      ) {
        issues.push({
          path: 'depositAccountId',
          message:
            currencyCode === accounting.baseCurrency
              ? `The deposit account must be in ${currencyCode}.`
              : `The deposit account must be in ${currencyCode} or ${accounting.baseCurrency}.`,
        });
      }
    }

    const targets = await this.lockTargets(
      tx,
      ctx.organizationId,
      {
        customerId: customer.id,
        currencyCode,
        date: input.receiptDate,
        allocations: input.allocations,
      },
      issues,
    );
    const allocated = targets.reduce((sum, t) => sum.plus(t.amount), decimal(0));
    if (amount.ok && allocated.gt(amount.value)) {
      issues.push({ path: 'allocations', message: 'The allocations exceed the amount received.' });
    }
    if (issues.length) throw new ValidationError(issues);
    await this.assertOpenPeriod(tx, ctx.organizationId, input.receiptDate);

    const settlement = settleReceipt({
      amount: amount.value,
      rate: rate!.rate,
      baseCurrency: accounting.baseCurrency,
      allocations: targets.map((t) => ({
        invoiceId: t.invoice.id,
        amount: t.amount,
        open: { amountDue: decimal(t.invoice.amountDue!), baseDue: decimal(t.invoice.baseDue!) },
      })),
    });
    const fxAccountId = await this.fxAccount(tx, ctx.organizationId, settlement.parts);
    const id = randomUUID();
    const number = await this.nextNumber(tx, ctx.organizationId);
    const invoices = new Map(targets.map((t) => [t.invoice.id, t.invoice]));
    const label = `Receipt ${number}`;
    const lines: SystemJournalLineInput[] = [
      {
        accountId: depositAccountId!,
        description: `${label} — ${party!.displayName}`.slice(0, 500),
        kind: 'normal',
        debit: fixed(amount.value),
        credit: null,
        baseDebit: fixed(settlement.baseAmount),
        baseCredit: null,
      },
      ...this.settlementLines(settlement.parts, invoices, sales.arAccountId, fxAccountId, label),
    ];
    if (settlement.unallocated.gt(0)) {
      // The excess stays on the AR control account as customer credit (Decision 38).
      lines.splice(1 + settlement.parts.length, 0, {
        accountId: sales.arAccountId,
        description: `${label} — customer credit`,
        kind: 'normal',
        debit: null,
        credit: fixed(settlement.unallocated),
        baseDebit: null,
        baseCredit: fixed(settlement.baseUnallocated),
      });
    }
    const journal = this.journalPayload({
      id,
      type: 'receipt',
      date: input.receiptDate,
      description: `${label} — ${party!.displayName}`,
      reference: input.reference?.trim() || number,
      currencyCode,
      baseCurrency: accounting.baseCurrency,
      rate: rate!,
      lines,
    });
    const now = this.now;
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'sales',
      eventType: RECEIPT_RECORDED_EVENT,
      eventKey: `receipt:${id}:recorded`,
      payload: { receiptId: id, number, journal },
      occurredAt: now,
      origin,
    });
    const depositDefault = sales.defaultDepositAccountId;
    const receipt = await insertReceipt(tx, {
      id,
      organizationId: ctx.organizationId,
      number,
      customerId: customer.id,
      receiptDate: input.receiptDate,
      currencyCode,
      amount: fixed(amount.value),
      exchangeRate: rate!.rate.toFixed(10),
      exchangeRateSource: rate!.source,
      tableRate: rate!.source === 'manual' ? (rate!.tableRate?.toFixed(10) ?? null) : null,
      rateOverrideReason: rate!.source === 'manual' ? input.rateOverrideReason!.trim() : null,
      depositAccountId: depositAccountId!,
      depositAccountOverridden: depositAccountId !== depositDefault,
      baseAmount: fixed(settlement.baseAmount),
      amountUnallocated: fixed(settlement.unallocated),
      baseUnallocated: fixed(settlement.baseUnallocated),
      reference: input.reference?.trim() || null,
      memo: input.memo?.trim() ?? '',
      journalId: event.journalId!,
      accountingEventId: event.eventId,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedByUserId: ctx.userId,
      updatedAt: now,
    });
    await this.applyParts(tx, ctx, {
      parts: settlement.parts,
      source: { type: 'receipt', id },
      mode: 'receipt',
      date: input.receiptDate,
      currencyCode,
      journalId: event.journalId!,
    });
    await this.audit(tx, ctx, 'receipt.recorded', id, origin, {
      number,
      customerId: customer.id,
      amount: receipt.amount,
      currencyCode,
      exchangeRate: receipt.exchangeRate,
      exchangeRateSource: receipt.exchangeRateSource,
      // D2 / D3: overrides are audited with what they replaced.
      tableRate: rate!.tableRate?.toFixed(10) ?? null,
      rateOverrideReason: receipt.rateOverrideReason,
      depositAccountId: receipt.depositAccountId,
      defaultDepositAccountId: depositDefault,
      depositAccountOverridden: receipt.depositAccountOverridden,
      baseAmount: receipt.baseAmount,
      unallocated: receipt.amountUnallocated,
      allocations: settlement.parts.map((p) => ({
        invoiceId: p.invoiceId,
        amount: fixed(p.amount),
        realizedFx: fixed(p.fx),
      })),
      journalId: event.journalId,
    });
    return this.detail(tx, ctx.organizationId, id);
  }

  private async resolveRate(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    input: {
      currencyCode: string;
      date: string;
      override: string | undefined;
      reason: string | undefined;
    },
    issues: ValidationIssue[],
  ): Promise<{
    rate: Decimal;
    source: 'base' | 'table' | 'manual';
    tableRate: Decimal | null;
  } | null> {
    if (input.currencyCode === accounting.baseCurrency) {
      if (input.override !== undefined) {
        issues.push({
          path: 'exchangeRate',
          message: 'Base-currency receipts have no exchange rate.',
        });
      }
      return { rate: decimal(1), source: 'base', tableRate: null };
    }
    const table = await findApplicableRate(tx, {
      organizationId,
      fromCurrency: input.currencyCode,
      toCurrency: accounting.baseCurrency,
      onDate: input.date,
    });
    const tableRate = table ? decimal(table.rate) : null;
    if (input.override !== undefined) {
      const parsed = parseRate(input.override);
      if (!parsed.ok) {
        issues.push({
          path: 'exchangeRate',
          message: 'Rates are positive decimals with at most 10 decimal places.',
        });
        return null;
      }
      if (!input.reason?.trim()) {
        issues.push({
          path: 'rateOverrideReason',
          message: 'Give a reason for overriding the rate (Decision 37).',
        });
        return null;
      }
      return { rate: parsed.value, source: 'manual', tableRate };
    }
    if (!tableRate) {
      throw new AppError(
        'EXCHANGE_RATE_REQUIRED',
        409,
        `An exchange rate from ${input.currencyCode} to ${accounting.baseCurrency} is required for ${input.date}.`,
      );
    }
    return { rate: tableRate, source: 'table', tableRate };
  }

  /**
   * The accounting-event journal: an ordinary event journal when no realized FX arises (the
   * engine's conversion then equals the settlement values), otherwise a `realized_fx` system
   * journal with explicit base amounts and base-only FX lines (E1).
   */
  private journalPayload(input: {
    id: string;
    type: 'receipt' | 'credit_application';
    date: string;
    description: string;
    reference: string;
    currencyCode: string;
    baseCurrency: string;
    rate: { rate: Decimal; source: 'base' | 'table' | 'manual' };
    lines: SystemJournalLineInput[];
  }) {
    const foreign = input.currencyCode !== input.baseCurrency;
    if (input.lines.some((l) => l.kind === 'base_only')) {
      return {
        system: {
          source: { module: 'sales', type: 'realized_fx', id: input.id },
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
      sourceRef: { module: 'sales', type: input.type, id: input.id },
      lines: input.lines.map((l) => ({
        accountId: l.accountId,
        description: l.description,
        debit: l.debit,
        credit: l.credit,
      })),
    };
  }

  /** Allocation rows and the invoices' open balances. */
  private async applyParts(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: {
      parts: readonly ReceiptPart[];
      source: { type: 'receipt' | 'credit_note'; id: string };
      mode: 'receipt' | 'credit';
      date: string;
      currencyCode: string;
      journalId: string;
    },
  ) {
    const now = this.now;
    const rows = await insertAllocations(
      tx,
      input.parts.map((p): NewAllocation => ({
        organizationId: ctx.organizationId,
        sourceType: input.source.type,
        receiptId: input.source.type === 'receipt' ? input.source.id : null,
        creditNoteId: input.source.type === 'credit_note' ? input.source.id : null,
        invoiceId: p.invoiceId,
        mode: input.mode,
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
      const updated = await adjustInvoiceBalance(tx, {
        organizationId: ctx.organizationId,
        invoiceId: p.invoiceId,
        amount: fixed(p.amount.negated()),
        base: fixed(p.baseRelieved.negated()),
        now,
        userId: ctx.userId,
      });
      if (!updated) throw invalidState('An invoice changed while allocating; try again.');
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Customer credit (step 9, Decisions 38, 39; credit notes, step 12)
  // ---------------------------------------------------------------------------

  applyCredit(
    principal: Principal,
    input: ApplyCreditInput,
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
          { key: options.idempotencyKey, scope: 'sales.credit.apply', request: input },
          () => this.applyCreditInTransaction(tx, ctx, input, origin),
        ),
    );
  }

  /** Locks the credit's source and describes its open credit. */
  private async lockSource(tx: Transaction, organizationId: string, input: ApplyCreditInput) {
    if (input.sourceType === 'receipt') {
      const receipt = await getReceipt(tx, organizationId, input.sourceId, { forUpdate: true });
      if (!receipt) throw new NotFoundError('Receipt not found.');
      if (receipt.status !== 'RECORDED') throw invalidState('A void receipt has no credit.');
      return {
        type: 'receipt' as const,
        id: receipt.id,
        number: receipt.number,
        customerId: receipt.customerId,
        currencyCode: receipt.currencyCode,
        date: receipt.receiptDate,
        open: {
          amountDue: decimal(receipt.amountUnallocated),
          baseDue: decimal(receipt.baseUnallocated),
        },
        rate: {
          rate: decimal(receipt.exchangeRate),
          source: receipt.exchangeRateSource === 'table' ? ('table' as const) : ('manual' as const),
        },
      };
    }
    const note = await getCreditNote(tx, organizationId, input.sourceId, { forUpdate: true });
    if (!note) throw new NotFoundError('Credit note not found.');
    if (note.status !== 'ISSUED')
      throw invalidState('Only an issued credit note has credit to apply.');
    return {
      type: 'credit_note' as const,
      id: note.id,
      number: note.number!,
      customerId: note.customerId,
      currencyCode: note.currencyCode,
      date: note.creditDate,
      open: { amountDue: decimal(note.amountUnapplied!), baseDue: decimal(note.baseUnapplied!) },
      rate: {
        rate: decimal(note.exchangeRate!),
        source: note.exchangeRateSource === 'base' ? ('manual' as const) : ('table' as const),
      },
    };
  }

  /**
   * Applies open customer credit (a receipt's excess or an issued credit note) to invoices of
   * the same customer and currency, in the caller's transaction: AR against AR (§Q) — the credit
   * released at its historical base, each invoice relieved at its own — with any difference as
   * realized FX (E1). Credit notes linked to an invoice use this at issue.
   */
  async applyCreditInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: ApplyCreditInput,
    origin: EventOrigin,
  ) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const sales = await this.requireSales(tx, ctx.organizationId);
    if (!isValidIsoDate(input.date)) {
      throw new ValidationError([{ path: 'date', message: 'Enter a valid date (YYYY-MM-DD).' }]);
    }
    const source = await this.lockSource(tx, ctx.organizationId, input);
    const issues: ValidationIssue[] = [];
    if (input.date < source.date) {
      issues.push({
        path: 'date',
        message: 'Credit cannot be applied before it was received or issued.',
      });
    }
    const targets = await this.lockTargets(
      tx,
      ctx.organizationId,
      {
        customerId: source.customerId,
        currencyCode: source.currencyCode,
        date: input.date,
        allocations: input.allocations,
      },
      issues,
    );
    const total = targets.reduce((sum, t) => sum.plus(t.amount), decimal(0));
    if (total.gt(source.open.amountDue)) {
      issues.push({
        path: 'allocations',
        message: `Only ${source.open.amountDue.toFixed(minorUnits(source.currencyCode))} of credit is available.`,
      });
    }
    if (issues.length) throw new ValidationError(issues);
    await this.assertOpenPeriod(tx, ctx.organizationId, input.date);

    const parts = settleCredit({
      source: source.open,
      baseCurrency: accounting.baseCurrency,
      allocations: targets.map((t) => ({
        invoiceId: t.invoice.id,
        amount: t.amount,
        open: { amountDue: decimal(t.invoice.amountDue!), baseDue: decimal(t.invoice.baseDue!) },
      })),
    });
    const fxAccountId = await this.fxAccount(tx, ctx.organizationId, parts);
    const id = randomUUID();
    const invoices = new Map(targets.map((t) => [t.invoice.id, t.invoice]));
    const label = `Credit from ${source.number}`;
    const released = parts.reduce((sum, p) => sum.plus(p.sourceBase), decimal(0));
    if (released.isZero()) {
      throw new ValidationError([
        { path: 'allocations', message: 'The amount is too small to apply.' },
      ]);
    }
    const hasFx = parts.some((p) => !p.fx.isZero());
    // With FX the journal is in the credit's currency with explicit bases; without, in base.
    const lines: SystemJournalLineInput[] = hasFx
      ? [
          {
            accountId: sales.arAccountId,
            description: `${label} — credit released`,
            kind: 'normal',
            debit: fixed(total),
            credit: null,
            baseDebit: fixed(released),
            baseCredit: null,
          },
          ...this.settlementLines(parts, invoices, sales.arAccountId, fxAccountId, label),
        ]
      : [
          {
            accountId: sales.arAccountId,
            description: `${label} — credit released`,
            kind: 'normal',
            debit: fixed(released),
            credit: null,
            baseDebit: null,
            baseCredit: null,
          },
          ...parts.map((p): SystemJournalLineInput => ({
            accountId: sales.arAccountId,
            description: `${label} — ${invoices.get(p.invoiceId)?.number ?? ''}`,
            kind: 'normal',
            debit: null,
            credit: fixed(p.baseRelieved),
            baseDebit: null,
            baseCredit: null,
          })),
        ];
    const journal = this.journalPayload({
      id,
      type: 'credit_application',
      date: input.date,
      description: label,
      reference: source.number,
      currencyCode: hasFx ? source.currencyCode : accounting.baseCurrency,
      baseCurrency: accounting.baseCurrency,
      rate: source.rate,
      lines,
    });
    const now = this.now;
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'sales',
      eventType: CREDIT_APPLIED_EVENT,
      eventKey: `credit:${source.type}:${source.id}:${id}`,
      payload: { sourceType: source.type, sourceId: source.id, applicationId: id, journal },
      occurredAt: now,
      origin,
    });
    const allocations = await this.applyParts(tx, ctx, {
      parts,
      source: { type: source.type, id: source.id },
      mode: 'credit',
      date: input.date,
      currencyCode: source.currencyCode,
      journalId: event.journalId!,
    });
    const remaining = {
      amount: source.open.amountDue.minus(total),
      base: source.open.baseDue.minus(released),
    };
    const updated =
      source.type === 'receipt'
        ? await updateReceipt(tx, {
            organizationId: ctx.organizationId,
            id: source.id,
            set: {
              amountUnallocated: fixed(remaining.amount),
              baseUnallocated: fixed(remaining.base),
              updatedByUserId: ctx.userId,
              updatedAt: now,
            },
          })
        : await adjustCreditNoteBalance(tx, {
            organizationId: ctx.organizationId,
            id: source.id,
            amount: fixed(total.negated()),
            base: fixed(released.negated()),
            now,
            userId: ctx.userId,
          });
    if (!updated) throw invalidState('The credit changed while applying it; try again.');
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'customer_credit.applied',
      resourceType: source.type === 'receipt' ? RESOURCE : 'sales_credit_note',
      resourceId: source.id,
      metadata: {
        applicationId: id,
        date: input.date,
        allocations: parts.map((p) => ({
          invoiceId: p.invoiceId,
          amount: fixed(p.amount),
          realizedFx: fixed(p.fx),
        })),
        journalId: event.journalId,
      },
      origin,
    });
    return {
      applicationId: id,
      sourceType: source.type,
      sourceId: source.id,
      sourceNumber: source.number,
      date: input.date,
      currencyCode: source.currencyCode,
      amountApplied: total.toFixed(minorUnits(source.currencyCode)),
      amountRemaining: remaining.amount.toFixed(minorUnits(source.currencyCode)),
      baseRemaining: fixed(remaining.base),
      journalId: event.journalId,
      allocations: allocations.map((a) => this.allocationView(a)),
    };
  }

  // ---------------------------------------------------------------------------
  // Void (step 11, Decision 40)
  // ---------------------------------------------------------------------------

  /**
   * Voids a receipt: reverses its journal and every credit application made from it through
   * Sales (E2), writes reversing allocations and restores the invoices' open balances. Needs
   * `receipts.void`, a recent password confirmation and open periods on the original dates.
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
        const receipt = await getReceipt(tx, ctx.organizationId, id, { forUpdate: true });
        if (!receipt) throw new NotFoundError('Receipt not found.');
        if (receipt.version !== input.version) {
          throw new ConflictError(
            'VERSION_CONFLICT',
            'The receipt changed; reload it and try again.',
          );
        }
        if (receipt.status !== 'RECORDED') throw invalidState('The receipt is already void.');
        const reason = input.reason.trim();
        const open = unreversed(await listAllocations(tx, ctx.organizationId, { receiptId: id }));
        await lockInvoices(
          tx,
          ctx.organizationId,
          [...new Set(open.map((a) => a.invoiceId))].sort(),
        );

        // Reverse the receipt journal and each credit application journal (E2).
        const reversals = new Map<string, string>();
        const journalIds = [
          receipt.journalId,
          ...new Set(open.filter((a) => a.mode === 'credit').map((a) => a.journalId)),
        ];
        for (const journalId of journalIds) {
          const reversal = await this.journals.reverseSalesJournalInTransaction(
            tx,
            ctx,
            journalId,
            { reason: `Receipt ${receipt.number} voided: ${reason}` },
            origin,
          );
          reversals.set(journalId, reversal.id);
        }
        const now = this.now;
        await insertAllocations(
          tx,
          open.map((a): NewAllocation => ({
            organizationId: ctx.organizationId,
            sourceType: a.sourceType,
            receiptId: a.receiptId,
            creditNoteId: a.creditNoteId,
            invoiceId: a.invoiceId,
            mode: a.mode,
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
          const restored = await adjustInvoiceBalance(tx, {
            organizationId: ctx.organizationId,
            invoiceId: a.invoiceId,
            amount: a.amount,
            base: a.baseRelieved,
            now,
            userId: ctx.userId,
          });
          if (!restored) throw invalidState('An invoice changed while voiding; try again.');
        }
        const voided = await updateReceipt(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'VOID',
            amountUnallocated: '0',
            baseUnallocated: '0',
            voidedByUserId: ctx.userId,
            voidedAt: now,
            voidReason: reason,
            voidJournalId: reversals.get(receipt.journalId)!,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!voided) throw invalidState('The receipt changed while voiding; try again.');
        await this.audit(tx, ctx, 'receipt.voided', id, origin, {
          number: receipt.number,
          reason,
          reversalJournalIds: [...reversals.values()],
          allocationsReversed: open.length,
        });
        return this.detail(tx, ctx.organizationId, id);
      },
    );
  }
}
