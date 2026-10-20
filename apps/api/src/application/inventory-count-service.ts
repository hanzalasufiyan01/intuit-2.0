import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { isValidIsoDate } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  getCount,
  ensureDefaultWarehouse,
  getCountLines,
  getWarehouse,
  levelsOfWarehouse,
  insertCount,
  insertCountLines,
  InventoryPermissions,
  listCounts,
  listTrackedItems,
  setCountedQuantity,
  takeNextCountNumber,
  updateCount,
  type StockCount,
} from '../modules/inventory/index.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { InventoryService } from './inventory-service.js';
import { withOrganization } from './organization-service.js';

/**
 * Physical stock counts (FP-29 A5, migration 0071). A count starts from the tracked items and
 * their system quantities; people enter what they counted; posting turns every counted difference
 * into ONE stock adjustment through the existing adjustment flow (journal, movements, audit),
 * measured against the quantity on hand at posting. Uncounted lines are left alone. A posted or
 * cancelled count is final; an unwanted adjustment is voided as an adjustment.
 */

const MAX_ITEMS = 2000;
const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The count changed; reload it and try again.');
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

export class InventoryCountService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly inventory: InventoryService,
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
      resourceType: 'inventory_count',
      resourceId: id,
      metadata,
      origin,
    });
  }

  private async view(tx: Transaction, organizationId: string, c: StockCount) {
    const [lines, tracked] = await Promise.all([
      getCountLines(tx, organizationId, c.id),
      listTrackedItems(tx, organizationId),
    ]);
    const byItem = new Map(tracked.map((t) => [t.itemId, t]));
    return {
      id: c.id,
      number: c.number,
      countDate: c.countDate,
      status: c.status,
      memo: c.memo,
      adjustmentId: c.adjustmentId,
      warehouseId: c.warehouseId,
      cancelReason: c.cancelReason,
      version: c.version,
      lines: lines.map((l) => {
        const expected = decimal(l.expectedQuantity);
        const counted = l.countedQuantity === null ? null : decimal(l.countedQuantity);
        return {
          itemId: l.itemId,
          name: byItem.get(l.itemId)?.name ?? null,
          sku: byItem.get(l.itemId)?.sku ?? null,
          expectedQuantity: expected.toFixed(),
          countedQuantity: counted?.toFixed() ?? null,
          difference: counted ? counted.minus(expected).toFixed() : null,
        };
      }),
    };
  }

  list(principal: Principal, limit: number) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.CountsManage, readOnlySnapshot: true },
      async (tx, ctx) =>
        Promise.all(
          (await listCounts(tx, ctx.organizationId, limit)).map((c) =>
            this.view(tx, ctx.organizationId, c),
          ),
        ),
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.CountsManage, readOnlySnapshot: true },
      async (tx, ctx) => {
        const c = await getCount(tx, ctx.organizationId, id);
        if (!c) throw new NotFoundError('Stock count not found.');
        return this.view(tx, ctx.organizationId, c);
      },
    );
  }

  /** Starts a count of all tracked items, or of the chosen ones. */
  start(
    principal: Principal,
    input: {
      countDate: string;
      memo?: string | undefined;
      itemIds?: string[] | undefined;
      warehouseId?: string | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.CountsManage },
      async (tx, ctx) => {
        if (!isValidIsoDate(input.countDate)) {
          throw new ValidationError([
            { path: 'countDate', message: 'Enter a valid date (YYYY-MM-DD).' },
          ]);
        }
        // A count is of one warehouse (ADR 0014): the default one unless another is named.
        const warehouse = input.warehouseId
          ? await getWarehouse(tx, ctx.organizationId, input.warehouseId)
          : await ensureDefaultWarehouse(tx, ctx.organizationId, this.now);
        if (!warehouse || warehouse.status !== 'ACTIVE') {
          throw new ValidationError([
            { path: 'warehouseId', message: 'Choose an active warehouse.' },
          ]);
        }
        const inWarehouse = new Map(
          (await levelsOfWarehouse(tx, ctx.organizationId, warehouse.id)).map((l) => [
            l.itemId,
            decimal(l.quantity),
          ]),
        );
        // Items tracked by lot or serial number are not counted here: their differences name lots,
        // so they are adjusted with a stock adjustment (ADR 0014).
        const tracked = (await listTrackedItems(tx, ctx.organizationId))
          .filter((t) => t.trackingMode === 'none')
          .map((t) => ({
            ...t,
            quantity: (inWarehouse.get(t.itemId) ?? decimal(0)).toFixed(6),
          }));
        const wanted = input.itemIds ? new Set(input.itemIds) : null;
        const chosen = tracked.filter((t) => (wanted ? wanted.has(t.itemId) : true));
        if (wanted && chosen.length !== wanted.size) {
          throw new ValidationError([
            {
              path: 'itemIds',
              message:
                'Choose only items tracked in stock without lot or serial numbers (adjust those with a stock adjustment).',
            },
          ]);
        }
        if (!chosen.length) {
          throw new ValidationError([
            { path: 'itemIds', message: 'There are no tracked items to count.' },
          ]);
        }
        if (chosen.length > MAX_ITEMS) {
          throw new ValidationError([
            { path: 'itemIds', message: `Count at most ${MAX_ITEMS} items at once.` },
          ]);
        }
        const now = this.now;
        const count = await insertCount(tx, {
          organizationId: ctx.organizationId,
          number: await takeNextCountNumber(tx, ctx.organizationId),
          countDate: input.countDate,
          memo: (input.memo ?? '').trim(),
          warehouseId: warehouse.id,
          createdByUserId: ctx.userId,
          createdAt: now,
          updatedAt: now,
        });
        await insertCountLines(
          tx,
          chosen.map((t) => ({
            organizationId: ctx.organizationId,
            countId: count.id,
            itemId: t.itemId,
            expectedQuantity: decimal(t.quantity).toFixed(6),
          })),
        );
        await this.audit(tx, ctx, 'inventory_count.started', count.id, origin, {
          number: count.number,
          items: chosen.length,
        });
        return this.view(tx, ctx.organizationId, count);
      },
    );
  }

  /** Records counted quantities (null clears one). Only a draft count changes. */
  enter(
    principal: Principal,
    id: string,
    input: { lines: { itemId: string; countedQuantity: string | null }[] },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.CountsManage },
      async (tx, ctx) => {
        const c = await getCount(tx, ctx.organizationId, id, { forUpdate: true });
        if (!c) throw new NotFoundError('Stock count not found.');
        if (c.status !== 'DRAFT') throw invalidState('Only a draft count can be changed.');
        const issues = [];
        for (const [i, line] of input.lines.entries()) {
          if (line.countedQuantity !== null && decimal(line.countedQuantity).lt(0)) {
            issues.push({ path: `lines.${i}.countedQuantity`, message: 'Enter zero or more.' });
            continue;
          }
          const stored = await setCountedQuantity(
            tx,
            ctx.organizationId,
            id,
            line.itemId,
            line.countedQuantity === null ? null : decimal(line.countedQuantity).toFixed(6),
          );
          if (!stored)
            issues.push({
              path: `lines.${i}.itemId`,
              message: 'This item is not part of the count.',
            });
        }
        if (issues.length) throw new ValidationError(issues);
        await this.audit(tx, ctx, 'inventory_count.entered', id, origin, {
          lines: input.lines.length,
        });
        return this.view(tx, ctx.organizationId, c);
      },
    );
  }

  /**
   * Posts the count: every counted line whose quantity differs from the quantity on hand now
   * becomes a line of one stock adjustment. Needs `inventory.counts.manage` and
   * `inventory.adjustments.create`. A count with no difference posts without an adjustment.
   */
  post(
    principal: Principal,
    id: string,
    input: { version: number; unitCosts?: Record<string, string> | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.CountsManage },
      async (tx, ctx) => {
        if (!hasPermission(ctx, InventoryPermissions.AdjustmentsCreate))
          throw new PermissionDeniedError();
        const c = await getCount(tx, ctx.organizationId, id, { forUpdate: true });
        if (!c) throw new NotFoundError('Stock count not found.');
        if (c.version !== input.version) throw versionConflict();
        if (c.status !== 'DRAFT') throw invalidState('Only a draft count can be posted.');
        const lines = await getCountLines(tx, ctx.organizationId, id);
        const countWarehouseId =
          c.warehouseId ?? (await ensureDefaultWarehouse(tx, ctx.organizationId, this.now)).id;
        const inWarehouse = new Map(
          (await levelsOfWarehouse(tx, ctx.organizationId, countWarehouseId)).map((l) => [
            l.itemId,
            decimal(l.quantity),
          ]),
        );
        const tracked = new Map(
          (await listTrackedItems(tx, ctx.organizationId)).map((t) => [
            t.itemId,
            { ...t, quantity: (inWarehouse.get(t.itemId) ?? decimal(0)).toFixed(6) },
          ]),
        );
        const changes = [];
        for (const line of lines) {
          if (line.countedQuantity === null) continue;
          const current = tracked.get(line.itemId);
          if (!current) continue;
          const change = decimal(line.countedQuantity).minus(current.quantity);
          if (change.isZero()) continue;
          const cost = input.unitCosts?.[line.itemId];
          changes.push({
            itemId: line.itemId,
            quantityChange: change.toFixed(),
            ...(change.gt(0) && cost ? { unitCost: cost } : {}),
          });
        }
        let adjustmentId: string | null = null;
        if (changes.length) {
          const adjustment = await this.inventory.postAdjustmentInTransaction(
            tx,
            ctx,
            {
              adjustmentDate: c.countDate,
              reason: `Stock count ${c.number}`,
              memo: c.memo,
              warehouseId: countWarehouseId,
              lines: changes,
            },
            origin,
          );
          adjustmentId = adjustment.id;
        }
        const now = this.now;
        const updated = await updateCount(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'POSTED',
            adjustmentId,
            postedAt: now,
            postedByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'inventory_count.posted', id, origin, {
          number: c.number,
          adjustmentId,
          differences: changes.length,
        });
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
      { permission: InventoryPermissions.CountsManage },
      async (tx, ctx) => {
        const c = await getCount(tx, ctx.organizationId, id, { forUpdate: true });
        if (!c) throw new NotFoundError('Stock count not found.');
        if (c.version !== input.version) throw versionConflict();
        if (c.status !== 'DRAFT') throw invalidState('Only a draft count can be cancelled.');
        const reason = input.reason.trim();
        if (!reason) throw new ValidationError([{ path: 'reason', message: 'Give a reason.' }]);
        const updated = await updateCount(tx, {
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
        await this.audit(tx, ctx, 'inventory_count.cancelled', id, origin, {
          number: c.number,
          reason,
        });
        return this.view(tx, ctx.organizationId, updated);
      },
    );
  }
}
