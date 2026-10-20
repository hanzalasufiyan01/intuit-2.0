import { Decimal } from 'decimal.js';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { isValidIsoDate } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  deleteDeliveryNote,
  deliveredQuantities,
  getDeliveryLines,
  getDeliveryNote,
  getReservation,
  insertDeliveryNote,
  insertReservation,
  listDeliveryNotes,
  listReservations,
  releaseReservation,
  replaceDeliveryLines,
  takeNextDeliveryNumber,
  updateDeliveryNote,
  type DeliveryNoteRow,
} from '../modules/delivery/index.js';
import { getBalance, InventoryPermissions } from '../modules/inventory/index.js';
import {
  getOrder,
  getOrderLines,
  invoicedQuantities,
  SalesExtraPermissions,
} from '../modules/sales-extras/index.js';
import { getItem } from '../modules/sales/index.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Delivery notes and stock reservations (migration 0091; reversible defaults, ADR 0015).
 *
 * A delivery note records what was delivered against a CONFIRMED sales order, never more than the
 * order still has open; it moves no stock and posts nothing (stock and cost of sales still move at
 * invoice issue, ADR 0014). A reservation is an ADVISORY hold: it lowers "available to promise"
 * but never blocks a sale or a transfer. An order reservation shrinks by what the order has
 * invoiced, and ends when the order is cancelled.
 */

const MAX_LINES = 200;
const QUANTITY = /^(0|[1-9]\d{0,21})(\.\d{1,6})?$/;
const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The record changed; reload it and try again.');
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

export interface DeliveryLineInput {
  orderLineNo: number;
  quantity: string;
}

export class DeliveryService {
  constructor(private readonly deps: AppDependencies) {}

  private get now() {
    return this.deps.clock.now();
  }

  private audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown> = {},
  ) {
    return recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'delivery_note',
      resourceId,
      metadata,
      origin,
    });
  }

  private async view(tx: Transaction, organizationId: string, note: DeliveryNoteRow) {
    const lines = await getDeliveryLines(tx, organizationId, note.id);
    const orderLines = await getOrderLines(tx, organizationId, note.orderId);
    const order = await getOrder(tx, organizationId, note.orderId);
    return {
      ...note,
      orderNumber: order?.number ?? null,
      lines: lines.map((l) => {
        const ol = orderLines.find((x) => x.lineNo === l.orderLineNo);
        return {
          lineNo: l.lineNo,
          orderLineNo: l.orderLineNo,
          itemId: ol?.itemId ?? null,
          description: ol?.description ?? null,
          quantity: decimal(l.quantity).toFixed(),
        };
      }),
    };
  }

  /** Validates lines against the order: known line, positive quantity, within what was ordered. */
  private async checkLines(
    tx: Transaction,
    ctx: AuthorizationContext,
    orderId: string,
    lines: DeliveryLineInput[],
  ) {
    const issues: ValidationIssue[] = [];
    if (lines.length < 1 || lines.length > MAX_LINES) {
      issues.push({ path: 'lines', message: 'Add 1 to 200 lines.' });
    }
    const orderLines = await getOrderLines(tx, ctx.organizationId, orderId);
    const seen = new Set<number>();
    lines.forEach((l, i) => {
      const ol = orderLines.find((x) => x.lineNo === l.orderLineNo);
      if (!ol)
        issues.push({ path: `lines.${i}.orderLineNo`, message: 'This line is not on the order.' });
      if (seen.has(l.orderLineNo))
        issues.push({ path: `lines.${i}.orderLineNo`, message: 'List each order line once.' });
      seen.add(l.orderLineNo);
      if (!QUANTITY.test(l.quantity) || !decimal(l.quantity).gt(0)) {
        issues.push({ path: `lines.${i}.quantity`, message: 'Enter a quantity above zero.' });
      } else if (ol && decimal(l.quantity).gt(ol.quantity)) {
        issues.push({ path: `lines.${i}.quantity`, message: 'More than the order quantity.' });
      }
    });
    if (issues.length) throw new ValidationError(issues);
  }

  list(principal: Principal, filter: { orderId?: string | undefined; limit: number }) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersView, readOnlySnapshot: true },
      async (tx, ctx) => listDeliveryNotes(tx, ctx.organizationId, filter),
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const note = await getDeliveryNote(tx, ctx.organizationId, id);
        if (!note) throw new NotFoundError('Delivery note not found.');
        return this.view(tx, ctx.organizationId, note);
      },
    );
  }

  /** Per order line: ordered, delivered (delivered notes), invoiced, and what remains to deliver. */
  fulfilment(principal: Principal, orderId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const order = await getOrder(tx, ctx.organizationId, orderId);
        if (!order) throw new NotFoundError('Sales order not found.');
        const [lines, delivered, invoiced] = await Promise.all([
          getOrderLines(tx, ctx.organizationId, orderId),
          deliveredQuantities(tx, ctx.organizationId, orderId),
          invoicedQuantities(tx, ctx.organizationId, orderId),
        ]);
        return {
          orderId,
          number: order.number,
          status: order.status,
          lines: lines.map((l) => {
            const d = decimal(delivered.get(l.lineNo) ?? 0);
            return {
              lineNo: l.lineNo,
              itemId: l.itemId,
              description: l.description,
              ordered: decimal(l.quantity).toFixed(),
              delivered: d.toFixed(),
              invoiced: decimal(invoiced.get(l.lineNo) ?? 0).toFixed(),
              remaining: decimal(l.quantity).minus(d).toFixed(),
            };
          }),
        };
      },
    );
  }

  create(
    principal: Principal,
    input: {
      orderId: string;
      deliveryDate: string;
      memo?: string | undefined;
      lines: DeliveryLineInput[];
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersCreate },
      async (tx, ctx) => {
        if (!isValidIsoDate(input.deliveryDate)) {
          throw new ValidationError([
            { path: 'deliveryDate', message: 'Enter a valid date (YYYY-MM-DD).' },
          ]);
        }
        const order = await getOrder(tx, ctx.organizationId, input.orderId, { forUpdate: true });
        if (!order) throw new NotFoundError('Sales order not found.');
        if (order.status !== 'CONFIRMED') {
          throw invalidState('Deliveries are recorded against a confirmed sales order.');
        }
        await this.checkLines(tx, ctx, input.orderId, input.lines);
        const note = await insertDeliveryNote(tx, {
          organizationId: ctx.organizationId,
          number: await takeNextDeliveryNumber(tx, ctx.organizationId),
          orderId: input.orderId,
          deliveryDate: input.deliveryDate,
          memo: (input.memo ?? '').trim(),
          userId: ctx.userId,
          at: this.now,
        });
        await replaceDeliveryLines(tx, {
          organizationId: ctx.organizationId,
          noteId: note.id,
          orderId: input.orderId,
          lines: input.lines.map((l) => ({
            orderLineNo: l.orderLineNo,
            quantity: decimal(l.quantity).toFixed(6),
          })),
        });
        await this.audit(tx, ctx, 'delivery_note.created', note.id, origin, {
          number: note.number,
          orderNumber: order.number,
        });
        return this.view(tx, ctx.organizationId, note);
      },
    );
  }

  update(
    principal: Principal,
    id: string,
    input: {
      version: number;
      deliveryDate: string;
      memo?: string | undefined;
      lines: DeliveryLineInput[];
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersCreate },
      async (tx, ctx) => {
        const note = await getDeliveryNote(tx, ctx.organizationId, id, { forUpdate: true });
        if (!note) throw new NotFoundError('Delivery note not found.');
        if (note.version !== input.version) throw versionConflict();
        if (note.status !== 'DRAFT')
          throw invalidState('Only a draft delivery note can be edited.');
        if (!isValidIsoDate(input.deliveryDate)) {
          throw new ValidationError([
            { path: 'deliveryDate', message: 'Enter a valid date (YYYY-MM-DD).' },
          ]);
        }
        await this.checkLines(tx, ctx, note.orderId, input.lines);
        await replaceDeliveryLines(tx, {
          organizationId: ctx.organizationId,
          noteId: id,
          orderId: note.orderId,
          lines: input.lines.map((l) => ({
            orderLineNo: l.orderLineNo,
            quantity: decimal(l.quantity).toFixed(6),
          })),
        });
        const updated = await updateDeliveryNote(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: { deliveryDate: input.deliveryDate, memo: (input.memo ?? '').trim() },
          userId: ctx.userId,
          at: this.now,
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'delivery_note.updated', id, origin, { number: note.number });
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
        const note = await getDeliveryNote(tx, ctx.organizationId, id, { forUpdate: true });
        if (!note) throw new NotFoundError('Delivery note not found.');
        if (note.version !== input.version) throw versionConflict();
        if (note.status !== 'DRAFT')
          throw invalidState('Only a draft delivery note can be deleted.');
        await deleteDeliveryNote(tx, ctx.organizationId, id);
        await this.audit(tx, ctx, 'delivery_note.deleted', id, origin, { number: note.number });
        return { id, deleted: true as const };
      },
    );
  }

  /**
   * Marks the note delivered. The order is locked, and each line is checked against what was
   * ordered less what other delivered notes already carry, so a line can never be over-delivered
   * even when two notes are delivered at once.
   */
  deliver(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersCreate },
      async (tx, ctx) => {
        const peek = await getDeliveryNote(tx, ctx.organizationId, id);
        if (!peek) throw new NotFoundError('Delivery note not found.');
        const order = await getOrder(tx, ctx.organizationId, peek.orderId, { forUpdate: true });
        const note = await getDeliveryNote(tx, ctx.organizationId, id, { forUpdate: true });
        if (!note || !order) throw new NotFoundError('Delivery note not found.');
        if (note.version !== input.version) throw versionConflict();
        if (note.status !== 'DRAFT')
          throw invalidState('Only a draft delivery note can be delivered.');
        if (order.status !== 'CONFIRMED') {
          throw invalidState('The sales order is no longer confirmed.');
        }
        const [lines, orderLines, delivered] = await Promise.all([
          getDeliveryLines(tx, ctx.organizationId, id),
          getOrderLines(tx, ctx.organizationId, note.orderId),
          deliveredQuantities(tx, ctx.organizationId, note.orderId),
        ]);
        const issues: ValidationIssue[] = [];
        lines.forEach((l, i) => {
          const ol = orderLines.find((x) => x.lineNo === l.orderLineNo);
          const open = decimal(ol?.quantity ?? 0).minus(delivered.get(l.orderLineNo) ?? 0);
          if (decimal(l.quantity).gt(open)) {
            issues.push({
              path: `lines.${i}.quantity`,
              message: `Only ${open.toFixed()} of this order line is still to be delivered.`,
            });
          }
        });
        if (issues.length) throw new ValidationError(issues);
        const updated = await updateDeliveryNote(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: { status: 'DELIVERED', deliveredBy: ctx.userId },
          userId: ctx.userId,
          at: this.now,
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'delivery_note.delivered', id, origin, {
          number: note.number,
          orderNumber: order.number,
        });
        return this.view(tx, ctx.organizationId, updated);
      },
    );
  }

  void(
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
        const note = await getDeliveryNote(tx, ctx.organizationId, id, { forUpdate: true });
        if (!note) throw new NotFoundError('Delivery note not found.');
        if (note.version !== input.version) throw versionConflict();
        if (note.status !== 'DELIVERED') {
          throw invalidState(
            note.status === 'VOID'
              ? 'The delivery note is already void.'
              : 'Delete a draft instead of voiding it.',
          );
        }
        const reason = input.reason.trim();
        if (!reason) throw new ValidationError([{ path: 'reason', message: 'Give a reason.' }]);
        const updated = await updateDeliveryNote(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: { status: 'VOID', reason, voidedBy: ctx.userId },
          userId: ctx.userId,
          at: this.now,
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'delivery_note.voided', id, origin, {
          number: note.number,
          reason,
        });
        return this.view(tx, ctx.organizationId, updated);
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

const reservationView = <T extends { quantity: string }>(r: T): T => ({
  ...r,
  quantity: decimal(r.quantity).toFixed(),
});

export class ReservationService {
  constructor(private readonly deps: AppDependencies) {}

  private get now() {
    return this.deps.clock.now();
  }

  private audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown> = {},
  ) {
    return recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'stock_reservation',
      resourceId,
      metadata,
      origin,
    });
  }

  /** What active reservations of an item currently hold (order reservations shrink as invoiced). */
  private reservedQuantity(tx: Transaction, organizationId: string, itemId: string) {
    return reservedQuantityOf(tx, organizationId, itemId, this.now.toISOString().slice(0, 10));
  }

  availability(principal: Principal, itemId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const balance = await getBalance(tx, ctx.organizationId, itemId);
        if (!balance) throw new NotFoundError('Tracked item not found.');
        const onHand = decimal(balance.quantity);
        const reserved = await this.reservedQuantity(tx, ctx.organizationId, itemId);
        return {
          itemId,
          onHand: onHand.toFixed(),
          reserved: reserved.toFixed(),
          available: onHand.minus(reserved).toFixed(),
          note: 'Reservations are advisory: they lower the available quantity but never block a sale or a transfer.',
        };
      },
    );
  }

  list(
    principal: Principal,
    filter: {
      itemId?: string | undefined;
      status?: 'ACTIVE' | 'RELEASED' | undefined;
      orderId?: string | undefined;
      limit: number;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) =>
        (await listReservations(tx, ctx.organizationId, filter)).map(reservationView),
    );
  }

  createManual(
    principal: Principal,
    input: {
      itemId: string;
      quantity: string;
      note?: string | undefined;
      expiresOn?: string | null | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.AdjustmentsCreate },
      async (tx, ctx) => {
        const issues: ValidationIssue[] = [];
        if (!QUANTITY.test(input.quantity) || !decimal(input.quantity).gt(0)) {
          issues.push({ path: 'quantity', message: 'Enter a quantity above zero.' });
        }
        if (input.expiresOn && !isValidIsoDate(input.expiresOn)) {
          issues.push({ path: 'expiresOn', message: 'Enter a valid date (YYYY-MM-DD).' });
        }
        if (
          !(await getItem(tx, ctx.organizationId, input.itemId)) ||
          !(await getBalance(tx, ctx.organizationId, input.itemId))
        ) {
          issues.push({ path: 'itemId', message: 'Choose an item tracked in stock.' });
        }
        if (issues.length) throw new ValidationError(issues);
        const row = await insertReservation(tx, {
          organizationId: ctx.organizationId,
          itemId: input.itemId,
          quantity: decimal(input.quantity).toFixed(6),
          source: 'manual',
          orderId: null,
          note: (input.note ?? '').trim(),
          expiresOn: input.expiresOn ?? null,
          userId: ctx.userId,
          at: this.now,
        });
        await this.audit(tx, ctx, 'stock_reservation.created', row.id, origin, {
          itemId: row.itemId,
          source: 'manual',
        });
        return reservationView(row);
      },
    );
  }

  /** Reserves what a CONFIRMED order still needs of its tracked items (not already reserved). */
  reserveOrder(principal: Principal, orderId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: SalesExtraPermissions.OrdersCreate },
      async (tx, ctx) => {
        const order = await getOrder(tx, ctx.organizationId, orderId, { forUpdate: true });
        if (!order) throw new NotFoundError('Sales order not found.');
        if (order.status !== 'CONFIRMED')
          throw invalidState('Only a confirmed order can reserve stock.');
        const [lines, invoiced, existing] = await Promise.all([
          getOrderLines(tx, ctx.organizationId, orderId),
          invoicedQuantities(tx, ctx.organizationId, orderId),
          listReservations(tx, ctx.organizationId, { orderId, status: 'ACTIVE', limit: 1000 }),
        ]);
        const need = new Map<string, ReturnType<typeof decimal>>();
        for (const l of lines) {
          if (!l.itemId) continue;
          const open = decimal(l.quantity).minus(invoiced.get(l.lineNo) ?? 0);
          if (open.gt(0)) need.set(l.itemId, (need.get(l.itemId) ?? decimal(0)).plus(open));
        }
        const created = [];
        for (const [itemId, wanted] of need) {
          if (!(await getBalance(tx, ctx.organizationId, itemId))) continue;
          const held = existing
            .filter((r) => r.itemId === itemId)
            .reduce((acc, r) => acc.plus(r.quantity), decimal(0));
          const add = wanted.minus(held);
          if (!add.gt(0)) continue;
          created.push(
            await insertReservation(tx, {
              organizationId: ctx.organizationId,
              itemId,
              quantity: add.toFixed(6),
              source: 'sales_order',
              orderId,
              note: order.number,
              expiresOn: null,
              userId: ctx.userId,
              at: this.now,
            }),
          );
        }
        for (const r of created) {
          await this.audit(tx, ctx, 'stock_reservation.created', r.id, origin, {
            itemId: r.itemId,
            source: 'sales_order',
            orderNumber: order.number,
          });
        }
        return created.map(reservationView);
      },
    );
  }

  release(
    principal: Principal,
    id: string,
    input: { reason?: string | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const row = await getReservation(tx, ctx.organizationId, id);
      if (!row) throw new NotFoundError('Reservation not found.');
      const allowed =
        row.source === 'sales_order'
          ? hasPermission(ctx, SalesExtraPermissions.OrdersCreate) ||
            hasPermission(ctx, InventoryPermissions.AdjustmentsCreate)
          : hasPermission(ctx, InventoryPermissions.AdjustmentsCreate);
      if (!allowed) throw new PermissionDeniedError();
      if (row.status !== 'ACTIVE') throw invalidState('The reservation is already released.');
      await releaseReservation(tx, {
        organizationId: ctx.organizationId,
        id,
        userId: ctx.userId,
        reason: (input.reason ?? 'Released').trim().slice(0, 200),
        at: this.now,
      });
      await this.audit(tx, ctx, 'stock_reservation.released', id, origin, { itemId: row.itemId });
      return { id, status: 'RELEASED' as const };
    });
  }
}

/**
 * What the active reservations of an item hold on `today`: expired reservations hold nothing and a
 * sales-order reservation shrinks as the order is invoiced. Shared by the availability screen and
 * the purchase suggestions, so both always show the same number.
 */
export async function reservedQuantityOf(
  tx: Transaction,
  organizationId: string,
  itemId: string,
  today: string,
) {
  const active = await listReservations(tx, organizationId, {
    itemId,
    status: 'ACTIVE',
    limit: 1000,
  });
  let total = decimal(0);
  const invoicedByOrder = new Map<string, Map<number, string>>();
  const linesByOrder = new Map<string, { lineNo: number; itemId: string | null }[]>();
  for (const r of active) {
    if (r.expiresOn !== null && r.expiresOn < today) continue;
    let held = decimal(r.quantity);
    if (r.source === 'sales_order' && r.orderId) {
      if (!invoicedByOrder.has(r.orderId)) {
        invoicedByOrder.set(r.orderId, await invoicedQuantities(tx, organizationId, r.orderId));
        linesByOrder.set(r.orderId, await getOrderLines(tx, organizationId, r.orderId));
      }
      const invoiced = invoicedByOrder.get(r.orderId)!;
      const sum = (linesByOrder.get(r.orderId) ?? [])
        .filter((l) => l.itemId === itemId)
        .reduce((acc, l) => acc.plus(invoiced.get(l.lineNo) ?? 0), decimal(0));
      held = Decimal.max(0, held.minus(sum));
    }
    total = total.plus(held);
  }
  return total;
}
