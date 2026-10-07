/** Client views of the Purchases API (Phase 4). Amounts are decimal strings computed by the server. */

export interface VendorSummary {
  id: string;
  partyId: string;
  kind: 'organization' | 'individual';
  displayName: string;
  companyName: string | null;
  reference: string | null;
  tin: string | null;
  email: string | null;
  phone: string | null;
  partyStatus: 'ACTIVE' | 'ARCHIVED';
  partyVersion: number;
  currencyCode: string;
  paymentTermsDays: number | null;
  creditLimit: string | null;
  accountNumber: string | null;
  defaultExpenseAccountId: string | null;
  defaultTaxCodeId: string | null;
  /** Default tax recoverability of bill lines (P4-12); null = no default. */
  defaultTaxRecoverable: boolean | null;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
}

export interface VendorDetail extends VendorSummary {
  roles: string[];
  addresses: {
    id: string;
    kind: 'billing' | 'delivery';
    line1: string;
    line2: string | null;
    city: string | null;
    countryCode: string;
    isDefault: boolean;
  }[];
  contacts: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  }[];
  warnings?: { code: string; message: string }[];
}

/** A nullable recoverability default as a select value, and back (P4-12). */
export type RecoverableChoice = '' | 'true' | 'false';
export const toRecoverableChoice = (value: boolean | null | undefined): RecoverableChoice =>
  value === true ? 'true' : value === false ? 'false' : '';
export const fromRecoverableChoice = (value: RecoverableChoice): boolean | null =>
  value === '' ? null : value === 'true';

/** Account subtypes a purchase may post to (mirrors the server's P4-19 rule; display only). */
export const PURCHASE_ACCOUNT_SUBTYPES = [
  'OPERATING_EXPENSE',
  'OTHER_EXPENSE',
  'COST_OF_SALES',
  'FIXED_ASSET',
  'OTHER_ASSET',
  'OTHER_CURRENT_ASSET',
] as const;

/** Purchases document types with their own numbering (ADR 0004 P4-51). */
export const PURCHASE_DOCUMENT_TYPES = [
  'bill',
  'vendor_credit',
  'debit_note',
  'vendor_payment',
  'vendor_refund',
  'expense',
] as const;
export type PurchaseDocumentType = (typeof PURCHASE_DOCUMENT_TYPES)[number];

/** Purchases settings and numbering (Phase 4A-4; P4-07, P4-08, P4-51). */
export interface PurchasesSettings {
  configured: boolean;
  version: number;
  apAccountId: string | null;
  defaultExpenseAccountId: string | null;
  defaultPaymentAccountId: string | null;
  defaultTaxCodeId: string | null;
  defaultTaxTreatment: 'exclusive' | 'inclusive' | 'no_tax';
  defaultPaymentTermsDays: number;
  apLocked: boolean;
  suggestedApAccountId: string | null;
  numbering: Record<
    PurchaseDocumentType,
    { prefix: string; minDigits: number; nextNumber: number; preview: string }
  >;
}

// ---------------------------------------------------------------------------
// Bills (Phase 4A-5; P4-15 to P4-22)
// ---------------------------------------------------------------------------

export type BillStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'POSTED' | 'VOID';

export interface BillSummary {
  id: string;
  kind: 'standard';
  status: BillStatus;
  number: string | null;
  vendorId: string;
  vendorName: string | null;
  vendorReference: string | null;
  billDate: string;
  dueDate: string;
  currencyCode: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  recoverableTaxTotal: string;
  total: string;
  amountDue: string | null;
  baseTotal: string | null;
  baseDue: string | null;
  version: number;
  postedAt: string | null;
  voidedAt: string | null;
}

export interface BillLine {
  id: string;
  lineNo: number;
  itemId: string | null;
  description: string;
  accountId: string | null;
  quantity: string;
  unitPrice: string;
  discount: { type: 'percent' | 'amount'; value: string } | null;
  amount: string;
  netAmount: string;
  taxCodeId: string | null;
  taxRate: string | null;
  taxAmount: string;
  taxRecoverable: boolean;
  taxRecoverableOverride: boolean | null;
  recoverableTax: string;
  nonRecoverableTax: string;
  inputTaxAccountId: string | null;
  total: string;
  dimensionValueIds: string[];
}

export interface BillDetail extends BillSummary {
  paymentTermsDays: number | null;
  exchangeRate: string | null;
  exchangeRateSource: 'base' | 'table' | 'manual' | null;
  tableRate: string | null;
  rateOverride: string | null;
  rateOverrideReason: string | null;
  taxTreatment: 'exclusive' | 'inclusive' | 'no_tax';
  discount: { type: 'percent' | 'amount'; value: string } | null;
  memo: string;
  dimensionValueIds: string[];
  duplicateConfirmedReason: string | null;
  journalId: string | null;
  voidReason: string | null;
  voidJournalId: string | null;
  createdByUserId: string;
  baseCurrency: string;
  lines: BillLine[];
  approval: {
    required: boolean;
    requestId: string | null;
    requestStatus: 'pending' | 'approved' | 'rejected' | 'withdrawn' | null;
    facts: {
      transactionType: string;
      baseAmount: string | null;
      baseCurrency: string | null;
    } | null;
    appliedSteps: { order: number; name: string; requiredApprovals: number }[];
    readyToIssue: boolean;
    approvalOutdated: boolean;
  };
  warnings: { code: string; message: string }[];
}

// ---------------------------------------------------------------------------
// Vendor credits and debit notes (Phase 4B-1; P4-23, P4-24)
// ---------------------------------------------------------------------------

export type VendorCreditOrigin = 'supplier_credit_note' | 'debit_note';
export type VendorCreditStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'POSTED' | 'VOID';

export interface VendorCreditSummary {
  id: string;
  origin: VendorCreditOrigin;
  status: VendorCreditStatus;
  number: string | null;
  vendorId: string;
  vendorName: string | null;
  billId: string | null;
  vendorReference: string | null;
  creditDate: string;
  currencyCode: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  recoverableTaxTotal: string;
  total: string;
  amountUnapplied: string | null;
  baseTotal: string | null;
  baseUnapplied: string | null;
  version: number;
  postedAt: string | null;
  voidedAt: string | null;
}

export interface VendorCreditDetail extends VendorCreditSummary {
  billNumber: string | null;
  exchangeRate: string | null;
  exchangeRateSource: 'base' | 'table' | 'manual' | 'bill' | null;
  tableRate: string | null;
  rateOverride: string | null;
  rateOverrideReason: string | null;
  taxTreatment: 'exclusive' | 'inclusive' | 'no_tax';
  discount: { type: 'percent' | 'amount'; value: string } | null;
  memo: string;
  dimensionValueIds: string[];
  journalId: string | null;
  pdfFileId: string | null;
  voidReason: string | null;
  voidJournalId: string | null;
  createdByUserId: string;
  baseCurrency: string;
  lines: BillLine[];
  approval: BillDetail['approval'];
  warnings: { code: string; message: string }[];
}

/** Phase 4B-2: vendor payments, prepayments and settlement history (P4-25 to P4-33). */
export type PaymentStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'RECORDED' | 'VOID';

export interface PaymentSummary {
  id: string;
  status: PaymentStatus;
  number: string | null;
  vendorId: string;
  vendorName: string | null;
  paymentDate: string;
  currencyCode: string;
  amount: string;
  amountUnallocated: string | null;
  baseAmount: string | null;
  baseUnallocated: string | null;
  reference: string | null;
  version: number;
  recordedAt: string | null;
  voidedAt: string | null;
  /** Phase 4B-4: the Pay-bills batch that recorded the payment. */
  paymentBatchId: string | null;
}

/** One settlement row: a payment or an applied credit against a bill (reversals negative). */
export interface AllocationView {
  id: string;
  billId: string;
  billNumber: string | null;
  sourceType: 'payment' | 'vendor_credit';
  sourceId: string;
  sourceNumber: string | null;
  mode: 'payment' | 'credit';
  applicationId: string | null;
  allocationDate: string;
  currencyCode: string;
  amount: string;
  baseRelieved: string;
  sourceBase: string;
  /** AP sign: base relieved − source base (positive = gain). */
  fxDifference: string;
  reversesAllocationId: string | null;
  journalId: string;
}

export interface PaymentDetail extends PaymentSummary {
  paymentAccountId: string | null;
  defaultPaymentAccountId: string | null;
  paymentAccountOverridden: boolean | null;
  rateOverride: string | null;
  rateOverrideReason: string | null;
  exchangeRate: string | null;
  exchangeRateSource: 'base' | 'table' | 'manual' | null;
  tableRate: string | null;
  memo: string;
  journalId: string | null;
  voidReason: string | null;
  voidJournalId: string | null;
  createdByUserId: string;
  baseCurrency: string;
  plannedAllocations: {
    billId: string;
    billNumber: string | null;
    billDate: string | null;
    billStatus: string | null;
    billAmountDue: string | null;
    amount: string;
  }[];
  allocations: AllocationView[];
  approval: BillDetail['approval'];
  warnings: { code: string; message: string }[];
}

/** A posted bill with an amount due: a payment or credit target. */
export interface OpenBill {
  id: string;
  number: string;
  vendorReference: string | null;
  billDate: string;
  dueDate: string | null;
  currencyCode: string;
  total: string;
  amountDue: string;
}

/** Phase 4B-3: vendor refunds from prepayments and unapplied vendor credits (P4-30). */
export type RefundStatus = 'RECORDED' | 'VOID';

export interface RefundSummary {
  id: string;
  status: RefundStatus;
  number: string;
  vendorId: string;
  vendorName: string | null;
  sourceType: 'payment' | 'vendor_credit';
  sourceId: string;
  refundDate: string;
  currencyCode: string;
  amount: string;
  baseAmount: string;
  reference: string | null;
  version: number;
  voidedAt: string | null;
}

export interface RefundDetail extends RefundSummary {
  sourceNumber: string | null;
  refundAccountId: string;
  refundAccountOverridden: boolean;
  exchangeRate: string;
  exchangeRateSource: 'base' | 'table' | 'manual';
  tableRate: string | null;
  rateOverrideReason: string | null;
  baseReleased: string;
  /** Base received − base released (positive = gain). */
  fxDifference: string;
  memo: string;
  journalId: string;
  voidReason: string | null;
  voidJournalId: string | null;
  baseCurrency: string;
}

/** Phase 4B-4: batch Pay bills (P4-32). */
export interface PayableBill {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string | null;
  vendorReference: string | null;
  billDate: string;
  dueDate: string | null;
  currencyCode: string;
  total: string;
  amountDue: string;
}

export interface PaymentBatchSummary {
  id: string;
  paymentDate: string;
  paymentCount: number;
  billCount: number;
  totals: { currencyCode: string; amount: string; payments: number }[];
  reference: string | null;
  createdAt: string;
  createdByUserId: string;
}

export interface PaymentBatchDetail extends PaymentBatchSummary {
  memo: string;
  payments: {
    id: string;
    number: string | null;
    status: PaymentStatus;
    vendorId: string;
    vendorName: string | null;
    currencyCode: string;
    amount: string;
    baseAmount: string | null;
    exchangeRate: string | null;
    exchangeRateSource: string | null;
    paymentAccountId: string | null;
    journalId: string | null;
    voidedAt: string | null;
  }[];
}

/** Phase 4B-5: AP reports (P4-49). Amounts read "what we owe" (PD4); bases are historical (PD7). */
export const AP_AGING_BUCKETS = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
] as const;
export type ApAgingBucket = (typeof AP_AGING_BUCKETS)[number];
type ApBuckets = Record<ApAgingBucket | 'credit' | 'total', string>;

export interface ApAgingReport {
  asOf: string;
  baseCurrency: string;
  vendors: {
    vendorId: string;
    vendorName: string | null;
    currencies: (ApBuckets & { currencyCode: string })[];
    base: ApBuckets;
    bills: {
      id: string;
      number: string;
      vendorReference: string | null;
      billDate: string;
      dueDate: string;
      daysOverdue: number;
      bucket: ApAgingBucket;
      currencyCode: string;
      openAmount: string;
      openBase: string;
    }[];
    credits: {
      type: 'vendor_credit' | 'payment';
      id: string;
      number: string;
      origin: string | null;
      date: string;
      currencyCode: string;
      openAmount: string;
      openBase: string;
    }[];
  }[];
  totals: ApBuckets;
}

export interface VendorStatement {
  vendorId: string;
  vendorName: string | null;
  from: string;
  to: string;
  currencies: {
    currencyCode: string;
    openingBalance: string;
    closingBalance: string;
    lines: {
      type: 'bill' | 'vendor_credit' | 'payment' | 'refund';
      id: string;
      number: string;
      origin: string | null;
      date: string;
      reference: string | null;
      amount: string;
      balance: string;
    }[];
    openBills: {
      id: string;
      number: string;
      dueDate: string;
      bucket: ApAgingBucket;
      openAmount: string;
    }[];
  }[];
}

export interface ApReconciliation {
  asOf: string;
  baseCurrency: string;
  apAccountId: string;
  glBalance: string;
  revaluationAdjustments: string;
  postingsOutsidePurchases: string;
  subledger: { openBills: string; unappliedCredits: string; prepayments: string; total: string };
  difference: string;
  reconciled: boolean;
}

/** Phase 4B-6: unpaid bills, purchase analysis, input tax and the payment register (P4-49). */
export type UnpaidBucketKey =
  'overdue' | 'days0to7' | 'days8to14' | 'days15to21' | 'days22to28' | 'later';

export interface CurrencyAmount {
  currencyCode: string;
  amount: string;
}

export interface UnpaidBillsReport {
  asOf: string;
  baseCurrency: string;
  buckets: {
    key: UnpaidBucketKey;
    from: string | null;
    to: string | null;
    currencies: CurrencyAmount[];
    base: string;
    bills: {
      id: string;
      number: string;
      vendorId: string;
      vendorName: string | null;
      vendorReference: string | null;
      billDate: string;
      dueDate: string;
      daysUntilDue: number;
      currencyCode: string;
      openAmount: string;
      openBase: string;
    }[];
  }[];
  totals: { currencies: CurrencyAmount[]; base: string };
}

/** PD2 columns, in base currency. */
export interface PurchaseSums {
  net: string;
  recoverableTax: string;
  nonRecoverableTax: string;
  cost: string;
  tax: string;
  total: string;
}

export interface PurchasesByVendorReport {
  from: string;
  to: string;
  baseCurrency: string;
  vendors: (PurchaseSums & {
    vendorId: string;
    vendorName: string | null;
    bills: number;
    credits: number;
  })[];
  totals: PurchaseSums;
}

export interface PurchasesByItemReport {
  from: string;
  to: string;
  baseCurrency: string;
  items: (PurchaseSums & {
    itemId: string | null;
    name: string | null;
    sku: string | null;
    quantity: string;
    lines: number;
  })[];
  totals: PurchaseSums;
}

export interface PurchasesByAccountReport {
  from: string;
  to: string;
  baseCurrency: string;
  accounts: {
    accountId: string | null;
    code: string | null;
    name: string | null;
    net: string;
    nonRecoverableTax: string;
    cost: string;
  }[];
  totals: { net: string; nonRecoverableTax: string; cost: string; recoverableTax: string };
}

export interface InputTaxSummaryReport {
  from: string;
  to: string;
  baseCurrency: string;
  reviewOnly: true;
  codes: {
    taxCodeId: string | null;
    code: string | null;
    rate: string | null;
    taxable: string;
    recoverableTax: string;
    nonRecoverableTax: string;
    tax: string;
  }[];
  totals: { taxable: string; recoverableTax: string; nonRecoverableTax: string; tax: string };
}

export interface RegisterSummary {
  subtotals: {
    accountId: string;
    account: { code: string; name: string } | null;
    currencyCode: string;
    count: number;
    amount: string;
    baseAmount: string;
    realizedFx: string;
  }[];
  totals: { count: number; voided: number; baseAmount: string };
}

export interface PaymentRegisterReport {
  from: string;
  to: string;
  baseCurrency: string;
  limit: number;
  truncated: boolean;
  payments: {
    id: string;
    number: string;
    status: 'RECORDED' | 'VOID';
    paymentDate: string;
    vendorId: string;
    vendorName: string | null;
    paymentAccountId: string;
    account: { code: string; name: string } | null;
    paymentBatchId: string | null;
    currencyCode: string;
    amount: string;
    exchangeRate: string;
    exchangeRateSource: string;
    baseAmount: string;
    appliedToBills: string;
    prepayment: string;
    realizedFx: string;
    voidedAt: string | null;
  }[];
  paymentSummary: RegisterSummary;
  refunds: {
    id: string;
    number: string;
    status: 'RECORDED' | 'VOID';
    refundDate: string;
    vendorId: string;
    vendorName: string | null;
    refundAccountId: string;
    account: { code: string; name: string } | null;
    sourceType: 'payment' | 'vendor_credit';
    sourceId: string;
    sourceNumber: string | null;
    currencyCode: string;
    amount: string;
    exchangeRate: string;
    baseAmount: string;
    realizedFx: string;
    voidedAt: string | null;
  }[];
  refundSummary: RegisterSummary;
}

/** Phase 4B-7: a payment's remittance advice (P4-46). */
export interface RemittanceStatus {
  status: 'none' | 'pending' | 'ready' | 'failed';
  fileId: string | null;
  jobId: string | null;
  download?: { url: string };
}

export interface RemittanceEmail {
  id: string;
  recipient: string;
  subject: string;
  status: 'queued' | 'sent' | 'failed';
  requestedAt: string;
  sentAt: string | null;
}
