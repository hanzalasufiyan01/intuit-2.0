import type { Decimal } from 'decimal.js';
import { AppError, ValidationError, type ValidationIssue } from '../domain/errors.js';
import { decimal, isSupportedCurrency, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  findApplicableRate,
  findPeriodForDate,
  getAccount,
  getAccountFacts,
  getDimensionValuesByIds,
  isValidIsoDate,
  listDimensionTypes,
  requiredTypesForAccount,
  type AccountingSettings,
} from '../modules/accounting/index.js';
import { getApprovalRequest, type ApprovalFacts } from '../modules/approvals/index.js';
import { customerIdsOfParties, getCustomer, type Customer } from '../modules/customers/index.js';
import { getOrganizationProfile } from '../modules/organizations/index.js';
import { getParty, getPartyDetail, partyIdsMatching } from '../modules/parties/index.js';
import {
  buildDocumentJournal,
  calculateDocument,
  getItem,
  takeNextNumber,
  type Discount,
  type InvoiceLineValues,
  type PostingLine,
  type SalesDocumentType,
  type SalesSettings,
} from '../modules/sales/index.js';
import { findRateOn, getTaxCode, type TaxTreatment } from '../modules/tax/index.js';
import type { ApprovalService } from './approval-service.js';

/**
 * Rules shared by invoices and credit notes (Phase 3B steps 6, 7, 12; Decisions 15, 16, 21, 32–35;
 * D7, D9, D10): draft resolution and arithmetic, the journal a document posts and its approval
 * facts, the issue checks, numbering and the frozen rendering data.
 */

export interface DocumentLineInput {
  itemId?: string | null | undefined;
  description?: string | undefined;
  quantity: string;
  unitPrice?: string | undefined;
  discount?: Discount | null | undefined;
  /** Omitted: the item's tax code, or the Sales default for lines without an item. */
  taxCodeId?: string | null | undefined;
  /** Omitted: the item's revenue account; null: the Sales default revenue account. */
  revenueAccountId?: string | null | undefined;
  dimensionValueIds?: string[] | undefined;
}

export interface DocumentBodyInput {
  customerId: string;
  /** The document date: invoice date or credit date. */
  date: string;
  currencyCode?: string | undefined;
  taxTreatment?: TaxTreatment | undefined;
  discount?: Discount | null | undefined;
  reference?: string | null | undefined;
  memo?: string | undefined;
  dimensionValueIds?: string[] | undefined;
  lines: DocumentLineInput[];
}

/** Lines are stored identically for invoices and credit notes. */
export type DocumentLineValues = InvoiceLineValues;

export interface StoredDocumentLine extends DocumentLineValues {
  id?: string;
}

export interface ResolvedDocumentLine extends DocumentLineValues {
  taxLabel: string | null;
  taxAccountId: string | null;
}

export interface ResolvedDocument {
  customer: Customer;
  header: {
    customerId: string;
    currencyCode: string;
    taxTreatment: TaxTreatment;
    discountType: Discount['type'] | null;
    discountValue: string | null;
    reference: string | null;
    memo: string;
    dimensionValueIds: string[];
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    total: string;
  };
  lines: ResolvedDocumentLine[];
}

const money = (value: Decimal) => value.toFixed(4);

/**
 * Resolves defaults (customer currency, Sales settings, item values), validates every reference
 * and computes all amounts. `existing` lets a draft keep references archived after it was saved;
 * new references must be active. `datePath` names the date field in validation messages.
 */
export async function resolveDocument(
  tx: Transaction,
  organizationId: string,
  accounting: AccountingSettings,
  sales: SalesSettings | undefined,
  input: DocumentBodyInput,
  options: {
    datePath: string;
    noun: string;
    existing?:
      | {
          customerId: string;
          dimensionValueIds: readonly string[];
          lines: readonly StoredDocumentLine[];
        }
      | undefined;
  },
): Promise<ResolvedDocument> {
  const { existing } = options;
  const issues: ValidationIssue[] = [];
  const fail = () => {
    if (issues.length) throw new ValidationError(issues);
  };
  if (!isValidIsoDate(input.date)) {
    issues.push({ path: options.datePath, message: 'Enter a valid date (YYYY-MM-DD).' });
  }
  const customer = await getCustomer(tx, organizationId, input.customerId);
  if (!customer) {
    issues.push({ path: 'customerId', message: 'Customer not found.' });
  } else if (customer.id !== existing?.customerId) {
    const party = await getParty(tx, organizationId, customer.partyId);
    if (customer.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
      issues.push({
        path: 'customerId',
        message: `Archived customers cannot get new ${options.noun}.`,
      });
    }
  }
  fail();

  const currencyCode = input.currencyCode ?? customer!.currencyCode;
  if (!isSupportedCurrency(currencyCode)) {
    issues.push({ path: 'currencyCode', message: 'Unsupported currency.' });
  }
  const taxTreatment = input.taxTreatment ?? sales?.defaultTaxTreatment ?? 'exclusive';
  fail();

  // Dimensions: known values, one per type, active unless already on this document.
  const keptValues = new Set([
    ...(existing?.dimensionValueIds ?? []),
    ...(existing?.lines.flatMap((l) => l.dimensionValueIds ?? []) ?? []),
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

  const keptItems = new Set(existing?.lines.map((l) => l.itemId).filter(Boolean));
  const keptTaxCodes = new Set(existing?.lines.map((l) => l.taxCodeId).filter(Boolean));
  const keptAccounts = new Set(existing?.lines.map((l) => l.revenueAccountId).filter(Boolean));
  const partial: (Omit<ResolvedDocumentLine, 'amount' | 'netAmount' | 'total'> & {
    ratePercent: string | null;
  })[] = [];
  for (const [i, line] of input.lines.entries()) {
    const path = `lines.${i}`;
    checkDims(line.dimensionValueIds ?? [], `${path}.dimensionValueIds`);
    const item = line.itemId ? await getItem(tx, organizationId, line.itemId) : undefined;
    if (line.itemId && !item) issues.push({ path: `${path}.itemId`, message: 'Item not found.' });
    else if (item && item.status !== 'ACTIVE' && !keptItems.has(item.id)) {
      issues.push({ path: `${path}.itemId`, message: `${item.name} is archived.` });
    }
    const description = line.description?.trim() || item?.name;
    if (!description) {
      issues.push({ path: `${path}.description`, message: 'Describe the line or choose an item.' });
    }
    let unitPrice = line.unitPrice;
    if (unitPrice === undefined) {
      // Item prices are in the base currency.
      if (
        item?.unitPrice !== null &&
        item?.unitPrice !== undefined &&
        currencyCode === accounting.baseCurrency
      ) {
        unitPrice = item.unitPrice;
      } else {
        issues.push({ path: `${path}.unitPrice`, message: 'Enter a unit price.' });
      }
    }
    let taxCodeId =
      line.taxCodeId !== undefined
        ? line.taxCodeId
        : item
          ? item.taxCodeId
          : (sales?.defaultTaxCodeId ?? null);
    if (taxTreatment === 'no_tax') taxCodeId = null;
    let taxRateId: string | null = null;
    let ratePercent: string | null = null;
    let taxLabel: string | null = null;
    let taxAccountId: string | null = null;
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
          taxAccountId = code.taxAccountId;
        }
      }
    }
    const revenueAccountId =
      line.revenueAccountId !== undefined
        ? line.revenueAccountId
        : (item?.revenueAccountId ?? null);
    if (revenueAccountId && !keptAccounts.has(revenueAccountId)) {
      const account = await getAccount(tx, organizationId, revenueAccountId);
      const accountPath = `${path}.revenueAccountId`;
      if (!account) issues.push({ path: accountPath, message: 'Account not found.' });
      else if (account.status !== 'ACTIVE' || !account.isLeaf) {
        issues.push({ path: accountPath, message: 'Choose an active posting account.' });
      } else if (account.accountType !== 'REVENUE' || account.isControlAccount) {
        issues.push({ path: accountPath, message: 'Choose a revenue account.' });
      } else if (account.currencyCode !== accounting.baseCurrency) {
        issues.push({ path: accountPath, message: 'The revenue account is in the base currency.' });
      }
    }
    partial.push({
      lineNo: i + 1,
      itemId: item?.id ?? null,
      description: description ?? '',
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
      revenueAccountId,
      dimensionValueIds: [...new Set(line.dimensionValueIds ?? [])],
      taxLabel,
      taxAccountId,
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
  return {
    customer: customer!,
    header: {
      customerId: customer!.id,
      currencyCode,
      taxTreatment,
      discountType: input.discount?.type ?? null,
      discountValue: input.discount?.value ?? null,
      reference: input.reference?.trim() || null,
      memo: input.memo?.trim() ?? '',
      dimensionValueIds: [...new Set(input.dimensionValueIds ?? [])],
      subtotal: money(doc.subtotal),
      discountTotal: money(doc.discountTotal),
      taxTotal: money(doc.taxTotal),
      total: money(doc.total),
    },
    lines: partial.map(({ ratePercent: _rate, ...l }, i) => {
      const c = doc.lines[i]!;
      return {
        ...l,
        amount: money(c.amount),
        lineDiscount: money(c.lineDiscount),
        documentDiscount: money(c.documentDiscount),
        netAmount: money(c.net),
        taxAmount: money(c.tax),
        total: money(c.total),
      };
    }),
  };
}

export function stripLines(lines: readonly ResolvedDocumentLine[]): DocumentLineValues[] {
  return lines.map(({ taxLabel: _label, taxAccountId: _account, ...line }) => line);
}

/** The stored lines as input, so issue recomputes a draft with the same rules as saving. */
export function linesAsInput(lines: readonly StoredDocumentLine[]): DocumentLineInput[] {
  return lines.map((l) => ({
    itemId: l.itemId ?? null,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discount: l.discountType ? { type: l.discountType, value: l.discountValue! } : null,
    taxCodeId: l.taxCodeId ?? null,
    revenueAccountId: l.revenueAccountId ?? null,
    dimensionValueIds: l.dimensionValueIds ?? [],
  }));
}

/**
 * The journal a document would post and its approval facts (Decision 77). The rate is 1 for the
 * base currency, `fixedRate` when given (a credit note follows its invoice's rate), or the table
 * rate on the document date (D9). Without a rate the amount is unknown and amount conditions
 * fail closed (S10-05).
 */
export async function documentPosting(
  tx: Transaction,
  organizationId: string,
  accounting: AccountingSettings,
  sales: SalesSettings | undefined,
  document: {
    direction: 'invoice' | 'credit_note';
    label: string;
    transactionType: string;
    date: string;
    currencyCode: string;
    dimensionValueIds: readonly string[];
    fixedRate?: { rate: string; source: 'invoice' } | null | undefined;
  },
  lines: readonly StoredDocumentLine[],
) {
  let rate: Decimal | null = null;
  let rateSource: 'base' | 'table' | 'invoice' = 'base';
  if (document.currencyCode === accounting.baseCurrency) {
    rate = decimal(1);
  } else if (document.fixedRate) {
    rate = decimal(document.fixedRate.rate);
    rateSource = 'invoice';
  } else {
    const found = await findApplicableRate(tx, {
      organizationId,
      fromCurrency: document.currencyCode,
      toCurrency: accounting.baseCurrency,
      onDate: document.date,
    });
    if (found) rate = decimal(found.rate);
    rateSource = 'table';
  }
  const values = await getDimensionValuesByIds(tx, organizationId, [
    ...document.dimensionValueIds,
    ...lines.flatMap((l) => l.dimensionValueIds ?? []),
  ]);
  const typeOf = new Map([...values].map(([id, v]) => [id, v.dimensionTypeId]));
  const taxes = [];
  for (const line of lines) {
    if (!line.taxCodeId || decimal(line.taxAmount ?? '0').isZero()) continue;
    const code = await getTaxCode(tx, organizationId, line.taxCodeId);
    taxes.push({
      taxCodeId: line.taxCodeId,
      label: `${code?.code ?? 'Tax'} ${line.taxRate ? decimal(line.taxRate).toFixed() : ''}%`,
      accountId: code!.taxAccountId,
      amount: decimal(line.taxAmount!),
    });
  }
  const journal = buildDocumentJournal({
    direction: document.direction,
    documentLabel: document.label,
    arAccountId: sales?.arAccountId ?? null,
    documentDimensionValueIds: document.dimensionValueIds,
    typeOf,
    revenue: lines.map((l) => ({
      accountId: l.revenueAccountId ?? sales?.defaultRevenueAccountId ?? null,
      dimensionValueIds: l.dimensionValueIds ?? [],
      net: decimal(l.netAmount),
    })),
    taxes,
    currency: document.currencyCode,
    baseCurrency: accounting.baseCurrency,
    rate: rate ?? decimal(1),
  });
  const facts: ApprovalFacts = {
    transactionType: document.transactionType,
    baseAmount: rate ? journal.baseTotal.toFixed(minorUnits(accounting.baseCurrency)) : null,
    baseCurrency: accounting.baseCurrency,
  };
  return { journal, rate, rateSource, facts, typeOf };
}

export async function assertOpenPeriod(tx: Transaction, organizationId: string, date: string) {
  const period = await findPeriodForDate(tx, organizationId, date);
  if (!period) throw new AppError('PERIOD_NOT_FOUND', 409, `No accounting period covers ${date}.`);
  if (period.status !== 'OPEN') {
    throw new AppError('PERIOD_CLOSED', 409, `The accounting period ${period.name} is closed.`);
  }
}

/** D10 / Decision 78: required dimensions are enforced at issue on the lines they apply to. */
export async function assertRequiredDimensions(
  tx: Transaction,
  organizationId: string,
  lines: readonly PostingLine[],
  typeOf: ReadonlyMap<string, string>,
) {
  const facts = await getAccountFacts(
    tx,
    organizationId,
    lines.map((l) => l.accountId!).filter(Boolean),
  );
  const types = await listDimensionTypes(tx, organizationId);
  const issues = new Map<string, ValidationIssue>();
  for (const line of lines) {
    const account = facts.get(line.accountId!);
    if (!account?.accountType) continue;
    const assigned = new Set(line.dimensionValueIds.map((id) => typeOf.get(id)));
    for (const type of requiredTypesForAccount(
      { accountType: account.accountType, subtype: account.subtype ?? null },
      types,
    )) {
      if (assigned.has(type.id)) continue;
      const issue = {
        path: line.role === 'revenue' ? 'lines' : 'dimensionValueIds',
        message: `${type.name} is required for ${
          line.role === 'revenue'
            ? 'revenue lines'
            : line.role === 'tax'
              ? 'the tax line'
              : 'the receivable'
        }.`,
      };
      issues.set(`${issue.path}|${issue.message}`, issue);
    }
  }
  if (issues.size)
    throw new ValidationError([...issues.values()], 'Required dimensions are missing.');
}

/** The next number of a sequence, skipping numbers already used (e.g. after a prefix change). */
export async function nextDocumentNumber(
  tx: Transaction,
  organizationId: string,
  type: SalesDocumentType,
  used: (number: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const taken = await takeNextNumber(tx, organizationId, type);
    if (!taken) {
      throw new ValidationError([
        { path: 'numbering', message: 'Save the Sales settings before issuing Sales documents.' },
      ]);
    }
    if (!(await used(taken.number))) return taken.number;
  }
  throw new AppError(
    'CONFLICT',
    409,
    'Could not find a free document number; check the numbering.',
  );
}

/** One event-journal line from a posting line (dimensions as type/value pairs). */
export function journalLine(
  line: PostingLine,
  number: string,
  typeOf: ReadonlyMap<string, string>,
) {
  const amount = line.amount.toFixed(4);
  return {
    accountId: line.accountId,
    description: line.description.replace('(draft)', number),
    debit: line.side === 'debit' ? amount : null,
    credit: line.side === 'credit' ? amount : null,
    dimensions: line.dimensionValueIds.map((valueId) => ({
      dimensionTypeId: typeOf.get(valueId)!,
      dimensionValueId: valueId,
    })),
  };
}

/** Everything a PDF needs, frozen at issue (Decision 21). */
export async function renderSnapshot(
  tx: Transaction,
  organizationId: string,
  document: {
    documentType: 'invoice' | 'credit_note';
    number: string;
    customerId: string;
    currencyCode: string;
    taxTreatment: string;
    reference: string | null;
    memo: string;
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    total: string;
    dates: Record<string, string | null>;
    extra?: Record<string, unknown>;
  },
  lines: readonly StoredDocumentLine[],
): Promise<Record<string, unknown>> {
  const customer = await getCustomer(tx, organizationId, document.customerId);
  const party = customer ? await getPartyDetail(tx, organizationId, customer.partyId) : undefined;
  const organization = await getOrganizationProfile(tx, organizationId);
  const profile = organization?.profile;
  const sellerAddress =
    organization?.addresses.find((a) => a.kind === 'business') ??
    organization?.addresses.find((a) => a.kind === 'registered') ??
    null;
  const billing =
    party?.addresses.find((a) => a.kind === 'billing' && a.isDefault) ??
    party?.addresses.find((a) => a.kind === 'billing') ??
    null;
  const address = (
    a: {
      line1: string;
      line2: string | null;
      city: string | null;
      region: string | null;
      postalCode: string | null;
      countryCode: string;
    } | null,
  ) =>
    a
      ? {
          line1: a.line1,
          line2: a.line2,
          city: a.city,
          region: a.region,
          postalCode: a.postalCode,
          countryCode: a.countryCode,
        }
      : null;
  const taxCodes = new Map<string, string>();
  for (const l of lines) {
    if (l.taxCodeId && !taxCodes.has(l.taxCodeId)) {
      taxCodes.set(l.taxCodeId, (await getTaxCode(tx, organizationId, l.taxCodeId))?.code ?? '');
    }
  }
  return {
    version: 1,
    documentType: document.documentType,
    number: document.number,
    ...document.dates,
    currencyCode: document.currencyCode,
    taxTreatment: document.taxTreatment,
    reference: document.reference,
    memo: document.memo,
    ...document.extra,
    seller: profile
      ? {
          legalName: profile.legalName,
          tradingName: profile.tradingName,
          tin: profile.tin,
          gstRegistrationNumber: profile.gstRegistrationNumber,
          email: profile.email,
          phone: profile.phone,
          // The logo as it was at issue; the PDF job reads this file (Decision 21).
          logoFileId: profile.logoFileId ?? null,
          address: address(sellerAddress),
        }
      : null,
    customer: party
      ? {
          displayName: party.party.displayName,
          companyName: party.party.companyName,
          tin: party.party.tin,
          email: party.party.email,
          billingAddress: address(billing),
        }
      : null,
    lines: lines.map((l) => ({
      description: l.description,
      quantity: decimal(l.quantity).toFixed(),
      unitPrice: decimal(l.unitPrice).toFixed(),
      amount: l.amount,
      discount: decimal(l.lineDiscount ?? '0')
        .plus(decimal(l.documentDiscount ?? '0'))
        .toFixed(4),
      taxCode: l.taxCodeId ? taxCodes.get(l.taxCodeId) : null,
      taxRate: l.taxRate ?? null,
      taxAmount: l.taxAmount ?? '0',
      total: l.total,
    })),
    totals: {
      subtotal: document.subtotal,
      discountTotal: document.discountTotal,
      taxTotal: document.taxTotal,
      total: document.total,
    },
  };
}

/** A customer's display name. */
export async function customerName(tx: Transaction, organizationId: string, customerId: string) {
  const customer = await getCustomer(tx, organizationId, customerId);
  const party = customer ? await getParty(tx, organizationId, customer.partyId) : undefined;
  return party?.displayName ?? null;
}

/**
 * A document's approval state; "approved, ready to issue" is derived from its request, never
 * stored (D1, the S8-03 pattern). An approval covers the steps it was given (S10-06): a step
 * that now applies but was not in the approved snapshot (e.g. the amount rose with a rate)
 * needs a new approval.
 */
export async function documentApprovalState(
  approvals: ApprovalService,
  tx: Transaction,
  organizationId: string,
  actionKey: string,
  document: { status: string; approvalRequestId: string | null },
  facts: ApprovalFacts | null,
) {
  const requirement = facts
    ? await approvals.requirementFor(tx, organizationId, actionKey, facts)
    : { required: false, steps: [] };
  const request = document.approvalRequestId
    ? await getApprovalRequest(tx, organizationId, document.approvalRequestId)
    : undefined;
  const progress = request ? await approvals.progress(tx, organizationId, request) : null;
  const approved = request?.status === 'approved';
  const snapshotOrders = new Set(request?.policySnapshot.steps.map((s) => s.order) ?? []);
  const uncovered = requirement.steps.filter((s) => !snapshotOrders.has(s.order));
  return {
    required: request ? true : requirement.required,
    requestId: request?.id ?? null,
    requestStatus: request?.status ?? null,
    steps: progress?.progress.steps ?? [],
    facts: request?.policySnapshot.facts ?? facts,
    appliedSteps: (request ? request.policySnapshot.steps : requirement.steps).map((step) => ({
      order: step.order,
      name: step.name,
      requiredApprovals: step.requiredApprovals,
      conditions: step.conditions ?? null,
    })),
    readyToIssue:
      (document.status === 'DRAFT' && !requirement.required) ||
      (document.status === 'PENDING_APPROVAL' && approved && uncovered.length === 0),
    approvalOutdated: document.status === 'PENDING_APPROVAL' && approved && uncovered.length > 0,
  };
}

export const shownMoney = (value: string | null, currency: string) =>
  value === null ? null : decimal(value).toFixed(minorUnits(currency));

/** A stored line as the API shows it. */
export function documentLineView(
  l: StoredDocumentLine & { id: string; lineNo: number },
  currency: string,
) {
  return {
    id: l.id,
    lineNo: l.lineNo,
    itemId: l.itemId ?? null,
    description: l.description,
    quantity: decimal(l.quantity).toFixed(),
    unitPrice: decimal(l.unitPrice).toFixed(),
    discount: l.discountType
      ? { type: l.discountType, value: decimal(l.discountValue!).toFixed() }
      : null,
    amount: shownMoney(l.amount, currency),
    lineDiscount: shownMoney(l.lineDiscount ?? '0', currency),
    documentDiscount: shownMoney(l.documentDiscount ?? '0', currency),
    netAmount: shownMoney(l.netAmount, currency),
    taxCodeId: l.taxCodeId ?? null,
    taxRate: l.taxRate ? decimal(l.taxRate).toFixed() : null,
    taxAmount: shownMoney(l.taxAmount ?? '0', currency),
    total: shownMoney(l.total, currency),
    revenueAccountId: l.revenueAccountId ?? null,
    dimensionValueIds: l.dimensionValueIds ?? [],
  };
}

/** Customers whose name, reference, email or TIN match a search (D15: documents by customer). */
export function customersMatching(organizationId: string, search: string | null) {
  return search
    ? customerIdsOfParties(organizationId, partyIdsMatching(organizationId, search))
    : undefined;
}
