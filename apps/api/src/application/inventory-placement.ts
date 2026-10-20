import { Decimal } from 'decimal.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  ensureDefaultWarehouse,
  findLotByCode,
  getWarehouse,
  insertLot,
  levelsOfItems,
  listWarehouses,
  lotLevelsOfItem,
  type StockEntry,
  type TrackedItem,
} from '../modules/inventory/index.js';
import type { AuthorizationContext } from './authorization.js';

/**
 * Where a stock movement lands (ADR 0014 AI-02..AI-07): which warehouse and, for lot- and
 * serial-tracked items, which lots. It only PLANS the entries; the caller writes them. Cost is not
 * touched here (one average per item).
 */

export interface LotIn {
  code: string;
  expiryDate?: string | null | undefined;
  quantity: Decimal;
}
export interface LotPick {
  code: string;
  quantity: Decimal;
}
export interface EntryPlan {
  warehouseId: string;
  lotId: string | null;
  quantity: Decimal;
}

const insufficient = (message: string) => new ConflictError('INSUFFICIENT_STOCK', message);
const lotIssue = (message: string) => new ValidationError([{ path: 'lots', message }]);
const sum = (values: readonly Decimal[]) => values.reduce((a, b) => a.plus(b), decimal(0));

export class StockPlacer {
  constructor(private readonly now: () => Date) {}

  private async names(tx: Transaction, organizationId: string) {
    return new Map((await listWarehouses(tx, organizationId)).map((w) => [w.id, w]));
  }

  private async assertUsable(tx: Transaction, organizationId: string, id: string) {
    const warehouse = await getWarehouse(tx, organizationId, id);
    if (!warehouse) throw new NotFoundError('Warehouse not found.');
    if (warehouse.status !== 'ACTIVE') {
      throw new ConflictError(
        'INVALID_STATE_TRANSITION',
        `Warehouse ${warehouse.code} is archived.`,
      );
    }
  }

  /** Stock coming in: the chosen or default warehouse, and the lots it arrives in. */
  async planIn(
    tx: Transaction,
    ctx: AuthorizationContext,
    item: TrackedItem,
    itemName: string,
    quantity: Decimal,
    opts: {
      warehouseId: string | null;
      lots?: readonly LotIn[] | undefined;
      /** Returns of sold goods: the lot must already exist. */
      existingLotsOnly?: boolean;
    },
  ): Promise<EntryPlan[]> {
    const warehouseId =
      opts.warehouseId ?? (await ensureDefaultWarehouse(tx, ctx.organizationId, this.now())).id;
    await this.assertUsable(tx, ctx.organizationId, warehouseId);
    if (item.trackingMode === 'none') {
      if (opts.lots?.length) {
        throw lotIssue(`${itemName} is not tracked by lot or serial number.`);
      }
      return [{ warehouseId, lotId: null, quantity }];
    }
    const lots = opts.lots ?? [];
    if (!lots.length) {
      throw lotIssue(
        `${itemName} is tracked by ${item.trackingMode === 'serial' ? 'serial number' : 'lot'}: name ${item.trackingMode === 'serial' ? 'the serial numbers' : 'the lot'} that ${quantity.toFixed()} arrive in.`,
      );
    }
    if (!sum(lots.map((l) => l.quantity)).eq(quantity)) {
      throw lotIssue(
        `The lots of ${itemName} add up to ${sum(lots.map((l) => l.quantity)).toFixed()}, but ${quantity.toFixed()} are being received.`,
      );
    }
    const codes = lots.map((l) => l.code.trim().toLowerCase());
    if (new Set(codes).size !== codes.length) {
      throw lotIssue(`List each lot of ${itemName} once.`);
    }
    const plans: EntryPlan[] = [];
    for (const lotIn of lots) {
      const code = lotIn.code.trim();
      if (!code || code.length > 60) {
        throw lotIssue('A lot or serial number is 1 to 60 characters.');
      }
      if (!lotIn.quantity.gt(0)) throw lotIssue('A lot quantity must be above zero.');
      if (item.trackingMode === 'serial' && !lotIn.quantity.eq(1)) {
        throw lotIssue(`Serial number ${code} of ${itemName} is one unit.`);
      }
      let lot = await findLotByCode(tx, ctx.organizationId, item.itemId, code);
      if (lot) {
        if (lotIn.expiryDate && lot.expiryDate && lot.expiryDate !== lotIn.expiryDate) {
          throw lotIssue(
            `Lot ${code} of ${itemName} already exists with expiry ${lot.expiryDate}.`,
          );
        }
      } else if (opts.existingLotsOnly) {
        throw lotIssue(
          `Lot ${code} of ${itemName} does not exist: returned goods go back into the lot they came from.`,
        );
      } else {
        if (item.expiryTracked && !lotIn.expiryDate) {
          throw lotIssue(`Give the expiry date of lot ${code} of ${itemName}.`);
        }
        lot = await insertLot(tx, {
          organizationId: ctx.organizationId,
          itemId: item.itemId,
          code,
          expiryDate: item.expiryTracked ? (lotIn.expiryDate ?? null) : null,
          createdByUserId: ctx.userId,
          createdAt: this.now(),
        });
      }
      plans.push({ warehouseId, lotId: lot.id, quantity: lotIn.quantity });
    }
    return plans;
  }

  /**
   * Stock going out. A named warehouse is checked on its own; otherwise stock comes from the
   * default warehouse first, then the others. Lot items go first-expired-first-out (no expiry
   * last), skipping expired lots when `skipExpired`; explicit lot picks override that.
   */
  async planOut(
    tx: Transaction,
    ctx: AuthorizationContext,
    item: TrackedItem,
    itemName: string,
    quantity: Decimal,
    opts: {
      warehouseId: string | null;
      lots?: readonly LotPick[] | undefined;
      allowNegative: boolean;
      date: string;
      skipExpired: boolean;
      what: string;
    },
  ): Promise<EntryPlan[]> {
    const warehouses = await this.names(tx, ctx.organizationId);
    const def = await ensureDefaultWarehouse(tx, ctx.organizationId, this.now());
    const label = (id: string) => warehouses.get(id)?.name ?? id;
    if (opts.warehouseId) await this.assertUsable(tx, ctx.organizationId, opts.warehouseId);
    const levels = new Map(
      (await levelsOfItems(tx, ctx.organizationId, [item.itemId])).map((l) => [
        l.warehouseId,
        decimal(l.quantity),
      ]),
    );
    const rank = (id: string) => (id === def.id ? '' : id);

    if (item.trackingMode === 'none') {
      if (opts.lots?.length) throw lotIssue(`${itemName} is not tracked by lot or serial number.`);
      if (opts.warehouseId) {
        const have = levels.get(opts.warehouseId) ?? decimal(0);
        if (have.lt(quantity) && !opts.allowNegative) {
          throw insufficient(
            `${opts.what}: only ${have.toFixed()} of ${itemName} in ${label(opts.warehouseId)}, ${quantity.toFixed()} needed. Move stock there with a transfer first.`,
          );
        }
        return [{ warehouseId: opts.warehouseId, lotId: null, quantity: quantity.negated() }];
      }
      const plans: EntryPlan[] = [];
      let remaining = quantity;
      const order = [...levels.keys()].sort((a, b) => rank(a).localeCompare(rank(b)));
      for (const id of order) {
        const have = levels.get(id) ?? decimal(0);
        if (have.lte(0) || remaining.lte(0)) continue;
        const take = Decimal.min(have, remaining);
        plans.push({ warehouseId: id, lotId: null, quantity: take.negated() });
        remaining = remaining.minus(take);
      }
      if (remaining.gt(0)) {
        if (!opts.allowNegative) {
          throw insufficient(
            `${opts.what}: only ${quantity.minus(remaining).toFixed()} of ${itemName} on hand, ${quantity.toFixed()} needed.`,
          );
        }
        // Negative stock is allowed: the shortfall goes negative in the default warehouse.
        plans.push({ warehouseId: def.id, lotId: null, quantity: remaining.negated() });
      }
      return plans;
    }

    // Lot- and serial-tracked items never go negative, whatever the organization's policy says.
    const rows = (await lotLevelsOfItem(tx, ctx.organizationId, item.itemId))
      .map((r) => ({ ...r, qty: decimal(r.quantity) }))
      .filter((r) => r.qty.gt(0) && (!opts.warehouseId || r.warehouseId === opts.warehouseId));
    const plans: EntryPlan[] = [];
    if (opts.lots?.length) {
      if (!sum(opts.lots.map((l) => l.quantity)).eq(quantity)) {
        throw lotIssue(
          `The lots of ${itemName} add up to ${sum(opts.lots.map((l) => l.quantity)).toFixed()}, but ${quantity.toFixed()} are needed.`,
        );
      }
      const taken = new Map<string, Decimal>();
      for (const pick of opts.lots) {
        const code = pick.code.trim().toLowerCase();
        let remaining = pick.quantity;
        const candidates = rows
          .filter((r) => r.code.toLowerCase() === code)
          .sort((a, b) => rank(a.warehouseId).localeCompare(rank(b.warehouseId)));
        if (!candidates.length) {
          throw insufficient(
            `${opts.what}: lot ${pick.code} of ${itemName} is not in stock${opts.warehouseId ? ` in ${label(opts.warehouseId)}` : ''}.`,
          );
        }
        for (const c of candidates) {
          const key = `${c.lotId}|${c.warehouseId}`;
          const available = c.qty.minus(taken.get(key) ?? 0);
          if (available.lte(0) || remaining.lte(0)) continue;
          const take = Decimal.min(available, remaining);
          plans.push({ warehouseId: c.warehouseId, lotId: c.lotId, quantity: take.negated() });
          taken.set(key, (taken.get(key) ?? decimal(0)).plus(take));
          remaining = remaining.minus(take);
        }
        if (remaining.gt(0)) {
          throw insufficient(
            `${opts.what}: only ${pick.quantity.minus(remaining).toFixed()} of lot ${pick.code} of ${itemName} in stock, ${pick.quantity.toFixed()} needed.`,
          );
        }
      }
      return plans;
    }
    const usable = rows
      .filter((r) => !(opts.skipExpired && r.expiryDate !== null && r.expiryDate < opts.date))
      .sort((a, b) => {
        if (a.expiryDate !== b.expiryDate) {
          if (a.expiryDate === null) return 1;
          if (b.expiryDate === null) return -1;
          return a.expiryDate < b.expiryDate ? -1 : 1;
        }
        if (a.createdAt.getTime() !== b.createdAt.getTime()) {
          return a.createdAt.getTime() - b.createdAt.getTime();
        }
        return rank(a.warehouseId).localeCompare(rank(b.warehouseId));
      });
    let remaining = quantity;
    for (const r of usable) {
      if (remaining.lte(0)) break;
      const take = Decimal.min(r.qty, remaining);
      plans.push({ warehouseId: r.warehouseId, lotId: r.lotId, quantity: take.negated() });
      remaining = remaining.minus(take);
    }
    if (remaining.gt(0)) {
      const expired = rows.length - usable.length;
      throw insufficient(
        `${opts.what}: only ${quantity.minus(remaining).toFixed()} of ${itemName} ${opts.warehouseId ? `in ${label(opts.warehouseId)} ` : ''}available, ${quantity.toFixed()} needed${expired > 0 ? ' (expired lots are not sold)' : ''}.`,
      );
    }
    return plans;
  }

  /** The exact opposite of a movement's entries (a void), refused if the goods have moved on. */
  async planMirror(
    tx: Transaction,
    ctx: AuthorizationContext,
    item: TrackedItem,
    itemName: string,
    original: readonly StockEntry[],
    allowNegative: boolean,
  ): Promise<EntryPlan[]> {
    const warehouses = await this.names(tx, ctx.organizationId);
    const plans = original.map((e) => ({
      warehouseId: e.warehouseId,
      lotId: e.lotId,
      quantity: decimal(e.quantity).negated(),
    }));
    if (item.trackingMode === 'none') {
      const levels = new Map(
        (await levelsOfItems(tx, ctx.organizationId, [item.itemId])).map((l) => [
          l.warehouseId,
          decimal(l.quantity),
        ]),
      );
      for (const p of plans) {
        const have = levels.get(p.warehouseId) ?? decimal(0);
        if (p.quantity.lt(0) && have.plus(p.quantity).lt(0) && !allowNegative) {
          throw insufficient(
            `The stock cannot be taken back: only ${have.toFixed()} of ${itemName} in ${warehouses.get(p.warehouseId)?.name ?? p.warehouseId}, ${p.quantity.abs().toFixed()} needed. Move stock there with a transfer first.`,
          );
        }
      }
      return plans;
    }
    const rows = await lotLevelsOfItem(tx, ctx.organizationId, item.itemId);
    for (const p of plans) {
      if (p.quantity.gte(0)) continue;
      const have = decimal(
        rows.find((r) => r.lotId === p.lotId && r.warehouseId === p.warehouseId)?.quantity ?? 0,
      );
      if (have.plus(p.quantity).lt(0)) {
        throw insufficient(
          `The stock cannot be taken back: the lot of ${itemName} is no longer in ${warehouses.get(p.warehouseId)?.name ?? p.warehouseId}.`,
        );
      }
    }
    return plans;
  }
}
