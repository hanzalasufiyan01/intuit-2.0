import { Decimal } from 'decimal.js';
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
  findApplicableRate,
  isValidIsoDate,
  type AccountingSettings,
} from '../modules/accounting/index.js';
import { getApprovalRequest } from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { type Discount } from '../modules/documents/index.js';
import { getParty, partyIdsMatching } from '../modules/parties/index.js';
import {
  addLineQuantity,
  commitmentsByVendor,
  deleteOrder,
  getBillLink,
  getBillMatch,
  getOrder,
  getOrderLines,
  getOrderSettings,
  getReceipt,
  getReceiptLines,
  insertBillLink,
  insertBilling,
  insertBillMatch,
  insertOrder,
  insertReceipt,
  listActiveBillings,
  listOrderBills,
  listOrders,
  listReceipts,
  orderNumberExists,
  PurchaseOrderPermissions,
  receiptNumberExists,
  replaceOrderLines,
  reverseBilling,
  saveOrderSettings,
  takeNextOrderNumber,
  updateOrder,
  voidReceipt,
  type MatchIssue,
  type MatchMode,
  type OrderStatus,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type PurchaseReceipt,
} from '../modules/purchase-orders/index.js';
import {
  getBill,
  getPurchasesSettings,
  type PurchasesSettings,
} from '../modules/purchases/index.js';
import type { TaxTreatment } from '../modules/tax/index.js';
import { getVendor, vendorIdsOfParties } from '../modules/vendors/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { ApprovalService } from './approval-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { BillDraftInput } from './bill-service.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import { withOrganization } from './organization-service.js';
import type { BillMatchPlan, PurchaseOrderHooks } from './purchase-order-hooks.js';
import {
  purchaseLinesAsInput,
  resolvePurchaseDocument,
  stripPurchaseLines,
  type PurchaseLineInput,
  type ResolvedPurchaseDocument,
} from './purchase-documents.js';
import { shownMoney } from './sales-documents.js';
import { isValidDecimalPercent } from './purchase-order-rules.js';

/**
 * Purchase orders, goods receiving and three-way matching (approved 2026-10-07; ADR 0007).
 *
 * An order commits to a vendor for quantities and prices and creates NO journal. It follows
 * DRAFT → PENDING_APPROVAL → APPROVED → PARTIALLY_RECEIVED → RECEIVED → CLOSED, or CANCELLED.
 * Submitting opens an approval request when a policy step matches (action
 * `purchases.order.approve`, type `purchase_order`); with no matching step the order is approved
 * at once. A goods receipt records quantities received (no GRNI: receiving never posts). A bill is
 * linked to an order; when it posts, the match runs (bill price against order price, billed
 * quantity against received, each with a tolerance) in the organization's mode OFF, WARNING or
 * BLOCK, and its billed quantities are applied to the order lines. A bill void releases them.
 */

export const ORDER_APPROVE_ACTION = 'purchases.order.approve';
const RESOURCE = 'purchase_order';
const RECEIPT_RESOURCE = 'purchase_receipt';
const SETTINGS_RESOURCE = 'purchase_order_settings';
const LIVE: readonly OrderStatus[] = ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED'];
const EPSILON = decimal('0.000001');

export interface OrderDraftInput {
  vendorId: string;
  orderDate: string;
  expectedDate?: string | null | undefined;
  currencyCode?: string | undefined;
  taxTreatment?: TaxTreatment | undefined;
  discount?: Discount | null | undefined;
  memo?: string | undefined;
  dimensionValueIds?: string[] | undefined;
  lines: PurchaseLineInput[];
}

export interface ReceiptInput {
  receiptDate: string;
  reference?: string | null | undefined;
  memo?: string | undefined;
  lines: { orderLineId: string; quantity: string }[];
}

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = (noun = 'purchase order') =>
  new ConflictError(
    'VERSION_CONFLICT',
    `This ${noun} was changed by someone else. Reload it and apply your changes again.`,
  );

function encodeCursor(order: PurchaseOrder) {
  return Buffer.from(JSON.stringify({ d: order.orderDate, i: order.id })).toString('base64url');
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

/** The unit price after the line discount, before any document discount. */
const effectiveUnit = (amount: string, lineDiscount: string, quantity: string) =>
  decimal(quantity).isZero() ? decimal(0) : decimal(amount).minus(lineDiscount).div(quantity);

export class PurchaseOrderService implements PurchaseOrderHooks {
  constructor(
    private readonly deps: AppDependencies,
    private readonly approvals: ApprovalService,
    private readonly idempotency: IdempotencyService,
  ) {
    approvals.register({
      actionKey: ORDER_APPROVE_ACTION,
      label: 'Approve purchase orders',
      subjectType: RESOURCE,
      approverPermission: PurchaseOrderPermissions.Approve,
      decisionRequiresReauth: false,
      conditions: { amount: true, transactionTypes: ['purchase_order'] },
      onApproved: async (tx, { request, authz, now, origin }) => {
        const order = await updateOrder(tx, {
          organizationId: authz.organizationId,
          id: request.subjectId,
          from: 'PENDING_APPROVAL',
          set: {
            status: 'APPROVED',
            approvedAt: now,
            updatedByUserId: authz.userId,
            updatedAt: now,
          },
        });
        if (!order) throw invalidState('The purchase order is no longer awaiting approval.');
        await this.audit(tx, authz, 'purchase_order.approved', order.id, now, origin, {
          approvalRequestId: request.id,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        if (!comment?.trim()) {
          throw new ValidationError([
            { path: 'comment', message: 'Give a reason for rejecting the purchase order.' },
          ]);
        }
        const order = await updateOrder(tx, {
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
        if (!order) throw invalidState('The purchase order is no longer awaiting approval.');
        await this.audit(tx, authz, 'purchase_order.rejected', order.id, now, origin, {
          approvalRequestId: request.id,
          comment: comment.trim(),
        });
      },
    });
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
    resourceType = RESOURCE,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType,
      resourceId: id,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Settings (the three-way match)
  // ---------------------------------------------------------------------------

  getSettings(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => this.settingsView(await getOrderSettings(tx, ctx.organizationId)),
    );
  }

  private settingsView(row: Awaited<ReturnType<typeof getOrderSettings>>) {
    return {
      matchMode: (row?.matchMode ?? 'off') as MatchMode,
      quantityTolerancePct: row ? decimal(row.quantityTolerancePct).toFixed() : '0',
      priceTolerancePct: row ? decimal(row.priceTolerancePct).toFixed() : '0',
      version: row?.version ?? 0,
    };
  }

  updateSettings(
    principal: Principal,
    input: {
      version: number;
      matchMode: MatchMode;
      quantityTolerancePct: string;
      priceTolerancePct: string;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.SettingsManage, sensitive: true },
      async (tx, ctx) => {
        const issues: ValidationIssue[] = [];
        for (const key of ['quantityTolerancePct', 'priceTolerancePct'] as const) {
          if (!isValidDecimalPercent(input[key])) {
            issues.push({
              path: key,
              message: 'Enter a percentage from 0 to 100 with up to 4 decimals.',
            });
          }
        }
        if (issues.length) throw new ValidationError(issues);
        const saved = await saveOrderSettings(tx, {
          organizationId: ctx.organizationId,
          version: input.version,
          matchMode: input.matchMode,
          quantityTolerancePct: decimal(input.quantityTolerancePct).toFixed(4),
          priceTolerancePct: decimal(input.priceTolerancePct).toFixed(4),
          userId: ctx.userId,
          at: this.now,
        });
        if (!saved) throw versionConflict('setting');
        await this.audit(
          tx,
          ctx,
          'purchase_order.settings_updated',
          ctx.organizationId,
          this.now,
          origin,
          {
            matchMode: saved.matchMode,
            quantityTolerancePct: saved.quantityTolerancePct,
            priceTolerancePct: saved.priceTolerancePct,
          },
          SETTINGS_RESOURCE,
        );
        return this.settingsView(saved);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Resolution and views
  // ---------------------------------------------------------------------------

  private async resolve(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    purchases: PurchasesSettings | undefined,
    input: OrderDraftInput,
    existing?: { order: PurchaseOrder; lines: readonly PurchaseOrderLine[] },
  ): Promise<ResolvedPurchaseDocument & { expectedDate: string | null }> {
    const resolved = await resolvePurchaseDocument(
      tx,
      organizationId,
      accounting,
      purchases,
      { ...input, date: input.orderDate },
      {
        datePath: 'orderDate',
        noun: 'purchase orders',
        existing: existing && {
          vendorId: existing.order.vendorId,
          dimensionValueIds: existing.order.dimensionValueIds,
          lines: existing.lines,
        },
      },
    );
    const issues: ValidationIssue[] = [];
    const expectedDate = input.expectedDate ?? null;
    if (expectedDate !== null) {
      if (!isValidIsoDate(expectedDate)) {
        issues.push({ path: 'expectedDate', message: 'Enter a valid date (YYYY-MM-DD).' });
      } else if (expectedDate < input.orderDate) {
        issues.push({
          path: 'expectedDate',
          message: 'The expected date cannot be before the order date.',
        });
      }
    }
    if (issues.length) throw new ValidationError(issues);
    return { ...resolved, expectedDate };
  }

  private inputOf(order: PurchaseOrder, lines: readonly PurchaseOrderLine[]): OrderDraftInput {
    return {
      vendorId: order.vendorId,
      orderDate: order.orderDate,
      expectedDate: order.expectedDate,
      currencyCode: order.currencyCode,
      taxTreatment: order.taxTreatment,
      discount: order.discountType
        ? { type: order.discountType, value: order.discountValue! }
        : null,
      memo: order.memo,
      dimensionValueIds: order.dimensionValueIds,
      lines: purchaseLinesAsInput(lines),
    };
  }

  private summary(order: PurchaseOrder, name: string | null) {
    const c = order.currencyCode;
    return {
      id: order.id,
      status: order.status,
      number: order.number,
      vendorId: order.vendorId,
      vendorName: name,
      orderDate: order.orderDate,
      expectedDate: order.expectedDate,
      currencyCode: c,
      subtotal: shownMoney(order.subtotal, c),
      discountTotal: shownMoney(order.discountTotal, c),
      taxTotal: shownMoney(order.taxTotal, c),
      total: shownMoney(order.total, c),
      version: order.version,
      approvedAt: order.approvedAt?.toISOString() ?? null,
      closedAt: order.closedAt?.toISOString() ?? null,
      cancelledAt: order.cancelledAt?.toISOString() ?? null,
    };
  }

  private lineView(l: PurchaseOrderLine, currency: string) {
    const ordered = decimal(l.quantity);
    return {
      id: l.id,
      lineNo: l.lineNo,
      itemId: l.itemId,
      description: l.description,
      accountId: l.accountId,
      quantity: ordered.toFixed(),
      unitPrice: decimal(l.unitPrice).toFixed(),
      discount: l.discountType
        ? { type: l.discountType, value: decimal(l.discountValue!).toFixed() }
        : null,
      amount: shownMoney(l.amount, currency),
      lineDiscount: shownMoney(l.lineDiscount, currency),
      netAmount: shownMoney(l.netAmount, currency),
      taxCodeId: l.taxCodeId,
      taxRate: l.taxRate ? decimal(l.taxRate).toFixed() : null,
      taxAmount: shownMoney(l.taxAmount, currency),
      taxRecoverable: l.taxRecoverable,
      taxRecoverableOverride: l.taxRecoverableOverride,
      total: shownMoney(l.total, currency),
      dimensionValueIds: l.dimensionValueIds,
      receivedQuantity: decimal(l.receivedQuantity).toFixed(),
      billedQuantity: decimal(l.billedQuantity).toFixed(),
      remainingToReceive: Decimal.max(ordered.minus(l.receivedQuantity), 0).toFixed(),
      remainingToBill: Decimal.max(ordered.minus(l.billedQuantity), 0).toFixed(),
    };
  }

  private async approvalFacts(
    tx: Transaction,
    organizationId: string,
    accounting: AccountingSettings,
    order: PurchaseOrder,
  ) {
    let baseAmount: string | null;
    if (order.currencyCode === accounting.baseCurrency) {
      baseAmount = decimal(order.total).toFixed(2);
    } else {
      const rate = await findApplicableRate(tx, {
        organizationId,
        fromCurrency: order.currencyCode,
        toCurrency: accounting.baseCurrency,
        onDate: order.orderDate,
      });
      baseAmount = rate ? decimal(order.total).times(rate.rate).toFixed(2) : null;
    }
    return {
      transactionType: 'purchase_order',
      baseAmount,
      baseCurrency: accounting.baseCurrency,
    };
  }

  private async detail(tx: Transaction, ctx: AuthorizationContext, id: string) {
    const order = await getOrder(tx, ctx.organizationId, id);
    if (!order) throw new NotFoundError('Purchase order not found.');
    const lines = await getOrderLines(tx, ctx.organizationId, id);
    const links = await listOrderBills(tx, ctx.organizationId, id);
    const bills = [];
    for (const link of links) {
      const bill = await getBill(tx, ctx.organizationId, link.billId);
      const match = await getBillMatch(tx, ctx.organizationId, link.billId);
      bills.push({
        billId: link.billId,
        number: bill?.number ?? null,
        status: bill?.status ?? null,
        total: bill ? shownMoney(bill.total, bill.currencyCode) : null,
        match: match ? { mode: match.mode, status: match.status, issues: match.issues } : null,
      });
    }
    const receipts = await listReceipts(tx, ctx.organizationId, id, 200);
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    return {
      ...this.summary(order, await vendorName(tx, ctx.organizationId, order.vendorId)),
      memo: order.memo,
      taxTreatment: order.taxTreatment,
      discount: order.discountType
        ? { type: order.discountType, value: decimal(order.discountValue!).toFixed() }
        : null,
      dimensionValueIds: order.dimensionValueIds,
      closeReason: order.closeReason,
      cancelReason: order.cancelReason,
      createdByUserId: order.createdByUserId,
      baseCurrency: accounting.baseCurrency,
      lines: lines.map((l) => this.lineView(l, order.currencyCode)),
      bills,
      receipts: receipts.map((r) => this.receiptView(r)),
      approval: order.approvalRequestId
        ? await this.approvalState(tx, ctx.organizationId, order)
        : null,
    };
  }

  private async approvalState(tx: Transaction, organizationId: string, order: PurchaseOrder) {
    const request = order.approvalRequestId
      ? await getApprovalRequest(tx, organizationId, order.approvalRequestId)
      : undefined;
    return {
      requestId: request?.id ?? null,
      requestStatus: request?.status ?? null,
    };
  }

  private receiptView(r: PurchaseReceipt) {
    return {
      id: r.id,
      number: r.number,
      orderId: r.orderId,
      date: r.receiptDate,
      reference: r.reference,
      memo: r.memo,
      status: r.status,
      voidedAt: r.voidedAt?.toISOString() ?? null,
      voidReason: r.voidReason,
      version: r.version,
    };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(
    principal: Principal,
    query: {
      status?: OrderStatus[] | undefined;
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
      { permission: PurchaseOrderPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const search = query.search?.trim() || null;
        const page = await listOrders(tx, {
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
        for (const id of new Set(page.items.map((o) => o.vendorId))) {
          names.set(id, await vendorName(tx, ctx.organizationId, id));
        }
        const last = page.items.at(-1);
        return {
          items: page.items.map((o) => this.summary(o, names.get(o.vendorId) ?? null)),
          nextCursor: page.hasMore && last ? encodeCursor(last) : null,
        };
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.View, readOnlySnapshot: true },
      (tx, ctx) => this.detail(tx, ctx, id),
    );
  }

  /** What is still to be billed on live orders, by vendor and currency. */
  commitments(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const rows = await commitmentsByVendor(tx, ctx.organizationId);
        const items = [];
        for (const r of rows) {
          items.push({
            vendorId: r.vendorId,
            vendorName: await vendorName(tx, ctx.organizationId, r.vendorId),
            currencyCode: r.currencyCode,
            orderCount: r.orderCount,
            ordered: shownMoney(r.ordered, r.currencyCode),
            openValue: shownMoney(r.openValue, r.currencyCode),
          });
        }
        return { items };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------------------

  create(
    principal: Principal,
    input: OrderDraftInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.Create },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'purchases.order.create', request: input },
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
            const order = await insertOrder(tx, {
              ...resolved.header,
              orderDate: input.orderDate,
              expectedDate: resolved.expectedDate,
              organizationId: ctx.organizationId,
              createdByUserId: ctx.userId,
              createdAt: now,
              updatedByUserId: ctx.userId,
              updatedAt: now,
            });
            await replaceOrderLines(
              tx,
              ctx.organizationId,
              order.id,
              stripPurchaseLines(resolved.lines),
            );
            await this.audit(tx, ctx, 'purchase_order.created', order.id, now, origin, {
              vendorId: order.vendorId,
              orderDate: order.orderDate,
              currencyCode: order.currencyCode,
              total: order.total,
              lines: resolved.lines.length,
            });
            return this.detail(tx, ctx, order.id);
          },
        ),
    );
  }

  update(
    principal: Principal,
    id: string,
    input: OrderDraftInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.Create },
      async (tx, ctx) => {
        const order = await this.lockDraft(tx, ctx, id, input.version, 'edited');
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const purchases = await getPurchasesSettings(tx, ctx.organizationId);
        const existingLines = await getOrderLines(tx, ctx.organizationId, id);
        const resolved = await this.resolve(tx, ctx.organizationId, accounting, purchases, input, {
          order,
          lines: existingLines,
        });
        const now = this.now;
        const updated = await updateOrder(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: input.version,
          set: {
            ...resolved.header,
            orderDate: input.orderDate,
            expectedDate: resolved.expectedDate,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict();
        await replaceOrderLines(tx, ctx.organizationId, id, stripPurchaseLines(resolved.lines));
        await this.audit(tx, ctx, 'purchase_order.updated', id, now, origin, {
          version: updated.version,
          total: { before: order.total, after: updated.total },
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
      { permission: PurchaseOrderPermissions.Create },
      async (tx, ctx) => {
        const order = await this.lockDraft(tx, ctx, id, input.version, 'deleted');
        await deleteOrder(tx, ctx.organizationId, id);
        await this.audit(tx, ctx, 'purchase_order.deleted', id, this.now, origin, {
          vendorId: order.vendorId,
          total: order.total,
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
    const order = await getOrder(tx, ctx.organizationId, id, { forUpdate: true });
    if (!order) throw new NotFoundError('Purchase order not found.');
    if (order.version !== version) throw versionConflict();
    if (order.status !== 'DRAFT') {
      throw invalidState(
        order.status === 'PENDING_APPROVAL'
          ? `The purchase order is awaiting approval. Withdraw it before it can be ${verb}.`
          : `Only draft purchase orders can be ${verb}; a submitted order is closed or cancelled.`,
      );
    }
    return order;
  }

  // ---------------------------------------------------------------------------
  // Approval
  // ---------------------------------------------------------------------------

  /**
   * Submit: recomputes the order, assigns the PO- number and opens an approval request when a
   * policy step matches; with none the order is approved at once.
   */
  submit(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.Create },
      async (tx, ctx) => {
        const order = await getOrder(tx, ctx.organizationId, id, { forUpdate: true });
        if (!order) throw new NotFoundError('Purchase order not found.');
        if (order.version !== input.version) throw versionConflict();
        if (order.status !== 'DRAFT')
          throw invalidState('Only draft purchase orders can be submitted.');
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const purchases = await getPurchasesSettings(tx, ctx.organizationId);
        const existing = await getOrderLines(tx, ctx.organizationId, id);
        const vendor = await getVendor(tx, ctx.organizationId, order.vendorId);
        const party = vendor ? await getParty(tx, ctx.organizationId, vendor.partyId) : undefined;
        if (vendor?.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
          throw new ValidationError([
            {
              path: 'vendorId',
              message: 'Purchase orders for archived vendors cannot be submitted.',
            },
          ]);
        }
        // Recompute with today's references, then keep the snapshot on the draft.
        const resolved = await this.resolve(
          tx,
          ctx.organizationId,
          accounting,
          purchases,
          this.inputOf(order, existing),
          { order: { ...order, vendorId: '', dimensionValueIds: [] }, lines: [] },
        );
        if (decimal(resolved.header.total).lte(0)) {
          throw new ValidationError([
            { path: 'lines', message: 'The order total must be greater than zero.' },
          ]);
        }
        const now = this.now;
        const snapshot = await updateOrder(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: order.version,
          set: {
            ...resolved.header,
            expectedDate: resolved.expectedDate,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!snapshot) throw versionConflict();
        await replaceOrderLines(tx, ctx.organizationId, id, stripPurchaseLines(resolved.lines));
        const facts = await this.approvalFacts(tx, ctx.organizationId, accounting, snapshot);
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: ORDER_APPROVE_ACTION,
          subjectId: id,
          // No self-approval: neither the preparer nor the submitter.
          excludedUserIds: [...new Set([ctx.userId, order.createdByUserId])],
          reason: null,
          facts,
          now,
        });
        // A returned order (withdrawn or rejected) keeps the number it was given.
        const number = order.number ?? (await this.nextNumber(tx, ctx.organizationId, 'order'));
        const submitted = await updateOrder(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          set: request
            ? {
                status: 'PENDING_APPROVAL',
                number,
                approvalRequestId: request.id,
                submittedByUserId: ctx.userId,
                submittedAt: now,
                updatedByUserId: ctx.userId,
                updatedAt: now,
              }
            : {
                status: 'APPROVED',
                number,
                submittedByUserId: ctx.userId,
                submittedAt: now,
                approvedAt: now,
                updatedByUserId: ctx.userId,
                updatedAt: now,
              },
        });
        if (!submitted) throw versionConflict();
        await this.audit(
          tx,
          ctx,
          request ? 'purchase_order.submitted' : 'purchase_order.approved',
          id,
          now,
          origin,
          {
            number,
            approvalRequestId: request?.id ?? null,
            facts,
          },
        );
        return this.detail(tx, ctx, id);
      },
    );
  }

  withdraw(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.Create },
      async (tx, ctx) => {
        const order = await getOrder(tx, ctx.organizationId, id, { forUpdate: true });
        if (!order) throw new NotFoundError('Purchase order not found.');
        if (order.version !== input.version) throw versionConflict();
        if (order.status !== 'PENDING_APPROVAL') {
          throw invalidState('Only a purchase order awaiting approval can be withdrawn.');
        }
        const now = this.now;
        const request = order.approvalRequestId
          ? await getApprovalRequest(tx, ctx.organizationId, order.approvalRequestId, {
              forUpdate: true,
            })
          : undefined;
        if (request?.status === 'pending') {
          await this.approvals.withdrawRequest(tx, ctx.organizationId, request.id, now);
        }
        const updated = await updateOrder(tx, {
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
        await this.audit(tx, ctx, 'purchase_order.withdrawn', id, now, origin, {
          approvalRequestId: request?.id ?? null,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  private async nextNumber(tx: Transaction, organizationId: string, type: 'order' | 'receipt') {
    const exists = type === 'order' ? orderNumberExists : receiptNumberExists;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const number = await takeNextOrderNumber(tx, organizationId, type);
      if (!(await exists(tx, organizationId, number))) return number;
    }
    throw new AppError('CONFLICT', 409, 'Could not find a free number; check the numbering.');
  }

  // ---------------------------------------------------------------------------
  // Status, close and cancel
  // ---------------------------------------------------------------------------

  /** APPROVED, PARTIALLY_RECEIVED or RECEIVED follows the quantities received. */
  private async syncStatus(
    tx: Transaction,
    ctx: AuthorizationContext,
    order: PurchaseOrder,
    now: Date,
  ) {
    if (!LIVE.includes(order.status)) return order;
    const lines = await getOrderLines(tx, ctx.organizationId, order.id);
    const received = lines.some((l) => decimal(l.receivedQuantity).gt(0));
    const complete = lines.every((l) => decimal(l.receivedQuantity).gte(l.quantity));
    const next: OrderStatus = complete ? 'RECEIVED' : received ? 'PARTIALLY_RECEIVED' : 'APPROVED';
    if (next === order.status) return order;
    const updated = await updateOrder(tx, {
      organizationId: ctx.organizationId,
      id: order.id,
      from: order.status,
      set: { status: next, updatedByUserId: ctx.userId, updatedAt: now },
    });
    return updated ?? order;
  }

  close(
    principal: Principal,
    id: string,
    input: { version: number; reason?: string | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.Close },
      async (tx, ctx) => {
        const order = await getOrder(tx, ctx.organizationId, id, { forUpdate: true });
        if (!order) throw new NotFoundError('Purchase order not found.');
        if (order.version !== input.version) throw versionConflict();
        if (!LIVE.includes(order.status))
          throw invalidState('Only an approved purchase order can be closed.');
        const now = this.now;
        const updated = await updateOrder(tx, {
          organizationId: ctx.organizationId,
          id,
          from: order.status,
          version: input.version,
          set: {
            status: 'CLOSED',
            closedByUserId: ctx.userId,
            closedAt: now,
            closeReason: input.reason?.trim() || null,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'purchase_order.closed', id, now, origin, {
          reason: updated.closeReason,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  cancel(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.Close },
      async (tx, ctx) => {
        const order = await getOrder(tx, ctx.organizationId, id, { forUpdate: true });
        if (!order) throw new NotFoundError('Purchase order not found.');
        if (order.version !== input.version) throw versionConflict();
        if (order.status !== 'APPROVED') {
          throw invalidState(
            'Only an approved order with nothing received can be cancelled; close it otherwise.',
          );
        }
        const lines = await getOrderLines(tx, ctx.organizationId, id);
        if (
          lines.some((l) => decimal(l.receivedQuantity).gt(0) || decimal(l.billedQuantity).gt(0))
        ) {
          throw invalidState('The order has goods received or billed; close it instead.');
        }
        const links = await listOrderBills(tx, ctx.organizationId, id);
        for (const link of links) {
          const bill = await getBill(tx, ctx.organizationId, link.billId);
          if (bill && bill.status !== 'VOID') {
            throw invalidState('A bill is linked to this order; delete or void it first.');
          }
        }
        const now = this.now;
        const updated = await updateOrder(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'APPROVED',
          version: input.version,
          set: {
            status: 'CANCELLED',
            cancelledByUserId: ctx.userId,
            cancelledAt: now,
            cancelReason: input.reason.trim(),
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'purchase_order.cancelled', id, now, origin, {
          reason: updated.cancelReason,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Goods receiving
  // ---------------------------------------------------------------------------

  receive(
    principal: Principal,
    orderId: string,
    input: ReceiptInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.Receive },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          {
            key: options.idempotencyKey,
            scope: 'purchases.order.receive',
            request: { orderId, ...input },
          },
          async () => {
            const order = await getOrder(tx, ctx.organizationId, orderId, { forUpdate: true });
            if (!order) throw new NotFoundError('Purchase order not found.');
            if (!LIVE.includes(order.status)) {
              throw invalidState(
                `Goods cannot be received on a ${order.status.toLowerCase().replace('_', ' ')} order.`,
              );
            }
            const issues: ValidationIssue[] = [];
            if (!isValidIsoDate(input.receiptDate)) {
              issues.push({ path: 'receiptDate', message: 'Enter a valid date (YYYY-MM-DD).' });
            }
            const lines = await getOrderLines(tx, ctx.organizationId, orderId, { forUpdate: true });
            const byId = new Map(lines.map((l) => [l.id, l]));
            const settings = await getOrderSettings(tx, ctx.organizationId);
            const tolerance = decimal(settings?.quantityTolerancePct ?? '0').div(100);
            const seen = new Set<string>();
            input.lines.forEach((entry, i) => {
              const line = byId.get(entry.orderLineId);
              if (!line) {
                issues.push({
                  path: `lines.${i}.orderLineId`,
                  message: 'This is not a line of the order.',
                });
                return;
              }
              if (seen.has(entry.orderLineId)) {
                issues.push({
                  path: `lines.${i}.orderLineId`,
                  message: 'List each order line once.',
                });
              }
              seen.add(entry.orderLineId);
              const quantity = decimal(entry.quantity);
              const allowed = decimal(line.quantity).times(tolerance.plus(1));
              if (quantity.lte(0)) {
                issues.push({
                  path: `lines.${i}.quantity`,
                  message: 'The quantity must be greater than zero.',
                });
              } else if (decimal(line.receivedQuantity).plus(quantity).gt(allowed.plus(EPSILON))) {
                issues.push({
                  path: `lines.${i}.quantity`,
                  message: `Only ${Decimal.max(allowed.minus(line.receivedQuantity), 0).toFixed()} more can be received on this line.`,
                });
              }
            });
            if (!input.lines.length)
              issues.push({ path: 'lines', message: 'Add at least one line.' });
            if (issues.length) throw new ValidationError(issues);
            const now = this.now;
            const number = await this.nextNumber(tx, ctx.organizationId, 'receipt');
            const receipt = await insertReceipt(
              tx,
              {
                organizationId: ctx.organizationId,
                number,
                orderId,
                receiptDate: input.receiptDate,
                reference: input.reference?.trim() || null,
                memo: input.memo?.trim() ?? '',
                createdByUserId: ctx.userId,
                createdAt: now,
                updatedAt: now,
              },
              input.lines.map((l) => ({
                orderLineId: l.orderLineId,
                quantity: decimal(l.quantity).toFixed(6),
              })),
            );
            for (const entry of input.lines) {
              await addLineQuantity(
                tx,
                ctx.organizationId,
                entry.orderLineId,
                'receivedQuantity',
                decimal(entry.quantity).toFixed(6),
              );
            }
            await this.syncStatus(tx, ctx, order, now);
            await this.audit(
              tx,
              ctx,
              'purchase_receipt.recorded',
              receipt.id,
              now,
              origin,
              { number, orderId, lines: input.lines.length },
              RECEIPT_RESOURCE,
            );
            return this.detail(tx, ctx, orderId);
          },
        ),
    );
  }

  listReceipts(principal: Principal, orderId: string | null) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => ({
        items: (await listReceipts(tx, ctx.organizationId, orderId, 200)).map((r) =>
          this.receiptView(r),
        ),
      }),
    );
  }

  getReceipt(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const receipt = await getReceipt(tx, ctx.organizationId, id);
        if (!receipt) throw new NotFoundError('Goods receipt not found.');
        const lines = await getReceiptLines(tx, ctx.organizationId, id);
        return {
          ...this.receiptView(receipt),
          lines: lines.map((l) => ({
            lineNo: l.lineNo,
            orderLineId: l.orderLineId,
            quantity: decimal(l.quantity).toFixed(),
          })),
        };
      },
    );
  }

  voidReceipt(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.Receive },
      async (tx, ctx) => {
        const receipt = await getReceipt(tx, ctx.organizationId, id, { forUpdate: true });
        if (!receipt) throw new NotFoundError('Goods receipt not found.');
        if (receipt.version !== input.version) throw versionConflict('goods receipt');
        if (receipt.status !== 'POSTED') throw invalidState('The goods receipt is already void.');
        const order = (await getOrder(tx, ctx.organizationId, receipt.orderId, {
          forUpdate: true,
        }))!;
        if (!LIVE.includes(order.status)) {
          throw invalidState('The order is closed; its receipts can no longer change.');
        }
        const receiptLines = await getReceiptLines(tx, ctx.organizationId, id);
        const lines = await getOrderLines(tx, ctx.organizationId, order.id, { forUpdate: true });
        const byId = new Map(lines.map((l) => [l.id, l]));
        for (const entry of receiptLines) {
          const line = byId.get(entry.orderLineId)!;
          const after = decimal(line.receivedQuantity).minus(entry.quantity);
          if (decimal(line.billedQuantity).gt(after.plus(EPSILON))) {
            throw invalidState(
              `Line ${line.lineNo} has been billed beyond what remains received; void or adjust the bill first.`,
            );
          }
        }
        const now = this.now;
        const voided = await voidReceipt(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          userId: ctx.userId,
          reason: input.reason.trim(),
          at: now,
        });
        if (!voided) throw versionConflict('goods receipt');
        for (const entry of receiptLines) {
          await addLineQuantity(
            tx,
            ctx.organizationId,
            entry.orderLineId,
            'receivedQuantity',
            decimal(entry.quantity).negated().toFixed(6),
          );
        }
        await this.syncStatus(tx, ctx, order, now);
        await this.audit(
          tx,
          ctx,
          'purchase_receipt.voided',
          id,
          now,
          origin,
          { number: receipt.number, reason: input.reason.trim() },
          RECEIPT_RESOURCE,
        );
        return this.detail(tx, ctx, order.id);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Bills: draft conversion, linking and the three-way match
  // ---------------------------------------------------------------------------

  /**
   * The draft bill an order converts to: its lines at their order prices for the quantities still
   * to be billed (what was received but not billed, or all that was ordered). A document discount
   * is carried only when every line is billed in full.
   */
  async billDraft(
    principal: Principal,
    orderId: string,
    options: {
      basis: 'received' | 'ordered';
      billDate: string;
      vendorReference?: string | null | undefined;
    },
  ): Promise<BillDraftInput> {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const order = await getOrder(tx, ctx.organizationId, orderId);
        if (!order) throw new NotFoundError('Purchase order not found.');
        if (!LIVE.includes(order.status)) {
          throw invalidState('Only an approved purchase order can be billed.');
        }
        const lines = await getOrderLines(tx, ctx.organizationId, orderId);
        const drafted: PurchaseLineInput[] = [];
        let full = true;
        for (const l of lines) {
          const basis =
            options.basis === 'received' ? decimal(l.receivedQuantity) : decimal(l.quantity);
          const remaining = basis.minus(l.billedQuantity);
          if (remaining.lte(0)) {
            full = false;
            continue;
          }
          if (!remaining.eq(l.quantity)) full = false;
          drafted.push({
            itemId: l.itemId,
            description: l.description,
            quantity: remaining.toFixed(),
            unitPrice: decimal(l.unitPrice).toFixed(),
            discount: l.discountType ? { type: l.discountType, value: l.discountValue! } : null,
            taxCodeId: l.taxCodeId,
            accountId: l.accountId,
            taxRecoverable: l.taxRecoverableOverride,
            dimensionValueIds: l.dimensionValueIds,
          });
        }
        if (!drafted.length) {
          throw invalidState(
            options.basis === 'received'
              ? 'Nothing received is left to bill.'
              : 'The whole order has been billed.',
          );
        }
        return {
          vendorId: order.vendorId,
          billDate: options.billDate,
          vendorReference: options.vendorReference ?? null,
          currencyCode: order.currencyCode,
          taxTreatment: order.taxTreatment,
          discount:
            full && order.discountType
              ? { type: order.discountType, value: order.discountValue! }
              : null,
          memo: order.memo
            ? `Purchase order ${order.number}. ${order.memo}`
            : `Purchase order ${order.number}`,
          dimensionValueIds: order.dimensionValueIds,
          lines: drafted,
        };
      },
    );
  }

  /** Links a draft bill to an order of the same vendor and currency. */
  linkBill(principal: Principal, orderId: string, billId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchaseOrderPermissions.Create },
      async (tx, ctx) => {
        const order = await getOrder(tx, ctx.organizationId, orderId, { forUpdate: true });
        if (!order) throw new NotFoundError('Purchase order not found.');
        if (!LIVE.includes(order.status)) {
          throw invalidState('Only an approved purchase order can be billed.');
        }
        const bill = await getBill(tx, ctx.organizationId, billId, { forUpdate: true });
        if (!bill) throw new NotFoundError('Bill not found.');
        const issues: ValidationIssue[] = [];
        if (bill.status !== 'DRAFT')
          issues.push({ path: 'billId', message: 'Only a draft bill can be linked to an order.' });
        if (bill.vendorId !== order.vendorId)
          issues.push({ path: 'billId', message: 'The bill is for another vendor.' });
        if (bill.currencyCode !== order.currencyCode) {
          issues.push({
            path: 'billId',
            message: 'The bill is in another currency than the order.',
          });
        }
        if (await getBillLink(tx, ctx.organizationId, billId)) {
          issues.push({ path: 'billId', message: 'The bill is already linked to an order.' });
        }
        if (issues.length) throw new ValidationError(issues);
        const now = this.now;
        await insertBillLink(tx, {
          organizationId: ctx.organizationId,
          billId,
          orderId,
          linkedByUserId: ctx.userId,
          linkedAt: now,
        });
        await this.audit(tx, ctx, 'purchase_order.bill_linked', orderId, now, origin, { billId });
        return this.detail(tx, ctx, orderId);
      },
    );
  }

  async checkBill(
    tx: Transaction,
    ctx: AuthorizationContext,
    bill: { id: string },
    lines: Parameters<PurchaseOrderHooks['checkBill']>[3],
  ): Promise<BillMatchPlan | null> {
    const link = await getBillLink(tx, ctx.organizationId, bill.id);
    if (!link) return null;
    const order = await getOrder(tx, ctx.organizationId, link.orderId, { forUpdate: true });
    if (!order) return null;
    if (!LIVE.includes(order.status)) {
      throw invalidState(
        `The linked purchase order ${order.number} is ${order.status.toLowerCase().replace('_', ' ')}; a bill cannot be posted against it.`,
      );
    }
    const settings = await getOrderSettings(tx, ctx.organizationId);
    const mode = (settings?.matchMode ?? 'off') as MatchMode;
    const quantityTolerance = decimal(settings?.quantityTolerancePct ?? '0').div(100);
    const priceTolerance = decimal(settings?.priceTolerancePct ?? '0').div(100);
    const orderLines = await getOrderLines(tx, ctx.organizationId, order.id, { forUpdate: true });
    const planned = new Map<string, Decimal>();
    const issues: MatchIssue[] = [];
    const allocations: { orderLineId: string; quantity: string }[] = [];
    for (const line of lines) {
      const candidates = orderLines.filter((o) =>
        line.itemId
          ? o.itemId === line.itemId
          : o.itemId === null &&
            o.description.trim().toLowerCase() === line.description.trim().toLowerCase(),
      );
      if (!candidates.length) {
        issues.push({
          kind: 'not_on_order',
          lineNo: line.lineNo,
          message: `Line ${line.lineNo} (${line.description}) is not on purchase order ${order.number}.`,
        });
        continue;
      }
      let remaining = decimal(line.quantity);
      const billedUnit = effectiveUnit(line.amount, line.lineDiscount, line.quantity);
      candidates.forEach((candidate, index) => {
        if (remaining.lte(0)) return;
        const alreadyPlanned = planned.get(candidate.id) ?? decimal(0);
        const open = Decimal.max(
          decimal(candidate.quantity).minus(candidate.billedQuantity).minus(alreadyPlanned),
          0,
        );
        const last = index === candidates.length - 1;
        const take = last ? remaining : Decimal.min(open, remaining);
        if (take.lte(0)) return;
        remaining = remaining.minus(take);
        planned.set(candidate.id, alreadyPlanned.plus(take));
        allocations.push({ orderLineId: candidate.id, quantity: take.toFixed(6) });
        // Price: the bill's unit price against the order's, within the tolerance.
        const orderUnit = effectiveUnit(
          candidate.amount,
          candidate.lineDiscount,
          candidate.quantity,
        );
        if (orderUnit.gt(0)) {
          const difference = billedUnit.minus(orderUnit).abs().div(orderUnit);
          if (difference.gt(priceTolerance.plus(EPSILON))) {
            issues.push({
              kind: 'price',
              lineNo: line.lineNo,
              message: `Line ${line.lineNo}: the bill price ${billedUnit.toFixed(4)} differs from the order price ${orderUnit.toFixed(4)} by more than ${priceTolerance.times(100).toFixed()}%.`,
            });
          }
        } else if (billedUnit.gt(0)) {
          issues.push({
            kind: 'price',
            lineNo: line.lineNo,
            message: `Line ${line.lineNo}: the order price is zero but the bill charges ${billedUnit.toFixed(4)}.`,
          });
        }
      });
    }
    // Quantity: what is billed (with this bill) against what was received and ordered.
    for (const [lineId, add] of planned) {
      const orderLine = orderLines.find((o) => o.id === lineId)!;
      const billed = decimal(orderLine.billedQuantity).plus(add);
      const received = decimal(orderLine.receivedQuantity);
      if (billed.gt(received.times(quantityTolerance.plus(1)).plus(EPSILON))) {
        issues.push({
          kind: 'quantity',
          lineNo: orderLine.lineNo,
          message: `Order line ${orderLine.lineNo}: billed ${billed.toFixed()} but only ${received.toFixed()} received${quantityTolerance.gt(0) ? ` (tolerance ${quantityTolerance.times(100).toFixed()}%)` : ''}.`,
        });
      }
      if (billed.gt(decimal(orderLine.quantity).times(quantityTolerance.plus(1)).plus(EPSILON))) {
        issues.push({
          kind: 'quantity',
          lineNo: orderLine.lineNo,
          message: `Order line ${orderLine.lineNo}: billed ${billed.toFixed()} exceeds the ${decimal(orderLine.quantity).toFixed()} ordered.`,
        });
      }
    }
    if (mode === 'block' && issues.length) {
      throw new ValidationError(
        issues.map((i) => ({
          path: i.lineNo ? `lines.${i.lineNo - 1}` : 'lines',
          message: i.message,
        })),
        `The bill does not match purchase order ${order.number}.`,
      );
    }
    return {
      orderId: order.id,
      mode,
      status: mode !== 'off' && issues.length ? 'warning' : 'matched',
      issues: mode === 'off' ? [] : issues,
      allocations,
    };
  }

  async recordBill(
    tx: Transaction,
    ctx: AuthorizationContext,
    billId: string,
    plan: BillMatchPlan,
    origin: EventOrigin,
  ) {
    const now = this.now;
    for (const allocation of plan.allocations) {
      await insertBilling(tx, {
        organizationId: ctx.organizationId,
        billId,
        orderLineId: allocation.orderLineId,
        quantity: allocation.quantity,
      });
      await addLineQuantity(
        tx,
        ctx.organizationId,
        allocation.orderLineId,
        'billedQuantity',
        allocation.quantity,
      );
    }
    await insertBillMatch(tx, {
      organizationId: ctx.organizationId,
      billId,
      orderId: plan.orderId,
      mode: plan.mode,
      status: plan.status,
      issues: plan.issues,
      createdAt: now,
    });
    await this.audit(
      tx,
      ctx,
      plan.status === 'warning'
        ? 'purchase_order.bill_matched_with_warnings'
        : 'purchase_order.bill_matched',
      plan.orderId,
      now,
      origin,
      { billId, mode: plan.mode, issues: plan.issues },
    );
  }

  async releaseBill(
    tx: Transaction,
    ctx: AuthorizationContext,
    billId: string,
    origin: EventOrigin,
  ) {
    const billings = await listActiveBillings(tx, ctx.organizationId, billId);
    if (!billings.length) return;
    const now = this.now;
    for (const billing of billings) {
      await addLineQuantity(
        tx,
        ctx.organizationId,
        billing.orderLineId,
        'billedQuantity',
        decimal(billing.quantity).negated().toFixed(6),
      );
      await reverseBilling(tx, ctx.organizationId, billing.id, now);
    }
    const link = await getBillLink(tx, ctx.organizationId, billId);
    await this.audit(
      tx,
      ctx,
      'purchase_order.bill_released',
      link?.orderId ?? billId,
      now,
      origin,
      {
        billId,
        lines: billings.length,
      },
    );
  }
}
