/**
 * Recurrence dates for recurring invoice schedules (FP-28). Occurrence n of a schedule is the
 * start date plus n periods, always counted from the START date, so a schedule that starts on the
 * 31st gives Jan 31, Feb 28 (or 29), Mar 31 and never drifts to the 28th. Pure date arithmetic on
 * ISO calendar dates (no time zones).
 */

export const frequencies = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type Frequency = (typeof frequencies)[number];

const MONTHS: Record<Exclude<Frequency, 'weekly'>, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

function parts(iso: string) {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The date of occurrence `n` (0 is the start date itself). */
export function occurrence(start: string, frequency: Frequency, n: number): string {
  if (!Number.isInteger(n) || n < 0)
    throw new RangeError('The occurrence number must be 0 or more.');
  const { y, m, d } = parts(start);
  if (frequency === 'weekly') {
    const date = new Date(Date.UTC(y, m - 1, d + 7 * n));
    return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  const totalMonths = y * 12 + (m - 1) + MONTHS[frequency] * n;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const day = Math.min(d, daysInMonth(year, month));
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}
