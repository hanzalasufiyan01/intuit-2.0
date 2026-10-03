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
import type { Discount } from '../modules/documents/index.js';
import { getParty, partyIdsMatching } from '../modules/parties/index.js';
import {
  deleteVendorCredit,
  findCreditReferenceDuplicates,
  getBill,
  getPurchasesSettings,
  getVendorCredit,
  getVendorCreditLines,
  insertVendorCredit,
  listVendorCredits,
  lockApAccount,
  replaceVendorCreditLines,
  takeNextPurchaseNumber,
  updateVendorCredit,
  VendorCreditPermissions,
  vendorCreditNumberExists,
  type Bill,
  type PurchasesSettings,
  type VendorCredit,
  type VendorCreditLine,
  type VendorCreditOrigin,
  type VendorCreditStatus,
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
  purchaseRenderSnapshot,
  resolvePurchaseDocument,
  stripPurchaseLines,
  type PurchaseLineInput,
  type ResolvedPurchaseDocument,
} from './purchase-documents.js';
import type { PurchasesOutputService } from './purchases-output-service.js';
import {
  assertOpenPeriod,
  assertRequiredDimensions,
  documentApprovalState,
  journalLine,
  shownMoney,
} from './sales-documents.js';

/**
 * Vendor credits and debit notes (ADR 0004 P4-11, P4-12, P4-23, P4-24, P4-37, P4-39, P4-42, P4-46,
 * P4-51; decided 2026-10-03). One document with origin `supplier_credit_note` (received) or
 * `debit_note` (raised by us). Both reduce what we owe: the journal is the reverse of a bill,
 * built by the shared purchase journal builder. The lifecycle mirrors bills: drafts under
 * optimistic versions; submit opens an approval request when a policy step matches; Post
 * (`vendor_credits.post`, re-authenticated, P4-42) recomputes, re-checks approval, fixes the rate
 * (the linked bill's rate, or the table rate or a manual override with a reason), takes the VC- or
 * DN- number and posts through `purchases.vendor_credit_posted`. A debit note freezes its render
 * snapshot and gets a PDF. A posted credit is voided only while fully unapplied and unrefunded,
 * through the Purchases reversal (P4-24). Linked bills are referenced, not applied (application
 * comes with the later settlement stage).
 */

export const VENDOR_CREDIT_POST_ACTION = 'purchases.vendor_credit.post';
export const VENDOR_CREDIT_POSTED_EVENT = 'purchases.vendor_credit_posted';
const RESOURCE = 'purchases_vendor_credit';

export interface VendorCreditDraftInput {
  vendorId: string;
  creditDate: string;
  billId?: string | null | undefined;
  vendorReference?: string | null | undefined;
  currencyCode?: string | undefined;
  rateOverride?: string | null | undefined;
  rateOverrideReason?: string | null | undefined;
  taxTreatment?: TaxTreatment | undefined;
  discount?: Discount | null | undefined;
  memo?: string | undefined;
  dimensionValueIds?: string[] | undefined;
  lines: PurchaseLineInput[];
}

type ResolvedCredit = ResolvedPurchaseDocument & {
  header: ResolvedPurchaseDocument['header'] & {
    creditDate: string;
    billId: string | null;
    vendorReference: string | null;
    rateOverride: string | null;
    rateOverrideReason: string | null;
  };
  bill: Bill | null;
};

const NOUN: Record<VendorCreditOrigin, string> = {
  supplier_credit_note: 'Vendor credit',
  debit_note: 'Debit note',
};

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'This vendor credit was changed by someone else. Reload it and apply your changes again.',
  );

function encodeCursor(credit: VendorCredit) {
  return Buffer.from(JSON.stringify({ d: credit.creditDate, i: credit.id })).toString('base64url');
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

export class VendorCreditService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly approvals: ApprovalService,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
    private readonly output: PurchasesOutputService,
  ) {
    approvals.register({
      actionKey: VENDOR_CREDIT_POST_ACTION,
      label: 'Approve vendor credits and debit notes before posting',
      subjectType: RESOURCE,
      approverPermission: VendorCreditPermissions.Approve,
      decisionRequiresReauth: false,
      // P4-37: the AP line's base at the credit's rate; the transaction type is the origin.
      conditions: { amount: true, transactionTypes: ['supplier_credit_note', 'debit_note'] },
      onApproved: async (tx, { request, authz, now, origin }) => {
        // Approval authorizes; the credit stays pending until someone posts it.
        await this.audit(tx, authz, 'vendor_credit.approved', request.subjectId, now, origin, {
          approvalRequestId: request.id,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        // A rejection needs a reason; refusing here rolls the whole decision back.
        if (!comment?.trim()) {
          throw new ValidationError([
            { path: 'comment', message: 'Give a reason for rejecting the vendor credit.' },
          ]);
        }
        const credit = await updateVendorCredit(tx, {
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
        if (!credit) throw invalidState('The vendor credit is no longer awaiting approval.');
        await this.audit(tx, authz, 'vendor_credit.rejected', credit.id, now, origin, {
          approvalRequestId: request.id,
          comment: comment.trim(),
        });
      },
    });
    // The journal a posted vendor credit posts; Purchases owns the approval (Decision 13).
    journals.registerEventHandler(
      VENDOR_CREDIT_POSTED_EVENT,
      (event) => event.payload.journal as never,
      { domainApproval: true },
    );
  }

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: Pick<AuthorizationContext, 'organizationId' | 'userId'>,
    action: string,
    creditId: string,
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
      resourceId: creditId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /** The linked bill must be a posted bill of the same vendor and currency (decided 2026-10-03). */
  private async linkedBill(
    tx: Transaction,
    organizationId: string,
    billId: string | null | undefined,
    vendorId: string,
  ): Promise<{ bill: Bill | null; issues: ValidationIssue[] }> {
    if (!billId) return { bill: null, issues: [] };
    const bill = await getBill(tx, organizationId, billId);
    if (!bill) return { bill: null, issues: [{ path: 'billId', message: 'Bill not found.' }] };
    if (bill.vendorId !== vendorId) {
      return { bill, issues: [{ path: 'billId', message: 'The bill is from another vendor.' }] };
    }
    if (bill.status !== 'POSTED') {
      return { bill, issues: [{ path: 'billId', message: 'Only a posted bill can be credited.' }] };
    }
    return { bill, issues: [] };
  }

  private async resolve(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    purchases: PurchasesSettings | undefined,
    origin: VendorCreditOrigin,
    input: VendorCreditDraftInput,
    existing?: { credit: VendorCredit; lines: readonly VendorCreditLine[] },
  ): Promise<ResolvedCredit> {
    const link = await this.linkedBill(tx, organizationId, input.billId, input.vendorId);
    if (link.issues.length) throw new ValidationError(link.issues);
    const resolved = await resolvePurchaseDocument(
      tx,
      organizationId,
      accounting,
      purchases,
      {
        ...input,
        date: input.creditDate,
        // A credit for a bill is in the bill's currency.
        currencyCode: input.currencyCode ?? link.bill?.currencyCode,
      },
      {
        datePath: 'creditDate',
        noun: 'vendor credits',
        existing: existing && {
          vendorId: existing.credit.vendorId,
          dimensionValueIds: existing.credit.dimensionValueIds,
          lines: existing.lines,
        },
      },
    );
    const issues: ValidationIssue[] = [];
    if (link.bill && link.bill.currencyCode !== resolved.header.currencyCode) {
      issues.push({
        path: 'currencyCode',
        message: 'A credit for a bill is in the bill currency.',
      });
    }
    const vendorReference = input.vendorReference?.trim() || null;
    if (origin === 'debit_note' && vendorReference) {
      issues.push({
        path: 'vendorReference',
        message: 'Debit notes carry our own number; they have no supplier reference.',
      });
    }
    const rateOverride = input.rateOverride ?? null;
    const rateOverrideReason = input.rateOverrideReason?.trim() || null;
    if (rateOverride !== null) {
      const parsed = parseRate(rateOverride);
      if (link.bill) {
        issues.push({
          path: 'rateOverride',
          message: "A credit for a bill uses the bill's exchange rate.",
        });
      } else if (!parsed.ok) {
        issues.push({
          path: 'rateOverride',
          message: 'Rates are positive decimal strings with at most 10 decimals.',
        });
      } else if (resolved.header.currencyCode === accounting.baseCurrency) {
        issues.push({
          path: 'rateOverride',
          message: 'A base-currency credit has no exchange rate to override.',
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
      bill: link.bill,
      header: {
        ...resolved.header,
        creditDate: input.creditDate,
        billId: link.bill?.id ?? null,
        vendorReference: origin === 'debit_note' ? null : vendorReference,
        rateOverride: rateOverride === null ? null : decimal(rateOverride).toFixed(10),
        rateOverrideReason: rateOverride === null ? null : rateOverrideReason,
      },
    };
  }

  /** P4-16 parity: a manual rate needs `vendor_credits.post`; P4-12: an explicit choice needs create. */
  private assertOverridePermissions(
    ctx: AuthorizationContext,
    resolved: ResolvedCredit,
    existing?: { credit: VendorCredit; lines: readonly VendorCreditLine[] },
  ) {
    const rateChanged =
      resolved.header.rateOverride !== null &&
      (resolved.header.rateOverride !== existing?.credit.rateOverride ||
        resolved.header.rateOverrideReason !== existing?.credit.rateOverrideReason);
    if (rateChanged) requirePermission(ctx, VendorCreditPermissions.Post);
    const stored = new Map(existing?.lines.map((l) => [l.lineNo, l.taxRecoverableOverride]));
    const newOverride = resolved.lines.some(
      (l) =>
        l.taxRecoverableOverride !== null &&
        l.taxRecoverableOverride !== undefined &&
        stored.get(l.lineNo) !== l.taxRecoverableOverride,
    );
    if (newOverride) requirePermission(ctx, VendorCreditPermissions.Create);
  }

  private inputOf(
    credit: VendorCredit,
    lines: readonly VendorCreditLine[],
  ): VendorCreditDraftInput {
    return {
      vendorId: credit.vendorId,
      creditDate: credit.creditDate,
      billId: credit.billId,
      vendorReference: credit.vendorReference,
      currencyCode: credit.currencyCode,
      rateOverride: credit.rateOverride,
      rateOverrideReason: credit.rateOverrideReason,
      taxTreatment: credit.taxTreatment,
      discount: credit.discountType
        ? { type: credit.discountType, value: credit.discountValue! }
        : null,
      memo: credit.memo,
      dimensionValueIds: credit.dimensionValueIds,
      lines: purchaseLinesAsInput(lines),
    };
  }

  private async posting(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    purchases: PurchasesSettings | undefined,
    credit: VendorCredit,
    lines: readonly VendorCreditLine[],
  ) {
    const bill = credit.billId ? await getBill(tx, organizationId, credit.billId) : undefined;
    return purchaseDocumentPosting(
      tx,
      organizationId,
      accounting,
      purchases,
      {
        direction: 'vendor_credit',
        label: `${NOUN[credit.origin]} ${credit.number ?? '(draft)'}`,
        transactionType: credit.origin,
        date: credit.creditDate,
        currencyCode: credit.currencyCode,
        dimensionValueIds: credit.dimensionValueIds,
        rateOverride: credit.rateOverride,
        fixedRate: bill && bill.currencyCode !== accounting.baseCurrency ? bill.exchangeRate : null,
      },
      lines,
    );
  }

  private async warnings(tx: Transaction, organizationId: string, credit: VendorCredit) {
    const warnings: { code: string; message: string; matches?: unknown }[] = [];
    if (credit.origin === 'supplier_credit_note' && credit.vendorReference) {
      const duplicates = await findCreditReferenceDuplicates(tx, {
        organizationId,
        vendorId: credit.vendorId,
        vendorReference: credit.vendorReference,
        exceptId: credit.id,
      });
      if (duplicates.length) {
        warnings.push({
          code: 'POSSIBLE_DUPLICATE',
          message: 'Another credit from this vendor has the same supplier reference.',
          matches: duplicates,
        });
      }
    }
    if (credit.billId) {
      const bill = await getBill(tx, organizationId, credit.billId);
      if (bill && bill.status !== 'POSTED') {
        warnings.push({
          code: 'BILL_NOT_POSTED',
          message: 'The linked bill is no longer posted; posting this credit will be refused.',
        });
      }
    }
    return warnings;
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private summary(credit: VendorCredit, name: string | null) {
    const c = credit.currencyCode;
    return {
      id: credit.id,
      origin: credit.origin,
      status: credit.status,
      number: credit.number,
      vendorId: credit.vendorId,
      vendorName: name,
      billId: credit.billId,
      vendorReference: credit.vendorReference,
      creditDate: credit.creditDate,
      currencyCode: c,
      subtotal: shownMoney(credit.subtotal, c),
      discountTotal: shownMoney(credit.discountTotal, c),
      taxTotal: shownMoney(credit.taxTotal, c),
      recoverableTaxTotal: shownMoney(credit.recoverableTaxTotal, c),
      total: shownMoney(credit.total, c),
      amountUnapplied: shownMoney(credit.amountUnapplied, c),
      baseTotal: credit.baseTotal,
      baseUnapplied: credit.baseUnapplied,
      version: credit.version,
      postedAt: credit.postedAt?.toISOString() ?? null,
      voidedAt: credit.voidedAt?.toISOString() ?? null,
    };
  }

  private lineView(l: VendorCreditLine, currency: string) {
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

  private async detail(tx: Transaction, ctx: AuthorizationContext, creditId: string) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const credit = await getVendorCredit(tx, ctx.organizationId, creditId);
    if (!credit) throw new NotFoundError('Vendor credit not found.');
    const lines = await getVendorCreditLines(tx, ctx.organizationId, credit.id);
    const open = credit.status === 'DRAFT' || credit.status === 'PENDING_APPROVAL';
    const purchases = await getPurchasesSettings(tx, ctx.organizationId);
    const facts = open
      ? (await this.posting(tx, ctx.organizationId, accounting, purchases, credit, lines)).facts
      : null;
    const taxProblems = open ? (await inputTaxCheck(tx, ctx.organizationId, lines)).issues : [];
    const bill = credit.billId ? await getBill(tx, ctx.organizationId, credit.billId) : undefined;
    return {
      ...this.summary(credit, await vendorName(tx, ctx.organizationId, credit.vendorId)),
      billNumber: bill?.number ?? null,
      exchangeRate: credit.exchangeRate,
      exchangeRateSource: credit.exchangeRateSource,
      tableRate: credit.tableRate,
      rateOverride: credit.rateOverride,
      rateOverrideReason: credit.rateOverrideReason,
      taxTreatment: credit.taxTreatment,
      discount: credit.discountType
        ? { type: credit.discountType, value: decimal(credit.discountValue!).toFixed() }
        : null,
      memo: credit.memo,
      dimensionValueIds: credit.dimensionValueIds,
      journalId: credit.journalId,
      pdfFileId: credit.pdfFileId,
      voidReason: credit.voidReason,
      voidJournalId: credit.voidJournalId,
      createdByUserId: credit.createdByUserId,
      baseCurrency: accounting.baseCurrency,
      lines: lines.map((l) => this.lineView(l, credit.currencyCode)),
      approval: await documentApprovalState(
        this.approvals,
        tx,
        ctx.organizationId,
        VENDOR_CREDIT_POST_ACTION,
        credit,
        facts,
      ),
      warnings: open
        ? [
            ...(await this.warnings(tx, ctx.organizationId, credit)),
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
      status?: VendorCreditStatus[] | undefined;
      origin?: VendorCreditOrigin | undefined;
      vendorId?: string | undefined;
      billId?: string | undefined;
      search?: string | undefined;
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorCreditPermissions.View },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const search = query.search?.trim() || null;
        const page = await listVendorCredits(tx, {
          organizationId: ctx.organizationId,
          statuses: query.status?.length ? query.status : null,
          origin: query.origin ?? null,
          vendorId: query.vendorId ?? null,
          billId: query.billId ?? null,
          search,
          vendorIdsIn: search
            ? vendorIdsOfParties(ctx.organizationId, partyIdsMatching(ctx.organizationId, search))
            : undefined,
          limit: query.limit,
          after: query.after ? decodeCursor(query.after) : null,
        });
        const names = new Map<string, string | null>();
        for (const id of new Set(page.items.map((c) => c.vendorId))) {
          names.set(id, await vendorName(tx, ctx.organizationId, id));
        }
        const last = page.items.at(-1);
        return {
          items: page.items.map((c) => this.summary(c, names.get(c.vendorId) ?? null)),
          nextCursor: page.hasMore && last ? encodeCursor(last) : null,
        };
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorCreditPermissions.View },
      (tx, ctx) => this.detail(tx, ctx, id),
    );
  }

  // ---------------------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------------------

  /** Creates a draft; with an Idempotency-Key a retry returns the first result (Decision 23). */
  create(
    principal: Principal,
    input: VendorCreditDraftInput & { origin: VendorCreditOrigin },
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorCreditPermissions.Create },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'purchases.vendor_credit.create', request: input },
          async () => {
            const accounting = await requireAccountingSettings(tx, ctx.organizationId);
            const purchases = await getPurchasesSettings(tx, ctx.organizationId);
            const resolved = await this.resolve(
              tx,
              ctx.organizationId,
              accounting,
              purchases,
              input.origin,
              input,
            );
            this.assertOverridePermissions(ctx, resolved);
            const now = this.now;
            const credit = await insertVendorCredit(tx, {
              ...resolved.header,
              organizationId: ctx.organizationId,
              origin: input.origin,
              createdByUserId: ctx.userId,
              createdAt: now,
              updatedByUserId: ctx.userId,
              updatedAt: now,
            });
            await replaceVendorCreditLines(
              tx,
              ctx.organizationId,
              credit.id,
              stripPurchaseLines(resolved.lines),
            );
            await this.audit(tx, ctx, 'vendor_credit.created', credit.id, now, origin, {
              origin: credit.origin,
              vendorId: credit.vendorId,
              billId: credit.billId,
              creditDate: credit.creditDate,
              currencyCode: credit.currencyCode,
              total: credit.total,
              lines: resolved.lines.length,
              ...(credit.rateOverride
                ? {
                    rateOverride: credit.rateOverride,
                    rateOverrideReason: credit.rateOverrideReason,
                  }
                : {}),
            });
            return this.detail(tx, ctx, credit.id);
          },
        ),
    );
  }

  update(
    principal: Principal,
    id: string,
    input: VendorCreditDraftInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorCreditPermissions.Create },
      async (tx, ctx) => {
        const credit = await this.lockDraft(tx, ctx, id, input.version, 'edited');
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const purchases = await getPurchasesSettings(tx, ctx.organizationId);
        const existingLines = await getVendorCreditLines(tx, ctx.organizationId, id);
        const existing = { credit, lines: existingLines };
        const resolved = await this.resolve(
          tx,
          ctx.organizationId,
          accounting,
          purchases,
          credit.origin,
          input,
          existing,
        );
        this.assertOverridePermissions(ctx, resolved, existing);
        const now = this.now;
        const updated = await updateVendorCredit(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: input.version,
          set: { ...resolved.header, updatedByUserId: ctx.userId, updatedAt: now },
        });
        if (!updated) throw versionConflict();
        await replaceVendorCreditLines(
          tx,
          ctx.organizationId,
          id,
          stripPurchaseLines(resolved.lines),
        );
        await this.audit(tx, ctx, 'vendor_credit.updated', id, now, origin, {
          version: updated.version,
          total: { before: credit.total, after: updated.total },
          lines: resolved.lines.length,
          ...(updated.rateOverride !== credit.rateOverride ||
          updated.rateOverrideReason !== credit.rateOverrideReason
            ? {
                rateOverride: {
                  before: credit.rateOverride,
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
      { permission: VendorCreditPermissions.Create },
      async (tx, ctx) => {
        const credit = await this.lockDraft(tx, ctx, id, input.version, 'deleted');
        await deleteVendorCredit(tx, ctx.organizationId, id);
        await this.audit(tx, ctx, 'vendor_credit.deleted', id, this.now, origin, {
          origin: credit.origin,
          vendorId: credit.vendorId,
          total: credit.total,
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
    const credit = await getVendorCredit(tx, ctx.organizationId, id, { forUpdate: true });
    if (!credit) throw new NotFoundError('Vendor credit not found.');
    if (credit.version !== version) throw versionConflict();
    if (credit.status !== 'DRAFT') {
      throw invalidState(
        credit.status === 'PENDING_APPROVAL'
          ? `The vendor credit is awaiting approval. Withdraw it before it can be ${verb}.`
          : verb === 'deleted'
            ? 'Only draft vendor credits can be deleted; posted ones are voided.'
            : 'Only draft vendor credits can be edited.',
      );
    }
    return credit;
  }

  // ---------------------------------------------------------------------------
  // Approval (P4-37) and post
  // ---------------------------------------------------------------------------

  submit(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorCreditPermissions.Create },
      async (tx, ctx) => {
        const credit = await getVendorCredit(tx, ctx.organizationId, id, { forUpdate: true });
        if (!credit) throw new NotFoundError('Vendor credit not found.');
        if (credit.version !== input.version) throw versionConflict();
        if (credit.status !== 'DRAFT') {
          throw invalidState('Only draft vendor credits can be submitted.');
        }
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const purchases = await getPurchasesSettings(tx, ctx.organizationId);
        const lines = await getVendorCreditLines(tx, ctx.organizationId, id);
        const { facts, journal, typeOf } = await this.posting(
          tx,
          ctx.organizationId,
          accounting,
          purchases,
          credit,
          lines,
        );
        // Required dimensions are enforced at submit and at post (architecture rules, D10).
        await assertRequiredDimensions(tx, ctx.organizationId, journal.lines, typeOf);
        const now = this.now;
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: VENDOR_CREDIT_POST_ACTION,
          subjectId: id,
          // No self-approval: neither the preparer nor the submitter.
          excludedUserIds: [...new Set([ctx.userId, credit.createdByUserId])],
          reason: null,
          facts,
          now,
        });
        if (!request) {
          throw invalidState('No approval step applies to this vendor credit; post it directly.');
        }
        const updated = await updateVendorCredit(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: credit.version,
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
        await this.audit(tx, ctx, 'vendor_credit.submitted', id, now, origin, {
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
      { permission: VendorCreditPermissions.Create },
      async (tx, ctx) => {
        const credit = await getVendorCredit(tx, ctx.organizationId, id, { forUpdate: true });
        if (!credit) throw new NotFoundError('Vendor credit not found.');
        if (credit.version !== input.version) throw versionConflict();
        if (credit.status !== 'PENDING_APPROVAL') {
          throw invalidState('Only a vendor credit awaiting approval can be withdrawn.');
        }
        const now = this.now;
        const request = credit.approvalRequestId
          ? await getApprovalRequest(tx, ctx.organizationId, credit.approvalRequestId, {
              forUpdate: true,
            })
          : undefined;
        if (request?.status === 'pending') {
          await this.approvals.withdrawRequest(tx, ctx.organizationId, request.id, now);
        }
        const updated = await updateVendorCredit(tx, {
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
        await this.audit(tx, ctx, 'vendor_credit.withdrawn', id, now, origin, {
          approvalRequestId: request?.id ?? null,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  /**
   * Post: one transaction that assigns the number, snapshots the credit and posts it through the
   * accounting event. Re-authenticated (P4-42). Any failure rolls back everything.
   */
  post(
    principal: Principal,
    id: string,
    input: { version: number },
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorCreditPermissions.Post, sensitive: true },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          {
            key: options.idempotencyKey,
            scope: 'purchases.vendor_credit.post',
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
    input: { version: number },
    origin: EventOrigin,
  ) {
    // 1. Lock, version and state; the Purchases settings row too (the AP lock is set under it).
    const credit = await getVendorCredit(tx, ctx.organizationId, id, { forUpdate: true });
    if (!credit) throw new NotFoundError('Vendor credit not found.');
    if (credit.version !== input.version) throw versionConflict();
    if (credit.status !== 'DRAFT' && credit.status !== 'PENDING_APPROVAL') {
      throw invalidState(`A ${credit.status.toLowerCase()} vendor credit cannot be posted.`);
    }
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const purchases = await getPurchasesSettings(tx, ctx.organizationId, { forUpdate: true });

    // 2. Recompute with today's references.
    const existing = await getVendorCreditLines(tx, ctx.organizationId, id);
    const vendor = await getVendor(tx, ctx.organizationId, credit.vendorId);
    const party = vendor ? await getParty(tx, ctx.organizationId, vendor.partyId) : undefined;
    const issues: ValidationIssue[] = [];
    if (vendor?.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
      issues.push({
        path: 'vendorId',
        message: 'Credits from archived vendors cannot be posted.',
      });
    }
    const resolved = await this.resolve(
      tx,
      ctx.organizationId,
      accounting,
      purchases,
      credit.origin,
      this.inputOf(credit, existing),
      { credit: { ...credit, vendorId: '', dimensionValueIds: [] }, lines: [] },
    );
    if (decimal(resolved.header.total).lte(0)) {
      issues.push({ path: 'lines', message: 'The credit total must be greater than zero.' });
    }
    // The supplier's credit-note number is required to post a supplier credit note.
    if (credit.origin === 'supplier_credit_note' && !resolved.header.vendorReference) {
      issues.push({
        path: 'vendorReference',
        message: "Enter the supplier's credit-note number before posting.",
      });
    }
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
    const inputTax = await inputTaxCheck(tx, ctx.organizationId, resolved.lines);
    issues.push(...inputTax.issues);
    if (issues.length) throw new ValidationError(issues, 'The vendor credit cannot be posted yet.');

    const now = this.now;
    const snapshot = await updateVendorCredit(tx, {
      organizationId: ctx.organizationId,
      id,
      from: credit.status,
      version: credit.version,
      set: { ...resolved.header, updatedByUserId: ctx.userId, updatedAt: now },
    });
    if (!snapshot) throw versionConflict();
    const lines = await replaceVendorCreditLines(
      tx,
      ctx.organizationId,
      id,
      stripPurchaseLines(resolved.lines).map((l, i) => ({
        ...l,
        inputTaxAccountId: inputTax.accounts[i] ?? null,
      })),
    );

    // 3. Rate (the bill's, the table's or the manual one) and the journal; its base total is the
    // approval amount.
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
        `An exchange rate from ${snapshot.currencyCode} to ${accounting.baseCurrency} is required for ${snapshot.creditDate}.`,
      );
    }

    // 4. Approval, re-checked against the recomputed facts (S10-06).
    const approval = await documentApprovalState(
      this.approvals,
      tx,
      ctx.organizationId,
      VENDOR_CREDIT_POST_ACTION,
      snapshot,
      posting.facts,
    );
    if (!approval.readyToIssue) {
      throw new AppError(
        'APPROVAL_REQUIRED',
        409,
        snapshot.status === 'DRAFT'
          ? 'This vendor credit needs approval: submit it for approval first.'
          : approval.approvalOutdated
            ? 'The credit amount now needs further approval. Withdraw it and submit it again.'
            : 'The vendor credit has not received all required approvals.',
      );
    }

    // 5. Period open on the credit date; required dimensions (D10).
    await assertOpenPeriod(tx, ctx.organizationId, snapshot.creditDate);
    await assertRequiredDimensions(tx, ctx.organizationId, posting.journal.lines, posting.typeOf);

    // 6. Number (P4-51): VC- for supplier credit notes, DN- for debit notes; not gapless.
    const sequence = credit.origin === 'debit_note' ? 'debit_note' : 'vendor_credit';
    let number: string | null = null;
    for (let attempt = 0; attempt < 50 && !number; attempt += 1) {
      const taken = await takeNextPurchaseNumber(tx, ctx.organizationId, sequence);
      if (!taken) {
        throw new ValidationError([
          { path: 'numbering', message: 'Save the Purchases settings before posting credits.' },
        ]);
      }
      if (!(await vendorCreditNumberExists(tx, ctx.organizationId, taken.number))) {
        number = taken.number;
      }
    }
    if (!number) {
      throw new AppError(
        'CONFLICT',
        409,
        'Could not find a free credit number; check the numbering.',
      );
    }
    const foreign = snapshot.currencyCode !== accounting.baseCurrency;
    const reference = snapshot.vendorReference ? ` (${snapshot.vendorReference})` : '';
    const journalInput = {
      entryDate: snapshot.creditDate,
      description: `${NOUN[credit.origin]} ${number} — ${party!.displayName}${reference}`.slice(
        0,
        500,
      ),
      reference: number,
      currency: snapshot.currencyCode,
      exchangeRate: foreign ? posting.rate.toFixed(10) : null,
      ...(foreign
        ? { exchangeRateSource: posting.rateSource === 'manual' ? 'manual' : ('table' as const) }
        : {}),
      sourceRef: { module: 'purchases', type: 'vendor_credit', id },
      lines: posting.journal.lines.map((l) => journalLine(l, number, posting.typeOf)),
    };
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'purchases',
      eventType: VENDOR_CREDIT_POSTED_EVENT,
      eventKey: `vendor_credit:${id}:posted`,
      payload: { vendorCreditId: id, number, journal: journalInput },
      occurredAt: now,
      origin,
    });
    if (!event.journalId) {
      throw new AppError('CONFLICT', 409, 'The vendor credit was not posted; try again.');
    }
    // The subledger carries exactly the base amount posted to the AP control account (a debit).
    const apLine = (await getJournalLines(tx, ctx.organizationId, [event.journalId])).find(
      (l) => l.accountId === purchases!.apAccountId && l.baseDebit !== null,
    );
    const baseTotal = decimal(apLine!.baseDebit!);
    const bill = snapshot.billId ? await getBill(tx, ctx.organizationId, snapshot.billId) : null;

    // 7. Posted: immutable from here.
    const posted = await updateVendorCredit(tx, {
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
        amountUnapplied: snapshot.total,
        baseUnapplied: baseTotal.toFixed(4),
        postedByUserId: ctx.userId,
        postedAt: now,
        journalId: event.journalId,
        accountingEventId: event.eventId,
        renderSnapshot:
          credit.origin === 'debit_note'
            ? await purchaseRenderSnapshot(
                tx,
                ctx.organizationId,
                {
                  documentType: 'debit_note',
                  number,
                  vendorId: snapshot.vendorId,
                  creditDate: snapshot.creditDate,
                  billNumber: bill?.number ?? null,
                  currencyCode: snapshot.currencyCode,
                  taxTreatment: snapshot.taxTreatment,
                  memo: snapshot.memo,
                  subtotal: snapshot.subtotal,
                  discountTotal: snapshot.discountTotal,
                  taxTotal: snapshot.taxTotal,
                  total: snapshot.total,
                },
                lines,
              )
            : null,
        updatedByUserId: ctx.userId,
        updatedAt: now,
      },
    });
    if (!posted) throw versionConflict();
    await lockApAccount(tx, ctx.organizationId, now);
    if (credit.origin === 'debit_note') {
      // The PDF is rendered from the frozen snapshot off the request path (P4-46).
      await this.output.enqueuePdfInTransaction(tx, ctx, id);
    }
    if (posting.rateSource === 'manual') {
      await this.audit(tx, ctx, 'vendor_credit.rate_overridden', id, now, origin, {
        currencyCode: posted.currencyCode,
        rate: posted.exchangeRate,
        tableRate: posted.tableRate,
        reason: posted.rateOverrideReason,
      });
    }
    await this.audit(tx, ctx, 'vendor_credit.posted', id, now, origin, {
      origin: posted.origin,
      number,
      billId: posted.billId,
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
  // Void (P4-24; reversal through Purchases, P4-09)
  // ---------------------------------------------------------------------------

  /**
   * Voids a posted vendor credit that is fully unapplied and unrefunded, in an open period: its
   * journal is reversed through Purchases on the credit date. Needs `vendor_credits.void` and a
   * recent password confirmation (P4-24, P4-42). Application and refunds come in later stages;
   * they reduce `amount_unapplied`, which blocks the void here and in the database guard.
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
      { permission: VendorCreditPermissions.Void, sensitive: true },
      async (tx, ctx) => {
        const credit = await getVendorCredit(tx, ctx.organizationId, id, { forUpdate: true });
        if (!credit) throw new NotFoundError('Vendor credit not found.');
        if (credit.version !== input.version) throw versionConflict();
        if (credit.status !== 'POSTED') {
          throw invalidState(
            credit.status === 'VOID'
              ? 'The vendor credit is already void.'
              : 'Only posted vendor credits can be voided; delete a draft instead.',
          );
        }
        if (credit.amountUnapplied !== credit.total || credit.baseUnapplied !== credit.baseTotal) {
          throw invalidState(
            'The vendor credit has been applied or refunded and cannot be voided.',
          );
        }
        const reason = input.reason.trim();
        const reversal = await this.journals.reverseSubledgerJournalInTransaction(
          tx,
          ctx,
          'purchases',
          credit.journalId!,
          { reason: `${NOUN[credit.origin]} ${credit.number} voided: ${reason}` },
          origin,
        );
        const now = this.now;
        const voided = await updateVendorCredit(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'POSTED',
          version: input.version,
          set: {
            status: 'VOID',
            amountUnapplied: '0',
            baseUnapplied: '0',
            voidedByUserId: ctx.userId,
            voidedAt: now,
            voidReason: reason,
            voidJournalId: reversal.id,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!voided) throw versionConflict();
        await this.audit(tx, ctx, 'vendor_credit.voided', id, now, origin, {
          number: credit.number,
          reason,
          total: credit.total,
          reversalJournalId: reversal.id,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }
}
