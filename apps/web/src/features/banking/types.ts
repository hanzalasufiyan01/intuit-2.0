/** Banking API shapes (mirrors /api/v1/banking responses). Amounts are decimal strings. */

export interface BankAccount {
  id: string;
  accountId: string;
  accountCode: string | null;
  accountName: string | null;
  name: string;
  currencyCode: string;
  status: 'ACTIVE' | 'ARCHIVED';
  openingBalance: string;
  openingBalanceDate: string | null;
  bookBalance: string;
  unmatchedCount: number;
  matchedCount: number;
  excludedCount: number;
  lastReconciledDate: string | null;
  lastReconciledBalance: string | null;
  version: number;
}

export type BankTransactionStatus = 'UNMATCHED' | 'MATCHED' | 'EXCLUDED';

export interface BankTransaction {
  id: string;
  bankingAccountId: string;
  date: string;
  description: string;
  reference: string | null;
  amount: string;
  currencyCode: string;
  balance: string | null;
  status: BankTransactionStatus;
  excludedReason: string | null;
  match: {
    id: string;
    source: 'manual' | 'entry' | 'transfer';
    journalId: string;
    journalNumber: number | null;
    journalLineId: string;
  } | null;
  suggestion: {
    ruleId: string;
    ruleName: string;
    categoryAccountId: string;
    memo: string;
  } | null;
}

export interface MatchSuggestion {
  journalLineId: string;
  journalId: string;
  journalNumber: number;
  date: string;
  description: string;
  reference: string;
  amount: string;
  sourceModule: string | null;
  sourceType: string | null;
}

export interface BankEntry {
  id: string;
  number: string;
  status: 'POSTED' | 'VOID';
  bankingTransactionId: string;
  bankingAccountId: string;
  date: string;
  direction: 'in' | 'out';
  amount: string;
  currencyCode: string;
  categoryAccountId: string;
  memo: string;
  journalId: string;
  voidJournalId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  version: number;
}

export interface BankTransfer {
  id: string;
  number: string;
  status: 'POSTED' | 'VOID';
  date: string;
  fromBankingAccountId: string;
  fromName: string | null;
  toBankingAccountId: string;
  toName: string | null;
  fromAmount: string;
  fromCurrencyCode: string;
  toAmount: string;
  toCurrencyCode: string;
  exchangeRate: string | null;
  exchangeRateSource: 'base' | 'table' | 'implied';
  baseAmount: string;
  memo: string;
  journalId: string;
  voidedAt: string | null;
  voidReason: string | null;
  version: number;
}

export interface ReconciliationPreview {
  statementDate: string;
  statementBalance: string;
  openingBalance: string;
  openingFrom: { reconciliationId: string; statementDate: string } | null;
  clearedTotal: string;
  difference: string;
  bookBalance: string;
  unmatchedCount: number;
  canComplete: boolean;
  items: { transactionId: string; date: string; description: string; amount: string }[];
}

export interface Reconciliation {
  id: string;
  bankingAccountId: string;
  status: 'COMPLETED' | 'REOPENED';
  statementDate: string;
  statementBalance: string;
  openingBalance: string;
  clearedTotal: string;
  itemCount: number;
  completedAt: string;
  reopenedAt: string | null;
  reopenReason: string | null;
  version: number;
}

export interface BankRule {
  id: string;
  name: string;
  bankingAccountId: string | null;
  priority: number;
  direction: 'in' | 'out' | 'any';
  descriptionContains: string | null;
  minAmount: string | null;
  maxAmount: string | null;
  categoryAccountId: string;
  memo: string;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
}

export interface ImportResult {
  importId: string;
  imported: number;
  duplicates: number;
  periodStart: string | null;
  periodEnd: string | null;
}
