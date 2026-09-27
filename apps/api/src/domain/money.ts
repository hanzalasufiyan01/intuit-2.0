import { Decimal } from 'decimal.js';

/**
 * Exact money arithmetic for the accounting core. JavaScript numbers are never used for
 * monetary values: amounts travel as decimal strings and are computed with decimal.js,
 * and persisted as PostgreSQL numeric.
 */
const D = Decimal.clone({
  precision: 60,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -60,
  toExpPos: 60,
});
export type Money = Decimal;
export const decimal = (value: string | number): Decimal => new D(value);

/**
 * ISO 4217 minor units. Currencies not listed use 2 decimals (the ISO default).
 */
const MINOR_UNITS: Record<string, number> = {
  // 0 decimals
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
  // 3 decimals
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // 4 decimals
  CLF: 4,
  UYW: 4,
};

/** Active ISO 4217 currency codes accepted by the accounting core. */
export const ISO_CURRENCIES: ReadonlySet<string> = new Set(
  (
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP ' +
    'BYN BZD CAD CDF CHF CLF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP ' +
    'GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS ' +
    'KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR ' +
    'MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF ' +
    'SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD ' +
    'TZS UAH UGX USD UYI UYU UYW UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL'
  ).split(' '),
);

export function isSupportedCurrency(code: string): boolean {
  return ISO_CURRENCIES.has(code);
}

export function minorUnits(currency: string): number {
  return MINOR_UNITS[currency] ?? 2;
}

/** Exchange rates carry up to 10 decimal places. */
export const RATE_SCALE = 10;

const DECIMAL_STRING = /^(0|[1-9]\d{0,23})(\.\d+)?$/;

export type AmountProblem = 'format' | 'not_positive' | 'too_many_decimals';

/**
 * Parses a positive monetary amount given as a decimal string. It must not have more
 * decimal places than the currency's minor unit allows.
 */
export function parseAmount(
  value: string,
  currency: string,
): { ok: true; value: Decimal } | { ok: false; problem: AmountProblem } {
  if (!DECIMAL_STRING.test(value)) return { ok: false, problem: 'format' };
  const amount = new D(value);
  if (amount.lte(0)) return { ok: false, problem: 'not_positive' };
  if (amount.decimalPlaces() > minorUnits(currency))
    return { ok: false, problem: 'too_many_decimals' };
  return { ok: true, value: amount };
}

export function parseRate(value: string): { ok: true; value: Decimal } | { ok: false } {
  if (!DECIMAL_STRING.test(value)) return { ok: false };
  const rate = new D(value);
  if (rate.lte(0) || rate.decimalPlaces() > RATE_SCALE) return { ok: false };
  return { ok: true, value: rate };
}

/** Converts a transaction amount to the base currency, rounded half-up to base minor units. */
export function convertToBase(amount: Decimal, rate: Decimal, baseCurrency: string): Decimal {
  return amount.times(rate).toDecimalPlaces(minorUnits(baseCurrency), Decimal.ROUND_HALF_UP);
}

/** Canonical string for persistence: fixed to the given scale, no exponent. */
export function toFixedString(value: Decimal, scale: number): string {
  return value.toFixed(scale);
}

export interface ConvertibleLine {
  side: 'debit' | 'credit';
  amount: Decimal;
}

export interface ConvertedLine {
  side: 'debit' | 'credit';
  baseAmount: Decimal;
  roundingAdjustment: Decimal;
}

/**
 * Converts balanced transaction-currency lines to the base currency.
 *
 * Each line is converted and rounded independently; per-line rounding can leave the base
 * totals unbalanced by a few minor units. Approved rule (largest eligible line): the whole
 * difference is applied to the line with the largest transaction amount (ties: first line),
 * moving it in whichever direction balances the base totals. Eligible lines are those whose
 * adjusted base amount stays positive.
 */
export function convertLinesToBase(
  lines: readonly ConvertibleLine[],
  rate: Decimal,
  baseCurrency: string,
): ConvertedLine[] {
  const converted = lines.map((line) => ({
    side: line.side,
    baseAmount: convertToBase(line.amount, rate, baseCurrency),
    roundingAdjustment: new D(0),
  }));
  const sum = (side: 'debit' | 'credit') =>
    converted.filter((l) => l.side === side).reduce((acc, l) => acc.plus(l.baseAmount), new D(0));
  const difference = sum('debit').minus(sum('credit'));
  if (difference.isZero()) return converted;

  const order = lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => b.line.amount.comparedTo(a.line.amount) || a.index - b.index);
  for (const { index } of order) {
    const target = converted[index]!;
    // Debit line: reduce by the surplus; credit line: increase by it.
    const adjustment = target.side === 'debit' ? difference.negated() : difference;
    const adjusted = target.baseAmount.plus(adjustment);
    if (adjusted.gt(0)) {
      target.baseAmount = adjusted;
      target.roundingAdjustment = adjustment;
      return converted;
    }
  }
  throw new Error('No eligible line can absorb the base-currency rounding difference');
}
