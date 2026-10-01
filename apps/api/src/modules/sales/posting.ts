import type { Decimal } from 'decimal.js';
import { convertLinesToBase, decimal, minorUnits } from '../../domain/money.js';

/**
 * The journal a Sales document posts (Phase 3B §Q, D10). Pure: the application resolves accounts,
 * rates and dimensions first. The same builder yields the approval amount (the AR line's base,
 * Decision 77) and the event payload, so the approved amount is exactly what posts.
 *
 * Invoice:     Dr AR control (total) / Cr revenue per account and dimensions (net of discounts) /
 *              Cr tax payable per tax code.
 * Credit note: the reverse.
 * Dimensions (D10): revenue lines carry their line's values, with document-level values filling
 * any dimension type a line does not set; tax lines and the AR line carry the document values.
 */

export interface PostingRevenueLine {
  accountId: string | null;
  dimensionValueIds: readonly string[];
  net: Decimal;
}

export interface PostingTaxLine {
  taxCodeId: string;
  label: string;
  accountId: string;
  amount: Decimal;
}

export interface PostingLine {
  role: 'receivable' | 'revenue' | 'tax';
  accountId: string | null;
  side: 'debit' | 'credit';
  amount: Decimal;
  description: string;
  dimensionValueIds: string[];
  /** Base amount at the document rate, after the engine's rounding rule. */
  baseAmount: Decimal;
}

/** Line values plus document values for dimension types the line does not set (D10). */
export function mergeDimensions(
  lineValueIds: readonly string[],
  documentValueIds: readonly string[],
  typeOf: ReadonlyMap<string, string>,
): string[] {
  const types = new Set(lineValueIds.map((id) => typeOf.get(id)));
  return [...lineValueIds, ...documentValueIds.filter((id) => !types.has(typeOf.get(id)))].sort();
}

export function buildDocumentJournal(input: {
  direction: 'invoice' | 'credit_note';
  documentLabel: string;
  arAccountId: string | null;
  documentDimensionValueIds: readonly string[];
  typeOf: ReadonlyMap<string, string>;
  revenue: readonly PostingRevenueLine[];
  taxes: readonly PostingTaxLine[];
  currency: string;
  baseCurrency: string;
  rate: Decimal;
}): { lines: PostingLine[]; total: Decimal; baseTotal: Decimal } {
  const credit = input.direction === 'invoice' ? 'credit' : 'debit';
  const debit = input.direction === 'invoice' ? 'debit' : 'credit';
  const documentDims = [...input.documentDimensionValueIds].sort();

  // Group revenue by account and dimension set; keep the first-seen order.
  const revenue = new Map<string, Omit<PostingLine, 'baseAmount'>>();
  for (const line of input.revenue) {
    if (line.net.isZero()) continue;
    const dims = mergeDimensions(line.dimensionValueIds, documentDims, input.typeOf);
    const key = `${line.accountId ?? '-'}|${dims.join(',')}`;
    const existing = revenue.get(key);
    if (existing) existing.amount = existing.amount.plus(line.net);
    else {
      revenue.set(key, {
        role: 'revenue',
        accountId: line.accountId,
        side: credit,
        amount: line.net,
        description: input.documentLabel,
        dimensionValueIds: dims,
      });
    }
  }
  const taxes = new Map<string, Omit<PostingLine, 'baseAmount'>>();
  for (const tax of input.taxes) {
    if (tax.amount.isZero()) continue;
    const existing = taxes.get(tax.taxCodeId);
    if (existing) existing.amount = existing.amount.plus(tax.amount);
    else {
      taxes.set(tax.taxCodeId, {
        role: 'tax',
        accountId: tax.accountId,
        side: credit,
        amount: tax.amount,
        description: `${input.documentLabel} — ${tax.label}`,
        dimensionValueIds: documentDims,
      });
    }
  }
  const credits = [...revenue.values(), ...taxes.values()];
  const total = credits.reduce((sum, l) => sum.plus(l.amount), decimal(0));
  const unbased: Omit<PostingLine, 'baseAmount'>[] = [
    {
      role: 'receivable',
      accountId: input.arAccountId,
      side: debit,
      amount: total,
      description: input.documentLabel,
      dimensionValueIds: documentDims,
    },
    ...credits,
  ];
  const converted =
    input.currency === input.baseCurrency
      ? unbased.map((l) => ({ baseAmount: l.amount }))
      : total.isZero()
        ? unbased.map(() => ({ baseAmount: decimal(0) }))
        : convertLinesToBase(unbased, input.rate, input.baseCurrency);
  const lines = unbased.map((l, i) => ({ ...l, baseAmount: converted[i]!.baseAmount }));
  return {
    lines,
    total,
    baseTotal: lines[0]!.baseAmount.toDecimalPlaces(minorUnits(input.baseCurrency)),
  };
}
