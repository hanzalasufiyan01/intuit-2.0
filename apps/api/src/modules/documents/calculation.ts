import { Decimal } from 'decimal.js';
import { decimal, minorUnits } from '../../domain/money.js';
import { allocateDiscount, lineTax, type TaxTreatment } from '../tax/index.js';

/**
 * Document arithmetic (Decisions 32–35, D16), shared by Sales and Purchases (Phase 4 P4-04).
 * Pure rules, exact decimals.
 *
 * Per line: amount = quantity x unit price (rounded to the currency) -> line discount -> share of
 * the document discount (pro rata by the line's value after its own discount, Decision 35) ->
 * tax on the discounted amount, rounded per line (Decisions 33, 34). Under Tax Inclusive the
 * discounted amount contains the tax, which is extracted.
 */

export const discountTypes = ['percent', 'amount'] as const;
export type DiscountType = (typeof discountTypes)[number];
export interface Discount {
  type: DiscountType;
  value: string;
}

export interface CalculationLineInput {
  quantity: string;
  unitPrice: string;
  discount: Discount | null;
  /** The tax rate percentage in effect, or null for no tax code. */
  ratePercent: string | null;
}

export interface CalculatedLine {
  amount: Decimal;
  lineDiscount: Decimal;
  documentDiscount: Decimal;
  /** Revenue: the discounted amount before tax. */
  net: Decimal;
  tax: Decimal;
  /** Net + tax: what the customer owes for the line. */
  total: Decimal;
}

export interface CalculatedDocument {
  lines: CalculatedLine[];
  subtotal: Decimal;
  discountTotal: Decimal;
  taxTotal: Decimal;
  /** Revenue across all lines. */
  netTotal: Decimal;
  total: Decimal;
}

export type CalculationProblem =
  | { line: number | null; field: 'discount'; message: string }
  | { line: number; field: 'unitPrice' | 'quantity'; message: string };

const round = (value: Decimal, currency: string) =>
  value.toDecimalPlaces(minorUnits(currency), Decimal.ROUND_HALF_UP);

function discountAmount(
  base: Decimal,
  discount: Discount,
  currency: string,
): { ok: true; value: Decimal } | { ok: false; message: string } {
  const value = decimal(discount.value);
  if (discount.type === 'percent') {
    if (value.gt(100)) return { ok: false, message: 'A percentage discount cannot exceed 100%.' };
    return { ok: true, value: round(base.times(value).dividedBy(100), currency) };
  }
  if (value.decimalPlaces() > minorUnits(currency)) {
    return {
      ok: false,
      message: `Use at most ${minorUnits(currency)} decimal places for ${currency}.`,
    };
  }
  if (value.gt(base)) return { ok: false, message: 'The discount cannot exceed the amount.' };
  return { ok: true, value };
}

export function calculateDocument(input: {
  currency: string;
  treatment: TaxTreatment;
  discount: Discount | null;
  lines: readonly CalculationLineInput[];
}): { ok: true; document: CalculatedDocument } | { ok: false; problems: CalculationProblem[] } {
  const problems: CalculationProblem[] = [];
  const afterLine: Decimal[] = [];
  const amounts: Decimal[] = [];
  const lineDiscounts: Decimal[] = [];
  input.lines.forEach((line, i) => {
    const amount = round(decimal(line.quantity).times(decimal(line.unitPrice)), input.currency);
    amounts.push(amount);
    let lineDiscount = decimal(0);
    if (line.discount) {
      const d = discountAmount(amount, line.discount, input.currency);
      if (!d.ok) problems.push({ line: i, field: 'discount', message: d.message });
      else lineDiscount = d.value;
    }
    lineDiscounts.push(lineDiscount);
    afterLine.push(amount.minus(lineDiscount));
  });

  const beforeDocument = afterLine.reduce((sum, a) => sum.plus(a), decimal(0));
  let documentDiscount = decimal(0);
  if (input.discount) {
    const d = discountAmount(beforeDocument, input.discount, input.currency);
    if (!d.ok) problems.push({ line: null, field: 'discount', message: d.message });
    else documentDiscount = d.value;
  }
  if (problems.length) return { ok: false, problems };

  const shares = allocateDiscount(afterLine, documentDiscount, input.currency);
  const lines = input.lines.map((line, i): CalculatedLine => {
    const discounted = afterLine[i]!.minus(shares[i]!);
    const taxed = lineTax({
      amount: discounted,
      ratePercent: line.ratePercent,
      treatment: input.treatment,
      currency: input.currency,
    });
    return {
      amount: amounts[i]!,
      lineDiscount: lineDiscounts[i]!,
      documentDiscount: shares[i]!,
      net: taxed.net,
      tax: taxed.tax,
      total: taxed.gross,
    };
  });
  const sum = (pick: (l: CalculatedLine) => Decimal) =>
    lines.reduce((acc, l) => acc.plus(pick(l)), decimal(0));
  return {
    ok: true,
    document: {
      lines,
      subtotal: sum((l) => l.amount),
      discountTotal: sum((l) => l.lineDiscount.plus(l.documentDiscount)),
      taxTotal: sum((l) => l.tax),
      netTotal: sum((l) => l.net),
      total: sum((l) => l.total),
    },
  };
}

/** The due date: the document date plus the payment terms (ISO dates, UTC arithmetic). */
export function dueDateFor(documentDate: string, termsDays: number): string {
  const date = new Date(`${documentDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + termsDays);
  return date.toISOString().slice(0, 10);
}
