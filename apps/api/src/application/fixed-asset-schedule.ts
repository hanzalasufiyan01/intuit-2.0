import { Decimal } from 'decimal.js';
import { decimal } from '../domain/money.js';

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
