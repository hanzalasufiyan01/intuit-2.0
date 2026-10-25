import { formatAmount } from '../../shared/money';
import { Badge } from '../../shared/ui/Badge';
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
import { useT } from '../../i18n/i18n';

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
  const t = useT();
  return (
    <span style={{ paddingLeft: row.level * 18 }}>
      {!row.isLeaf ? (
        <button
          type="button"
          className="link-button"
          aria-label={t(
            collapsed ? 'reports.reportPages.expandNamed' : 'reports.reportPages.collapseNamed',
            {
              name: row.name,
            },
          )}
          onClick={onToggle}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      ) : null}{' '}
      {row.code ? `${row.code} ` : ''}
      {row.name}
      {row.archived ? (
        <>
          {' '}
          <Badge tone="neutral">{t('reports.reportPages.archived')}</Badge>
        </>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Trial Balance
// ---------------------------------------------------------------------------

export function TrialBalancePage() {
  const t = useT();
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
      title={t('reports.reportPages.trialBalance')}
      description={t('reports.reportPages.postedLedgerBalancesWithinOne')}
      searchParams={searchParams}
      setSearchParams={setSearchParams}
    >
      <Card>
        {result.isPending ? (
          <Spinner label={t('reports.reportPages.loadingReport')} />
        ) : result.isError ? (
          <ReportError error={result.error} />
        ) : report ? (
          <>
            <p className="muted">
              {t('reports.reportPages.to', {
                name: report.fiscalYear.name,
                from: report.from,
                to: report.to,
                baseCurrency: report.baseCurrency,
              })}
            </p>
            <IntegrityPanel integrity={report.integrity} currency={cur} />
            <ReportNotices {...report} />
            <div className="actions">
              <Button variant="ghost" onClick={tree.expandAll}>
                {t('reports.reportPages.expandAll')}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  tree.collapseAll(report.rows.filter((r) => !r.isLeaf).map((r) => r.key))
                }
              >
                {t('reports.reportPages.collapseAll')}
              </Button>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('reports.reportPages.account')}</th>
                  <th>{t('reports.reportPages.openingDr')}</th>
                  <th>{t('reports.reportPages.openingCr')}</th>
                  <th>{t('reports.reportPages.periodDr')}</th>
                  <th>{t('reports.reportPages.periodCr')}</th>
                  <th>{t('reports.reportPages.closingDr')}</th>
                  <th>{t('reports.reportPages.closingCr')}</th>
                  {showFx ? <th>{t('reports.reportPages.accountCurrencyClosing')}</th> : null}
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
                        <span className="muted">
                          {' '}
                          {t('reports.reportPages.includesPriorYearEarnings')}
                        </span>
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
                  <th>{t('reports.reportPages.total')}</th>
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

export function SectionTable({
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
  const translate = useT();
  const tree = useCollapse();
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{translate('reports.reportPages.account')}</th>
          {columns.map((c) => (
            <th key={c.key} className="num">
              {c.label}
            </th>
          ))}
          {showFx ? <th>{translate('reports.reportPages.accountCurrency')}</th> : null}
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
                {row.partial ? (
                  <span className="muted"> {translate('reports.reportPages.part')}</span>
                ) : null}
                {row.rowType === 'computed' ? (
                  <span className="muted"> {translate('reports.reportPages.computed')}</span>
                ) : null}
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
            <th>{translate('reports.reportPages.total2', { label: section.label })}</th>
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
  const t = useT();
  const { result, searchParams, setSearchParams } =
    useReportQuery<ProfitAndLossReport>('profit-and-loss');
  const report = result.data;
  return (
    <ReportShell
      kind="profit-and-loss"
      title={t('reports.reportPages.profitLoss')}
      description={t('reports.reportPages.revenueAndExpensesFromPosted')}
      searchParams={searchParams}
      setSearchParams={setSearchParams}
    >
      <Card>
        {result.isPending ? (
          <Spinner label={t('reports.reportPages.loadingReport')} />
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
                { label: t('reports.grossProfit'), amounts: report.summary.grossProfit },
                { label: t('reports.operatingProfit'), amounts: report.summary.operatingProfit },
                {
                  label: t('reports.netProfitLoss'),
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
  const t = useT();
  const { result, searchParams, setSearchParams } =
    useReportQuery<BalanceSheetReport>('balance-sheet');
  const report = result.data;
  return (
    <ReportShell
      kind="balance-sheet"
      title={t('reports.reportPages.balanceSheet')}
      description={t('reports.reportPages.assetsLiabilitiesAndEquityFrom')}
      searchParams={searchParams}
      setSearchParams={setSearchParams}
    >
      <Card>
        {result.isPending ? (
          <Spinner label={t('reports.reportPages.loadingReport')} />
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
                  label: t('reports.reportPages.totalAssets'),
                  amounts: report.totals.totalAssets,
                  testId: 'total-assets',
                },
                {
                  label: t('reports.reportPages.totalLiabilities'),
                  amounts: report.totals.totalLiabilities,
                },
                { label: t('reports.reportPages.totalEquity'), amounts: report.totals.totalEquity },
                {
                  label: t('reports.reportPages.totalLiabilitiesAndEquity'),
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
