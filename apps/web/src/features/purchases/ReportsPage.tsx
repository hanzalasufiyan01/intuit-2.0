import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useT, type MessageKey } from '../../i18n/i18n';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useOrgKey } from '../sales/shared';
import type { Page } from '../sales/types';
import { PurchasesNav } from './PurchasesSection';
import {
  AP_AGING_BUCKETS,
  type ApAgingBucket,
  type ApAgingReport,
  type ApReconciliation,
  type VendorStatement,
  type VendorSummary,
} from './types';

const VIEWS = ['aging', 'statement', 'reconciliation'] as const;
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
 * AP aging, vendor statements and the AP reconciliation (Phase 4B-5; P4-49). Every view needs
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
