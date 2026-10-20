import { Decimal } from 'decimal.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal, parseRate } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  getAccount,
  getJournalLines,
  isValidIsoDate,
  type AccountingSettings,
} from '../modules/accounting/index.js';
import { getApprovalRequest } from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { type Discount } from '../modules/documents/index.js';
import {
  countAttachments,
  evaluateExpensePolicies,
  listExpensePolicies,
} from '../modules/expense-policies/index.js';
import { getParty, partyIdsMatching } from '../modules/parties/index.js';
import {
  deleteExpense,
  expenseNumberExists,
  ExpensePermissions,
  findDuplicateExpenseReferences,
  getExpense,
  getExpenseLines,
  getPurchasesSettings,
  insertExpense,
  listExpenses,
  lockDuplicateCheck,
  replaceExpenseLines,
  takeNextPurchaseNumber,
  updateExpense,
  type Expense,
  type ExpenseLine,
  type ExpenseStatus,
  type PurchasesSettings,
} from '../modules/purchases/index.js';
import type { TaxTreatment } from '../modules/tax/index.js';
import { getVendor, vendorIdsOfParties } from '../modules/vendors/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { ApprovalService } from './approval-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { JournalService } from './journal-service.js';
import type { InventoryHooks } from './inventory-hooks.js';
import { withOrganization } from './organization-service.js';
import {
  inputTaxCheck,
  purchaseDocumentPosting,
  purchaseLinesAsInput,
  resolvePurchaseDocument,
  stripPurchaseLines,
  type PurchaseLineInput,
  type ResolvedPurchaseDocument,
} from './purchase-documents.js';
import {
  assertOpenPeriod,
  assertRequiredDimensions,
  documentApprovalState,
  journalLine,
  shownMoney,
} from './sales-documents.js';
import { paymentAccountProblem } from './vendor-payment-service.js';

/**
 * Direct expenses, "spend money" (Phase 4B-9; ADR 0004 P4-37, P4-39, P4-42, P4-44, P4-50, P4-51).
 *
 * An expense is paid at once: Dr each line's account (net plus non-recoverable tax) / Dr input tax
 * (recoverable) / Cr the bank, cash or credit-card account. It never touches the AP control
 * account. Drafts are edited under optimistic concurrency and every amount is computed here.
 * Submitting opens an approval request when a policy step matches (action `purchases.expense.post`,
 * type `expense`, the base amount paid); approval only authorizes, and post (`expenses.create`)
 * is one transaction: lock, recompute with today's references, re-check approval against the
 * recomputed facts (S10-06), check the period, the payment account (P4-26, Decision 42), required
 * dimensions and input tax accounts, fix the rate, take the EXP- number (P4-51), snapshot tax and
 * post through the `purchases.expense_posted` accounting event. A posted expense is voided by
 * reversing its journal through Purchases (P4-09; `expenses.void` and re-authentication, P4-42).
 * Purchases never writes ledger tables.
 */

export const EXPENSE_POST_ACTION = 'purchases.expense.post';
export const EXPENSE_POSTED_EVENT = 'purchases.expense_posted';
const RESOURCE = 'purchases_expense';

export interface ExpenseDraftInput {
  vendorId: string;
  expenseDate: string;
  vendorReference?: string | null | undefined;
  currencyCode?: string | undefined;
  paymentAccountId?: string | null | undefined;
  rateOverride?: string | null | undefined;
  rateOverrideReason?: string | null | undefined;
  taxTreatment?: TaxTreatment | undefined;
  discount?: Discount | null | undefined;
  memo?: string | undefined;
  dimensionValueIds?: string[] | undefined;
  lines: PurchaseLineInput[];
}

type ResolvedExpense = ResolvedPurchaseDocument & {
  header: ResolvedPurchaseDocument['header'] & {
    expenseDate: string;
    vendorReference: string | null;
    paymentAccountId: string | null;
    rateOverride: string | null;
    rateOverrideReason: string | null;
  };
};

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'This expense was changed by someone else. Reload it and apply your changes again.',
  );

function encodeCursor(expense: Expense) {
  return Buffer.from(JSON.stringify({ d: expense.expenseDate, i: expense.id })).toString(
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

async function vendorName(tx: Transaction, organizationId: string, vendorId: string) {
  const vendor = await getVendor(tx, organizationId, vendorId);
  const party = vendor ? await getParty(tx, organizationId, vendor.partyId) : undefined;
  return party?.displayName ?? null;
}

export class ExpenseService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly approvals: ApprovalService,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
    private readonly inventory?: InventoryHooks,
  ) {
    approvals.register({
      actionKey: EXPENSE_POST_ACTION,
      label: 'Approve expenses before posting',
      subjectType: RESOURCE,
      approverPermission: ExpensePermissions.Approve,
      decisionRequiresReauth: false,
      // P4-37: the base amount paid; the transaction type is `expense`.
      conditions: { amount: true, transactionTypes: ['expense'] },
      onApproved: async (tx, { request, authz, now, origin }) => {
        // Approval authorizes; the expense stays pending until someone posts it.
        await this.audit(tx, authz, 'expense.approved', request.subjectId, now, origin, {
          approvalRequestId: request.id,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        if (!comment?.trim()) {
          throw new ValidationError([
            { path: 'comment', message: 'Give a reason for rejecting the expense.' },
          ]);
        }
        const expense = await updateExpense(tx, {
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
        if (!expense) throw invalidState('The expense is no longer awaiting approval.');
        await this.audit(tx, authz, 'expense.rejected', expense.id, now, origin, {
          approvalRequestId: request.id,
          comment: comment.trim(),
        });
      },
    });
    // The journal a posted expense posts; Purchases owns the approval (Decision 13).
    journals.registerEventHandler(EXPENSE_POSTED_EVENT, (event) => event.payload.journal as never, {
      domainApproval: true,
    });
  }

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: Pick<AuthorizationContext, 'organizationId' | 'userId'>,
    action: string,
    expenseId: string,
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
      resourceId: expenseId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /** The shared purchase rules plus the payment account, reference and rate override. */
  private async resolve(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    purchases: PurchasesSettings | undefined,
    input: ExpenseDraftInput,
    existing?: { expense: Expense; lines: readonly ExpenseLine[] },
  ): Promise<ResolvedExpense> {
    const resolved = await resolvePurchaseDocument(
      tx,
      organizationId,
      accounting,
      purchases,
      { ...input, date: input.expenseDate },
      {
        datePath: 'expenseDate',
        noun: 'expenses',
        existing: existing && {
          vendorId: existing.expense.vendorId,
          dimensionValueIds: existing.expense.dimensionValueIds,
          lines: existing.lines,
        },
      },
    );
    const issues: ValidationIssue[] = [];
    const vendorReference = input.vendorReference?.trim() || null;
    // P4-26, Decision 42: a bank, cash or credit-card account in the expense or base currency.
    const paymentAccountId = input.paymentAccountId ?? null;
    if (paymentAccountId) {
      const problem = paymentAccountProblem(
        await getAccount(tx, organizationId, paymentAccountId),
        resolved.header.currencyCode,
        accounting.baseCurrency,
      );
      if (problem) issues.push({ path: 'paymentAccountId', message: problem });
    }
    // P4-16 parity: a manual rate needs a reason and a foreign-currency expense.
    const rateOverride = input.rateOverride ?? null;
    const rateOverrideReason = input.rateOverrideReason?.trim() || null;
    if (rateOverride !== null) {
      const parsed = parseRate(rateOverride);
      if (!parsed.ok) {
        issues.push({
          path: 'rateOverride',
          message: 'Rates are positive decimal strings with at most 10 decimals.',
        });
      } else if (resolved.header.currencyCode === accounting.baseCurrency) {
        issues.push({
          path: 'rateOverride',
          message: 'A base-currency expense has no exchange rate to override.',
        });
      }
      if (!rateOverrideReason) {
        issues.push({
          path: 'rateOverrideReason',
          message: 'Give a reason for the manual exchange rate.',
        });
      }
    } else if (rateOverrideReason) {
      issues.push({ path: 'rateOverride', message: 'Enter the manual rate the reason is for.' });
    }
    if (issues.length) throw new ValidationError(issues);
    return {
      ...resolved,
      header: {
        ...resolved.header,
        expenseDate: input.expenseDate,
        vendorReference,
        paymentAccountId,
        rateOverride: rateOverride === null ? null : decimal(rateOverride).toFixed(10),
        rateOverrideReason: rateOverride === null ? null : rateOverrideReason,
      },
    };
  }

  private inputOf(expense: Expense, lines: readonly ExpenseLine[]): ExpenseDraftInput {
    return {
      vendorId: expense.vendorId,
      expenseDate: expense.expenseDate,
      vendorReference: expense.vendorReference,
      currencyCode: expense.currencyCode,
      paymentAccountId: expense.paymentAccountId,
      rateOverride: expense.rateOverride,
      rateOverrideReason: expense.rateOverrideReason,
      taxTreatment: expense.taxTreatment,
      discount: expense.discountType
        ? { type: expense.discountType, value: expense.discountValue! }
        : null,
      memo: expense.memo,
      dimensionValueIds: expense.dimensionValueIds,
      lines: purchaseLinesAsInput(lines),
    };
  }

  /**
   * The journal an expense would post: the shared purchase builder with the payment account in
   * the credit role (the account the bill builder uses for AP). The paid account is the
   * expense's own, else the Purchases default payment account.
   */
  private posting(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    purchases: PurchasesSettings | undefined,
    expense: Expense,
    lines: readonly ExpenseLine[],
  ) {
    const paidFrom = expense.paymentAccountId ?? purchases?.defaultPaymentAccountId ?? null;
    return purchaseDocumentPosting(
      tx,
      organizationId,
      accounting,
      purchases,
      {
        direction: 'bill',
        label: `Expense ${expense.number ?? '(draft)'}`,
        transactionType: 'expense',
        date: expense.expenseDate,
        currencyCode: expense.currencyCode,
        dimensionValueIds: expense.dimensionValueIds,
        rateOverride: expense.rateOverride,
      },
      lines,
    ).then((posting) => ({
      ...posting,
      // The bill builder's AP (payable) credit is the paid account here; no AP is touched.
      journal: {
        ...posting.journal,
        lines: posting.journal.lines.map((l) =>
          l.role === 'payable' ? { ...l, accountId: paidFrom } : l,
        ),
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private summary(expense: Expense, name: string | null) {
    const c = expense.currencyCode;
    return {
      id: expense.id,
      status: expense.status,
      number: expense.number,
      vendorId: expense.vendorId,
      vendorName: name,
      vendorReference: expense.vendorReference,
      expenseDate: expense.expenseDate,
      currencyCode: c,
      paymentAccountId: expense.paymentAccountId,
      subtotal: shownMoney(expense.subtotal, c),
      discountTotal: shownMoney(expense.discountTotal, c),
      taxTotal: shownMoney(expense.taxTotal, c),
      recoverableTaxTotal: shownMoney(expense.recoverableTaxTotal, c),
      total: shownMoney(expense.total, c),
      baseTotal: expense.baseTotal,
      version: expense.version,
      postedAt: expense.postedAt?.toISOString() ?? null,
      voidedAt: expense.voidedAt?.toISOString() ?? null,
    };
  }

  private lineView(l: ExpenseLine, currency: string) {
    return {
      id: l.id,
      lineNo: l.lineNo,
      itemId: l.itemId,
      description: l.description,
      accountId: l.accountId,
      quantity: decimal(l.quantity).toFixed(),
      unitPrice: decimal(l.unitPrice).toFixed(),
      discount: l.discountType
        ? { type: l.discountType, value: decimal(l.discountValue!).toFixed() }
        : null,
      amount: shownMoney(l.amount, currency),
      lineDiscount: shownMoney(l.lineDiscount, currency),
      documentDiscount: shownMoney(l.documentDiscount, currency),
      netAmount: shownMoney(l.netAmount, currency),
      taxCodeId: l.taxCodeId,
      taxRate: l.taxRate ? decimal(l.taxRate).toFixed() : null,
      taxAmount: shownMoney(l.taxAmount, currency),
      taxRecoverable: l.taxRecoverable,
      taxRecoverableOverride: l.taxRecoverableOverride,
      recoverableTax: shownMoney(l.recoverableTax, currency),
      nonRecoverableTax: shownMoney(l.nonRecoverableTax, currency),
      inputTaxAccountId: l.inputTaxAccountId,
      total: shownMoney(l.total, currency),
      dimensionValueIds: l.dimensionValueIds,
    };
  }

  private async detail(tx: Transaction, ctx: AuthorizationContext, expenseId: string) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const expense = await getExpense(tx, ctx.organizationId, expenseId);
    if (!expense) throw new NotFoundError('Expense not found.');
    const lines = await getExpenseLines(tx, ctx.organizationId, expense.id);
    const open = expense.status === 'DRAFT' || expense.status === 'PENDING_APPROVAL';
    const purchases = await getPurchasesSettings(tx, ctx.organizationId);
    const facts = open
      ? (await this.posting(tx, ctx.organizationId, accounting, purchases, expense, lines)).facts
      : null;
    const taxProblems = open ? (await inputTaxCheck(tx, ctx.organizationId, lines)).issues : [];
    return {
      ...this.summary(expense, await vendorName(tx, ctx.organizationId, expense.vendorId)),
      defaultPaymentAccountId: purchases?.defaultPaymentAccountId ?? null,
      exchangeRate: expense.exchangeRate,
      exchangeRateSource: expense.exchangeRateSource,
      tableRate: expense.tableRate,
      rateOverride: expense.rateOverride,
      rateOverrideReason: expense.rateOverrideReason,
      taxTreatment: expense.taxTreatment,
      discount: expense.discountType
        ? { type: expense.discountType, value: decimal(expense.discountValue!).toFixed() }
        : null,
      memo: expense.memo,
      dimensionValueIds: expense.dimensionValueIds,
      journalId: expense.journalId,
      voidReason: expense.voidReason,
      voidJournalId: expense.voidJournalId,
      createdByUserId: expense.createdByUserId,
      baseCurrency: accounting.baseCurrency,
      lines: lines.map((l) => this.lineView(l, expense.currencyCode)),
      approval: await documentApprovalState(
        this.approvals,
        tx,
        ctx.organizationId,
        EXPENSE_POST_ACTION,
        expense,
        facts,
      ),
      warnings: open
        ? [
            ...taxProblems.map((p) => ({ code: 'TAX_CODE_NOT_PURCHASABLE', message: p.message })),
            ...(await this.duplicateWarnings(tx, ctx.organizationId, expense)),
          ]
        : [],
    };
  }

  /** A supplier reference already used by another expense or bill of the vendor (blocks at post). */
  private async duplicateWarnings(tx: Transaction, organizationId: string, expense: Expense) {
    if (!expense.vendorReference) return [];
    const duplicates = await findDuplicateExpenseReferences(tx, {
      organizationId,
      vendorId: expense.vendorId,
      vendorReference: expense.vendorReference,
      exceptId: expense.id,
    });
    return duplicates.length
      ? [
          {
            code: 'DUPLICATE_VENDOR_REFERENCE',
            message:
              'Another expense or bill from this vendor has the same supplier reference. Posting needs a confirmed reason.',
            matches: duplicates,
          },
        ]
      : [];
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(
    principal: Principal,
    query: {
      status?: ExpenseStatus[] | undefined;
      vendorId?: string | undefined;
      search?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpensePermissions.View },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const search = query.search?.trim() || null;
        const page = await listExpenses(tx, {
          organizationId: ctx.organizationId,
          statuses: query.status?.length ? query.status : null,
          vendorId: query.vendorId ?? null,
          search,
          vendorIdsIn: search
            ? vendorIdsOfParties(ctx.organizationId, partyIdsMatching(ctx.organizationId, search))
            : undefined,
          from: query.from ?? null,
          to: query.to ?? null,
          limit: query.limit,
          after: query.after ? decodeCursor(query.after) : null,
        });
        const names = new Map<string, string | null>();
        for (const id of new Set(page.items.map((e) => e.vendorId))) {
          names.set(id, await vendorName(tx, ctx.organizationId, id));
        }
        const last = page.items.at(-1);
        return {
          items: page.items.map((e) => this.summary(e, names.get(e.vendorId) ?? null)),
          nextCursor: page.hasMore && last ? encodeCursor(last) : null,
        };
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpensePermissions.View },
      (tx, ctx) => this.detail(tx, ctx, id),
    );
  }

  // ---------------------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------------------

  /** Creates a draft; with an Idempotency-Key a retry returns the first result (Decision 23). */
  create(
    principal: Principal,
    input: ExpenseDraftInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpensePermissions.Create },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'purchases.expense.create', request: input },
          async () => {
            const accounting = await requireAccountingSettings(tx, ctx.organizationId);
            const purchases = await getPurchasesSettings(tx, ctx.organizationId);
            const resolved = await this.resolve(
              tx,
              ctx.organizationId,
              accounting,
              purchases,
              input,
            );
            const now = this.now;
            const expense = await insertExpense(tx, {
              ...resolved.header,
              organizationId: ctx.organizationId,
              createdByUserId: ctx.userId,
              createdAt: now,
              updatedByUserId: ctx.userId,
              updatedAt: now,
            });
            await replaceExpenseLines(
              tx,
              ctx.organizationId,
              expense.id,
              stripPurchaseLines(resolved.lines),
            );
            await this.audit(tx, ctx, 'expense.created', expense.id, now, origin, {
              vendorId: expense.vendorId,
              expenseDate: expense.expenseDate,
              currencyCode: expense.currencyCode,
              total: expense.total,
              lines: resolved.lines.length,
            });
            return this.detail(tx, ctx, expense.id);
          },
        ),
    );
  }

  update(
    principal: Principal,
    id: string,
    input: ExpenseDraftInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpensePermissions.Create },
      async (tx, ctx) => {
        const expense = await this.lockDraft(tx, ctx, id, input.version, 'edited');
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const purchases = await getPurchasesSettings(tx, ctx.organizationId);
        const existingLines = await getExpenseLines(tx, ctx.organizationId, id);
        const resolved = await this.resolve(tx, ctx.organizationId, accounting, purchases, input, {
          expense,
          lines: existingLines,
        });
        const now = this.now;
        const updated = await updateExpense(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: input.version,
          set: { ...resolved.header, updatedByUserId: ctx.userId, updatedAt: now },
        });
        if (!updated) throw versionConflict();
        await replaceExpenseLines(tx, ctx.organizationId, id, stripPurchaseLines(resolved.lines));
        await this.audit(tx, ctx, 'expense.updated', id, now, origin, {
          version: updated.version,
          total: { before: expense.total, after: updated.total },
          lines: resolved.lines.length,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  delete(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpensePermissions.Create },
      async (tx, ctx) => {
        const expense = await this.lockDraft(tx, ctx, id, input.version, 'deleted');
        await deleteExpense(tx, ctx.organizationId, id);
        await this.audit(tx, ctx, 'expense.deleted', id, this.now, origin, {
          vendorId: expense.vendorId,
          total: expense.total,
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
    const expense = await getExpense(tx, ctx.organizationId, id, { forUpdate: true });
    if (!expense) throw new NotFoundError('Expense not found.');
    if (expense.version !== version) throw versionConflict();
    if (expense.status !== 'DRAFT') {
      throw invalidState(
        expense.status === 'PENDING_APPROVAL'
          ? `The expense is awaiting approval. Withdraw it before it can be ${verb}.`
          : verb === 'deleted'
            ? 'Only draft expenses can be deleted; posted expenses are voided.'
            : 'Only draft expenses can be edited.',
      );
    }
    return expense;
  }

  // ---------------------------------------------------------------------------
  // Approval (P4-37) and post
  // ---------------------------------------------------------------------------

  submit(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpensePermissions.Create },
      async (tx, ctx) => {
        const expense = await getExpense(tx, ctx.organizationId, id, { forUpdate: true });
        if (!expense) throw new NotFoundError('Expense not found.');
        if (expense.version !== input.version) throw versionConflict();
        if (expense.status !== 'DRAFT') {
          throw invalidState('Only draft expenses can be submitted.');
        }
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const purchases = await getPurchasesSettings(tx, ctx.organizationId);
        const lines = await getExpenseLines(tx, ctx.organizationId, id);
        const { facts, journal, typeOf } = await this.posting(
          tx,
          ctx.organizationId,
          accounting,
          purchases,
          expense,
          lines,
        );
        // Required dimensions are enforced at submit and at post (architecture rules, D10).
        await assertRequiredDimensions(tx, ctx.organizationId, journal.lines, typeOf);
        const now = this.now;
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: EXPENSE_POST_ACTION,
          subjectId: id,
          // No self-approval: neither the preparer nor the submitter.
          excludedUserIds: [...new Set([ctx.userId, expense.createdByUserId])],
          reason: null,
          facts,
          now,
        });
        if (!request) {
          throw invalidState('No approval step applies to this expense; post it directly.');
        }
        const updated = await updateExpense(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: expense.version,
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
        await this.audit(tx, ctx, 'expense.submitted', id, now, origin, {
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
      { permission: ExpensePermissions.Create },
      async (tx, ctx) => {
        const expense = await getExpense(tx, ctx.organizationId, id, { forUpdate: true });
        if (!expense) throw new NotFoundError('Expense not found.');
        if (expense.version !== input.version) throw versionConflict();
        if (expense.status !== 'PENDING_APPROVAL') {
          throw invalidState('Only an expense awaiting approval can be withdrawn.');
        }
        const now = this.now;
        const request = expense.approvalRequestId
          ? await getApprovalRequest(tx, ctx.organizationId, expense.approvalRequestId, {
              forUpdate: true,
            })
          : undefined;
        if (request?.status === 'pending') {
          await this.approvals.withdrawRequest(tx, ctx.organizationId, request.id, now);
        }
        const updated = await updateExpense(tx, {
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
        await this.audit(tx, ctx, 'expense.withdrawn', id, now, origin, {
          approvalRequestId: request?.id ?? null,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  /**
   * Post: one transaction that assigns the number, snapshots the expense and posts it through the
   * accounting event. Any failure rolls back everything, including the number.
   */
  post(
    principal: Principal,
    id: string,
    input: {
      version: number;
      duplicateReason?: string | null | undefined;
      policyReason?: string | null | undefined;
    },
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpensePermissions.Create },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          {
            key: options.idempotencyKey,
            scope: 'purchases.expense.post',
            request: { id, ...input },
          },
          () => this.postInTransaction(tx, ctx, id, input, origin),
        ),
    );
  }

  private async postInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    id: string,
    input: {
      version: number;
      duplicateReason?: string | null | undefined;
      policyReason?: string | null | undefined;
    },
    origin: EventOrigin,
  ) {
    // 1. Lock, version and state.
    const expense = await getExpense(tx, ctx.organizationId, id, { forUpdate: true });
    if (!expense) throw new NotFoundError('Expense not found.');
    if (expense.version !== input.version) throw versionConflict();
    if (expense.status !== 'DRAFT' && expense.status !== 'PENDING_APPROVAL') {
      throw invalidState(`A ${expense.status.toLowerCase()} expense cannot be posted.`);
    }
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const purchases = await getPurchasesSettings(tx, ctx.organizationId, { forUpdate: true });

    // 2. Recompute with today's references: rates on the expense date, recoverability defaults,
    // and active vendor, items, tax codes, accounts and dimension values.
    const existing = await getExpenseLines(tx, ctx.organizationId, id);
    const vendor = await getVendor(tx, ctx.organizationId, expense.vendorId);
    const party = vendor ? await getParty(tx, ctx.organizationId, vendor.partyId) : undefined;
    const issues: ValidationIssue[] = [];
    if (vendor?.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
      issues.push({
        path: 'vendorId',
        message: 'Expenses for archived vendors cannot be posted.',
      });
    }
    // The paid account: the expense's own, else the Purchases default (P4-28 parity).
    const paidFrom = expense.paymentAccountId ?? purchases?.defaultPaymentAccountId ?? null;
    if (!paidFrom) {
      issues.push({
        path: 'paymentAccountId',
        message: 'Choose the account the expense was paid from, or set a default payment account.',
      });
    }
    const resolved = await this.resolve(
      tx,
      ctx.organizationId,
      accounting,
      purchases,
      { ...this.inputOf(expense, existing), paymentAccountId: paidFrom },
      { expense: { ...expense, vendorId: '', dimensionValueIds: [] }, lines: [] },
    );
    if (decimal(resolved.header.total).lte(0)) {
      issues.push({ path: 'lines', message: 'The expense total must be greater than zero.' });
    }
    resolved.lines.forEach((l, i) => {
      if (!l.accountId) {
        issues.push({
          path: `lines.${i}.accountId`,
          message: 'Choose an account or set a default expense account.',
        });
      }
    });
    // P4-11: every tax code used must have a usable input tax account.
    const inputTax = await inputTaxCheck(tx, ctx.organizationId, resolved.lines);
    issues.push(...inputTax.issues);
    if (issues.length) throw new ValidationError(issues, 'The expense cannot be posted yet.');
    await this.inventory?.assertNoTrackedItems(
      tx,
      ctx.organizationId,
      resolved.lines.map((l) => ({ itemId: l.itemId ?? null })),
      'expenses',
    );

    const now = this.now;
    // Keep the recomputed values, the tax snapshot and the input accounts on the lines.
    const snapshot = await updateExpense(tx, {
      organizationId: ctx.organizationId,
      id,
      from: expense.status,
      version: expense.version,
      set: { ...resolved.header, updatedByUserId: ctx.userId, updatedAt: now },
    });
    if (!snapshot) throw versionConflict();
    const lines = await replaceExpenseLines(
      tx,
      ctx.organizationId,
      id,
      stripPurchaseLines(resolved.lines).map((l, i) => ({
        ...l,
        inputTaxAccountId: inputTax.accounts[i] ?? null,
      })),
    );

    // 3. Rate and the journal to post; its base total is the approval amount.
    const posting = await this.posting(
      tx,
      ctx.organizationId,
      accounting,
      purchases,
      snapshot,
      lines,
    );
    if (!posting.rate) {
      throw new AppError(
        'EXCHANGE_RATE_REQUIRED',
        409,
        `An exchange rate from ${snapshot.currencyCode} to ${accounting.baseCurrency} is required for ${snapshot.expenseDate}.`,
      );
    }

    // 4. Approval, re-checked against the recomputed facts (S10-06).
    const approval = await documentApprovalState(
      this.approvals,
      tx,
      ctx.organizationId,
      EXPENSE_POST_ACTION,
      snapshot,
      posting.facts,
    );
    if (!approval.readyToIssue) {
      throw new AppError(
        'APPROVAL_REQUIRED',
        409,
        snapshot.status === 'DRAFT'
          ? 'This expense needs approval: submit it for approval first.'
          : approval.approvalOutdated
            ? 'The expense amount now needs further approval. Withdraw it and submit it again.'
            : 'The expense has not received all required approvals.',
      );
    }

    // 5. Period open on the expense date; required dimensions on the posted lines (D10).
    await assertOpenPeriod(tx, ctx.organizationId, snapshot.expenseDate);
    await assertRequiredDimensions(tx, ctx.organizationId, posting.journal.lines, posting.typeOf);

    // 5b. Duplicate supplier reference (expense or bill of this vendor), under the same advisory
    // lock the bills use, so a bill and an expense racing with one reference are serialised.
    const checkDuplicates = snapshot.vendorReference !== null;
    if (checkDuplicates) {
      await lockDuplicateCheck(
        tx,
        ctx.organizationId,
        snapshot.vendorId,
        snapshot.vendorReference!,
      );
    }
    const duplicates = checkDuplicates
      ? await findDuplicateExpenseReferences(tx, {
          organizationId: ctx.organizationId,
          vendorId: snapshot.vendorId,
          vendorReference: snapshot.vendorReference!,
          exceptId: id,
        })
      : [];
    const duplicateReason = input.duplicateReason?.trim() || null;
    if (duplicates.length && !duplicateReason) {
      const first = duplicates[0]!;
      throw new AppError(
        'DUPLICATE_VENDOR_REFERENCE',
        409,
        `Another ${first.kind} from this vendor already uses supplier reference ${snapshot.vendorReference}${
          first.number ? ` (${first.number})` : ''
        }. Confirm with a reason to post it anyway.`,
        {
          issues: duplicates.map((d) => ({
            path: 'vendorReference',
            message: `${d.number ?? `Draft ${d.kind}`} (${d.kind}, ${d.status.toLowerCase()}, ${d.date}) uses ${d.vendorReference}.`,
          })),
        },
      );
    }

    // 5c. Organization expense policies (migration 0092). A blocking rule stops the post; a warning
    // rule needs a reason from the person posting, which is audited.
    const policies = await listExpensePolicies(tx, ctx.organizationId);
    let policyConfirmed: { names: string[]; reason: string } | null = null;
    if (policies.some((p) => p.status === 'ACTIVE')) {
      const debits = posting.journal.lines.filter((l) => l.side === 'debit');
      const byAccount = new Map<string, Decimal>();
      for (const l of debits) {
        if (l.role === 'expense' && l.accountId) {
          byAccount.set(
            l.accountId,
            (byAccount.get(l.accountId) ?? new Decimal(0)).plus(l.baseAmount),
          );
        }
      }
      const violations = evaluateExpensePolicies(policies, {
        total: debits.reduce((acc, l) => acc.plus(l.baseAmount), new Decimal(0)),
        byAccount,
        attachments: await countAttachments(tx, ctx.organizationId, 'expense', id),
      });
      const blocking = violations.filter((v) => v.action === 'block');
      if (blocking.length) {
        throw new AppError(
          'EXPENSE_POLICY_BLOCKED',
          409,
          'This expense breaks an expense policy and cannot be posted.',
          { issues: blocking.map((v) => ({ path: 'policy', message: v.message })) },
        );
      }
      const warnings = violations.filter((v) => v.action === 'warn');
      if (warnings.length) {
        const reason = input.policyReason?.trim() || null;
        if (!reason) {
          throw new AppError(
            'EXPENSE_POLICY_WARNING',
            409,
            'This expense breaks an expense policy. Confirm with a reason to post it anyway.',
            { issues: warnings.map((v) => ({ path: 'policy', message: v.message })) },
          );
        }
        policyConfirmed = { names: warnings.map((v) => v.name), reason };
      }
    }

    // 6. Number (P4-51), then the journal through the accounting event (Decision 13).
    let number: string | null = null;
    for (let attempt = 0; attempt < 50 && !number; attempt += 1) {
      const taken = await takeNextPurchaseNumber(tx, ctx.organizationId, 'expense');
      if (!taken) {
        throw new ValidationError([
          { path: 'numbering', message: 'Save the Purchases settings before posting expenses.' },
        ]);
      }
      if (!(await expenseNumberExists(tx, ctx.organizationId, taken.number))) {
        number = taken.number;
      }
    }
    if (!number) {
      throw new AppError(
        'CONFLICT',
        409,
        'Could not find a free expense number; check the numbering.',
      );
    }
    const foreign = snapshot.currencyCode !== accounting.baseCurrency;
    const journalInput = {
      entryDate: snapshot.expenseDate,
      description:
        `Expense ${number} — ${party!.displayName}${snapshot.vendorReference ? ` (${snapshot.vendorReference})` : ''}`.slice(
          0,
          500,
        ),
      reference: number,
      currency: snapshot.currencyCode,
      exchangeRate: foreign ? posting.rate.toFixed(10) : null,
      ...(foreign
        ? { exchangeRateSource: posting.rateSource === 'manual' ? 'manual' : ('table' as const) }
        : {}),
      sourceRef: { module: 'purchases', type: 'expense', id },
      lines: posting.journal.lines.map((l) => journalLine(l, number, posting.typeOf)),
    };
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'purchases',
      eventType: EXPENSE_POSTED_EVENT,
      eventKey: `expense:${id}:posted`,
      payload: { expenseId: id, number, journal: journalInput },
      occurredAt: now,
      origin,
    });
    if (!event.journalId) {
      throw new AppError('CONFLICT', 409, 'The expense was not posted; try again.');
    }
    // The base amount paid is exactly what the journal credited to the payment account.
    const paidLine = (await getJournalLines(tx, ctx.organizationId, [event.journalId])).find(
      (l) => l.accountId === paidFrom && l.baseCredit !== null,
    );
    const baseTotal = decimal(paidLine!.baseCredit!);

    // 7. Posted: immutable from here.
    const posted = await updateExpense(tx, {
      organizationId: ctx.organizationId,
      id,
      from: snapshot.status,
      version: snapshot.version,
      set: {
        status: 'POSTED',
        number,
        paymentAccountId: paidFrom!,
        exchangeRate: posting.rate.toFixed(10),
        exchangeRateSource: posting.rateSource as 'base' | 'table' | 'manual',
        tableRate: posting.tableRate ? posting.tableRate.toFixed(10) : null,
        baseTotal: baseTotal.toFixed(4),
        postedByUserId: ctx.userId,
        postedAt: now,
        journalId: event.journalId,
        accountingEventId: event.eventId,
        updatedByUserId: ctx.userId,
        updatedAt: now,
      },
    });
    if (!posted) throw versionConflict();
    if (policyConfirmed) {
      await this.audit(tx, ctx, 'expense.policy_confirmed', id, now, origin, {
        policies: policyConfirmed.names,
        reason: policyConfirmed.reason,
      });
    }
    if (duplicates.length) {
      await this.audit(tx, ctx, 'expense.duplicate_confirmed', id, now, origin, {
        vendorReference: posted.vendorReference,
        reason: duplicateReason,
        duplicates: duplicates.map((d) => ({ kind: d.kind, id: d.id })),
      });
    }
    if (posting.rateSource === 'manual') {
      await this.audit(tx, ctx, 'expense.rate_overridden', id, now, origin, {
        currencyCode: posted.currencyCode,
        rate: posted.exchangeRate,
        tableRate: posted.tableRate,
        reason: posted.rateOverrideReason,
      });
    }
    await this.audit(tx, ctx, 'expense.posted', id, now, origin, {
      number,
      vendorReference: posted.vendorReference,
      total: posted.total,
      currencyCode: posted.currencyCode,
      paymentAccountId: posted.paymentAccountId,
      exchangeRate: posted.exchangeRate,
      exchangeRateSource: posted.exchangeRateSource,
      baseTotal: posted.baseTotal,
      recoverableTaxTotal: posted.recoverableTaxTotal,
      journalId: event.journalId,
      approvalRequestId: posted.approvalRequestId,
    });
    return this.detail(tx, ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Void (P4-42; reversal through Purchases, P4-09)
  // ---------------------------------------------------------------------------

  /**
   * Voids a posted expense in an open period: its journal is reversed through Purchases on the
   * expense date. Needs `expenses.void` and a recent password confirmation (P4-42).
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
      { permission: ExpensePermissions.Void, sensitive: true },
      async (tx, ctx) => {
        const expense = await getExpense(tx, ctx.organizationId, id, { forUpdate: true });
        if (!expense) throw new NotFoundError('Expense not found.');
        if (expense.version !== input.version) throw versionConflict();
        if (expense.status !== 'POSTED') {
          throw invalidState(
            expense.status === 'VOID'
              ? 'The expense is already void.'
              : 'Only posted expenses can be voided; delete a draft instead.',
          );
        }
        const reason = input.reason.trim();
        const reversal = await this.journals.reverseSubledgerJournalInTransaction(
          tx,
          ctx,
          'purchases',
          expense.journalId!,
          { reason: `Expense ${expense.number} voided: ${reason}` },
          origin,
        );
        const now = this.now;
        const voided = await updateExpense(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'POSTED',
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
        if (!voided) throw versionConflict();
        await this.audit(tx, ctx, 'expense.voided', id, now, origin, {
          number: expense.number,
          reason,
          total: expense.total,
          reversalJournalId: reversal.id,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }
}
