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

/**
 * Characterization of the current straight-line rules (M2 step 0, before any other depreciation
 * method is added). The expected values were computed twice: from these functions and,
 * independently, as round-half-up((cost - salvage) x months / life) per ADR 0008 FA-04, with each
 * month's charge the difference of two rounded cumulative amounts. They must not change.
 */
describe('straight-line characterization (locked before R-11)', () => {
  const uneven = {
    cost: '1000.00',
    salvageValue: '100.03',
    lifeMonths: 7,
    inServiceDate: '2026-03-20',
  };

  it('spreads an uneven depreciable amount (salvage included) to the exact cent', () => {
    const rows = scheduleOf(uneven, 2);
    expect(rows.map((r) => r.monthEnd)).toEqual([
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
    ]);
    expect(rows.map((r) => r.amount)).toEqual([
      '128.57',
      '128.56',
      '128.57',
      '128.57',
      '128.57',
      '128.56',
      '128.57',
    ]);
    expect(rows.map((r) => r.accumulated)).toEqual([
      '128.57',
      '257.13',
      '385.70',
      '514.27',
      '642.84',
      '771.40',
      '899.97',
    ]);
    expect(rows.at(-1)!.bookValue).toBe('100.03');
  });

  it('rounds each cumulative amount half up, so the charges alternate and the life total is exact', () => {
    const three = {
      cost: '100.00',
      salvageValue: '0.00',
      lifeMonths: 3,
      inServiceDate: '2026-01-01',
    };
    expect(scheduleOf(three, 2).map((r) => r.amount)).toEqual(['33.33', '33.34', '33.33']);
    // 1.00 / 8 = 0.125 per month: half up gives 0.13 first (half-even would give 0.12).
    const eight = {
      cost: '1.00',
      salvageValue: '0.00',
      lifeMonths: 8,
      inServiceDate: '2026-01-01',
    };
    expect(scheduleOf(eight, 2).map((r) => r.amount)).toEqual([
      '0.13',
      '0.12',
      '0.13',
      '0.12',
      '0.13',
      '0.12',
      '0.13',
      '0.12',
    ]);
  });

  it('counts the in-service month in full, whatever its day', () => {
    expect(monthsInService('2026-01-31', '2026-01-31')).toBe(1);
    expect(monthsInService('2026-02-01', '2026-01-31')).toBe(0);
    expect(monthsInService('2026-02-15', '2026-02-28')).toBe(1);
  });

  it('depreciates a one-month life fully in its in-service month, down to the salvage value', () => {
    const one = {
      cost: '999.99',
      salvageValue: '0.99',
      lifeMonths: 1,
      inServiceDate: '2026-05-17',
    };
    expect(scheduleOf(one, 2)).toEqual([
      { monthEnd: '2026-05-31', amount: '999.00', accumulated: '999.00', bookValue: '0.99' },
    ]);
    expect(scheduledAccumulated(one, '2026-04-30', 2).toFixed(2)).toBe('0.00');
    expect(scheduledAccumulated(one, '2026-05-31', 2).toFixed(2)).toBe('999.00');
    expect(scheduledAccumulated(one, '2027-12-31', 2).toFixed(2)).toBe('999.00');
  });

  it('catches up exactly the sum of the skipped months', () => {
    const booked = (accumulatedDepreciation: string) => ({ ...uneven, accumulatedDepreciation });
    // Months 3 to 6 (128.57 + 128.57 + 128.57 + 128.56) after two months were booked.
    expect(depreciationDue(booked('257.13'), '2026-08-31', 2).toFixed(2)).toBe('514.27');
    // The last month brings the total to the depreciable amount, also after the life has ended.
    expect(depreciationDue(booked('771.40'), '2026-12-31', 2).toFixed(2)).toBe('128.57');
    expect(
      cumulativeDepreciation(uneven, monthsInService('2026-03-20', '2026-06-30'), 2).toFixed(2),
    ).toBe('514.27');
  });
});
