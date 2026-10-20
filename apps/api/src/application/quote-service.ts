import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { isValidIsoDate } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getCustomer } from '../modules/customers/index.js';
import {
  deleteQuote,
  getQuote,
  getQuoteLines,
  insertQuote,
  listQuotes,
  QuotePermissions,
  replaceQuoteLines,
  takeNextQuoteNumber,
  updateQuote,
  type Quote,
  type QuoteStatus,
} from '../modules/quotes/index.js';
import { getItem, SalesPermissions } from '../modules/sales/index.js';
import { getTaxCode } from '../modules/tax/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { InvoiceService } from './invoice-service.js';
import { withOrganization } from './organization-service.js';

/**
 * Sales quotes (FP-28, migration 0068). A quote is a non-posting offer: draft, sent, accepted or
 * declined, expired by its validity date, converted at most once into a DRAFT sales invoice (which
 * then follows the ordinary invoice rules: tax, approval, issue). Totals on a quote are the net
 * amounts; tax is calculated by the invoice engine at conversion so the two cannot disagree.
 */

const MAX_LINES = 200;
const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The quote changed; reload it and try again.');
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

export interface QuoteLineInput {
  itemId?: string | null | undefined;
  description?: string | undefined;
  quantity: string;
  unitPrice: string;
  taxCodeId?: string | null | undefined;
}

export interface QuoteInput {
  customerId: string;
  quoteDate: string;
  validUntil: string;
  reference?: string | null | undefined;
  memo?: string | undefined;
  lines: QuoteLineInput[];
}

export class QuoteService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly invoices: InvoiceService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private today() {
    return this.now.toISOString().slice(0, 10);
  }

  private audit(
    tx: Transaction,
    ctx: Pick<AuthorizationContext, 'organizationId' | 'userId'>,
    action: string,
    id: string,
    origin: EventOrigin,
    metadata: Record<string, unknown> = {},
  ) {
    return recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'sales_quote',
      resourceId: id,
      metadata,
      origin,
    });
  }

  /** A sent or accepted quote past its validity date reads as EXPIRED. */
  private effectiveStatus(q: Quote): QuoteStatus {
    return (q.status === 'SENT' || q.status === 'ACCEPTED') && q.validUntil < this.today()
      ? 'EXPIRED'
      : q.status;
  }

  private async view(tx: Transaction, organizationId: string, q: Quote) {
    const lines = await getQuoteLines(tx, organizationId, q.id);
    return {
      id: q.id,
      number: q.number,
      customerId: q.customerId,
      quoteDate: q.quoteDate,
      validUntil: q.validUntil,
      status: this.effectiveStatus(q),
      reference: q.reference,
      memo: q.memo,
      netTotal: decimal(q.netTotal).toFixed(),
      declineReason: q.declineReason,
      invoiceId: q.invoiceId,
      version: q.version,
      lines: lines.map((l) => ({
        lineNo: l.lineNo,
        itemId: l.itemId,
        description: l.description,
        quantity: decimal(l.quantity).toFixed(),
        unitPrice: decimal(l.unitPrice).toFixed(),
        taxCodeId: l.taxCodeId,
        netAmount: decimal(l.netAmount).toFixed(),
      })),
    };
  }

  private async validate(tx: Transaction, ctx: AuthorizationContext, input: QuoteInput) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const places = minorUnits(accounting.baseCurrency);
    const issues: ValidationIssue[] = [];
    if (!isValidIsoDate(input.quoteDate)) {
      issues.push({ path: 'quoteDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    }
    if (!isValidIsoDate(input.validUntil)) {
      issues.push({ path: 'validUntil', message: 'Enter a valid date (YYYY-MM-DD).' });
    } else if (isValidIsoDate(input.quoteDate) && input.validUntil < input.quoteDate) {
      issues.push({ path: 'validUntil', message: 'The quote cannot expire before it is dated.' });
    }
    if (!(await getCustomer(tx, ctx.organizationId, input.customerId))) {
      issues.push({ path: 'customerId', message: 'Choose a customer of this organization.' });
    }
    if (!input.lines.length || input.lines.length > MAX_LINES) {
      issues.push({ path: 'lines', message: `Add between 1 and ${MAX_LINES} lines.` });
    }
    const resolved: {
      itemId: string | null;
      description: string;
      quantity: string;
      unitPrice: string;
      taxCodeId: string | null;
      netAmount: string;
    }[] = [];
    for (const [i, line] of input.lines.entries()) {
      const item = line.itemId ? await getItem(tx, ctx.organizationId, line.itemId) : undefined;
      if (line.itemId && !item) {
        issues.push({ path: `lines.${i}.itemId`, message: 'Unknown item.' });
      }
      const description = (line.description?.trim() || item?.name || '').slice(0, 500);
      if (!description) {
        issues.push({
          path: `lines.${i}.description`,
          message: 'Describe the line or choose an item.',
        });
      }
      const quantity = decimal(line.quantity);
      const unitPrice = decimal(line.unitPrice);
      if (!quantity.gt(0))
        issues.push({ path: `lines.${i}.quantity`, message: 'Enter a quantity above zero.' });
      if (unitPrice.lt(0))
        issues.push({ path: `lines.${i}.unitPrice`, message: 'Enter zero or more.' });
      if (line.taxCodeId && !(await getTaxCode(tx, ctx.organizationId, line.taxCodeId))) {
        issues.push({ path: `lines.${i}.taxCodeId`, message: 'Unknown tax code.' });
      }
      resolved.push({
        itemId: line.itemId ?? null,
        description,
        quantity: quantity.toFixed(6),
        unitPrice: unitPrice.toFixed(6),
        taxCodeId: line.taxCodeId ?? null,
        netAmount: quantity.times(unitPrice).toDecimalPlaces(places).toFixed(4),
      });
    }
    if (issues.length) throw new ValidationError(issues);
    const netTotal = resolved.reduce((s, l) => s.plus(l.netAmount), decimal(0)).toFixed(4);
    return { resolved, netTotal };
  }

  list(
    principal: Principal,
    filter: { status?: QuoteStatus | undefined; customerId?: string | undefined; limit: number },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const rows = await listQuotes(tx, ctx.organizationId, filter);
        return Promise.all(rows.map((q) => this.view(tx, ctx.organizationId, q)));
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const q = await getQuote(tx, ctx.organizationId, id);
        if (!q) throw new NotFoundError('Quote not found.');
        return this.view(tx, ctx.organizationId, q);
      },
    );
  }

  create(
    principal: Principal,
    input: QuoteInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.Create },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'sales.quote.create', request: input },
          async () => {
            const { resolved, netTotal } = await this.validate(tx, ctx, input);
            const now = this.now;
            const quote = await insertQuote(tx, {
              organizationId: ctx.organizationId,
              number: await takeNextQuoteNumber(tx, ctx.organizationId),
              customerId: input.customerId,
              quoteDate: input.quoteDate,
              validUntil: input.validUntil,
              reference: input.reference?.trim() || null,
              memo: (input.memo ?? '').trim(),
              netTotal,
              createdByUserId: ctx.userId,
              createdAt: now,
              updatedAt: now,
            });
            await replaceQuoteLines(tx, ctx.organizationId, quote.id, resolved);
            await this.audit(tx, ctx, 'quote.created', quote.id, origin, {
              number: quote.number,
              customerId: quote.customerId,
              netTotal,
              lines: resolved.length,
            });
            return this.view(tx, ctx.organizationId, quote);
          },
        ),
    );
  }

  update(
    principal: Principal,
    id: string,
    input: QuoteInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.Create },
      async (tx, ctx) => {
        const existing = await getQuote(tx, ctx.organizationId, id, { forUpdate: true });
        if (!existing) throw new NotFoundError('Quote not found.');
        if (existing.version !== input.version) throw versionConflict();
        if (existing.status !== 'DRAFT') throw invalidState('Only a draft quote can be edited.');
        const { resolved, netTotal } = await this.validate(tx, ctx, input);
        await replaceQuoteLines(tx, ctx.organizationId, id, resolved);
        const updated = await updateQuote(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            customerId: input.customerId,
            quoteDate: input.quoteDate,
            validUntil: input.validUntil,
            reference: input.reference?.trim() || null,
            memo: (input.memo ?? '').trim(),
            netTotal,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'quote.updated', id, origin, { netTotal });
        return this.view(tx, ctx.organizationId, updated);
      },
    );
  }

  delete(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.Create },
      async (tx, ctx) => {
        const existing = await getQuote(tx, ctx.organizationId, id, { forUpdate: true });
        if (!existing) throw new NotFoundError('Quote not found.');
        if (existing.version !== input.version) throw versionConflict();
        if (existing.status !== 'DRAFT') throw invalidState('Only a draft quote can be deleted.');
        await deleteQuote(tx, ctx.organizationId, id);
        await this.audit(tx, ctx, 'quote.deleted', id, origin, { number: existing.number });
        return { id, deleted: true as const };
      },
    );
  }

  /** Records an outcome on a quote; an expired quote is persisted as EXPIRED and the action refused. */
  private transition(
    principal: Principal,
    id: string,
    input: { version: number; reason?: string | undefined },
    action: 'send' | 'accept' | 'decline',
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.Create },
      async (tx, ctx) => {
        const q = await getQuote(tx, ctx.organizationId, id, { forUpdate: true });
        if (!q) throw new NotFoundError('Quote not found.');
        if (q.version !== input.version) throw versionConflict();
        const from: QuoteStatus = action === 'send' ? 'DRAFT' : 'SENT';
        if (q.status !== from) {
          throw invalidState(
            action === 'send'
              ? 'Only a draft quote can be sent.'
              : 'Only a sent quote can be accepted or declined.',
          );
        }
        const now = this.now;
        if (q.validUntil < this.today()) throw invalidState('The quote has expired.');
        const reason = input.reason?.trim();
        if (action === 'decline' && !reason) {
          throw new ValidationError([
            { path: 'reason', message: 'Say why the quote was declined.' },
          ]);
        }
        const status = action === 'send' ? 'SENT' : action === 'accept' ? 'ACCEPTED' : 'DECLINED';
        const updated = await updateQuote(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status,
            ...(action === 'send' ? { sentAt: now } : { decidedAt: now }),
            ...(action === 'decline' ? { declineReason: reason! } : {}),
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(
          tx,
          ctx,
          `quote.${action === 'send' ? 'sent' : action === 'accept' ? 'accepted' : 'declined'}`,
          id,
          origin,
          {
            number: q.number,
            ...(reason ? { reason } : {}),
          },
        );
        return this.view(tx, ctx.organizationId, updated);
      },
    );
  }

  send(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.transition(principal, id, input, 'send', origin);
  }

  accept(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.transition(principal, id, input, 'accept', origin);
  }

  decline(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return this.transition(principal, id, input, 'decline', origin);
  }

  /**
   * Converts an accepted quote into ONE draft sales invoice (same customer, lines and reference).
   * Needs `quotes.convert` and `invoices.create`. A quote converts at most once.
   */
  convert(
    principal: Principal,
    id: string,
    input: { version: number; invoiceDate?: string | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.Convert },
      async (tx, ctx) => {
        if (!hasPermission(ctx, SalesPermissions.InvoicesCreate)) throw new PermissionDeniedError();
        const q = await getQuote(tx, ctx.organizationId, id, { forUpdate: true });
        if (!q) throw new NotFoundError('Quote not found.');
        if (q.version !== input.version) throw versionConflict();
        if (q.status === 'CONVERTED') throw invalidState('The quote was already converted.');
        if (q.status !== 'ACCEPTED') throw invalidState('Only an accepted quote can be converted.');
        if (q.validUntil < this.today()) {
          throw invalidState('The quote has expired.');
        }
        const invoiceDate = input.invoiceDate ?? this.today();
        if (!isValidIsoDate(invoiceDate)) {
          throw new ValidationError([
            { path: 'invoiceDate', message: 'Enter a valid date (YYYY-MM-DD).' },
          ]);
        }
        const lines = await getQuoteLines(tx, ctx.organizationId, id);
        const invoice = await this.invoices.createDraftInTransaction(
          tx,
          ctx,
          {
            customerId: q.customerId,
            invoiceDate,
            reference: q.number,
            memo: q.memo,
            lines: lines.map((l) => ({
              ...(l.itemId ? { itemId: l.itemId } : {}),
              description: l.description,
              quantity: decimal(l.quantity).toFixed(),
              unitPrice: decimal(l.unitPrice).toFixed(),
              ...(l.taxCodeId ? { taxCodeId: l.taxCodeId } : {}),
            })),
          },
          origin,
        );
        const now = this.now;
        const updated = await updateQuote(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'CONVERTED',
            invoiceId: invoice.id,
            convertedAt: now,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'quote.converted', id, origin, {
          number: q.number,
          invoiceId: invoice.id,
        });
        return { quote: await this.view(tx, ctx.organizationId, updated), invoiceId: invoice.id };
      },
    );
  }
}
