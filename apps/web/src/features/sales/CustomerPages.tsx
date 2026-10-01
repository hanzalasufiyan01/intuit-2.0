import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useT } from '../../i18n/i18n';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { COMMON_CURRENCIES, formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { ExportButton } from '../data-exchange/ExportButton';
import { orNull, SalesNav, StatusBadge, useOrgKey } from './shared';
import type { CustomerDetail, CustomerSummary, Page } from './types';

export function CustomersPage() {
  const t = useT();
  const org = useOrgKey();
  const [filters, setFilters] = useState({ search: '', status: 'active' });
  const [applied, setApplied] = useState(filters);
  const list = useInfiniteQuery({
    queryKey: ['customers', org, applied],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ status: applied.status, limit: '50' });
      if (applied.search.trim()) params.set('search', applied.search.trim());
      if (pageParam) params.set('after', pageParam);
      return api.get<Page<CustomerSummary>>(`/customers?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader
        title={t('sales.customers.title')}
        description={t('sales.customers.description')}
      />
      <SalesNav />
      <p className="actions">
        <ExportButton domain="customers" label={t('sales.customers.export')} />
      </p>
      <Card
        actions={
          <Can permission={Permission.CustomersCreate}>
            <Link className="btn btn--primary" to="/sales/customers/new">
              {t('sales.customers.new')}
            </Link>
          </Can>
        }
      >
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(filters);
          }}
        >
          <TextField
            label={t('common.search')}
            value={filters.search}
            placeholder={t('sales.customers.searchHint')}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <div className="field">
            <label htmlFor="customer-status">{t('sales.field.status')}</label>
            <select
              id="customer-status"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="active">{t('sales.status.active')}</option>
              <option value="archived">{t('sales.status.archived')}</option>
              <option value="all">{t('common.all')}</option>
            </select>
          </div>
          <Button type="submit">{t('common.search')}</Button>
        </form>
      </Card>
      <Card>
        {list.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : items.length === 0 ? (
          <p className="muted">{t('sales.customers.none')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('sales.field.name')}</th>
                <th>{t('sales.field.reference')}</th>
                <th>{t('sales.field.email')}</th>
                <th>{t('sales.field.currency')}</th>
                <th>{t('sales.field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/sales/customers/${c.id}`}>{c.displayName}</Link>
                  </td>
                  <td>{c.reference}</td>
                  <td>{c.email}</td>
                  <td>{c.currencyCode}</td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {list.hasNextPage ? (
          <Button
            variant="secondary"
            busy={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('common.loadMore')}
          </Button>
        ) : null}
      </Card>
    </>
  );
}

/** Customer terms (Decision 48: the credit limit is a warning only). */
function TermsFields({
  values,
  onChange,
  error,
  disabled = false,
}: {
  values: { currencyCode: string; paymentTermsDays: string; creditLimit: string };
  onChange: (next: { currencyCode: string; paymentTermsDays: string; creditLimit: string }) => void;
  error: unknown;
  disabled?: boolean;
}) {
  const t = useT();
  const issue = (path: string) => (error instanceof ApiError ? error.fieldError(path) : undefined);
  return (
    <div className="form-grid">
      <div className="field">
        <label htmlFor="customer-currency">{t('sales.field.currency')}</label>
        <select
          id="customer-currency"
          value={values.currencyCode}
          disabled={disabled}
          onChange={(e) => onChange({ ...values, currencyCode: e.target.value })}
        >
          <option value="">{t('sales.customers.baseCurrency')}</option>
          {COMMON_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label={t('sales.field.paymentTerms')}
        inputMode="numeric"
        value={values.paymentTermsDays}
        disabled={disabled}
        hint={t('sales.customers.termsHint')}
        error={issue('paymentTermsDays')}
        onChange={(e) => onChange({ ...values, paymentTermsDays: e.target.value })}
      />
      <TextField
        label={t('sales.field.creditLimit')}
        inputMode="decimal"
        value={values.creditLimit}
        disabled={disabled}
        hint={t('sales.customers.creditLimitHint')}
        error={issue('creditLimit')}
        onChange={(e) => onChange({ ...values, creditLimit: e.target.value })}
      />
    </div>
  );
}

const termsBody = (v: { currencyCode: string; paymentTermsDays: string; creditLimit: string }) => ({
  ...(v.currencyCode ? { currencyCode: v.currencyCode } : {}),
  paymentTermsDays: v.paymentTermsDays.trim() === '' ? null : Number(v.paymentTermsDays),
  creditLimit: orNull(v.creditLimit),
});

export function NewCustomerPage() {
  const t = useT();
  const navigate = useNavigate();
  const [kind, setKind] = useState<'organization' | 'individual'>('organization');
  const [displayName, setDisplayName] = useState('');
  const [reference, setReference] = useState('');
  const [email, setEmail] = useState('');
  const [tin, setTin] = useState('');
  const [terms, setTerms] = useState({ currencyCode: '', paymentTermsDays: '', creditLimit: '' });
  const create = useApiMutation((body: unknown) => api.post<CustomerDetail>('/customers', body));
  const issue = (path: string) =>
    create.error instanceof ApiError ? create.error.fieldError(path) : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      {
        party: {
          kind,
          displayName: orNull(displayName),
          reference: orNull(reference),
          email: orNull(email),
          tin: orNull(tin),
        },
        ...termsBody(terms),
      },
      { onSuccess: (customer) => void navigate(`/sales/customers/${customer.id}`) },
    );
  };
  return (
    <>
      <PageHeader title={t('sales.customers.new')} />
      <SalesNav />
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={create.error} />
        <Card title={t('sales.customers.identity')}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="customer-kind">{t('sales.field.kind')}</label>
              <select
                id="customer-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="organization">{t('sales.customers.organization')}</option>
                <option value="individual">{t('sales.customers.individual')}</option>
              </select>
            </div>
            <TextField
              label={t('sales.field.name')}
              value={displayName}
              required
              error={issue('displayName')}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <TextField
              label={t('sales.field.reference')}
              value={reference}
              error={issue('reference')}
              onChange={(e) => setReference(e.target.value)}
            />
            <TextField
              label={t('sales.field.email')}
              type="email"
              value={email}
              error={issue('email')}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TextField
              label={t('sales.field.tin')}
              value={tin}
              onChange={(e) => setTin(e.target.value)}
            />
          </div>
          <p className="muted">{t('sales.customers.moreOnContacts')}</p>
        </Card>
        <Card title={t('sales.customers.terms')}>
          <TermsFields values={terms} onChange={setTerms} error={create.error} />
        </Card>
        <p className="actions">
          <Button type="submit" busy={create.isPending}>
            {t('sales.customers.create')}
          </Button>
        </p>
      </form>
    </>
  );
}

export function CustomerDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canUpdate = usePermission(Permission.CustomersUpdate);
  const canArchive = usePermission(Permission.CustomersArchive);
  const canInvoice = usePermission(Permission.InvoicesCreate);
  const canReports = usePermission(Permission.SalesReportsView);
  const customer = useQuery({
    queryKey: ['customer', org, id],
    queryFn: () => api.get<CustomerDetail>(`/customers/${id}`),
  });
  const [form, setForm] = useState<null | {
    displayName: string;
    email: string;
    tin: string;
    currencyCode: string;
    paymentTermsDays: string;
    creditLimit: string;
  }>(null);
  const c = customer.data;
  if (c && form === null) {
    setForm({
      displayName: c.displayName,
      email: c.email ?? '',
      tin: c.tin ?? '',
      currencyCode: c.currencyCode,
      paymentTermsDays: c.paymentTermsDays === null ? '' : String(c.paymentTermsDays),
      creditLimit: c.creditLimit ?? '',
    });
  }
  const save = useApiMutation(() =>
    api.patch<CustomerDetail>(`/customers/${id}`, {
      version: c!.version,
      ...termsBody(form!),
      party: {
        version: c!.partyVersion,
        displayName: form!.displayName.trim(),
        email: orNull(form!.email),
        tin: orNull(form!.tin),
      },
    }),
  );
  const status = useApiMutation((action: 'archive' | 'restore') =>
    api.post<CustomerDetail>(`/customers/${id}/${action}`, { version: c!.version }),
  );
  const done = (data: CustomerDetail) => {
    queryClient.setQueryData(['customer', org, id], data);
    void queryClient.invalidateQueries({ queryKey: ['customers', org] });
    setForm(null);
  };
  if (customer.isError) return <ErrorAlert error={customer.error} />;
  if (customer.isPending || !form) return <Spinner label={t('common.loading')} />;
  const detail = customer.data;
  return (
    <>
      <PageHeader title={detail.displayName} description={detail.reference ?? undefined} />
      <SalesNav />
      <ErrorAlert error={save.error ?? status.error} />
      {save.isSuccess ? <Alert tone="success">{t('common.saved')}</Alert> : null}
      {save.data?.warnings?.map((w) => (
        <Alert key={w.code} tone="info">
          {w.message}
        </Alert>
      ))}
      <Card title={t('sales.customers.summary')} actions={<StatusBadge status={detail.status} />}>
        <div className="actions">
          {canInvoice && detail.status === 'ACTIVE' ? (
            <Link className="btn btn--primary" to={`/sales/invoices/new?customerId=${id}`}>
              {t('sales.invoices.new')}
            </Link>
          ) : null}
          {canReports ? (
            <Link
              className="btn btn--secondary"
              to={`/sales/reports?view=statement&customerId=${id}`}
            >
              {t('sales.customers.statement')}
            </Link>
          ) : null}
          <Link className="btn btn--secondary" to={`/parties/${detail.partyId}`}>
            {t('sales.customers.contactRecord')}
          </Link>
          {canArchive ? (
            <Button
              variant="ghost"
              busy={status.isPending}
              onClick={() =>
                status.mutate(detail.status === 'ACTIVE' ? 'archive' : 'restore', {
                  onSuccess: done,
                })
              }
            >
              {detail.status === 'ACTIVE' ? t('common.archive') : t('common.restore')}
            </Button>
          ) : null}
        </div>
      </Card>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined, { onSuccess: done });
        }}
      >
        <Card title={t('sales.customers.identity')}>
          <div className="form-grid">
            <TextField
              label={t('sales.field.name')}
              value={form.displayName}
              disabled={!canUpdate}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <TextField
              label={t('sales.field.email')}
              type="email"
              value={form.email}
              disabled={!canUpdate}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <TextField
              label={t('sales.field.tin')}
              value={form.tin}
              disabled={!canUpdate}
              onChange={(e) => setForm({ ...form, tin: e.target.value })}
            />
          </div>
        </Card>
        <Card title={t('sales.customers.terms')}>
          <TermsFields
            values={form}
            onChange={(v) => setForm({ ...form, ...v })}
            error={save.error}
            disabled={!canUpdate}
          />
          {detail.creditLimit ? (
            <p className="muted">
              {t('sales.customers.creditLimitShown', {
                amount: formatAmount(detail.creditLimit, detail.currencyCode),
                currency: detail.currencyCode,
              })}
            </p>
          ) : null}
        </Card>
        {canUpdate ? (
          <p className="actions">
            <Button type="submit" busy={save.isPending}>
              {t('common.save')}
            </Button>
          </p>
        ) : null}
      </form>
      <Card title={t('sales.customers.addresses')}>
        {detail.addresses.length === 0 ? (
          <p className="muted">{t('sales.customers.noAddresses')}</p>
        ) : (
          <ul className="list">
            {detail.addresses.map((a) => (
              <li key={a.id}>
                {t(`sales.customers.address.${a.kind}`)}:{' '}
                {[a.line1, a.line2, a.city, a.countryCode].filter(Boolean).join(', ')}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
