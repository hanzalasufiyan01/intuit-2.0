import { randomUUID } from 'node:crypto';
import type { Decimal } from 'decimal.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  designationsOfAccount,
  getAccount,
  getDimensionValuesByIds,
  getJournalLines,
  isValidIsoDate,
  type AccountWithFacts,
} from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getItem, updateItem } from '../modules/catalog/index.js';
import { mergeDimensions } from '../modules/documents/index.js';
import { getCreditNote, getCreditNoteLines } from '../modules/sales/index.js';
import {
  adjustmentNumberExists,
  bundleComponentsOf,
  documentLotsOf,
  lotsOfMovement,
  type DocumentLot,
  entriesOfMovement,
  getDocumentLocation,
  getWarehouse,
  insertStockEntries,
  type DocumentLocationType,
  bundlesUsingComponent,
  deleteTrackedItem,
  isBundle,
  getAdjustment,
  getAdjustmentLines,
  getInventorySettings,
  getMovementsBySource,
  getReturn,
  getReturnLines,
  getTrackedItem,
  getTrackedItems,
  insertAdjustment,
  insertAdjustmentLines,
  insertMovement,
  insertReturn,
  insertReturnLines,
  insertTrackedItem,
  inventoryAccountIds,
  InventoryPermissions,
  listAdjustments,
  listMovements,
  listReturns,
  listTrackedItems,
  lockBalances,
  returnedQuantities,
  returnNumberExists,
  saveInventorySettings,
  takeNextAdjustmentNumber,
  takeNextReturnNumber,
  updateAdjustment,
  updateReturn,
  updateTrackedItem,
  valuationByAccount,
  writeBalance,
  type StockAdjustment,
  type StockMovement,
  type StockReturn,
  type TrackedItem,
} from '../modules/inventory/index.js';
import { purchaseAccountProblem } from '../modules/vendors/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import {
  revalue,
  allocate,
  averageCost,
  InsufficientStock,
  issue,
  receive,
  remove,
  stateOf,
  type StockState,
  type StockStep,
} from './inventory-costing.js';
import type { InventoryHooks } from './inventory-hooks.js';
import { StockPlacer, type EntryPlan, type LotIn, type LotPick } from './inventory-placement.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import { assertOpenPeriod } from './sales-documents.js';

/**
 * Inventory: items tracked in stock at perpetual weighted-average cost, an immutable stock ledger,
 * stock adjustments and valuation (approved 2026-10-07; ADR 0006).
 *
 * Inventory is additive to Sales and Purchases. A bill that carries a tracked item brings stock in
 * at the cost the bill posted to the inventory account (no goods-received-not-invoiced account in
 * v1). An invoice that carries it takes stock out at the average cost and posts the cost of goods
 * sold through the `inventory.cogs_posted` accounting event; the invoice's own journal is not
 * touched. Voids restore or remove stock at the cost of the movement they reverse. Negative stock is
 * blocked unless the organization allows it. Inventory never writes ledger tables.
 */

export const INVENTORY_COGS_EVENT = 'inventory.cogs_posted';
export const INVENTORY_ADJUSTMENT_EVENT = 'inventory.adjustment_posted';
/** Goods returned against a credit note: Dr inventory / Cr cost of goods sold (ADR 0012). */
export const INVENTORY_RETURN_EVENT = 'inventory.sales_return_posted';
const RETURN_RESOURCE = 'inventory_return';
const MAX_RETURN_LINES = 200;
const ITEM_RESOURCE = 'inventory_item';
const ADJUSTMENT_RESOURCE = 'inventory_adjustment';
const SETTINGS_RESOURCE = 'inventory_settings';
const MAX_ADJUSTMENT_LINES = 200;

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = (noun: string) =>
  new ConflictError(
    'VERSION_CONFLICT',
    `This ${noun} was changed by someone else. Reload it and apply your changes again.`,
  );

export interface ReturnInput {
  returnDate: string;
  creditNoteId: string;
  reason: string;
  memo?: string | undefined;
  warehouseId?: string | null | undefined;
  lines: {
    itemId: string;
    quantity: string;
    /** The lots the goods go back into (they must already exist). */
    lots?: { lotCode: string; quantity: string }[] | undefined;
  }[];
}

export interface AdjustmentInput {
  adjustmentDate: string;
  reason: string;
  memo?: string | undefined;
  adjustmentAccountId?: string | undefined;
  warehouseId?: string | null | undefined;
  lines: {
    itemId: string;
    quantityChange: string;
    unitCost?: string | undefined;
    /** Lots received (increase) or written off (decrease); lot- and serial-tracked items only. */
    lots?:
      { lotCode: string; expiryDate?: string | null | undefined; quantity: string }[] | undefined;
  }[];
}

/** An asset account that can hold stock: an other (current) asset, not a bank, receivable or control account. */
export function inventoryAccountProblem(
  account: AccountWithFacts | undefined,
  designated: boolean,
): string | null {
  if (!account) return 'Account not found.';
  const base = purchaseAccountProblem({
    status: account.status,
    isLeaf: account.isLeaf,
    subtype: account.subtype,
    isControlAccount: account.isControlAccount,
    designated,
  });
  if (base) return base;
  if (
    account.accountType !== 'ASSET' ||
    (account.subtype !== 'OTHER_CURRENT_ASSET' && account.subtype !== 'OTHER_ASSET')
  ) {
    return 'Choose an other current asset or other asset account for inventory.';
  }
  return null;
}

/** An expense account for the cost of goods sold. */
export function cogsAccountProblem(
  account: AccountWithFacts | undefined,
  designated: boolean,
): string | null {
  if (!account) return 'Account not found.';
  if (account.status !== 'ACTIVE') return 'Choose an active account.';
  if (!account.isLeaf) return 'Choose a posting (leaf) account.';
  if (account.isControlAccount) return 'A control account cannot be used here.';
  if (designated) return 'A designated system account cannot be used here.';
  if (account.accountType !== 'EXPENSE') return 'Choose a cost of sales or expense account.';
  return null;
}

function stepToValues(step: StockStep) {
  return {
    quantity: step.quantity.toFixed(6),
    value: step.value.toFixed(4),
    quantityAfter: step.after.quantity.toFixed(6),
    valueAfter: step.after.value.toFixed(4),
  };
}

/** A document quantity in the item's purchase or sales unit, as a base-unit quantity (exact to 6 places). */
function toBaseQuantity(
  quantity: Decimal | string,
  factor: string | null,
  itemName: string,
  unit: string | null,
): Decimal {
  const qty = typeof quantity === 'string' ? decimal(quantity) : quantity;
  if (factor === null) return qty;
  const base = qty.times(factor);
  if (!base.eq(base.toDecimalPlaces(6))) {
    throw new ValidationError([
      {
        path: 'quantity',
        message: `${qty.toFixed()} ${unit ?? 'units'} of ${itemName} is not a whole number of base units (factor ${decimal(factor).toFixed()}).`,
      },
    ]);
  }
  return base;
}

const lotsInOf = (rows: readonly DocumentLot[], itemId: string): LotIn[] =>
  rows
    .filter((r) => r.itemId === itemId)
    .map((r) => ({ code: r.lotCode, expiryDate: r.expiryDate, quantity: decimal(r.quantity) }));
const lotPicksOf = (rows: readonly DocumentLot[], itemId: string): LotPick[] =>
  rows
    .filter((r) => r.itemId === itemId)
    .map((r) => ({ code: r.lotCode, quantity: decimal(r.quantity) }));

export class InventoryService implements InventoryHooks {
  private readonly placer: StockPlacer;

  constructor(
    private readonly deps: AppDependencies,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
  ) {
    this.placer = new StockPlacer(() => this.deps.clock.now());
    for (const event of [
      INVENTORY_COGS_EVENT,
      INVENTORY_ADJUSTMENT_EVENT,
      INVENTORY_RETURN_EVENT,
    ]) {
      // Inventory posts inside the document that causes it; the journal is complete (Decision 13).
      journals.registerEventHandler(event, (e) => e.payload.journal as never, {
        domainApproval: true,
      });
    }
  }

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: Pick<AuthorizationContext, 'organizationId' | 'userId'>,
    action: string,
    resourceType: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
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

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private async policyOf(tx: Transaction, organizationId: string) {
    return (await getInventorySettings(tx, organizationId))?.negativeStockPolicy ?? 'block';
  }

  getSettings(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const settings = await getInventorySettings(tx, ctx.organizationId);
        return {
          negativeStockPolicy: settings?.negativeStockPolicy ?? 'block',
          adjustmentAccountId: settings?.adjustmentAccountId ?? null,
          version: settings?.version ?? 0,
        };
      },
    );
  }

  updateSettings(
    principal: Principal,
    input: {
      version: number;
      negativeStockPolicy: 'block' | 'allow';
      adjustmentAccountId: string | null;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.SettingsManage, sensitive: true },
      async (tx, ctx) => {
        const current = await getInventorySettings(tx, ctx.organizationId, { forUpdate: true });
        if ((current?.version ?? 0) !== input.version) throw versionConflict('setting');
        if (input.adjustmentAccountId) {
          const account = await getAccount(tx, ctx.organizationId, input.adjustmentAccountId);
          const designated =
            (await designationsOfAccount(tx, ctx.organizationId, input.adjustmentAccountId))
              .length > 0;
          const problem = cogsAccountProblem(account, designated);
          const isStock = (await inventoryAccountIds(tx, ctx.organizationId)).has(
            input.adjustmentAccountId,
          );
          if (problem || isStock) {
            throw new ValidationError([
              {
                path: 'adjustmentAccountId',
                message: problem ?? 'The adjustment account cannot be an inventory account.',
              },
            ]);
          }
        }
        if (input.negativeStockPolicy === 'block') {
          const negative = (await listTrackedItems(tx, ctx.organizationId)).filter((r) =>
            decimal(r.quantity).lt(0),
          );
          if (negative.length) {
            throw invalidState(
              `${negative.length} item${negative.length === 1 ? ' has' : 's have'} negative stock; bring ${negative.length === 1 ? 'it' : 'them'} back to zero before blocking negative stock.`,
            );
          }
        }
        const saved = await saveInventorySettings(tx, {
          organizationId: ctx.organizationId,
          version: input.version,
          negativeStockPolicy: input.negativeStockPolicy,
          adjustmentAccountId: input.adjustmentAccountId,
          userId: ctx.userId,
          at: this.now,
        });
        if (!saved) throw versionConflict('setting');
        await this.audit(
          tx,
          ctx,
          'inventory.settings_updated',
          SETTINGS_RESOURCE,
          ctx.organizationId,
          origin,
          {
            negativeStockPolicy: saved.negativeStockPolicy,
            adjustmentAccountId: saved.adjustmentAccountId,
          },
        );
        return {
          negativeStockPolicy: saved.negativeStockPolicy,
          adjustmentAccountId: saved.adjustmentAccountId,
          version: saved.version,
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Tracked items
  // ---------------------------------------------------------------------------

  private itemView(row: {
    itemId: string;
    sku: string | null;
    name: string;
    inventoryAccountId: string;
    cogsAccountId: string;
    reorderPoint: string | null;
    trackingMode: 'none' | 'lot' | 'serial';
    expiryTracked: boolean;
    baseUnit: string;
    purchaseUnit: string | null;
    purchaseFactor: string | null;
    salesUnit: string | null;
    salesFactor: string | null;
    quantity: string;
    value: string;
    lastUnitCost: string;
    version: number;
  }) {
    const quantity = decimal(row.quantity);
    const value = decimal(row.value);
    return {
      itemId: row.itemId,
      sku: row.sku,
      name: row.name,
      inventoryAccountId: row.inventoryAccountId,
      cogsAccountId: row.cogsAccountId,
      reorderPoint: row.reorderPoint === null ? null : decimal(row.reorderPoint).toFixed(),
      trackingMode: row.trackingMode,
      expiryTracked: row.expiryTracked,
      baseUnit: row.baseUnit,
      purchaseUnit:
        row.purchaseUnit === null
          ? null
          : { unit: row.purchaseUnit, factor: decimal(row.purchaseFactor!).toFixed() },
      salesUnit:
        row.salesUnit === null
          ? null
          : { unit: row.salesUnit, factor: decimal(row.salesFactor!).toFixed() },
      quantity: quantity.toFixed(),
      averageCost: quantity.gt(0) ? value.div(quantity).toFixed(4) : '0.0000',
      value: value.toFixed(4),
      belowReorderPoint: row.reorderPoint !== null && quantity.lte(row.reorderPoint),
      version: row.version,
    };
  }

  listItems(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => ({
        items: (await listTrackedItems(tx, ctx.organizationId)).map((r) => this.itemView(r)),
      }),
    );
  }

  private async trackedView(tx: Transaction, organizationId: string, itemId: string) {
    const row = (await listTrackedItems(tx, organizationId)).find((r) => r.itemId === itemId);
    if (!row) throw new NotFoundError('Tracked item not found.');
    return this.itemView(row);
  }

  getItem(principal: Principal, itemId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      (tx, ctx) => this.trackedView(tx, ctx.organizationId, itemId),
    );
  }

  /** Validates the two accounts of a tracked item. */
  private async itemAccountIssues(
    tx: Transaction,
    organizationId: string,
    input: { inventoryAccountId: string; cogsAccountId: string },
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const inventory = await getAccount(tx, organizationId, input.inventoryAccountId);
    const designatedInventory =
      (await designationsOfAccount(tx, organizationId, input.inventoryAccountId)).length > 0;
    const inventoryProblem = inventoryAccountProblem(inventory, designatedInventory);
    if (inventoryProblem) issues.push({ path: 'inventoryAccountId', message: inventoryProblem });
    const cogs = await getAccount(tx, organizationId, input.cogsAccountId);
    const designatedCogs =
      (await designationsOfAccount(tx, organizationId, input.cogsAccountId)).length > 0;
    const cogsProblem = cogsAccountProblem(cogs, designatedCogs);
    if (cogsProblem) issues.push({ path: 'cogsAccountId', message: cogsProblem });
    if (input.inventoryAccountId === input.cogsAccountId) {
      issues.push({
        path: 'cogsAccountId',
        message: 'Use different accounts for inventory and cost of goods sold.',
      });
    }
    return issues;
  }

  trackItem(
    principal: Principal,
    itemId: string,
    input: {
      inventoryAccountId: string;
      cogsAccountId: string;
      reorderPoint?: string | null | undefined;
      trackingMode?: 'none' | 'lot' | 'serial' | undefined;
      expiryTracked?: boolean | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.ItemsManage },
      async (tx, ctx) => {
        const item = await getItem(tx, ctx.organizationId, itemId, { forUpdate: true });
        if (!item) throw new NotFoundError('Item not found.');
        const issues = await this.itemAccountIssues(tx, ctx.organizationId, input);
        if (item.itemType !== 'product') {
          issues.push({ path: 'itemId', message: 'Only products can be tracked in stock.' });
        }
        if (item.status !== 'ACTIVE')
          issues.push({ path: 'itemId', message: 'The item is archived.' });
        if (input.expiryTracked && (input.trackingMode ?? 'none') === 'none') {
          issues.push({
            path: 'expiryTracked',
            message: 'Expiry dates need lot or serial tracking.',
          });
        }
        if (await getTrackedItem(tx, ctx.organizationId, itemId)) {
          throw invalidState('This item is already tracked in stock.');
        }
        if (await isBundle(tx, ctx.organizationId, itemId)) {
          throw invalidState('This item is a bundle; a bundle cannot be tracked in stock.');
        }
        if (issues.length) throw new ValidationError(issues);
        const now = this.now;
        const policy = await this.policyOf(tx, ctx.organizationId);
        await insertTrackedItem(
          tx,
          {
            organizationId: ctx.organizationId,
            itemId,
            inventoryAccountId: input.inventoryAccountId,
            cogsAccountId: input.cogsAccountId,
            reorderPoint: input.reorderPoint ?? null,
            trackingMode: input.trackingMode ?? 'none',
            expiryTracked: input.expiryTracked ?? false,
            createdByUserId: ctx.userId,
            createdAt: now,
            updatedAt: now,
          },
          policy === 'allow',
        );
        // A tracked item is bought into the inventory account: the purchase defaults follow it.
        await updateItem(tx, {
          organizationId: ctx.organizationId,
          id: itemId,
          version: item.version,
          set: { isPurchased: true, expenseAccountId: input.inventoryAccountId },
          userId: ctx.userId,
          now,
        });
        await this.audit(tx, ctx, 'inventory.item_tracked', ITEM_RESOURCE, itemId, origin, {
          inventoryAccountId: input.inventoryAccountId,
          cogsAccountId: input.cogsAccountId,
          trackingMode: input.trackingMode ?? 'none',
          expiryTracked: input.expiryTracked ?? false,
        });
        return this.trackedView(tx, ctx.organizationId, itemId);
      },
    );
  }

  updateTrackedItem(
    principal: Principal,
    itemId: string,
    input: {
      version: number;
      inventoryAccountId?: string | undefined;
      cogsAccountId?: string | undefined;
      reorderPoint?: string | null | undefined;
      trackingMode?: 'none' | 'lot' | 'serial' | undefined;
      expiryTracked?: boolean | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.ItemsManage },
      async (tx, ctx) => {
        const current = await getTrackedItem(tx, ctx.organizationId, itemId);
        if (!current) throw new NotFoundError('Tracked item not found.');
        if (current.version !== input.version) throw versionConflict('item');
        const next = {
          inventoryAccountId: input.inventoryAccountId ?? current.inventoryAccountId,
          cogsAccountId: input.cogsAccountId ?? current.cogsAccountId,
        };
        const accountsChanged =
          next.inventoryAccountId !== current.inventoryAccountId ||
          next.cogsAccountId !== current.cogsAccountId;
        if (accountsChanged) {
          if (
            (await listMovements(tx, { organizationId: ctx.organizationId, itemId, limit: 1 }))
              .length
          ) {
            throw invalidState('The item has stock history; its accounts cannot change.');
          }
          const issues = await this.itemAccountIssues(tx, ctx.organizationId, next);
          if (issues.length) throw new ValidationError(issues);
        }
        const nextMode = input.trackingMode ?? current.trackingMode;
        const nextExpiry = input.expiryTracked ?? current.expiryTracked;
        if (nextMode === 'none' && nextExpiry) {
          throw new ValidationError([
            { path: 'expiryTracked', message: 'Expiry dates need lot or serial tracking.' },
          ]);
        }
        if (
          (nextMode !== current.trackingMode || nextExpiry !== current.expiryTracked) &&
          (await listMovements(tx, { organizationId: ctx.organizationId, itemId, limit: 1 })).length
        ) {
          throw invalidState('The item has stock history; its lot tracking cannot change.');
        }
        const updated = await updateTrackedItem(tx, {
          organizationId: ctx.organizationId,
          itemId,
          version: input.version,
          set: {
            ...next,
            trackingMode: nextMode,
            expiryTracked: nextExpiry,
            ...(input.reorderPoint !== undefined ? { reorderPoint: input.reorderPoint } : {}),
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict('item');
        await this.audit(tx, ctx, 'inventory.item_updated', ITEM_RESOURCE, itemId, origin, {
          ...next,
          reorderPoint: updated.reorderPoint,
        });
        return this.trackedView(tx, ctx.organizationId, itemId);
      },
    );
  }

  /** Stops tracking an item that never moved. */
  untrackItem(principal: Principal, itemId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.ItemsManage },
      async (tx, ctx) => {
        if (!(await getTrackedItem(tx, ctx.organizationId, itemId))) {
          throw new NotFoundError('Tracked item not found.');
        }
        if (
          (await listMovements(tx, { organizationId: ctx.organizationId, itemId, limit: 1 })).length
        ) {
          throw invalidState('The item has stock history and stays tracked.');
        }
        if ((await bundlesUsingComponent(tx, ctx.organizationId, itemId)).length) {
          throw invalidState('The item is a component of a bundle and stays tracked.');
        }
        await deleteTrackedItem(tx, ctx.organizationId, itemId);
        await this.audit(tx, ctx, 'inventory.item_untracked', ITEM_RESOURCE, itemId, origin, {});
        return { itemId };
      },
    );
  }

  listItemMovements(principal: Principal, itemId: string, limit: number, after?: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (!(await getTrackedItem(tx, ctx.organizationId, itemId))) {
          throw new NotFoundError('Tracked item not found.');
        }
        let cursor: { createdAt: Date; id: string } | undefined;
        if (after) {
          try {
            const parsed = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')) as {
              t: string;
              i: string;
            };
            cursor = { createdAt: new Date(parsed.t), id: parsed.i };
            if (Number.isNaN(cursor.createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(cursor.id)) {
              throw new Error('bad');
            }
          } catch {
            throw new ValidationError([{ path: 'after', message: 'Invalid cursor.' }]);
          }
        }
        const rows = await listMovements(tx, {
          organizationId: ctx.organizationId,
          itemId,
          after: cursor,
          limit: limit + 1,
        });
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((m) => this.movementView(m)),
          nextCursor:
            rows.length > limit && last
              ? Buffer.from(
                  JSON.stringify({ t: last.createdAt.toISOString(), i: last.id }),
                ).toString('base64url')
              : null,
        };
      },
    );
  }

  private movementView(m: StockMovement) {
    return {
      id: m.id,
      date: m.movementDate,
      kind: m.kind,
      quantity: decimal(m.quantity).toFixed(),
      value: m.value,
      quantityAfter: decimal(m.quantityAfter).toFixed(),
      valueAfter: m.valueAfter,
      sourceModule: m.sourceModule,
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      journalId: m.journalId,
      createdAt: m.createdAt.toISOString(),
    };
  }

  /** Stock value by inventory account against the general ledger, item by item. */
  valuation(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const items = (await listTrackedItems(tx, ctx.organizationId)).map((r) => this.itemView(r));
        const accounts = await valuationByAccount(tx, ctx.organizationId);
        const total = items.reduce((sum, i) => sum.plus(i.value), decimal(0));
        return {
          items,
          totalValue: total.toFixed(4),
          accounts: accounts.map((a) => ({
            accountId: a.accountId,
            stockValue: decimal(a.stockValue).toFixed(4),
            glBalance: decimal(a.glBalance).toFixed(4),
            difference: decimal(a.glBalance).minus(a.stockValue).toFixed(4),
          })),
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Hooks used by Purchases and Sales
  // ---------------------------------------------------------------------------

  async assertBillLines(
    tx: Transaction,
    organizationId: string,
    lines: readonly { itemId: string | null; accountId: string | null }[],
    noun = 'bill',
  ) {
    const tracked = await getTrackedItems(
      tx,
      organizationId,
      lines.map((l) => l.itemId).filter((id): id is string => id !== null),
    );
    const stockAccounts = await inventoryAccountIds(tx, organizationId);
    const issues: ValidationIssue[] = [];
    lines.forEach((line, i) => {
      const item = line.itemId ? tracked.get(line.itemId) : undefined;
      if (item) {
        if (line.accountId !== item.inventoryAccountId) {
          issues.push({
            path: `lines.${i}.accountId`,
            message: `This item is tracked in stock; its ${noun} line posts to its inventory account.`,
          });
        }
      } else if (line.accountId && stockAccounts.has(line.accountId)) {
        issues.push({
          path: `lines.${i}.accountId`,
          message: 'This account holds tracked stock; choose the tracked item instead.',
        });
      }
    });
    if (issues.length) throw new ValidationError(issues, `The ${noun} cannot be posted yet.`);
  }

  async assertNoTrackedItems(
    tx: Transaction,
    organizationId: string,
    lines: readonly { itemId: string | null }[],
    noun: string,
  ) {
    const tracked = await getTrackedItems(
      tx,
      organizationId,
      lines.map((l) => l.itemId).filter((id): id is string => id !== null),
    );
    if (!tracked.size) return;
    const issues = lines.flatMap((line, i) =>
      line.itemId && tracked.has(line.itemId)
        ? [
            {
              path: `lines.${i}.itemId`,
              message: `Stock-tracked items cannot be used on ${noun} yet; record a stock adjustment instead.`,
            },
          ]
        : [],
    );
    if (issues.length) throw new ValidationError(issues);
  }

  /** Locks the balances; returns them with the negative-stock policy and the base value scale. */
  private async lockedState(tx: Transaction, organizationId: string, itemIds: readonly string[]) {
    const balances = await lockBalances(tx, organizationId, itemIds);
    const allowNegative = (await this.policyOf(tx, organizationId)) === 'allow';
    const scale = minorUnits((await requireAccountingSettings(tx, organizationId)).baseCurrency);
    return { balances, allowNegative, scale };
  }

  private async commit(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: {
      item: TrackedItem;
      step: StockStep;
      allowNegative: boolean;
      date: string;
      kind: StockMovement['kind'];
      source: { module: string; type: string; id: string };
      reversesId?: string | null;
      journalId?: string | null;
      /** The warehouse the stock moves in or out of; null chooses automatically (ADR 0014 AI-04). */
      warehouseId?: string | null;
      /** Lots coming in (receipts) or picked (issues) for lot- and serial-tracked items. */
      lots?: readonly (LotIn | LotPick)[] | undefined;
    },
  ): Promise<StockMovement> {
    const movement = await insertMovement(tx, {
      organizationId: ctx.organizationId,
      itemId: input.item.itemId,
      movementDate: input.date,
      kind: input.kind,
      ...stepToValues(input.step),
      sourceModule: input.source.module,
      sourceType: input.source.type,
      sourceId: input.source.id,
      reversesId: input.reversesId ?? null,
      journalId: input.journalId ?? null,
      createdByUserId: ctx.userId,
      createdAt: this.now,
    });
    await writeBalance(tx, {
      organizationId: ctx.organizationId,
      itemId: input.item.itemId,
      quantity: input.step.after.quantity.toFixed(6),
      value: input.step.after.value.toFixed(4),
      lastUnitCost: input.step.after.lastUnitCost.toFixed(6),
      negativeAllowed: input.allowNegative,
    });
    await this.place(tx, ctx, movement, input.item, {
      warehouseId: input.warehouseId ?? null,
      allowNegative: input.allowNegative,
      lots: input.lots,
      date: input.date,
    });
    return movement;
  }

  /**
   * A stock movement that moves VALUE only (a landed cost or its void): the quantity stays, the
   * item's value changes by `delta`. Costing stays one average per item; no warehouse or lot
   * entries are written because no quantity moves.
   */
  async recordValueMovement(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: {
      itemId: string;
      delta: Decimal;
      date: string;
      kind: 'landed_cost' | 'landed_cost_void';
      source: { module: string; type: string; id: string };
      reversesId?: string | null;
      journalId: string | null;
    },
  ): Promise<StockMovement> {
    const { balances, allowNegative, scale } = await this.lockedState(tx, ctx.organizationId, [
      input.itemId,
    ]);
    const item = await getTrackedItem(tx, ctx.organizationId, input.itemId);
    if (!item) throw new NotFoundError('Tracked item not found.');
    let step: StockStep;
    try {
      step = revalue(stateOf(balances.get(input.itemId)!), input.delta, allowNegative, scale);
    } catch (error) {
      if (error instanceof InsufficientStock) {
        throw new ConflictError(
          'INSUFFICIENT_STOCK',
          `The cost cannot be taken back: the stock value of ${await this.itemName(tx, ctx.organizationId, input.itemId)} has since been used.`,
        );
      }
      throw error;
    }
    return this.commit(tx, ctx, {
      item,
      step,
      allowNegative,
      date: input.date,
      kind: input.kind,
      source: input.source,
      reversesId: input.reversesId ?? null,
      journalId: input.journalId,
    });
  }

  /** The warehouse chosen for a draft document, if any. */
  private async documentWarehouse(
    tx: Transaction,
    organizationId: string,
    type: DocumentLocationType,
    documentId: string,
  ): Promise<string | null> {
    return (await getDocumentLocation(tx, organizationId, type, documentId))?.warehouseId ?? null;
  }

  /**
   * Writes the placement entries of a movement (ADR 0014 AI-02): a reversal mirrors the entries of
   * the movement it reverses; stock in goes to the chosen or default warehouse (in the named lots
   * for lot- and serial-tracked items); stock out comes from the chosen warehouse, or from the
   * default one first and then the others, first-expired-first-out for lot items. The database
   * refuses to commit if the warehouse or lot levels stop adding up to the balance.
   */
  private async place(
    tx: Transaction,
    ctx: AuthorizationContext,
    movement: StockMovement,
    item: TrackedItem,
    opts: {
      warehouseId: string | null;
      allowNegative: boolean;
      lots?: readonly (LotIn | LotPick)[] | undefined;
      date: string;
    },
  ) {
    const itemName = await this.itemName(tx, ctx.organizationId, movement.itemId);
    const quantity = decimal(movement.quantity);
    let plans: EntryPlan[];
    if (movement.reversesId) {
      plans = await this.placer.planMirror(
        tx,
        ctx,
        item,
        itemName,
        await entriesOfMovement(tx, ctx.organizationId, movement.reversesId),
        opts.allowNegative,
      );
    } else if (quantity.gt(0)) {
      plans = await this.placer.planIn(tx, ctx, item, itemName, quantity, {
        warehouseId: opts.warehouseId,
        lots: opts.lots as readonly LotIn[] | undefined,
        existingLotsOnly: movement.kind === 'sales_return',
      });
    } else {
      plans = await this.placer.planOut(tx, ctx, item, itemName, quantity.abs(), {
        warehouseId: opts.warehouseId,
        lots: opts.lots as readonly LotPick[] | undefined,
        allowNegative: opts.allowNegative,
        date: opts.date,
        skipExpired: movement.kind === 'sale',
        what: 'The stock cannot be taken out',
      });
    }
    await insertStockEntries(
      tx,
      plans.map((p) => ({
        organizationId: ctx.organizationId,
        itemId: movement.itemId,
        warehouseId: p.warehouseId,
        lotId: p.lotId,
        quantity: p.quantity.toFixed(6),
        entryKind: 'movement' as const,
        movementId: movement.id,
        createdByUserId: ctx.userId,
        createdAt: this.now,
      })),
    );
  }

  private async checkNamedWarehouse(
    tx: Transaction,
    organizationId: string,
    id: string | null | undefined,
    issues: ValidationIssue[],
  ) {
    if (!id) return;
    const warehouse = await getWarehouse(tx, organizationId, id);
    if (!warehouse || warehouse.status !== 'ACTIVE') {
      issues.push({ path: 'warehouseId', message: 'Choose an active warehouse.' });
    }
  }

  private insufficient(name: string, error: InsufficientStock, what: string) {
    return new ConflictError(
      'INSUFFICIENT_STOCK',
      `${what}: only ${error.available.toFixed()} of ${name} on hand, ${error.requested.toFixed()} needed.`,
    );
  }

  private async itemName(tx: Transaction, organizationId: string, itemId: string) {
    return (await getItem(tx, organizationId, itemId))?.name ?? 'the item';
  }

  async receiveBill(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: Parameters<InventoryHooks['receiveBill']>[2],
  ) {
    const tracked = await getTrackedItems(
      tx,
      ctx.organizationId,
      input.lines.map((l) => l.itemId).filter((id): id is string => id !== null),
    );
    if (!tracked.size) return;
    // Per item: quantity and the cost in the bill's currency (net plus capitalized tax).
    const perItem = new Map<string, { quantity: Decimal; cost: Decimal }>();
    for (const line of input.lines) {
      if (!line.itemId || !tracked.has(line.itemId)) continue;
      const entry = perItem.get(line.itemId) ?? { quantity: decimal(0), cost: decimal(0) };
      const item = tracked.get(line.itemId)!;
      entry.quantity = entry.quantity.plus(
        toBaseQuantity(
          line.quantity,
          item.purchaseFactor,
          await this.itemName(tx, ctx.organizationId, line.itemId),
          item.purchaseUnit,
        ),
      );
      entry.cost = entry.cost.plus(line.netAmount).plus(line.nonRecoverableTax);
      perItem.set(line.itemId, entry);
    }
    const { balances, allowNegative, scale } = await this.lockedState(tx, ctx.organizationId, [
      ...perItem.keys(),
    ]);
    // The base value is exactly what the bill's journal booked to each inventory account.
    const journalLines = await getJournalLines(tx, ctx.organizationId, [input.journalId]);
    const values = new Map<string, Decimal>();
    const byAccount = new Map<string, string[]>();
    for (const [itemId] of perItem) {
      const account = tracked.get(itemId)!.inventoryAccountId;
      byAccount.set(account, [...(byAccount.get(account) ?? []), itemId]);
    }
    for (const [accountId, itemIds] of byAccount) {
      const total = journalLines
        .filter((l) => l.accountId === accountId)
        .reduce((sum, l) => sum.plus(l.baseDebit ?? 0).minus(l.baseCredit ?? 0), decimal(0));
      const sorted = [...itemIds].sort();
      const parts = allocate(
        total,
        sorted.map((id) => perItem.get(id)!.cost),
        scale,
      );
      sorted.forEach((id, i) => values.set(id, parts[i]!));
    }
    const warehouseId = await this.documentWarehouse(tx, ctx.organizationId, 'bill', input.billId);
    const billLots = await documentLotsOf(tx, ctx.organizationId, 'bill', input.billId);
    for (const itemId of [...perItem.keys()].sort()) {
      const balance = balances.get(itemId)!;
      const step = receive(
        stateOf(balance),
        perItem.get(itemId)!.quantity,
        values.get(itemId)!,
        scale,
      );
      await this.commit(tx, ctx, {
        item: tracked.get(itemId)!,
        step,
        allowNegative,
        date: input.date,
        kind: 'purchase',
        source: { module: 'purchases', type: 'bill', id: input.billId },
        journalId: input.journalId,
        warehouseId,
        lots: lotsInOf(billLots, itemId),
      });
    }
  }

  async returnToVendor(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: Parameters<InventoryHooks['returnToVendor']>[2],
  ) {
    const tracked = await getTrackedItems(
      tx,
      ctx.organizationId,
      input.lines.map((l) => l.itemId).filter((id): id is string => id !== null),
    );
    if (!tracked.size) return;
    const perItem = new Map<string, { quantity: Decimal; cost: Decimal }>();
    for (const line of input.lines) {
      if (!line.itemId || !tracked.has(line.itemId)) continue;
      const entry = perItem.get(line.itemId) ?? { quantity: decimal(0), cost: decimal(0) };
      const item = tracked.get(line.itemId)!;
      entry.quantity = entry.quantity.plus(
        toBaseQuantity(
          line.quantity,
          item.purchaseFactor,
          await this.itemName(tx, ctx.organizationId, line.itemId),
          item.purchaseUnit,
        ),
      );
      entry.cost = entry.cost.plus(line.netAmount).plus(line.nonRecoverableTax);
      perItem.set(line.itemId, entry);
    }
    const { balances, allowNegative, scale } = await this.lockedState(tx, ctx.organizationId, [
      ...perItem.keys(),
    ]);
    // The base value is exactly what the credit's journal booked (a credit) to each inventory account.
    const journalLines = await getJournalLines(tx, ctx.organizationId, [input.journalId]);
    const values = new Map<string, Decimal>();
    const byAccount = new Map<string, string[]>();
    for (const [itemId] of perItem) {
      const account = tracked.get(itemId)!.inventoryAccountId;
      byAccount.set(account, [...(byAccount.get(account) ?? []), itemId]);
    }
    for (const [accountId, itemIds] of byAccount) {
      const total = journalLines
        .filter((l) => l.accountId === accountId)
        .reduce((sum, l) => sum.plus(l.baseCredit ?? 0).minus(l.baseDebit ?? 0), decimal(0));
      const sorted = [...itemIds].sort();
      const parts = allocate(
        total,
        sorted.map((id) => perItem.get(id)!.cost),
        scale,
      );
      sorted.forEach((id, i) => values.set(id, parts[i]!));
    }
    for (const itemId of [...perItem.keys()].sort()) {
      let step: StockStep;
      try {
        step = remove(
          stateOf(balances.get(itemId)!),
          perItem.get(itemId)!.quantity,
          values.get(itemId)!,
          allowNegative,
          scale,
        );
      } catch (error) {
        if (error instanceof InsufficientStock) {
          throw this.insufficient(
            await this.itemName(tx, ctx.organizationId, itemId),
            error,
            'The goods cannot be returned to the supplier',
          );
        }
        throw error;
      }
      await this.commit(tx, ctx, {
        item: tracked.get(itemId)!,
        step,
        allowNegative,
        date: input.date,
        lots: lotPicksOf(
          await documentLotsOf(tx, ctx.organizationId, 'vendor_credit', input.vendorCreditId),
          itemId,
        ),
        kind: 'purchase_return',
        source: { module: 'purchases', type: 'vendor_credit', id: input.vendorCreditId },
        journalId: input.journalId,
        warehouseId: await this.documentWarehouse(
          tx,
          ctx.organizationId,
          'vendor_credit',
          input.vendorCreditId,
        ),
      });
    }
  }

  async voidVendorReturn(tx: Transaction, ctx: AuthorizationContext, vendorCreditId: string) {
    const movements = await getMovementsBySource(tx, ctx.organizationId, {
      sourceType: 'vendor_credit',
      sourceId: vendorCreditId,
      kind: 'purchase_return',
    });
    if (!movements.length) return;
    const { balances, allowNegative, scale } = await this.lockedState(
      tx,
      ctx.organizationId,
      movements.map((m) => m.itemId),
    );
    for (const m of movements) {
      const step = receive(
        stateOf(balances.get(m.itemId)!),
        decimal(m.quantity).negated(),
        decimal(m.value).negated(),
        scale,
      );
      await this.commit(tx, ctx, {
        item: (await getTrackedItem(tx, ctx.organizationId, m.itemId))!,
        step,
        allowNegative,
        date: m.movementDate,
        kind: 'purchase_return_void',
        source: { module: 'purchases', type: 'vendor_credit', id: vendorCreditId },
        reversesId: m.id,
      });
    }
  }

  async voidBill(tx: Transaction, ctx: AuthorizationContext, billId: string) {
    const movements = await getMovementsBySource(tx, ctx.organizationId, {
      sourceType: 'bill',
      sourceId: billId,
      kind: 'purchase',
    });
    if (!movements.length) return;
    const { balances, allowNegative, scale } = await this.lockedState(
      tx,
      ctx.organizationId,
      movements.map((m) => m.itemId),
    );
    for (const m of movements) {
      const item = (await getTrackedItem(tx, ctx.organizationId, m.itemId))!;
      const balance = balances.get(m.itemId)!;
      let step: StockStep;
      try {
        step = remove(
          stateOf(balance),
          decimal(m.quantity),
          decimal(m.value),
          allowNegative,
          scale,
        );
      } catch (error) {
        if (error instanceof InsufficientStock) {
          throw this.insufficient(
            await this.itemName(tx, ctx.organizationId, m.itemId),
            error,
            'The stock this bill brought has been used',
          );
        }
        throw error;
      }
      await this.commit(tx, ctx, {
        item,
        step,
        allowNegative,
        date: m.movementDate,
        kind: 'purchase_void',
        source: { module: 'purchases', type: 'bill', id: billId },
        reversesId: m.id,
      });
    }
  }

  async issueInvoice(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: Parameters<InventoryHooks['issueInvoice']>[2],
    origin: EventOrigin,
  ) {
    // A bundle line sells its tracked components: each component leaves stock at its own cost.
    const bundles = await bundleComponentsOf(
      tx,
      ctx.organizationId,
      input.lines.map((l) => l.itemId).filter((id): id is string => id !== null),
    );
    const invoiceLines = input.lines.flatMap((line) => {
      const components = line.itemId ? bundles.get(line.itemId) : undefined;
      if (!components) return [{ ...line, base: false }];
      return components.map((c) => ({
        itemId: c.componentItemId,
        quantity: decimal(line.quantity).times(c.quantity).toFixed(6),
        dimensionValueIds: line.dimensionValueIds,
        base: true,
      }));
    });
    const tracked = await getTrackedItems(
      tx,
      ctx.organizationId,
      invoiceLines.map((l) => l.itemId).filter((id): id is string => id !== null),
    );
    if (!tracked.size) return;
    // Direct lines are in the item's sales unit; bundle components are already base units.
    const soldLines: (typeof invoiceLines)[number][] = [];
    for (const l of invoiceLines) {
      if (!l.itemId || !tracked.has(l.itemId)) continue;
      const item = tracked.get(l.itemId)!;
      soldLines.push(
        l.base
          ? l
          : {
              ...l,
              quantity: toBaseQuantity(
                l.quantity,
                item.salesFactor,
                await this.itemName(tx, ctx.organizationId, l.itemId),
                item.salesUnit,
              ).toFixed(6),
            },
      );
    }
    const quantities = new Map<string, Decimal>();
    for (const line of soldLines) {
      quantities.set(
        line.itemId!,
        (quantities.get(line.itemId!) ?? decimal(0)).plus(line.quantity),
      );
    }
    const itemIds = [...quantities.keys()].sort();
    const { balances, allowNegative, scale } = await this.lockedState(
      tx,
      ctx.organizationId,
      itemIds,
    );
    const steps = new Map<string, StockStep>();
    for (const itemId of itemIds) {
      try {
        steps.set(
          itemId,
          issue(stateOf(balances.get(itemId)!), quantities.get(itemId)!, allowNegative, scale),
        );
      } catch (error) {
        if (error instanceof InsufficientStock) {
          throw this.insufficient(
            await this.itemName(tx, ctx.organizationId, itemId),
            error,
            'The invoice cannot be issued',
          );
        }
        throw error;
      }
    }
    // The cost of each item is shared across its invoice lines, so dimensions follow the lines.
    const dimensionIds = [
      ...input.dimensionValueIds,
      ...soldLines.flatMap((l) => [...l.dimensionValueIds]),
    ];
    const dimensionValues = await getDimensionValuesByIds(tx, ctx.organizationId, dimensionIds);
    const typeOf = new Map([...dimensionValues].map(([id, v]) => [id, v.dimensionTypeId]));
    const debits = new Map<string, { accountId: string; dims: string[]; amount: Decimal }>();
    const credits = new Map<string, { accountId: string; dims: string[]; amount: Decimal }>();
    const add = (target: typeof debits, accountId: string, dims: string[], amount: Decimal) => {
      const key = `${accountId}|${dims.join(',')}`;
      const existing = target.get(key);
      if (existing) existing.amount = existing.amount.plus(amount);
      else target.set(key, { accountId, dims, amount });
    };
    for (const itemId of itemIds) {
      const item = tracked.get(itemId)!;
      const cost = steps.get(itemId)!.value.negated();
      const itemLines = soldLines.filter((l) => l.itemId === itemId);
      const parts = allocate(
        cost,
        itemLines.map((l) => decimal(l.quantity)),
        4,
      );
      itemLines.forEach((line, i) => {
        if (parts[i]!.isZero()) return;
        const dims = mergeDimensions(line.dimensionValueIds, input.dimensionValueIds, typeOf);
        add(debits, item.cogsAccountId, dims, parts[i]!);
        add(credits, item.inventoryAccountId, dims, parts[i]!);
      });
    }
    const toLine = (
      side: 'debit' | 'credit',
      entry: { accountId: string; dims: string[]; amount: Decimal },
    ) => ({
      accountId: entry.accountId,
      description: `Cost of goods sold — invoice ${input.number}`,
      debit: side === 'debit' ? entry.amount.toFixed(4) : null,
      credit: side === 'credit' ? entry.amount.toFixed(4) : null,
      dimensions: entry.dims.map((valueId) => ({
        dimensionTypeId: typeOf.get(valueId)!,
        dimensionValueId: valueId,
      })),
    });
    const lines = [
      ...[...debits.values()].map((e) => toLine('debit', e)),
      ...[...credits.values()].map((e) => toLine('credit', e)),
    ];
    let journalId: string | null = null;
    if (lines.length) {
      const settings = await requireAccountingSettings(tx, ctx.organizationId);
      const event = await this.journals.receiveEventInTransaction(tx, {
        organizationId: ctx.organizationId,
        sourceModule: 'inventory',
        eventType: INVENTORY_COGS_EVENT,
        eventKey: `invoice:${input.invoiceId}:cogs`,
        payload: {
          invoiceId: input.invoiceId,
          journal: {
            entryDate: input.date,
            description: `Cost of goods sold — invoice ${input.number}`.slice(0, 500),
            reference: input.number,
            currency: settings.baseCurrency,
            exchangeRate: null,
            sourceRef: { module: 'inventory', type: 'sale', id: input.invoiceId },
            lines,
          },
        },
        occurredAt: this.now,
        origin,
      });
      if (!event.journalId) {
        throw new AppError('CONFLICT', 409, 'The cost of goods sold was not posted; try again.');
      }
      journalId = event.journalId;
    }
    for (const itemId of itemIds) {
      await this.commit(tx, ctx, {
        item: tracked.get(itemId)!,
        step: steps.get(itemId)!,
        allowNegative,
        date: input.date,
        kind: 'sale',
        source: { module: 'sales', type: 'invoice', id: input.invoiceId },
        journalId,
        warehouseId: await this.documentWarehouse(
          tx,
          ctx.organizationId,
          'invoice',
          input.invoiceId,
        ),
      });
    }
  }

  async voidInvoice(
    tx: Transaction,
    ctx: AuthorizationContext,
    invoiceId: string,
    reason: string,
    origin: EventOrigin,
  ) {
    const movements = await getMovementsBySource(tx, ctx.organizationId, {
      sourceType: 'invoice',
      sourceId: invoiceId,
      kind: 'sale',
    });
    if (!movements.length) return;
    const { balances, allowNegative, scale } = await this.lockedState(
      tx,
      ctx.organizationId,
      movements.map((m) => m.itemId),
    );
    const journalIds = [
      ...new Set(movements.map((m) => m.journalId).filter((id): id is string => id !== null)),
    ];
    let reversalId: string | null = null;
    for (const journalId of journalIds) {
      const reversal = await this.journals.reverseSubledgerJournalInTransaction(
        tx,
        ctx,
        'inventory',
        journalId,
        { reason: `Invoice voided: ${reason}` },
        origin,
      );
      reversalId = reversal.id;
    }
    for (const m of movements) {
      const step = receive(
        stateOf(balances.get(m.itemId)!),
        decimal(m.quantity).negated(),
        decimal(m.value).negated(),
        scale,
      );
      await this.commit(tx, ctx, {
        item: (await getTrackedItem(tx, ctx.organizationId, m.itemId))!,
        step,
        allowNegative,
        date: m.movementDate,
        kind: 'sale_void',
        source: { module: 'sales', type: 'invoice', id: invoiceId },
        reversesId: m.id,
        journalId: reversalId,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Stock adjustments
  // ---------------------------------------------------------------------------

  private async adjustmentView(tx: Transaction, organizationId: string, a: StockAdjustment) {
    const lines = await getAdjustmentLines(tx, organizationId, a.id);
    return {
      id: a.id,
      number: a.number,
      status: a.status,
      date: a.adjustmentDate,
      reason: a.reason,
      memo: a.memo,
      adjustmentAccountId: a.adjustmentAccountId,
      netValue: a.netValue,
      journalId: a.journalId,
      voidJournalId: a.voidJournalId,
      voidedAt: a.voidedAt?.toISOString() ?? null,
      voidReason: a.voidReason,
      version: a.version,
      lines: lines.map((l) => ({
        lineNo: l.lineNo,
        itemId: l.itemId,
        quantityChange: decimal(l.quantityChange).toFixed(),
        unitCost: l.unitCost === null ? null : decimal(l.unitCost).toFixed(),
        value: l.value,
      })),
    };
  }

  listAdjustments(principal: Principal, limit: number) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const rows = await listAdjustments(tx, ctx.organizationId, limit);
        const items = [];
        for (const row of rows) items.push(await this.adjustmentView(tx, ctx.organizationId, row));
        return { items };
      },
    );
  }

  getAdjustment(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const adjustment = await getAdjustment(tx, ctx.organizationId, id);
        if (!adjustment) throw new NotFoundError('Stock adjustment not found.');
        return this.adjustmentView(tx, ctx.organizationId, adjustment);
      },
    );
  }

  postAdjustment(
    principal: Principal,
    input: AdjustmentInput,
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
          { key: options.idempotencyKey, scope: 'inventory.adjustment.post', request: input },
          () => this.postAdjustmentInTransaction(tx, ctx, input, origin),
        ),
    );
  }

  async postAdjustmentInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: AdjustmentInput,
    origin: EventOrigin,
  ) {
    const issues: ValidationIssue[] = [];
    if (!isValidIsoDate(input.adjustmentDate)) {
      issues.push({ path: 'adjustmentDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    }
    if (!input.reason.trim()) issues.push({ path: 'reason', message: 'Give a reason.' });
    await this.checkNamedWarehouse(tx, ctx.organizationId, input.warehouseId, issues);
    if (!input.lines.length || input.lines.length > MAX_ADJUSTMENT_LINES) {
      issues.push({ path: 'lines', message: `Add between 1 and ${MAX_ADJUSTMENT_LINES} lines.` });
    }
    const settings = await getInventorySettings(tx, ctx.organizationId);
    const offsetId = input.adjustmentAccountId ?? settings?.adjustmentAccountId ?? null;
    if (!offsetId) {
      issues.push({
        path: 'adjustmentAccountId',
        message: 'Choose the account for stock differences, or set it in the inventory settings.',
      });
    } else {
      const designated = (await designationsOfAccount(tx, ctx.organizationId, offsetId)).length > 0;
      const problem = cogsAccountProblem(
        await getAccount(tx, ctx.organizationId, offsetId),
        designated,
      );
      if (problem) issues.push({ path: 'adjustmentAccountId', message: problem });
      else if ((await inventoryAccountIds(tx, ctx.organizationId)).has(offsetId)) {
        issues.push({
          path: 'adjustmentAccountId',
          message: 'The offset cannot be an inventory account.',
        });
      }
    }
    const seen = new Set<string>();
    input.lines.forEach((line, i) => {
      if (seen.has(line.itemId)) {
        issues.push({ path: `lines.${i}.itemId`, message: 'List each item once per adjustment.' });
      }
      seen.add(line.itemId);
      const change = decimal(line.quantityChange);
      if (change.isZero()) {
        issues.push({ path: `lines.${i}.quantityChange`, message: 'The change cannot be zero.' });
      }
      if (line.unitCost !== undefined && change.lt(0)) {
        issues.push({
          path: `lines.${i}.unitCost`,
          message: 'A decrease is costed at the average; leave the unit cost empty.',
        });
      }
    });
    const tracked = await getTrackedItems(
      tx,
      ctx.organizationId,
      input.lines.map((l) => l.itemId),
    );
    input.lines.forEach((line, i) => {
      if (!tracked.has(line.itemId)) {
        issues.push({ path: `lines.${i}.itemId`, message: 'This item is not tracked in stock.' });
      }
    });
    if (issues.length) throw new ValidationError(issues);

    await assertOpenPeriod(tx, ctx.organizationId, input.adjustmentDate);
    const adjustmentId = randomUUID();
    const { balances, allowNegative, scale } = await this.lockedState(
      tx,
      ctx.organizationId,
      input.lines.map((l) => l.itemId),
    );
    const steps: { line: AdjustmentInput['lines'][number]; step: StockStep }[] = [];
    for (const line of input.lines) {
      const state: StockState = stateOf(balances.get(line.itemId)!);
      const change = decimal(line.quantityChange);
      try {
        if (change.gt(0)) {
          const unitCost =
            line.unitCost !== undefined
              ? decimal(line.unitCost)
              : averageCost(state).isZero()
                ? null
                : averageCost(state);
          if (unitCost === null) {
            throw new ValidationError([
              {
                path: `lines.${input.lines.indexOf(line)}.unitCost`,
                message: 'There is no stock to take the cost from: enter the unit cost.',
              },
            ]);
          }
          steps.push({ line, step: receive(state, change, change.times(unitCost), scale) });
        } else {
          steps.push({ line, step: issue(state, change.negated(), allowNegative, scale) });
        }
      } catch (error) {
        if (error instanceof InsufficientStock) {
          throw this.insufficient(
            await this.itemName(tx, ctx.organizationId, line.itemId),
            error,
            'The adjustment cannot be posted',
          );
        }
        throw error;
      }
    }
    // Journal: each inventory account moves by the value of its items; the offset takes the rest.
    const net = new Map<string, Decimal>();
    for (const { line, step } of steps) {
      const account = tracked.get(line.itemId)!.inventoryAccountId;
      net.set(account, (net.get(account) ?? decimal(0)).plus(step.value));
    }
    const netTotal = [...net.values()].reduce((a, b) => a.plus(b), decimal(0));
    const number = await this.nextAdjustmentNumber(tx, ctx.organizationId);
    const text = `Stock adjustment ${number} — ${input.reason.trim()}`.slice(0, 500);
    const lines: {
      accountId: string;
      description: string;
      debit: string | null;
      credit: string | null;
      dimensions: never[];
    }[] = [];
    for (const [accountId, value] of net) {
      if (value.isZero()) continue;
      lines.push({
        accountId,
        description: text,
        debit: value.gt(0) ? value.toFixed(4) : null,
        credit: value.lt(0) ? value.abs().toFixed(4) : null,
        dimensions: [],
      });
    }
    if (!netTotal.isZero()) {
      lines.push({
        accountId: offsetId!,
        description: text,
        debit: netTotal.lt(0) ? netTotal.abs().toFixed(4) : null,
        credit: netTotal.gt(0) ? netTotal.toFixed(4) : null,
        dimensions: [],
      });
    }
    let journalId: string | null = null;
    let eventId: string | null = null;
    if (lines.length) {
      const accounting = await requireAccountingSettings(tx, ctx.organizationId);
      const event = await this.journals.receiveEventInTransaction(tx, {
        organizationId: ctx.organizationId,
        sourceModule: 'inventory',
        eventType: INVENTORY_ADJUSTMENT_EVENT,
        eventKey: `inventory_adjustment:${adjustmentId}:posted`,
        payload: {
          adjustmentId,
          number,
          journal: {
            entryDate: input.adjustmentDate,
            description: text,
            reference: number,
            currency: accounting.baseCurrency,
            exchangeRate: null,
            sourceRef: { module: 'inventory', type: 'adjustment', id: adjustmentId },
            lines,
          },
        },
        occurredAt: this.now,
        origin,
      });
      if (!event.journalId) {
        throw new AppError('CONFLICT', 409, 'The adjustment was not posted; try again.');
      }
      journalId = event.journalId;
      eventId = event.eventId;
    }
    const now = this.now;
    const adjustment = await insertAdjustment(tx, {
      id: adjustmentId,
      organizationId: ctx.organizationId,
      number,
      adjustmentDate: input.adjustmentDate,
      reason: input.reason.trim(),
      memo: (input.memo ?? '').trim(),
      adjustmentAccountId: offsetId!,
      warehouseId: input.warehouseId ?? null,
      netValue: netTotal.toFixed(4),
      journalId,
      accountingEventId: eventId,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
    const lineRows = [];
    for (const [index, { line, step }] of steps.entries()) {
      const movement = await this.commit(tx, ctx, {
        item: tracked.get(line.itemId)!,
        step,
        allowNegative,
        date: input.adjustmentDate,
        kind: 'adjustment',
        source: { module: 'inventory', type: 'adjustment', id: adjustmentId },
        journalId,
        warehouseId: input.warehouseId ?? null,
        lots: (line.lots ?? []).map((l) => ({
          code: l.lotCode,
          expiryDate: l.expiryDate ?? null,
          quantity: decimal(l.quantity),
        })),
      });
      const usedLots =
        tracked.get(line.itemId)!.trackingMode === 'none'
          ? null
          : await lotsOfMovement(tx, ctx.organizationId, movement.id);
      lineRows.push({
        organizationId: ctx.organizationId,
        adjustmentId,
        lineNo: index + 1,
        itemId: line.itemId,
        quantityChange: decimal(line.quantityChange).toFixed(6),
        unitCost: line.unitCost === undefined ? null : decimal(line.unitCost).toFixed(6),
        value: step.value.toFixed(4),
        movementId: movement.id,
        lots: usedLots,
      });
    }
    await insertAdjustmentLines(tx, lineRows);
    await this.audit(
      tx,
      ctx,
      'inventory.adjustment_posted',
      ADJUSTMENT_RESOURCE,
      adjustmentId,
      origin,
      {
        number,
        reason: adjustment.reason,
        netValue: adjustment.netValue,
        lines: lineRows.length,
        journalId,
      },
    );
    return this.adjustmentView(tx, ctx.organizationId, adjustment);
  }

  private async nextAdjustmentNumber(tx: Transaction, organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const number = await takeNextAdjustmentNumber(tx, organizationId);
      if (!(await adjustmentNumberExists(tx, organizationId, number))) return number;
    }
    throw new AppError('CONFLICT', 409, 'Could not find a free number; check the numbering.');
  }

  voidAdjustment(
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
        const adjustment = await getAdjustment(tx, ctx.organizationId, id, { forUpdate: true });
        if (!adjustment) throw new NotFoundError('Stock adjustment not found.');
        if (adjustment.version !== input.version) throw versionConflict('adjustment');
        if (adjustment.status !== 'POSTED') throw invalidState('The adjustment is already void.');
        const reason = input.reason.trim();
        const originals = await getMovementsBySource(tx, ctx.organizationId, {
          sourceType: 'adjustment',
          sourceId: id,
          kind: 'adjustment',
        });
        const { balances, allowNegative, scale } = await this.lockedState(
          tx,
          ctx.organizationId,
          originals.map((m) => m.itemId),
        );
        const steps: { movement: StockMovement; step: StockStep }[] = [];
        for (const m of originals) {
          const state = stateOf(balances.get(m.itemId)!);
          try {
            // An increase is removed at its value; a decrease comes back at its value.
            steps.push({
              movement: m,
              step: decimal(m.quantity).gt(0)
                ? remove(state, decimal(m.quantity), decimal(m.value), allowNegative, scale)
                : receive(state, decimal(m.quantity).negated(), decimal(m.value).negated(), scale),
            });
          } catch (error) {
            if (error instanceof InsufficientStock) {
              throw this.insufficient(
                await this.itemName(tx, ctx.organizationId, m.itemId),
                error,
                'The adjustment cannot be voided',
              );
            }
            throw error;
          }
        }
        let reversalId: string | null = null;
        if (adjustment.journalId) {
          const reversal = await this.journals.reverseSubledgerJournalInTransaction(
            tx,
            ctx,
            'inventory',
            adjustment.journalId,
            { reason: `Stock adjustment ${adjustment.number} voided: ${reason}` },
            origin,
          );
          reversalId = reversal.id;
        }
        for (const { movement, step } of steps) {
          await this.commit(tx, ctx, {
            item: (await getTrackedItem(tx, ctx.organizationId, movement.itemId))!,
            step,
            allowNegative,
            date: movement.movementDate,
            kind: 'adjustment_void',
            source: { module: 'inventory', type: 'adjustment', id },
            reversesId: movement.id,
            journalId: reversalId,
          });
        }
        const now = this.now;
        const voided = await updateAdjustment(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'VOID',
            voidedByUserId: ctx.userId,
            voidedAt: now,
            voidReason: reason,
            voidJournalId: reversalId,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!voided) throw versionConflict('adjustment');
        await this.audit(tx, ctx, 'inventory.adjustment_voided', ADJUSTMENT_RESOURCE, id, origin, {
          number: adjustment.number,
          reason,
          reversalJournalId: reversalId,
        });
        return this.adjustmentView(tx, ctx.organizationId, voided);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Customer returns (ADR 0012): goods back into stock against an issued credit note
  // ---------------------------------------------------------------------------

  private async returnView(tx: Transaction, organizationId: string, r: StockReturn) {
    const lines = await getReturnLines(tx, organizationId, r.id);
    const credit = await getCreditNote(tx, organizationId, r.creditNoteId);
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      date: r.returnDate,
      creditNoteId: r.creditNoteId,
      creditNoteNumber: credit?.number ?? null,
      reason: r.reason,
      memo: r.memo,
      totalValue: r.totalValue,
      journalId: r.journalId,
      voidJournalId: r.voidJournalId,
      voidedAt: r.voidedAt?.toISOString() ?? null,
      voidReason: r.voidReason,
      version: r.version,
      lines: lines.map((l) => ({
        lineNo: l.lineNo,
        itemId: l.itemId,
        quantity: decimal(l.quantity).toFixed(),
        unitCost: decimal(l.unitCost).toFixed(),
        value: l.value,
      })),
    };
  }

  listReturns(principal: Principal, limit: number) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const rows = await listReturns(tx, ctx.organizationId, limit);
        const items = [];
        for (const row of rows) items.push(await this.returnView(tx, ctx.organizationId, row));
        return { items };
      },
    );
  }

  getReturn(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const row = await getReturn(tx, ctx.organizationId, id);
        if (!row) throw new NotFoundError('Stock return not found.');
        return this.returnView(tx, ctx.organizationId, row);
      },
    );
  }

  /** What each item may still come back for a credit note: credited, returned so far, remaining. */
  returnable(principal: Principal, creditNoteId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const note = await getCreditNote(tx, ctx.organizationId, creditNoteId);
        if (!note) throw new NotFoundError('Credit note not found.');
        const credited = await this.creditedQuantities(tx, ctx.organizationId, creditNoteId);
        const returned = await returnedQuantities(tx, ctx.organizationId, creditNoteId);
        const tracked = await getTrackedItems(tx, ctx.organizationId, [...credited.keys()]);
        return {
          creditNoteId,
          number: note.number,
          status: note.status,
          items: [...credited]
            .filter(([itemId]) => tracked.has(itemId))
            .map(([itemId, quantity]) => ({
              itemId,
              credited: quantity.toFixed(),
              returned: decimal(returned.get(itemId) ?? 0).toFixed(),
              remaining: quantity.minus(returned.get(itemId) ?? 0).toFixed(),
            })),
        };
      },
    );
  }

  private async creditedQuantities(tx: Transaction, organizationId: string, creditNoteId: string) {
    const credited = new Map<string, Decimal>();
    const lines = await getCreditNoteLines(tx, organizationId, creditNoteId);
    const tracked = await getTrackedItems(
      tx,
      organizationId,
      lines.map((l) => l.itemId).filter((id): id is string => id !== null),
    );
    for (const line of lines) {
      if (!line.itemId) continue;
      // Credit note quantities are in the item's sales unit; returns are in the base unit.
      const item = tracked.get(line.itemId);
      const base = item
        ? toBaseQuantity(
            line.quantity,
            item.salesFactor,
            await this.itemName(tx, organizationId, line.itemId),
            item.salesUnit,
          )
        : decimal(line.quantity);
      credited.set(line.itemId, (credited.get(line.itemId) ?? decimal(0)).plus(base));
    }
    return credited;
  }

  postReturn(
    principal: Principal,
    input: ReturnInput,
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
          { key: options.idempotencyKey, scope: 'inventory.return.post', request: input },
          () => this.postReturnInTransaction(tx, ctx, input, origin),
        ),
    );
  }

  private async postReturnInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: ReturnInput,
    origin: EventOrigin,
  ) {
    const issues: ValidationIssue[] = [];
    if (!isValidIsoDate(input.returnDate)) {
      issues.push({ path: 'returnDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    }
    if (!input.reason.trim()) issues.push({ path: 'reason', message: 'Give a reason.' });
    await this.checkNamedWarehouse(tx, ctx.organizationId, input.warehouseId, issues);
    if (!input.lines.length || input.lines.length > MAX_RETURN_LINES) {
      issues.push({ path: 'lines', message: `Add between 1 and ${MAX_RETURN_LINES} lines.` });
    }
    const seen = new Set<string>();
    input.lines.forEach((line, i) => {
      if (seen.has(line.itemId)) {
        issues.push({ path: `lines.${i}.itemId`, message: 'List each item once per return.' });
      }
      seen.add(line.itemId);
      if (!decimal(line.quantity).gt(0)) {
        issues.push({
          path: `lines.${i}.quantity`,
          message: 'The quantity must be greater than zero.',
        });
      }
    });
    const note = await getCreditNote(tx, ctx.organizationId, input.creditNoteId, {
      forUpdate: true,
    });
    if (!note) {
      issues.push({ path: 'creditNoteId', message: 'The credit note does not exist.' });
    } else if (note.status !== 'ISSUED') {
      issues.push({
        path: 'creditNoteId',
        message: 'Only an issued credit note can take a return.',
      });
    }
    if (issues.length) throw new ValidationError(issues);
    const creditNote = note!;
    const tracked = await getTrackedItems(
      tx,
      ctx.organizationId,
      input.lines.map((l) => l.itemId),
    );
    const credited = await this.creditedQuantities(tx, ctx.organizationId, creditNote.id);
    const returned = await returnedQuantities(tx, ctx.organizationId, creditNote.id);
    input.lines.forEach((line, i) => {
      const itemPath = `lines.${i}.itemId`;
      if (!tracked.has(line.itemId)) {
        issues.push({ path: itemPath, message: 'This item is not tracked in stock.' });
        return;
      }
      const creditedQty = credited.get(line.itemId);
      if (!creditedQty) {
        issues.push({ path: itemPath, message: 'The credit note does not credit this item.' });
        return;
      }
      const remaining = creditedQty.minus(returned.get(line.itemId) ?? 0);
      if (decimal(line.quantity).gt(remaining)) {
        issues.push({
          path: `lines.${i}.quantity`,
          message: `Only ${remaining.toFixed()} of this item can still be returned for this credit note.`,
        });
      }
    });
    if (issues.length) throw new ValidationError(issues);

    await assertOpenPeriod(tx, ctx.organizationId, input.returnDate);
    // The unit cost: what the goods left stock at on the credited invoice, else the current average.
    const saleCost = new Map<string, Decimal>();
    if (creditNote.invoiceId) {
      for (const m of await getMovementsBySource(tx, ctx.organizationId, {
        sourceType: 'invoice',
        sourceId: creditNote.invoiceId,
        kind: 'sale',
      })) {
        const quantity = decimal(m.quantity).abs();
        if (quantity.gt(0)) saleCost.set(m.itemId, decimal(m.value).abs().div(quantity));
      }
    }
    const returnId = randomUUID();
    const { balances, allowNegative, scale } = await this.lockedState(
      tx,
      ctx.organizationId,
      input.lines.map((l) => l.itemId),
    );
    const steps: { line: ReturnInput['lines'][number]; step: StockStep; unitCost: Decimal }[] = [];
    for (const line of input.lines) {
      const state = stateOf(balances.get(line.itemId)!);
      const unitCost =
        saleCost.get(line.itemId) ??
        (averageCost(state).gt(0) ? averageCost(state) : state.lastUnitCost);
      const quantity = decimal(line.quantity);
      steps.push({
        line,
        unitCost,
        step: receive(state, quantity, quantity.times(unitCost), scale),
      });
    }
    // Journal: Dr inventory / Cr cost of goods sold, with the credit note's dimensions.
    const noteLines = await getCreditNoteLines(tx, ctx.organizationId, creditNote.id);
    const dimensionIds = [
      ...creditNote.dimensionValueIds,
      ...noteLines.flatMap((l) => [...l.dimensionValueIds]),
    ];
    const dimensionValues = await getDimensionValuesByIds(tx, ctx.organizationId, dimensionIds);
    const typeOf = new Map([...dimensionValues].map(([id, v]) => [id, v.dimensionTypeId]));
    const debits = new Map<string, { accountId: string; dims: string[]; amount: Decimal }>();
    const credits = new Map<string, { accountId: string; dims: string[]; amount: Decimal }>();
    const add = (target: typeof debits, accountId: string, dims: string[], amount: Decimal) => {
      const key = accountId + '|' + dims.join(',');
      const existing = target.get(key);
      if (existing) existing.amount = existing.amount.plus(amount);
      else target.set(key, { accountId, dims, amount });
    };
    for (const { line, step } of steps) {
      const item = tracked.get(line.itemId)!;
      const itemLines = noteLines.filter((l) => l.itemId === line.itemId);
      const parts = allocate(
        step.value,
        itemLines.map((l) => decimal(l.quantity)),
        4,
      );
      itemLines.forEach((noteLine, i) => {
        if (parts[i]!.isZero()) return;
        const dims = mergeDimensions(
          noteLine.dimensionValueIds,
          creditNote.dimensionValueIds,
          typeOf,
        );
        add(debits, item.inventoryAccountId, dims, parts[i]!);
        add(credits, item.cogsAccountId, dims, parts[i]!);
      });
    }
    const number = await this.nextReturnNumber(tx, ctx.organizationId);
    const text = `Stock return ${number} — credit note ${creditNote.number ?? ''}`.slice(0, 500);
    const toLine = (
      side: 'debit' | 'credit',
      entry: { accountId: string; dims: string[]; amount: Decimal },
    ) => ({
      accountId: entry.accountId,
      description: text,
      debit: side === 'debit' ? entry.amount.toFixed(4) : null,
      credit: side === 'credit' ? entry.amount.toFixed(4) : null,
      dimensions: entry.dims.map((valueId) => ({
        dimensionTypeId: typeOf.get(valueId)!,
        dimensionValueId: valueId,
      })),
    });
    const lines = [
      ...[...debits.values()].map((e) => toLine('debit', e)),
      ...[...credits.values()].map((e) => toLine('credit', e)),
    ];
    const totalValue = steps.reduce((sum, s) => sum.plus(s.step.value), decimal(0));
    let journalId: string | null = null;
    let eventId: string | null = null;
    if (lines.length) {
      const accounting = await requireAccountingSettings(tx, ctx.organizationId);
      const event = await this.journals.receiveEventInTransaction(tx, {
        organizationId: ctx.organizationId,
        sourceModule: 'inventory',
        eventType: INVENTORY_RETURN_EVENT,
        eventKey: 'inventory_return:' + returnId + ':posted',
        payload: {
          returnId,
          number,
          journal: {
            entryDate: input.returnDate,
            description: text,
            reference: number,
            currency: accounting.baseCurrency,
            exchangeRate: null,
            sourceRef: { module: 'inventory', type: 'sales_return', id: returnId },
            lines,
          },
        },
        occurredAt: this.now,
        origin,
      });
      if (!event.journalId) {
        throw new AppError('CONFLICT', 409, 'The return was not posted; try again.');
      }
      journalId = event.journalId;
      eventId = event.eventId;
    }
    const now = this.now;
    const created = await insertReturn(tx, {
      id: returnId,
      organizationId: ctx.organizationId,
      number,
      returnDate: input.returnDate,
      creditNoteId: creditNote.id,
      reason: input.reason.trim(),
      memo: (input.memo ?? '').trim(),
      warehouseId: input.warehouseId ?? null,
      totalValue: totalValue.toFixed(4),
      journalId,
      accountingEventId: eventId,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
    const lineRows = [];
    for (const [index, { line, step, unitCost }] of steps.entries()) {
      const movement = await this.commit(tx, ctx, {
        item: tracked.get(line.itemId)!,
        step,
        allowNegative,
        date: input.returnDate,
        kind: 'sales_return',
        source: { module: 'inventory', type: 'return', id: returnId },
        journalId,
        warehouseId: input.warehouseId ?? null,
        lots: (line.lots ?? []).map((l) => ({ code: l.lotCode, quantity: decimal(l.quantity) })),
      });
      const usedLots =
        tracked.get(line.itemId)!.trackingMode === 'none'
          ? null
          : await lotsOfMovement(tx, ctx.organizationId, movement.id);
      lineRows.push({
        organizationId: ctx.organizationId,
        returnId,
        lineNo: index + 1,
        itemId: line.itemId,
        quantity: decimal(line.quantity).toFixed(6),
        unitCost: unitCost.toFixed(6),
        value: step.value.toFixed(4),
        movementId: movement.id,
        lots: usedLots,
      });
    }
    await insertReturnLines(tx, lineRows);
    await this.audit(tx, ctx, 'inventory.return_posted', RETURN_RESOURCE, returnId, origin, {
      number,
      creditNoteId: creditNote.id,
      reason: created.reason,
      totalValue: created.totalValue,
      lines: lineRows.length,
      journalId,
    });
    return this.returnView(tx, ctx.organizationId, created);
  }

  private async nextReturnNumber(tx: Transaction, organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const number = await takeNextReturnNumber(tx, organizationId);
      if (!(await returnNumberExists(tx, organizationId, number))) return number;
    }
    throw new AppError('CONFLICT', 409, 'Could not find a free number; check the numbering.');
  }

  voidReturn(
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
        const row = await getReturn(tx, ctx.organizationId, id, { forUpdate: true });
        if (!row) throw new NotFoundError('Stock return not found.');
        if (row.version !== input.version) throw versionConflict('return');
        if (row.status !== 'POSTED') throw invalidState('The return is already void.');
        const reason = input.reason.trim();
        const originals = await getMovementsBySource(tx, ctx.organizationId, {
          sourceType: 'return',
          sourceId: id,
          kind: 'sales_return',
        });
        const { balances, allowNegative, scale } = await this.lockedState(
          tx,
          ctx.organizationId,
          originals.map((m) => m.itemId),
        );
        const steps: { movement: StockMovement; step: StockStep }[] = [];
        for (const m of originals) {
          try {
            // The goods leave stock again at the value they came back at.
            steps.push({
              movement: m,
              step: remove(
                stateOf(balances.get(m.itemId)!),
                decimal(m.quantity),
                decimal(m.value),
                allowNegative,
                scale,
              ),
            });
          } catch (error) {
            if (error instanceof InsufficientStock) {
              throw this.insufficient(
                await this.itemName(tx, ctx.organizationId, m.itemId),
                error,
                'The return cannot be voided',
              );
            }
            throw error;
          }
        }
        let reversalId: string | null = null;
        if (row.journalId) {
          const reversal = await this.journals.reverseSubledgerJournalInTransaction(
            tx,
            ctx,
            'inventory',
            row.journalId,
            { reason: `Stock return ${row.number} voided: ${reason}` },
            origin,
          );
          reversalId = reversal.id;
        }
        for (const { movement, step } of steps) {
          await this.commit(tx, ctx, {
            item: (await getTrackedItem(tx, ctx.organizationId, movement.itemId))!,
            step,
            allowNegative,
            date: movement.movementDate,
            kind: 'sales_return_void',
            source: { module: 'inventory', type: 'return', id },
            reversesId: movement.id,
            journalId: reversalId,
          });
        }
        const now = this.now;
        const voided = await updateReturn(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'VOID',
            voidedByUserId: ctx.userId,
            voidedAt: now,
            voidReason: reason,
            voidJournalId: reversalId,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!voided) throw versionConflict('return');
        await this.audit(tx, ctx, 'inventory.return_voided', RETURN_RESOURCE, id, origin, {
          number: row.number,
          reason,
          reversalJournalId: reversalId,
        });
        return this.returnView(tx, ctx.organizationId, voided);
      },
    );
  }
}
