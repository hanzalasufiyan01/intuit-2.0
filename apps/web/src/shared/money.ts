import { Decimal } from 'decimal.js';

/**
 * Display-side money helpers. Amounts stay decimal strings end to end; the server is the
 * authority for all financial calculations. decimal.js keeps client-side totals exact.
 */
const MINOR_UNITS: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

export const COMMON_CURRENCIES = ['MVR', 'USD', 'EUR', 'GBP', 'INR', 'AED', 'LKR', 'SGD'];

export function minorUnits(currency: string): number {
  return MINOR_UNITS[currency] ?? 2;
}

export function isDecimalString(value: string): boolean {
  return /^(0|[1-9]\d{0,23})(\.\d+)?$/.test(value.trim());
}

/** Sums decimal strings exactly, ignoring blanks and malformed values. */
export function sumAmounts(values: readonly (string | null | undefined)[]): Decimal {
  return values.reduce<Decimal>(
    (acc, v) => (v && isDecimalString(v) ? acc.plus(new Decimal(v.trim())) : acc),
    new Decimal(0),
  );
}

export function formatAmount(value: string | null | undefined, currency: string): string {
  if (value === null || value === undefined || value === '') return '';
  const d = new Decimal(value);
  const [whole, fraction] = d.toFixed(minorUnits(currency)).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}
