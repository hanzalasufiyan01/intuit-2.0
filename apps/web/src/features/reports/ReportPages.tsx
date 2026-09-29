import { formatAmount } from '../../shared/money';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { ExportButton } from '../data-exchange/ExportButton';
import { Spinner } from '../../shared/ui/Spinner';
import { AccountingPage } from '../accounting/shared';
import {
  DrillLink,
  IntegrityPanel,
  ReportError,
  ReportFilters,
  ReportNotices,
  useCollapse,
  useReportQuery,
  type ReportKind,
} from './ReportControls';
import type {
  BalanceSheetReport,
  ProfitAndLossReport,
  StatementSection,
  TrialBalanceReport,
} from './types';

const REPORT_EXPORTS = {
  'trial-balance': 'trial_balance',
  'profit-and-loss': 'profit_and_loss',
  'balance-sheet': 'balance_sheet',
} as const satisfies Record<ReportKind, string>;

function ReportShell({
  kind,
  title,
  description,
  searchParams,
  setSearchParams,
  children,
}: {
  kind: ReportKind;
  title: string;
  description: string;
  searchParams: URLSearchParams;
  setSearchParams: (p: URLSearchParams) => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <AccountingPage>
        <p className="actions">
          <ExportButton
            key={searchParams.toString()}
            domain={REPORT_EXPORTS[kind]}
            params={Object.fromEntries(searchParams)}
          />
        </p>
        <Card>
          <ReportFilters
            key={searchParams.toString()}
            kind={kind}
            searchParams={searchParams}
            onApply={setSearchParams}
          />
        </Card>
        {children}
      </AccountingPage>
    </>
  );
}

function AccountName({
  row,
  collapsed,
  onToggle,
}: {
  row: {
    key: string;
    code: string | null;
    name: string;
    level: number;
    isLeaf: boolean;
    archived: boolean;
  };
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <span style={{ paddingLeft: row.level * 18 }}>
      {!row.isLeaf ? (
        <button
          type="button"
          className="link-button"
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${row.name}`}
          onClick={onToggle}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      ) : null}{' '}
      {row.code ? `${row.code} ` : ''}
      {row.name}
      {row.archived ? <span className="badge badge--archived"> archived</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Trial Balance
// ---------------------------------------------------------------------------

export function TrialBalancePage() {
  const { result, searchParams, setSearchParams } =
    useReportQuery<TrialBalanceReport>('trial-balance');
  const tree = useCollapse();
  const report = result.data;
  const dims = searchParams.get('dimensionValueIds');
  const cur = report?.baseCurrency ?? '';
  const showFx = report?.currencyView === 'base_and_account';
  return (
    <ReportShell
      kind="trial-balance"
      title="Trial Balance"
      description="Posted ledger balances within one fiscal year, after the virtual year-end."
      searchParams={searchParams}
      setSearchParams={setSearchParams}
    >
      <Card>
        {result.isPending ? (
          <Spinner label="Loading report" />
        ) : result.isError ? (
          <ReportError error={result.error} />
        ) : report ? (
          <>
            <p className="muted">
              {report.fiscalYear.name}: {report.from} to {report.to} · {report.baseCurrency}
            </p>
            <IntegrityPanel integrity={report.integrity} currency={cur} />
            <ReportNotices {...report} />
            <div className="actions">
              <Button variant="ghost" onClick={tree.expandAll}>
                Expand all
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  tree.collapseAll(report.rows.filter((r) => !r.isLeaf).map((r) => r.key))
                }
              >
                Collapse all
              </Button>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Opening Dr</th>
                  <th>Opening Cr</th>
                  <th>Period Dr</th>
                  <th>Period Cr</th>
                  <th>Closing Dr</th>
                  <th>Closing Cr</th>
                  {showFx ? <th>Account currency (closing)</th> : null}
                </tr>
              </thead>
              <tbody>
                {tree.visible(report.rows).map((row) => (
                  <tr key={row.key} className={row.isLeaf ? undefined : 'row--group'}>
                    <td>
                      <AccountName
                        row={row}
                        collapsed={tree.collapsed.has(row.key)}
                        onToggle={() => tree.toggle(row.key)}
                      />
                      {row.includesPriorYearEarnings ? (
                        <span className="muted"> (includes prior-year earnings)</span>
                      ) : null}
                    </td>
                    {(
                      [
                        'openingDebit',
                        'openingCredit',
                        'periodDebit',
                        'periodCredit',
                        'closingDebit',
                        'closingCredit',
                      ] as const
                    ).map((k) => (
                      <td key={k} className="num">
                        <DrillLink drill={row.drill} dimensionValueIds={dims}>
                          {formatAmount(row[k], cur)}
                        </DrillLink>
                      </td>
                    ))}
                    {showFx ? (
                      <td className="num">
                        {row.accountCurrency
                          ? `${formatAmount(row.accountCurrency.closing, row.accountCurrency.code)} ${row.accountCurrency.code}`
                          : ''}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th className="num">{formatAmount(report.totals.openingDebit, cur)}</th>
                  <th className="num">{formatAmount(report.totals.openingCredit, cur)}</th>
                  <th className="num">{formatAmount(report.totals.periodDebit, cur)}</th>
                  <th className="num">{formatAmount(report.totals.periodCredit, cur)}</th>
                  <th className="num" data-testid="tb-closing-debit">
                    {formatAmount(report.totals.closingDebit, cur)}
                  </th>
                  <th className="num">{formatAmount(report.totals.closingCredit, cur)}</th>
                  {showFx ? <th /> : null}
                </tr>
              </tfoot>
            </table>
          </>
        ) : null}
      </Card>
    </ReportShell>
  );
}

// ---------------------------------------------------------------------------
// Sectioned statements (P&L, Balance Sheet)
// ---------------------------------------------------------------------------

function SectionTable({
  sections,
  columns,
  currency,
  showFx,
  dims,
  summaryRows,
}: {
  sections: StatementSection[];
  columns: { key: string; label: string }[];
  currency: string;
  showFx: boolean;
  dims: string | null;
  summaryRows: { label: string; amounts: string[]; testId?: string }[];
}) {
  const tree = useCollapse();
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Account</th>
          {columns.map((c) => (
            <th key={c.key} className="num">
              {c.label}
            </th>
          ))}
          {showFx ? <th>Account currency</th> : null}
        </tr>
      </thead>
      {sections.map((section) => (
        <tbody key={section.key}>
          <tr className="row--section">
            <th colSpan={columns.length + 1 + (showFx ? 1 : 0)}>{section.label}</th>
          </tr>
          {tree.visible(section.rows).map((row) => (
            <tr key={row.key} className={row.isLeaf ? undefined : 'row--group'}>
              <td>
                <AccountName
                  row={row}
                  collapsed={tree.collapsed.has(row.key)}
                  onToggle={() => tree.toggle(row.key)}
                />
                {row.partial ? <span className="muted"> (part)</span> : null}
                {row.rowType === 'computed' ? <span className="muted"> (computed)</span> : null}
              </td>
              {row.amounts.map((amount, i) => (
                <td key={i} className="num">
                  <DrillLink drill={row.drills[i] ?? null} dimensionValueIds={dims}>
                    {formatAmount(amount, currency)}
                  </DrillLink>
                </td>
              ))}
              {showFx ? (
                <td className="num">
                  {row.accountCurrency
                    ? row.accountCurrency.amounts
                        .map(
                          (a) =>
                            `${formatAmount(a, row.accountCurrency!.code)} ${row.accountCurrency!.code}`,
                        )
                        .join(' / ')
                    : ''}
                </td>
              ) : null}
            </tr>
          ))}
          <tr className="row--subtotal">
            <th>Total {section.label}</th>
            {section.total.map((t, i) => (
              <th key={i} className="num">
                {formatAmount(t, currency)}
              </th>
            ))}
            {showFx ? <th /> : null}
          </tr>
        </tbody>
      ))}
      <tfoot>
        {summaryRows.map((s) => (
          <tr key={s.label} className="row--total">
            <th>{s.label}</th>
            {s.amounts.map((a, i) => (
              <th key={i} className="num" data-testid={i === 0 ? s.testId : undefined}>
                {formatAmount(a, currency)}
              </th>
            ))}
            {showFx ? <th /> : null}
          </tr>
        ))}
      </tfoot>
    </table>
  );
}

export function ProfitAndLossPage() {
  const { result, searchParams, setSearchParams } =
    useReportQuery<ProfitAndLossReport>('profit-and-loss');
  const report = result.data;
  return (
    <ReportShell
      kind="profit-and-loss"
      title="Profit & Loss"
      description="Revenue and expenses from posted journals for the selected range."
      searchParams={searchParams}
      setSearchParams={setSearchParams}
    >
      <Card>
        {result.isPending ? (
          <Spinner label="Loading report" />
        ) : result.isError ? (
          <ReportError error={result.error} />
        ) : report ? (
          <>
            <IntegrityPanel integrity={report.integrity} currency={report.baseCurrency} />
            <ReportNotices {...report} />
            <SectionTable
              sections={report.sections}
              columns={report.columns}
              currency={report.baseCurrency}
              showFx={report.currencyView === 'base_and_account'}
              dims={searchParams.get('dimensionValueIds')}
              summaryRows={[
                { label: 'Gross Profit', amounts: report.summary.grossProfit },
                { label: 'Operating Profit', amounts: report.summary.operatingProfit },
                {
                  label: 'Net Profit (Loss)',
                  amounts: report.summary.netProfit,
                  testId: 'net-profit',
                },
              ]}
            />
          </>
        ) : null}
      </Card>
    </ReportShell>
  );
}

export function BalanceSheetPage() {
  const { result, searchParams, setSearchParams } =
    useReportQuery<BalanceSheetReport>('balance-sheet');
  const report = result.data;
  return (
    <ReportShell
      kind="balance-sheet"
      title="Balance Sheet"
      description="Assets, liabilities and equity from posted journals, with virtual year-end earnings."
      searchParams={searchParams}
      setSearchParams={setSearchParams}
    >
      <Card>
        {result.isPending ? (
          <Spinner label="Loading report" />
        ) : result.isError ? (
          <ReportError error={result.error} />
        ) : report ? (
          <>
            <IntegrityPanel integrity={report.integrity} currency={report.baseCurrency} />
            <ReportNotices {...report} />
            <SectionTable
              sections={report.sections}
              columns={report.columns}
              currency={report.baseCurrency}
              showFx={report.currencyView === 'base_and_account'}
              dims={searchParams.get('dimensionValueIds')}
              summaryRows={[
                {
                  label: 'Total Assets',
                  amounts: report.totals.totalAssets,
                  testId: 'total-assets',
                },
                { label: 'Total Liabilities', amounts: report.totals.totalLiabilities },
                { label: 'Total Equity', amounts: report.totals.totalEquity },
                {
                  label: 'Total Liabilities and Equity',
                  amounts: report.totals.totalLiabilitiesAndEquity,
                },
              ]}
            />
          </>
        ) : null}
      </Card>
    </ReportShell>
  );
}
