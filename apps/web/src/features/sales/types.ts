/** Client views of the Sales API (Phase 3B). Amounts are decimal strings computed by the server. */

export type TaxTreatment = 'exclusive' | 'inclusive' | 'no_tax';
export type DiscountType = 'percent' | 'amount';
export interface Discount {
  type: DiscountType;
  value: string;
}

export interface TaxRate {
  id: string;
  rate: string;
  effectiveFrom: string;
  verificationNote: string | null;
}
export interface TaxCode {
  id: string;
  code: string;
  name: string;
  description: string;
  taxAccountId: string;
  /** Recoverable purchase tax posts here (ADR 0004 P4-11); null until mapped. */
  inputTaxAccountId: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  systemSeeded: boolean;
  rates: TaxRate[];
}

export interface Numbering {
  prefix: string;
  minDigits: number;
  nextNumber: number;
  preview: string;
}
export type DocumentTypeKey = 'invoice' | 'credit_note' | 'receipt';
export interface SalesSettings {
  configured: boolean;
  version: number;
  arAccountId: string | null;
  defaultRevenueAccountId: string | null;
  defaultDepositAccountId: string | null;
  defaultTaxCodeId: string | null;
  defaultTaxTreatment: TaxTreatment;
  defaultPaymentTermsDays: number;
  arLocked: boolean;
  suggestedArAccountId: string | null;
  numbering: Record<DocumentTypeKey, Numbering>;
}

export interface CustomerSummary {
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
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
}
export interface CustomerDetail extends CustomerSummary {
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
    isPrimary: boolean;
  }[];
  warnings?: { code: string; message: string }[];
}

export interface Item {
  id: string;
  sku: string | null;
  name: string;
  itemType: 'service' | 'product';
  description: string;
  unitPrice: string | null;
  revenueAccountId: string | null;
  taxCodeId: string | null;
  /** The purchase side of the shared catalog (ADR 0004 P4-05). */
  isSold: boolean;
  isPurchased: boolean;
  purchaseDescription: string;
  purchaseUnitCost: string | null;
  expenseAccountId: string | null;
  purchaseTaxCodeId: string | null;
  /** Default tax recoverability on purchase lines (P4-12); null = no default. */
  purchaseTaxRecoverable: boolean | null;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
}

export interface DocumentLine {
  id: string;
  lineNo: number;
  itemId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: Discount | null;
  amount: string;
  lineDiscount: string;
  documentDiscount: string;
  netAmount: string;
  taxCodeId: string | null;
  taxRate: string | null;
  taxAmount: string;
  total: string;
  revenueAccountId: string | null;
  dimensionValueIds: string[];
}

export interface ApprovalState {
  required: boolean;
  requestId: string | null;
  requestStatus: 'pending' | 'approved' | 'rejected' | 'withdrawn' | null;
  facts: { transactionType: string; baseAmount: string | null; baseCurrency: string | null } | null;
  appliedSteps: { order: number; name: string; requiredApprovals: number }[];
  readyToIssue: boolean;
  approvalOutdated: boolean;
}

export type InvoiceStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'ISSUED' | 'VOID';
export interface InvoiceSummary {
  id: string;
  kind: 'standard' | 'opening';
  status: InvoiceStatus;
  number: string | null;
  customerId: string;
  customerName: string | null;
  invoiceDate: string;
  dueDate: string;
  currencyCode: string;
  reference: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountDue: string | null;
  baseTotal: string | null;
  baseDue: string | null;
  version: number;
}
export interface InvoiceDetail extends InvoiceSummary {
  paymentTermsDays: number | null;
  openingBaseTotal: string | null;
  exchangeRate: string | null;
  exchangeRateSource: string | null;
  taxTreatment: TaxTreatment;
  discount: Discount | null;
  memo: string;
  dimensionValueIds: string[];
  journalId: string | null;
  voidReason: string | null;
  baseCurrency: string;
  lines: DocumentLine[];
  allocations: {
    id: string;
    sourceType: 'receipt' | 'credit_note';
    receiptId: string | null;
    creditNoteId: string | null;
    mode: 'receipt' | 'credit';
    allocationDate: string;
    amount: string;
    reversesAllocationId: string | null;
  }[];
  approval: ApprovalState;
  warnings: { code: string; message: string }[];
}

export type CreditNoteStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'ISSUED';
export interface CreditNoteSummary {
  id: string;
  status: CreditNoteStatus;
  number: string | null;
  customerId: string;
  customerName: string | null;
  invoiceId: string | null;
  creditDate: string;
  currencyCode: string;
  reference: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountUnapplied: string | null;
  version: number;
}
export interface CreditNoteDetail extends CreditNoteSummary {
  exchangeRate: string | null;
  exchangeRateSource: string | null;
  taxTreatment: TaxTreatment;
  discount: Discount | null;
  memo: string;
  dimensionValueIds: string[];
  journalId: string | null;
  baseCurrency: string;
  lines: DocumentLine[];
  allocations: {
    id: string;
    invoiceId: string;
    allocationDate: string;
    amount: string;
    reversesAllocationId: string | null;
  }[];
  approval: ApprovalState;
}

export interface ReceiptSummary {
  id: string;
  status: 'RECORDED' | 'VOID';
  number: string;
  customerId: string;
  customerName: string | null;
  receiptDate: string;
  currencyCode: string;
  amount: string;
  exchangeRate: string;
  exchangeRateSource: 'base' | 'table' | 'manual';
  tableRate: string | null;
  rateOverrideReason: string | null;
  depositAccountId: string;
  depositAccountOverridden: boolean;
  baseAmount: string;
  amountUnallocated: string;
  reference: string | null;
  memo: string;
  journalId: string;
  voidReason: string | null;
  version: number;
}
export interface ReceiptDetail extends ReceiptSummary {
  allocations: {
    id: string;
    invoiceId: string;
    mode: 'receipt' | 'credit';
    allocationDate: string;
    amount: string;
    fxDifference: string;
    reversesAllocationId: string | null;
  }[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const AGING_BUCKETS = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
