import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useT, type MessageKey } from '../../i18n/i18n';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { SalesNav, StatusBadge, useOrgKey } from './shared';

interface DocumentHit {
  id: string;
  number: string | null;
  status: string;
  customerName: string | null;
  currencyCode: string;
  invoiceDate?: string;
  creditDate?: string;
  receiptDate?: string;
  total?: string | null;
  amount?: string | null;
}
interface SearchResult {
  q: string;
  customers?: {
    id: string;
    displayName: string;
    reference: string | null;
    email: string | null;
    currencyCode: string;
  }[];
  invoices?: DocumentHit[];
  creditNotes?: DocumentHit[];
  receipts?: DocumentHit[];
  items?: { id: string; sku: string | null; name: string; itemType: 'service' | 'product' }[];
}

const SECTIONS: {
  key: 'invoices' | 'creditNotes' | 'receipts';
  title: MessageKey;
  path: string;
}[] = [
  { key: 'invoices', title: 'sales.nav.invoices', path: '/sales/invoices' },
  { key: 'creditNotes', title: 'sales.nav.creditNotes', path: '/sales/credit-notes' },
  { key: 'receipts', title: 'sales.nav.receipts', path: '/sales/receipts' },
];

/** The Sales landing page: one search across the Sales records the user may view (D15). */
export function SalesHomePage() {
  const t = useT();
  const org = useOrgKey();
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const search = useQuery({
    queryKey: ['sales-search', org, applied],
    queryFn: () =>
      api.get<SearchResult>(
        `/sales/search?${new URLSearchParams({ q: applied, limit: '10' }).toString()}`,
      ),
    enabled: applied.length >= 2,
  });
  const data = search.data;
  const empty =
    data !== undefined &&
    !data.customers?.length &&
    !data.invoices?.length &&
    !data.creditNotes?.length &&
    !data.receipts?.length &&
    !data.items?.length;
  return (
    <>
      <PageHeader title={t('sales.home.title')} description={t('sales.home.description')} />
      <SalesNav />
      <Card>
        <form
          className="form form--inline"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(q.trim());
          }}
        >
          <TextField
            label={t('sales.home.search')}
            value={q}
            hint={t('sales.home.searchHint')}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button type="submit" disabled={q.trim().length < 2}>
            {t('common.search')}
          </Button>
        </form>
      </Card>
      {search.isError ? <ErrorAlert error={search.error} /> : null}
      {search.isFetching ? <Spinner label={t('common.loading')} /> : null}
      {empty ? <p className="muted">{t('sales.home.noResults', { q: data.q })}</p> : null}
      {data?.customers?.length ? (
        <Card title={t('sales.nav.customers')}>
          <ul className="list">
            {data.customers.map((c) => (
              <li key={c.id}>
                <Link to={`/sales/customers/${c.id}`}>{c.displayName}</Link>{' '}
                <span className="muted">
                  {[c.reference, c.email, c.currencyCode].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {SECTIONS.map(({ key, title, path }) =>
        data?.[key]?.length ? (
          <Card key={key} title={t(title)}>
            <table className="table">
              <tbody>
                {data[key]!.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link to={`${path}/${d.id}`}>
                        {d.number ?? t('sales.invoices.draftNumber')}
                      </Link>
                    </td>
                    <td>{d.customerName}</td>
                    <td>{d.invoiceDate ?? d.creditDate ?? d.receiptDate}</td>
                    <td className="num">
                      {formatAmount(d.total ?? d.amount ?? null, d.currencyCode)} {d.currencyCode}
                    </td>
                    <td>
                      <StatusBadge status={d.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : null,
      )}
      {data?.items?.length ? (
        <Card title={t('sales.nav.items')}>
          <ul className="list">
            {data.items.map((i) => (
              <li key={i.id}>
                <Link to="/sales/items">{i.name}</Link>{' '}
                <span className="muted">
                  {[i.sku, t(`sales.items.${i.itemType}`)].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
