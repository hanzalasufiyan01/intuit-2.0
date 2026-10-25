import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api, type ApiError } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { EmptyState } from '../../shared/ui/EmptyState';
import { LoadingState } from '../../shared/ui/LoadingState';
import { Badge } from '../../shared/ui/Badge';
import { DataTable, RowActions } from '../../shared/ui/Table';
import { Spinner } from '../../shared/ui/Spinner';
import { CheckboxField } from '../../shared/ui/CheckboxField';
import { SelectField } from '../../shared/ui/SelectField';
import { TextField } from '../../shared/ui/TextField';
import { AttachmentsCard } from '../files/AttachmentsCard';
import { ExportButton } from '../data-exchange/ExportButton';
import { CountrySelect, orNull } from './shared';
import {
  PARTY_ROLES,
  ROLE_LABELS,
  type DuplicateWarning,
  type PartyAddress,
  type PartyContact,
  type PartyDetail,
  type PartyKind,
  type PartyRole,
  type PartySummary,
} from './types';
import { useT } from '../../i18n/i18n';

const useOrg = () => useAuth().activeOrganization?.id ?? 'none';

// ---------------------------------------------------------------------------
// List (S4-15)
// ---------------------------------------------------------------------------

export function PartiesPage() {
  const t = useT();
  const org = useOrg();
  const [filters, setFilters] = useState({ search: '', role: '', status: 'active' });
  const [applied, setApplied] = useState(filters);
  const list = useInfiniteQuery({
    queryKey: ['parties', org, applied],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ status: applied.status, limit: '50' });
      if (applied.search.trim()) params.set('search', applied.search.trim());
      if (applied.role) params.set('role', applied.role);
      if (pageParam) params.set('after', pageParam);
      return api.get<{ items: PartySummary[]; nextCursor: string | null }>(
        `/parties?${params.toString()}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader
        title={t('parties.partyPages.contacts')}
        description={t('parties.partyPages.customersVendorsEmployeesAndOther')}
      />
      <p className="actions">
        <ExportButton domain="parties" label={t('parties.partyPages.exportContactsCsv')} />
        <ExportButton
          domain="parties"
          params={{ layout: 'contacts' }}
          label={t('parties.partyPages.exportContactPersonsCsv')}
        />
      </p>
      <Card
        actions={
          <Can permission={Permission.PartiesCreate}>
            <Link className="button" to="/parties/new">
              {t('parties.partyPages.newContact')}
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
            placeholder={t('parties.partyPages.nameReferenceEmailOrTin')}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <div className="field">
            <label htmlFor="party-role-filter">{t('parties.partyPages.role')}</label>
            <select
              id="party-role-filter"
              value={filters.role}
              onChange={(e) => setFilters({ ...filters, role: e.target.value })}
            >
              <option value="">{t('parties.partyPages.allRoles')}</option>
              {PARTY_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <SelectField
            id="party-status-filter"
            label={t('parties.partyPages.status')}
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="active">{t('parties.partyPages.active')}</option>
            <option value="archived">{t('parties.partyPages.archived')}</option>
            <option value="all">{t('common.all')}</option>
          </SelectField>
          <Button type="submit">{t('common.search')}</Button>
        </form>
      </Card>
      <Card>
        {list.isPending ? (
          <LoadingState label={t('parties.partyPages.loadingContacts')} />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : items.length === 0 ? (
          <EmptyState message={t('parties.partyPages.noContactsFound')} />
        ) : (
          <DataTable label={t('parties.partyPages.contacts')}>
            <thead>
              <tr>
                <th>{t('parties.partyPages.name')}</th>
                <th>{t('parties.partyPages.reference')}</th>
                <th>{t('parties.partyPages.roles')}</th>
                <th>{t('parties.partyPages.email')}</th>
                <th>{t('parties.partyPages.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/parties/${p.id}`}>{p.displayName}</Link>
                  </td>
                  <td>{p.reference}</td>
                  <td>{p.roles.map((r) => ROLE_LABELS[r]).join(', ')}</td>
                  <td>{p.email}</td>
                  <td>
                    {p.status === 'ARCHIVED' ? (
                      <Badge tone="neutral">{t('parties.partyPages.archived2')}</Badge>
                    ) : (
                      t('parties.partyPages.active')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
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

// ---------------------------------------------------------------------------
// Header form (create and edit)
// ---------------------------------------------------------------------------

interface HeaderDraft {
  kind: PartyKind;
  displayName: string;
  companyName: string;
  firstName: string;
  lastName: string;
  reference: string;
  tin: string;
  email: string;
  phone: string;
  website: string;
  notes: string;
  roles: PartyRole[];
}

const headerFrom = (p?: PartyDetail): HeaderDraft => ({
  kind: p?.kind ?? 'organization',
  displayName: p?.displayName ?? '',
  companyName: p?.companyName ?? '',
  firstName: p?.firstName ?? '',
  lastName: p?.lastName ?? '',
  reference: p?.reference ?? '',
  tin: p?.tin ?? '',
  email: p?.email ?? '',
  phone: p?.phone ?? '',
  website: p?.website ?? '',
  notes: p?.notes ?? '',
  roles: p?.roles ?? [],
});

const headerBody = (d: HeaderDraft) => ({
  kind: d.kind,
  displayName: orNull(d.displayName),
  companyName: orNull(d.companyName),
  firstName: orNull(d.firstName),
  lastName: orNull(d.lastName),
  reference: orNull(d.reference),
  tin: orNull(d.tin),
  email: orNull(d.email),
  phone: orNull(d.phone),
  website: orNull(d.website),
  notes: orNull(d.notes),
  roles: d.roles,
});

function HeaderFields({
  draft,
  onChange,
  error,
}: {
  draft: HeaderDraft;
  onChange: (next: HeaderDraft) => void;
  error: ApiError | null;
}) {
  const t = useT();
  const text = (key: Exclude<keyof HeaderDraft, 'kind' | 'roles'>, label: string) => (
    <TextField
      label={label}
      value={draft[key]}
      onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
      error={error?.fieldError(key)}
    />
  );
  return (
    <>
      <div className="form form--inline">
        <div className="field">
          <label htmlFor="party-kind">{t('parties.partyPages.kind')}</label>
          <select
            id="party-kind"
            value={draft.kind}
            onChange={(e) => onChange({ ...draft, kind: e.target.value as PartyKind })}
          >
            <option value="organization">{t('parties.partyPages.organization')}</option>
            <option value="individual">{t('parties.partyPages.individual')}</option>
          </select>
        </div>
        {text('displayName', t('parties.partyPages.field.displayName'))}
        {draft.kind === 'organization'
          ? text('companyName', t('parties.partyPages.field.companyName'))
          : null}
        {draft.kind === 'individual' ? (
          <>
            {text('firstName', t('parties.partyPages.field.firstName'))}
            {text('lastName', t('parties.partyPages.field.lastName'))}
          </>
        ) : null}
        {text('reference', t('parties.partyPages.field.reference'))}
        {text('tin', t('parties.partyPages.field.tin'))}
        {text('email', t('parties.partyPages.field.email'))}
        {text('phone', t('parties.partyPages.field.phone'))}
        {text('website', t('parties.partyPages.field.website'))}
      </div>
      <div className="choice-grid">
        <div>
          <strong>{t('parties.partyPages.roles')}</strong>
          {PARTY_ROLES.map((role) => (
            <CheckboxField
              key={role}
              label={ROLE_LABELS[role]}
              checked={draft.roles.includes(role)}
              onChange={() =>
                onChange({
                  ...draft,
                  roles: draft.roles.includes(role)
                    ? draft.roles.filter((r) => r !== role)
                    : [...draft.roles, role],
                })
              }
            />
          ))}
        </div>
      </div>
      <TextField
        label={t('parties.partyPages.notes')}
        value={draft.notes}
        onChange={(e) => onChange({ ...draft, notes: e.target.value })}
      />
    </>
  );
}

function DuplicateNotice({ warnings }: { warnings: DuplicateWarning[] | undefined }) {
  const t = useT();
  const match = warnings?.find((w) => w.code === 'POSSIBLE_DUPLICATE');
  if (!match) return null;
  return (
    <Alert tone="info">
      {t('parties.partyPages.possibleDuplicate', { message: match.message })}{' '}
      {match.matches.map((m, i) => (
        <span key={m.partyId}>
          {i > 0 ? ', ' : ''}
          <Link to={`/parties/${m.partyId}`}>{t('parties.partyPages.viewMatch')}</Link> (
          {m.matchedOn.join(', ')})
        </span>
      ))}
    </Alert>
  );
}

export function NewPartyPage() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(headerFrom());
  const create = useApiMutation(() => api.post<PartyDetail>('/parties', headerBody(draft)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: (party) => {
        void queryClient.invalidateQueries({ queryKey: ['parties'] });
        queryClient.setQueryData(['party', party.id], party);
        void navigate(`/parties/${party.id}`, { state: { warnings: party.warnings } });
      },
    });
  };
  return (
    <>
      <PageHeader title={t('parties.partyPages.newContact')} />
      <Card>
        <form className="form" onSubmit={submit} noValidate>
          <HeaderFields draft={draft} onChange={setDraft} error={create.error} />
          <ErrorAlert error={create.error?.issues.length ? null : create.error} />
          <div className="actions">
            <Button type="submit" busy={create.isPending}>
              {t('parties.partyPages.createContact')}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail: header, contact persons, addresses, archive/restore
// ---------------------------------------------------------------------------

function useParty(id: string) {
  return useQuery({
    queryKey: ['party', id],
    queryFn: () => api.get<PartyDetail>(`/parties/${id}`),
  });
}

function ContactsCard({
  party,
  onSaved,
}: {
  party: PartyDetail;
  onSaved: (p: PartyDetail) => void;
}) {
  const t = useT();
  const canUpdate = usePermission(Permission.PartiesUpdate);
  const empty = {
    firstName: '',
    lastName: '',
    jobTitle: '',
    email: '',
    phone: '',
    isPrimary: false,
    receivesDocuments: false,
  };
  const [form, setForm] = useState(empty);
  const add = useApiMutation(() =>
    api.post<PartyDetail>(`/parties/${party.id}/contacts`, {
      firstName: orNull(form.firstName),
      lastName: orNull(form.lastName),
      jobTitle: orNull(form.jobTitle),
      email: orNull(form.email),
      phone: orNull(form.phone),
      isPrimary: form.isPrimary,
      receivesDocuments: form.receivesDocuments,
    }),
  );
  const change = useApiMutation((input: { contact: PartyContact; action: 'primary' | 'remove' }) =>
    input.action === 'remove'
      ? api.delete<PartyDetail>(`/parties/${party.id}/contacts/${input.contact.id}`)
      : api.patch<PartyDetail>(`/parties/${party.id}/contacts/${input.contact.id}`, {
          isPrimary: true,
        }),
  );
  return (
    <Card title={t('parties.partyPages.contactPersons')}>
      <DataTable label={t('parties.partyPages.contactPersons')}>
        <thead>
          <tr>
            <th>{t('parties.partyPages.name')}</th>
            <th>{t('parties.partyPages.jobTitle')}</th>
            <th>{t('parties.partyPages.email')}</th>
            <th>{t('parties.partyPages.phone')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {party.contacts.map((c) => (
            <tr key={c.id}>
              <td>
                {[c.firstName, c.lastName].filter(Boolean).join(' ')}
                {c.isPrimary ? (
                  <span className="badge"> {t('parties.partyPages.primary')}</span>
                ) : null}
                {c.receivesDocuments ? (
                  <span className="muted"> {t('parties.partyPages.receivesDocuments')}</span>
                ) : null}
              </td>
              <td>{c.jobTitle}</td>
              <td>{c.email}</td>
              <td>{c.phone}</td>
              <RowActions>
                {canUpdate && !c.isPrimary ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      change.mutate({ contact: c, action: 'primary' }, { onSuccess: onSaved })
                    }
                  >
                    {t('parties.partyPages.makePrimary')}
                  </Button>
                ) : null}
                {canUpdate ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      change.mutate({ contact: c, action: 'remove' }, { onSuccess: onSaved })
                    }
                  >
                    {t('common.remove')}
                  </Button>
                ) : null}
              </RowActions>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <ErrorAlert error={change.error} />
      {canUpdate ? (
        <form
          className="form form--inline"
          aria-label={t('parties.partyPages.addContactPerson')}
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined, { onSuccess: (p) => (setForm(empty), onSaved(p)) });
          }}
        >
          <TextField
            label={t('parties.partyPages.contactFirstName')}
            value={form.firstName}
            onChange={(e) => setForm({ ...form, firstName: e.target.value })}
            error={add.error?.fieldError('firstName')}
          />
          <TextField
            label={t('parties.partyPages.contactLastName')}
            value={form.lastName}
            onChange={(e) => setForm({ ...form, lastName: e.target.value })}
          />
          <TextField
            label={t('parties.partyPages.contactJobTitle')}
            value={form.jobTitle}
            onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
          />
          <TextField
            label={t('parties.partyPages.contactEmail')}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            error={add.error?.fieldError('email')}
          />
          <TextField
            label={t('parties.partyPages.contactPhone')}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          <CheckboxField
            label={t('parties.partyPages.primary2')}
            checked={form.isPrimary}
            onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })}
          />
          <CheckboxField
            label={t('parties.partyPages.receivesDocuments2')}
            checked={form.receivesDocuments}
            onChange={(e) => setForm({ ...form, receivesDocuments: e.target.checked })}
          />
          <Button type="submit" busy={add.isPending}>
            {t('parties.partyPages.addContactPerson')}
          </Button>
          <ErrorAlert error={add.error?.issues.length ? null : add.error} />
        </form>
      ) : null}
    </Card>
  );
}

function AddressesCard({
  party,
  onSaved,
}: {
  party: PartyDetail;
  onSaved: (p: PartyDetail) => void;
}) {
  const t = useT();
  const canUpdate = usePermission(Permission.PartiesUpdate);
  const empty = {
    kind: 'billing' as PartyAddress['kind'],
    label: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    countryCode: '',
    isDefault: false,
  };
  const [form, setForm] = useState(empty);
  const add = useApiMutation(() =>
    api.post<PartyDetail>(`/parties/${party.id}/addresses`, {
      kind: form.kind,
      label: orNull(form.label),
      line1: form.line1.trim(),
      line2: orNull(form.line2),
      city: orNull(form.city),
      region: orNull(form.region),
      postalCode: orNull(form.postalCode),
      countryCode: form.countryCode,
      isDefault: form.isDefault,
    }),
  );
  const change = useApiMutation((input: { address: PartyAddress; action: 'default' | 'remove' }) =>
    input.action === 'remove'
      ? api.delete<PartyDetail>(`/parties/${party.id}/addresses/${input.address.id}`)
      : api.patch<PartyDetail>(`/parties/${party.id}/addresses/${input.address.id}`, {
          isDefault: true,
        }),
  );
  return (
    <Card title={t('parties.partyPages.addresses')}>
      <DataTable label={t('parties.partyPages.addresses')}>
        <thead>
          <tr>
            <th>{t('parties.partyPages.kind')}</th>
            <th>{t('parties.partyPages.address')}</th>
            <th>{t('parties.partyPages.country')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {party.addresses.map((a) => (
            <tr key={a.id}>
              <td>
                {a.kind === 'billing'
                  ? t('parties.partyPages.billing')
                  : t('parties.partyPages.delivery')}
                {a.isDefault ? (
                  <span className="badge"> {t('parties.partyPages.default')}</span>
                ) : null}
              </td>
              <td>
                {[a.label, a.line1, a.line2, a.city, a.region, a.postalCode]
                  .filter(Boolean)
                  .join(', ')}
              </td>
              <td>{a.countryCode}</td>
              <RowActions>
                {canUpdate && !a.isDefault ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      change.mutate({ address: a, action: 'default' }, { onSuccess: onSaved })
                    }
                  >
                    {t('parties.partyPages.makeDefault')}
                  </Button>
                ) : null}
                {canUpdate ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      change.mutate({ address: a, action: 'remove' }, { onSuccess: onSaved })
                    }
                  >
                    {t('common.remove')}
                  </Button>
                ) : null}
              </RowActions>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <ErrorAlert error={change.error} />
      {canUpdate ? (
        <form
          className="form form--inline"
          aria-label={t('parties.partyPages.addAddress')}
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined, { onSuccess: (p) => (setForm(empty), onSaved(p)) });
          }}
        >
          <div className="field">
            <label htmlFor="address-kind">{t('parties.partyPages.addressKind')}</label>
            <select
              id="address-kind"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as PartyAddress['kind'] })}
            >
              <option value="billing">{t('parties.partyPages.billing')}</option>
              <option value="delivery">{t('parties.partyPages.delivery')}</option>
            </select>
          </div>
          <TextField
            label={t('parties.partyPages.addressLabel')}
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
          <TextField
            label={t('parties.partyPages.addressLine1')}
            value={form.line1}
            onChange={(e) => setForm({ ...form, line1: e.target.value })}
            error={add.error?.fieldError('line1')}
          />
          <TextField
            label={t('parties.partyPages.addressLine2')}
            value={form.line2}
            onChange={(e) => setForm({ ...form, line2: e.target.value })}
          />
          <TextField
            label={t('parties.partyPages.city')}
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
          />
          <TextField
            label={t('parties.partyPages.regionAtoll')}
            value={form.region}
            onChange={(e) => setForm({ ...form, region: e.target.value })}
          />
          <TextField
            label={t('parties.partyPages.postalCode')}
            value={form.postalCode}
            onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
          />
          <CountrySelect
            id="address-country"
            label={t('parties.partyPages.country')}
            value={form.countryCode}
            onChange={(countryCode) => setForm({ ...form, countryCode })}
            error={add.error?.fieldError('countryCode')}
          />
          <CheckboxField
            label={t('parties.partyPages.default2')}
            checked={form.isDefault}
            onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
          />
          <Button type="submit" busy={add.isPending}>
            {t('parties.partyPages.addAddress')}
          </Button>
          <ErrorAlert error={add.error?.issues.length ? null : add.error} />
        </form>
      ) : null}
    </Card>
  );
}

export function PartyDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const party = useParty(id);
  const canUpdate = usePermission(Permission.PartiesUpdate);
  const canArchive = usePermission(Permission.PartiesArchive);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<HeaderDraft | null>(null);
  const [warnings, setWarnings] = useState<DuplicateWarning[] | undefined>(
    () => queryClient.getQueryData<PartyDetail>(['party', id])?.warnings,
  );
  const saved = (p: PartyDetail) => {
    queryClient.setQueryData(['party', id], p);
    void queryClient.invalidateQueries({ queryKey: ['parties'] });
  };
  const update = useApiMutation(() =>
    api.patch<PartyDetail>(`/parties/${id}`, {
      version: party.data!.version,
      ...headerBody(draft!),
    }),
  );
  const status = useApiMutation((action: 'archive' | 'restore') =>
    api.post<PartyDetail>(`/parties/${id}/${action}`, {}),
  );

  if (party.isPending) return <Spinner label={t('parties.partyPages.loadingContact')} />;
  if (party.isError) return <ErrorAlert error={party.error} />;
  const p = party.data;
  return (
    <>
      <PageHeader
        title={p.displayName}
        description={
          p.roles.map((r) => ROLE_LABELS[r]).join(', ') || t('parties.partyPages.noRoles')
        }
      />
      {p.status === 'ARCHIVED' ? (
        <Alert tone="info">{t('parties.partyPages.thisContactIsArchived')}</Alert>
      ) : null}
      <DuplicateNotice warnings={warnings} />
      <Card
        title={t('parties.partyPages.details')}
        actions={
          <>
            {canUpdate && !editing ? (
              <Button
                variant="secondary"
                onClick={() => (setDraft(headerFrom(p)), setEditing(true))}
              >
                {t('common.edit')}
              </Button>
            ) : null}
            {canArchive ? (
              <Button
                variant="ghost"
                busy={status.isPending}
                onClick={() =>
                  status.mutate(p.status === 'ACTIVE' ? 'archive' : 'restore', { onSuccess: saved })
                }
              >
                {p.status === 'ACTIVE' ? t('common.archive') : t('common.restore')}
              </Button>
            ) : null}
          </>
        }
      >
        {editing && draft ? (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate(undefined, {
                onSuccess: (next) => {
                  saved(next);
                  setWarnings(next.warnings);
                  setEditing(false);
                },
              });
            }}
          >
            <HeaderFields draft={draft} onChange={setDraft} error={update.error} />
            {update.error?.code === 'VERSION_CONFLICT' ? (
              <Alert>
                {update.error.message}{' '}
                <Button variant="ghost" onClick={() => (void party.refetch(), setEditing(false))}>
                  {t('parties.partyPages.reload')}
                </Button>
              </Alert>
            ) : (
              <ErrorAlert error={update.error?.issues.length ? null : update.error} />
            )}
            <div className="actions">
              <Button type="submit" busy={update.isPending}>
                {t('common.save')}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <dl className="details">
            <dt>{t('parties.partyPages.kind')}</dt>
            <dd>
              {p.kind === 'organization'
                ? t('parties.partyPages.organization')
                : t('parties.partyPages.individual')}
            </dd>
            {p.companyName ? (
              <>
                <dt>{t('parties.partyPages.company')}</dt>
                <dd>{p.companyName}</dd>
              </>
            ) : null}
            {p.reference ? (
              <>
                <dt>{t('parties.partyPages.reference')}</dt>
                <dd>{p.reference}</dd>
              </>
            ) : null}
            {p.tin ? (
              <>
                <dt>TIN</dt>
                <dd>{p.tin}</dd>
              </>
            ) : null}
            {p.email ? (
              <>
                <dt>{t('parties.partyPages.email')}</dt>
                <dd>{p.email}</dd>
              </>
            ) : null}
            {p.phone ? (
              <>
                <dt>{t('parties.partyPages.phone')}</dt>
                <dd>{p.phone}</dd>
              </>
            ) : null}
            {p.website ? (
              <>
                <dt>{t('parties.partyPages.website')}</dt>
                <dd>{p.website}</dd>
              </>
            ) : null}
            {p.notes ? (
              <>
                <dt>{t('parties.partyPages.notes')}</dt>
                <dd>{p.notes}</dd>
              </>
            ) : null}
          </dl>
        )}
        <ErrorAlert error={status.error} />
      </Card>
      <ContactsCard party={p} onSaved={saved} />
      <AddressesCard party={p} onSaved={saved} />
      <AttachmentsCard linkType="party" linkId={p.id} canChange={canUpdate} canRemove={canUpdate} />
    </>
  );
}
