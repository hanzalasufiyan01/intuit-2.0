import type { Decimal } from 'decimal.js';
import { convertLinesToBase, decimal, minorUnits } from '../../domain/money.js';

/**
 * The journal a Sales document posts (Phase 3B §Q, D10); shared engine since Phase 4 (P4-04).
 * Pure: the application resolves accounts,
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
  /** Sales: receivable, revenue, tax. Purchases (P4-12): payable, expense, tax. */
  role: 'receivable' | 'revenue' | 'tax' | 'payable' | 'expense';
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

/** A purchase line for posting: its account, dimensions, net and capitalized tax (P4-12). */
export interface PostingPurchaseLine {
  accountId: string | null;
  dimensionValueIds: readonly string[];
  net: Decimal;
  /** Non-recoverable tax, added to the line's own account (capitalized into the cost). */
  nonRecoverableTax: Decimal;
}

/**
 * The journal a purchase document posts (ADR 0004 architecture rules, P4-11, P4-12):
 * Dr each line's account (net plus non-recoverable tax) / Dr input tax per code (recoverable tax,
 * on the code's input tax account) / Cr AP control (total). A vendor credit is the reverse.
 * It reuses the Sales builder (same grouping, dimension merge D10 and base conversion), shaped
 * like a credit note, and only renames the line roles; Sales output is unchanged.
 */
export function buildPurchaseJournal(input: {
  direction: 'bill' | 'vendor_credit';
  documentLabel: string;
  apAccountId: string | null;
  documentDimensionValueIds: readonly string[];
  typeOf: ReadonlyMap<string, string>;
  lines: readonly PostingPurchaseLine[];
  inputTaxes: readonly PostingTaxLine[];
  currency: string;
  baseCurrency: string;
  rate: Decimal;
}): { lines: PostingLine[]; total: Decimal; baseTotal: Decimal } {
  const built = buildDocumentJournal({
    direction: input.direction === 'bill' ? 'credit_note' : 'invoice',
    documentLabel: input.documentLabel,
    arAccountId: input.apAccountId,
    documentDimensionValueIds: input.documentDimensionValueIds,
    typeOf: input.typeOf,
    revenue: input.lines.map((l) => ({
      accountId: l.accountId,
      dimensionValueIds: l.dimensionValueIds,
      net: l.net.plus(l.nonRecoverableTax),
    })),
    taxes: input.inputTaxes,
    currency: input.currency,
    baseCurrency: input.baseCurrency,
    rate: input.rate,
  });
  const roles = { receivable: 'payable', revenue: 'expense', tax: 'tax' } as const;
  return {
    ...built,
    lines: built.lines.map((l) => ({
      ...l,
      role: roles[l.role as keyof typeof roles],
    })),
  };
}
