import type { AppliedStep, ApprovalFacts } from '../approvals/conditions';
/** Accounting API shapes (mirrors /api/v1/accounting responses). Amounts are decimal strings. */

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export const ACCOUNT_TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

/** Decision 53 subtype catalog by account nature. */
export const ACCOUNT_SUBTYPES: Record<AccountType, readonly AccountSubtype[]> = {
  ASSET: [
    'BANK',
    'CASH',
    'ACCOUNTS_RECEIVABLE',
    'OTHER_CURRENT_ASSET',
    'FIXED_ASSET',
    'OTHER_ASSET',
  ],
  LIABILITY: ['ACCOUNTS_PAYABLE', 'CREDIT_CARD', 'OTHER_CURRENT_LIABILITY', 'LONG_TERM_LIABILITY'],
  EQUITY: ['EQUITY'],
  REVENUE: ['OPERATING_REVENUE', 'OTHER_INCOME'],
  EXPENSE: ['COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_EXPENSE'],
};
export type AccountSubtype =
  | 'BANK'
  | 'CASH'
  | 'ACCOUNTS_RECEIVABLE'
  | 'OTHER_CURRENT_ASSET'
  | 'FIXED_ASSET'
  | 'OTHER_ASSET'
  | 'ACCOUNTS_PAYABLE'
  | 'CREDIT_CARD'
  | 'OTHER_CURRENT_LIABILITY'
  | 'LONG_TERM_LIABILITY'
  | 'EQUITY'
  | 'OPERATING_REVENUE'
  | 'OTHER_INCOME'
  | 'COST_OF_SALES'
  | 'OPERATING_EXPENSE'
  | 'OTHER_EXPENSE';
export const SUBTYPE_LABELS: Record<AccountSubtype, string> = {
  BANK: 'Bank',
  CASH: 'Cash',
  ACCOUNTS_RECEIVABLE: 'Accounts Receivable',
  OTHER_CURRENT_ASSET: 'Other Current Asset',
  FIXED_ASSET: 'Fixed Asset',
  OTHER_ASSET: 'Other Asset',
  ACCOUNTS_PAYABLE: 'Accounts Payable',
  CREDIT_CARD: 'Credit Card',
  OTHER_CURRENT_LIABILITY: 'Other Current Liability',
  LONG_TERM_LIABILITY: 'Long-Term Liability',
  EQUITY: 'Equity',
  OPERATING_REVENUE: 'Operating Revenue',
  OTHER_INCOME: 'Other Income',
  COST_OF_SALES: 'Cost of Sales',
  OPERATING_EXPENSE: 'Operating Expense',
  OTHER_EXPENSE: 'Other Expense',
};
/** Always monetary (Decision 53). */
export const ALWAYS_MONETARY: readonly AccountSubtype[] = [
  'BANK',
  'CASH',
  'ACCOUNTS_RECEIVABLE',
  'ACCOUNTS_PAYABLE',
  'CREDIT_CARD',
];
/** Monetary only when marked explicitly (Decision 53, amended by S9 N9). */
export const OPTIONALLY_MONETARY: readonly AccountSubtype[] = [
  'OTHER_CURRENT_ASSET',
  'OTHER_ASSET',
  'OTHER_CURRENT_LIABILITY',
  'LONG_TERM_LIABILITY',
];

export interface Account {
  id: string;
  code: string;
  name: string;
  description: string;
  type: AccountType;
  parentId: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  isSystem: boolean;
  isLeaf: boolean;
  usedInPostedJournals: boolean;
  currencyCode: string;
  subtype: AccountSubtype | null;
  isMonetary: boolean;
  isControlAccount: boolean;
  /** The subledger that maintains this control account (ADR 0004 P4-08). */
  controlSubledger?: 'sales' | 'purchases' | null;
  isBankOrCash: boolean;
}

export type Designation =
  | 'RETAINED_EARNINGS'
  | 'REALIZED_FX_GAIN_LOSS'
  | 'UNREALIZED_FX_GAIN_LOSS'
  | 'ROUNDING_DIFFERENCE'
  | 'OPENING_BALANCE_EQUITY';
export const DESIGNATION_LABELS: Record<Designation, string> = {
  RETAINED_EARNINGS: 'Retained Earnings',
  REALIZED_FX_GAIN_LOSS: 'Realized FX Gain/Loss',
  UNREALIZED_FX_GAIN_LOSS: 'Unrealized FX Gain/Loss',
  ROUNDING_DIFFERENCE: 'Rounding Differences',
  OPENING_BALANCE_EQUITY: 'Opening Balance Equity',
};
export interface DesignationEntry {
  designation: Designation;
  accountId: string | null;
  allowedTypes: AccountType[];
  updatedAt: string | null;
}

export interface SetupState {
  isSetUp: boolean;
  settings: { baseCurrency: string; coaTemplateKey: string; baseCurrencyLocked: boolean } | null;
  templates: { key: string; name: string; description: string; accountCount: number }[];
}

export interface Period {
  id: string;
  fiscalYearId: string;
  number: number;
  name: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
  reopenReason: string | null;
}

export interface FiscalYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  periods?: Period[];
}

export type JournalStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'POSTED' | 'REVERSED' | 'DISCARDED';

export interface DimensionValue {
  id: string;
  dimensionTypeId: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'ARCHIVED';
  archivedAt: string | null;
}

export interface DimensionType {
  id: string;
  code: string;
  name: string;
  description: string;
  isRequired: boolean;
  scope: { accountTypes: AccountType[]; accountSubtypes: AccountSubtype[] };
  status: 'ACTIVE' | 'ARCHIVED';
  values: DimensionValue[];
}

export interface LineDimension {
  dimensionTypeId: string;
  dimensionValueId: string;
  typeCode: string;
  typeName: string;
  valueCode: string;
  valueName: string;
}

export interface JournalLine {
  lineNumber: number;
  kind?: 'normal' | 'base_only';
  dimensions?: LineDimension[];
  accountId: string | null;
  description: string;
  debit: string | null;
  credit: string | null;
  baseDebit: string | null;
  baseCredit: string | null;
  roundingAdjustment: string;
}

export interface Journal {
  id: string;
  number: number | null;
  status: JournalStatus;
  source: 'manual' | 'reversal' | 'event' | 'system';
  sourceModule?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  /** Set once submitted; never cleared (S6, L-9). */
  submittedAt?: string | null;
  discardedAt?: string | null;
  entryDate: string | null;
  description: string;
  reference: string;
  currency: string;
  exchangeRate: string | null;
  exchangeRateSource: string | null;
  baseCurrency: string | null;
  totalDebit: string | null;
  totalBaseDebit: string | null;
  createdByUserId: string | null;
  submittedByUserId: string | null;
  createdAt: string;
  postedAt: string | null;
  lines?: JournalLine[];
}

export interface JournalDetail extends Journal {
  lines: JournalLine[];
  approval: {
    requestId: string;
    status: string;
    satisfied: boolean;
    steps: {
      order: number;
      name: string;
      requiredApprovals: number;
      approvals: number;
      satisfied: boolean;
    }[];
    decisions: {
      approverUserId: string;
      decision: string;
      comment: string | null;
      decidedAt: string;
    }[];
  } | null;
  approvalRequiredForPosting: boolean;
  /** S10: facts the server derived for this journal, and the policy steps that apply to them. */
  approvalFacts: ApprovalFacts;
  approvalSteps: AppliedStep[];
  reversedByJournalId: string | null;
  reversesJournalId: string | null;
  reversalReason: string | null;
}

export interface LedgerResult {
  baseCurrency: string;
  taggedActivityOnly?: boolean;
  dimensionFilter?: { dimensionTypeId: string; typeName: string; valueName: string }[];
  openingBalance: string | null;
  totals: { baseDebit: string; baseCredit: string };
  truncated: boolean;
  rows: {
    journalId: string;
    journalNumber: number;
    entryDate: string;
    journalDescription: string;
    lineNumber: number;
    accountCode: string;
    accountName: string;
    currency: string;
    debit: string | null;
    credit: string | null;
    exchangeRate: string;
    baseDebit: string | null;
    baseCredit: string | null;
    runningBalance: string | null;
  }[];
}

export interface ApprovalRequestSummary {
  id: string;
  actionKey: string;
  subjectType: string;
  subjectId: string;
  reason: string | null;
  createdAt: string;
  canDecide: boolean;
  progress: { order: number; name: string; requiredApprovals: number; approvals: number }[];
  /** S10: the facts the steps were matched against, and the steps that apply. */
  facts: ApprovalFacts | null;
  appliedSteps: AppliedStep[];
}

// ---------------------------------------------------------------------------
// Phase 3A S8: opening balances
// ---------------------------------------------------------------------------

export type OpeningBatchStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'POSTED' | 'REVERSED';

export interface OpeningDimension {
  dimensionTypeId: string;
  dimensionValueId: string;
}

export interface OpeningBatchSummary {
  id: string;
  status: OpeningBatchStatus;
  conversionDate: string;
  openingDate: string;
  version: number;
  notes: string;
  approvalRequestId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface OpeningLineView {
  id: string;
  lineNumber: number;
  accountId: string;
  accountCode: string | null;
  accountName: string | null;
  currency: string;
  description: string;
  debit: string | null;
  credit: string | null;
  baseAmount: string | null;
  dimensions: OpeningDimension[];
}

export interface OpeningTotals {
  currency: string;
  lines: number;
  debit: string;
  credit: string;
  openingBalanceEquity: { side: 'debit' | 'credit'; amount: string } | null;
}

export interface OpeningApproval {
  required: boolean;
  requestId: string | null;
  requestStatus: 'pending' | 'approved' | 'rejected' | 'withdrawn' | null;
  steps: { name: string; requiredApprovals: number; approvals: number; satisfied: boolean }[];
  /** S10: the batch's facts (null once posted) and the steps that apply. */
  facts: ApprovalFacts | null;
  appliedSteps: AppliedStep[];
  readyToPost: boolean;
}

export interface OpeningBatchDetail extends OpeningBatchSummary {
  baseCurrency: string;
  lines: OpeningLineView[];
  totals: OpeningTotals[];
  approval: OpeningApproval;
  journals: {
    id: string;
    journalNumber: number | null;
    currency: string;
    status: JournalStatus;
    entryDate: string | null;
    totalDebit: string | null;
    totalBaseDebit: string | null;
    exchangeRate: string | null;
    exchangeRateSource: string | null;
  }[];
}

export interface OpeningIssue {
  path: string;
  message: string;
}

export interface OpeningPreview {
  batchId: string;
  version: number;
  openingDate: string;
  baseCurrency: string;
  errors: OpeningIssue[];
  warnings: OpeningIssue[];
  approval: OpeningApproval;
  journals: {
    currency: string;
    rate: string;
    rateSource: 'base' | 'table' | 'explicit';
    accountLines: number;
    totals: { debit: string; credit: string; baseDebit: string | null; baseCredit: string | null };
    openingBalanceEquity: {
      side: 'debit' | 'credit';
      amount: string;
      baseAmount: string | null;
    } | null;
    lines: {
      accountId: string;
      accountCode: string | null;
      accountName: string | null;
      description: string;
      debit: string | null;
      credit: string | null;
      baseDebit: string | null;
      baseCredit: string | null;
    }[];
  }[];
}

export interface OpeningList {
  conversionDate: string | null;
  openingDate: string | null;
  batches: OpeningBatchSummary[];
}
