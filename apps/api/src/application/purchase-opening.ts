import type { Decimal } from 'decimal.js';
import { ValidationError, type ValidationIssue } from '../domain/errors.js';
import { convertToBase, decimal, minorUnits, parseAmount } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  findApplicableRate,
  getDesignatedAccountId,
  getDimensionValuesByIds,
  isValidIsoDate,
  openingDateFor,
  type AccountingSettings,
} from '../modules/accounting/index.js';
import type { ApprovalFacts } from '../modules/approvals/index.js';
import type { PostingLine } from '../modules/documents/index.js';
import { journalLine } from './sales-documents.js';

/**
 * Opening AP documents (ADR 0004 P4-35, P4-36; mirrors the Sales opening invoice, Phase 3B D5).
 * An opening bill is dated on or before the S8 opening date, carries no tax and no expense, and
 * posts Dr Opening Balance Equity / Cr AP control; an opening vendor credit is the reverse. A
 * foreign-currency document may carry an explicit base carrying value (S8-06); otherwise the
 * table rate on its date applies. Pure of the document tables: the services own the lifecycle.
 */

/** The conversion date must be set and the document dated on or before the opening date. */
export function openingDocumentIssues(
  accounting: AccountingSettings,
  input: { date: string; dateName: string; taxTreatment?: string | undefined; noun: string },
): void {
  const issues: ValidationIssue[] = [];
  if (!accounting.conversionDate) {
    issues.push({
      path: 'kind',
      message: `Set the conversion date under Accounting > Opening balances before entering opening ${input.noun}.`,
    });
  } else if (isValidIsoDate(input.date) && input.date > openingDateFor(accounting.conversionDate)) {
    issues.push({
      path: input.dateName,
      message: `Opening ${input.noun} are dated on or before ${openingDateFor(accounting.conversionDate)}.`,
    });
  }
  if (input.taxTreatment && input.taxTreatment !== 'no_tax') {
    issues.push({ path: 'taxTreatment', message: `Opening ${input.noun} carry no tax.` });
  }
  if (issues.length) throw new ValidationError(issues);
}

/** The explicit carrying value (foreign currency only), in base minor units. */
export function openingCarryingValue(
  accounting: AccountingSettings,
  currency: string,
  openingBaseTotal: string | null | undefined,
  noun: string,
): string | null {
  if (openingBaseTotal === undefined || openingBaseTotal === null) return null;
  if (currency === accounting.baseCurrency) {
    throw new ValidationError([
      {
        path: 'openingBaseTotal',
        message: `A base-currency ${noun} has no separate carrying value.`,
      },
    ]);
  }
  const parsed = parseAmount(openingBaseTotal, accounting.baseCurrency);
  if (!parsed.ok) {
    throw new ValidationError([
      { path: 'openingBaseTotal', message: 'Enter the base carrying value (greater than zero).' },
    ]);
  }
  return parsed.value.toFixed(4);
}

/**
 * The journal of an opening document and its approval facts (type `opening`, the AP line's base).
 * A bill is Dr OBE / Cr AP; a vendor credit is Dr AP / Cr OBE. The first line is always the AP
 * ("payable") line, the second the Opening Balance Equity line.
 */
export async function openingPurchasePosting(
  tx: Transaction,
  organizationId: string,
  accounting: AccountingSettings,
  apAccountId: string | null,
  document: {
    direction: 'bill' | 'vendor_credit';
    label: string;
    total: string;
    currencyCode: string;
    date: string;
    openingBaseTotal: string | null;
    dimensionValueIds: readonly string[];
  },
) {
  const total = decimal(document.total);
  let rate: Decimal | null = null;
  let rateSource: 'base' | 'table' | 'carrying' = 'base';
  let baseTotal: Decimal | null = null;
  if (document.currencyCode === accounting.baseCurrency) {
    rate = decimal(1);
    baseTotal = total;
  } else if (document.openingBaseTotal) {
    baseTotal = decimal(document.openingBaseTotal);
    rate = total.isZero() ? null : baseTotal.dividedBy(total).toDecimalPlaces(10);
    rateSource = 'carrying';
  } else {
    const found = await findApplicableRate(tx, {
      organizationId,
      fromCurrency: document.currencyCode,
      toCurrency: accounting.baseCurrency,
      onDate: document.date,
    });
    rateSource = 'table';
    if (found) {
      rate = decimal(found.rate);
      baseTotal = convertToBase(total, rate, accounting.baseCurrency);
    }
  }
  const values = await getDimensionValuesByIds(tx, organizationId, document.dimensionValueIds);
  const typeOf = new Map([...values].map(([valueId, v]) => [valueId, v.dimensionTypeId]));
  const obe = await getDesignatedAccountId(tx, organizationId, 'OPENING_BALANCE_EQUITY');
  const dims = [...document.dimensionValueIds].sort();
  const base = baseTotal ?? decimal(0);
  const bill = document.direction === 'bill';
  const journalLines: PostingLine[] = [
    {
      role: 'payable',
      accountId: apAccountId,
      side: bill ? 'credit' : 'debit',
      amount: total,
      description: document.label,
      dimensionValueIds: dims,
      baseAmount: base,
    },
    {
      role: 'expense',
      accountId: obe,
      side: bill ? 'debit' : 'credit',
      amount: total,
      description: document.label,
      dimensionValueIds: dims,
      baseAmount: base,
    },
  ];
  const facts: ApprovalFacts = {
    transactionType: 'opening',
    baseAmount: baseTotal ? baseTotal.toFixed(minorUnits(accounting.baseCurrency)) : null,
    baseCurrency: accounting.baseCurrency,
  };
  return {
    journal: { lines: journalLines, total, baseTotal: base },
    rate,
    rateSource,
    tableRate: null as Decimal | null,
    facts,
    typeOf,
  };
}

/** The system-journal payload of an opening document (allowlisted `opening_balance` type, E1). */
export function openingSystemJournal(input: {
  id: string;
  entryDate: string;
  description: string;
  reference: string;
  currencyCode: string;
  baseCurrency: string;
  rate: Decimal;
  rateSource: 'base' | 'table' | 'carrying';
  lines: readonly PostingLine[];
  typeOf: ReadonlyMap<string, string>;
  number: string;
}) {
  const foreign = input.currencyCode !== input.baseCurrency;
  return {
    system: {
      source: { module: 'purchases', type: 'opening_balance', id: input.id },
      entryDate: input.entryDate,
      description: input.description.slice(0, 500),
      reference: input.reference,
      currency: input.currencyCode,
      exchangeRate: foreign ? input.rate.toFixed(10) : null,
      exchangeRateSource: input.rateSource === 'table' ? ('table' as const) : ('manual' as const),
      lines: input.lines.map((l) => {
        const line = journalLine(l, input.number, input.typeOf);
        const base = l.baseAmount.toFixed(4);
        return {
          ...line,
          accountId: l.accountId!,
          kind: 'normal' as const,
          baseDebit: l.side === 'debit' ? base : null,
          baseCredit: l.side === 'credit' ? base : null,
        };
      }),
    },
  };
}
