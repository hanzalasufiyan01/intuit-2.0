import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useT, type MessageKey } from '../../i18n/i18n';
import { api } from '../../services/api-client';
import { COMMON_CURRENCIES, formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { useItemOptions, useOrgKey } from '../sales/shared';
import type { Page } from '../sales/types';
import { PurchasesNav } from './PurchasesSection';
import {
  AP_AGING_BUCKETS,
  type ApAgingBucket,
  type ApAgingReport,
  type ApReconciliation,
  type InputTaxSummaryReport,
  type PaymentRegisterReport,
  type PurchasesByAccountReport,
  type PurchasesByItemReport,
  type PurchasesByVendorReport,
  type PurchaseSums,
  type RegisterSummary,
  type UnpaidBillsReport,
  type VendorStatement,
  type VendorSummary,
} from './types';

// PD9: one page, nine tabs (4B-5's three, then 4B-6's six).
const VIEWS = [
  'aging',
  'statement',
  'reconciliation',
  'unpaid',
  'byVendor',
  'byItem',
  'byAccount',
  'inputTax',
  'register',
] as const;
type View = (typeof VIEWS)[number];

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

/** Where each AP document opens (drill-down). */
const DOC_PATHS: Record<string, string> = {
  bill: '/purchases/bills',
  vendor_credit: '/purchases/vendor-credits',
  payment: '/purchases/payments',
  refund: '/purchases/refunds',
};

type DocKind = 'bill' | 'vendor_credit' | 'debit_note' | 'payment' | 'refund';
const docKind = (type: string, origin: string | null): DocKind =>
  type === 'vendor_credit' && origin === 'debit_note' ? 'debit_note' : (type as DocKind);

/**
 * AP aging, vendor statements and the AP reconciliation (Phase 4B-5); unpaid bills, purchases by
 * vendor, item and account, the input-tax summary and the payment register (Phase 4B-6). P4-49.
 * Every view needs
 * `purchases.reports.view` on the server. Amounts read "what we owe": bills positive, credits and
 * prepayments negative (PD4); bases are historical (PD7).
 */
export function PurchasesReportsPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const view: View = (VIEWS as readonly string[]).includes(params.get('view') ?? '')
    ? (params.get('view') as View)
    : 'aging';
  return (
    <>
      <PageHeader
        title={t('purchases.reports.title')}
        description={t('purchases.reports.description')}
      />
      <PurchasesNav />
      <nav className="tabs" aria-label={t('purchases.reports.views')}>
        {VIEWS.map((v) => (
          <Button
            key={v}
            aria-current={v === view ? 'page' : undefined}
            variant={v === view ? 'primary' : 'ghost'}
            onClick={() => setParams({ view: v })}
          >
            {t(`purchases.reports.view.${v}`)}
          </Button>
        ))}
      </nav>
      {view === 'aging' ? <AgingView /> : null}
      {view === 'statement' ? (
        <StatementView initialVendorId={params.get('vendorId') ?? ''} />
      ) : null}
      {view === 'reconciliation' ? <ReconciliationView /> : null}
      {view === 'unpaid' ? <UnpaidBillsView /> : null}
      {view === 'byVendor' ? <ByVendorView /> : null}
      {view === 'byItem' ? <ByItemView /> : null}
      {view === 'byAccount' ? <ByAccountView /> : null}
      {view === 'inputTax' ? <InputTaxView /> : null}
      {view === 'register' ? <RegisterView /> : null}
    </>
  );
}

function useReport<T>(name: string, path: string | null) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['purchases-report', org, name, path],
    queryFn: () => api.get<T>(path!),
    enabled: path !== null,
  });
}

function Result<T>({
  query,
  children,
}: {
  query: ReturnType<typeof useReport<T>>;
  children: (data: T) => ReactNode;
}) {
  const t = useT();
  if (query.fetchStatus === 'idle' && query.isPending) return null;
  if (query.isPending) return <Spinner label={t('common.loading')} />;
  if (query.isError) return <ErrorAlert error={query.error} />;
  return <>{children(query.data)}</>;
}

function AsOfForm({ onRun }: { onRun: (asOf: string) => void }) {
  const t = useT();
  const [asOf, setAsOf] = useState(today());
  return (
    <form
      className="form form--inline"
      onSubmit={(e) => {
        e.preventDefault();
        onRun(asOf);
      }}
    >
      <TextField
        label={t('purchases.reports.asOf')}
        type="date"
        value={asOf}
        required
        onChange={(e) => setAsOf(e.target.value)}
      />
      <Button type="submit">{t('purchases.reports.run')}</Button>
    </form>
  );
}

const COLUMNS = [...AP_AGING_BUCKETS, 'credit', 'total'] as const;

function AgingView() {
  const t = useT();
  const [applied, setApplied] = useState(today());
  const [open, setOpen] = useState<string | null>(null);
  const report = useReport<ApAgingReport>('aging', `/purchases/reports/aging?asOf=${applied}`);
  return (
    <Card>
      <AsOfForm onRun={setApplied} />
      <Result query={report}>
        {(data) =>
          data.vendors.length === 0 ? (
            <p className="muted">{t('purchases.reports.noOpenItems')}</p>
          ) : (
            <table className="table">
              <caption className="muted">
                {t('purchases.reports.inBase', { currency: data.baseCurrency })}
              </caption>
              <thead>
                <tr>
                  <th>{t('purchases.reports.vendor')}</th>
                  {COLUMNS.map((b) => (
                    <th key={b} className="num">
                      {t(`purchases.reports.bucket.${b}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.vendors.map((v) => (
                  <AgingRows
                    key={v.vendorId}
                    vendor={v}
                    base={data.baseCurrency}
                    open={open === v.vendorId}
                    onToggle={() => setOpen(open === v.vendorId ? null : v.vendorId)}
                  />
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>{t('purchases.reports.bucket.total')}</th>
                  {COLUMNS.map((b) => (
                    <td key={b} className="num">
                      {formatAmount(data.totals[b], data.baseCurrency)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          )
        }
      </Result>
    </Card>
  );
}

function AgingRows({
  vendor,
  base,
  open,
  onToggle,
}: {
  vendor: ApAgingReport['vendors'][number];
  base: string;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <>
      <tr>
        <td>
          <button type="button" className="link-button" aria-expanded={open} onClick={onToggle}>
            {vendor.vendorName ?? vendor.vendorId}
          </button>
        </td>
        {COLUMNS.map((b) => (
          <td key={b} className="num">
            {formatAmount(vendor.base[b], base)}
          </td>
        ))}
      </tr>
      {open ? (
        <>
          {vendor.currencies
            .filter((c) => c.currencyCode !== base)
            .map((c) => (
              <tr key={`cur-${c.currencyCode}`} className="subrow">
                <td className="muted">
                  {t('purchases.reports.inCurrency', { currency: c.currencyCode })}
                </td>
                {COLUMNS.map((b) => (
                  <td key={b} className="num">
                    {formatAmount(c[b], c.currencyCode)}
                  </td>
                ))}
              </tr>
            ))}
          {vendor.bills.map((b) => (
            <tr key={b.id} className="subrow">
              <td>
                <Link to={`/purchases/bills/${b.id}`}>{b.number}</Link>{' '}
                <span className="muted">
                  {t('purchases.reports.dueOn', { date: b.dueDate, days: String(b.daysOverdue) })}
                </span>
              </td>
              {AP_AGING_BUCKETS.map((bucket: ApAgingBucket) => (
                <td key={bucket} className="num">
                  {bucket === b.bucket
                    ? `${formatAmount(b.openAmount, b.currencyCode)} ${b.currencyCode}`
                    : ''}
                </td>
              ))}
              <td />
              <td className="num">{formatAmount(b.openBase, base)}</td>
            </tr>
          ))}
          {vendor.credits.map((c) => (
            <tr key={c.id} className="subrow">
              <td>
                <Link to={`${DOC_PATHS[c.type]}/${c.id}`}>
                  {t(`purchases.reports.docType.${docKind(c.type, c.origin)}`)} {c.number}
                </Link>
              </td>
              {AP_AGING_BUCKETS.map((bucket) => (
                <td key={bucket} />
              ))}
              <td className="num">
                {`-${formatAmount(c.openAmount, c.currencyCode)} ${c.currencyCode}`}
              </td>
              <td className="num">{formatAmount(`-${c.openBase}`, base)}</td>
            </tr>
          ))}
        </>
      ) : null}
    </>
  );
}

function StatementView({ initialVendorId }: { initialVendorId: string }) {
  const t = useT();
  const org = useOrgKey();
  const vendors = useQuery({
    queryKey: ['vendor-options', org, 'all'],
    queryFn: () => api.get<Page<VendorSummary>>('/vendors?limit=200'),
  });
  const [form, setForm] = useState({ vendorId: initialVendorId, from: monthStart(), to: today() });
  const [applied, setApplied] = useState<typeof form | null>(initialVendorId ? form : null);
  const report = useReport<VendorStatement>(
    'statement',
    applied ? `/purchases/reports/statement?${new URLSearchParams(applied).toString()}` : null,
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied(form);
  };
  return (
    <Card>
      <form className="form form--inline" onSubmit={submit}>
        <div className="field">
          <label htmlFor="statement-vendor">{t('purchases.reports.vendor')}</label>
          <select
            id="statement-vendor"
            value={form.vendorId}
            required
            onChange={(e) => setForm({ ...form, vendorId: e.target.value })}
          >
            <option value="">{t('common.choose')}</option>
            {(vendors.data?.items ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.displayName}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label={t('purchases.reports.from')}
          type="date"
          value={form.from}
          required
          onChange={(e) => setForm({ ...form, from: e.target.value })}
        />
        <TextField
          label={t('purchases.reports.to')}
          type="date"
          value={form.to}
          required
          onChange={(e) => setForm({ ...form, to: e.target.value })}
        />
        <Button type="submit">{t('purchases.reports.run')}</Button>
      </form>
      <Result query={report}>
        {(data) =>
          data.currencies.length === 0 ? (
            <p className="muted">{t('purchases.reports.noActivity')}</p>
          ) : (
            <>
              <p className="muted">{t('purchases.reports.owedNote')}</p>
              {data.currencies.map((c) => (
                <div key={c.currencyCode}>
                  <table className="table">
                    <caption>
                      {t('purchases.reports.statementFor', {
                        name: data.vendorName ?? '',
                        currency: c.currencyCode,
                      })}
                    </caption>
                    <thead>
                      <tr>
                        <th>{t('purchases.reports.date')}</th>
                        <th>{t('purchases.reports.document')}</th>
                        <th>{t('purchases.reports.reference')}</th>
                        <th className="num">{t('purchases.reports.amount')}</th>
                        <th className="num">{t('purchases.reports.balance')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>{data.from}</td>
                        <td colSpan={3}>{t('purchases.reports.broughtForward')}</td>
                        <td className="num">{formatAmount(c.openingBalance, c.currencyCode)}</td>
                      </tr>
                      {c.lines.map((l) => (
                        <tr key={`${l.type}-${l.id}`}>
                          <td>{l.date}</td>
                          <td>
                            <Link to={`${DOC_PATHS[l.type] ?? '/purchases/bills'}/${l.id}`}>
                              {t(`purchases.reports.docType.${docKind(l.type, l.origin)}`)}{' '}
                              {l.number}
                            </Link>
                          </td>
                          <td>{l.reference ?? ''}</td>
                          <td className="num">{formatAmount(l.amount, c.currencyCode)}</td>
                          <td className="num">{formatAmount(l.balance, c.currencyCode)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th colSpan={4}>{t('purchases.reports.closing', { date: data.to })}</th>
                        <td className="num">{formatAmount(c.closingBalance, c.currencyCode)}</td>
                      </tr>
                    </tfoot>
                  </table>
                  {c.openBills.length > 0 ? (
                    <table className="table">
                      <caption>{t('purchases.reports.openBills', { date: data.to })}</caption>
                      <thead>
                        <tr>
                          <th>{t('purchases.reports.document')}</th>
                          <th>{t('purchases.reports.dueDate')}</th>
                          <th className="num">{t('purchases.reports.open')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.openBills.map((b) => (
                          <tr key={b.id}>
                            <td>
                              <Link to={`/purchases/bills/${b.id}`}>{b.number}</Link>
                            </td>
                            <td>
                              {b.dueDate}{' '}
                              <span className="muted">
                                {t(`purchases.reports.bucket.${b.bucket}`)}
                              </span>
                            </td>
                            <td className="num">{formatAmount(b.openAmount, c.currencyCode)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                </div>
              ))}
            </>
          )
        }
      </Result>
    </Card>
  );
}

function ReconciliationView() {
  const t = useT();
  const [applied, setApplied] = useState(today());
  const report = useReport<ApReconciliation>(
    'reconciliation',
    `/purchases/reports/ap-reconciliation?asOf=${applied}`,
  );
  return (
    <Card>
      <AsOfForm onRun={setApplied} />
      <Result query={report}>
        {(r) => {
          const row = (label: MessageKey, value: string) => (
            <tr>
              <th scope="row">{t(label)}</th>
              <td className="num">{formatAmount(value, r.baseCurrency)}</td>
            </tr>
          );
          return (
            <>
              {r.reconciled ? (
                <Alert tone="success">{t('purchases.reports.reconciled')}</Alert>
              ) : (
                <Alert>
                  {t('purchases.reports.notReconciled', {
                    amount: formatAmount(r.difference, r.baseCurrency),
                  })}
                </Alert>
              )}
              <table className="table facts">
                <caption className="muted">{t('purchases.reports.owedNote')}</caption>
                <tbody>
                  {row('purchases.reports.recon.openBills', r.subledger.openBills)}
                  {row('purchases.reports.recon.unappliedCredits', r.subledger.unappliedCredits)}
                  {row('purchases.reports.recon.prepayments', r.subledger.prepayments)}
                  {row('purchases.reports.recon.subledger', r.subledger.total)}
                  {row('purchases.reports.recon.revaluation', r.revaluationAdjustments)}
                  {row('purchases.reports.recon.gl', r.glBalance)}
                  {row('purchases.reports.recon.outside', r.postingsOutsidePurchases)}
                  {row('purchases.reports.recon.difference', r.difference)}
                </tbody>
              </table>
            </>
          );
        }}
      </Result>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Phase 4B-6: unpaid bills, purchase analysis, input tax and the payment register
// ---------------------------------------------------------------------------

function useVendorOptions() {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['vendor-options', org, 'all'],
    queryFn: () => api.get<Page<VendorSummary>>('/vendors?limit=200'),
  });
}

function VendorFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  const vendors = useVendorOptions();
  return (
    <div className="field">
      <label htmlFor="report-vendor">{t('purchases.reports.vendor')}</label>
      <select id="report-vendor" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('purchases.reports.allVendors')}</option>
        {(vendors.data?.items ?? []).map((v) => (
          <option key={v.id} value={v.id}>
            {v.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Builds a query string, leaving out empty filters. */
const query = (values: Record<string, string>) =>
  new URLSearchParams(Object.entries(values).filter(([, v]) => v !== '')).toString();

function PeriodForm({
  form,
  setForm,
  onRun,
  children,
}: {
  form: { from: string; to: string };
  setForm: (patch: { from?: string; to?: string }) => void;
  onRun: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <form
      className="form form--inline"
      onSubmit={(e) => {
        e.preventDefault();
        onRun();
      }}
    >
      <TextField
        label={t('purchases.reports.from')}
        type="date"
        value={form.from}
        required
        onChange={(e) => setForm({ from: e.target.value })}
      />
      <TextField
        label={t('purchases.reports.to')}
        type="date"
        value={form.to}
        required
        onChange={(e) => setForm({ to: e.target.value })}
      />
      {children}
      <Button type="submit">{t('purchases.reports.run')}</Button>
    </form>
  );
}

function usePeriodForm<T extends Record<string, string>>(extra: T) {
  const [form, setFormState] = useState({ from: monthStart(), to: today(), ...extra });
  const [applied, setApplied] = useState(form);
  return {
    form,
    setForm: (patch: Partial<typeof form>) => setFormState((f) => ({ ...f, ...patch })),
    applied,
    run: () => setApplied(form),
  };
}

function UnpaidBillsView() {
  const t = useT();
  const [form, setForm] = useState({ asOf: today(), vendorId: '' });
  const [applied, setApplied] = useState(form);
  const report = useReport<UnpaidBillsReport>(
    'unpaid',
    `/purchases/reports/unpaid-bills?${query(applied)}`,
  );
  return (
    <Card>
      <form
        className="form form--inline"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(form);
        }}
      >
        <TextField
          label={t('purchases.reports.asOf')}
          type="date"
          value={form.asOf}
          required
          onChange={(e) => setForm({ ...form, asOf: e.target.value })}
        />
        <VendorFilter value={form.vendorId} onChange={(v) => setForm({ ...form, vendorId: v })} />
        <Button type="submit">{t('purchases.reports.run')}</Button>
      </form>
      <p className="muted">{t('purchases.reports.unpaid.note')}</p>
      <Result query={report}>
        {(data) =>
          data.buckets.every((b) => b.bills.length === 0) ? (
            <p className="muted">{t('purchases.reports.noUnpaid')}</p>
          ) : (
            <>
              {data.buckets
                .filter((b) => b.bills.length > 0)
                .map((b) => (
                  <table key={b.key} className="table">
                    <caption>
                      {t(`purchases.reports.unpaid.${b.key}`)}{' '}
                      <span className="muted">
                        {b.from && b.to
                          ? t('purchases.reports.unpaid.window', { from: b.from, to: b.to })
                          : b.to
                            ? t('purchases.reports.unpaid.until', { date: addOneDay(b.to) })
                            : t('purchases.reports.unpaid.from', { date: b.from ?? '' })}
                      </span>
                    </caption>
                    <thead>
                      <tr>
                        <th>{t('purchases.reports.document')}</th>
                        <th>{t('purchases.reports.vendor')}</th>
                        <th>{t('purchases.reports.dueDate')}</th>
                        <th className="num">{t('purchases.reports.open')}</th>
                        <th className="num">{t('purchases.reports.base')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.bills.map((bill) => (
                        <tr key={bill.id}>
                          <td>
                            <Link to={`/purchases/bills/${bill.id}`}>{bill.number}</Link>
                          </td>
                          <td>{bill.vendorName ?? ''}</td>
                          <td>{bill.dueDate}</td>
                          <td className="num">
                            {`${formatAmount(bill.openAmount, bill.currencyCode)} ${bill.currencyCode}`}
                          </td>
                          <td className="num">{formatAmount(bill.openBase, data.baseCurrency)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th colSpan={3}>{t('purchases.reports.total')}</th>
                        <td className="num">
                          {b.currencies
                            .map(
                              (c) => `${formatAmount(c.amount, c.currencyCode)} ${c.currencyCode}`,
                            )
                            .join(' · ')}
                        </td>
                        <td className="num">{formatAmount(b.base, data.baseCurrency)}</td>
                      </tr>
                    </tfoot>
                  </table>
                ))}
              <p>
                <strong>{t('purchases.reports.total')}:</strong>{' '}
                {data.totals.currencies
                  .map((c) => `${formatAmount(c.amount, c.currencyCode)} ${c.currencyCode}`)
                  .join(' · ')}{' '}
                ({formatAmount(data.totals.base, data.baseCurrency)} {data.baseCurrency})
              </p>
            </>
          )
        }
      </Result>
    </Card>
  );
}

const addOneDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const SUM_COLUMNS = ['net', 'recoverableTax', 'nonRecoverableTax', 'cost', 'total'] as const;

function SumCells({ sums, currency }: { sums: PurchaseSums; currency: string }) {
  return (
    <>
      {SUM_COLUMNS.map((c) => (
        <td key={c} className="num">
          {formatAmount(sums[c], currency)}
        </td>
      ))}
    </>
  );
}

function SumHeaders() {
  const t = useT();
  return (
    <>
      {SUM_COLUMNS.map((c) => (
        <th key={c} className="num">
          {t(`purchases.reports.${c}`)}
        </th>
      ))}
    </>
  );
}

function ByVendorView() {
  const t = useT();
  const p = usePeriodForm({ vendorId: '' });
  const report = useReport<PurchasesByVendorReport>(
    'byVendor',
    `/purchases/reports/purchases-by-vendor?${query(p.applied)}`,
  );
  return (
    <Card>
      <PeriodForm form={p.form} setForm={p.setForm} onRun={p.run}>
        <VendorFilter value={p.form.vendorId} onChange={(v) => p.setForm({ vendorId: v })} />
      </PeriodForm>
      <Result query={report}>
        {(data) =>
          data.vendors.length === 0 ? (
            <p className="muted">{t('purchases.reports.noRows')}</p>
          ) : (
            <table className="table">
              <caption className="muted">
                {t('purchases.reports.inBaseNet', { currency: data.baseCurrency })}
              </caption>
              <thead>
                <tr>
                  <th>{t('purchases.reports.vendor')}</th>
                  <th className="num">{t('purchases.reports.bills')}</th>
                  <th className="num">{t('purchases.reports.credits')}</th>
                  <SumHeaders />
                </tr>
              </thead>
              <tbody>
                {data.vendors.map((v) => (
                  <tr key={v.vendorId}>
                    <td>
                      <Link
                        to={`/purchases/reports?${query({ view: 'statement', vendorId: v.vendorId })}`}
                      >
                        {v.vendorName ?? v.vendorId}
                      </Link>
                    </td>
                    <td className="num">{v.bills}</td>
                    <td className="num">{v.credits}</td>
                    <SumCells sums={v} currency={data.baseCurrency} />
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>{t('purchases.reports.total')}</th>
                  <SumCells sums={data.totals} currency={data.baseCurrency} />
                </tr>
              </tfoot>
            </table>
          )
        }
      </Result>
    </Card>
  );
}

function ByItemView() {
  const t = useT();
  const items = useItemOptions();
  const p = usePeriodForm({ itemId: '' });
  const report = useReport<PurchasesByItemReport>(
    'byItem',
    `/purchases/reports/purchases-by-item?${query(p.applied)}`,
  );
  return (
    <Card>
      <PeriodForm form={p.form} setForm={p.setForm} onRun={p.run}>
        <div className="field">
          <label htmlFor="report-item">{t('purchases.reports.item')}</label>
          <select
            id="report-item"
            value={p.form.itemId}
            onChange={(e) => p.setForm({ itemId: e.target.value })}
          >
            <option value="">{t('purchases.reports.allItems')}</option>
            {(items.data?.items ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
      </PeriodForm>
      <Result query={report}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="muted">{t('purchases.reports.noRows')}</p>
          ) : (
            <table className="table">
              <caption className="muted">
                {t('purchases.reports.inBaseNet', { currency: data.baseCurrency })}
              </caption>
              <thead>
                <tr>
                  <th>{t('purchases.reports.item')}</th>
                  <th className="num">{t('purchases.reports.quantity')}</th>
                  <th className="num">{t('purchases.reports.lines')}</th>
                  <SumHeaders />
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.itemId ?? 'none'}>
                    <td>
                      {i.itemId === null ? (
                        <span className="muted">{t('purchases.reports.noItem')}</span>
                      ) : (
                        <>
                          {i.name}
                          {i.sku ? <span className="muted"> · {i.sku}</span> : null}
                        </>
                      )}
                    </td>
                    <td className="num">{i.quantity}</td>
                    <td className="num">{i.lines}</td>
                    <SumCells sums={i} currency={data.baseCurrency} />
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>{t('purchases.reports.total')}</th>
                  <SumCells sums={data.totals} currency={data.baseCurrency} />
                </tr>
              </tfoot>
            </table>
          )
        }
      </Result>
    </Card>
  );
}

function ByAccountView() {
  const t = useT();
  const accounts = useAccounts();
  const p = usePeriodForm({ accountId: '' });
  const report = useReport<PurchasesByAccountReport>(
    'byAccount',
    `/purchases/reports/purchases-by-account?${query(p.applied)}`,
  );
  return (
    <Card>
      <PeriodForm form={p.form} setForm={p.setForm} onRun={p.run}>
        <div className="field">
          <label htmlFor="report-account">{t('purchases.reports.account')}</label>
          <select
            id="report-account"
            value={p.form.accountId}
            onChange={(e) => p.setForm({ accountId: e.target.value })}
          >
            <option value="">{t('purchases.reports.allAccounts')}</option>
            {(accounts.data ?? [])
              .filter((a) => a.isLeaf)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
          </select>
        </div>
      </PeriodForm>
      <Result query={report}>
        {(data) =>
          data.accounts.length === 0 ? (
            <p className="muted">{t('purchases.reports.noRows')}</p>
          ) : (
            <>
              <p className="muted">
                {t('purchases.reports.accountNote', {
                  amount: formatAmount(data.totals.recoverableTax, data.baseCurrency),
                })}
              </p>
              <table className="table">
                <caption className="muted">
                  {t('purchases.reports.inBaseNet', { currency: data.baseCurrency })}
                </caption>
                <thead>
                  <tr>
                    <th>{t('purchases.reports.account')}</th>
                    <th className="num">{t('purchases.reports.net')}</th>
                    <th className="num">{t('purchases.reports.nonRecoverableTax')}</th>
                    <th className="num">{t('purchases.reports.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => (
                    <tr key={a.accountId ?? 'none'}>
                      <td>
                        {a.accountId === null
                          ? t('purchases.reports.noAccount')
                          : `${a.code ?? ''} · ${a.name ?? ''}`}
                      </td>
                      <td className="num">{formatAmount(a.net, data.baseCurrency)}</td>
                      <td className="num">
                        {formatAmount(a.nonRecoverableTax, data.baseCurrency)}
                      </td>
                      <td className="num">{formatAmount(a.cost, data.baseCurrency)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>{t('purchases.reports.total')}</th>
                    <td className="num">{formatAmount(data.totals.net, data.baseCurrency)}</td>
                    <td className="num">
                      {formatAmount(data.totals.nonRecoverableTax, data.baseCurrency)}
                    </td>
                    <td className="num">{formatAmount(data.totals.cost, data.baseCurrency)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          )
        }
      </Result>
    </Card>
  );
}

function InputTaxView() {
  const t = useT();
  const p = usePeriodForm({});
  const report = useReport<InputTaxSummaryReport>(
    'inputTax',
    `/purchases/reports/input-tax-summary?${query(p.applied)}`,
  );
  return (
    <Card>
      <PeriodForm form={p.form} setForm={p.setForm} onRun={p.run} />
      <Alert tone="info">{t('purchases.reports.reviewOnly')}</Alert>
      <Result query={report}>
        {(data) =>
          data.codes.length === 0 ? (
            <p className="muted">{t('purchases.reports.noRows')}</p>
          ) : (
            <table className="table">
              <caption className="muted">
                {t('purchases.reports.inBaseNet', { currency: data.baseCurrency })}
              </caption>
              <thead>
                <tr>
                  <th>{t('purchases.reports.taxCode')}</th>
                  <th className="num">{t('purchases.reports.rate')}</th>
                  <th className="num">{t('purchases.reports.taxable')}</th>
                  <th className="num">{t('purchases.reports.recoverableTax')}</th>
                  <th className="num">{t('purchases.reports.nonRecoverableTax')}</th>
                  <th className="num">{t('purchases.reports.tax')}</th>
                </tr>
              </thead>
              <tbody>
                {data.codes.map((c) => (
                  <tr key={`${c.taxCodeId ?? 'none'}-${c.rate ?? ''}`}>
                    <td>{c.code ?? t('purchases.reports.noTaxCode')}</td>
                    <td className="num">{c.rate === null ? '' : `${c.rate}%`}</td>
                    <td className="num">{formatAmount(c.taxable, data.baseCurrency)}</td>
                    <td className="num">{formatAmount(c.recoverableTax, data.baseCurrency)}</td>
                    <td className="num">{formatAmount(c.nonRecoverableTax, data.baseCurrency)}</td>
                    <td className="num">{formatAmount(c.tax, data.baseCurrency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={2}>{t('purchases.reports.total')}</th>
                  <td className="num">{formatAmount(data.totals.taxable, data.baseCurrency)}</td>
                  <td className="num">
                    {formatAmount(data.totals.recoverableTax, data.baseCurrency)}
                  </td>
                  <td className="num">
                    {formatAmount(data.totals.nonRecoverableTax, data.baseCurrency)}
                  </td>
                  <td className="num">{formatAmount(data.totals.tax, data.baseCurrency)}</td>
                </tr>
              </tfoot>
            </table>
          )
        }
      </Result>
    </Card>
  );
}

function StatusCell({ status }: { status: 'RECORDED' | 'VOID' }) {
  const t = useT();
  return (
    <td>
      {status === 'VOID' ? (
        <span className="badge badge--void">{t('purchases.reports.statusVoid')}</span>
      ) : (
        t('purchases.reports.statusRecorded')
      )}
    </td>
  );
}

function RegisterSubtotals({ summary, base }: { summary: RegisterSummary; base: string }) {
  const t = useT();
  return (
    <>
      {summary.subtotals.length > 0 ? (
        <table className="table">
          <caption className="muted">{t('purchases.reports.subtotals')}</caption>
          <tbody>
            {summary.subtotals.map((s) => (
              <tr key={`${s.accountId}-${s.currencyCode}`}>
                <td>{s.account ? `${s.account.code} · ${s.account.name}` : s.accountId}</td>
                <td className="num">{s.count}</td>
                <td className="num">{`${formatAmount(s.amount, s.currencyCode)} ${s.currencyCode}`}</td>
                <td className="num">{formatAmount(s.baseAmount, base)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="muted">
        {t('purchases.reports.registerTotals', {
          count: String(summary.totals.count),
          voided: String(summary.totals.voided),
          amount: formatAmount(summary.totals.baseAmount, base),
        })}
      </p>
    </>
  );
}

function RegisterView() {
  const t = useT();
  const accounts = useAccounts();
  const p = usePeriodForm({ vendorId: '', paymentAccountId: '', currencyCode: '' });
  const report = useReport<PaymentRegisterReport>(
    'register',
    `/purchases/reports/payment-register?${query(p.applied)}`,
  );
  return (
    <Card>
      <PeriodForm form={p.form} setForm={p.setForm} onRun={p.run}>
        <VendorFilter value={p.form.vendorId} onChange={(v) => p.setForm({ vendorId: v })} />
        <div className="field">
          <label htmlFor="report-payment-account">{t('purchases.reports.paymentAccount')}</label>
          <select
            id="report-payment-account"
            value={p.form.paymentAccountId}
            onChange={(e) => p.setForm({ paymentAccountId: e.target.value })}
          >
            <option value="">{t('purchases.reports.allAccounts')}</option>
            {(accounts.data ?? [])
              .filter((a) => a.isLeaf && (a.isBankOrCash || a.subtype === 'CREDIT_CARD'))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="report-currency">{t('purchases.reports.currency')}</label>
          <select
            id="report-currency"
            value={p.form.currencyCode}
            onChange={(e) => p.setForm({ currencyCode: e.target.value })}
          >
            <option value="">{t('purchases.reports.allCurrencies')}</option>
            {COMMON_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </PeriodForm>
      <Result query={report}>
        {(data) => (
          <>
            {data.truncated ? (
              <Alert>{t('purchases.reports.truncated', { limit: String(data.limit) })}</Alert>
            ) : null}
            <h3>{t('purchases.reports.payments')}</h3>
            {data.payments.length === 0 ? (
              <p className="muted">{t('purchases.reports.noPayments')}</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('purchases.reports.date')}</th>
                    <th>{t('purchases.reports.number')}</th>
                    <th>{t('purchases.reports.vendor')}</th>
                    <th>{t('purchases.reports.paymentAccount')}</th>
                    <th className="num">{t('purchases.reports.amount')}</th>
                    <th className="num">{t('purchases.reports.fxRate')}</th>
                    <th className="num">{t('purchases.reports.base')}</th>
                    <th className="num">{t('purchases.reports.applied')}</th>
                    <th className="num">{t('purchases.reports.prepayment')}</th>
                    <th className="num">{t('purchases.reports.realizedFx')}</th>
                    <th>{t('purchases.reports.batch')}</th>
                    <th>{t('purchases.reports.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.payments.map((pm) => (
                    <tr key={pm.id} className={pm.status === 'VOID' ? 'muted' : undefined}>
                      <td>{pm.paymentDate}</td>
                      <td>
                        <Link to={`/purchases/payments/${pm.id}`}>{pm.number}</Link>
                      </td>
                      <td>{pm.vendorName ?? ''}</td>
                      <td>{pm.account?.code ?? ''}</td>
                      <td className="num">{`${formatAmount(pm.amount, pm.currencyCode)} ${pm.currencyCode}`}</td>
                      <td className="num">
                        {pm.exchangeRateSource === 'base' ? '' : pm.exchangeRate}
                      </td>
                      <td className="num">{formatAmount(pm.baseAmount, data.baseCurrency)}</td>
                      <td className="num">{formatAmount(pm.appliedToBills, pm.currencyCode)}</td>
                      <td className="num">{formatAmount(pm.prepayment, pm.currencyCode)}</td>
                      <td className="num">{formatAmount(pm.realizedFx, data.baseCurrency)}</td>
                      <td>
                        {pm.paymentBatchId ? (
                          <Link to={`/purchases/payment-batches/${pm.paymentBatchId}`}>
                            {t('purchases.reports.batch')}
                          </Link>
                        ) : null}
                      </td>
                      <StatusCell status={pm.status} />
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <RegisterSubtotals summary={data.paymentSummary} base={data.baseCurrency} />
            <h3>{t('purchases.reports.refunds')}</h3>
            {data.refunds.length === 0 ? (
              <p className="muted">{t('purchases.reports.noRefunds')}</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('purchases.reports.date')}</th>
                    <th>{t('purchases.reports.number')}</th>
                    <th>{t('purchases.reports.vendor')}</th>
                    <th>{t('purchases.reports.account')}</th>
                    <th>{t('purchases.reports.source')}</th>
                    <th className="num">{t('purchases.reports.amount')}</th>
                    <th className="num">{t('purchases.reports.base')}</th>
                    <th className="num">{t('purchases.reports.realizedFx')}</th>
                    <th>{t('purchases.reports.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.refunds.map((r) => (
                    <tr key={r.id} className={r.status === 'VOID' ? 'muted' : undefined}>
                      <td>{r.refundDate}</td>
                      <td>
                        <Link to={`/purchases/refunds/${r.id}`}>{r.number}</Link>
                      </td>
                      <td>{r.vendorName ?? ''}</td>
                      <td>{r.account?.code ?? ''}</td>
                      <td>
                        <Link
                          to={`${r.sourceType === 'payment' ? '/purchases/payments' : '/purchases/vendor-credits'}/${r.sourceId}`}
                        >
                          {r.sourceNumber ?? ''}
                        </Link>
                      </td>
                      <td className="num">{`${formatAmount(r.amount, r.currencyCode)} ${r.currencyCode}`}</td>
                      <td className="num">{formatAmount(r.baseAmount, data.baseCurrency)}</td>
                      <td className="num">{formatAmount(r.realizedFx, data.baseCurrency)}</td>
                      <StatusCell status={r.status} />
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <RegisterSubtotals summary={data.refundSummary} base={data.baseCurrency} />
          </>
        )}
      </Result>
    </Card>
  );
}
