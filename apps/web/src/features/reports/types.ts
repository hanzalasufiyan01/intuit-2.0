/** Financial report API shapes (mirrors /api/v1/accounting/reports). Amounts are decimal strings. */

export type Drill =
  | {
      kind: 'ledger';
      accountId: string;
      fromDate: string | null;
      toDate: string;
      openingBasis: 'cumulative' | 'fiscal_year';
    }
  | { kind: 'profit_and_loss'; from: string | null; to: string };

export interface IntegrityCheck {
  name: string;
  status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
  left: string;
  right: string;
  difference: string;
}

export interface Integrity {
  status: 'BALANCED' | 'OUT_OF_BALANCE' | 'NOT_APPLICABLE';
  checks: IntegrityCheck[];
}

export interface ReportWarning {
  code: string;
  message: string;
}

export interface DimensionFilterEntry {
  dimensionTypeId: string;
  typeName: string;
  dimensionValueId: string;
  valueName: string;
}

interface ReportBase {
  baseCurrency: string;
  currencyView: 'base' | 'base_and_account';
  includeZero: boolean;
  dimensionFilter: DimensionFilterEntry[];
  taggedActivityOnly: boolean;
  integrity: Integrity;
  warnings: ReportWarning[];
  generatedAt: string;
}

export interface TrialBalanceRow {
  rowType: 'account' | 'computed';
  key: string;
  accountId: string | null;
  code: string | null;
  name: string;
  level: number;
  isLeaf: boolean;
  archived: boolean;
  includesPriorYearEarnings: boolean;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
  netBalance: string;
  accountCurrency: { code: string; opening: string; movement: string; closing: string } | null;
  drill: Drill | null;
}

export interface TrialBalanceReport extends ReportBase {
  report: 'trial_balance';
  from: string;
  to: string;
  fiscalYear: { id: string; name: string; startDate: string; endDate: string };
  rows: TrialBalanceRow[];
  totals: Record<
    | 'openingDebit'
    | 'openingCredit'
    | 'periodDebit'
    | 'periodCredit'
    | 'closingDebit'
    | 'closingCredit',
    string
  >;
}

export interface StatementRow {
  rowType: 'account' | 'computed';
  key: string;
  accountId: string | null;
  code: string | null;
  name: string;
  level: number;
  isLeaf: boolean;
  archived: boolean;
  partial: boolean;
  amounts: string[];
  accountCurrency: { code: string; amounts: string[] } | null;
  drills: (Drill | null)[];
}

export interface StatementSection {
  key: string;
  label: string;
  rows: StatementRow[];
  total: string[];
}

export interface StatementColumn {
  key: 'current' | 'comparison';
  label: string;
}

export interface ProfitAndLossReport extends ReportBase {
  report: 'profit_and_loss';
  columns: (StatementColumn & { from: string; to: string })[];
  sections: StatementSection[];
  summary: { grossProfit: string[]; operatingProfit: string[]; netProfit: string[] };
}

export interface BalanceSheetReport extends ReportBase {
  report: 'balance_sheet';
  columns: (StatementColumn & { asOf: string })[];
  sections: StatementSection[];
  totals: {
    totalAssets: string[];
    totalLiabilities: string[];
    totalEquity: string[];
    totalLiabilitiesAndEquity: string[];
  };
}
