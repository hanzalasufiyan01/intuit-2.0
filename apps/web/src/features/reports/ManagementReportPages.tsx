import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { FilterBar } from '../../shared/ui/FilterBar';
import { Spinner } from '../../shared/ui/Spinner';
import { Tabs } from '../../shared/ui/Tabs';
import { TextField } from '../../shared/ui/TextField';
import { AccountingPage, useOrgKey } from '../accounting/shared';
import { SalesNav } from '../sales/shared';
import { SectionTable } from './ReportPages';
import type { ProfitAndLossReport } from './types';
import { useT, type MessageKey } from '../../i18n/i18n';

/**
 * Management reports (FP-22): sales trend, inventory low stock / slow-moving / COGS profitability
 * and the tax liability review summary. Read-only; the server computes every figure.
 */

const today = () => new Date().toISOString().slice(0, 10);

function usePeriod() {
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(today());
  const [applied, setApplied] = useState({ from, to });
  return { from, to, setFrom, setTo, applied, apply: () => setApplied({ from, to }) };
}

function PeriodForm({
  period,
  children,
}: {
  period: ReturnType<typeof usePeriod>;
  children?: React.ReactNode;
}) {
  const t = useT();
  return (
    <Card>
      <FilterBar
        label={t('common.filters')}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          period.apply();
        }}
      >
        <TextField
          label={t('reports.managementReportPages.from')}
          type="date"
          value={period.from}
          onChange={(e) => period.setFrom(e.target.value)}
        />
        <TextField
          label={t('reports.managementReportPages.to')}
          type="date"
          value={period.to}
          onChange={(e) => period.setTo(e.target.value)}
        />
        {children}
        <Button type="submit">{t('reports.managementReportPages.runReport')}</Button>
      </FilterBar>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sales trend
// ---------------------------------------------------------------------------

interface TrendReport {
  baseCurrency: string;
  granularity: string;
  periods: {
    periodStart: string;
    invoices: number;
    creditNotes: number;
    netSales: string;
    tax: string;
  }[];
  totals: { netSales: string; tax: string; total: string };
}

export function SalesTrendPage() {
  const t = useT();
  const org = useOrgKey();
  const period = usePeriod();
  const [granularity, setGranularity] = useState('month');
  const [appliedGranularity, setAppliedGranularity] = useState('month');
  const query = useQuery({
    queryKey: ['report-sales-trend', org, period.applied, appliedGranularity],
    queryFn: () =>
      api.get<TrendReport>(
        `/sales/reports/sales-trend?from=${period.applied.from}&to=${period.applied.to}&granularity=${appliedGranularity}`,
      ),
  });
  const report = query.data;
  const money = (v: string) => formatAmount(v, report?.baseCurrency ?? 'MVR');
  return (
    <>
      <SalesNav />
      <PageHeader
        title={t('reports.managementReportPages.salesTrend')}
        description={t('reports.managementReportPages.netSalesAndTaxBy')}
      />
      <PeriodForm
        period={{
          ...period,
          apply: () => {
            period.apply();
            setAppliedGranularity(granularity);
          },
        }}
      >
        <div className="field">
          <label htmlFor="trend-granularity">{t('reports.managementReportPages.groupBy')}</label>
          <select
            id="trend-granularity"
            value={granularity}
            onChange={(e) => setGranularity(e.target.value)}
          >
            <option value="day">{t('reports.managementReportPages.day')}</option>
            <option value="week">{t('reports.managementReportPages.week')}</option>
            <option value="month">{t('reports.managementReportPages.month')}</option>
          </select>
        </div>
      </PeriodForm>
      {query.isPending ? <Spinner /> : null}
      <ErrorAlert error={query.error} />
      {report ? (
        <Card title={t('reports.managementReportPages.salesByPeriod')}>
          {report.periods.length === 0 ? (
            <p className="muted">{t('reports.managementReportPages.noSalesInThisPeriod')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('reports.managementReportPages.periodStarting')}</th>
                  <th className="num">{t('reports.managementReportPages.invoices')}</th>
                  <th className="num">{t('reports.managementReportPages.creditNotes')}</th>
                  <th className="num">{t('reports.managementReportPages.netSales')}</th>
                  <th className="num">{t('reports.managementReportPages.tax')}</th>
                </tr>
              </thead>
              <tbody>
                {report.periods.map((p) => (
                  <tr key={p.periodStart}>
                    <td>{p.periodStart}</td>
                    <td className="num">{p.invoices}</td>
                    <td className="num">{p.creditNotes}</td>
                    <td className="num">{money(p.netSales)}</td>
                    <td className="num">{money(p.tax)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>{t('reports.managementReportPages.total')}</th>
                  <th className="num">{money(report.totals.netSales)}</th>
                  <th className="num">{money(report.totals.tax)}</th>
                </tr>
              </tfoot>
            </table>
          )}
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Inventory reports
// ---------------------------------------------------------------------------

interface LowStock {
  items: {
    itemId: string;
    sku: string | null;
    name: string;
    quantity: string;
    reorderPoint: string;
    shortfall: string;
  }[];
}
interface SlowMoving {
  asOf: string;
  baseCurrency: string;
  note: string;
  items: {
    itemId: string;
    name: string;
    quantity: string;
    value: string;
    lastSale: string | null;
    lastReceipt: string | null;
    daysSinceLastSale: number | null;
    bucket: string;
  }[];
  totals: Record<string, string>;
}
interface Profitability {
  baseCurrency: string;
  note: string;
  items: {
    itemId: string;
    name: string;
    quantitySold: string;
    netSales: string;
    cogs: string;
    grossMargin: string;
    marginPercent: string | null;
  }[];
  totals: { netSales: string; cogs: string; grossMargin: string; marginPercent: string | null };
}

const BUCKET_LABEL: Record<string, MessageKey> = {
  days0to30: 'reports.managementReportPages.bucket.days0to30',
  days31to60: 'reports.managementReportPages.bucket.days31to60',
  days61to90: 'reports.managementReportPages.bucket.days61to90',
  over90: 'reports.managementReportPages.bucket.over90',
  neverSold: 'reports.managementReportPages.bucket.neverSold',
};

export function InventoryReportsPage() {
  const t = useT();
  const org = useOrgKey();
  const [view, setView] = useState<'low' | 'slow' | 'profit'>('low');
  const period = usePeriod();
  const [asOf, setAsOf] = useState(today());
  const [appliedAsOf, setAppliedAsOf] = useState(asOf);
  const low = useQuery({
    queryKey: ['report-low-stock', org],
    enabled: view === 'low',
    queryFn: () => api.get<LowStock>('/inventory/reports/low-stock'),
  });
  const slow = useQuery({
    queryKey: ['report-slow-moving', org, appliedAsOf],
    enabled: view === 'slow',
    queryFn: () => api.get<SlowMoving>(`/inventory/reports/slow-moving?asOf=${appliedAsOf}`),
  });
  const profit = useQuery({
    queryKey: ['report-cogs-profit', org, period.applied],
    enabled: view === 'profit',
    queryFn: () =>
      api.get<Profitability>(
        `/inventory/reports/cogs-profitability?from=${period.applied.from}&to=${period.applied.to}`,
      ),
  });
  const money = (v: string, currency = 'MVR') => formatAmount(v, currency);
  return (
    <>
      <PageHeader
        title={t('reports.managementReportPages.inventoryReports')}
        description={t('reports.managementReportPages.lowStockSlowMovingStock')}
      />
      <Tabs
        label={t('reports.managementReportPages.inventoryReport')}
        tabs={[
          { value: 'low', label: t('reports.managementReportPages.viewLow') },
          { value: 'slow', label: t('reports.managementReportPages.viewSlow') },
          { value: 'profit', label: t('reports.managementReportPages.viewProfit') },
        ]}
        value={view}
        onChange={setView}
      >
        {view === 'low' ? (
          <Card title={t('reports.managementReportPages.itemsAtOrBelowTheir')}>
            {low.isPending ? <Spinner /> : null}
            <ErrorAlert error={low.error} />
            {low.data ? (
              low.data.items.length === 0 ? (
                <p className="muted">{t('reports.managementReportPages.noTrackedItemIsAt')}</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('reports.managementReportPages.item')}</th>
                      <th className="num">{t('reports.managementReportPages.onHand')}</th>
                      <th className="num">{t('reports.managementReportPages.reorderPoint')}</th>
                      <th className="num">{t('reports.managementReportPages.shortfall')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {low.data.items.map((i) => (
                      <tr key={i.itemId}>
                        <td>{i.name}</td>
                        <td className="num">{i.quantity}</td>
                        <td className="num">{i.reorderPoint}</td>
                        <td className="num">{i.shortfall}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : null}
          </Card>
        ) : null}
        {view === 'slow' ? (
          <>
            <Card>
              <FilterBar
                label={t('common.filters')}
                onSubmit={(e) => {
                  e.preventDefault();
                  setAppliedAsOf(asOf);
                }}
              >
                <TextField
                  label={t('reports.managementReportPages.asOf')}
                  type="date"
                  value={asOf}
                  onChange={(e) => setAsOf(e.target.value)}
                />
                <Button type="submit">{t('reports.managementReportPages.runReport')}</Button>
              </FilterBar>
            </Card>
            {slow.isPending ? <Spinner /> : null}
            <ErrorAlert error={slow.error} />
            {slow.data ? (
              <Card title={t('reports.managementReportPages.stockByDaysSinceLast')}>
                <p className="muted">{slow.data.note}</p>
                {slow.data.items.length === 0 ? (
                  <p className="muted">{t('reports.managementReportPages.noStockOnHand')}</p>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('reports.managementReportPages.item')}</th>
                        <th className="num">{t('reports.managementReportPages.onHand')}</th>
                        <th className="num">{t('reports.managementReportPages.value')}</th>
                        <th>{t('reports.managementReportPages.lastSale')}</th>
                        <th className="num">{t('reports.managementReportPages.days')}</th>
                        <th>{t('reports.managementReportPages.age')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {slow.data.items.map((i) => (
                        <tr key={i.itemId}>
                          <td>{i.name}</td>
                          <td className="num">{i.quantity}</td>
                          <td className="num">{money(i.value, slow.data.baseCurrency)}</td>
                          <td>{i.lastSale ?? '—'}</td>
                          <td className="num">{i.daysSinceLastSale ?? '—'}</td>
                          <td>{BUCKET_LABEL[i.bucket] ? t(BUCKET_LABEL[i.bucket]!) : i.bucket}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            ) : null}
          </>
        ) : null}
        {view === 'profit' ? (
          <>
            <PeriodForm period={period} />
            {profit.isPending ? <Spinner /> : null}
            <ErrorAlert error={profit.error} />
            {profit.data ? (
              <Card title={t('reports.managementReportPages.netSalesCostAndMargin')}>
                <p className="muted">{profit.data.note}</p>
                {profit.data.items.length === 0 ? (
                  <p className="muted">
                    {t('reports.managementReportPages.noSalesOfTrackedItems')}
                  </p>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('reports.managementReportPages.item')}</th>
                        <th className="num">{t('reports.managementReportPages.sold')}</th>
                        <th className="num">{t('reports.managementReportPages.netSales')}</th>
                        <th className="num">{t('reports.managementReportPages.cost')}</th>
                        <th className="num">{t('reports.managementReportPages.margin')}</th>
                        <th className="num">{t('reports.managementReportPages.margin2')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profit.data.items.map((i) => (
                        <tr key={i.itemId}>
                          <td>{i.name}</td>
                          <td className="num">{i.quantitySold}</td>
                          <td className="num">{money(i.netSales, profit.data.baseCurrency)}</td>
                          <td className="num">{money(i.cogs, profit.data.baseCurrency)}</td>
                          <td className="num">{money(i.grossMargin, profit.data.baseCurrency)}</td>
                          <td className="num">{i.marginPercent ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th>{t('reports.managementReportPages.total')}</th>
                        <th />
                        <th className="num">
                          {money(profit.data.totals.netSales, profit.data.baseCurrency)}
                        </th>
                        <th className="num">
                          {money(profit.data.totals.cogs, profit.data.baseCurrency)}
                        </th>
                        <th className="num">
                          {money(profit.data.totals.grossMargin, profit.data.baseCurrency)}
                        </th>
                        <th className="num">{profit.data.totals.marginPercent ?? '—'}</th>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </Card>
            ) : null}
          </>
        ) : null}
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tax liability (review summary)
// ---------------------------------------------------------------------------

interface TaxLiability {
  baseCurrency: string;
  note: string;
  codes: {
    taxCodeId: string | null;
    code: string | null;
    rate: string | null;
    outputTax: string;
    recoverableInputTax: string;
    netPayable: string;
  }[];
  totals: { outputTax: string; recoverableInputTax: string; netPayable: string };
}

export function TaxLiabilityPage() {
  const t = useT();
  const org = useOrgKey();
  const period = usePeriod();
  const query = useQuery({
    queryKey: ['report-tax-liability', org, period.applied],
    queryFn: () =>
      api.get<TaxLiability>(
        `/accounting/reports/tax-liability?from=${period.applied.from}&to=${period.applied.to}`,
      ),
  });
  const report = query.data;
  const money = (v: string) => formatAmount(v, report?.baseCurrency ?? 'MVR');
  return (
    <>
      <PageHeader
        title={t('reports.managementReportPages.taxLiability')}
        description={t('reports.managementReportPages.outputTaxOnSalesLess')}
      />
      <AccountingPage>
        <PeriodForm period={period} />
        {query.isPending ? <Spinner /> : null}
        <ErrorAlert error={query.error} />
        {report ? (
          <Card title={t('reports.managementReportPages.taxByCode')}>
            <Alert>{report.note}</Alert>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('reports.managementReportPages.taxCode')}</th>
                  <th className="num">{t('reports.managementReportPages.rate')}</th>
                  <th className="num">{t('reports.managementReportPages.outputTax')}</th>
                  <th className="num">{t('reports.managementReportPages.inputTax')}</th>
                  <th className="num">{t('reports.managementReportPages.netPayable')}</th>
                </tr>
              </thead>
              <tbody>
                {report.codes.map((c) => (
                  <tr key={`${c.taxCodeId}-${c.rate}`}>
                    <td>{c.code ?? t('reports.managementReportPages.noTaxCode')}</td>
                    <td className="num">{c.rate ?? '—'}</td>
                    <td className="num">{money(c.outputTax)}</td>
                    <td className="num">{money(c.recoverableInputTax)}</td>
                    <td className="num">{money(c.netPayable)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={2}>{t('reports.managementReportPages.total')}</th>
                  <th className="num">{money(report.totals.outputTax)}</th>
                  <th className="num">{money(report.totals.recoverableInputTax)}</th>
                  <th className="num">{money(report.totals.netPayable)}</th>
                </tr>
              </tfoot>
            </table>
          </Card>
        ) : null}
      </AccountingPage>
    </>
  );
}

// ---------------------------------------------------------------------------
// Cash-basis profit and loss
// ---------------------------------------------------------------------------

export function CashBasisProfitLossPage() {
  const t = useT();
  const org = useOrgKey();
  const period = usePeriod();
  const query = useQuery({
    queryKey: ['report-pl-cash', org, period.applied],
    queryFn: () =>
      api.get<ProfitAndLossReport & { method: string }>(
        `/accounting/reports/profit-and-loss-cash-basis?from=${period.applied.from}&to=${period.applied.to}`,
      ),
  });
  const report = query.data;
  return (
    <>
      <PageHeader
        title={t('reports.managementReportPages.profitLossCashBasis')}
        description={t('reports.managementReportPages.revenueAndExpensesRecognisedWhen')}
      />
      <AccountingPage>
        <PeriodForm period={period} />
        {query.isPending ? <Spinner /> : null}
        <ErrorAlert error={query.error} />
        {report ? (
          <Card>
            <Alert>{report.method}</Alert>
            <SectionTable
              sections={report.sections}
              columns={report.columns}
              currency={report.baseCurrency}
              showFx={false}
              dims={null}
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
          </Card>
        ) : null}
      </AccountingPage>
    </>
  );
}

// ---------------------------------------------------------------------------
// Expense claims by claimant
// ---------------------------------------------------------------------------

interface ClaimantReport {
  baseCurrency: string;
  claimants: {
    partyId: string;
    displayName: string;
    claims: number;
    pending: string;
    approved: string;
    posted: string;
    total: string;
  }[];
  totals: { claims: number; total: string };
}

export function ClaimsByClaimantPage() {
  const t = useT();
  const org = useOrgKey();
  const period = usePeriod();
  const query = useQuery({
    queryKey: ['report-claims-by-claimant', org, period.applied],
    queryFn: () =>
      api.get<ClaimantReport>(
        `/expense-claims/reports/by-claimant?from=${period.applied.from}&to=${period.applied.to}`,
      ),
  });
  const report = query.data;
  const money = (v: string) => formatAmount(v, report?.baseCurrency ?? 'MVR');
  return (
    <>
      <PageHeader
        title={t('reports.managementReportPages.expenseClaimsByClaimant')}
        description={t('reports.managementReportPages.claimsWaitingForApprovalApproved')}
      />
      <PeriodForm period={period} />
      {query.isPending ? <Spinner /> : null}
      <ErrorAlert error={query.error} />
      {report ? (
        <Card>
          {report.claimants.length === 0 ? (
            <p className="muted">{t('reports.managementReportPages.noClaimsInThisPeriod')}</p>
          ) : null}
          {report.claimants.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('reports.managementReportPages.claimant')}</th>
                  <th className="num">{t('reports.managementReportPages.claims')}</th>
                  <th className="num">{t('reports.managementReportPages.waiting')}</th>
                  <th className="num">{t('reports.managementReportPages.approved')}</th>
                  <th className="num">{t('reports.managementReportPages.posted')}</th>
                  <th className="num">{t('reports.managementReportPages.total')}</th>
                </tr>
              </thead>
              <tbody>
                {report.claimants.map((c) => (
                  <tr key={c.partyId}>
                    <td>{c.displayName}</td>
                    <td className="num">{c.claims}</td>
                    <td className="num">{money(c.pending)}</td>
                    <td className="num">{money(c.approved)}</td>
                    <td className="num">{money(c.posted)}</td>
                    <td className="num">{money(c.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>{t('reports.managementReportPages.total')}</th>
                  <th className="num">{report.totals.claims}</th>
                  <td colSpan={3} />
                  <th className="num">{money(report.totals.total)}</th>
                </tr>
              </tfoot>
            </table>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Profit and loss by dimension (branch, department, ...)
// ---------------------------------------------------------------------------

interface DimensionTypeOption {
  id: string;
  code: string;
  name: string;
}
interface ByDimensionRow {
  dimensionValueId?: string;
  code?: string;
  name?: string;
  revenue: string;
  costOfGoodsSold: string;
  operatingExpenses: string;
  grossProfit: string;
  netProfit: string;
}
interface ByDimensionReport {
  dimensionType: DimensionTypeOption;
  baseCurrency: string;
  values: ByDimensionRow[];
  unassigned: ByDimensionRow;
  total: ByDimensionRow;
  note: string;
}

export function ProfitLossByDimensionPage() {
  const translate = useT();
  const org = useOrgKey();
  const period = usePeriod();
  const [typeId, setTypeId] = useState('');
  const types = useQuery({
    queryKey: ['dimension-types', org],
    queryFn: () => api.get<DimensionTypeOption[]>('/accounting/dimensions'),
  });
  const query = useQuery({
    queryKey: ['report-pl-dimension', org, typeId, period.applied],
    enabled: typeId !== '',
    queryFn: () =>
      api.get<ByDimensionReport>(
        `/accounting/reports/profit-and-loss-by-dimension?dimensionTypeId=${typeId}&from=${period.applied.from}&to=${period.applied.to}`,
      ),
  });
  const report = query.data;
  const money = (v: string) => formatAmount(v, report?.baseCurrency ?? 'MVR');
  const row = (label: string, r: ByDimensionRow, key: string, strong = false) => (
    <tr key={key}>
      {strong ? <th>{label}</th> : <td>{label}</td>}
      {[r.revenue, r.costOfGoodsSold, r.operatingExpenses, r.grossProfit, r.netProfit].map(
        (v, i) =>
          strong ? (
            <th key={i} className="num">
              {money(v)}
            </th>
          ) : (
            <td key={i} className="num">
              {money(v)}
            </td>
          ),
      )}
    </tr>
  );
  return (
    <>
      <PageHeader
        title={translate('reports.managementReportPages.profitLossByDimension')}
        description={translate('reports.managementReportPages.oneColumnOfResultsPer')}
      />
      <AccountingPage>
        <PeriodForm period={period}>
          <div className="field">
            <label htmlFor="pl-dimension">
              {translate('reports.managementReportPages.dimension')}
            </label>
            <select id="pl-dimension" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">{translate('common.choose')}</option>
              {(types.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </PeriodForm>
        {query.isPending && typeId !== '' ? <Spinner /> : null}
        <ErrorAlert error={query.error ?? types.error} />
        {report ? (
          <Card title={`${report.dimensionType.name} (${report.baseCurrency})`}>
            <table className="table">
              <thead>
                <tr>
                  <th>{report.dimensionType.name}</th>
                  <th className="num">{translate('reports.managementReportPages.revenue')}</th>
                  <th className="num">
                    {translate('reports.managementReportPages.costOfGoodsSold')}
                  </th>
                  <th className="num">
                    {translate('reports.managementReportPages.operatingExpenses')}
                  </th>
                  <th className="num">{translate('reports.managementReportPages.grossProfit')}</th>
                  <th className="num">{translate('reports.managementReportPages.netProfit')}</th>
                </tr>
              </thead>
              <tbody>
                {report.values.map((v) =>
                  row(`${v.code} ${v.name}`, v, v.dimensionValueId ?? v.code ?? ''),
                )}
                {row(
                  translate('reports.managementReportPages.unassigned'),
                  report.unassigned,
                  'unassigned',
                )}
                {row(translate('reports.managementReportPages.total'), report.total, 'total', true)}
              </tbody>
            </table>
            <Alert tone="info">{report.note}</Alert>
          </Card>
        ) : null}
      </AccountingPage>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sales by dimension (branch sales)
// ---------------------------------------------------------------------------

interface SalesByDimensionReport {
  dimensionType: DimensionTypeOption;
  baseCurrency: string;
  values: {
    dimensionValueId: string | null;
    code: string | null;
    name: string | null;
    invoices: number;
    creditNotes: number;
    netSales: string;
    tax: string;
    total: string;
  }[];
  totals: { netSales: string; tax: string };
}

export function SalesByDimensionPage() {
  const translate = useT();
  const org = useOrgKey();
  const period = usePeriod();
  const [typeId, setTypeId] = useState('');
  const types = useQuery({
    queryKey: ['dimension-types', org],
    queryFn: () => api.get<DimensionTypeOption[]>('/accounting/dimensions'),
  });
  const query = useQuery({
    queryKey: ['report-sales-dimension', org, typeId, period.applied],
    enabled: typeId !== '',
    queryFn: () =>
      api.get<SalesByDimensionReport>(
        `/sales/reports/sales-by-dimension?dimensionTypeId=${typeId}&from=${period.applied.from}&to=${period.applied.to}`,
      ),
  });
  const report = query.data;
  const money = (v: string) => formatAmount(v, report?.baseCurrency ?? 'MVR');
  return (
    <>
      <PageHeader
        title={translate('reports.managementReportPages.salesByDimension')}
        description={translate('reports.managementReportPages.issuedInvoicesLessCreditNotes')}
      />
      <AccountingPage>
        <PeriodForm period={period}>
          <div className="field">
            <label htmlFor="sales-dimension">
              {translate('reports.managementReportPages.dimension')}
            </label>
            <select id="sales-dimension" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">{translate('common.choose')}</option>
              {(types.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </PeriodForm>
        {query.isPending && typeId !== '' ? <Spinner /> : null}
        <ErrorAlert error={query.error ?? types.error} />
        {report ? (
          <Card title={`${report.dimensionType.name} (${report.baseCurrency})`}>
            <table className="table">
              <thead>
                <tr>
                  <th>{report.dimensionType.name}</th>
                  <th className="num">{translate('reports.managementReportPages.invoices')}</th>
                  <th className="num">{translate('reports.managementReportPages.creditNotes')}</th>
                  <th className="num">{translate('reports.managementReportPages.netSales')}</th>
                  <th className="num">{translate('reports.managementReportPages.tax')}</th>
                  <th className="num">{translate('reports.managementReportPages.total')}</th>
                </tr>
              </thead>
              <tbody>
                {report.values.map((v) => (
                  <tr key={v.dimensionValueId ?? 'unassigned'}>
                    <td>
                      {v.code
                        ? `${v.code} ${v.name}`
                        : translate('reports.managementReportPages.unassigned')}
                    </td>
                    <td className="num">{v.invoices}</td>
                    <td className="num">{v.creditNotes}</td>
                    <td className="num">{money(v.netSales)}</td>
                    <td className="num">{money(v.tax)}</td>
                    <td className="num">{money(v.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>{translate('reports.managementReportPages.total')}</th>
                  <th className="num">{money(report.totals.netSales)}</th>
                  <th className="num">{money(report.totals.tax)}</th>
                  <th />
                </tr>
              </tfoot>
            </table>
          </Card>
        ) : null}
      </AccountingPage>
    </>
  );
}
