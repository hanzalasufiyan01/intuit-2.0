import { Decimal } from 'decimal.js';
import { decimal } from '../domain/money.js';
import type { DepreciationMethod } from '../modules/fixed-assets/index.js';

/**
 * Straight-line depreciation by month (fixed assets v1, cost model, no revaluation). The month an
 * asset goes into service counts as its first month; the depreciable amount is cost less salvage,
 * spread over the life in months. Each month's charge is the difference of two rounded cumulative
 * amounts, so the total over the life is exactly the depreciable amount. Pure functions.
 */

export interface DepreciableAsset {
  cost: string;
  salvageValue: string;
  lifeMonths: number;
  inServiceDate: string;
  /** Absent or 'straight_line': the straight-line rules above, unchanged (ADR 0008 FA-04). */
  depreciationMethod?: DepreciationMethod | undefined;
  /** Annual percentage for 'declining_balance' (greater than 0, at most 100, four decimals). */
  decliningRate?: string | null | undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The last day of the month a date falls in. */
export function monthEndOf(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(last)}`;
}

/** The last day of the month before a date's month. */
export function previousMonthEnd(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m - 1, 0));
  return `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`;
}

/** The last day of the month after a month end. */
export function nextMonthEnd(monthEnd: string): string {
  const [y, m] = monthEnd.split('-').map(Number) as [number, number];
  return monthEndOf(`${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-01`);
}

/** How many months, counting the in-service month, have started by a month end (0 if none). */
export function monthsInService(inServiceDate: string, monthEnd: string): number {
  const [y1, m1] = inServiceDate.split('-').map(Number) as [number, number];
  const [y2, m2] = monthEnd.split('-').map(Number) as [number, number];
  return Math.max((y2 - y1) * 12 + (m2 - m1) + 1, 0);
}

/** The accumulated depreciation the schedule gives after `months` months of service. */
export function cumulativeDepreciation(
  asset: DepreciableAsset,
  months: number,
  scale: number,
): Decimal {
  if (isDeclining(asset)) return decimal(decliningCumulative(asset, months, scale));
  const depreciable = decimal(asset.cost).minus(asset.salvageValue);
  if (months <= 0) return decimal(0);
  if (months >= asset.lifeMonths) return depreciable.toDecimalPlaces(scale);
  return depreciable
    .times(months)
    .div(asset.lifeMonths)
    .toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
}

/** The accumulated depreciation the schedule gives by a month end. */
export function scheduledAccumulated(
  asset: DepreciableAsset,
  monthEnd: string,
  scale: number,
): Decimal {
  return cumulativeDepreciation(asset, monthsInService(asset.inServiceDate, monthEnd), scale);
}

/** What is still to be booked at a month end: the schedule less what is booked (never negative). */
export function depreciationDue(
  asset: DepreciableAsset & { accumulatedDepreciation: string },
  monthEnd: string,
  scale: number,
): Decimal {
  const due = scheduledAccumulated(asset, monthEnd, scale).minus(asset.accumulatedDepreciation);
  return due.gt(0) ? due : decimal(0);
}

export interface ScheduleRow {
  monthEnd: string;
  amount: string;
  accumulated: string;
  bookValue: string;
}

/** The whole schedule of an asset, one row per month of its life. */
export function scheduleOf(asset: DepreciableAsset, scale: number): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let monthEnd = monthEndOf(asset.inServiceDate);
  let previous = decimal(0);
  for (let month = 1; month <= asset.lifeMonths; month += 1) {
    const accumulated = cumulativeDepreciation(asset, month, scale);
    rows.push({
      monthEnd,
      amount: accumulated.minus(previous).toFixed(scale),
      accumulated: accumulated.toFixed(scale),
      bookValue: decimal(asset.cost).minus(accumulated).toFixed(scale),
    });
    previous = accumulated;
    monthEnd = nextMonthEnd(monthEnd);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Declining balance and double-declining balance (R-11; ADR 0008 FA-12)
// ---------------------------------------------------------------------------
//
// By service year (12 months from the in-service month, which counts in full). At the start of
// year k, with book value BV, remaining months R = N - 12(k - 1) and months in the year
// M = min(12, R):
//   DB = r x BV x M / 12   (double-declining: 2 x BV x M / N)
//   SL = (BV - S) x M / R
// If the asset has switched, or SL >= DB, it switches to straight line for good and the year's
// charge is SL; otherwise the charge is min(DB, BV - S). The year's charge is spread equally over
// its M months. The cumulative amount (earlier years' charges + this year's charge x m / M) is
// kept EXACT, then rounded half up to the base currency's scale and capped at C - S; from month
// N it is exactly C - S. All arithmetic is integer (native BigInt) and exact.
//
// Closed form: before the switch every full year multiplies BV by q (1 - r, or (N - 24) / N for
// double-declining), so BV stays an integer over a known denominator; the switch and cap tests
// are integer cross-multiplications, and after a switch or cap the amount is linear to salvage.

const isDeclining = (asset: DepreciableAsset) =>
  asset.depreciationMethod === 'declining_balance' ||
  asset.depreciationMethod === 'double_declining_balance';

/** A non-negative decimal string as an exact integer over a power of ten. */
function exactDecimal(value: string, field: string): { n: bigint; d: bigint } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`The fixed asset ${field} is not a non-negative decimal: ${value}`);
  const fraction = match[2] ?? '';
  return { n: BigInt(match[1]! + fraction), d: 10n ** BigInt(fraction.length) };
}

/** num / den rounded half up to `scale` decimals (both non-negative), as a decimal string. */
function roundHalfUp(num: bigint, den: bigint, scale: number): string {
  const unit = 10n ** BigInt(scale);
  const rounded = (2n * num * unit + den) / (2n * den);
  const digits = rounded.toString().padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}

/** The exact declining-balance cumulative depreciation after `months` months, rounded. */
function decliningCumulative(asset: DepreciableAsset, months: number, scale: number): string {
  const cost = exactDecimal(asset.cost, 'cost');
  const salvage = exactDecimal(asset.salvageValue, 'salvage value');
  const unit = cost.d > salvage.d ? cost.d : salvage.d; // a power of ten
  const C = cost.n * (unit / cost.d);
  const S = salvage.n * (unit / salvage.d);
  const depreciable = C - S; // over `unit`
  const N = asset.lifeMonths;
  if (months <= 0) return roundHalfUp(0n, 1n, scale);
  if (months >= N || depreciable === 0n) return roundHalfUp(depreciable, unit, scale);

  // DB charge for a year of M months = BV x dbNum x M / dbDen; full-year factor q = qNum / qDen.
  let qNum: bigint, qDen: bigint, dbNum: bigint, dbDen: bigint;
  if (asset.depreciationMethod === 'double_declining_balance') {
    [qNum, qDen, dbNum, dbDen] = [BigInt(N - 24), BigInt(N), 2n, BigInt(N)];
  } else {
    if (asset.decliningRate === null || asset.decliningRate === undefined) {
      throw new Error('A declining-balance asset needs a rate.');
    }
    const rate = exactDecimal(asset.decliningRate, 'declining rate'); // percent
    const hundredths = rate.d * 100n; // r = rate.n / hundredths
    [qNum, qDen, dbNum, dbDen] = [hundredths - rate.n, hundredths, rate.n, 12n * hundredths];
  }

  // Book value BV = bvNum / (unit x bvDen).
  let bvNum = C;
  let bvDen = 1n;
  const year = Math.ceil(months / 12);
  for (let y = 1; y <= year; y += 1) {
    const R = BigInt(N - 12 * (y - 1));
    const M = BigInt(Math.min(12, N - 12 * (y - 1)));
    const restNum = bvNum - S * bvDen; // (BV - S) x unit x bvDen
    // SL >= DB  <=>  restNum x M / R  >=  bvNum x dbNum x M / dbDen
    const switches = restNum * dbDen >= bvNum * dbNum * R;
    // DB > BV - S  <=>  bvNum x dbNum x M / dbDen  >  restNum
    const capped = !switches && bvNum * dbNum * M > restNum * dbDen;
    const intoYear = BigInt(months - 12 * (y - 1));
    let num: bigint;
    let den: bigint;
    if (switches || capped) {
      // Linear to salvage: over the R remaining months (switch) or this year's M months (cap).
      const spread = switches ? R : M;
      const done = intoYear < spread ? intoYear : spread;
      num = (C * bvDen - bvNum) * spread + restNum * done;
      den = unit * bvDen * spread;
    } else if (y === year) {
      // Declining within this year: (C - BV) + BV x dbNum x M / dbDen x m / M.
      num = (C * bvDen - bvNum) * dbDen + bvNum * dbNum * intoYear;
      den = unit * bvDen * dbDen;
    } else {
      bvNum *= qNum; // a full declining year: BV x q
      bvDen *= qDen;
      continue;
    }
    return num * unit >= depreciable * den
      ? roundHalfUp(depreciable, unit, scale)
      : roundHalfUp(num, den, scale);
  }
  throw new Error('unreachable');
}

/** Warnings shown before an asset is capitalized (non-blocking). */
export type ScheduleWarning = 'NOTHING_TO_DEPRECIATE' | 'STRAIGHT_LINE_EQUIVALENT';

/**
 * For the declining methods only: nothing to depreciate (cost equals salvage), or the complete
 * schedule equals straight line (every month's rounded cumulative amount is the same).
 */
export function scheduleWarnings(asset: DepreciableAsset, scale: number): ScheduleWarning[] {
  if (!isDeclining(asset)) return [];
  if (decimal(asset.cost).eq(asset.salvageValue)) return ['NOTHING_TO_DEPRECIATE'];
  const mine = scheduleOf(asset, scale);
  const straight = scheduleOf(
    { ...asset, depreciationMethod: 'straight_line', decliningRate: null },
    scale,
  );
  return mine.every((row, i) => row.accumulated === straight[i]!.accumulated)
    ? ['STRAIGHT_LINE_EQUIVALENT']
    : [];
}
