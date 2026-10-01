import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  getJournalLines,
  isValidIsoDate,
  type AccountingSettings,
} from '../modules/accounting/index.js';
import { getApprovalRequest } from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getCustomer } from '../modules/customers/index.js';
import { getParty } from '../modules/parties/index.js';
import {
  creditedOnInvoice,
  creditNoteNumberExists,
  deleteCreditNote,
  getCreditNote,
  getCreditNoteLines,
  getInvoice,
  getSalesSettings,
  insertCreditNote,
  listAllocations,
  listCreditNotes,
  lockArAccount,
  replaceCreditNoteLines,
  SalesPermissions,
  updateCreditNote,
  type CreditNote,
  type CreditNoteLine,
  type CreditNoteStatus,
  type Discount,
  type Invoice,
  type SalesSettings,
} from '../modules/sales/index.js';
import type { TaxTreatment } from '../modules/tax/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { ApprovalService } from './approval-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import type { ReceiptService } from './receipt-service.js';
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
} from './sales-documents.js';

/**
 * Credit notes (Phase 3B step 12; Decisions 38, 41; D7; §M). Drafts are created, edited and
 * deleted under `credit_notes.create` (D7). Issue needs `credit_notes.issue` and a recent password
 * confirmation (Decision 41), may need approval first (D1 pattern), and posts the reverse of an
 * invoice through the `sales.credit_note_issued` event. A credit note linked to an invoice follows
 * that invoice's rate and is applied to it at issue; any rest, and every standalone credit note,
 * is customer credit. Issued credit notes are never edited, voided or deleted.
 */

export const CREDIT_NOTE_ISSUE_ACTION = 'sales.credit_note.issue';
export const CREDIT_NOTE_ISSUED_EVENT = 'sales.credit_note_issued';
const RESOURCE = 'sales_credit_note';

export interface CreditNoteDraftInput {
  customerId: string;
  creditDate: string;
  invoiceId?: string | null | undefined;
  currencyCode?: string | undefined;
  taxTreatment?: TaxTreatment | undefined;
  discount?: Discount | null | undefined;
  reference?: string | null | undefined;
  memo?: string | undefined;
  dimensionValueIds?: string[] | undefined;
  lines: DocumentLineInput[];
}

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'This credit note was changed by someone else. Reload it and apply your changes again.',
  );

export class CreditNoteService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly approvals: ApprovalService,
    private readonly journals: JournalService,
    private readonly receipts: ReceiptService,
    private readonly idempotency: IdempotencyService,
    private readonly output: SalesOutputService,
  ) {
    approvals.register({
      actionKey: CREDIT_NOTE_ISSUE_ACTION,
      label: 'Approve credit notes before issuing',
      subjectType: RESOURCE,
      approverPermission: SalesPermissions.CreditNotesApprove,
      decisionRequiresReauth: false,
      conditions: { amount: true, transactionTypes: ['credit_note'] },
      onApproved: async (tx, { request, authz, now, origin }) => {
        await this.audit(tx, authz, 'credit_note.approved', request.subjectId, now, origin, {
          approvalRequestId: request.id,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        const note = await updateCreditNote(tx, {
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
        if (!note) throw invalidState('The credit note is no longer awaiting approval.');
        await this.audit(tx, authz, 'credit_note.rejected', note.id, now, origin, {
          approvalRequestId: request.id,
          comment,
        });
      },
    });
    journals.registerEventHandler(
      CREDIT_NOTE_ISSUED_EVENT,
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
    ctx: Pick<AuthorizationContext, 'organizationId' | 'userId'>,
    action: string,
    id: string,
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
      resourceId: id,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /** The linked invoice: issued, same customer, dated on or before the credit. */
  private async linkedInvoice(
    tx: Transaction,
    organizationId: string,
    input: { invoiceId?: string | null | undefined; customerId: string; creditDate: string },
    issues: ValidationIssue[],
  ): Promise<Invoice | undefined> {
    if (!input.invoiceId) return undefined;
    const invoice = await getInvoice(tx, organizationId, input.invoiceId);
    if (!invoice) issues.push({ path: 'invoiceId', message: 'Invoice not found.' });
    else if (invoice.status !== 'ISSUED') {
      issues.push({ path: 'invoiceId', message: 'Only an issued invoice can be credited.' });
    } else if (invoice.customerId !== input.customerId) {
      issues.push({ path: 'invoiceId', message: 'The invoice belongs to another customer.' });
    } else if (invoice.invoiceDate > input.creditDate) {
      issues.push({
        path: 'invoiceId',
        message: 'The credit note cannot be dated before the invoice.',
      });
    } else {
      return invoice;
    }
    return undefined;
  }

  private async resolve(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    sales: SalesSettings | undefined,
    input: CreditNoteDraftInput,
    existing?: { note: CreditNote; lines: readonly CreditNoteLine[] },
  ) {
    const issues: ValidationIssue[] = [];
    const invoice = await this.linkedInvoice(tx, organizationId, input, issues);
    if (invoice && input.currencyCode && input.currencyCode !== invoice.currencyCode) {
      issues.push({
        path: 'currencyCode',
        message: `The credit follows the invoice's currency (${invoice.currencyCode}).`,
      });
    }
    if (issues.length) throw new ValidationError(issues);
    const resolved = await resolveDocument(
      tx,
      organizationId,
      accounting,
      sales,
      {
        ...input,
        date: input.creditDate,
        // Linked: the invoice's currency and, unless set, its dimensions (§M).
        currencyCode: invoice?.currencyCode ?? input.currencyCode,
        dimensionValueIds: input.dimensionValueIds ?? invoice?.dimensionValueIds,
      },
      {
        datePath: 'creditDate',
        noun: 'credit notes',
        existing: existing && {
          customerId: existing.note.customerId,
          dimensionValueIds: existing.note.dimensionValueIds,
          lines: existing.lines,
        },
      },
    );
    return {
      ...resolved,
      invoice,
      header: { ...resolved.header, creditDate: input.creditDate, invoiceId: invoice?.id ?? null },
    };
  }

  private inputOf(note: CreditNote, lines: readonly CreditNoteLine[]): CreditNoteDraftInput {
    return {
      customerId: note.customerId,
      creditDate: note.creditDate,
      invoiceId: note.invoiceId,
      currencyCode: note.currencyCode,
      taxTreatment: note.taxTreatment,
      discount: note.discountType ? { type: note.discountType, value: note.discountValue! } : null,
      reference: note.reference,
      memo: note.memo,
      dimensionValueIds: note.dimensionValueIds,
      lines: linesAsInput(lines),
    };
  }

  private async posting(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    sales: SalesSettings | undefined,
    note: CreditNote,
    lines: readonly CreditNoteLine[],
  ) {
    const invoice = note.invoiceId
      ? await getInvoice(tx, organizationId, note.invoiceId)
      : undefined;
    return documentPosting(
      tx,
      organizationId,
      accounting,
      sales,
      {
        direction: 'credit_note',
        label: `Credit note ${note.number ?? '(draft)'}`,
        transactionType: 'credit_note',
        date: note.creditDate,
        currencyCode: note.currencyCode,
        dimensionValueIds: note.dimensionValueIds,
        // §M: a linked credit note posts at its invoice's rate.
        fixedRate: invoice?.exchangeRate ? { rate: invoice.exchangeRate, source: 'invoice' } : null,
      },
      lines,
    );
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private summary(note: CreditNote, name: string | null) {
    const c = note.currencyCode;
    return {
      id: note.id,
      status: note.status,
      number: note.number,
      customerId: note.customerId,
      customerName: name,
      invoiceId: note.invoiceId,
      creditDate: note.creditDate,
      currencyCode: c,
      reference: note.reference,
      subtotal: shownMoney(note.subtotal, c),
      discountTotal: shownMoney(note.discountTotal, c),
      taxTotal: shownMoney(note.taxTotal, c),
      total: shownMoney(note.total, c),
      amountUnapplied: shownMoney(note.amountUnapplied, c),
      baseTotal: note.baseTotal,
      baseUnapplied: note.baseUnapplied,
      version: note.version,
      issuedAt: note.issuedAt?.toISOString() ?? null,
    };
  }

  private async detail(tx: Transaction, ctx: AuthorizationContext, id: string) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const note = await getCreditNote(tx, ctx.organizationId, id);
    if (!note) throw new NotFoundError('Credit note not found.');
    const lines = await getCreditNoteLines(tx, ctx.organizationId, id);
    const open = note.status !== 'ISSUED';
    const sales = await getSalesSettings(tx, ctx.organizationId);
    const facts = open
      ? (await this.posting(tx, ctx.organizationId, accounting, sales, note, lines)).facts
      : null;
    const allocations = await listAllocations(tx, ctx.organizationId, { creditNoteId: id });
    return {
      ...this.summary(note, await customerName(tx, ctx.organizationId, note.customerId)),
      exchangeRate: note.exchangeRate,
      exchangeRateSource: note.exchangeRateSource,
      taxTreatment: note.taxTreatment,
      discount: note.discountType
        ? { type: note.discountType, value: decimal(note.discountValue!).toFixed() }
        : null,
      memo: note.memo,
      dimensionValueIds: note.dimensionValueIds,
      journalId: note.journalId,
      baseCurrency: accounting.baseCurrency,
      lines: lines.map((l) => documentLineView(l, note.currencyCode)),
      allocations: allocations.map((a) => ({
        id: a.id,
        invoiceId: a.invoiceId,
        allocationDate: a.allocationDate,
        amount: shownMoney(a.amount, a.currencyCode),
        fxDifference: a.fxDifference,
        reversesAllocationId: a.reversesAllocationId,
        journalId: a.journalId,
      })),
      approval: await documentApprovalState(
        this.approvals,
        tx,
        ctx.organizationId,
        CREDIT_NOTE_ISSUE_ACTION,
        note,
        facts,
      ),
    };
  }

  list(
    principal: Principal,
    query: {
      status?: CreditNoteStatus | undefined;
      customerId?: string | undefined;
      invoiceId?: string | undefined;
      search?: string | undefined;
      withCredit?: boolean | undefined;
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.CreditNotesView },
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
        const page = await listCreditNotes(tx, {
          organizationId: ctx.organizationId,
          status: query.status ?? null,
          customerId: query.customerId ?? null,
          invoiceId: query.invoiceId ?? null,
          search: query.search?.trim() || null,
          customerIdsIn: customersMatching(ctx.organizationId, query.search?.trim() || null),
          withCredit: query.withCredit === true,
          limit: query.limit,
          after,
        });
        const items = [];
        for (const n of page.items) {
          items.push(this.summary(n, await customerName(tx, ctx.organizationId, n.customerId)));
        }
        const last = page.items.at(-1);
        return {
          items,
          nextCursor:
            page.hasMore && last
              ? Buffer.from(JSON.stringify({ d: last.creditDate, i: last.id })).toString(
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
      { permission: SalesPermissions.CreditNotesView },
      (tx, ctx) => this.detail(tx, ctx, id),
    );
  }

  // ---------------------------------------------------------------------------
  // Drafts (D7: credit_notes.create covers create, edit and delete)
  // ---------------------------------------------------------------------------

  create(
    principal: Principal,
    input: CreditNoteDraftInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.CreditNotesCreate },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'sales.credit_note.create', request: input },
          async () => {
            const accounting = await requireAccountingSettings(tx, ctx.organizationId);
            const sales = await getSalesSettings(tx, ctx.organizationId);
            const resolved = await this.resolve(tx, ctx.organizationId, accounting, sales, input);
            const now = this.now;
            const note = await insertCreditNote(tx, {
              ...resolved.header,
              organizationId: ctx.organizationId,
              createdByUserId: ctx.userId,
              createdAt: now,
              updatedByUserId: ctx.userId,
              updatedAt: now,
            });
            await replaceCreditNoteLines(
              tx,
              ctx.organizationId,
              note.id,
              stripLines(resolved.lines),
            );
            await this.audit(tx, ctx, 'credit_note.created', note.id, now, origin, {
              customerId: note.customerId,
              invoiceId: note.invoiceId,
              creditDate: note.creditDate,
              total: note.total,
            });
            return this.detail(tx, ctx, note.id);
          },
        ),
    );
  }

  update(
    principal: Principal,
    id: string,
    input: CreditNoteDraftInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.CreditNotesCreate },
      async (tx, ctx) => {
        const note = await this.lockDraft(tx, ctx, id, input.version);
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const sales = await getSalesSettings(tx, ctx.organizationId);
        const lines = await getCreditNoteLines(tx, ctx.organizationId, id);
        const resolved = await this.resolve(tx, ctx.organizationId, accounting, sales, input, {
          note,
          lines,
        });
        const now = this.now;
        const updated = await updateCreditNote(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: input.version,
          set: { ...resolved.header, updatedByUserId: ctx.userId, updatedAt: now },
        });
        if (!updated) throw versionConflict();
        await replaceCreditNoteLines(tx, ctx.organizationId, id, stripLines(resolved.lines));
        await this.audit(tx, ctx, 'credit_note.updated', id, now, origin, {
          version: updated.version,
          total: { before: note.total, after: updated.total },
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  delete(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.CreditNotesCreate },
      async (tx, ctx) => {
        const note = await this.lockDraft(tx, ctx, id, input.version);
        await deleteCreditNote(tx, ctx.organizationId, id);
        await this.audit(tx, ctx, 'credit_note.deleted', id, this.now, origin, {
          customerId: note.customerId,
          total: note.total,
        });
        return { id, deleted: true };
      },
    );
  }

  private async lockDraft(tx: Transaction, ctx: AuthorizationContext, id: string, version: number) {
    const note = await getCreditNote(tx, ctx.organizationId, id, { forUpdate: true });
    if (!note) throw new NotFoundError('Credit note not found.');
    if (note.version !== version) throw versionConflict();
    if (note.status !== 'DRAFT') {
      throw invalidState(
        note.status === 'PENDING_APPROVAL'
          ? 'The credit note is awaiting approval. Withdraw it first.'
          : 'Issued credit notes cannot be changed or deleted (Decision 41).',
      );
    }
    return note;
  }

  // ---------------------------------------------------------------------------
  // Approval and issue (Decision 41)
  // ---------------------------------------------------------------------------

  submit(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesPermissions.CreditNotesCreate },
      async (tx, ctx) => {
        const note = await this.lockDraft(tx, ctx, id, input.version);
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const sales = await getSalesSettings(tx, ctx.organizationId);
        const lines = await getCreditNoteLines(tx, ctx.organizationId, id);
        const { facts } = await this.posting(
          tx,
          ctx.organizationId,
          accounting,
          sales,
          note,
          lines,
        );
        const now = this.now;
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: CREDIT_NOTE_ISSUE_ACTION,
          subjectId: id,
          excludedUserIds: [...new Set([ctx.userId, note.createdByUserId])],
          reason: null,
          facts,
          now,
        });
        if (!request)
          throw invalidState('No approval step applies to this credit note; issue it directly.');
        const updated = await updateCreditNote(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: note.version,
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
        await this.audit(tx, ctx, 'credit_note.submitted', id, now, origin, {
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
      { permission: SalesPermissions.CreditNotesCreate },
      async (tx, ctx) => {
        const note = await getCreditNote(tx, ctx.organizationId, id, { forUpdate: true });
        if (!note) throw new NotFoundError('Credit note not found.');
        if (note.version !== input.version) throw versionConflict();
        if (note.status !== 'PENDING_APPROVAL')
          throw invalidState('Only a credit note awaiting approval can be withdrawn.');
        const now = this.now;
        const request = note.approvalRequestId
          ? await getApprovalRequest(tx, ctx.organizationId, note.approvalRequestId, {
              forUpdate: true,
            })
          : undefined;
        if (request?.status === 'pending') {
          await this.approvals.withdrawRequest(tx, ctx.organizationId, request.id, now);
        }
        const updated = await updateCreditNote(tx, {
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
        await this.audit(tx, ctx, 'credit_note.withdrawn', id, now, origin, {
          approvalRequestId: request?.id ?? null,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

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
      { permission: SalesPermissions.CreditNotesIssue, sensitive: true },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          {
            key: options.idempotencyKey,
            scope: 'sales.credit_note.issue',
            request: { id, ...input },
          },
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
    const note = await getCreditNote(tx, ctx.organizationId, id, { forUpdate: true });
    if (!note) throw new NotFoundError('Credit note not found.');
    if (note.version !== input.version) throw versionConflict();
    if (note.status === 'ISSUED') throw invalidState('The credit note is already issued.');
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const sales = await getSalesSettings(tx, ctx.organizationId, { forUpdate: true });
    const existing = await getCreditNoteLines(tx, ctx.organizationId, id);
    const customer = await getCustomer(tx, ctx.organizationId, note.customerId);
    const party = customer ? await getParty(tx, ctx.organizationId, customer.partyId) : undefined;
    const issues: ValidationIssue[] = [];
    if (customer?.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
      issues.push({ path: 'customerId', message: 'Archived customers cannot be credited.' });
    }
    const resolved = await this.resolve(
      tx,
      ctx.organizationId,
      accounting,
      sales,
      this.inputOf(note, existing),
      {
        note: { ...note, dimensionValueIds: [] },
        lines: [],
      },
    );
    const total = decimal(resolved.header.total);
    if (total.lte(0))
      issues.push({ path: 'lines', message: 'The credit note total must be greater than zero.' });
    if (resolved.invoice) {
      const credited = decimal(
        await creditedOnInvoice(tx, ctx.organizationId, resolved.invoice.id, id),
      );
      if (credited.plus(total).gt(decimal(resolved.invoice.total))) {
        issues.push({
          path: 'lines',
          message: 'The credit notes for this invoice would exceed the invoice total.',
        });
      }
    }
    if (!sales?.arAccountId) {
      issues.push({
        path: 'arAccountId',
        message: 'Choose the AR control account in Sales settings before issuing.',
      });
    }
    resolved.lines.forEach((l, i) => {
      if (!l.revenueAccountId && !sales?.defaultRevenueAccountId) {
        issues.push({
          path: `lines.${i}.revenueAccountId`,
          message: 'Choose a revenue account or set the default in Sales settings.',
        });
      }
    });
    if (issues.length) throw new ValidationError(issues, 'The credit note cannot be issued yet.');

    const now = this.now;
    const snapshot = await updateCreditNote(tx, {
      organizationId: ctx.organizationId,
      id,
      from: note.status,
      version: note.version,
      set: { ...resolved.header, updatedByUserId: ctx.userId, updatedAt: now },
    });
    if (!snapshot) throw versionConflict();
    const lines = await replaceCreditNoteLines(
      tx,
      ctx.organizationId,
      id,
      stripLines(resolved.lines),
    );
    const posting = await this.posting(tx, ctx.organizationId, accounting, sales, snapshot, lines);
    if (!posting.rate) {
      throw new AppError(
        'EXCHANGE_RATE_REQUIRED',
        409,
        `An exchange rate from ${snapshot.currencyCode} to ${accounting.baseCurrency} is required for ${snapshot.creditDate}.`,
      );
    }
    const approval = await documentApprovalState(
      this.approvals,
      tx,
      ctx.organizationId,
      CREDIT_NOTE_ISSUE_ACTION,
      snapshot,
      posting.facts,
    );
    if (!approval.readyToIssue) {
      throw new AppError(
        'APPROVAL_REQUIRED',
        409,
        snapshot.status === 'DRAFT'
          ? 'This credit note needs approval: submit it for approval first.'
          : approval.approvalOutdated
            ? 'The credit note amount now needs further approval. Withdraw it and submit it again.'
            : 'The credit note has not received all required approvals.',
      );
    }
    await assertOpenPeriod(tx, ctx.organizationId, snapshot.creditDate);
    await assertRequiredDimensions(tx, ctx.organizationId, posting.journal.lines, posting.typeOf);

    const number = await nextDocumentNumber(tx, ctx.organizationId, 'credit_note', (n) =>
      creditNoteNumberExists(tx, ctx.organizationId, n),
    );
    const foreign = snapshot.currencyCode !== accounting.baseCurrency;
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'sales',
      eventType: CREDIT_NOTE_ISSUED_EVENT,
      eventKey: `credit_note:${id}:issued`,
      payload: {
        creditNoteId: id,
        number,
        journal: {
          entryDate: snapshot.creditDate,
          description: `Credit note ${number} — ${party!.displayName}`.slice(0, 500),
          reference: number,
          currency: snapshot.currencyCode,
          exchangeRate: foreign ? posting.rate.toFixed(10) : null,
          ...(foreign ? { exchangeRateSource: 'table' as const } : {}),
          sourceRef: { module: 'sales', type: 'credit_note', id },
          lines: posting.journal.lines.map((l) => journalLine(l, number, posting.typeOf)),
        },
      },
      occurredAt: now,
      origin,
    });
    if (!event.journalId)
      throw new AppError('CONFLICT', 409, 'The credit note was not posted; try again.');
    const arLine = (await getJournalLines(tx, ctx.organizationId, [event.journalId])).find(
      (l) => l.accountId === sales!.arAccountId && l.baseCredit !== null,
    );
    const baseTotal = decimal(arLine!.baseCredit!).toFixed(4);
    const issued = await updateCreditNote(tx, {
      organizationId: ctx.organizationId,
      id,
      from: snapshot.status,
      version: snapshot.version,
      set: {
        status: 'ISSUED',
        number,
        exchangeRate: posting.rate.toFixed(10),
        exchangeRateSource: posting.rateSource,
        baseTotal,
        amountUnapplied: snapshot.total,
        baseUnapplied: baseTotal,
        issuedByUserId: ctx.userId,
        issuedAt: now,
        journalId: event.journalId,
        accountingEventId: event.eventId,
        renderSnapshot: await renderSnapshot(
          tx,
          ctx.organizationId,
          {
            documentType: 'credit_note',
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
            dates: { creditDate: snapshot.creditDate },
            extra: { creditedInvoiceNumber: resolved.invoice?.number ?? null },
          },
          lines,
        ),
        updatedByUserId: ctx.userId,
        updatedAt: now,
      },
    });
    if (!issued) throw versionConflict();
    await lockArAccount(tx, ctx.organizationId, now);
    await this.output.enqueuePdfInTransaction(tx, ctx, 'credit_note', id);
    // §M: a linked credit note is applied to its invoice, up to the invoice's open balance.
    const invoice = resolved.invoice
      ? await getInvoice(tx, ctx.organizationId, resolved.invoice.id)
      : undefined;
    if (invoice && decimal(invoice.amountDue!).gt(0)) {
      const amount = decimal(issued.total).lt(decimal(invoice.amountDue!))
        ? decimal(issued.total)
        : decimal(invoice.amountDue!);
      await this.receipts.applyCreditInTransaction(
        tx,
        ctx,
        {
          sourceType: 'credit_note',
          sourceId: id,
          date: snapshot.creditDate,
          allocations: [{ invoiceId: invoice.id, amount: amount.toFixed(4) }],
        },
        origin,
      );
    }
    await this.audit(tx, ctx, 'credit_note.issued', id, now, origin, {
      number,
      invoiceId: issued.invoiceId,
      total: issued.total,
      currencyCode: issued.currencyCode,
      exchangeRate: issued.exchangeRate,
      exchangeRateSource: issued.exchangeRateSource,
      baseTotal,
      journalId: event.journalId,
      approvalRequestId: issued.approvalRequestId,
    });
    return this.detail(tx, ctx, id);
  }
}
