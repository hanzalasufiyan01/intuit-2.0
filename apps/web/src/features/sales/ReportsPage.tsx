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
import { ExportButton } from '../data-exchange/ExportButton';
import { SalesNav, useCustomerOptions, useOrgKey } from './shared';
import { AGING_BUCKETS, type AgingBucket } from './types';

type Buckets = Record<AgingBucket | 'credit' | 'total', string>;
interface AgingReport {
  asOf: string;
  baseCurrency: string;
  customers: {
    customerId: string;
    customerName: string | null;
    currencies: (Buckets & { currencyCode: string })[];
    base: Buckets;
    invoices: {
      id: string;
      number: string;
      dueDate: string;
      daysOverdue: number;
      bucket: AgingBucket;
      currencyCode: string;
      openAmount: string;
      openBase: string;
    }[];
  }[];
  totals: Buckets;
}
interface StatementReport {
  customerName: string | null;
  from: string;
  to: string;
  currencies: {
    currencyCode: string;
    openingBalance: string;
    closingBalance: string;
    lines: {
      type: string;
      id: string;
      number: string;
      date: string;
      reference: string | null;
      amount: string;
      balance: string;
    }[];
  }[];
}
interface Reconciliation {
  asOf: string;
  baseCurrency: string;
  glBalance: string;
  revaluationAdjustments: string;
  postingsOutsideSales: string;
  subledger: { openInvoices: string; unappliedCredit: string; total: string };
  difference: string;
  reconciled: boolean;
}
interface ByCustomer {
  baseCurrency: string;
  customers: {
    customerId: string;
    customerName: string | null;
    invoices: number;
    creditNotes: number;
    netSales: string;
    tax: string;
    total: string;
  }[];
  totals: { netSales: string; tax: string; total: string };
}
interface ByItem {
  baseCurrency: string;
  items: {
    itemId: string | null;
    name: string | null;
    sku: string | null;
    quantity: string;
    lines: number;
    netSales: string;
  }[];
  totals: { netSales: string };
}
interface TaxSummary {
  baseCurrency: string;
  codes: {
    taxCodeId: string | null;
    code: string | null;
    rate: string | null;
    taxable: string;
    tax: string;
  }[];
  totals: { taxable: string; tax: string };
}

const VIEWS = ['aging', 'statement', 'reconciliation', 'byCustomer', 'byItem', 'tax'] as const;
type View = (typeof VIEWS)[number];

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;
const DOC_PATHS: Record<string, string> = {
  invoice: '/sales/invoices',
  credit_note: '/sales/credit-notes',
  receipt: '/sales/receipts',
};

/** AR and sales reports (D9, Decision 45); every view needs sales.reports.view on the server. */
export function SalesReportsPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const view: View = (VIEWS as readonly string[]).includes(params.get('view') ?? '')
    ? (params.get('view') as View)
    : 'aging';
  return (
    <>
      <PageHeader title={t('sales.reports.title')} description={t('sales.reports.description')} />
      <SalesNav />
      <nav className="tabs" aria-label={t('sales.reports.views')}>
        {VIEWS.map((v) => (
          <Button
            key={v}
            aria-current={v === view ? 'page' : undefined}
            variant={v === view ? 'primary' : 'ghost'}
            onClick={() => setParams({ view: v })}
          >
            {t(`sales.reports.view.${v}`)}
          </Button>
        ))}
      </nav>
      {view === 'aging' ? <AgingView /> : null}
      {view === 'statement' ? (
        <StatementView initialCustomerId={params.get('customerId') ?? ''} />
      ) : null}
      {view === 'reconciliation' ? <ReconciliationView /> : null}
      {view === 'byCustomer' || view === 'byItem' || view === 'tax' ? (
        <PeriodView view={view} />
      ) : null}
    </>
  );
}

function useReport<T>(name: string, path: string | null) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['sales-report', org, name, path],
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

function AgingView() {
  const t = useT();
  const [asOf, setAsOf] = useState(today());
  const [applied, setApplied] = useState(asOf);
  const [open, setOpen] = useState<string | null>(null);
  const report = useReport<AgingReport>('aging', `/sales/reports/aging?asOf=${applied}`);
  return (
    <Card>
      <form
        className="form form--inline"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(asOf);
        }}
      >
        <TextField
          label={t('sales.reports.asOf')}
          type="date"
          value={asOf}
          required
          onChange={(e) => setAsOf(e.target.value)}
        />
        <Button type="submit">{t('sales.reports.run')}</Button>
        <ExportButton
          domain="ar_aging"
          params={{ asOf: applied }}
          label={t('sales.reports.export')}
        />
      </form>
      <Result query={report}>
        {(data) =>
          data.customers.length === 0 ? (
            <p className="muted">{t('sales.reports.noOpenItems')}</p>
          ) : (
            <table className="table">
              <caption className="muted">
                {t('sales.reports.inBase', { currency: data.baseCurrency })}
              </caption>
              <thead>
                <tr>
                  <th>{t('sales.field.customer')}</th>
                  {AGING_BUCKETS.map((b) => (
                    <th key={b} className="num">
                      {t(`sales.reports.bucket.${b}`)}
                    </th>
                  ))}
                  <th className="num">{t('sales.reports.bucket.credit')}</th>
                  <th className="num">{t('sales.totals.total')}</th>
                </tr>
              </thead>
              <tbody>
                {data.customers.map((c) => (
                  <AgingRows
                    key={c.customerId}
                    customer={c}
                    base={data.baseCurrency}
                    open={open === c.customerId}
                    onToggle={() => setOpen(open === c.customerId ? null : c.customerId)}
                  />
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>{t('sales.totals.total')}</th>
                  {[...AGING_BUCKETS, 'credit' as const, 'total' as const].map((b) => (
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
  customer,
  base,
  open,
  onToggle,
}: {
  customer: AgingReport['customers'][number];
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
            {customer.customerName ?? customer.customerId}
          </button>
        </td>
        {[...AGING_BUCKETS, 'credit' as const, 'total' as const].map((b) => (
          <td key={b} className="num">
            {formatAmount(customer.base[b], base)}
          </td>
        ))}
      </tr>
      {open
        ? customer.invoices.map((i) => (
            <tr key={i.id} className="subrow">
              <td>
                <Link to={`/sales/invoices/${i.id}`}>{i.number}</Link>{' '}
                <span className="muted">
                  {t('sales.reports.dueOn', { date: i.dueDate, days: String(i.daysOverdue) })}
                </span>
              </td>
              {AGING_BUCKETS.map((b) => (
                <td key={b} className="num">
                  {b === i.bucket
                    ? `${formatAmount(i.openAmount, i.currencyCode)} ${i.currencyCode}`
                    : ''}
                </td>
              ))}
              <td />
              <td className="num">{formatAmount(i.openBase, base)}</td>
            </tr>
          ))
        : null}
    </>
  );
}

function StatementView({ initialCustomerId }: { initialCustomerId: string }) {
  const t = useT();
  const customers = useCustomerOptions();
  const [form, setForm] = useState({
    customerId: initialCustomerId,
    from: monthStart(),
    to: today(),
  });
  const [applied, setApplied] = useState<typeof form | null>(initialCustomerId ? form : null);
  const report = useReport<StatementReport>(
    'statement',
    applied ? `/sales/reports/statement?${new URLSearchParams(applied).toString()}` : null,
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied(form);
  };
  return (
    <Card>
      <form className="form form--inline" onSubmit={submit}>
        <div className="field">
          <label htmlFor="statement-customer">{t('sales.field.customer')}</label>
          <select
            id="statement-customer"
            value={form.customerId}
            required
            onChange={(e) => setForm({ ...form, customerId: e.target.value })}
          >
            <option value="">{t('common.choose')}</option>
            {(customers.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label={t('sales.reports.from')}
          type="date"
          value={form.from}
          required
          onChange={(e) => setForm({ ...form, from: e.target.value })}
        />
        <TextField
          label={t('sales.reports.to')}
          type="date"
          value={form.to}
          required
          onChange={(e) => setForm({ ...form, to: e.target.value })}
        />
        <Button type="submit">{t('sales.reports.run')}</Button>
      </form>
      <Result query={report}>
        {(data) =>
          data.currencies.length === 0 ? (
            <p className="muted">{t('sales.reports.noActivity')}</p>
          ) : (
            data.currencies.map((c) => (
              <table key={c.currencyCode} className="table">
                <caption>
                  {t('sales.reports.statementFor', {
                    name: data.customerName ?? '',
                    currency: c.currencyCode,
                  })}
                </caption>
                <thead>
                  <tr>
                    <th>{t('sales.field.date')}</th>
                    <th>{t('sales.reports.document')}</th>
                    <th>{t('sales.field.reference')}</th>
                    <th className="num">{t('sales.field.amount')}</th>
                    <th className="num">{t('sales.reports.balance')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{data.from}</td>
                    <td colSpan={3}>{t('sales.reports.broughtForward')}</td>
                    <td className="num">{formatAmount(c.openingBalance, c.currencyCode)}</td>
                  </tr>
                  {c.lines.map((l) => (
                    <tr key={`${l.type}-${l.id}`}>
                      <td>{l.date}</td>
                      <td>
                        <Link to={`${DOC_PATHS[l.type] ?? '/sales/invoices'}/${l.id}`}>
                          {t(
                            `sales.reports.docType.${l.type as 'invoice' | 'credit_note' | 'receipt'}`,
                          )}{' '}
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
                    <th colSpan={4}>{t('sales.reports.closing', { date: data.to })}</th>
                    <td className="num">{formatAmount(c.closingBalance, c.currencyCode)}</td>
                  </tr>
                </tfoot>
              </table>
            ))
          )
        }
      </Result>
    </Card>
  );
}

function ReconciliationView() {
  const t = useT();
  const [asOf, setAsOf] = useState(today());
  const [applied, setApplied] = useState(asOf);
  const report = useReport<Reconciliation>(
    'reconciliation',
    `/sales/reports/ar-reconciliation?asOf=${applied}`,
  );
  return (
    <Card>
      <form
        className="form form--inline"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(asOf);
        }}
      >
        <TextField
          label={t('sales.reports.asOf')}
          type="date"
          value={asOf}
          required
          onChange={(e) => setAsOf(e.target.value)}
        />
        <Button type="submit">{t('sales.reports.run')}</Button>
      </form>
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
                <Alert tone="success">{t('sales.reports.reconciled')}</Alert>
              ) : (
                <Alert>
                  {t('sales.reports.notReconciled', {
                    amount: formatAmount(r.difference, r.baseCurrency),
                  })}
                </Alert>
              )}
              <table className="table facts">
                <tbody>
                  {row('sales.reports.recon.openInvoices', r.subledger.openInvoices)}
                  {row('sales.reports.recon.unappliedCredit', r.subledger.unappliedCredit)}
                  {row('sales.reports.recon.subledger', r.subledger.total)}
                  {row('sales.reports.recon.revaluation', r.revaluationAdjustments)}
                  {row('sales.reports.recon.gl', r.glBalance)}
                  {row('sales.reports.recon.outside', r.postingsOutsideSales)}
                  {row('sales.reports.recon.difference', r.difference)}
                </tbody>
              </table>
            </>
          );
        }}
      </Result>
    </Card>
  );
}

function PeriodView({ view }: { view: 'byCustomer' | 'byItem' | 'tax' }) {
  const t = useT();
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const [applied, setApplied] = useState(range);
  const path = { byCustomer: 'sales-by-customer', byItem: 'sales-by-item', tax: 'tax-summary' }[
    view
  ];
  const report = useReport<ByCustomer & ByItem & TaxSummary>(
    view,
    `/sales/reports/${path}?${new URLSearchParams(applied).toString()}`,
  );
  return (
    <Card>
      <form
        className="form form--inline"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(range);
        }}
      >
        <TextField
          label={t('sales.reports.from')}
          type="date"
          value={range.from}
          required
          onChange={(e) => setRange({ ...range, from: e.target.value })}
        />
        <TextField
          label={t('sales.reports.to')}
          type="date"
          value={range.to}
          required
          onChange={(e) => setRange({ ...range, to: e.target.value })}
        />
        <Button type="submit">{t('sales.reports.run')}</Button>
      </form>
      <Result query={report}>
        {(data) => {
          const money = (v: string) => formatAmount(v, data.baseCurrency);
          const caption = (
            <caption className="muted">
              {t('sales.reports.inBase', { currency: data.baseCurrency })}
            </caption>
          );
          if (view === 'byCustomer') {
            return (
              <table className="table">
                {caption}
                <thead>
                  <tr>
                    <th>{t('sales.field.customer')}</th>
                    <th className="num">{t('sales.reports.invoiceCount')}</th>
                    <th className="num">{t('sales.reports.creditCount')}</th>
                    <th className="num">{t('sales.reports.netSales')}</th>
                    <th className="num">{t('sales.totals.tax')}</th>
                    <th className="num">{t('sales.totals.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.customers.map((c) => (
                    <tr key={c.customerId}>
                      <td>{c.customerName}</td>
                      <td className="num">{c.invoices}</td>
                      <td className="num">{c.creditNotes}</td>
                      <td className="num">{money(c.netSales)}</td>
                      <td className="num">{money(c.tax)}</td>
                      <td className="num">{money(c.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={3}>{t('sales.totals.total')}</th>
                    <td className="num">{money(data.totals.netSales)}</td>
                    <td className="num">{money(data.totals.tax)}</td>
                    <td className="num">{money(data.totals.total)}</td>
                  </tr>
                </tfoot>
              </table>
            );
          }
          if (view === 'byItem') {
            return (
              <table className="table">
                {caption}
                <thead>
                  <tr>
                    <th>{t('sales.field.item')}</th>
                    <th>{t('sales.field.sku')}</th>
                    <th className="num">{t('sales.field.quantity')}</th>
                    <th className="num">{t('sales.reports.netSales')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.itemId ?? 'none'}>
                      <td>{i.name ?? t('sales.reports.noItem')}</td>
                      <td>{i.sku ?? ''}</td>
                      <td className="num">{i.quantity}</td>
                      <td className="num">{money(i.netSales)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={3}>{t('sales.totals.total')}</th>
                    <td className="num">{money(data.totals.netSales)}</td>
                  </tr>
                </tfoot>
              </table>
            );
          }
          return (
            <>
              <Alert tone="info">{t('sales.reports.taxNote')}</Alert>
              <table className="table">
                {caption}
                <thead>
                  <tr>
                    <th>{t('sales.field.taxCode')}</th>
                    <th className="num">{t('sales.tax.rate')}</th>
                    <th className="num">{t('sales.reports.taxable')}</th>
                    <th className="num">{t('sales.totals.tax')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.codes.map((c) => (
                    <tr key={`${c.taxCodeId ?? 'none'}-${c.rate ?? ''}`}>
                      <td>{c.code ?? t('sales.editor.noTax')}</td>
                      <td className="num">{c.rate === null ? '' : `${c.rate}%`}</td>
                      <td className="num">{money(c.taxable)}</td>
                      <td className="num">{money(c.tax)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={2}>{t('sales.totals.total')}</th>
                    <td className="num">{money(data.totals.taxable)}</td>
                    <td className="num">{money(data.totals.tax)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          );
        }}
      </Result>
    </Card>
  );
}
