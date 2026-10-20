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
import { getItem } from '../modules/catalog/index.js';
import { getInvoice, SalesPermissions } from '../modules/sales/index.js';
import { BillPermissions, VendorCreditPermissions } from '../modules/purchases/index.js';
import { getBill, getVendorCredit } from '../modules/purchases/index.js';
import {
  clearDocumentLocation,
  ensureDefaultWarehouse,
  entriesOfTransfer,
  getDocumentLocation,
  getBalance,
  getTrackedItems,
  getTransfer,
  getTransferLines,
  getWarehouse,
  insertStockEntries,
  insertTransfer,
  insertTransferLines,
  insertWarehouse,
  InventoryPermissions,
  levelsOfItems,
  levelsOfWarehouse,
  listTrackedItems,
  listTransfers,
  listWarehouses,
  lockBalances,
  markTransferVoid,
  setDocumentLocation,
  takeNextTransferNumber,
  updateWarehouse,
  warehouseCodeExists,
  type DocumentLocationType,
  type Transfer,
  type Warehouse,
} from '../modules/inventory/index.js';
import { hasPermission, type Principal } from './authorization.js';
import { StockPlacer, type EntryPlan } from './inventory-placement.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import { withOrganization } from './organization-service.js';

/**
 * Warehouses and transfers (FP-29 A3/A4, migration 0078, ADR 0014). Costing stays one weighted
 * average per item: a warehouse holds quantities, a transfer moves quantity between two warehouses
 * with no journal and no value movement. The database refuses to commit if the warehouse levels of
 * an item stop adding up to its balance.
 */

const MAX_TRANSFER_LINES = 200;
const QUANTITY = /^(0|[1-9]\d{0,21})(\.\d{1,6})?$/;
const versionConflict = (what: string) =>
  new ConflictError('VERSION_CONFLICT', `The ${what} changed; reload it and try again.`);
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

export interface TransferInput {
  transferDate: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  memo?: string | undefined;
  lines: {
    itemId: string;
    quantity: string;
    /** Lots to move (lot- and serial-tracked items); first-expired-first-out when omitted. */
    lots?: { lotCode: string; quantity: string }[] | undefined;
  }[];
}

export class WarehouseService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly idempotency: IdempotencyService,
  ) {
    this.placer = new StockPlacer(() => this.deps.clock.now());
  }

  private readonly placer: StockPlacer;

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: { organizationId: string; userId: string },
    action: string,
    resourceType: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType,
      resourceId,
      metadata,
      origin,
    });
  }

  private view(w: Warehouse) {
    return {
      id: w.id,
      code: w.code,
      name: w.name,
      isDefault: w.isDefault,
      status: w.status,
      version: w.version,
    };
  }

  // ---------------------------------------------------------------------------
  // Warehouses
  // ---------------------------------------------------------------------------

  list(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View },
      async (tx, ctx) => {
        await ensureDefaultWarehouse(tx, ctx.organizationId, this.now);
        const warehouses = await listWarehouses(tx, ctx.organizationId);
        const totals = new Map<string, { items: number; quantity: ReturnType<typeof decimal> }>();
        for (const w of warehouses) {
          const levels = (await levelsOfWarehouse(tx, ctx.organizationId, w.id)).filter(
            (l) => !decimal(l.quantity).isZero(),
          );
          totals.set(w.id, {
            items: levels.length,
            quantity: levels.reduce((sum, l) => sum.plus(l.quantity), decimal(0)),
          });
        }
        return warehouses.map((w) => ({
          ...this.view(w),
          itemsInStock: totals.get(w.id)!.items,
        }));
      },
    );
  }

  create(principal: Principal, input: { code: string; name: string }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.SettingsManage },
      async (tx, ctx) => {
        await ensureDefaultWarehouse(tx, ctx.organizationId, this.now);
        const code = input.code.trim();
        if (await warehouseCodeExists(tx, ctx.organizationId, code)) {
          throw new ValidationError([{ path: 'code', message: 'This code is already used.' }]);
        }
        const row = await insertWarehouse(tx, {
          organizationId: ctx.organizationId,
          code,
          name: input.name.trim(),
          createdByUserId: ctx.userId,
          createdAt: this.now,
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        });
        await this.audit(
          tx,
          ctx,
          'inventory.warehouse_created',
          'inventory_warehouse',
          row.id,
          origin,
          {
            code: row.code,
            name: row.name,
          },
        );
        return this.view(row);
      },
    );
  }

  update(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name?: string | undefined;
      archived?: boolean | undefined;
      makeDefault?: boolean | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.SettingsManage },
      async (tx, ctx) => {
        const current = await getWarehouse(tx, ctx.organizationId, id, { forUpdate: true });
        if (!current) throw new NotFoundError('Warehouse not found.');
        if (current.version !== input.version) throw versionConflict('warehouse');
        const set: Parameters<typeof updateWarehouse>[4] = {
          updatedAt: this.now,
          updatedByUserId: ctx.userId,
        };
        if (input.name !== undefined) set.name = input.name.trim();
        if (input.archived === true) {
          if (current.isDefault) {
            throw invalidState(
              'The default warehouse cannot be archived; make another one the default first.',
            );
          }
          set.status = 'ARCHIVED';
        } else if (input.archived === false) {
          set.status = 'ACTIVE';
        }
        if (input.makeDefault === true && !current.isDefault) {
          if (current.status !== 'ACTIVE' && set.status !== 'ACTIVE') {
            throw invalidState('Only an active warehouse can be the default.');
          }
          // The unique default index allows only one: demote the old default first.
          const previous = (await listWarehouses(tx, ctx.organizationId)).find((w) => w.isDefault);
          if (previous) {
            await updateWarehouse(tx, ctx.organizationId, previous.id, previous.version, {
              isDefault: false,
              updatedAt: this.now,
              updatedByUserId: ctx.userId,
            });
          }
          set.isDefault = true;
        }
        let updated: Warehouse | undefined;
        try {
          updated = await updateWarehouse(tx, ctx.organizationId, id, input.version, set);
        } catch (error) {
          if (
            /still holds stock/.test(
              String((error as { cause?: { message?: string } }).cause?.message ?? error),
            )
          ) {
            throw invalidState(
              'The warehouse still holds stock; transfer it out before archiving.',
            );
          }
          throw error;
        }
        if (!updated) throw versionConflict('warehouse');
        await this.audit(
          tx,
          ctx,
          'inventory.warehouse_updated',
          'inventory_warehouse',
          id,
          origin,
          {
            name: input.name ?? null,
            archived: input.archived ?? null,
            makeDefault: input.makeDefault ?? null,
          },
        );
        return this.view(updated);
      },
    );
  }

  /** Stock in one warehouse: quantity per item and its value at the item's current average cost. */
  stock(principal: Principal, warehouseId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const warehouse = await getWarehouse(tx, ctx.organizationId, warehouseId);
        if (!warehouse) throw new NotFoundError('Warehouse not found.');
        const [levels, tracked] = await Promise.all([
          levelsOfWarehouse(tx, ctx.organizationId, warehouseId),
          listTrackedItems(tx, ctx.organizationId),
        ]);
        const byItem = new Map(tracked.map((t) => [t.itemId, t]));
        const rows = levels
          .filter((l) => !decimal(l.quantity).isZero())
          .map((l) => {
            const item = byItem.get(l.itemId);
            const total = decimal(item?.quantity ?? 0);
            const average = total.isZero() ? decimal(0) : decimal(item!.value).div(total);
            return {
              itemId: l.itemId,
              name: item?.name ?? null,
              sku: item?.sku ?? null,
              quantity: decimal(l.quantity).toFixed(),
              // Informational: quantity times the item's average cost (cost is one per item).
              value: decimal(l.quantity).times(average).toFixed(4),
            };
          })
          .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
        return { warehouse: this.view(warehouse), items: rows };
      },
    );
  }

  /** Where one item's stock sits. */
  itemLocations(principal: Principal, itemId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (!(await getBalance(tx, ctx.organizationId, itemId))) {
          throw new NotFoundError('Tracked item not found.');
        }
        const [levels, warehouses] = await Promise.all([
          levelsOfItems(tx, ctx.organizationId, [itemId]),
          listWarehouses(tx, ctx.organizationId),
        ]);
        const byId = new Map(warehouses.map((w) => [w.id, w]));
        return levels
          .filter((l) => !decimal(l.quantity).isZero())
          .map((l) => ({
            warehouseId: l.warehouseId,
            code: byId.get(l.warehouseId)?.code ?? null,
            name: byId.get(l.warehouseId)?.name ?? null,
            quantity: decimal(l.quantity).toFixed(),
          }));
      },
    );
  }

  // ---------------------------------------------------------------------------
  // The warehouse a draft document will use
  // ---------------------------------------------------------------------------

  getDocumentWarehouse(principal: Principal, type: DocumentLocationType, documentId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const row = await getDocumentLocation(tx, ctx.organizationId, type, documentId);
        return { warehouseId: row?.warehouseId ?? null };
      },
    );
  }

  /** Chooses (or clears, with null) the warehouse of a DRAFT invoice, bill or vendor credit. */
  setDocumentWarehouse(
    principal: Principal,
    type: DocumentLocationType,
    documentId: string,
    warehouseId: string | null,
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const needed =
        type === 'invoice'
          ? SalesPermissions.InvoicesCreate
          : type === 'bill'
            ? BillPermissions.Create
            : VendorCreditPermissions.Create;
      if (!hasPermission(ctx, needed)) {
        throw new PermissionDeniedError();
      }
      const document =
        type === 'invoice'
          ? await getInvoice(tx, ctx.organizationId, documentId)
          : type === 'bill'
            ? await getBill(tx, ctx.organizationId, documentId)
            : await getVendorCredit(tx, ctx.organizationId, documentId);
      if (!document) throw new NotFoundError('Document not found.');
      if (document.status !== 'DRAFT') {
        throw invalidState('The warehouse can only be chosen while the document is a draft.');
      }
      if (warehouseId === null) {
        await clearDocumentLocation(tx, ctx.organizationId, type, documentId);
      } else {
        const warehouse = await getWarehouse(tx, ctx.organizationId, warehouseId);
        if (!warehouse || warehouse.status !== 'ACTIVE') {
          throw new ValidationError([
            { path: 'warehouseId', message: 'Choose an active warehouse.' },
          ]);
        }
        await setDocumentLocation(tx, {
          organizationId: ctx.organizationId,
          documentType: type,
          documentId,
          warehouseId,
          setByUserId: ctx.userId,
          setAt: this.now,
        });
      }
      await this.audit(
        tx,
        ctx,
        'inventory.document_warehouse_set',
        'inventory_document',
        documentId,
        origin,
        {
          documentType: type,
          warehouseId,
        },
      );
      return { warehouseId };
    });
  }

  // ---------------------------------------------------------------------------
  // Transfers
  // ---------------------------------------------------------------------------

  private async transferView(tx: Transaction, organizationId: string, t: Transfer) {
    const [lines, warehouses] = await Promise.all([
      getTransferLines(tx, organizationId, t.id),
      listWarehouses(tx, organizationId),
    ]);
    const name = (id: string) => warehouses.find((w) => w.id === id);
    const items = new Map<string, string>();
    for (const l of lines) {
      items.set(l.itemId, (await getItem(tx, organizationId, l.itemId))?.name ?? '');
    }
    return {
      id: t.id,
      number: t.number,
      transferDate: t.transferDate,
      memo: t.memo,
      status: t.status,
      from: {
        id: t.fromWarehouseId,
        code: name(t.fromWarehouseId)?.code ?? null,
        name: name(t.fromWarehouseId)?.name ?? null,
      },
      to: {
        id: t.toWarehouseId,
        code: name(t.toWarehouseId)?.code ?? null,
        name: name(t.toWarehouseId)?.name ?? null,
      },
      voidReason: t.voidReason,
      version: t.version,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        name: items.get(l.itemId) ?? null,
        quantity: decimal(l.quantity).toFixed(),
      })),
    };
  }

  listTransfers(principal: Principal, limit: number) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) =>
        Promise.all(
          (await listTransfers(tx, ctx.organizationId, limit)).map((t) =>
            this.transferView(tx, ctx.organizationId, t),
          ),
        ),
    );
  }

  getTransfer(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const t = await getTransfer(tx, ctx.organizationId, id);
        if (!t) throw new NotFoundError('Transfer not found.');
        return this.transferView(tx, ctx.organizationId, t);
      },
    );
  }

  postTransfer(
    principal: Principal,
    input: TransferInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.AdjustmentsCreate },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'inventory.transfer.post', request: input },
          async () => {
            const issues: ValidationIssue[] = [];
            if (!isValidIsoDate(input.transferDate)) {
              issues.push({ path: 'transferDate', message: 'Enter a valid date (YYYY-MM-DD).' });
            }
            if (input.fromWarehouseId === input.toWarehouseId) {
              issues.push({
                path: 'toWarehouseId',
                message: 'Choose a different warehouse to transfer to.',
              });
            }
            if (!input.lines.length || input.lines.length > MAX_TRANSFER_LINES) {
              issues.push({
                path: 'lines',
                message: `Add between 1 and ${MAX_TRANSFER_LINES} lines.`,
              });
            }
            const ids = input.lines.map((l) => l.itemId);
            if (new Set(ids).size !== ids.length) {
              issues.push({ path: 'lines', message: 'List each item once.' });
            }
            input.lines.forEach((l, i) => {
              if (!QUANTITY.test(l.quantity) || !decimal(l.quantity).gt(0)) {
                issues.push({
                  path: `lines.${i}.quantity`,
                  message: 'Enter a quantity above zero (up to 6 decimals).',
                });
              }
            });
            const [from, to] = await Promise.all([
              getWarehouse(tx, ctx.organizationId, input.fromWarehouseId),
              getWarehouse(tx, ctx.organizationId, input.toWarehouseId),
            ]);
            if (!from || from.status !== 'ACTIVE')
              issues.push({ path: 'fromWarehouseId', message: 'Choose an active warehouse.' });
            if (!to || to.status !== 'ACTIVE')
              issues.push({ path: 'toWarehouseId', message: 'Choose an active warehouse.' });
            const tracked = await getTrackedItems(tx, ctx.organizationId, ids);
            input.lines.forEach((l, i) => {
              if (!tracked.has(l.itemId)) {
                issues.push({
                  path: `lines.${i}.itemId`,
                  message: 'Only items tracked in stock can be transferred.',
                });
              }
            });
            if (issues.length) throw new ValidationError(issues);
            // Serialise with every other posting of these items (the same lock they take).
            await lockBalances(tx, ctx.organizationId, ids);
            // Plan what leaves the source (lots first-expired-first-out unless named); nothing is
            // written until every line is covered.
            const plans = new Map<string, EntryPlan[]>();
            for (const l of input.lines) {
              const item = tracked.get(l.itemId)!;
              plans.set(
                l.itemId,
                await this.placer.planOut(
                  tx,
                  ctx,
                  item,
                  (await getItem(tx, ctx.organizationId, l.itemId))?.name ?? 'the item',
                  decimal(l.quantity),
                  {
                    warehouseId: input.fromWarehouseId,
                    lots: l.lots?.map((x) => ({ code: x.lotCode, quantity: decimal(x.quantity) })),
                    allowNegative: false,
                    date: input.transferDate,
                    skipExpired: false,
                    what: 'The transfer cannot be posted',
                  },
                ),
              );
            }
            const transfer = await insertTransfer(tx, {
              organizationId: ctx.organizationId,
              number: await takeNextTransferNumber(tx, ctx.organizationId),
              transferDate: input.transferDate,
              fromWarehouseId: input.fromWarehouseId,
              toWarehouseId: input.toWarehouseId,
              memo: (input.memo ?? '').trim(),
              createdByUserId: ctx.userId,
              createdAt: this.now,
            });
            await insertTransferLines(
              tx,
              input.lines.map((l, i) => ({
                organizationId: ctx.organizationId,
                transferId: transfer.id,
                lineNo: i + 1,
                itemId: l.itemId,
                quantity: decimal(l.quantity).toFixed(6),
                lots:
                  tracked.get(l.itemId)!.trackingMode === 'none'
                    ? null
                    : plans
                        .get(l.itemId)!
                        .map((p) => ({ lotId: p.lotId!, quantity: p.quantity.abs().toFixed() })),
              })),
            );
            await insertStockEntries(
              tx,
              input.lines.flatMap((l) =>
                plans.get(l.itemId)!.flatMap((out) =>
                  [
                    { warehouseId: out.warehouseId, quantity: out.quantity },
                    { warehouseId: input.toWarehouseId, quantity: out.quantity.negated() },
                  ].map((e) => ({
                    organizationId: ctx.organizationId,
                    itemId: l.itemId,
                    warehouseId: e.warehouseId,
                    lotId: out.lotId,
                    quantity: e.quantity.toFixed(6),
                    entryKind: 'transfer' as const,
                    transferId: transfer.id,
                    createdByUserId: ctx.userId,
                    createdAt: this.now,
                  })),
                ),
              ),
            );
            await this.audit(
              tx,
              ctx,
              'inventory.transfer_posted',
              'inventory_transfer',
              transfer.id,
              origin,
              {
                number: transfer.number,
                from: from!.code,
                to: to!.code,
                lines: input.lines.length,
              },
            );
            return this.transferView(tx, ctx.organizationId, transfer);
          },
        ),
    );
  }

  voidTransfer(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.AdjustmentsVoid, sensitive: true },
      async (tx, ctx) => {
        const transfer = await getTransfer(tx, ctx.organizationId, id, { forUpdate: true });
        if (!transfer) throw new NotFoundError('Transfer not found.');
        if (transfer.version !== input.version) throw versionConflict('transfer');
        if (transfer.status !== 'POSTED') throw invalidState('The transfer is already void.');
        const reason = input.reason.trim();
        if (!reason) throw new ValidationError([{ path: 'reason', message: 'Give a reason.' }]);
        const original = await entriesOfTransfer(tx, ctx.organizationId, id);
        const itemIds = [...new Set(original.map((e) => e.itemId))];
        await lockBalances(tx, ctx.organizationId, itemIds);
        const tracked = await getTrackedItems(tx, ctx.organizationId, itemIds);
        const mirrored: (EntryPlan & { itemId: string })[] = [];
        for (const itemId of itemIds) {
          const plans = await this.placer.planMirror(
            tx,
            ctx,
            tracked.get(itemId)!,
            (await getItem(tx, ctx.organizationId, itemId))?.name ?? 'the item',
            original.filter((e) => e.itemId === itemId),
            false,
          );
          mirrored.push(...plans.map((p) => ({ ...p, itemId })));
        }
        await insertStockEntries(
          tx,
          mirrored.map((e) => ({
            organizationId: ctx.organizationId,
            itemId: e.itemId,
            warehouseId: e.warehouseId,
            lotId: e.lotId,
            quantity: e.quantity.toFixed(6),
            entryKind: 'transfer' as const,
            transferId: id,
            createdByUserId: ctx.userId,
            createdAt: this.now,
          })),
        );
        const voided = await markTransferVoid(tx, ctx.organizationId, id, input.version, {
          userId: ctx.userId,
          at: this.now,
          reason,
        });
        if (!voided) throw versionConflict('transfer');
        await this.audit(tx, ctx, 'inventory.transfer_voided', 'inventory_transfer', id, origin, {
          number: transfer.number,
          reason,
        });
        return this.transferView(tx, ctx.organizationId, voided);
      },
    );
  }
}
