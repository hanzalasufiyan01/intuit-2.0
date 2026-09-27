/** Accounting API shapes (mirrors /api/v1/accounting responses). Amounts are decimal strings. */

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export const ACCOUNT_TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

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

export type JournalStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'POSTED' | 'REVERSED';

export interface JournalLine {
  lineNumber: number;
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
  source: 'manual' | 'reversal' | 'event';
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
  reversedByJournalId: string | null;
  reversesJournalId: string | null;
  reversalReason: string | null;
}

export interface LedgerResult {
  baseCurrency: string;
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
}
