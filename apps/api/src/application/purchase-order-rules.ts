/** A percentage from 0 to 100 with at most four decimals. */
export function isValidDecimalPercent(value: string): boolean {
  if (!/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/.test(value)) return false;
  return Number(value) <= 100;
}
