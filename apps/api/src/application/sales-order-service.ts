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
import { releaseOrderReservations } from '../modules/delivery/index.js';
import {
  deleteOrder,
  getOrder,
  getOrderLines,
  insertOrder,
  insertOrderInvoiceLines,
  invoicedQuantities,
  listOrders,
  replaceOrderLines,
  SalesExtraPermissions,
  takeNextOrderNumber,
  updateOrder,
  type OrderStatus,
  type SalesOrder,
} from '../modules/sales-extras/index.js';
import { getItem, SalesPermissions } from '../modules/sales/index.js';
import { getTaxCode } from '../modules/tax/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { InvoiceService } from './invoice-service.js';
import { withOrganization } from './organization-service.js';

/**
 * Sales orders (FP-28, migration 0070). A customer's order: draft, confirmed (content frozen),
 * invoiced in whole or in parts through DRAFT invoices, or cancelled while nothing is invoiced.
 * Invoiced quantity is derived from the invoices that still exist and are not void, so a deleted
 * draft releases its quantity and an order can never be over-invoiced (the order row is locked
 * while a draft is created). Orders post nothing to the ledger.
 */

const MAX_LINES = 200;
const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The order changed; reload it and try again.');
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

export type OrderViewStatus = OrderStatus | 'PARTIALLY_INVOICED' | 'INVOICED';

export interface OrderLineInput {
  itemId?: string | null | undefined;
  description?: string | undefined;
  quantity: string;
  unitPrice: string;
  taxCodeId?: string | null | undefined;
}

export interface OrderInput {
  customerId: string;
  orderDate: string;
  expectedDate?: string | null | undefined;
  reference?: string | null | undefined;
  memo?: string | undefined;
  lines: OrderLineInput[];
}

export class SalesOrderService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly invoices: InvoiceService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private get now() {
    return this.deps.clock.now();
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
      resourceType: 'sales_order',
      resourceId: id,
      metadata,
      origin,
    });
  }

  private async view(tx: Transaction, organizationId: string, o: SalesOrder) {
    const lines = await getOrderLines(tx, organizationId, o.id);
    const invoiced = await invoicedQuantities(tx, organizationId, o.id);
    const rows = lines.map((l) => {
      const done = decimal(invoiced.get(l.lineNo) ?? 0);
      return {
        lineNo: l.lineNo,
        itemId: l.itemId,
        description: l.description,
        quantity: decimal(l.quantity).toFixed(),
        unitPrice: decimal(l.unitPrice).toFixed(),
        taxCodeId: l.taxCodeId,
        netAmount: decimal(l.netAmount).toFixed(),
        invoiced: done.toFixed(),
        remaining: decimal(l.quantity).minus(done).toFixed(),
      };
    });
    const anyInvoiced = rows.some((r) => decimal(r.invoiced).gt(0));
    const allInvoiced = rows.length > 0 && rows.every((r) => !decimal(r.remaining).gt(0));
    const status: OrderViewStatus =
      o.status === 'CONFIRMED'
        ? allInvoiced
          ? 'INVOICED'
          : anyInvoiced
            ? 'PARTIALLY_INVOICED'
            : 'CONFIRMED'
        : o.status;
    return {
      id: o.id,
      number: o.number,
      customerId: o.customerId,
      orderDate: o.orderDate,
      expectedDate: o.expectedDate,
      status,
      reference: o.reference,
      memo: o.memo,
      netTotal: decimal(o.netTotal).toFixed(),
      cancelReason: o.cancelReason,
      version: o.version,
      lines: rows,
    };
  }

  private async validate(tx: Transaction, ctx: AuthorizationContext, input: OrderInput) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const places = minorUnits(accounting.baseCurrency);
    const issues: ValidationIssue[] = [];
    if (!isValidIsoDate(input.orderDate)) {
      issues.push({ path: 'orderDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    }
    if (input.expectedDate) {
      if (!isValidIsoDate(input.expectedDate)) {
        issues.push({ path: 'expectedDate', message: 'Enter a valid date (YYYY-MM-DD).' });
      } else if (isValidIsoDate(input.orderDate) && input.expectedDate < input.orderDate) {
        issues.push({
          path: 'expectedDate',
          message: 'The expected date is before the order date.',
        });
      }
    }
    if (!(await getCustomer(tx, ctx.organizationId, input.customerId))) {
      issues.push({ path: 'customerId', message: 'Choose a customer of this organization.' });
    }
    if (!input.lines.length || input.lines.length > MAX_LINES) {
      issues.push({ path: 'lines', message: `Add between 1 and ${MAX_LINES} lines.` });
    }
    const resolved = [];
    for (const [i, line] of input.lines.entries()) {
      const item = line.itemId ? await getItem(tx, ctx.organizationId, line.itemId) : undefined;
      if (line.itemId && !item)
        issues.push({ path: `lines.${i}.itemId`, message: 'Unknown item.' });
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
    return {
      resolved,
      netTotal: resolved.reduce((s, l) => s.plus(l.netAmount), decimal(0)).toFixed(4),
    };
  }

  list(
    principal: Principal,
    filter: { status?: OrderStatus | undefined; customerId?: string | undefined; limit: number },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const rows = await listOrders(tx, ctx.organizationId, filter);
        return Promise.all(rows.map((o) => this.view(tx, ctx.organizationId, o)));
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const o = await getOrder(tx, ctx.organizationId, id);
        if (!o) throw new NotFoundError('Sales order not found.');
        return this.view(tx, ctx.organizationId, o);
      },
    );
  }

  create(
    principal: Principal,
    input: OrderInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersCreate },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'sales.order.create', request: input },
          async () => {
            const { resolved, netTotal } = await this.validate(tx, ctx, input);
            const now = this.now;
            const order = await insertOrder(tx, {
              organizationId: ctx.organizationId,
              number: await takeNextOrderNumber(tx, ctx.organizationId),
              customerId: input.customerId,
              orderDate: input.orderDate,
              expectedDate: input.expectedDate || null,
              reference: input.reference?.trim() || null,
              memo: (input.memo ?? '').trim(),
              netTotal,
              createdByUserId: ctx.userId,
              createdAt: now,
              updatedAt: now,
            });
            await replaceOrderLines(tx, ctx.organizationId, order.id, resolved);
            await this.audit(tx, ctx, 'sales_order.created', order.id, origin, {
              number: order.number,
              netTotal,
              lines: resolved.length,
            });
            return this.view(tx, ctx.organizationId, order);
          },
        ),
    );
  }

  update(
    principal: Principal,
    id: string,
    input: OrderInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersCreate },
      async (tx, ctx) => {
        const existing = await getOrder(tx, ctx.organizationId, id, { forUpdate: true });
        if (!existing) throw new NotFoundError('Sales order not found.');
        if (existing.version !== input.version) throw versionConflict();
        if (existing.status !== 'DRAFT') throw invalidState('Only a draft order can be edited.');
        const { resolved, netTotal } = await this.validate(tx, ctx, input);
        await replaceOrderLines(tx, ctx.organizationId, id, resolved);
        const updated = await updateOrder(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            customerId: input.customerId,
            orderDate: input.orderDate,
            expectedDate: input.expectedDate || null,
            reference: input.reference?.trim() || null,
            memo: (input.memo ?? '').trim(),
            netTotal,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'sales_order.updated', id, origin, { netTotal });
        return this.view(tx, ctx.organizationId, updated);
      },
    );
  }

  delete(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersCreate },
      async (tx, ctx) => {
        const existing = await getOrder(tx, ctx.organizationId, id, { forUpdate: true });
        if (!existing) throw new NotFoundError('Sales order not found.');
        if (existing.version !== input.version) throw versionConflict();
        if (existing.status !== 'DRAFT') throw invalidState('Only a draft order can be deleted.');
        await deleteOrder(tx, ctx.organizationId, id);
        await this.audit(tx, ctx, 'sales_order.deleted', id, origin, { number: existing.number });
        return { id, deleted: true as const };
      },
    );
  }

  confirm(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersCreate },
      async (tx, ctx) => {
        const o = await getOrder(tx, ctx.organizationId, id, { forUpdate: true });
        if (!o) throw new NotFoundError('Sales order not found.');
        if (o.version !== input.version) throw versionConflict();
        if (o.status !== 'DRAFT') throw invalidState('Only a draft order can be confirmed.');
        const updated = await updateOrder(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: { status: 'CONFIRMED', updatedByUserId: ctx.userId, updatedAt: this.now },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'sales_order.confirmed', id, origin, { number: o.number });
        return this.view(tx, ctx.organizationId, updated);
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
      { permission: SalesExtraPermissions.OrdersCreate },
      async (tx, ctx) => {
        const o = await getOrder(tx, ctx.organizationId, id, { forUpdate: true });
        if (!o) throw new NotFoundError('Sales order not found.');
        if (o.version !== input.version) throw versionConflict();
        if (o.status === 'CANCELLED') throw invalidState('The order is already cancelled.');
        const reason = input.reason.trim();
        if (!reason) throw new ValidationError([{ path: 'reason', message: 'Give a reason.' }]);
        const invoiced = await invoicedQuantities(tx, ctx.organizationId, id);
        if ([...invoiced.values()].some((q) => decimal(q).gt(0))) {
          throw invalidState('An order with invoiced quantities cannot be cancelled.');
        }
        const updated = await updateOrder(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'CANCELLED',
            cancelReason: reason,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict();
        await releaseOrderReservations(tx, {
          organizationId: ctx.organizationId,
          orderId: id,
          userId: ctx.userId,
          reason: 'Order cancelled',
          at: this.now,
        });
        await this.audit(tx, ctx, 'sales_order.cancelled', id, origin, {
          number: o.number,
          reason,
        });
        return this.view(tx, ctx.organizationId, updated);
      },
    );
  }

  /**
   * Creates ONE draft invoice for the requested quantities (default: everything still open).
   * Needs `sales_orders.invoice` and `invoices.create`. A quantity can never exceed what remains.
   */
  invoice(
    principal: Principal,
    id: string,
    input: {
      version: number;
      invoiceDate?: string | undefined;
      lines?: { lineNo: number; quantity: string }[] | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersInvoice },
      async (tx, ctx) => {
        if (!hasPermission(ctx, SalesPermissions.InvoicesCreate)) throw new PermissionDeniedError();
        const o = await getOrder(tx, ctx.organizationId, id, { forUpdate: true });
        if (!o) throw new NotFoundError('Sales order not found.');
        if (o.version !== input.version) throw versionConflict();
        if (o.status !== 'CONFIRMED') throw invalidState('Only a confirmed order can be invoiced.');
        const invoiceDate = input.invoiceDate ?? this.now.toISOString().slice(0, 10);
        if (!isValidIsoDate(invoiceDate)) {
          throw new ValidationError([
            { path: 'invoiceDate', message: 'Enter a valid date (YYYY-MM-DD).' },
          ]);
        }
        const lines = await getOrderLines(tx, ctx.organizationId, id);
        const invoiced = await invoicedQuantities(tx, ctx.organizationId, id);
        const remaining = new Map(
          lines.map((l) => [l.lineNo, decimal(l.quantity).minus(invoiced.get(l.lineNo) ?? 0)]),
        );
        const wanted = new Map<number, ReturnType<typeof decimal>>();
        const issues: ValidationIssue[] = [];
        if (input.lines) {
          for (const [i, entry] of input.lines.entries()) {
            const left = remaining.get(entry.lineNo);
            const quantity = decimal(entry.quantity);
            if (left === undefined) {
              issues.push({ path: `lines.${i}.lineNo`, message: 'This order has no such line.' });
            } else if (wanted.has(entry.lineNo)) {
              issues.push({ path: `lines.${i}.lineNo`, message: 'List each line once.' });
            } else if (!quantity.gt(0)) {
              issues.push({ path: `lines.${i}.quantity`, message: 'Enter a quantity above zero.' });
            } else if (quantity.gt(left)) {
              issues.push({
                path: `lines.${i}.quantity`,
                message: `Only ${left.toFixed()} of this line is still open.`,
              });
            } else {
              wanted.set(entry.lineNo, quantity);
            }
          }
        } else {
          for (const [lineNo, left] of remaining) if (left.gt(0)) wanted.set(lineNo, left);
        }
        if (!issues.length && wanted.size === 0) {
          issues.push({
            path: 'lines',
            message: 'There is nothing left to invoice on this order.',
          });
        }
        if (issues.length) throw new ValidationError(issues);
        const chosen = lines.filter((l) => wanted.has(l.lineNo));
        const invoice = await this.invoices.createDraftInTransaction(
          tx,
          ctx,
          {
            customerId: o.customerId,
            invoiceDate,
            reference: o.number,
            memo: o.memo,
            lines: chosen.map((l) => ({
              ...(l.itemId ? { itemId: l.itemId } : {}),
              description: l.description,
              quantity: wanted.get(l.lineNo)!.toFixed(),
              unitPrice: decimal(l.unitPrice).toFixed(),
              ...(l.taxCodeId ? { taxCodeId: l.taxCodeId } : {}),
            })),
          },
          origin,
        );
        await insertOrderInvoiceLines(
          tx,
          chosen.map((l) => ({
            organizationId: ctx.organizationId,
            orderId: id,
            lineNo: l.lineNo,
            invoiceId: invoice.id,
            quantity: wanted.get(l.lineNo)!.toFixed(6),
            createdAt: this.now,
          })),
        );
        await this.audit(tx, ctx, 'sales_order.invoiced', id, origin, {
          number: o.number,
          invoiceId: invoice.id,
          lines: chosen.length,
        });
        return { order: await this.view(tx, ctx.organizationId, o), invoiceId: invoice.id };
      },
    );
  }
}
