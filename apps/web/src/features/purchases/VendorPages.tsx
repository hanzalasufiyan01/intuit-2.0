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
import { useAccounts } from '../accounting/shared';
import type { PartySummary } from '../parties/types';
import { orNull, StatusBadge, useOrgKey } from '../sales/shared';
import { PurchasesNav } from './PurchasesSection';
import {
  fromRecoverableChoice,
  PURCHASE_ACCOUNT_SUBTYPES,
  toRecoverableChoice,
  type RecoverableChoice,
  type VendorDetail,
  type VendorSummary,
} from './types';

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

interface TermsValues {
  currencyCode: string;
  paymentTermsDays: string;
  creditLimit: string;
  accountNumber: string;
  defaultExpenseAccountId: string;
  defaultTaxCodeId: string;
  defaultTaxRecoverable: RecoverableChoice;
}

const emptyTerms: TermsValues = {
  currencyCode: '',
  paymentTermsDays: '',
  creditLimit: '',
  accountNumber: '',
  defaultExpenseAccountId: '',
  defaultTaxCodeId: '',
  defaultTaxRecoverable: '',
};

const termsBody = (v: TermsValues) => ({
  ...(v.currencyCode ? { currencyCode: v.currencyCode } : {}),
  paymentTermsDays: v.paymentTermsDays.trim() === '' ? null : Number(v.paymentTermsDays),
  creditLimit: orNull(v.creditLimit),
  accountNumber: orNull(v.accountNumber),
  defaultExpenseAccountId: v.defaultExpenseAccountId || null,
  defaultTaxCodeId: v.defaultTaxCodeId || null,
  defaultTaxRecoverable: fromRecoverableChoice(v.defaultTaxRecoverable),
});

/** Tax codes for the vendor default; hidden when the user cannot read them. */
function useTaxCodeOptions() {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['tax-codes', org],
    queryFn: () =>
      api.get<{ id: string; code: string; name: string; status: string }[]>('/tax/codes'),
    retry: false,
  });
}

export function VendorsPage() {
  const t = useT();
  const org = useOrgKey();
  const [filters, setFilters] = useState({ search: '', status: 'active' });
  const [applied, setApplied] = useState(filters);
  const list = useInfiniteQuery({
    queryKey: ['vendors', org, applied],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ status: applied.status, limit: '50' });
      if (applied.search.trim()) params.set('search', applied.search.trim());
      if (pageParam) params.set('after', pageParam);
      return api.get<Page<VendorSummary>>(`/vendors?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader
        title={t('purchases.vendors.title')}
        description={t('purchases.vendors.description')}
      />
      <PurchasesNav />
      <Card
        actions={
          <Can permission={Permission.VendorsCreate}>
            <Link className="btn btn--primary" to="/purchases/vendors/new">
              {t('purchases.vendors.new')}
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
            placeholder={t('purchases.vendors.searchHint')}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <div className="field">
            <label htmlFor="vendor-status">{t('purchases.field.status')}</label>
            <select
              id="vendor-status"
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
          <p className="muted">{t('purchases.vendors.none')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('purchases.field.name')}</th>
                <th>{t('purchases.field.reference')}</th>
                <th>{t('purchases.field.email')}</th>
                <th>{t('purchases.field.currency')}</th>
                <th>{t('purchases.field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <tr key={v.id}>
                  <td>
                    <Link to={`/purchases/vendors/${v.id}`}>{v.displayName}</Link>
                  </td>
                  <td>{v.reference}</td>
                  <td>{v.email}</td>
                  <td>{v.currencyCode}</td>
                  <td>
                    <StatusBadge status={v.status} />
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

/** Vendor terms and defaults. The credit limit is a warning only. */
function TermsFields({
  values,
  onChange,
  error,
  disabled = false,
}: {
  values: TermsValues;
  onChange: (next: TermsValues) => void;
  error: unknown;
  disabled?: boolean;
}) {
  const t = useT();
  const canAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canAccounts);
  const taxCodes = useTaxCodeOptions();
  const issue = (path: string) => (error instanceof ApiError ? error.fieldError(path) : undefined);
  const purchaseAccounts = (accounts.data ?? []).filter(
    (a) =>
      (a.status === 'ACTIVE' &&
        a.isLeaf !== false &&
        !a.isControlAccount &&
        a.subtype !== null &&
        (PURCHASE_ACCOUNT_SUBTYPES as readonly string[]).includes(a.subtype)) ||
      a.id === values.defaultExpenseAccountId,
  );
  return (
    <div className="form-grid">
      <div className="field">
        <label htmlFor="vendor-currency">{t('purchases.field.currency')}</label>
        <select
          id="vendor-currency"
          value={values.currencyCode}
          disabled={disabled}
          onChange={(e) => onChange({ ...values, currencyCode: e.target.value })}
        >
          <option value="">{t('purchases.vendors.baseCurrency')}</option>
          {[...new Set([...COMMON_CURRENCIES, values.currencyCode].filter(Boolean))].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label={t('purchases.field.paymentTerms')}
        inputMode="numeric"
        value={values.paymentTermsDays}
        disabled={disabled}
        hint={t('purchases.vendors.termsHint')}
        error={issue('paymentTermsDays')}
        onChange={(e) => onChange({ ...values, paymentTermsDays: e.target.value })}
      />
      <TextField
        label={t('purchases.field.creditLimit')}
        inputMode="decimal"
        value={values.creditLimit}
        disabled={disabled}
        hint={t('purchases.vendors.creditLimitHint')}
        error={issue('creditLimit')}
        onChange={(e) => onChange({ ...values, creditLimit: e.target.value })}
      />
      <TextField
        label={t('purchases.field.accountNumber')}
        value={values.accountNumber}
        disabled={disabled}
        hint={t('purchases.vendors.accountNumberHint')}
        error={issue('accountNumber')}
        onChange={(e) => onChange({ ...values, accountNumber: e.target.value })}
      />
      {canAccounts ? (
        <div className="field">
          <label htmlFor="vendor-expense-account">
            {t('purchases.field.defaultExpenseAccount')}
          </label>
          <select
            id="vendor-expense-account"
            value={values.defaultExpenseAccountId}
            disabled={disabled}
            onChange={(e) => onChange({ ...values, defaultExpenseAccountId: e.target.value })}
          >
            <option value="">{t('common.none')}</option>
            {purchaseAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
          {issue('defaultExpenseAccountId') ? (
            <small className="field__error">{issue('defaultExpenseAccountId')}</small>
          ) : null}
        </div>
      ) : null}
      {taxCodes.isSuccess ? (
        <div className="field">
          <label htmlFor="vendor-tax-code">{t('purchases.field.defaultTaxCode')}</label>
          <select
            id="vendor-tax-code"
            value={values.defaultTaxCodeId}
            disabled={disabled}
            onChange={(e) => onChange({ ...values, defaultTaxCodeId: e.target.value })}
          >
            <option value="">{t('common.none')}</option>
            {taxCodes.data
              .filter((c) => c.status === 'ACTIVE' || c.id === values.defaultTaxCodeId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </option>
              ))}
          </select>
          {issue('defaultTaxCodeId') ? (
            <small className="field__error">{issue('defaultTaxCodeId')}</small>
          ) : null}
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="vendor-tax-recoverable">{t('purchases.field.taxRecoverable')}</label>
        <select
          id="vendor-tax-recoverable"
          value={values.defaultTaxRecoverable}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...values, defaultTaxRecoverable: e.target.value as RecoverableChoice })
          }
        >
          <option value="">{t('purchases.recoverable.none')}</option>
          <option value="true">{t('purchases.recoverable.yes')}</option>
          <option value="false">{t('purchases.recoverable.no')}</option>
        </select>
        <small className="field__hint">{t('purchases.recoverable.hint')}</small>
      </div>
    </div>
  );
}

export function NewVendorPage() {
  const t = useT();
  const navigate = useNavigate();
  const org = useOrgKey();
  const canContacts = usePermission(Permission.PartiesView);
  const [source, setSource] = useState<'new' | 'existing'>('new');
  const [kind, setKind] = useState<'organization' | 'individual'>('organization');
  const [displayName, setDisplayName] = useState('');
  const [reference, setReference] = useState('');
  const [email, setEmail] = useState('');
  const [tin, setTin] = useState('');
  const [partySearch, setPartySearch] = useState('');
  const [partyQuery, setPartyQuery] = useState('');
  const [partyId, setPartyId] = useState('');
  const [terms, setTerms] = useState<TermsValues>(emptyTerms);
  const parties = useQuery({
    queryKey: ['vendor-party-options', org, partyQuery],
    queryFn: () =>
      api.get<Page<PartySummary>>(
        `/parties?${new URLSearchParams({ status: 'active', limit: '20', search: partyQuery }).toString()}`,
      ),
    enabled: canContacts && source === 'existing',
  });
  const create = useApiMutation((body: unknown) => api.post<VendorDetail>('/vendors', body));
  const issue = (path: string) =>
    create.error instanceof ApiError ? create.error.fieldError(path) : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const identity =
      source === 'existing'
        ? { partyId }
        : {
            party: {
              kind,
              displayName: orNull(displayName),
              reference: orNull(reference),
              email: orNull(email),
              tin: orNull(tin),
            },
          };
    create.mutate(
      { ...identity, ...termsBody(terms) },
      { onSuccess: (vendor) => void navigate(`/purchases/vendors/${vendor.id}`) },
    );
  };
  return (
    <>
      <PageHeader title={t('purchases.vendors.new')} />
      <PurchasesNav />
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={create.error} />
        <Card title={t('purchases.vendors.identity')}>
          {canContacts ? (
            <div className="field">
              <span>{t('purchases.vendors.source')}</span>
              <label className="checkbox">
                <input
                  type="radio"
                  name="vendor-source"
                  checked={source === 'new'}
                  onChange={() => setSource('new')}
                />{' '}
                {t('purchases.vendors.sourceNew')}
              </label>
              <label className="checkbox">
                <input
                  type="radio"
                  name="vendor-source"
                  checked={source === 'existing'}
                  onChange={() => setSource('existing')}
                />{' '}
                {t('purchases.vendors.sourceExisting')}
              </label>
            </div>
          ) : null}
          {source === 'existing' ? (
            <div className="form-grid">
              <div className="field">
                <TextField
                  label={t('purchases.vendors.findContact')}
                  value={partySearch}
                  onChange={(e) => setPartySearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      setPartyQuery(partySearch.trim());
                    }
                  }}
                />
                <Button variant="secondary" onClick={() => setPartyQuery(partySearch.trim())}>
                  {t('common.search')}
                </Button>
              </div>
              <div className="field">
                <label htmlFor="vendor-party">{t('purchases.vendors.contact')}</label>
                <select
                  id="vendor-party"
                  value={partyId}
                  required
                  onChange={(e) => setPartyId(e.target.value)}
                >
                  <option value="">{t('common.choose')}</option>
                  {(parties.data?.items ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                      {p.roles.length ? ` (${p.roles.join(', ')})` : ''}
                    </option>
                  ))}
                </select>
                {issue('partyId') ? (
                  <small className="field__error">{issue('partyId')}</small>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="vendor-kind">{t('purchases.field.kind')}</label>
                  <select
                    id="vendor-kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                  >
                    <option value="organization">{t('sales.customers.organization')}</option>
                    <option value="individual">{t('sales.customers.individual')}</option>
                  </select>
                </div>
                <TextField
                  label={t('purchases.field.name')}
                  value={displayName}
                  required
                  error={issue('displayName')}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
                <TextField
                  label={t('purchases.field.reference')}
                  value={reference}
                  error={issue('reference')}
                  onChange={(e) => setReference(e.target.value)}
                />
                <TextField
                  label={t('purchases.field.email')}
                  type="email"
                  value={email}
                  error={issue('email')}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <TextField
                  label={t('purchases.field.tin')}
                  value={tin}
                  onChange={(e) => setTin(e.target.value)}
                />
              </div>
              <p className="muted">{t('purchases.vendors.moreOnContacts')}</p>
            </>
          )}
        </Card>
        <Card title={t('purchases.vendors.terms')}>
          <TermsFields values={terms} onChange={setTerms} error={create.error} />
        </Card>
        <p className="actions">
          <Button type="submit" busy={create.isPending}>
            {t('purchases.vendors.create')}
          </Button>
        </p>
      </form>
    </>
  );
}

export function VendorDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canUpdate = usePermission(Permission.VendorsUpdate);
  const canArchive = usePermission(Permission.VendorsArchive);
  const vendor = useQuery({
    queryKey: ['vendor', org, id],
    queryFn: () => api.get<VendorDetail>(`/vendors/${id}`),
  });
  const [form, setForm] = useState<
    null | (TermsValues & { displayName: string; email: string; tin: string })
  >(null);
  const v = vendor.data;
  if (v && form === null) {
    setForm({
      displayName: v.displayName,
      email: v.email ?? '',
      tin: v.tin ?? '',
      currencyCode: v.currencyCode,
      paymentTermsDays: v.paymentTermsDays === null ? '' : String(v.paymentTermsDays),
      creditLimit: v.creditLimit ?? '',
      accountNumber: v.accountNumber ?? '',
      defaultExpenseAccountId: v.defaultExpenseAccountId ?? '',
      defaultTaxCodeId: v.defaultTaxCodeId ?? '',
      defaultTaxRecoverable: toRecoverableChoice(v.defaultTaxRecoverable),
    });
  }
  const save = useApiMutation(() =>
    api.patch<VendorDetail>(`/vendors/${id}`, {
      version: v!.version,
      ...termsBody(form!),
      party: {
        version: v!.partyVersion,
        displayName: form!.displayName.trim(),
        email: orNull(form!.email),
        tin: orNull(form!.tin),
      },
    }),
  );
  const status = useApiMutation((action: 'archive' | 'restore') =>
    api.post<VendorDetail>(`/vendors/${id}/${action}`, { version: v!.version }),
  );
  const done = (data: VendorDetail) => {
    queryClient.setQueryData(['vendor', org, id], data);
    void queryClient.invalidateQueries({ queryKey: ['vendors', org] });
    setForm(null);
  };
  if (vendor.isError) return <ErrorAlert error={vendor.error} />;
  if (vendor.isPending || !form) return <Spinner label={t('common.loading')} />;
  const detail = vendor.data;
  return (
    <>
      <PageHeader title={detail.displayName} description={detail.reference ?? undefined} />
      <PurchasesNav />
      <ErrorAlert error={save.error ?? status.error} />
      {save.isSuccess ? <Alert tone="success">{t('common.saved')}</Alert> : null}
      {save.data?.warnings?.map((w) => (
        <Alert key={w.code} tone="info">
          {w.message}
        </Alert>
      ))}
      {detail.status === 'ARCHIVED' ? (
        <Alert tone="info">{t('purchases.vendors.archivedNote')}</Alert>
      ) : null}
      <Card title={t('purchases.vendors.summary')} actions={<StatusBadge status={detail.status} />}>
        <div className="actions">
          <Link className="btn btn--secondary" to={`/parties/${detail.partyId}`}>
            {t('purchases.vendors.contactRecord')}
          </Link>
          {/* Phase 4B-5: the vendor statement (P4-49). */}
          <Can permission={Permission.PurchasesReportsView}>
            <Link
              className="btn btn--secondary"
              to={`/purchases/reports?view=statement&vendorId=${detail.id}`}
            >
              {t('purchases.reports.statementLink')}
            </Link>
          </Can>
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
        {detail.roles.includes('customer') ? (
          <p className="muted">{t('purchases.vendors.alsoCustomer')}</p>
        ) : null}
      </Card>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined, { onSuccess: done });
        }}
      >
        <Card title={t('purchases.vendors.identity')}>
          <div className="form-grid">
            <TextField
              label={t('purchases.field.name')}
              value={form.displayName}
              disabled={!canUpdate}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <TextField
              label={t('purchases.field.email')}
              type="email"
              value={form.email}
              disabled={!canUpdate}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <TextField
              label={t('purchases.field.tin')}
              value={form.tin}
              disabled={!canUpdate}
              onChange={(e) => setForm({ ...form, tin: e.target.value })}
            />
          </div>
        </Card>
        <Card title={t('purchases.vendors.terms')}>
          <TermsFields
            values={form}
            onChange={(next) => setForm({ ...form, ...next })}
            error={save.error}
            disabled={!canUpdate}
          />
          {detail.creditLimit ? (
            <p className="muted">
              {t('purchases.vendors.creditLimitShown', {
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
      <Card title={t('purchases.vendors.addresses')}>
        {detail.addresses.length === 0 ? (
          <p className="muted">{t('purchases.vendors.noAddresses')}</p>
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
