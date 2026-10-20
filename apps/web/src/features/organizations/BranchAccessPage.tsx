import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import type { Member } from '../../services/types';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { useT } from '../../i18n/i18n';

/**
 * Branch-scoped access (FP-24, migration 0084). An administrator limits a member to some branches
 * (dimension values). The database then shows that member only invoices and bills tagged with
 * them, and removes every permission outside invoices, bills, customers, vendors and dimensions.
 * Owners cannot be limited and nobody can limit themself; the server enforces both.
 */

interface DimensionType {
  id: string;
  code: string;
  name: string;
  status: string;
  values: { id: string; code: string; name: string; status: string }[];
}
interface Scope {
  membershipId: string;
  branches: { id: string; code: string | null; name: string | null }[];
}

function MemberRow({
  member,
  scope,
  types,
  mine,
  onChanged,
}: {
  member: Member;
  scope: Scope | undefined;
  types: DimensionType[];
  mine: boolean;
  onChanged: () => void;
}) {
  const t = useT();
  const sensitive = useSensitiveAction();
  const current = (scope?.branches ?? []).map((b) => b.id);
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<string[]>(current);
  const save = useApiMutation((ids: string[]) =>
    sensitive(() =>
      api.put(`/organizations/current/members/${member.membershipId}/branch-scope`, {
        dimensionValueIds: ids,
      }),
    ),
  );
  const locked = member.isOwner || mine || member.status !== 'active';
  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const name = member.displayName ?? member.email ?? member.membershipId;
  return (
    <tr>
      <td>{name}</td>
      <td>
        {scope && scope.branches.length > 0
          ? scope.branches.map((b) => b.name ?? b.code).join(', ')
          : t('branchAccess.all')}
        {editing ? (
          <fieldset className="form">
            <legend>{t('branchAccess.branchesFor', { name })}</legend>
            {types.flatMap((t) =>
              t.values
                .filter((v) => v.status === 'ACTIVE')
                .map((v) => (
                  <label key={v.id} className="checkbox">
                    <input
                      type="checkbox"
                      checked={chosen.includes(v.id)}
                      onChange={() => toggle(v.id)}
                    />{' '}
                    {t.name}: {v.name}
                  </label>
                )),
            )}
            <small className="field__hint">{t('branchAccess.untickHint')}</small>
            <ErrorAlert error={save.error} />
            <div>
              <Button
                busy={save.isPending}
                onClick={() =>
                  save.mutate(chosen, {
                    onSuccess: () => {
                      setEditing(false);
                      onChanged();
                    },
                  })
                }
              >
                {t('branchAccess.save')}
              </Button>{' '}
              <Button variant="secondary" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </fieldset>
        ) : null}
      </td>
      <td>
        {locked ? (
          <span className="muted">
            {member.isOwner
              ? t('branchAccess.owner')
              : mine
                ? t('branchAccess.you')
                : t('branchAccess.inactive')}
          </span>
        ) : (
          <Can permission={Permission.MembersManage}>
            {!editing ? (
              <Button
                variant="secondary"
                aria-label={t('branchAccess.editFor', { name })}
                onClick={() => {
                  setChosen(current);
                  setEditing(true);
                }}
              >
                {t('branchAccess.edit')}
              </Button>
            ) : null}
          </Can>
        )}
      </td>
    </tr>
  );
}

export function BranchAccessPage() {
  const t = useT();
  const { activeOrganization } = useAuth();
  const queryClient = useQueryClient();
  const organizationId = activeOrganization?.id ?? 'none';
  const members = useQuery({
    queryKey: ['members', organizationId],
    queryFn: () => api.get<Member[]>('/organizations/current/members'),
  });
  const scopes = useQuery({
    queryKey: ['branch-scopes', organizationId],
    queryFn: () => api.get<Scope[]>('/organizations/current/branch-scopes'),
  });
  const types = useQuery({
    queryKey: ['dimension-types', organizationId],
    queryFn: () => api.get<DimensionType[]>('/accounting/dimensions'),
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['branch-scopes', organizationId] });
  const byMember = new Map((scopes.data ?? []).map((s) => [s.membershipId, s]));
  const list = types.data ?? [];
  const noValues = types.isSuccess && list.every((t) => t.values.length === 0);
  return (
    <>
      <PageHeader title={t('branchAccess.title')} description={t('branchAccess.description')} />
      {members.isPending || scopes.isPending || types.isPending ? <Spinner /> : null}
      <ErrorAlert error={members.error ?? scopes.error ?? types.error} />
      {noValues ? <Alert tone="info">{t('branchAccess.noValues')}</Alert> : null}
      <Card title={t('branchAccess.members')}>
        {members.data ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('branchAccess.member')}</th>
                <th>{t('branchAccess.branches')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.data.map((m) => (
                <MemberRow
                  key={`${m.membershipId}-${(byMember.get(m.membershipId)?.branches ?? []).map((b) => b.id).join()}`}
                  member={m}
                  scope={byMember.get(m.membershipId)}
                  types={list}
                  mine={m.membershipId === activeOrganization?.membershipId}
                  onChanged={refresh}
                />
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </>
  );
}
