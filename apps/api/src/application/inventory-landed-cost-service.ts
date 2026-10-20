import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { designationsOfAccount, getAccount, isValidIsoDate } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getItem } from '../modules/catalog/index.js';
import {
  getBalance,
  getLandedCost,
  getLandedCostLines,
  getMovementsBySource,
  getTrackedItems,
  insertLandedCost,
  insertLandedCostLines,
  inventoryAccountIds,
  InventoryPermissions,
  listLandedCosts,
  lockBalances,
  markLandedCostVoid,
  takeNextLandedCostNumber,
  type LandedCost,
} from '../modules/inventory/index.js';
import { getBill } from '../modules/purchases/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import { allocate } from './inventory-costing.js';
import type { InventoryService } from './inventory-service.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import { assertOpenPeriod } from './sales-documents.js';

/**
 * Landed cost (FP-29 A8, migration 0081, ADR 0014 AI-08). The amount is spread over the tracked
 * items of ONE posted bill (by value or by quantity of what the bill brought in). For each item the
 * share belonging to units still on hand raises the stock value (a value-only movement); the rest
 * goes to that item's cost of goods sold, because those units are gone. Units "still on hand" are
 * the smaller of the quantity on hand now and the quantity the bill brought in. One journal posts
 * it all against the account the user chose; voiding reverses the journal and the movements.
 */

export const INVENTORY_LANDED_COST_EVENT = 'inventory.landed_cost_posted';
const RESOURCE = 'inventory_landed_cost';
const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The landed cost changed; reload it and try again.');
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

export interface LandedCostInput {
  costDate: string;
  billId: string;
  description: string;
  /** In the base currency. */
  amount: string;
  basis: 'value' | 'quantity';
  creditAccountId: string;
}

export class InventoryLandedCostService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
    private readonly inventory: InventoryService,
  ) {
    journals.registerEventHandler(INVENTORY_LANDED_COST_EVENT, (e) => e.payload.journal as never, {
      domainApproval: true,
    });
  }

  private get now() {
    return this.deps.clock.now();
  }

  private async view(tx: Transaction, organizationId: string, c: LandedCost) {
    const [lines, bill] = await Promise.all([
      getLandedCostLines(tx, organizationId, c.id),
      getBill(tx, organizationId, c.billId),
    ]);
    const names = new Map<string, string>();
    for (const l of lines) {
      names.set(l.itemId, (await getItem(tx, organizationId, l.itemId))?.name ?? '');
    }
    return {
      id: c.id,
      number: c.number,
      costDate: c.costDate,
      billId: c.billId,
      billNumber: bill?.number ?? null,
      description: c.description,
      amount: decimal(c.amount).toFixed(4),
      basis: c.basis,
      creditAccountId: c.creditAccountId,
      status: c.status,
      journalId: c.journalId,
      voidReason: c.voidReason,
      version: c.version,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        name: names.get(l.itemId) ?? null,
        allocated: decimal(l.allocated).toFixed(4),
        toInventory: decimal(l.toInventory).toFixed(4),
        toCostOfGoodsSold: decimal(l.toCogs).toFixed(4),
      })),
    };
  }

  list(principal: Principal, filter: { billId?: string | undefined; limit: number }) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) =>
        Promise.all(
          (await listLandedCosts(tx, ctx.organizationId, filter)).map((c) =>
            this.view(tx, ctx.organizationId, c),
          ),
        ),
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const c = await getLandedCost(tx, ctx.organizationId, id);
        if (!c) throw new NotFoundError('Landed cost not found.');
        return this.view(tx, ctx.organizationId, c);
      },
    );
  }

  post(
    principal: Principal,
    input: LandedCostInput,
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
          { key: options.idempotencyKey, scope: 'inventory.landed_cost.post', request: input },
          () => this.postInTransaction(tx, ctx, input, origin),
        ),
    );
  }

  private async postInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: LandedCostInput,
    origin: EventOrigin,
  ) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const scale = minorUnits(accounting.baseCurrency);
    const issues: ValidationIssue[] = [];
    if (!isValidIsoDate(input.costDate)) {
      issues.push({ path: 'costDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    }
    if (!input.description.trim())
      issues.push({ path: 'description', message: 'Describe the cost.' });
    const amount = decimal(input.amount);
    if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > scale) {
      issues.push({
        path: 'amount',
        message: `Enter an amount above zero with at most ${scale} decimals (${accounting.baseCurrency}).`,
      });
    }
    const credit = await getAccount(tx, ctx.organizationId, input.creditAccountId);
    const designated =
      (await designationsOfAccount(tx, ctx.organizationId, input.creditAccountId)).length > 0;
    if (
      !credit ||
      credit.status !== 'ACTIVE' ||
      !credit.isLeaf ||
      credit.isControlAccount ||
      designated
    ) {
      issues.push({
        path: 'creditAccountId',
        message: 'Choose an active posting account that is not a control account.',
      });
    } else if ((await inventoryAccountIds(tx, ctx.organizationId)).has(input.creditAccountId)) {
      issues.push({
        path: 'creditAccountId',
        message: 'The account cannot be an inventory account.',
      });
    }
    if (issues.length) throw new ValidationError(issues);
    await assertOpenPeriod(tx, ctx.organizationId, input.costDate);

    const bill = await getBill(tx, ctx.organizationId, input.billId);
    if (!bill) throw new NotFoundError('Bill not found.');
    if (bill.status !== 'POSTED')
      throw invalidState('Landed cost can only be added to a posted bill.');
    const received = await getMovementsBySource(tx, ctx.organizationId, {
      sourceType: 'bill',
      sourceId: bill.id,
      kind: 'purchase',
    });
    if (!received.length) {
      throw new ValidationError([{ path: 'billId', message: 'This bill brought no stock in.' }]);
    }
    const itemIds = received.map((m) => m.itemId);
    const balances = await lockBalances(tx, ctx.organizationId, itemIds);
    const tracked = await getTrackedItems(tx, ctx.organizationId, itemIds);
    const weights = received.map((m) => decimal(input.basis === 'value' ? m.value : m.quantity));
    if (weights.every((w) => w.isZero())) {
      throw new ValidationError([
        { path: 'basis', message: 'The bill has no value to allocate on; use quantity.' },
      ]);
    }
    const parts = allocate(amount, weights, scale);
    const rows = received.map((m, i) => {
      const onHand = decimal(balances.get(m.itemId)?.quantity ?? 0);
      const billQty = decimal(m.quantity);
      const share =
        onHand.lte(0) || billQty.lte(0)
          ? decimal(0)
          : onHand.gte(billQty)
            ? decimal(1)
            : onHand.div(billQty);
      const toInventory = parts[i]!.times(share).toDecimalPlaces(scale);
      return {
        movement: m,
        item: tracked.get(m.itemId)!,
        allocated: parts[i]!,
        toInventory,
        toCogs: parts[i]!.minus(toInventory),
      };
    });

    // One journal: Dr inventory / Dr cost of goods sold / Cr the chosen account.
    const debits = new Map<string, ReturnType<typeof decimal>>();
    const add = (accountId: string, value: ReturnType<typeof decimal>) => {
      if (value.gt(0)) debits.set(accountId, (debits.get(accountId) ?? decimal(0)).plus(value));
    };
    for (const r of rows) {
      add(r.item.inventoryAccountId, r.toInventory);
      add(r.item.cogsAccountId, r.toCogs);
    }
    const number = await takeNextLandedCostNumber(tx, ctx.organizationId);
    const landedCostId = randomUUID();
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'inventory',
      eventType: INVENTORY_LANDED_COST_EVENT,
      eventKey: `landed_cost:${landedCostId}:posted`,
      payload: {
        landedCostId,
        journal: {
          entryDate: input.costDate,
          description: `Landed cost ${number}: ${input.description.trim()}`.slice(0, 500),
          reference: number,
          currency: accounting.baseCurrency,
          exchangeRate: null,
          sourceRef: { module: 'inventory', type: 'landed_cost', id: landedCostId },
          lines: [
            ...[...debits.entries()].map(([accountId, value]) => ({
              accountId,
              description: `Landed cost ${number}`,
              debit: value.toFixed(4),
              credit: null,
              dimensions: [],
            })),
            {
              accountId: input.creditAccountId,
              description: `Landed cost ${number}`,
              debit: null,
              credit: amount.toFixed(4),
              dimensions: [],
            },
          ],
        },
      },
      occurredAt: this.now,
      origin,
    });
    if (!event.journalId) {
      throw new ConflictError('CONFLICT', 'The landed cost was not posted; try again.');
    }
    const now = this.now;
    const created = await insertLandedCost(tx, {
      id: landedCostId,
      organizationId: ctx.organizationId,
      number,
      costDate: input.costDate,
      billId: bill.id,
      description: input.description.trim(),
      amount: amount.toFixed(4),
      basis: input.basis,
      creditAccountId: input.creditAccountId,
      journalId: event.journalId,
      accountingEventId: event.eventId,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
    const lineRows = [];
    for (const [index, r] of rows.entries()) {
      const movement = r.toInventory.gt(0)
        ? await this.inventory.recordValueMovement(tx, ctx, {
            itemId: r.movement.itemId,
            delta: r.toInventory,
            date: input.costDate,
            kind: 'landed_cost',
            source: { module: 'inventory', type: 'landed_cost', id: landedCostId },
            journalId: event.journalId,
          })
        : null;
      lineRows.push({
        organizationId: ctx.organizationId,
        landedCostId,
        lineNo: index + 1,
        itemId: r.movement.itemId,
        allocated: r.allocated.toFixed(4),
        toInventory: r.toInventory.toFixed(4),
        toCogs: r.toCogs.toFixed(4),
        movementId: movement?.id ?? null,
      });
    }
    await insertLandedCostLines(tx, lineRows);
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'inventory.landed_cost_posted',
      resourceType: RESOURCE,
      resourceId: landedCostId,
      metadata: {
        number,
        billId: bill.id,
        amount: amount.toFixed(4),
        basis: input.basis,
        toInventory: rows.reduce((s, r) => s.plus(r.toInventory), decimal(0)).toFixed(4),
        toCostOfGoodsSold: rows.reduce((s, r) => s.plus(r.toCogs), decimal(0)).toFixed(4),
        journalId: event.journalId,
      },
      origin,
    });
    return this.view(tx, ctx.organizationId, created);
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
      { permission: InventoryPermissions.AdjustmentsVoid, sensitive: true },
      async (tx, ctx) => {
        const cost = await getLandedCost(tx, ctx.organizationId, id, { forUpdate: true });
        if (!cost) throw new NotFoundError('Landed cost not found.');
        if (cost.version !== input.version) throw versionConflict();
        if (cost.status !== 'POSTED') throw invalidState('The landed cost is already void.');
        const reason = input.reason.trim();
        if (!reason) throw new ValidationError([{ path: 'reason', message: 'Give a reason.' }]);
        const lines = await getLandedCostLines(tx, ctx.organizationId, id);
        await lockBalances(
          tx,
          ctx.organizationId,
          lines.map((l) => l.itemId),
        );
        // Take the value back first so a stock value that has since been used refuses the void
        // before anything is reversed.
        const originals = await getMovementsBySource(tx, ctx.organizationId, {
          sourceType: 'landed_cost',
          sourceId: id,
          kind: 'landed_cost',
        });
        let reversalId: string | null = null;
        if (cost.journalId) {
          const reversal = await this.journals.reverseSubledgerJournalInTransaction(
            tx,
            ctx,
            'inventory',
            cost.journalId,
            { reason: `Landed cost ${cost.number} voided: ${reason}` },
            origin,
          );
          reversalId = reversal.id;
        }
        for (const m of originals) {
          const balance = await getBalance(tx, ctx.organizationId, m.itemId);
          if (!balance) continue;
          await this.inventory.recordValueMovement(tx, ctx, {
            itemId: m.itemId,
            delta: decimal(m.value).negated(),
            date: m.movementDate,
            kind: 'landed_cost_void',
            source: { module: 'inventory', type: 'landed_cost', id },
            reversesId: m.id,
            journalId: reversalId,
          });
        }
        const voided = await markLandedCostVoid(tx, ctx.organizationId, id, input.version, {
          userId: ctx.userId,
          at: this.now,
          reason,
          journalId: reversalId!,
        });
        if (!voided) throw versionConflict();
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'inventory.landed_cost_voided',
          resourceType: RESOURCE,
          resourceId: id,
          metadata: { number: cost.number, reason, reversalJournalId: reversalId },
          origin,
        });
        return this.view(tx, ctx.organizationId, voided);
      },
    );
  }
}
