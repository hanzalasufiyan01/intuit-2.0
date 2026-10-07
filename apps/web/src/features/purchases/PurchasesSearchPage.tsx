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
import { useOrgKey } from '../sales/shared';
import { PurchasesNav } from './PurchasesSection';

interface DocumentHit {
  id: string;
  number: string | null;
  status: string;
  vendorName: string | null;
  currencyCode: string;
  vendorReference?: string | null;
  billDate?: string;
  expenseDate?: string;
  creditDate?: string;
  paymentDate?: string;
  total?: string | null;
  amount?: string | null;
  amountDue?: string | null;
}
interface SearchResult {
  q: string;
  vendors?: {
    id: string;
    displayName: string;
    reference: string | null;
    email: string | null;
    currencyCode: string;
  }[];
  bills?: DocumentHit[];
  expenses?: DocumentHit[];
  vendorCredits?: DocumentHit[];
  payments?: DocumentHit[];
}

const SECTIONS: {
  key: 'bills' | 'expenses' | 'vendorCredits' | 'payments';
  title: MessageKey;
  path: string;
}[] = [
  { key: 'bills', title: 'purchases.nav.bills', path: '/purchases/bills' },
  { key: 'expenses', title: 'purchases.nav.expenses', path: '/purchases/expenses' },
  { key: 'vendorCredits', title: 'purchases.nav.vendorCredits', path: '/purchases/vendor-credits' },
  { key: 'payments', title: 'purchases.nav.payments', path: '/purchases/payments' },
];

/** One search across the Purchases records the user may view (4B-8; mirrors Sales search D15). */
export function PurchasesSearchPage() {
  const t = useT();
  const org = useOrgKey();
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const search = useQuery({
    queryKey: ['purchases-search', org, applied],
    queryFn: () =>
      api.get<SearchResult>(
        `/purchases/search?${new URLSearchParams({ q: applied, limit: '10' }).toString()}`,
      ),
    enabled: applied.length >= 2,
  });
  const data = search.data;
  const empty =
    data !== undefined &&
    !data.vendors?.length &&
    !data.bills?.length &&
    !data.expenses?.length &&
    !data.vendorCredits?.length &&
    !data.payments?.length;
  return (
    <>
      <PageHeader
        title={t('purchases.search.title')}
        description={t('purchases.search.description')}
      />
      <PurchasesNav />
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
            label={t('purchases.search.label')}
            value={q}
            hint={t('purchases.search.hint')}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button type="submit" disabled={q.trim().length < 2}>
            {t('common.search')}
          </Button>
        </form>
      </Card>
      {search.isError ? <ErrorAlert error={search.error} /> : null}
      {search.isFetching ? <Spinner label={t('common.loading')} /> : null}
      {empty ? <p className="muted">{t('purchases.search.noResults', { q: data.q })}</p> : null}
      {data?.vendors?.length ? (
        <Card title={t('purchases.nav.vendors')}>
          <ul className="list">
            {data.vendors.map((v) => (
              <li key={v.id}>
                <Link to={`/purchases/vendors/${v.id}`}>{v.displayName}</Link>{' '}
                <span className="muted">
                  {[v.reference, v.email, v.currencyCode].filter(Boolean).join(' · ')}
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
                      <Link to={`${path}/${d.id}`}>{d.number ?? t('purchases.search.draft')}</Link>
                      {d.vendorReference ? (
                        <span className="muted"> · {d.vendorReference}</span>
                      ) : null}
                    </td>
                    <td>{d.vendorName}</td>
                    <td>{d.billDate ?? d.expenseDate ?? d.creditDate ?? d.paymentDate}</td>
                    <td className="num">
                      {formatAmount(d.total ?? d.amount ?? null, d.currencyCode)} {d.currencyCode}
                    </td>
                    <td>{d.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : null,
      )}
    </>
  );
}
