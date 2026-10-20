import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { formatAmount } from '../../shared/money';
import { useT } from '../../i18n/i18n';

/**
 * Groups of legal entities (FP-24, migration 0085). A legal entity is a separate organization;
 * a group links organizations the same person owns and shows them side by side. It does not
 * consolidate: figures stay in each organization's own currency and are never added together.
 */

interface Group {
  id: string;
  name: string;
  organizations: { organizationId: string; name: string | null; isOwner: boolean }[];
}
interface OverviewRow {
  organizationId: string;
  name: string | null;
  status: 'ok' | 'no_access' | 'unavailable';
  baseCurrency?: string;
  grossProfit?: string | null;
  netProfit?: string | null;
  reason?: string;
}
interface Overview {
  from: string;
  to: string;
  organizations: OverviewRow[];
  note: string;
}
interface MyOrganization {
  id: string;
  name: string;
}

function GroupCard({
  group,
  mine,
  onChanged,
}: {
  group: Group;
  mine: MyOrganization[];
  onChanged: () => void;
}) {
  const t = useT();
  const sensitive = useSensitiveAction();
  const year = new Date().getFullYear();
  const [organizationId, setOrganizationId] = useState('');
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [overview, setOverview] = useState<Overview | null>(null);
  const add = useApiMutation(() =>
    sensitive(() => api.post(`/organization-groups/${group.id}/organizations`, { organizationId })),
  );
  const remove = useApiMutation((id: string) =>
    sensitive(() => api.delete(`/organization-groups/${group.id}/organizations/${id}`)),
  );
  const drop = useApiMutation(() =>
    sensitive(() => api.delete(`/organization-groups/${group.id}`)),
  );
  const load = useApiMutation(() =>
    api.get<Overview>(`/organization-groups/${group.id}/overview?from=${from}&to=${to}`),
  );
  const inGroup = new Set(group.organizations.map((o) => o.organizationId));
  const candidates = mine.filter((o) => !inGroup.has(o.id));
  return (
    <Card title={group.name}>
      {group.organizations.length === 0 ? (
        <p className="muted">{t('groups.empty')}</p>
      ) : (
        <ul>
          {group.organizations.map((o) => (
            <li key={o.organizationId}>
              {o.name ?? t('groups.noAccessName')}{' '}
              <Button
                variant="ghost"
                aria-label={t('groups.removeFrom', {
                  name: o.name ?? o.organizationId,
                  group: group.name,
                })}
                onClick={() => remove.mutate(o.organizationId, { onSuccess: onChanged })}
              >
                {t('common.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="filters">
        <div className="field">
          <label htmlFor={`add-${group.id}`}>{t('groups.addLabel')}</label>
          <select
            id={`add-${group.id}`}
            value={organizationId}
            onChange={(e) => setOrganizationId(e.target.value)}
          >
            <option value="">{t('common.choose')}</option>
            {candidates.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <Button
          disabled={!organizationId}
          busy={add.isPending}
          onClick={() =>
            add.mutate(undefined, {
              onSuccess: () => {
                setOrganizationId('');
                onChanged();
              },
            })
          }
        >
          {t('groups.add')}
        </Button>
      </div>
      <ErrorAlert error={add.error ?? remove.error ?? drop.error} />
      <div className="filters">
        <TextField
          label={t('groups.from')}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextField
          label={t('groups.to')}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <Button
          variant="secondary"
          busy={load.isPending}
          onClick={() => load.mutate(undefined, { onSuccess: setOverview })}
        >
          {t('groups.show')}
        </Button>
      </div>
      <ErrorAlert error={load.error} />
      {overview ? (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>{t('groups.organization')}</th>
                <th>{t('groups.currency')}</th>
                <th className="num">{t('groups.grossProfit')}</th>
                <th className="num">{t('groups.netProfit')}</th>
              </tr>
            </thead>
            <tbody>
              {overview.organizations.map((r) => (
                <tr key={r.organizationId}>
                  <td>{r.name ?? t('groups.unknown')}</td>
                  {r.status === 'ok' ? (
                    <>
                      <td>{r.baseCurrency}</td>
                      <td className="num">{formatAmount(r.grossProfit ?? '0', r.baseCurrency!)}</td>
                      <td className="num">{formatAmount(r.netProfit ?? '0', r.baseCurrency!)}</td>
                    </>
                  ) : (
                    <td colSpan={3} className="muted">
                      {r.status === 'no_access'
                        ? t('groups.noReports')
                        : t('groups.notAvailable', {
                            reason: r.reason ?? t('groups.notSetUp'),
                          })}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <Alert tone="info">{overview.note}</Alert>
        </>
      ) : null}
      <Button
        variant="ghost"
        aria-label={t('groups.deleteNamed', { name: group.name })}
        busy={drop.isPending}
        onClick={() => drop.mutate(undefined, { onSuccess: onChanged })}
      >
        {t('groups.delete')}
      </Button>
    </Card>
  );
}

export function GroupsPage() {
  const t = useT();
  const { activeOrganization } = useAuth();
  const queryClient = useQueryClient();
  const key = activeOrganization?.id ?? 'none';
  const groups = useQuery({
    queryKey: ['organization-groups', key],
    queryFn: () => api.get<Group[]>('/organization-groups'),
  });
  const orgs = useQuery({
    queryKey: ['my-organizations', key],
    queryFn: () => api.get<MyOrganization[]>('/organizations'),
  });
  const [name, setName] = useState('');
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['organization-groups', key] });
  const create = useApiMutation(() => api.post('/organization-groups', { name: name.trim() }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: () => {
        setName('');
        refresh();
      },
    });
  };
  return (
    <>
      <PageHeader title={t('groups.title')} description={t('groups.description')} />
      {groups.isPending ? <Spinner /> : null}
      <ErrorAlert error={groups.error} />
      {(groups.data ?? []).map((g) => (
        <GroupCard key={g.id} group={g} mine={orgs.data ?? []} onChanged={refresh} />
      ))}
      <Card title={t('groups.new')}>
        <form className="form" onSubmit={submit} noValidate>
          <TextField
            label={t('groups.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <ErrorAlert error={create.error} />
          <Button type="submit" busy={create.isPending} disabled={!name.trim()}>
            {t('groups.create')}
          </Button>
        </form>
      </Card>
    </>
  );
}
