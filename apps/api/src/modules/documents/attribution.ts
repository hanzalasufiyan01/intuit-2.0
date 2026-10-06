import type { Decimal } from 'decimal.js';
import { convertToBase, decimal } from '../../domain/money.js';
import { buildPurchaseJournal, mergeDimensions } from './posting.js';

/**
 * Canonical Group Base Attribution (ADR 0004, Phase 4B-6 PD4 clarification). REPORTING ONLY.
 *
 * Posting:   document lines → canonical journal groups → GL
 * Reporting: canonical journal groups → presentation attribution → report rows
 *
 * The canonical purchase journal is rebuilt from a posted document's stored snapshots (lines, tax
 * snapshots, dimensions, rate) with the same `buildPurchaseJournal` the posting uses, so its group
 * base amounts are the authoritative accounting values. Reports that need finer rows (per line,
 * per item, net versus non-recoverable tax) attribute an authoritative group base to its member
 * lines: provisional member bases with `convertToBase`, the group's residue on the largest member
 * (ties by line order). This is a deterministic presentation allocation of an amount that is
 * already authoritative; it never feeds posting, journals, the GL or stored data.
 */

export interface AttributableLine {
  /** Line order on the document (ties are broken by it). */
  lineNo: number;
  accountId: string | null;
  dimensionValueIds: readonly string[];
  netAmount: Decimal;
  nonRecoverableTax: Decimal;
  recoverableTax: Decimal;
  taxCodeId: string | null;
  inputTaxAccountId: string | null;
}

export interface AttributedLine {
  lineNo: number;
  /** The line's share of its canonical account group base (net plus non-recoverable tax). */
  costBase: Decimal;
  nonRecoverableTaxBase: Decimal;
  /** costBase − nonRecoverableTaxBase. */
  netBase: Decimal;
  /** The line's share of its canonical tax-code group base. */
  recoverableTaxBase: Decimal;
}

export interface CanonicalGroups {
  /** Account groups in journal order: account, dimensions, authoritative base, member lines. */
  expense: {
    accountId: string | null;
    dimensionValueIds: string[];
    base: Decimal;
    lineNos: number[];
  }[];
  /** Tax-code groups in journal order. */
  tax: { taxCodeId: string; accountId: string; base: Decimal; lineNos: number[] }[];
  /** The AP line's base: the document's authoritative base total. */
  baseTotal: Decimal;
}

/**
 * Allocates an authoritative group base to member amounts: each member gets `convertToBase`, then
 * the difference to the group base goes to the largest member (the first one on a tie).
 */
export function attributeGroupBase(
  groupBase: Decimal,
  members: readonly Decimal[],
  rate: Decimal,
  baseCurrency: string,
): Decimal[] {
  const provisional = members.map((amount) => convertToBase(amount, rate, baseCurrency));
  if (members.length === 0) return provisional;
  const residue = groupBase.minus(provisional.reduce((sum, b) => sum.plus(b), decimal(0)));
  if (residue.isZero()) return provisional;
  let largest = 0;
  members.forEach((amount, i) => {
    if (amount.abs().gt(members[largest]!.abs())) largest = i;
  });
  provisional[largest] = provisional[largest]!.plus(residue);
  return provisional;
}

/**
 * Rebuilds a posted purchase document's canonical journal and attributes its group bases to the
 * document's lines. Base amounts are positive for bills and vendor credits alike; reports sign them.
 */
export function attributePurchaseDocument(input: {
  direction: 'bill' | 'vendor_credit';
  currency: string;
  baseCurrency: string;
  rate: Decimal;
  documentDimensionValueIds: readonly string[];
  typeOf: ReadonlyMap<string, string>;
  lines: readonly AttributableLine[];
}): { groups: CanonicalGroups; lines: AttributedLine[] } {
  const lines = [...input.lines].sort((a, b) => a.lineNo - b.lineNo);
  const rate = input.currency === input.baseCurrency ? decimal(1) : input.rate;
  const journal = buildPurchaseJournal({
    direction: input.direction,
    documentLabel: '',
    apAccountId: null,
    documentDimensionValueIds: input.documentDimensionValueIds,
    typeOf: input.typeOf,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      dimensionValueIds: l.dimensionValueIds,
      net: l.netAmount,
      nonRecoverableTax: l.nonRecoverableTax,
    })),
    inputTaxes: lines
      .filter((l) => l.taxCodeId && !l.recoverableTax.isZero())
      .map((l) => ({
        taxCodeId: l.taxCodeId!,
        label: '',
        accountId: l.inputTaxAccountId ?? '',
        amount: l.recoverableTax,
      })),
    currency: input.currency,
    baseCurrency: input.baseCurrency,
    rate,
  });

  // The builder's grouping, replayed to know each group's members (same keys, same order).
  const documentDims = [...input.documentDimensionValueIds].sort();
  const expenseGroups = new Map<string, number[]>();
  for (const l of lines) {
    if (l.netAmount.plus(l.nonRecoverableTax).isZero()) continue;
    const dims = mergeDimensions(l.dimensionValueIds, documentDims, input.typeOf);
    const key = `${l.accountId ?? '-'}|${dims.join(',')}`;
    expenseGroups.set(key, [...(expenseGroups.get(key) ?? []), l.lineNo]);
  }
  const taxGroups = new Map<string, number[]>();
  for (const l of lines) {
    if (!l.taxCodeId || l.recoverableTax.isZero()) continue;
    taxGroups.set(l.taxCodeId, [...(taxGroups.get(l.taxCodeId) ?? []), l.lineNo]);
  }
  const expenseLines = journal.lines.filter((l) => l.role === 'expense');
  const taxLines = journal.lines.filter((l) => l.role === 'tax');
  if (expenseLines.length !== expenseGroups.size || taxLines.length !== taxGroups.size) {
    throw new Error('The canonical journal groups do not match the document lines.');
  }
  const byNo = new Map(lines.map((l) => [l.lineNo, l]));
  const cost = new Map<number, Decimal>();
  const recoverable = new Map<number, Decimal>();
  const groups: CanonicalGroups = { expense: [], tax: [], baseTotal: journal.baseTotal };
  [...expenseGroups.values()].forEach((lineNos, i) => {
    const line = expenseLines[i]!;
    const shares = attributeGroupBase(
      line.baseAmount,
      lineNos.map((n) => byNo.get(n)!.netAmount.plus(byNo.get(n)!.nonRecoverableTax)),
      rate,
      input.baseCurrency,
    );
    lineNos.forEach((n, k) => cost.set(n, shares[k]!));
    groups.expense.push({
      accountId: line.accountId,
      dimensionValueIds: [...line.dimensionValueIds],
      base: line.baseAmount,
      lineNos,
    });
  });
  [...taxGroups.entries()].forEach(([taxCodeId, lineNos], i) => {
    const line = taxLines[i]!;
    const shares = attributeGroupBase(
      line.baseAmount,
      lineNos.map((n) => byNo.get(n)!.recoverableTax),
      rate,
      input.baseCurrency,
    );
    lineNos.forEach((n, k) => recoverable.set(n, shares[k]!));
    groups.tax.push({ taxCodeId, accountId: line.accountId ?? '', base: line.baseAmount, lineNos });
  });
  return {
    groups,
    lines: lines.map((l) => {
      const costBase = cost.get(l.lineNo) ?? decimal(0);
      const nonRecoverableTaxBase = convertToBase(l.nonRecoverableTax, rate, input.baseCurrency);
      return {
        lineNo: l.lineNo,
        costBase,
        nonRecoverableTaxBase,
        netBase: costBase.minus(nonRecoverableTaxBase),
        recoverableTaxBase: recoverable.get(l.lineNo) ?? decimal(0),
      };
    }),
  };
}
