import type { Decimal } from 'decimal.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { convertToBase, decimal, minorUnits, parseAmount } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  findApplicableRate,
  getDesignatedAccountId,
  getDimensionValuesByIds,
  getJournalLines,
  openingDateFor,
  isValidIsoDate,
  type AccountingSettings,
} from '../modules/accounting/index.js';
import { getApprovalRequest, type ApprovalFacts } from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getCustomer } from '../modules/customers/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  deleteInvoice,
  dueDateFor,
  findSimilarInvoices,
  getInvoice,
  getInvoiceLines,
  getSalesSettings,
  insertInvoice,
  invoiceNumberExists,
  listAllocations,
  listInvoices,
  lockArAccount,
  openInvoiceBalance,
  replaceInvoiceLines,
  SalesPermissions,
  updateInvoice,
  type Discount,
  type Invoice,
  type InvoiceKind,
  type InvoiceLine,
  type InvoiceStatus,
  type PostingLine,
  type SalesSettings,
} from '../modules/sales/index.js';
import type { TaxTreatment } from '../modules/tax/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { ApprovalService } from './approval-service.js';
import { requirePermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import type { SalesOutputService } from './sales-output-service.js';
import {
  assertOpenPeriod,
  assertRequiredDimensions,
  customerName,
  customersMatching,
  documentApprovalState,
  documentLineView,
  documentPosting,
  journalLine,
  linesAsInput,
  nextDocumentNumber,
  renderSnapshot,
  resolveDocument,
  shownMoney,
  stripLines,
  type DocumentLineInput,
  type ResolvedDocument,
} from './sales-documents.js';

/**
 * Invoices (Phase 3B steps 6, 7, 13; Decisions 13, 15, 16, 23, 32–35, 46, 48, 77; D1, D8, D9, D10).
 *
 * Drafts are edited under optimistic concurrency and every amount is computed here. Submitting
 * opens an approval request when a policy step matches the invoice's facts; approval only
 * authorizes (D1). Issue is one transaction: lock, re-check approval against the recomputed
 * facts (S10-06), check the period and the table rate on the invoice date (D9), assign the
 * number, snapshot rates and rendering data, and post through the `sales.invoice_issued`
 * accounting event. An unpaid invoice is voided by reversing its journal through Sales (E2).
 * Sales never writes ledger tables.
 */

export const INVOICE_ISSUE_ACTION = 'sales.invoice.issue';
export const INVOICE_ISSUED_EVENT = 'sales.invoice_issued';
const RESOURCE = 'sales_invoice';

export type InvoiceLineInput = DocumentLineInput;

export interface InvoiceDraftInput {
  customerId: string;
  invoiceDate: string;
  dueDate?: string | null | undefined;
  paymentTermsDays?: number | null | undefined;
  currencyCode?: string | undefined;
  taxTreatment?: TaxTreatment | undefined;
  discount?: Discount | null | undefined;
  reference?: string | null | undefined;
  memo?: string | undefined;
  dimensionValueIds?: string[] | undefined;
  lines: InvoiceLineInput[];
  /** D5: 'opening' brings a conversion-date balance into AR (set when the draft is created). */
  kind?: InvoiceKind | undefined;
  /** D5 / S8-06: an explicit base carrying value for a foreign-currency opening invoice. */
  openingBaseTotal?: string | null | undefined;
}

type ResolvedInvoice = ResolvedDocument & {
  header: ResolvedDocument['header'] & {
    invoiceDate: string;
    dueDate: string;
    paymentTermsDays: number | null;
    openingBaseTotal: string | null;
  };
};

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'This invoice was changed by someone else. Reload it and apply your changes again.',
  );

function encodeCursor(invoice: Invoice) {
  return Buffer.from(JSON.stringify({ d: invoice.invoiceDate, i: invoice.id })).toString(
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

export class InvoiceService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly approvals: ApprovalService,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
    private readonly output: SalesOutputService,
  ) {
    approvals.register({
      actionKey: INVOICE_ISSUE_ACTION,
      label: 'Approve invoices before issuing',
      subjectType: RESOURCE,
      approverPermission: SalesPermissions.InvoicesApprove,
      decisionRequiresReauth: false,
      // Decision 77: the base-currency total at the document rate; standard or opening invoices.
      conditions: { amount: true, transactionTypes: ['standard', 'opening'] },
      onApproved: async (tx, { request, authz, now, origin }) => {
        // D1: approval authorizes; the invoice stays pending until someone issues it.
        await this.audit(tx, authz, 'invoice.approved', request.subjectId, now, origin, {
          approvalRequestId: request.id,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        const invoice = await updateInvoice(tx, {
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
        if (!invoice) throw invalidState('The invoice is no longer awaiting approval.');
        await this.audit(tx, authz, 'invoice.rejected', invoice.id, now, origin, {
          approvalRequestId: request.id,
          comment,
        });
      },
    });
    // The journal an issued invoice posts; Sales owns the approval (Decision 13).
    journals.registerEventHandler(INVOICE_ISSUED_EVENT, (event) => event.payload.journal as never, {
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
    invoiceId: string,
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
      resourceId: invoiceId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /** The shared document rules plus the due date: explicit, or date + terms (D9 in ADR 0003). */
  private async resolve(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    sales: SalesSettings | undefined,
    input: InvoiceDraftInput,
    existing?: { invoice: Invoice; lines: readonly InvoiceLine[] },
  ): Promise<ResolvedInvoice> {
    const kind: InvoiceKind = existing?.invoice.kind ?? input.kind ?? 'standard';
    const opening = kind === 'opening' ? this.openingIssues(accounting, input) : null;
    const resolved = await resolveDocument(
      tx,
      organizationId,
      accounting,
      sales,
      opening
        ? {
            ...input,
            date: input.invoiceDate,
            // D5: no tax and no revenue on an opening invoice.
            taxTreatment: 'no_tax',
            lines: input.lines.map((l) => ({ ...l, taxCodeId: null, revenueAccountId: null })),
          }
        : { ...input, date: input.invoiceDate },
      {
        datePath: 'invoiceDate',
        noun: 'invoices',
        existing: existing && {
          customerId: existing.invoice.customerId,
          dimensionValueIds: existing.invoice.dimensionValueIds,
          lines: existing.lines,
        },
      },
    );
    let dueDate: string;
    let paymentTermsDays: number | null;
    if (input.dueDate) {
      dueDate = input.dueDate;
      paymentTermsDays = null;
      const issues: ValidationIssue[] = [];
      if (!isValidIsoDate(dueDate)) {
        issues.push({ path: 'dueDate', message: 'Enter a valid date (YYYY-MM-DD).' });
      } else if (dueDate < input.invoiceDate) {
        issues.push({
          path: 'dueDate',
          message: 'The due date cannot be before the invoice date.',
        });
      }
      if (issues.length) throw new ValidationError(issues);
    } else {
      paymentTermsDays =
        input.paymentTermsDays ??
        resolved.customer.paymentTermsDays ??
        sales?.defaultPaymentTermsDays ??
        30;
      dueDate = dueDateFor(input.invoiceDate, paymentTermsDays);
    }
    const openingBaseTotal = opening
      ? this.openingBase(accounting, resolved.header.currencyCode, input)
      : null;
    return {
      ...resolved,
      header: {
        ...resolved.header,
        invoiceDate: input.invoiceDate,
        dueDate,
        paymentTermsDays,
        openingBaseTotal,
      },
    };
  }

  /** D5: opening invoices are dated on or before the S8 opening date (conversion date − 1). */
  private openingIssues(accounting: AccountingSettings, input: InvoiceDraftInput) {
    const issues: ValidationIssue[] = [];
    if (!accounting.conversionDate) {
      issues.push({
        path: 'kind',
        message:
          'Set the conversion date under Accounting > Opening balances before entering opening invoices.',
      });
    } else if (
      isValidIsoDate(input.invoiceDate) &&
      input.invoiceDate > openingDateFor(accounting.conversionDate)
    ) {
      issues.push({
        path: 'invoiceDate',
        message: `Opening invoices are dated on or before ${openingDateFor(accounting.conversionDate)}.`,
      });
    }
    if (input.taxTreatment && input.taxTreatment !== 'no_tax') {
      issues.push({ path: 'taxTreatment', message: 'Opening invoices carry no tax.' });
    }
    if (issues.length) throw new ValidationError(issues);
    return true;
  }

  /** The explicit carrying value (foreign currency only), in base minor units. */
  private openingBase(accounting: AccountingSettings, currency: string, input: InvoiceDraftInput) {
    if (input.openingBaseTotal === undefined || input.openingBaseTotal === null) return null;
    if (currency === accounting.baseCurrency) {
      throw new ValidationError([
        {
          path: 'openingBaseTotal',
          message: 'A base-currency invoice has no separate carrying value.',
        },
      ]);
    }
    const parsed = parseAmount(input.openingBaseTotal, accounting.baseCurrency);
    if (!parsed.ok) {
      throw new ValidationError([
        { path: 'openingBaseTotal', message: 'Enter the base carrying value (greater than zero).' },
      ]);
    }
    return parsed.value.toFixed(4);
  }

  private inputOf(invoice: Invoice, lines: readonly InvoiceLine[]): InvoiceDraftInput {
    return {
      customerId: invoice.customerId,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.paymentTermsDays === null ? invoice.dueDate : null,
      paymentTermsDays: invoice.paymentTermsDays,
      currencyCode: invoice.currencyCode,
      taxTreatment: invoice.taxTreatment,
      discount: invoice.discountType
        ? { type: invoice.discountType, value: invoice.discountValue! }
        : null,
      reference: invoice.reference,
      memo: invoice.memo,
      dimensionValueIds: invoice.dimensionValueIds,
      lines: linesAsInput(lines),
      kind: invoice.kind,
      openingBaseTotal: invoice.openingBaseTotal,
    };
  }

  private posting(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    sales: SalesSettings | undefined,
    invoice: Invoice,
    lines: readonly InvoiceLine[],
  ) {
    if (invoice.kind === 'opening')
      return this.openingPosting(tx, organizationId, accounting, sales, invoice);
    return documentPosting(
      tx,
      organizationId,
      accounting,
      sales,
      {
        direction: 'invoice',
        label: `Invoice ${invoice.number ?? '(draft)'}`,
        transactionType: invoice.kind,
        date: invoice.invoiceDate,
        currencyCode: invoice.currencyCode,
        dimensionValueIds: invoice.dimensionValueIds,
      },
      lines,
    );
  }

  /**
   * D5: Dr AR control / Cr Opening Balance Equity for the invoice total. The base is the explicit
   * carrying value (S8-06, rate implied), or the table rate on the invoice date.
   */
  private async openingPosting(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    sales: SalesSettings | undefined,
    invoice: Invoice,
  ) {
    const total = decimal(invoice.total);
    let rate: Decimal | null = null;
    let rateSource: 'base' | 'table' | 'carrying' = 'base';
    let baseTotal: Decimal | null = null;
    if (invoice.currencyCode === accounting.baseCurrency) {
      rate = decimal(1);
      baseTotal = total;
    } else if (invoice.openingBaseTotal) {
      baseTotal = decimal(invoice.openingBaseTotal);
      rate = total.isZero() ? null : baseTotal.dividedBy(total).toDecimalPlaces(10);
      rateSource = 'carrying';
    } else {
      const found = await findApplicableRate(tx, {
        organizationId,
        fromCurrency: invoice.currencyCode,
        toCurrency: accounting.baseCurrency,
        onDate: invoice.invoiceDate,
      });
      rateSource = 'table';
      if (found) {
        rate = decimal(found.rate);
        baseTotal = convertToBase(total, rate, accounting.baseCurrency);
      }
    }
    const values = await getDimensionValuesByIds(tx, organizationId, invoice.dimensionValueIds);
    const typeOf = new Map([...values].map(([valueId, v]) => [valueId, v.dimensionTypeId]));
    const obe = await getDesignatedAccountId(tx, organizationId, 'OPENING_BALANCE_EQUITY');
    const label = `Opening invoice ${invoice.number ?? '(draft)'}`;
    const dims = [...invoice.dimensionValueIds].sort();
    const base = baseTotal ?? decimal(0);
    const journalLines: PostingLine[] = [
      {
        role: 'receivable',
        accountId: sales?.arAccountId ?? null,
        side: 'debit',
        amount: total,
        description: label,
        dimensionValueIds: dims,
        baseAmount: base,
      },
      {
        role: 'revenue',
        accountId: obe,
        side: 'credit',
        amount: total,
        description: label,
        dimensionValueIds: dims,
        baseAmount: base,
      },
    ];
    const facts: ApprovalFacts = {
      transactionType: 'opening',
      baseAmount: baseTotal ? baseTotal.toFixed(minorUnits(accounting.baseCurrency)) : null,
      baseCurrency: accounting.baseCurrency,
    };
    return {
      journal: { lines: journalLines, total, baseTotal: base },
      rate,
      rateSource,
      facts,
      typeOf,
    };
  }

  /** Decision 23 (detection, not idempotency) and Decision 48 (credit limit, warning only). */
  private async warnings(tx: Transaction, organizationId: string, invoice: Invoice) {
    const warnings: { code: string; message: string; matches?: unknown }[] = [];
    const similar = await findSimilarInvoices(tx, {
      organizationId,
      customerId: invoice.customerId,
      invoiceDate: invoice.invoiceDate,
      total: invoice.total,
      currencyCode: invoice.currencyCode,
      exceptId: invoice.id,
    });
    if (similar.length) {
      warnings.push({
        code: 'POSSIBLE_DUPLICATE',
        message: 'Another invoice for this customer has the same date and total.',
        matches: similar,
      });
    }
    const customer = await getCustomer(tx, organizationId, invoice.customerId);
    if (
      customer?.creditLimit !== null &&
      customer?.creditLimit !== undefined &&
      customer.currencyCode === invoice.currencyCode
    ) {
      const open = decimal(
        await openInvoiceBalance(tx, organizationId, customer.id, invoice.currencyCode),
      );
      if (open.plus(decimal(invoice.total)).gt(decimal(customer.creditLimit))) {
        warnings.push({
          code: 'CREDIT_LIMIT_EXCEEDED',
          message: `This invoice takes the customer over their credit limit of ${decimal(
            customer.creditLimit,
          ).toFixed(minorUnits(customer.currencyCode))} ${customer.currencyCode}.`,
        });
      }
    }
    return warnings;
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private summary(invoice: Invoice, name: string | null) {
    const c = invoice.currencyCode;
    return {
      id: invoice.id,
      kind: invoice.kind,
      status: invoice.status,
      number: invoice.number,
      customerId: invoice.customerId,
      customerName: name,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      currencyCode: c,
      reference: invoice.reference,
      subtotal: shownMoney(invoice.subtotal, c),
      discountTotal: shownMoney(invoice.discountTotal, c),
      taxTotal: shownMoney(invoice.taxTotal, c),
      total: shownMoney(invoice.total, c),
      amountDue: shownMoney(invoice.amountDue, c),
      baseTotal: invoice.baseTotal,
      baseDue: invoice.baseDue,
      version: invoice.version,
      issuedAt: invoice.issuedAt?.toISOString() ?? null,
      voidedAt: invoice.voidedAt?.toISOString() ?? null,
    };
  }

  private async detail(tx: Transaction, ctx: AuthorizationContext, invoiceId: string) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const invoice = await getInvoice(tx, ctx.organizationId, invoiceId);
    if (!invoice) throw new NotFoundError('Invoice not found.');
    const lines = await getInvoiceLines(tx, ctx.organizationId, invoice.id);
    const open = invoice.status === 'DRAFT' || invoice.status === 'PENDING_APPROVAL';
    const sales = await getSalesSettings(tx, ctx.organizationId);
    const facts = open
      ? (await this.posting(tx, ctx.organizationId, accounting, sales, invoice, lines)).facts
      : null;
    const allocations = await listAllocations(tx, ctx.organizationId, { invoiceId: invoice.id });
    return {
      ...this.summary(invoice, await customerName(tx, ctx.organizationId, invoice.customerId)),
      paymentTermsDays: invoice.paymentTermsDays,
      openingBaseTotal: invoice.openingBaseTotal,
      exchangeRate: invoice.exchangeRate,
      exchangeRateSource: invoice.exchangeRateSource,
      taxTreatment: invoice.taxTreatment,
      discount: invoice.discountType
        ? { type: invoice.discountType, value: decimal(invoice.discountValue!).toFixed() }
        : null,
      memo: invoice.memo,
      dimensionValueIds: invoice.dimensionValueIds,
      journalId: invoice.journalId,
      voidReason: invoice.voidReason,
      voidJournalId: invoice.voidJournalId,
      baseCurrency: accounting.baseCurrency,
      lines: lines.map((l) => documentLineView(l, invoice.currencyCode)),
      // Payments and credits applied, including reversals from voids.
      allocations: allocations.map((a) => ({
        id: a.id,
        sourceType: a.sourceType,
        receiptId: a.receiptId,
        creditNoteId: a.creditNoteId,
        mode: a.mode,
        allocationDate: a.allocationDate,
        amount: shownMoney(a.amount, a.currencyCode),
        baseRelieved: a.baseRelieved,
        reversesAllocationId: a.reversesAllocationId,
      })),
      approval: await documentApprovalState(
        this.approvals,
        tx,
        ctx.organizationId,
        INVOICE_ISSUE_ACTION,
        invoice,
        facts,
      ),
      warnings: open ? await this.warnings(tx, ctx.organizationId, invoice) : [],
    };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(
    principal: Principal,
    query: {
      status?: InvoiceStatus[] | undefined;
      customerId?: string | undefined;
      search?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      open?: boolean | undefined;
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.InvoicesView },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const page = await listInvoices(tx, {
          organizationId: ctx.organizationId,
          statuses: query.status?.length ? query.status : null,
          customerId: query.customerId ?? null,
          search: query.search?.trim() || null,
          customerIdsIn: customersMatching(ctx.organizationId, query.search?.trim() || null),
          from: query.from ?? null,
          to: query.to ?? null,
          openOnly: query.open === true,
          limit: query.limit,
          after: query.after ? decodeCursor(query.after) : null,
        });
        const names = new Map<string, string | null>();
        for (const id of new Set(page.items.map((i) => i.customerId))) {
          names.set(id, await customerName(tx, ctx.organizationId, id));
        }
        const last = page.items.at(-1);
        return {
          items: page.items.map((i) => this.summary(i, names.get(i.customerId) ?? null)),
          nextCursor: page.hasMore && last ? encodeCursor(last) : null,
        };
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.InvoicesView },
      (tx, ctx) => this.detail(tx, ctx, id),
    );
  }

  // ---------------------------------------------------------------------------
  // Drafts (Decision 46)
  // ---------------------------------------------------------------------------

  /** Creates a draft; with an Idempotency-Key a retry returns the first result (Decision 23). */
  create(
    principal: Principal,
    input: InvoiceDraftInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.InvoicesCreate },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'sales.invoice.create', request: input },
          async () => {
            const invoice = await this.createDraftInTransaction(tx, ctx, input, origin);
            return this.detail(tx, ctx, invoice.id);
          },
        ),
    );
  }

  /** The draft rules without writing (step 18: opening-invoice import validation). */
  async validateDraftInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: InvoiceDraftInput,
  ) {
    requirePermission(ctx, SalesPermissions.InvoicesCreate);
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const sales = await getSalesSettings(tx, ctx.organizationId);
    return this.resolve(tx, ctx.organizationId, accounting, sales, input);
  }

  /** Creates a draft in the caller's transaction with the HTTP rules and audit (imports never issue). */
  async createDraftInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: InvoiceDraftInput,
    origin: EventOrigin,
  ): Promise<Invoice> {
    const resolved = await this.validateDraftInTransaction(tx, ctx, input);
    const now = this.now;
    const invoice = await insertInvoice(tx, {
      ...resolved.header,
      organizationId: ctx.organizationId,
      kind: input.kind ?? 'standard',
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedByUserId: ctx.userId,
      updatedAt: now,
    });
    await replaceInvoiceLines(tx, ctx.organizationId, invoice.id, stripLines(resolved.lines));
    await this.audit(tx, ctx, 'invoice.created', invoice.id, now, origin, {
      customerId: invoice.customerId,
      kind: invoice.kind,
      invoiceDate: invoice.invoiceDate,
      currencyCode: invoice.currencyCode,
      total: invoice.total,
      lines: resolved.lines.length,
    });
    return invoice;
  }

  update(
    principal: Principal,
    id: string,
    input: InvoiceDraftInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.InvoicesEditDraft },
      async (tx, ctx) => {
        const invoice = await this.lockDraft(tx, ctx, id, input.version, 'edited');
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const sales = await getSalesSettings(tx, ctx.organizationId);
        const existingLines = await getInvoiceLines(tx, ctx.organizationId, id);
        const resolved = await this.resolve(tx, ctx.organizationId, accounting, sales, input, {
          invoice,
          lines: existingLines,
        });
        const now = this.now;
        const updated = await updateInvoice(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: input.version,
          set: { ...resolved.header, updatedByUserId: ctx.userId, updatedAt: now },
        });
        if (!updated) throw versionConflict();
        await replaceInvoiceLines(tx, ctx.organizationId, id, stripLines(resolved.lines));
        await this.audit(tx, ctx, 'invoice.updated', id, now, origin, {
          version: updated.version,
          total: { before: invoice.total, after: updated.total },
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
      { permission: SalesPermissions.InvoicesDeleteDraft },
      async (tx, ctx) => {
        const invoice = await this.lockDraft(tx, ctx, id, input.version, 'deleted');
        await deleteInvoice(tx, ctx.organizationId, id);
        await this.audit(tx, ctx, 'invoice.deleted', id, this.now, origin, {
          customerId: invoice.customerId,
          total: invoice.total,
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
    const invoice = await getInvoice(tx, ctx.organizationId, id, { forUpdate: true });
    if (!invoice) throw new NotFoundError('Invoice not found.');
    if (invoice.version !== version) throw versionConflict();
    if (invoice.status !== 'DRAFT') {
      throw invalidState(
        invoice.status === 'PENDING_APPROVAL'
          ? `The invoice is awaiting approval. Withdraw it before it can be ${verb}.`
          : verb === 'deleted'
            ? 'Only draft invoices can be deleted; issued invoices are voided.'
            : 'Only draft invoices can be edited.',
      );
    }
    return invoice;
  }

  // ---------------------------------------------------------------------------
  // Approval (D1) and issue
  // ---------------------------------------------------------------------------

  submit(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.InvoicesCreate },
      async (tx, ctx) => {
        const invoice = await getInvoice(tx, ctx.organizationId, id, { forUpdate: true });
        if (!invoice) throw new NotFoundError('Invoice not found.');
        if (invoice.version !== input.version) throw versionConflict();
        if (invoice.status !== 'DRAFT') throw invalidState('Only draft invoices can be submitted.');
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const sales = await getSalesSettings(tx, ctx.organizationId);
        const lines = await getInvoiceLines(tx, ctx.organizationId, id);
        const { facts } = await this.posting(
          tx,
          ctx.organizationId,
          accounting,
          sales,
          invoice,
          lines,
        );
        const now = this.now;
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: INVOICE_ISSUE_ACTION,
          subjectId: id,
          // No self-approval: neither the preparer nor the submitter.
          excludedUserIds: [...new Set([ctx.userId, invoice.createdByUserId])],
          reason: null,
          facts,
          now,
        });
        if (!request)
          throw invalidState('No approval step applies to this invoice; issue it directly.');
        const updated = await updateInvoice(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: invoice.version,
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
        await this.audit(tx, ctx, 'invoice.submitted', id, now, origin, {
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
      { permission: SalesPermissions.InvoicesCreate },
      async (tx, ctx) => {
        const invoice = await getInvoice(tx, ctx.organizationId, id, { forUpdate: true });
        if (!invoice) throw new NotFoundError('Invoice not found.');
        if (invoice.version !== input.version) throw versionConflict();
        if (invoice.status !== 'PENDING_APPROVAL') {
          throw invalidState('Only an invoice awaiting approval can be withdrawn.');
        }
        const now = this.now;
        const request = invoice.approvalRequestId
          ? await getApprovalRequest(tx, ctx.organizationId, invoice.approvalRequestId, {
              forUpdate: true,
            })
          : undefined;
        if (request?.status === 'pending') {
          await this.approvals.withdrawRequest(tx, ctx.organizationId, request.id, now);
        }
        const updated = await updateInvoice(tx, {
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
        await this.audit(tx, ctx, 'invoice.withdrawn', id, now, origin, {
          approvalRequestId: request?.id ?? null,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  /**
   * Issue (D1): one transaction that assigns the number, snapshots the document and posts it
   * through the accounting event. Any failure rolls back everything, including the number.
   */
  issue(
    principal: Principal,
    id: string,
    input: { version: number },
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.InvoicesIssue },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'sales.invoice.issue', request: { id, ...input } },
          () => this.issueInTransaction(tx, ctx, id, input, origin),
        ),
    );
  }

  private async issueInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    id: string,
    input: { version: number },
    origin: EventOrigin,
  ) {
    // 1. Lock, version and state.
    const invoice = await getInvoice(tx, ctx.organizationId, id, { forUpdate: true });
    if (!invoice) throw new NotFoundError('Invoice not found.');
    if (invoice.version !== input.version) throw versionConflict();
    if (invoice.status !== 'DRAFT' && invoice.status !== 'PENDING_APPROVAL') {
      throw invalidState(`A ${invoice.status.toLowerCase()} invoice cannot be issued.`);
    }
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const sales = await getSalesSettings(tx, ctx.organizationId, { forUpdate: true });

    // 2. Recompute with today's references: the rates in effect on the invoice date, and active
    // customer, items, tax codes, accounts and dimension values.
    const existing = await getInvoiceLines(tx, ctx.organizationId, id);
    const customer = await getCustomer(tx, ctx.organizationId, invoice.customerId);
    const party = customer ? await getParty(tx, ctx.organizationId, customer.partyId) : undefined;
    const issues: ValidationIssue[] = [];
    if (customer?.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
      issues.push({ path: 'customerId', message: 'Archived customers cannot be invoiced.' });
    }
    const resolved = await this.resolve(
      tx,
      ctx.organizationId,
      accounting,
      sales,
      this.inputOf(invoice, existing),
      { invoice: { ...invoice, dimensionValueIds: [] }, lines: [] },
    );
    if (decimal(resolved.header.total).lte(0)) {
      issues.push({ path: 'lines', message: 'The invoice total must be greater than zero.' });
    }
    // 3. Accounts (D7): missing accounts block issue.
    if (!sales?.arAccountId) {
      issues.push({
        path: 'arAccountId',
        message: 'Choose the AR control account in Sales settings before issuing.',
      });
    }
    resolved.lines.forEach((l, i) => {
      if (invoice.kind !== 'opening' && !l.revenueAccountId && !sales?.defaultRevenueAccountId) {
        issues.push({
          path: `lines.${i}.revenueAccountId`,
          message: 'Choose a revenue account or set the default in Sales settings.',
        });
      }
    });
    if (issues.length) throw new ValidationError(issues, 'The invoice cannot be issued yet.');

    const now = this.now;
    // Keep the recomputed values and rate snapshots on the lines.
    const snapshot = await updateInvoice(tx, {
      organizationId: ctx.organizationId,
      id,
      from: invoice.status,
      version: invoice.version,
      set: { ...resolved.header, updatedByUserId: ctx.userId, updatedAt: now },
    });
    if (!snapshot) throw versionConflict();
    const lines = await replaceInvoiceLines(tx, ctx.organizationId, id, stripLines(resolved.lines));

    // 4. Rate (D9) and the journal to post; its base total is the approval amount.
    const posting = await this.posting(tx, ctx.organizationId, accounting, sales, snapshot, lines);
    if (!posting.rate) {
      throw new AppError(
        'EXCHANGE_RATE_REQUIRED',
        409,
        `An exchange rate from ${snapshot.currencyCode} to ${accounting.baseCurrency} is required for ${snapshot.invoiceDate}.`,
      );
    }

    if (snapshot.kind === 'opening' && !posting.journal.lines[1]!.accountId) {
      throw new AppError(
        'DESIGNATION_REQUIRED',
        409,
        'Designate the Opening Balance Equity account under Accounting before issuing opening invoices.',
      );
    }

    // 5. Approval, re-checked against the recomputed facts (S10-06).
    const approval = await documentApprovalState(
      this.approvals,
      tx,
      ctx.organizationId,
      INVOICE_ISSUE_ACTION,
      snapshot,
      posting.facts,
    );
    if (!approval.readyToIssue) {
      throw new AppError(
        'APPROVAL_REQUIRED',
        409,
        snapshot.status === 'DRAFT'
          ? 'This invoice needs approval: submit it for approval first.'
          : approval.approvalOutdated
            ? 'The invoice amount now needs further approval. Withdraw it and submit it again.'
            : 'The invoice has not received all required approvals.',
      );
    }

    // 6. Period open on the invoice date (D15); required dimensions on the posted lines (D10).
    await assertOpenPeriod(tx, ctx.organizationId, snapshot.invoiceDate);
    await assertRequiredDimensions(tx, ctx.organizationId, posting.journal.lines, posting.typeOf);

    // 7. Number (D3), then the journal through the accounting event (C1, Decision 13).
    const number = await nextDocumentNumber(tx, ctx.organizationId, 'invoice', (n) =>
      invoiceNumberExists(tx, ctx.organizationId, n),
    );
    const foreign = snapshot.currencyCode !== accounting.baseCurrency;
    // D5: opening invoices post a system journal (allowlisted `opening_balance` type, E1) with
    // explicit base amounts, so a carrying value lands exactly on AR.
    const journalInput =
      snapshot.kind === 'opening'
        ? {
            system: {
              source: { module: 'sales', type: 'opening_balance', id },
              entryDate: snapshot.invoiceDate,
              description: `Opening invoice ${number} — ${party!.displayName}`.slice(0, 500),
              reference: number,
              currency: snapshot.currencyCode,
              exchangeRate: foreign ? posting.rate.toFixed(10) : null,
              exchangeRateSource:
                posting.rateSource === 'table' ? ('table' as const) : ('manual' as const),
              lines: posting.journal.lines.map((l) => {
                const line = journalLine(l, number, posting.typeOf);
                const base = l.baseAmount.toFixed(4);
                return {
                  ...line,
                  accountId: l.accountId!,
                  kind: 'normal' as const,
                  baseDebit: l.side === 'debit' ? base : null,
                  baseCredit: l.side === 'credit' ? base : null,
                };
              }),
            },
          }
        : {
            entryDate: snapshot.invoiceDate,
            description: `Invoice ${number} — ${party!.displayName}`.slice(0, 500),
            reference: number,
            currency: snapshot.currencyCode,
            exchangeRate: foreign ? posting.rate.toFixed(10) : null,
            ...(foreign ? { exchangeRateSource: 'table' as const } : {}),
            sourceRef: { module: 'sales', type: 'invoice', id },
            lines: posting.journal.lines.map((l) => journalLine(l, number, posting.typeOf)),
          };
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'sales',
      eventType: INVOICE_ISSUED_EVENT,
      eventKey: `invoice:${id}:issued`,
      payload: { invoiceId: id, number, journal: journalInput },
      occurredAt: now,
      origin,
    });
    if (!event.journalId)
      throw new AppError('CONFLICT', 409, 'The invoice was not posted; try again.');
    // The subledger carries exactly the base amount posted to the AR control account.
    const arLine = (await getJournalLines(tx, ctx.organizationId, [event.journalId])).find(
      (l) => l.accountId === sales!.arAccountId && l.baseDebit !== null,
    );
    const baseTotal = decimal(arLine!.baseDebit!);

    // 8. Issued: immutable from here (R35).
    const issued = await updateInvoice(tx, {
      organizationId: ctx.organizationId,
      id,
      from: snapshot.status,
      version: snapshot.version,
      set: {
        status: 'ISSUED',
        number,
        exchangeRate: posting.rate.toFixed(10),
        exchangeRateSource: posting.rateSource === 'invoice' ? 'table' : posting.rateSource,
        baseTotal: baseTotal.toFixed(4),
        amountDue: snapshot.total,
        baseDue: baseTotal.toFixed(4),
        issuedByUserId: ctx.userId,
        issuedAt: now,
        journalId: event.journalId,
        accountingEventId: event.eventId,
        renderSnapshot: await renderSnapshot(
          tx,
          ctx.organizationId,
          {
            documentType: 'invoice',
            number,
            customerId: snapshot.customerId,
            currencyCode: snapshot.currencyCode,
            taxTreatment: snapshot.taxTreatment,
            reference: snapshot.reference,
            memo: snapshot.memo,
            subtotal: snapshot.subtotal,
            discountTotal: snapshot.discountTotal,
            taxTotal: snapshot.taxTotal,
            total: snapshot.total,
            dates: { invoiceDate: snapshot.invoiceDate, dueDate: snapshot.dueDate },
          },
          lines,
        ),
        updatedByUserId: ctx.userId,
        updatedAt: now,
      },
    });
    if (!issued) throw versionConflict();
    await lockArAccount(tx, ctx.organizationId, now);
    // §Z: the PDF is rendered from the frozen snapshot off the request path.
    await this.output.enqueuePdfInTransaction(tx, ctx, 'invoice', id);
    await this.audit(tx, ctx, 'invoice.issued', id, now, origin, {
      number,
      total: issued.total,
      currencyCode: issued.currencyCode,
      exchangeRate: issued.exchangeRate,
      baseTotal: issued.baseTotal,
      journalId: event.journalId,
      approvalRequestId: issued.approvalRequestId,
    });
    return this.detail(tx, ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Void (step 13; D8, R35, E2)
  // ---------------------------------------------------------------------------

  /**
   * Voids an unpaid issued invoice in an open period: its journal is reversed through Sales
   * (E2) on the invoice date, and the invoice leaves the AR subledger. Needs `invoices.void` and
   * a recent password confirmation (D12). Invoices with payments or credits applied cannot be
   * voided: void the receipts first, or issue a credit note.
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
      { permission: SalesPermissions.InvoicesVoid, sensitive: true },
      async (tx, ctx) => {
        const invoice = await getInvoice(tx, ctx.organizationId, id, { forUpdate: true });
        if (!invoice) throw new NotFoundError('Invoice not found.');
        if (invoice.version !== input.version) throw versionConflict();
        if (invoice.status !== 'ISSUED') {
          throw invalidState(
            invoice.status === 'VOID'
              ? 'The invoice is already void.'
              : 'Only issued invoices can be voided; delete a draft instead.',
          );
        }
        if (invoice.amountDue !== invoice.total || invoice.baseDue !== invoice.baseTotal) {
          throw invalidState(
            'The invoice has payments or credits applied. Void those receipts first, or issue a credit note.',
          );
        }
        const reason = input.reason.trim();
        const reversal = await this.journals.reverseSalesJournalInTransaction(
          tx,
          ctx,
          invoice.journalId!,
          { reason: `Invoice ${invoice.number} voided: ${reason}` },
          origin,
        );
        const now = this.now;
        const voided = await updateInvoice(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'ISSUED',
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
        await this.audit(tx, ctx, 'invoice.voided', id, now, origin, {
          number: invoice.number,
          reason,
          total: invoice.total,
          reversalJournalId: reversal.id,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }
}
