import { Decimal } from 'decimal.js';
import { decimal } from '../domain/money.js';

/**
 * Perpetual weighted-average costing (approved 2026-10-07). Pure functions: the service locks the
 * balance, calls these, and writes the movement and the new balance together.
 *
 * - A receipt adds its quantity and its base value; the average is value / quantity.
 * - An issue takes the average cost. The issue that empties the stock takes the whole remaining
 *   value, so the value never carries a residue once the quantity is zero.
 * - With negative stock allowed, the part of an issue beyond the stock on hand is costed at the
 *   last known unit cost.
 * - A void restores or removes stock at the cost of the movement it reverses, not at the average.
 */

export interface StockState {
  quantity: Decimal;
  /** Base value of the stock on hand. */
  value: Decimal;
  /** The unit cost used for an issue with nothing on hand. */
  lastUnitCost: Decimal;
}

export interface StockStep {
  /** Signed quantity of the movement. */
  quantity: Decimal;
  /** Signed base value of the movement. */
  value: Decimal;
  after: StockState;
}

export class InsufficientStock extends Error {
  constructor(
    readonly available: Decimal,
    readonly requested: Decimal,
  ) {
    super('Not enough stock.');
  }
}

const QTY_SCALE = 6;
/** Default value scale; the service passes the base currency's minor units (journals need them). */
export const DEFAULT_VALUE_SCALE = 4;
const round = (value: Decimal, places: number) =>
  value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);

export const stateOf = (balance: {
  quantity: string;
  value: string;
  lastUnitCost: string;
}): StockState => ({
  quantity: decimal(balance.quantity),
  value: decimal(balance.value),
  lastUnitCost: decimal(balance.lastUnitCost),
});

/** The average unit cost on hand (zero when there is no stock). */
export function averageCost(state: StockState): Decimal {
  return state.quantity.gt(0) ? state.value.div(state.quantity) : decimal(0);
}

/** Stock arrives: `value` is the base value it brings (zero for free goods). */
export function receive(
  state: StockState,
  quantity: Decimal,
  value: Decimal,
  scale = DEFAULT_VALUE_SCALE,
): StockStep {
  const qty = round(quantity, QTY_SCALE);
  const val = round(value, scale);
  const after: StockState = {
    quantity: round(state.quantity.plus(qty), QTY_SCALE),
    value: round(state.value.plus(val), scale),
    lastUnitCost: state.lastUnitCost,
  };
  if (after.quantity.gt(0)) {
    after.lastUnitCost = round(after.value.div(after.quantity), QTY_SCALE);
  } else if (qty.gt(0) && !val.isZero()) {
    after.lastUnitCost = round(val.div(qty), QTY_SCALE);
  }
  return { quantity: qty, value: val, after };
}

/** The cost of issuing `quantity` at the average; throws when it exceeds the stock (block policy). */
export function issueCost(
  state: StockState,
  quantity: Decimal,
  allowNegative: boolean,
  scale = DEFAULT_VALUE_SCALE,
): Decimal {
  const qty = round(quantity, QTY_SCALE);
  const onHand = state.quantity.gt(0) ? state.quantity : decimal(0);
  if (qty.gt(onHand) && !allowNegative) throw new InsufficientStock(onHand, qty);
  const fromStock = Decimal.min(qty, onHand);
  let cost = decimal(0);
  if (fromStock.gt(0)) {
    cost = fromStock.eq(state.quantity)
      ? state.value
      : round(fromStock.times(state.value).div(state.quantity), scale);
  }
  const shortfall = qty.minus(fromStock);
  if (shortfall.gt(0)) cost = cost.plus(round(shortfall.times(state.lastUnitCost), scale));
  return cost;
}

/** Stock leaves at the average cost. */
export function issue(
  state: StockState,
  quantity: Decimal,
  allowNegative: boolean,
  scale = DEFAULT_VALUE_SCALE,
): StockStep {
  const qty = round(quantity, QTY_SCALE);
  const cost = issueCost(state, qty, allowNegative, scale);
  return {
    quantity: qty.negated(),
    value: cost.negated(),
    after: {
      quantity: round(state.quantity.minus(qty), QTY_SCALE),
      value: round(state.value.minus(cost), scale),
      lastUnitCost: state.lastUnitCost,
    },
  };
}

/** Stock leaves at a stated cost (the void of a receipt). */
export function remove(
  state: StockState,
  quantity: Decimal,
  value: Decimal,
  allowNegative: boolean,
  scale = DEFAULT_VALUE_SCALE,
): StockStep {
  const qty = round(quantity, QTY_SCALE);
  const val = round(value, scale);
  if (qty.gt(state.quantity) && !allowNegative) {
    throw new InsufficientStock(state.quantity.gt(0) ? state.quantity : decimal(0), qty);
  }
  return {
    quantity: qty.negated(),
    value: val.negated(),
    after: {
      quantity: round(state.quantity.minus(qty), QTY_SCALE),
      value: round(state.value.minus(val), scale),
      lastUnitCost: state.lastUnitCost,
    },
  };
}

/**
 * Splits a total across weights so the parts add up to the total exactly (the last part takes the
 * rounding remainder). Used to share a journal amount between items and between document lines.
 */
export function allocate(total: Decimal, weights: readonly Decimal[], places: number): Decimal[] {
  const sum = weights.reduce((a, b) => a.plus(b), decimal(0));
  const parts: Decimal[] = [];
  let allocated = decimal(0);
  weights.forEach((weight, index) => {
    if (index === weights.length - 1) {
      parts.push(round(total.minus(allocated), places));
    } else {
      const share = sum.isZero() ? decimal(0) : round(total.times(weight).div(sum), places);
      parts.push(share);
      allocated = allocated.plus(share);
    }
  });
  return parts;
}

/**
 * Value moves with no quantity (a landed cost, or its void). A negative `delta` takes value away and
 * is refused when it would leave the stock with negative value (block policy).
 */
export function revalue(
  state: StockState,
  delta: Decimal,
  allowNegative: boolean,
  scale = DEFAULT_VALUE_SCALE,
): StockStep {
  const val = round(delta, scale);
  const value = round(state.value.plus(val), scale);
  if (value.lt(0) && !allowNegative) throw new InsufficientStock(state.quantity, decimal(0));
  return {
    quantity: decimal(0),
    value: val,
    after: {
      quantity: state.quantity,
      value,
      lastUnitCost: state.quantity.gt(0)
        ? round(value.div(state.quantity), QTY_SCALE)
        : state.lastUnitCost,
    },
  };
}
