import { Decimal } from 'decimal.js';
import { decimal, minorUnits } from '../../domain/money.js';

/**
 * Tax calculation (Decisions 32–35). Pure rules.
 *
 * - Treatment is Tax Exclusive, Tax Inclusive or No Tax (organization default, document override).
 * - Discounts come before tax: gross → discount → tax → final (Decision 34).
 * - Tax is calculated and rounded per line, half-up to the currency's minor units; the document's
 *   tax is the sum of its rounded line taxes (Decision 33).
 */

export const taxTreatments = ['exclusive', 'inclusive', 'no_tax'] as const;
export type TaxTreatment = (typeof taxTreatments)[number];

export interface LineTax {
  /** Amount before tax (the revenue). */
  net: Decimal;
  tax: Decimal;
  /** Net + tax (what the customer owes for the line). */
  gross: Decimal;
}

const round = (value: Decimal, currency: string) =>
  value.toDecimalPlaces(minorUnits(currency), Decimal.ROUND_HALF_UP);

/**
 * Tax on one line whose discounted amount is `amount`. For Tax Exclusive the amount is the net;
 * for Tax Inclusive it already contains the tax, which is extracted. `ratePercent` is e.g. "8".
 */
export function lineTax(input: {
  amount: Decimal;
  ratePercent: string | null;
  treatment: TaxTreatment;
  currency: string;
}): LineTax {
  const amount = round(input.amount, input.currency);
  if (input.treatment === 'no_tax' || input.ratePercent === null) {
    return { net: amount, tax: decimal(0), gross: amount };
  }
  const rate = decimal(input.ratePercent);
  if (input.treatment === 'exclusive') {
    const tax = round(amount.times(rate).dividedBy(100), input.currency);
    return { net: amount, tax, gross: amount.plus(tax) };
  }
  const tax = round(amount.times(rate).dividedBy(rate.plus(100)), input.currency);
  return { net: amount.minus(tax), tax, gross: amount };
}

/**
 * Spreads a document-level discount over lines in proportion to their amounts (Decision 35),
 * rounded to the currency's minor units with the remainder given to the largest shares so the
 * parts add up exactly. Returns one share per line.
 */
export function allocateDiscount(
  lineAmounts: readonly Decimal[],
  discount: Decimal,
  currency: string,
): Decimal[] {
  const total = lineAmounts.reduce((sum, a) => sum.plus(a), decimal(0));
  if (discount.isZero() || total.isZero()) return lineAmounts.map(() => decimal(0));
  const unit = decimal(1).dividedBy(decimal(10).pow(minorUnits(currency)));
  const exact = lineAmounts.map((a) => discount.times(a).dividedBy(total));
  const shares = exact.map((e) => e.toDecimalPlaces(minorUnits(currency), Decimal.ROUND_DOWN));
  let remainder = discount.minus(shares.reduce((sum, s) => sum.plus(s), decimal(0)));
  const order = exact
    .map((e, i) => ({ i, fraction: e.minus(shares[i]!) }))
    .sort((a, b) => b.fraction.comparedTo(a.fraction) || a.i - b.i);
  for (const { i } of order) {
    if (remainder.lte(0)) break;
    shares[i] = shares[i]!.plus(unit);
    remainder = remainder.minus(unit);
  }
  return shares;
}
