import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api, type ApiError } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
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

const useOrg = () => useAuth().activeOrganization?.id ?? 'none';

// ---------------------------------------------------------------------------
// List (S4-15)
// ---------------------------------------------------------------------------

export function PartiesPage() {
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
      <PageHeader title="Contacts" description="Customers, vendors, employees and other parties." />
      <p className="actions">
        <ExportButton domain="parties" label="Export contacts (CSV)" />
        <ExportButton
          domain="parties"
          params={{ layout: 'contacts' }}
          label="Export contact persons (CSV)"
        />
      </p>
      <Card
        actions={
          <Can permission={Permission.PartiesCreate}>
            <Link className="button" to="/parties/new">
              New contact
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
            label="Search"
            value={filters.search}
            placeholder="Name, reference, email or TIN"
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <div className="field">
            <label htmlFor="party-role-filter">Role</label>
            <select
              id="party-role-filter"
              value={filters.role}
              onChange={(e) => setFilters({ ...filters, role: e.target.value })}
            >
              <option value="">All roles</option>
              {PARTY_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="party-status-filter">Status</label>
            <select
              id="party-status-filter"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
          </div>
          <Button type="submit">Search</Button>
        </form>
      </Card>
      <Card>
        {list.isPending ? (
          <Spinner label="Loading contacts" />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : items.length === 0 ? (
          <p className="muted">No contacts found.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Reference</th>
                <th>Roles</th>
                <th>Email</th>
                <th>Status</th>
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
                      <span className="badge badge--archived">archived</span>
                    ) : (
                      'Active'
                    )}
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
            Load more
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
          <label htmlFor="party-kind">Kind</label>
          <select
            id="party-kind"
            value={draft.kind}
            onChange={(e) => onChange({ ...draft, kind: e.target.value as PartyKind })}
          >
            <option value="organization">Organization</option>
            <option value="individual">Individual</option>
          </select>
        </div>
        {text('displayName', 'Display name')}
        {draft.kind === 'organization' ? text('companyName', 'Company name') : null}
        {draft.kind === 'individual' ? (
          <>
            {text('firstName', 'First name')}
            {text('lastName', 'Last name')}
          </>
        ) : null}
        {text('reference', 'Reference')}
        {text('tin', 'TIN')}
        {text('email', 'Email')}
        {text('phone', 'Phone')}
        {text('website', 'Website')}
      </div>
      <div className="choice-grid">
        <div>
          <strong>Roles</strong>
          {PARTY_ROLES.map((role) => (
            <label key={role} className="checkbox">
              <input
                type="checkbox"
                checked={draft.roles.includes(role)}
                onChange={() =>
                  onChange({
                    ...draft,
                    roles: draft.roles.includes(role)
                      ? draft.roles.filter((r) => r !== role)
                      : [...draft.roles, role],
                  })
                }
              />{' '}
              {ROLE_LABELS[role]}
            </label>
          ))}
        </div>
      </div>
      <TextField
        label="Notes"
        value={draft.notes}
        onChange={(e) => onChange({ ...draft, notes: e.target.value })}
      />
    </>
  );
}

function DuplicateNotice({ warnings }: { warnings: DuplicateWarning[] | undefined }) {
  const match = warnings?.find((w) => w.code === 'POSSIBLE_DUPLICATE');
  if (!match) return null;
  return (
    <Alert tone="info">
      Possible duplicate: {match.message}{' '}
      {match.matches.map((m, i) => (
        <span key={m.partyId}>
          {i > 0 ? ', ' : ''}
          <Link to={`/parties/${m.partyId}`}>view match</Link> ({m.matchedOn.join(', ')})
        </span>
      ))}
    </Alert>
  );
}

export function NewPartyPage() {
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
      <PageHeader title="New contact" />
      <Card>
        <form className="form" onSubmit={submit} noValidate>
          <HeaderFields draft={draft} onChange={setDraft} error={create.error} />
          <ErrorAlert error={create.error?.issues.length ? null : create.error} />
          <div className="actions">
            <Button type="submit" busy={create.isPending}>
              Create contact
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
    <Card title="Contact persons">
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Job title</th>
            <th>Email</th>
            <th>Phone</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {party.contacts.map((c) => (
            <tr key={c.id}>
              <td>
                {[c.firstName, c.lastName].filter(Boolean).join(' ')}
                {c.isPrimary ? <span className="badge"> primary</span> : null}
                {c.receivesDocuments ? <span className="muted"> · receives documents</span> : null}
              </td>
              <td>{c.jobTitle}</td>
              <td>{c.email}</td>
              <td>{c.phone}</td>
              <td className="actions">
                {canUpdate && !c.isPrimary ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      change.mutate({ contact: c, action: 'primary' }, { onSuccess: onSaved })
                    }
                  >
                    Make primary
                  </Button>
                ) : null}
                {canUpdate ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      change.mutate({ contact: c, action: 'remove' }, { onSuccess: onSaved })
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorAlert error={change.error} />
      {canUpdate ? (
        <form
          className="form form--inline"
          aria-label="Add contact person"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined, { onSuccess: (p) => (setForm(empty), onSaved(p)) });
          }}
        >
          <TextField
            label="Contact first name"
            value={form.firstName}
            onChange={(e) => setForm({ ...form, firstName: e.target.value })}
            error={add.error?.fieldError('firstName')}
          />
          <TextField
            label="Contact last name"
            value={form.lastName}
            onChange={(e) => setForm({ ...form, lastName: e.target.value })}
          />
          <TextField
            label="Contact job title"
            value={form.jobTitle}
            onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
          />
          <TextField
            label="Contact email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            error={add.error?.fieldError('email')}
          />
          <TextField
            label="Contact phone"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.isPrimary}
              onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })}
            />{' '}
            Primary
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.receivesDocuments}
              onChange={(e) => setForm({ ...form, receivesDocuments: e.target.checked })}
            />{' '}
            Receives documents
          </label>
          <Button type="submit" busy={add.isPending}>
            Add contact person
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
    <Card title="Addresses">
      <table className="table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Address</th>
            <th>Country</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {party.addresses.map((a) => (
            <tr key={a.id}>
              <td>
                {a.kind === 'billing' ? 'Billing' : 'Delivery'}
                {a.isDefault ? <span className="badge"> default</span> : null}
              </td>
              <td>
                {[a.label, a.line1, a.line2, a.city, a.region, a.postalCode]
                  .filter(Boolean)
                  .join(', ')}
              </td>
              <td>{a.countryCode}</td>
              <td className="actions">
                {canUpdate && !a.isDefault ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      change.mutate({ address: a, action: 'default' }, { onSuccess: onSaved })
                    }
                  >
                    Make default
                  </Button>
                ) : null}
                {canUpdate ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      change.mutate({ address: a, action: 'remove' }, { onSuccess: onSaved })
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorAlert error={change.error} />
      {canUpdate ? (
        <form
          className="form form--inline"
          aria-label="Add address"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined, { onSuccess: (p) => (setForm(empty), onSaved(p)) });
          }}
        >
          <div className="field">
            <label htmlFor="address-kind">Address kind</label>
            <select
              id="address-kind"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as PartyAddress['kind'] })}
            >
              <option value="billing">Billing</option>
              <option value="delivery">Delivery</option>
            </select>
          </div>
          <TextField
            label="Address label"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
          <TextField
            label="Address line 1"
            value={form.line1}
            onChange={(e) => setForm({ ...form, line1: e.target.value })}
            error={add.error?.fieldError('line1')}
          />
          <TextField
            label="Address line 2"
            value={form.line2}
            onChange={(e) => setForm({ ...form, line2: e.target.value })}
          />
          <TextField
            label="City"
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
          />
          <TextField
            label="Region / atoll"
            value={form.region}
            onChange={(e) => setForm({ ...form, region: e.target.value })}
          />
          <TextField
            label="Postal code"
            value={form.postalCode}
            onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
          />
          <CountrySelect
            id="address-country"
            label="Country"
            value={form.countryCode}
            onChange={(countryCode) => setForm({ ...form, countryCode })}
            error={add.error?.fieldError('countryCode')}
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
            />{' '}
            Default
          </label>
          <Button type="submit" busy={add.isPending}>
            Add address
          </Button>
          <ErrorAlert error={add.error?.issues.length ? null : add.error} />
        </form>
      ) : null}
    </Card>
  );
}

export function PartyDetailPage() {
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

  if (party.isPending) return <Spinner label="Loading contact" />;
  if (party.isError) return <ErrorAlert error={party.error} />;
  const p = party.data;
  return (
    <>
      <PageHeader
        title={p.displayName}
        description={p.roles.map((r) => ROLE_LABELS[r]).join(', ') || 'No roles'}
      />
      {p.status === 'ARCHIVED' ? <Alert tone="info">This contact is archived.</Alert> : null}
      <DuplicateNotice warnings={warnings} />
      <Card
        title="Details"
        actions={
          <>
            {canUpdate && !editing ? (
              <Button
                variant="secondary"
                onClick={() => (setDraft(headerFrom(p)), setEditing(true))}
              >
                Edit
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
                {p.status === 'ACTIVE' ? 'Archive' : 'Restore'}
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
                  Reload
                </Button>
              </Alert>
            ) : (
              <ErrorAlert error={update.error?.issues.length ? null : update.error} />
            )}
            <div className="actions">
              <Button type="submit" busy={update.isPending}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <dl className="details">
            <dt>Kind</dt>
            <dd>{p.kind === 'organization' ? 'Organization' : 'Individual'}</dd>
            {p.companyName ? (
              <>
                <dt>Company</dt>
                <dd>{p.companyName}</dd>
              </>
            ) : null}
            {p.reference ? (
              <>
                <dt>Reference</dt>
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
                <dt>Email</dt>
                <dd>{p.email}</dd>
              </>
            ) : null}
            {p.phone ? (
              <>
                <dt>Phone</dt>
                <dd>{p.phone}</dd>
              </>
            ) : null}
            {p.website ? (
              <>
                <dt>Website</dt>
                <dd>{p.website}</dd>
              </>
            ) : null}
            {p.notes ? (
              <>
                <dt>Notes</dt>
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
