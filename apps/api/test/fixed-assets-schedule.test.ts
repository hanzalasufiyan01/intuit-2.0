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
  scheduleWarnings,
  type DepreciableAsset,
} from '../src/application/fixed-asset-schedule.js';
import { decimal } from '../src/domain/money.js';

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

describe('declining-balance methods (R-11; ADR 0008 FA-12)', () => {
  // Expected values from an independent month-by-month model in exact fractions (not this code).
  const accumulated = (asset: DepreciableAsset, scale = 2) =>
    scheduleOf(asset, scale).map((row) => row.accumulated);
  const yearTotals = (asset: DepreciableAsset, scale = 2) => {
    const rows = accumulated(asset, scale);
    const ends = rows.filter((_, i) => (i + 1) % 12 === 0 || i === rows.length - 1);
    return ends.map((end, i) =>
      decimal(end)
        .minus(i ? ends[i - 1]! : 0)
        .toFixed(scale),
    );
  };
  const ddb60: DepreciableAsset = {
    cost: '10000.00',
    salvageValue: '1000.00',
    lifeMonths: 60,
    inServiceDate: '2026-01-15',
    depreciationMethod: 'double_declining_balance',
  };

  it('double-declining: 40% of book value a year, the last year capped at salvage', () => {
    expect(yearTotals(ddb60)).toEqual(['4000.00', '2400.00', '1440.00', '864.00', '296.00']);
    const rows = accumulated(ddb60);
    expect(rows.slice(0, 3)).toEqual(['333.33', '666.67', '1000.00']);
    expect(rows.slice(12, 14)).toEqual(['4200.00', '4400.00']);
    expect(rows.slice(-3)).toEqual(['8950.67', '8975.33', '9000.00']);
    expect(scheduleOf(ddb60, 2).at(-1)!.bookValue).toBe('1000.00');
    expect(scheduleWarnings(ddb60, 2)).toEqual([]);
  });

  it('declining balance switches to straight line for good, over a life of 30 months', () => {
    const db: DepreciableAsset = {
      cost: '5000.00',
      salvageValue: '200.00',
      lifeMonths: 30,
      inServiceDate: '2026-03-01',
      depreciationMethod: 'declining_balance',
      decliningRate: '40.0000',
    };
    // Year 1: DB 2,000 > SL 1,920. Year 2: SL 2,800 x 12/18 = 1,866.67 > DB 1,200: switch.
    // Year 3 (6 months): the rest, 933.33.
    expect(yearTotals(db)).toEqual(['2000.00', '1866.67', '933.33']);
    expect(accumulated(db).slice(11, 15)).toEqual(['2000.00', '2155.56', '2311.11', '2466.67']);
    expect(accumulated(db).at(-1)).toBe('4800.00');
    expect(scheduleOf(db, 2)[0]!.monthEnd).toBe('2026-03-31');
  });

  it('switches on an exact tie of straight line and declining balance', () => {
    // Life 48, 50% a year: year 3 has DB = SL = 1,000 exactly; straight line from then on.
    const tie: DepreciableAsset = {
      cost: '8000.00',
      salvageValue: '0.00',
      lifeMonths: 48,
      inServiceDate: '2026-01-01',
      depreciationMethod: 'double_declining_balance',
    };
    expect(yearTotals(tie)).toEqual(['4000.00', '2000.00', '1000.00', '1000.00']);
    expect(accumulated(tie).slice(12, 14)).toEqual(['4166.67', '4333.33']);
  });

  it('rounds exact half cents up, on the cumulative amount', () => {
    const halves: DepreciableAsset = {
      cost: '0.15',
      salvageValue: '0.00',
      lifeMonths: 24,
      inServiceDate: '2026-01-01',
      depreciationMethod: 'declining_balance',
      decliningRate: '60',
    };
    // 0.0075 a month in year 1 (0.015 -> 0.02, 0.045 -> 0.05), 0.005 a month in year 2.
    expect(accumulated(halves)).toEqual([
      '0.01',
      '0.02',
      '0.02',
      '0.03',
      '0.04',
      '0.05',
      '0.05',
      '0.06',
      '0.07',
      '0.08',
      '0.08',
      '0.09',
      '0.10',
      '0.10',
      '0.11',
      '0.11',
      '0.12',
      '0.12',
      '0.13',
      '0.13',
      '0.14',
      '0.14',
      '0.15',
      '0.15',
    ]);
  });

  it('caps a year at salvage: a 100% rate depreciates everything in year 1', () => {
    const full: DepreciableAsset = {
      cost: '1200.00',
      salvageValue: '0.00',
      lifeMonths: 24,
      inServiceDate: '2026-01-01',
      depreciationMethod: 'declining_balance',
      decliningRate: '100',
    };
    expect(yearTotals(full)).toEqual(['1200.00', '0.00']);
    expect(accumulated(full)[0]).toBe('100.00');
    // Double-declining over 13 months: the rate exceeds 100%, so year 1 takes it all.
    const short: DepreciableAsset = {
      cost: '1000.00',
      salvageValue: '100.00',
      lifeMonths: 13,
      inServiceDate: '2026-01-01',
      depreciationMethod: 'double_declining_balance',
    };
    expect(accumulated(short)).toEqual([
      '75.00',
      '150.00',
      '225.00',
      '300.00',
      '375.00',
      '450.00',
      '525.00',
      '600.00',
      '675.00',
      '750.00',
      '825.00',
      '900.00',
      '900.00',
    ]);
  });

  it('works in other currency scales', () => {
    const whole: DepreciableAsset = {
      cost: '1000',
      salvageValue: '7',
      lifeMonths: 18,
      inServiceDate: '2026-01-01',
      depreciationMethod: 'declining_balance',
      decliningRate: '80',
    };
    expect(accumulated(whole, 0)).toEqual([
      '67',
      '133',
      '200',
      '267',
      '333',
      '400',
      '467',
      '533',
      '600',
      '667',
      '733',
      '800',
      '832',
      '864',
      '897',
      '929',
      '961',
      '993',
    ]);
    const fine: DepreciableAsset = {
      cost: '100.005',
      salvageValue: '0.000',
      lifeMonths: 27,
      inServiceDate: '2026-01-01',
      depreciationMethod: 'declining_balance',
      decliningRate: '60',
    };
    const rows = accumulated(fine, 3);
    expect(rows.slice(0, 3)).toEqual(['5.000', '10.001', '15.001']);
    expect(rows.slice(11, 13)).toEqual(['60.003', '62.670']);
    expect(rows.at(-1)).toBe('100.005');
  });

  it('warns when the schedule equals straight line, or there is nothing to depreciate', () => {
    // 30% over 30 months: straight line (1,920 a year) is already more than DB (1,500).
    const same: DepreciableAsset = {
      cost: '5000.00',
      salvageValue: '200.00',
      lifeMonths: 30,
      inServiceDate: '2026-01-01',
      depreciationMethod: 'declining_balance',
      decliningRate: '30',
    };
    expect(scheduleWarnings(same, 2)).toEqual(['STRAIGHT_LINE_EQUIVALENT']);
    expect(accumulated(same)).toEqual(accumulated({ ...same, depreciationMethod: undefined }));
    // A life within one year: the year's straight line is everything, so it always switches.
    const short = { ...same, lifeMonths: 6, decliningRate: '50' };
    expect(scheduleWarnings(short, 2)).toEqual(['STRAIGHT_LINE_EQUIVALENT']);
    const nothing = { ...ddb60, salvageValue: '10000.00' };
    expect(scheduleWarnings(nothing, 2)).toEqual(['NOTHING_TO_DEPRECIATE']);
    expect(accumulated(nothing).every((a) => a === '0.00')).toBe(true);
    // Straight-line assets get no warnings.
    expect(scheduleWarnings({ ...same, depreciationMethod: 'straight_line' }, 2)).toEqual([]);
    expect(scheduleWarnings({ ...nothing, depreciationMethod: undefined }, 2)).toEqual([]);
  });

  it('keeps straight line exactly as before when the method is given explicitly', () => {
    const plain = {
      cost: '1000.00',
      salvageValue: '100.03',
      lifeMonths: 7,
      inServiceDate: '2026-03-20',
    };
    expect(
      scheduleOf({ ...plain, depreciationMethod: 'straight_line', decliningRate: null }, 2),
    ).toEqual(scheduleOf(plain, 2));
  });

  it('catches up and pays out path-independently, like straight line', () => {
    const at = (monthEnd: string) => scheduledAccumulated(ddb60, monthEnd, 2).toFixed(2);
    expect(at('2025-12-31')).toBe('0.00');
    expect(at('2026-12-31')).toBe('4000.00');
    // Due after 3 months booked, at the end of month 14: months 4 to 14.
    expect(
      depreciationDue({ ...ddb60, accumulatedDepreciation: '1000.00' }, '2027-02-28', 2).toFixed(2),
    ).toBe('3400.00');
    expect(at('2040-01-31')).toBe('9000.00');
    expect(cumulativeDepreciation(ddb60, 0, 2).toFixed(2)).toBe('0.00');
  });

  it('holds the invariants over a grid of terms', () => {
    const lives = [1, 2, 11, 12, 13, 23, 24, 25, 30, 36, 59, 61, 120];
    const rates = ['0.0001', '7.5', '33.3333', '50', '99.9999', '100'];
    for (const lifeMonths of lives) {
      for (const method of ['declining_balance', 'double_declining_balance'] as const) {
        for (const decliningRate of method === 'declining_balance' ? rates : [null]) {
          const a: DepreciableAsset = {
            cost: '12345.67',
            salvageValue: '345.67',
            lifeMonths,
            inServiceDate: '2026-07-04',
            depreciationMethod: method,
            decliningRate,
          };
          const rows = scheduleOf(a, 2);
          expect(rows).toHaveLength(lifeMonths);
          expect(rows.at(-1)!.accumulated).toBe('12000.00');
          let previous = decimal(0);
          for (const row of rows) {
            expect(decimal(row.amount).gte(0)).toBe(true);
            expect(decimal(row.accumulated).eq(previous.plus(row.amount))).toBe(true);
            expect(decimal(row.bookValue).gte('345.67')).toBe(true);
            previous = decimal(row.accumulated);
          }
        }
      }
    }
  });

  it('refuses a declining-balance asset without a rate', () => {
    expect(() =>
      cumulativeDepreciation({ ...ddb60, depreciationMethod: 'declining_balance' }, 3, 2),
    ).toThrow(/needs a rate/);
  });
});
