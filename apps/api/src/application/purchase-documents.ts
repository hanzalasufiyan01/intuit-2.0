import type { Decimal } from 'decimal.js';
import { ValidationError, type ValidationIssue } from '../domain/errors.js';
import { decimal, isSupportedCurrency, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  designationsOfAccount,
  findApplicableRate,
  getAccount,
  getDimensionValuesByIds,
  isValidIsoDate,
  type AccountingSettings,
} from '../modules/accounting/index.js';
import type { ApprovalFacts } from '../modules/approvals/index.js';
import { getItem } from '../modules/catalog/index.js';
import {
  buildPurchaseJournal,
  calculateDocument,
  type Discount,
  type PostingTaxLine,
} from '../modules/documents/index.js';
import { getOrganizationProfile } from '../modules/organizations/index.js';
import { getParty } from '../modules/parties/index.js';
import type { BillLineValues, PurchasesSettings } from '../modules/purchases/index.js';
import {
  defaultTaxRecoverable,
  findRateOn,
  getTaxCode,
  purchaseTaxCodeProblem,
  splitLineTax,
  type TaxTreatment,
} from '../modules/tax/index.js';
import { getVendor, purchaseAccountProblem, type Vendor } from '../modules/vendors/index.js';

/**
 * Rules for purchase documents (ADR 0004 P4-11, P4-12, P4-16, P4-19, P4-20; brief §13, §14): draft
 * resolution and arithmetic, and the journal a document posts with its approval facts. The
 * arithmetic is the shared engine's (`calculateDocument`, Decisions 32–35) and the journal the
 * shared purchase builder's (`buildPurchaseJournal`); this module only resolves references and
 * defaults for the purchase side. Bills use it now; vendor credits will reuse it.
 *
 * Line defaults: the line's own value, then the item's purchase default, then the vendor's
 * default, then the Purchases settings default (tax code and account). Tax recoverability:
 * the line's explicit choice, otherwise the frozen P4-12 default.
 */

export interface PurchaseLineInput {
  itemId?: string | null | undefined;
  description?: string | undefined;
  quantity: string;
  unitPrice?: string | undefined;
  discount?: Discount | null | undefined;
  /** Omitted: item, vendor, then Purchases default. Null: no tax. */
  taxCodeId?: string | null | undefined;
  /** Omitted or null: item, vendor, then Purchases default expense account. */
  accountId?: string | null | undefined;
  /** P4-12: an explicit choice; omitted or null: the default applies. */
  taxRecoverable?: boolean | null | undefined;
  dimensionValueIds?: string[] | undefined;
}

export interface PurchaseBodyInput {
  vendorId: string;
  date: string;
  currencyCode?: string | undefined;
  taxTreatment?: TaxTreatment | undefined;
  discount?: Discount | null | undefined;
  memo?: string | undefined;
  dimensionValueIds?: string[] | undefined;
  lines: PurchaseLineInput[];
}

export interface StoredPurchaseLine {
  itemId: string | null;
  accountId: string | null;
  taxCodeId: string | null;
  taxRecoverableOverride: boolean | null;
  dimensionValueIds: string[];
}

export type ResolvedPurchaseLine = BillLineValues & { taxLabel: string | null };

export interface ResolvedPurchaseDocument {
  vendor: Vendor;
  header: {
    vendorId: string;
    currencyCode: string;
    taxTreatment: TaxTreatment;
    discountType: Discount['type'] | null;
    discountValue: string | null;
    memo: string;
    dimensionValueIds: string[];
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    recoverableTaxTotal: string;
    total: string;
  };
  lines: ResolvedPurchaseLine[];
}

const money = (value: Decimal) => value.toFixed(4);

/** P4-50: at most 200 lines on a bill or vendor credit. */
export const MAX_PURCHASE_LINES = 200;

/**
 * Resolves defaults, validates every reference and computes all amounts. `existing` lets a draft
 * keep references archived after it was saved; new references must be active.
 */
export async function resolvePurchaseDocument(
  tx: Transaction,
  organizationId: string,
  accounting: AccountingSettings,
  purchases: PurchasesSettings | undefined,
  input: PurchaseBodyInput,
  options: {
    datePath: string;
    noun: string;
    existing?:
      | {
          vendorId: string;
          dimensionValueIds: readonly string[];
          lines: readonly StoredPurchaseLine[];
        }
      | undefined;
  },
): Promise<ResolvedPurchaseDocument> {
  const { existing } = options;
  const issues: ValidationIssue[] = [];
  const fail = () => {
    if (issues.length) throw new ValidationError(issues);
  };
  if (!isValidIsoDate(input.date)) {
    issues.push({ path: options.datePath, message: 'Enter a valid date (YYYY-MM-DD).' });
  }
  if (input.lines.length > MAX_PURCHASE_LINES) {
    issues.push({ path: 'lines', message: `Use at most ${MAX_PURCHASE_LINES} lines.` });
  }
  // The vendor must belong to this organization (RLS and the scoped lookup) and be usable.
  const vendor = await getVendor(tx, organizationId, input.vendorId);
  if (!vendor) {
    issues.push({ path: 'vendorId', message: 'Vendor not found.' });
  } else if (vendor.id !== existing?.vendorId) {
    const party = await getParty(tx, organizationId, vendor.partyId);
    if (vendor.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
      issues.push({
        path: 'vendorId',
        message: `Archived vendors cannot get new ${options.noun}.`,
      });
    }
  }
  fail();

  // P4-20: the vendor's currency by default; any supported currency (Sales parity).
  const currencyCode = input.currencyCode ?? vendor!.currencyCode;
  if (!isSupportedCurrency(currencyCode)) {
    issues.push({ path: 'currencyCode', message: 'Unsupported currency.' });
  }
  const taxTreatment = input.taxTreatment ?? purchases?.defaultTaxTreatment ?? 'exclusive';
  fail();

  // Dimensions (D10): known values, one per type, active unless already on this document.
  const keptValues = new Set([
    ...(existing?.dimensionValueIds ?? []),
    ...(existing?.lines.flatMap((l) => l.dimensionValueIds) ?? []),
  ]);
  const values = await getDimensionValuesByIds(tx, organizationId, [
    ...(input.dimensionValueIds ?? []),
    ...input.lines.flatMap((l) => l.dimensionValueIds ?? []),
  ]);
  const checkDims = (ids: readonly string[], path: string) => {
    const types = new Set<string>();
    for (const id of ids) {
      const value = values.get(id);
      if (!value) {
        issues.push({ path, message: 'Unknown dimension value.' });
      } else if (types.has(value.dimensionTypeId)) {
        issues.push({ path, message: 'Choose only one value per dimension.' });
      } else if (
        (value.status !== 'ACTIVE' || value.typeStatus !== 'ACTIVE') &&
        !keptValues.has(id)
      ) {
        issues.push({ path, message: `${value.name} is archived and cannot be assigned.` });
      } else {
        types.add(value.dimensionTypeId);
      }
    }
  };
  checkDims(input.dimensionValueIds ?? [], 'dimensionValueIds');

  const profile = (await getOrganizationProfile(tx, organizationId))?.profile;
  const organization = {
    gstRegistered: profile?.gstRegistered ?? false,
    gstRegisteredFrom: profile?.gstRegisteredFrom ?? null,
  };
  const keptItems = new Set(existing?.lines.map((l) => l.itemId).filter(Boolean));
  const keptTaxCodes = new Set(existing?.lines.map((l) => l.taxCodeId).filter(Boolean));
  const keptAccounts = new Set(existing?.lines.map((l) => l.accountId).filter(Boolean));
  const partial: (Omit<
    ResolvedPurchaseLine,
    'amount' | 'netAmount' | 'total' | 'recoverableTax' | 'nonRecoverableTax'
  > & { ratePercent: string | null })[] = [];
  for (const [i, line] of input.lines.entries()) {
    const path = `lines.${i}`;
    checkDims(line.dimensionValueIds ?? [], `${path}.dimensionValueIds`);
    const item = line.itemId ? await getItem(tx, organizationId, line.itemId) : undefined;
    if (line.itemId && !item) issues.push({ path: `${path}.itemId`, message: 'Item not found.' });
    else if (item && item.status !== 'ACTIVE' && !keptItems.has(item.id)) {
      issues.push({ path: `${path}.itemId`, message: `${item.name} is archived.` });
    } else if (item && !item.isPurchased && !keptItems.has(item.id)) {
      // P4-05: a sales-only catalog item is not offered on purchase documents.
      issues.push({ path: `${path}.itemId`, message: `${item.name} is not purchased.` });
    }
    const description = line.description?.trim() || item?.purchaseDescription || item?.name;
    if (!description) {
      issues.push({ path: `${path}.description`, message: 'Describe the line or choose an item.' });
    }
    let unitPrice = line.unitPrice;
    if (unitPrice === undefined) {
      // Item costs are in the base currency.
      if (
        item?.purchaseUnitCost !== null &&
        item?.purchaseUnitCost !== undefined &&
        currencyCode === accounting.baseCurrency
      ) {
        unitPrice = item.purchaseUnitCost;
      } else {
        issues.push({ path: `${path}.unitPrice`, message: 'Enter a unit price.' });
      }
    }
    let taxCodeId =
      line.taxCodeId !== undefined
        ? line.taxCodeId
        : (item?.purchaseTaxCodeId ??
          vendor!.defaultTaxCodeId ??
          purchases?.defaultTaxCodeId ??
          null);
    if (taxTreatment === 'no_tax') taxCodeId = null;
    let taxRateId: string | null = null;
    let ratePercent: string | null = null;
    let taxLabel: string | null = null;
    if (taxCodeId) {
      const code = await getTaxCode(tx, organizationId, taxCodeId);
      if (!code) issues.push({ path: `${path}.taxCodeId`, message: 'Tax code not found.' });
      else if (code.status !== 'ACTIVE' && !keptTaxCodes.has(code.id)) {
        issues.push({ path: `${path}.taxCodeId`, message: `${code.code} is archived.` });
      } else if (isValidIsoDate(input.date)) {
        // Decision 15: the version in effect on the document date.
        const rate = await findRateOn(tx, organizationId, code.id, input.date);
        if (!rate) {
          issues.push({
            path: `${path}.taxCodeId`,
            message: `${code.code} has no rate in effect on ${input.date}.`,
          });
        } else {
          taxRateId = rate.id;
          ratePercent = rate.rate;
          taxLabel = `${code.code} ${decimal(rate.rate).toFixed()}%`;
        }
      }
    }
    const accountId =
      line.accountId ??
      item?.expenseAccountId ??
      vendor!.defaultExpenseAccountId ??
      purchases?.defaultExpenseAccountId ??
      null;
    if (accountId && !keptAccounts.has(accountId)) {
      // P4-19 (amended and clarified): eligible purchase accounts only; nothing inferred.
      const account = await getAccount(tx, organizationId, accountId);
      const problem = account
        ? purchaseAccountProblem({
            status: account.status,
            isLeaf: account.isLeaf,
            subtype: account.subtype,
            isControlAccount: account.isControlAccount,
            designated: (await designationsOfAccount(tx, organizationId, account.id)).length > 0,
          })
        : 'Account not found.';
      if (problem) issues.push({ path: `${path}.accountId`, message: problem });
    }
    // P4-12: the explicit choice, else organization registration on the date, item, vendor.
    const override = line.taxRecoverable ?? null;
    const recoverable =
      override ??
      (isValidIsoDate(input.date)
        ? defaultTaxRecoverable({
            organization,
            documentDate: input.date,
            itemDefault: item?.purchaseTaxRecoverable ?? null,
            vendorDefault: vendor!.defaultTaxRecoverable,
          })
        : false);
    partial.push({
      lineNo: i + 1,
      itemId: item?.id ?? null,
      description: description ?? '',
      accountId,
      quantity: line.quantity,
      unitPrice: unitPrice ?? '0',
      discountType: line.discount?.type ?? null,
      discountValue: line.discount?.value ?? null,
      lineDiscount: '0',
      documentDiscount: '0',
      taxCodeId,
      taxRateId,
      taxRate: ratePercent,
      taxAmount: '0',
      taxRecoverableOverride: override,
      taxRecoverable: recoverable,
      inputTaxAccountId: null,
      dimensionValueIds: [...new Set(line.dimensionValueIds ?? [])],
      taxLabel,
      ratePercent,
    });
  }
  fail();

  const calculated = calculateDocument({
    currency: currencyCode,
    treatment: taxTreatment,
    discount: input.discount ?? null,
    lines: partial.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discountType ? { type: l.discountType, value: l.discountValue! } : null,
      ratePercent: l.ratePercent,
    })),
  });
  if (!calculated.ok) {
    throw new ValidationError(
      calculated.problems.map((p) => ({
        path: p.line === null ? 'discount' : `lines.${p.line}.${p.field}`,
        message: p.message,
      })),
    );
  }
  const doc = calculated.document;
  let recoverableTaxTotal = decimal(0);
  const lines = partial.map(({ ratePercent: _rate, ...l }, i) => {
    const c = doc.lines[i]!;
    const split = splitLineTax(c.tax, l.taxRecoverable === true);
    recoverableTaxTotal = recoverableTaxTotal.plus(split.recoverableTax);
    return {
      ...l,
      amount: money(c.amount),
      lineDiscount: money(c.lineDiscount),
      documentDiscount: money(c.documentDiscount),
      netAmount: money(c.net),
      taxAmount: money(c.tax),
      recoverableTax: money(split.recoverableTax),
      nonRecoverableTax: money(split.nonRecoverableTax),
      total: money(c.total),
    };
  });
  return {
    vendor: vendor!,
    header: {
      vendorId: vendor!.id,
      currencyCode,
      taxTreatment,
      discountType: input.discount?.type ?? null,
      discountValue: input.discount?.value ?? null,
      memo: input.memo?.trim() ?? '',
      dimensionValueIds: [...new Set(input.dimensionValueIds ?? [])],
      subtotal: money(doc.subtotal),
      discountTotal: money(doc.discountTotal),
      taxTotal: money(doc.taxTotal),
      recoverableTaxTotal: money(recoverableTaxTotal),
      total: money(doc.total),
    },
    lines,
  };
}

export function stripPurchaseLines(lines: readonly ResolvedPurchaseLine[]): BillLineValues[] {
  return lines.map(({ taxLabel: _label, ...line }) => line);
}

/** The stored lines as input, so posting recomputes a draft with the same rules as saving. */
export function purchaseLinesAsInput(
  lines: readonly (StoredPurchaseLine & BillLineValues)[],
): PurchaseLineInput[] {
  return lines.map((l) => ({
    itemId: l.itemId ?? null,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discount: l.discountType ? { type: l.discountType, value: l.discountValue! } : null,
    taxCodeId: l.taxCodeId ?? null,
    accountId: l.accountId ?? null,
    taxRecoverable: l.taxRecoverableOverride ?? null,
    dimensionValueIds: l.dimensionValueIds ?? [],
  }));
}

/**
 * Why each taxed line cannot post (P4-11): the code's input tax account must exist and be a
 * usable asset. Returns the problems by line and the input account to snapshot per line.
 */
export async function inputTaxCheck(
  tx: Transaction,
  organizationId: string,
  lines: readonly { taxCodeId?: string | null | undefined }[],
) {
  const issues: ValidationIssue[] = [];
  const accounts: (string | null)[] = [];
  for (const [i, line] of lines.entries()) {
    if (!line.taxCodeId) {
      accounts.push(null);
      continue;
    }
    const code = await getTaxCode(tx, organizationId, line.taxCodeId);
    const account = code?.inputTaxAccountId
      ? await getAccount(tx, organizationId, code.inputTaxAccountId)
      : undefined;
    const problem = code
      ? purchaseTaxCodeProblem(
          code,
          account
            ? {
                status: account.status,
                isLeaf: account.isLeaf,
                accountType: account.accountType,
                isControlAccount: account.isControlAccount,
              }
            : null,
        )
      : 'Tax code not found.';
    if (problem) issues.push({ path: `lines.${i}.taxCodeId`, message: problem });
    accounts.push(problem ? null : code!.inputTaxAccountId);
  }
  return { issues, accounts };
}

/**
 * The journal a purchase document would post and its approval facts (P4-37: the AP line's base).
 * The rate is 1 for the base currency, the manual override when one is set (P4-16; the table
 * rate is still looked up and kept), or the table rate on the document date. Without a rate the
 * amount is unknown and amount conditions fail closed (S10-05).
 */
export async function purchaseDocumentPosting(
  tx: Transaction,
  organizationId: string,
  accounting: AccountingSettings,
  purchases: PurchasesSettings | undefined,
  document: {
    direction: 'bill' | 'vendor_credit';
    label: string;
    transactionType: string;
    date: string;
    currencyCode: string;
    dimensionValueIds: readonly string[];
    rateOverride: string | null;
  },
  lines: readonly (BillLineValues & { inputTaxAccountId?: string | null })[],
) {
  let rate: Decimal | null;
  let tableRate: Decimal | null = null;
  let rateSource: 'base' | 'table' | 'manual' = 'base';
  if (document.currencyCode === accounting.baseCurrency) {
    rate = decimal(1);
  } else {
    const found = await findApplicableRate(tx, {
      organizationId,
      fromCurrency: document.currencyCode,
      toCurrency: accounting.baseCurrency,
      onDate: document.date,
    });
    tableRate = found ? decimal(found.rate) : null;
    if (document.rateOverride) {
      rate = decimal(document.rateOverride);
      rateSource = 'manual';
    } else {
      rate = tableRate;
      rateSource = 'table';
    }
  }
  const values = await getDimensionValuesByIds(tx, organizationId, [
    ...document.dimensionValueIds,
    ...lines.flatMap((l) => l.dimensionValueIds ?? []),
  ]);
  const typeOf = new Map([...values].map(([id, v]) => [id, v.dimensionTypeId]));
  const inputTaxes: PostingTaxLine[] = [];
  for (const line of lines) {
    if (!line.taxCodeId || decimal(line.recoverableTax ?? '0').isZero()) continue;
    const code = await getTaxCode(tx, organizationId, line.taxCodeId);
    inputTaxes.push({
      taxCodeId: line.taxCodeId,
      label: `${code?.code ?? 'Tax'} ${line.taxRate ? decimal(line.taxRate).toFixed() : ''}%`,
      // P4-11: the code's input tax account (snapshotted on the line at post).
      accountId: (line.inputTaxAccountId ?? code?.inputTaxAccountId)!,
      amount: decimal(line.recoverableTax!),
    });
  }
  const journal = buildPurchaseJournal({
    direction: document.direction,
    documentLabel: document.label,
    apAccountId: purchases?.apAccountId ?? null,
    documentDimensionValueIds: document.dimensionValueIds,
    typeOf,
    lines: lines.map((l) => ({
      accountId: l.accountId ?? null,
      dimensionValueIds: l.dimensionValueIds ?? [],
      net: decimal(l.netAmount),
      nonRecoverableTax: decimal(l.nonRecoverableTax ?? '0'),
    })),
    inputTaxes,
    currency: document.currencyCode,
    baseCurrency: accounting.baseCurrency,
    rate: rate ?? decimal(1),
  });
  const facts: ApprovalFacts = {
    transactionType: document.transactionType,
    baseAmount: rate ? journal.baseTotal.toFixed(minorUnits(accounting.baseCurrency)) : null,
    baseCurrency: accounting.baseCurrency,
  };
  return { journal, rate, rateSource, tableRate, facts, typeOf };
}
