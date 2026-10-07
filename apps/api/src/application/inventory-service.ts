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
import {
  adjustmentNumberExists,
  deleteTrackedItem,
  getAdjustment,
  getAdjustmentLines,
  getInventorySettings,
  getMovementsBySource,
  getTrackedItem,
  getTrackedItems,
  insertAdjustment,
  insertAdjustmentLines,
  insertMovement,
  insertTrackedItem,
  inventoryAccountIds,
  InventoryPermissions,
  listAdjustments,
  listMovements,
  listTrackedItems,
  lockBalances,
  saveInventorySettings,
  takeNextAdjustmentNumber,
  updateAdjustment,
  updateTrackedItem,
  valuationByAccount,
  writeBalance,
  type StockAdjustment,
  type StockMovement,
  type TrackedItem,
} from '../modules/inventory/index.js';
import { purchaseAccountProblem } from '../modules/vendors/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import {
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

export interface AdjustmentInput {
  adjustmentDate: string;
  reason: string;
  memo?: string | undefined;
  adjustmentAccountId?: string | undefined;
  lines: { itemId: string; quantityChange: string; unitCost?: string | undefined }[];
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

export class InventoryService implements InventoryHooks {
  constructor(
    private readonly deps: AppDependencies,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
  ) {
    for (const event of [INVENTORY_COGS_EVENT, INVENTORY_ADJUSTMENT_EVENT]) {
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
        if (await getTrackedItem(tx, ctx.organizationId, itemId)) {
          throw invalidState('This item is already tracked in stock.');
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
        const updated = await updateTrackedItem(tx, {
          organizationId: ctx.organizationId,
          itemId,
          version: input.version,
          set: {
            ...next,
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
            message: 'This item is tracked in stock; its bill line posts to its inventory account.',
          });
        }
      } else if (line.accountId && stockAccounts.has(line.accountId)) {
        issues.push({
          path: `lines.${i}.accountId`,
          message: 'This account holds tracked stock; choose the tracked item instead.',
        });
      }
    });
    if (issues.length) throw new ValidationError(issues, 'The bill cannot be posted yet.');
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
    return movement;
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
      entry.quantity = entry.quantity.plus(line.quantity);
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
    const tracked = await getTrackedItems(
      tx,
      ctx.organizationId,
      input.lines.map((l) => l.itemId).filter((id): id is string => id !== null),
    );
    if (!tracked.size) return;
    const soldLines = input.lines.filter((l) => l.itemId && tracked.has(l.itemId));
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

  private async postAdjustmentInTransaction(
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
      });
      lineRows.push({
        organizationId: ctx.organizationId,
        adjustmentId,
        lineNo: index + 1,
        itemId: line.itemId,
        quantityChange: decimal(line.quantityChange).toFixed(6),
        unitCost: line.unitCost === undefined ? null : decimal(line.unitCost).toFixed(6),
        value: step.value.toFixed(4),
        movementId: movement.id,
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
}
