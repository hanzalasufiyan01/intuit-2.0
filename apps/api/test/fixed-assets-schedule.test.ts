import { describe, expect, it } from 'vitest';
import {
  cumulativeDepreciation,
  depreciationDue,
  monthEndOf,
  monthsInService,
  nextMonthEnd,
  previousMonthEnd,
  scheduleOf,
  scheduledAccumulated,
} from '../src/application/fixed-asset-schedule.js';

/** Straight-line monthly depreciation: pure rules, no database. */

const asset = {
  cost: '12000.00',
  salvageValue: '0.00',
  lifeMonths: 12,
  inServiceDate: '2026-01-15',
};

describe('month arithmetic', () => {
  it('finds month ends, including leap years and year boundaries', () => {
    expect(monthEndOf('2026-02-10')).toBe('2026-02-28');
    expect(monthEndOf('2028-02-10')).toBe('2028-02-29');
    expect(previousMonthEnd('2026-01-05')).toBe('2025-12-31');
    expect(previousMonthEnd('2026-03-31')).toBe('2026-02-28');
    expect(nextMonthEnd('2026-12-31')).toBe('2027-01-31');
    expect(nextMonthEnd('2026-01-31')).toBe('2026-02-28');
  });

  it('counts the in-service month as the first', () => {
    expect(monthsInService('2026-01-15', '2026-01-31')).toBe(1);
    expect(monthsInService('2026-01-15', '2026-03-31')).toBe(3);
    expect(monthsInService('2026-01-15', '2026-12-31')).toBe(12);
    expect(monthsInService('2026-05-01', '2026-03-31')).toBe(0);
  });
});

describe('straight-line schedule', () => {
  it('spreads cost less salvage evenly and ends exactly at the depreciable amount', () => {
    expect(cumulativeDepreciation(asset, 0, 2).toFixed(2)).toBe('0.00');
    expect(cumulativeDepreciation(asset, 3, 2).toFixed(2)).toBe('3000.00');
    expect(cumulativeDepreciation(asset, 12, 2).toFixed(2)).toBe('12000.00');
    expect(cumulativeDepreciation(asset, 99, 2).toFixed(2)).toBe('12000.00');
    const withSalvage = { ...asset, salvageValue: '1000.00' };
    expect(cumulativeDepreciation(withSalvage, 12, 2).toFixed(2)).toBe('11000.00');
  });

  it('never loses a cent to rounding over the life', () => {
    const odd = { cost: '1000.00', salvageValue: '0', lifeMonths: 7, inServiceDate: '2026-01-01' };
    const rows = scheduleOf(odd, 2);
    expect(rows).toHaveLength(7);
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    expect(total.toFixed(2)).toBe('1000.00');
    expect(rows.at(-1)!.accumulated).toBe('1000.00');
    expect(rows.at(-1)!.bookValue).toBe('0.00');
    expect(rows[0]!.monthEnd).toBe('2026-01-31');
    expect(rows[6]!.monthEnd).toBe('2026-07-31');
  });

  it('books only what the schedule says is still owing, never negative', () => {
    const booked = (accumulatedDepreciation: string) => ({ ...asset, accumulatedDepreciation });
    expect(depreciationDue(booked('0'), '2026-03-31', 2).toFixed(2)).toBe('3000.00');
    expect(depreciationDue(booked('3000.00'), '2026-03-31', 2).toFixed(2)).toBe('0.00');
    expect(depreciationDue(booked('3000.00'), '2026-06-30', 2).toFixed(2)).toBe('3000.00');
    expect(depreciationDue(booked('5000.00'), '2026-03-31', 2).toFixed(2)).toBe('0.00');
    expect(depreciationDue(booked('0'), '2025-12-31', 2).toFixed(2)).toBe('0.00');
    expect(scheduledAccumulated(asset, '2027-06-30', 2).toFixed(2)).toBe('12000.00');
  });
});
