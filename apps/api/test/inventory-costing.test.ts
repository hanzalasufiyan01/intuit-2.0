import { describe, expect, it } from 'vitest';
import { decimal } from '../src/domain/money.js';
import {
  allocate,
  averageCost,
  InsufficientStock,
  issue,
  receive,
  remove,
  type StockState,
} from '../src/application/inventory-costing.js';

/** Perpetual weighted-average costing: pure rules, no database. */

const empty: StockState = { quantity: decimal(0), value: decimal(0), lastUnitCost: decimal(0) };
const d = decimal;

describe('weighted-average costing', () => {
  it('averages receipts and issues at the average cost', () => {
    let s = receive(empty, d(10), d(200)).after;
    expect(averageCost(s).toFixed(4)).toBe('20.0000');
    s = receive(s, d(10), d(300)).after;
    expect(s.quantity.toFixed()).toBe('20');
    expect(s.value.toFixed()).toBe('500');
    expect(averageCost(s).toFixed(4)).toBe('25.0000');
    const sale = issue(s, d(4), false);
    expect(sale.value.toFixed(4)).toBe('-100.0000');
    expect(sale.after.quantity.toFixed()).toBe('16');
    expect(sale.after.value.toFixed()).toBe('400');
  });

  it('takes the whole remaining value when the stock is emptied, leaving no residue', () => {
    // 3 units for 10.00: a unit is 3.3333…, three of them must cost exactly 10.00.
    let s = receive(empty, d(3), d(10)).after;
    s = issue(s, d(1), false).after;
    s = issue(s, d(1), false).after;
    const last = issue(s, d(1), false);
    expect(last.after.quantity.toFixed()).toBe('0');
    expect(last.after.value.toFixed()).toBe('0');
  });

  it('refuses an issue beyond the stock unless negative stock is allowed', () => {
    const s = receive(empty, d(5), d(50)).after;
    expect(() => issue(s, d(6), false)).toThrow(InsufficientStock);
    const allowed = issue(s, d(8), true);
    // 5 units at the average (50) plus 3 at the last unit cost (10 each).
    expect(allowed.value.toFixed(4)).toBe('-80.0000');
    expect(allowed.after.quantity.toFixed()).toBe('-3');
    expect(allowed.after.value.toFixed()).toBe('-30');
  });

  it('costs an issue with nothing on hand at the last unit cost', () => {
    let s = receive(empty, d(2), d(40)).after;
    s = issue(s, d(2), false).after;
    expect(s.quantity.toFixed()).toBe('0');
    const again = issue(s, d(1), true);
    expect(again.value.toFixed(4)).toBe('-20.0000');
    expect(() => issue(s, d(1), false)).toThrow(InsufficientStock);
  });

  it('removes and restores stock at a stated cost (voids)', () => {
    let s = receive(empty, d(10), d(100)).after;
    s = receive(s, d(10), d(300)).after;
    const gone = remove(s, d(10), d(100), false);
    expect(gone.after.quantity.toFixed()).toBe('10');
    expect(gone.after.value.toFixed()).toBe('300');
    expect(() => remove(s, d(25), d(100), false)).toThrow(InsufficientStock);
    const back = receive(gone.after, d(10), d(100));
    expect(back.after.value.toFixed()).toBe('400');
  });

  it('shares an amount so the parts add up exactly', () => {
    const parts = allocate(d('100.00'), [d(1), d(1), d(1)], 4);
    expect(parts.map((p) => p.toFixed(4))).toEqual(['33.3333', '33.3333', '33.3334']);
    expect(parts.reduce((a, b) => a.plus(b), d(0)).toFixed(4)).toBe('100.0000');
    expect(allocate(d(0), [d(0), d(0)], 4).map((p) => p.toFixed())).toEqual(['0', '0']);
    expect(allocate(d(7), [d(5)], 4).map((p) => p.toFixed())).toEqual(['7']);
  });
});
