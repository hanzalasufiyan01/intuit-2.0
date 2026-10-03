import { Decimal } from 'decimal.js';
import { convertToBase, decimal, minorUnits } from '../../domain/money.js';

/**
 * Settlement arithmetic (Decisions 10, 36–39; Phase 3B §P), shared by Sales and Purchases
 * (Phase 4 P4-04). Pure, exact decimals.
 *
 * - A receipt's parts (each allocation and any excess) are valued at the receipt rate; the
 *   receipt's base amount is their sum, so the deposit and the parts always agree.
 * - An allocation relieves the invoice's historical base in proportion to the amount; the final
 *   settlement of an invoice relieves whatever base remains, so no rounding residue is left.
 * - Realized FX is the source value minus the relieved base: positive is a gain.
 * - Applying customer credit consumes the source's historical base the same way.
 */

export interface OpenBalance {
  amountDue: Decimal;
  baseDue: Decimal;
}

/** The share of an open balance's base that `amount` relieves. */
export function relievedBase(amount: Decimal, open: OpenBalance, baseCurrency: string): Decimal {
  if (amount.gte(open.amountDue)) return open.baseDue;
  return open.baseDue
    .times(amount)
    .dividedBy(open.amountDue)
    .toDecimalPlaces(minorUnits(baseCurrency), Decimal.ROUND_HALF_UP);
}

export interface ReceiptPart {
  invoiceId: string;
  amount: Decimal;
  /** Value of this part at the receipt rate. */
  sourceBase: Decimal;
  baseRelieved: Decimal;
  fx: Decimal;
}

export function settleReceipt(input: {
  amount: Decimal;
  rate: Decimal;
  baseCurrency: string;
  allocations: readonly { invoiceId: string; amount: Decimal; open: OpenBalance }[];
}): { parts: ReceiptPart[]; unallocated: Decimal; baseUnallocated: Decimal; baseAmount: Decimal } {
  const parts = input.allocations.map((a): ReceiptPart => {
    const sourceBase = convertToBase(a.amount, input.rate, input.baseCurrency);
    const baseRelieved = relievedBase(a.amount, a.open, input.baseCurrency);
    return {
      invoiceId: a.invoiceId,
      amount: a.amount,
      sourceBase,
      baseRelieved,
      fx: sourceBase.minus(baseRelieved),
    };
  });
  const allocated = parts.reduce((sum, p) => sum.plus(p.amount), decimal(0));
  const unallocated = input.amount.minus(allocated);
  const baseUnallocated = convertToBase(unallocated, input.rate, input.baseCurrency);
  const baseAmount = parts.reduce((sum, p) => sum.plus(p.sourceBase), baseUnallocated);
  return { parts, unallocated, baseUnallocated, baseAmount };
}

/** Applying customer credit (receipt excess or credit note) to invoices of the same currency. */
export function settleCredit(input: {
  source: OpenBalance;
  baseCurrency: string;
  allocations: readonly { invoiceId: string; amount: Decimal; open: OpenBalance }[];
}): ReceiptPart[] {
  let remaining = { ...input.source };
  return input.allocations.map((a) => {
    const sourceBase = relievedBase(a.amount, remaining, input.baseCurrency);
    remaining = {
      amountDue: remaining.amountDue.minus(a.amount),
      baseDue: remaining.baseDue.minus(sourceBase),
    };
    const baseRelieved = relievedBase(a.amount, a.open, input.baseCurrency);
    return {
      invoiceId: a.invoiceId,
      amount: a.amount,
      sourceBase,
      baseRelieved,
      fx: sourceBase.minus(baseRelieved),
    };
  });
}
