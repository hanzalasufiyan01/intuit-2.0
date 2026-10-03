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
  getJournalLines,
  isValidIsoDate,
  type AccountingSettings,
} from '../modules/accounting/index.js';
import { getApprovalRequest } from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { dueDateFor, type Discount } from '../modules/documents/index.js';
import { getParty, partyIdsMatching } from '../modules/parties/index.js';
import {
  BillPermissions,
  billNumberExists,
  deleteBill,
  findDuplicateReferences,
  findSimilarBills,
  getBill,
  getBillLines,
  getPurchasesSettings,
  insertBill,
  listBills,
  lockApAccount,
  lockDuplicateCheck,
  replaceBillLines,
  takeNextPurchaseNumber,
  updateBill,
  type Bill,
  type BillLine,
  type BillStatus,
  type PurchasesSettings,
} from '../modules/purchases/index.js';
import type { TaxTreatment } from '../modules/tax/index.js';
import { getVendor, vendorIdsOfParties } from '../modules/vendors/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { ApprovalService } from './approval-service.js';
import { requirePermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { JournalService } from './journal-service.js';
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

/**
 * Bills (ADR 0004 P4-11, P4-12, P4-15 to P4-22, P4-37, P4-39, P4-42, P4-50, P4-51).
 *
 * Drafts are edited under optimistic concurrency and every amount is computed here. Submitting
 * opens an approval request when a policy step matches the bill's facts; approval only
 * authorizes. Post (`bills.post`) is one transaction: lock, recompute with today's references,
 * re-check approval against the recomputed facts (S10-06), check the period, required dimensions,
 * the input tax accounts (P4-11) and the supplier reference with its duplicate check (P4-17,
 * P4-18), fix the rate (P4-16), take the number (P4-51), snapshot tax, and post through the
 * `purchases.bill_posted` accounting event; the first post fixes the AP control account. An unpaid
 * bill is voided by reversing its journal through Purchases (P4-09, P4-21). Purchases never writes
 * ledger tables.
 */

export const BILL_POST_ACTION = 'purchases.bill.post';
export const BILL_POSTED_EVENT = 'purchases.bill_posted';
const RESOURCE = 'purchases_bill';

export interface BillDraftInput {
  vendorId: string;
  billDate: string;
  dueDate?: string | null | undefined;
  paymentTermsDays?: number | null | undefined;
  vendorReference?: string | null | undefined;
  currencyCode?: string | undefined;
  /** P4-16: a manual rate with its mandatory reason (both or neither); needs `bills.post`. */
  rateOverride?: string | null | undefined;
  rateOverrideReason?: string | null | undefined;
  taxTreatment?: TaxTreatment | undefined;
  discount?: Discount | null | undefined;
  memo?: string | undefined;
  dimensionValueIds?: string[] | undefined;
  lines: PurchaseLineInput[];
}

type ResolvedBill = ResolvedPurchaseDocument & {
  header: ResolvedPurchaseDocument['header'] & {
    billDate: string;
    dueDate: string;
    paymentTermsDays: number | null;
    vendorReference: string | null;
    rateOverride: string | null;
    rateOverrideReason: string | null;
  };
};

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'This bill was changed by someone else. Reload it and apply your changes again.',
  );

function encodeCursor(bill: Bill) {
  return Buffer.from(JSON.stringify({ d: bill.billDate, i: bill.id })).toString('base64url');
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

export class BillService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly approvals: ApprovalService,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
  ) {
    approvals.register({
      actionKey: BILL_POST_ACTION,
      label: 'Approve bills before posting',
      subjectType: RESOURCE,
      approverPermission: BillPermissions.Approve,
      decisionRequiresReauth: false,
      // P4-37: the AP line's base at the bill rate; standard (and later opening) bills.
      conditions: { amount: true, transactionTypes: ['standard', 'opening'] },
      onApproved: async (tx, { request, authz, now, origin }) => {
        // P4-15: approval authorizes; the bill stays pending until someone posts it.
        await this.audit(tx, authz, 'bill.approved', request.subjectId, now, origin, {
          approvalRequestId: request.id,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        // A rejection needs a reason; refusing here rolls the whole decision back.
        if (!comment?.trim()) {
          throw new ValidationError([
            { path: 'comment', message: 'Give a reason for rejecting the bill.' },
          ]);
        }
        const bill = await updateBill(tx, {
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
        if (!bill) throw invalidState('The bill is no longer awaiting approval.');
        await this.audit(tx, authz, 'bill.rejected', bill.id, now, origin, {
          approvalRequestId: request.id,
          comment: comment.trim(),
        });
      },
    });
    // The journal a posted bill posts; Purchases owns the approval (Decision 13).
    journals.registerEventHandler(BILL_POSTED_EVENT, (event) => event.payload.journal as never, {
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
    billId: string,
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
      resourceId: billId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /** The shared purchase rules plus the due date, supplier reference and rate override. */
  private async resolve(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    purchases: PurchasesSettings | undefined,
    input: BillDraftInput,
    existing?: { bill: Bill; lines: readonly BillLine[] },
  ): Promise<ResolvedBill> {
    const resolved = await resolvePurchaseDocument(
      tx,
      organizationId,
      accounting,
      purchases,
      { ...input, date: input.billDate },
      {
        datePath: 'billDate',
        noun: 'bills',
        existing: existing && {
          vendorId: existing.bill.vendorId,
          dimensionValueIds: existing.bill.dimensionValueIds,
          lines: existing.lines,
        },
      },
    );
    const issues: ValidationIssue[] = [];
    let dueDate: string;
    let paymentTermsDays: number | null;
    if (input.dueDate) {
      dueDate = input.dueDate;
      paymentTermsDays = null;
      if (!isValidIsoDate(dueDate)) {
        issues.push({ path: 'dueDate', message: 'Enter a valid date (YYYY-MM-DD).' });
      } else if (dueDate < input.billDate) {
        issues.push({ path: 'dueDate', message: 'The due date cannot be before the bill date.' });
      }
    } else {
      paymentTermsDays =
        input.paymentTermsDays ??
        resolved.vendor.paymentTermsDays ??
        purchases?.defaultPaymentTermsDays ??
        30;
      dueDate = dueDateFor(input.billDate, paymentTermsDays);
    }
    // P4-17: kept as entered (trimmed); optional on drafts.
    const vendorReference = input.vendorReference?.trim() || null;
    // P4-16: a manual rate needs a reason and a foreign-currency bill.
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
          message: 'A base-currency bill has no exchange rate to override.',
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
        billDate: input.billDate,
        dueDate,
        paymentTermsDays,
        vendorReference,
        rateOverride: rateOverride === null ? null : decimal(rateOverride).toFixed(10),
        rateOverrideReason: rateOverride === null ? null : rateOverrideReason,
      },
    };
  }

  /**
   * P4-16: setting or changing a manual rate needs `bills.post`; P4-12: an explicit tax
   * recoverability choice needs `bills.create`.
   */
  private assertOverridePermissions(
    ctx: AuthorizationContext,
    resolved: ResolvedBill,
    existing?: { bill: Bill; lines: readonly BillLine[] },
  ) {
    const rateChanged =
      resolved.header.rateOverride !== null &&
      (resolved.header.rateOverride !== existing?.bill.rateOverride ||
        resolved.header.rateOverrideReason !== existing?.bill.rateOverrideReason);
    if (rateChanged) requirePermission(ctx, BillPermissions.Post);
    const stored = new Map(existing?.lines.map((l) => [l.lineNo, l.taxRecoverableOverride]));
    const newOverride = resolved.lines.some(
      (l) =>
        l.taxRecoverableOverride !== null &&
        l.taxRecoverableOverride !== undefined &&
        stored.get(l.lineNo) !== l.taxRecoverableOverride,
    );
    if (newOverride) requirePermission(ctx, BillPermissions.Create);
  }

  private inputOf(bill: Bill, lines: readonly BillLine[]): BillDraftInput {
    return {
      vendorId: bill.vendorId,
      billDate: bill.billDate,
      dueDate: bill.paymentTermsDays === null ? bill.dueDate : null,
      paymentTermsDays: bill.paymentTermsDays,
      vendorReference: bill.vendorReference,
      currencyCode: bill.currencyCode,
      rateOverride: bill.rateOverride,
      rateOverrideReason: bill.rateOverrideReason,
      taxTreatment: bill.taxTreatment,
      discount: bill.discountType ? { type: bill.discountType, value: bill.discountValue! } : null,
      memo: bill.memo,
      dimensionValueIds: bill.dimensionValueIds,
      lines: purchaseLinesAsInput(lines),
    };
  }

  private posting(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    purchases: PurchasesSettings | undefined,
    bill: Bill,
    lines: readonly BillLine[],
  ) {
    return purchaseDocumentPosting(
      tx,
      organizationId,
      accounting,
      purchases,
      {
        direction: 'bill',
        label: `Bill ${bill.number ?? '(draft)'}`,
        transactionType: bill.kind,
        date: bill.billDate,
        currencyCode: bill.currencyCode,
        dimensionValueIds: bill.dimensionValueIds,
        rateOverride: bill.rateOverride,
      },
      lines,
    );
  }

  /** P4-18: duplicate references (blocking at post) and same-amount bills (warning only). */
  private async warnings(tx: Transaction, organizationId: string, bill: Bill) {
    const warnings: { code: string; message: string; matches?: unknown }[] = [];
    if (bill.vendorReference) {
      const duplicates = await findDuplicateReferences(tx, {
        organizationId,
        vendorId: bill.vendorId,
        vendorReference: bill.vendorReference,
        exceptId: bill.id,
      });
      if (duplicates.length) {
        warnings.push({
          code: 'DUPLICATE_VENDOR_REFERENCE',
          message:
            'Another bill from this vendor has the same supplier reference. Posting needs a confirmed reason.',
          matches: duplicates,
        });
      }
    }
    const similar = await findSimilarBills(tx, {
      organizationId,
      vendorId: bill.vendorId,
      billDate: bill.billDate,
      total: bill.total,
      currencyCode: bill.currencyCode,
      exceptId: bill.id,
    });
    if (similar.length) {
      warnings.push({
        code: 'POSSIBLE_DUPLICATE',
        message: 'Another bill from this vendor has the same total within 7 days.',
        matches: similar,
      });
    }
    return warnings;
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private summary(bill: Bill, name: string | null) {
    const c = bill.currencyCode;
    return {
      id: bill.id,
      kind: bill.kind,
      status: bill.status,
      number: bill.number,
      vendorId: bill.vendorId,
      vendorName: name,
      vendorReference: bill.vendorReference,
      billDate: bill.billDate,
      dueDate: bill.dueDate,
      currencyCode: c,
      subtotal: shownMoney(bill.subtotal, c),
      discountTotal: shownMoney(bill.discountTotal, c),
      taxTotal: shownMoney(bill.taxTotal, c),
      recoverableTaxTotal: shownMoney(bill.recoverableTaxTotal, c),
      total: shownMoney(bill.total, c),
      amountDue: shownMoney(bill.amountDue, c),
      baseTotal: bill.baseTotal,
      baseDue: bill.baseDue,
      version: bill.version,
      postedAt: bill.postedAt?.toISOString() ?? null,
      voidedAt: bill.voidedAt?.toISOString() ?? null,
    };
  }

  private lineView(l: BillLine, currency: string) {
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

  private async detail(tx: Transaction, ctx: AuthorizationContext, billId: string) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const bill = await getBill(tx, ctx.organizationId, billId);
    if (!bill) throw new NotFoundError('Bill not found.');
    const lines = await getBillLines(tx, ctx.organizationId, bill.id);
    const open = bill.status === 'DRAFT' || bill.status === 'PENDING_APPROVAL';
    const purchases = await getPurchasesSettings(tx, ctx.organizationId);
    const facts = open
      ? (await this.posting(tx, ctx.organizationId, accounting, purchases, bill, lines)).facts
      : null;
    // P4-11: taxed lines whose code cannot be used on purchases yet (posting would be blocked).
    const taxProblems = open ? (await inputTaxCheck(tx, ctx.organizationId, lines)).issues : [];
    return {
      ...this.summary(bill, await vendorName(tx, ctx.organizationId, bill.vendorId)),
      paymentTermsDays: bill.paymentTermsDays,
      exchangeRate: bill.exchangeRate,
      exchangeRateSource: bill.exchangeRateSource,
      tableRate: bill.tableRate,
      rateOverride: bill.rateOverride,
      rateOverrideReason: bill.rateOverrideReason,
      taxTreatment: bill.taxTreatment,
      discount: bill.discountType
        ? { type: bill.discountType, value: decimal(bill.discountValue!).toFixed() }
        : null,
      memo: bill.memo,
      dimensionValueIds: bill.dimensionValueIds,
      duplicateConfirmedReason: bill.duplicateConfirmedReason,
      journalId: bill.journalId,
      voidReason: bill.voidReason,
      voidJournalId: bill.voidJournalId,
      createdByUserId: bill.createdByUserId,
      baseCurrency: accounting.baseCurrency,
      lines: lines.map((l) => this.lineView(l, bill.currencyCode)),
      approval: await documentApprovalState(
        this.approvals,
        tx,
        ctx.organizationId,
        BILL_POST_ACTION,
        bill,
        facts,
      ),
      warnings: open
        ? [
            ...(await this.warnings(tx, ctx.organizationId, bill)),
            ...taxProblems.map((p) => ({ code: 'TAX_CODE_NOT_PURCHASABLE', message: p.message })),
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
      status?: BillStatus[] | undefined;
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
      { permission: BillPermissions.View },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const search = query.search?.trim() || null;
        const page = await listBills(tx, {
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
        for (const id of new Set(page.items.map((b) => b.vendorId))) {
          names.set(id, await vendorName(tx, ctx.organizationId, id));
        }
        const last = page.items.at(-1);
        return {
          items: page.items.map((b) => this.summary(b, names.get(b.vendorId) ?? null)),
          nextCursor: page.hasMore && last ? encodeCursor(last) : null,
        };
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(this.deps, principal, { permission: BillPermissions.View }, (tx, ctx) =>
      this.detail(tx, ctx, id),
    );
  }

  // ---------------------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------------------

  /** Creates a draft; with an Idempotency-Key a retry returns the first result (Decision 23). */
  create(
    principal: Principal,
    input: BillDraftInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BillPermissions.Create },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'purchases.bill.create', request: input },
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
            this.assertOverridePermissions(ctx, resolved);
            const now = this.now;
            const bill = await insertBill(tx, {
              ...resolved.header,
              organizationId: ctx.organizationId,
              kind: 'standard',
              createdByUserId: ctx.userId,
              createdAt: now,
              updatedByUserId: ctx.userId,
              updatedAt: now,
            });
            await replaceBillLines(
              tx,
              ctx.organizationId,
              bill.id,
              stripPurchaseLines(resolved.lines),
            );
            await this.audit(tx, ctx, 'bill.created', bill.id, now, origin, {
              vendorId: bill.vendorId,
              billDate: bill.billDate,
              currencyCode: bill.currencyCode,
              total: bill.total,
              lines: resolved.lines.length,
              ...(bill.rateOverride
                ? { rateOverride: bill.rateOverride, rateOverrideReason: bill.rateOverrideReason }
                : {}),
            });
            return this.detail(tx, ctx, bill.id);
          },
        ),
    );
  }

  update(
    principal: Principal,
    id: string,
    input: BillDraftInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BillPermissions.EditDraft },
      async (tx, ctx) => {
        const bill = await this.lockDraft(tx, ctx, id, input.version, 'edited');
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const purchases = await getPurchasesSettings(tx, ctx.organizationId);
        const existingLines = await getBillLines(tx, ctx.organizationId, id);
        const existing = { bill, lines: existingLines };
        const resolved = await this.resolve(
          tx,
          ctx.organizationId,
          accounting,
          purchases,
          input,
          existing,
        );
        this.assertOverridePermissions(ctx, resolved, existing);
        const now = this.now;
        const updated = await updateBill(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: input.version,
          set: { ...resolved.header, updatedByUserId: ctx.userId, updatedAt: now },
        });
        if (!updated) throw versionConflict();
        await replaceBillLines(tx, ctx.organizationId, id, stripPurchaseLines(resolved.lines));
        await this.audit(tx, ctx, 'bill.updated', id, now, origin, {
          version: updated.version,
          total: { before: bill.total, after: updated.total },
          lines: resolved.lines.length,
          ...(updated.rateOverride !== bill.rateOverride ||
          updated.rateOverrideReason !== bill.rateOverrideReason
            ? {
                rateOverride: {
                  before: bill.rateOverride,
                  after: updated.rateOverride,
                  reason: updated.rateOverrideReason,
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
      { permission: BillPermissions.DeleteDraft },
      async (tx, ctx) => {
        const bill = await this.lockDraft(tx, ctx, id, input.version, 'deleted');
        await deleteBill(tx, ctx.organizationId, id);
        await this.audit(tx, ctx, 'bill.deleted', id, this.now, origin, {
          vendorId: bill.vendorId,
          total: bill.total,
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
    const bill = await getBill(tx, ctx.organizationId, id, { forUpdate: true });
    if (!bill) throw new NotFoundError('Bill not found.');
    if (bill.version !== version) throw versionConflict();
    if (bill.status !== 'DRAFT') {
      throw invalidState(
        bill.status === 'PENDING_APPROVAL'
          ? `The bill is awaiting approval. Withdraw it before it can be ${verb}.`
          : verb === 'deleted'
            ? 'Only draft bills can be deleted; posted bills are voided.'
            : 'Only draft bills can be edited.',
      );
    }
    return bill;
  }

  // ---------------------------------------------------------------------------
  // Approval (P4-15, P4-37) and post
  // ---------------------------------------------------------------------------

  submit(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BillPermissions.Create },
      async (tx, ctx) => {
        const bill = await getBill(tx, ctx.organizationId, id, { forUpdate: true });
        if (!bill) throw new NotFoundError('Bill not found.');
        if (bill.version !== input.version) throw versionConflict();
        if (bill.status !== 'DRAFT') throw invalidState('Only draft bills can be submitted.');
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const purchases = await getPurchasesSettings(tx, ctx.organizationId);
        const lines = await getBillLines(tx, ctx.organizationId, id);
        const { facts, journal, typeOf } = await this.posting(
          tx,
          ctx.organizationId,
          accounting,
          purchases,
          bill,
          lines,
        );
        // Required dimensions are enforced at submit and at post (architecture rules, D10).
        await assertRequiredDimensions(tx, ctx.organizationId, journal.lines, typeOf);
        const now = this.now;
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: BILL_POST_ACTION,
          subjectId: id,
          // No self-approval: neither the preparer nor the submitter.
          excludedUserIds: [...new Set([ctx.userId, bill.createdByUserId])],
          reason: null,
          facts,
          now,
        });
        if (!request)
          throw invalidState('No approval step applies to this bill; post it directly.');
        const updated = await updateBill(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: bill.version,
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
        await this.audit(tx, ctx, 'bill.submitted', id, now, origin, {
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
      { permission: BillPermissions.Create },
      async (tx, ctx) => {
        const bill = await getBill(tx, ctx.organizationId, id, { forUpdate: true });
        if (!bill) throw new NotFoundError('Bill not found.');
        if (bill.version !== input.version) throw versionConflict();
        if (bill.status !== 'PENDING_APPROVAL') {
          throw invalidState('Only a bill awaiting approval can be withdrawn.');
        }
        const now = this.now;
        const request = bill.approvalRequestId
          ? await getApprovalRequest(tx, ctx.organizationId, bill.approvalRequestId, {
              forUpdate: true,
            })
          : undefined;
        if (request?.status === 'pending') {
          await this.approvals.withdrawRequest(tx, ctx.organizationId, request.id, now);
        }
        const updated = await updateBill(tx, {
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
        await this.audit(tx, ctx, 'bill.withdrawn', id, now, origin, {
          approvalRequestId: request?.id ?? null,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  /**
   * Post (P4-15): one transaction that assigns the number, snapshots the bill and posts it through
   * the accounting event. Any failure rolls back everything, including the number.
   */
  post(
    principal: Principal,
    id: string,
    input: { version: number; duplicateReason?: string | null | undefined },
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, { permission: BillPermissions.Post }, (tx, ctx) =>
      this.idempotency.run(
        tx,
        ctx,
        { key: options.idempotencyKey, scope: 'purchases.bill.post', request: { id, ...input } },
        () => this.postInTransaction(tx, ctx, id, input, origin),
      ),
    );
  }

  private async postInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    id: string,
    input: { version: number; duplicateReason?: string | null | undefined },
    origin: EventOrigin,
  ) {
    // 1. Lock, version and state; the Purchases settings row too (the AP lock is set under it).
    const bill = await getBill(tx, ctx.organizationId, id, { forUpdate: true });
    if (!bill) throw new NotFoundError('Bill not found.');
    if (bill.version !== input.version) throw versionConflict();
    if (bill.status !== 'DRAFT' && bill.status !== 'PENDING_APPROVAL') {
      throw invalidState(`A ${bill.status.toLowerCase()} bill cannot be posted.`);
    }
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const purchases = await getPurchasesSettings(tx, ctx.organizationId, { forUpdate: true });

    // 2. Recompute with today's references: rates on the bill date, recoverability defaults, and
    // active vendor, items, tax codes, accounts and dimension values.
    const existing = await getBillLines(tx, ctx.organizationId, id);
    const vendor = await getVendor(tx, ctx.organizationId, bill.vendorId);
    const party = vendor ? await getParty(tx, ctx.organizationId, vendor.partyId) : undefined;
    const issues: ValidationIssue[] = [];
    if (vendor?.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
      issues.push({ path: 'vendorId', message: 'Bills from archived vendors cannot be posted.' });
    }
    const resolved = await this.resolve(
      tx,
      ctx.organizationId,
      accounting,
      purchases,
      this.inputOf(bill, existing),
      {
        bill: { ...bill, vendorId: '', dimensionValueIds: [] },
        lines: [],
      },
    );
    if (decimal(resolved.header.total).lte(0)) {
      issues.push({ path: 'lines', message: 'The bill total must be greater than zero.' });
    }
    // 3. P4-17: the supplier reference is required to post a standard bill.
    if (!resolved.header.vendorReference) {
      issues.push({
        path: 'vendorReference',
        message: "Enter the supplier's invoice number before posting.",
      });
    }
    // Accounts: missing accounts block posting.
    if (!purchases?.apAccountId) {
      issues.push({
        path: 'apAccountId',
        message: 'Choose the AP control account in Purchases settings before posting.',
      });
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
    if (issues.length) throw new ValidationError(issues, 'The bill cannot be posted yet.');

    const now = this.now;
    // Keep the recomputed values, the tax snapshot and the input accounts on the lines.
    const snapshot = await updateBill(tx, {
      organizationId: ctx.organizationId,
      id,
      from: bill.status,
      version: bill.version,
      set: { ...resolved.header, updatedByUserId: ctx.userId, updatedAt: now },
    });
    if (!snapshot) throw versionConflict();
    const lines = await replaceBillLines(
      tx,
      ctx.organizationId,
      id,
      stripPurchaseLines(resolved.lines).map((l, i) => ({
        ...l,
        inputTaxAccountId: inputTax.accounts[i] ?? null,
      })),
    );

    // 4. Rate (P4-16) and the journal to post; its base total is the approval amount.
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
        `An exchange rate from ${snapshot.currencyCode} to ${accounting.baseCurrency} is required for ${snapshot.billDate}.`,
      );
    }

    // 5. Approval, re-checked against the recomputed facts (S10-06).
    const approval = await documentApprovalState(
      this.approvals,
      tx,
      ctx.organizationId,
      BILL_POST_ACTION,
      snapshot,
      posting.facts,
    );
    if (!approval.readyToIssue) {
      throw new AppError(
        'APPROVAL_REQUIRED',
        409,
        snapshot.status === 'DRAFT'
          ? 'This bill needs approval: submit it for approval first.'
          : approval.approvalOutdated
            ? 'The bill amount now needs further approval. Withdraw it and submit it again.'
            : 'The bill has not received all required approvals.',
      );
    }

    // 6. Period open on the bill date; required dimensions on the posted lines (D10).
    await assertOpenPeriod(tx, ctx.organizationId, snapshot.billDate);
    await assertRequiredDimensions(tx, ctx.organizationId, posting.journal.lines, posting.typeOf);

    // 7. P4-18: duplicate supplier reference, under an advisory lock for this vendor and key.
    await lockDuplicateCheck(tx, ctx.organizationId, snapshot.vendorId, snapshot.vendorReference!);
    const duplicates = await findDuplicateReferences(tx, {
      organizationId: ctx.organizationId,
      vendorId: snapshot.vendorId,
      vendorReference: snapshot.vendorReference!,
      exceptId: id,
    });
    const duplicateReason = input.duplicateReason?.trim() || null;
    if (duplicates.length && !duplicateReason) {
      const first = duplicates[0]!;
      throw new AppError(
        'DUPLICATE_VENDOR_REFERENCE',
        409,
        `Another bill from this vendor already uses supplier reference ${snapshot.vendorReference}${
          first.number ? ` (${first.number})` : ''
        }. Confirm with a reason to post it anyway.`,
        {
          issues: duplicates.map((d) => ({
            path: 'vendorReference',
            message: `${d.number ?? 'Draft bill'} (${d.status.toLowerCase()}, ${d.billDate}) uses ${d.vendorReference}.`,
          })),
        },
      );
    }

    // 8. Number (P4-51), then the journal through the accounting event (Decision 13).
    let number: string | null = null;
    for (let attempt = 0; attempt < 50 && !number; attempt += 1) {
      const taken = await takeNextPurchaseNumber(tx, ctx.organizationId, 'bill');
      if (!taken) {
        throw new ValidationError([
          { path: 'numbering', message: 'Save the Purchases settings before posting bills.' },
        ]);
      }
      if (!(await billNumberExists(tx, ctx.organizationId, taken.number))) number = taken.number;
    }
    if (!number) {
      throw new AppError(
        'CONFLICT',
        409,
        'Could not find a free bill number; check the numbering.',
      );
    }
    const foreign = snapshot.currencyCode !== accounting.baseCurrency;
    const journalInput = {
      entryDate: snapshot.billDate,
      description: `Bill ${number} — ${party!.displayName} (${snapshot.vendorReference})`.slice(
        0,
        500,
      ),
      reference: number,
      currency: snapshot.currencyCode,
      exchangeRate: foreign ? posting.rate.toFixed(10) : null,
      ...(foreign
        ? { exchangeRateSource: posting.rateSource === 'manual' ? 'manual' : ('table' as const) }
        : {}),
      sourceRef: { module: 'purchases', type: 'bill', id },
      lines: posting.journal.lines.map((l) => journalLine(l, number, posting.typeOf)),
    };
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'purchases',
      eventType: BILL_POSTED_EVENT,
      eventKey: `bill:${id}:posted`,
      payload: { billId: id, number, journal: journalInput },
      occurredAt: now,
      origin,
    });
    if (!event.journalId)
      throw new AppError('CONFLICT', 409, 'The bill was not posted; try again.');
    // The subledger carries exactly the base amount posted to the AP control account.
    const apLine = (await getJournalLines(tx, ctx.organizationId, [event.journalId])).find(
      (l) => l.accountId === purchases!.apAccountId && l.baseCredit !== null,
    );
    const baseTotal = decimal(apLine!.baseCredit!);

    // 9. Posted: immutable from here.
    const posted = await updateBill(tx, {
      organizationId: ctx.organizationId,
      id,
      from: snapshot.status,
      version: snapshot.version,
      set: {
        status: 'POSTED',
        number,
        exchangeRate: posting.rate.toFixed(10),
        exchangeRateSource: posting.rateSource,
        tableRate: posting.tableRate ? posting.tableRate.toFixed(10) : null,
        baseTotal: baseTotal.toFixed(4),
        amountDue: snapshot.total,
        baseDue: baseTotal.toFixed(4),
        duplicateConfirmedReason: duplicates.length ? duplicateReason : null,
        postedByUserId: ctx.userId,
        postedAt: now,
        journalId: event.journalId,
        accountingEventId: event.eventId,
        updatedByUserId: ctx.userId,
        updatedAt: now,
      },
    });
    if (!posted) throw versionConflict();
    // 4A-4: the first Purchases posting fixes the AP control account.
    await lockApAccount(tx, ctx.organizationId, now);
    if (duplicates.length) {
      await this.audit(tx, ctx, 'bill.duplicate_confirmed', id, now, origin, {
        vendorReference: posted.vendorReference,
        reason: duplicateReason,
        duplicateBillIds: duplicates.map((d) => d.id),
      });
    }
    if (posting.rateSource === 'manual') {
      await this.audit(tx, ctx, 'bill.rate_overridden', id, now, origin, {
        currencyCode: posted.currencyCode,
        rate: posted.exchangeRate,
        tableRate: posted.tableRate,
        reason: posted.rateOverrideReason,
      });
    }
    await this.audit(tx, ctx, 'bill.posted', id, now, origin, {
      number,
      vendorReference: posted.vendorReference,
      total: posted.total,
      currencyCode: posted.currencyCode,
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
  // Void (P4-21; reversal through Purchases, P4-09)
  // ---------------------------------------------------------------------------

  /**
   * Voids an unpaid posted bill in an open period: its journal is reversed through Purchases on
   * the bill date, and the bill leaves the AP subledger. Needs `bills.void` and a recent password
   * confirmation (P4-42). Paid bills cannot be voided (payments are a later stage; their
   * allocations reduce `amount_due`); other corrections use vendor credits.
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
      { permission: BillPermissions.Void, sensitive: true },
      async (tx, ctx) => {
        const bill = await getBill(tx, ctx.organizationId, id, { forUpdate: true });
        if (!bill) throw new NotFoundError('Bill not found.');
        if (bill.version !== input.version) throw versionConflict();
        if (bill.status !== 'POSTED') {
          throw invalidState(
            bill.status === 'VOID'
              ? 'The bill is already void.'
              : 'Only posted bills can be voided; delete a draft instead.',
          );
        }
        if (bill.amountDue !== bill.total || bill.baseDue !== bill.baseTotal) {
          throw invalidState(
            'The bill has payments or credits applied. Void those first, or record a vendor credit.',
          );
        }
        const reason = input.reason.trim();
        const reversal = await this.journals.reverseSubledgerJournalInTransaction(
          tx,
          ctx,
          'purchases',
          bill.journalId!,
          { reason: `Bill ${bill.number} voided: ${reason}` },
          origin,
        );
        const now = this.now;
        const voided = await updateBill(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'POSTED',
          version: input.version,
          set: {
            status: 'VOID',
            amountDue: '0',
            baseDue: '0',
            voidedByUserId: ctx.userId,
            voidedAt: now,
            voidReason: reason,
            voidJournalId: reversal.id,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!voided) throw versionConflict();
        await this.audit(tx, ctx, 'bill.voided', id, now, origin, {
          number: bill.number,
          reason,
          total: bill.total,
          reversalJournalId: reversal.id,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }
}
