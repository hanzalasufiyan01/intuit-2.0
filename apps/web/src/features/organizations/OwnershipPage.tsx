import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { api } from '../../services/api-client';
import type { Member, Role } from '../../services/types';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { useT } from '../../i18n/i18n';

/**
 * Ownership transfer (master context section 8, ADR 0012). The Owner offers ownership to another
 * member; the member accepts or declines. Both sides confirm their password and a second factor
 * (the shared re-authentication prompt asks for them). Until accepted, nothing changes.
 */

interface Person {
  membershipId: string;
  email: string | null;
  displayName: string | null;
}
interface Transfer {
  id: string;
  status: 'initiated' | 'verified' | 'accepted' | 'completed' | 'cancelled' | 'expired';
  from: Person;
  to: Person;
  replacementRole: { id: string; name: string | null };
  initiatedAt: string;
  completedAt: string | null;
  cancelReason: string | null;
  expiresAt: string;
}

const personName = (p: Person) => p.displayName ?? p.email ?? p.membershipId;
const OPEN = ['initiated', 'verified', 'accepted'];
// Stored on the transfer when no reason is typed: data, not screen text, so never translated.
const DEFAULT_DECLINE_REASON = 'Declined';
const DEFAULT_CANCEL_REASON = 'Withdrawn';

function StartForm({ organizationId, onDone }: { organizationId: string; onDone: () => void }) {
  const t = useT();
  const sensitive = useSensitiveAction();
  const members = useQuery({
    queryKey: ['members', organizationId],
    queryFn: () => api.get<Member[]>('/organizations/current/members'),
  });
  const roles = useQuery({
    queryKey: ['roles', organizationId],
    queryFn: () => api.get<Role[]>('/organizations/current/roles'),
  });
  const [to, setTo] = useState('');
  const [roleId, setRoleId] = useState('');
  const start = useApiMutation(() =>
    sensitive(() =>
      api.post<Transfer>('/organizations/current/ownership-transfers', {
        toMembershipId: to,
        replacementRoleId: roleId,
      }),
    ),
  );
  const candidates = (members.data ?? []).filter((m) => !m.isOwner && m.status === 'active');
  const keepRoles = (roles.data ?? []).filter((r) => !r.isOwner);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    start.mutate(undefined, { onSuccess: onDone });
  };
  if (members.isError || roles.isError) {
    return <Alert>{t('ownership.needPermission')}</Alert>;
  }
  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="owner-to">{t('ownership.newOwner')}</label>
        <select id="owner-to" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">{t('ownership.chooseMember')}</option>
          {candidates.map((m) => (
            <option key={m.membershipId} value={m.membershipId}>
              {m.displayName ?? m.email}
            </option>
          ))}
        </select>
        <small className="field__hint">{t('ownership.mfaHint')}</small>
      </div>
      <div className="field">
        <label htmlFor="owner-role">{t('ownership.roleAfter')}</label>
        <select id="owner-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">{t('ownership.chooseRole')}</option>
          {keepRoles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <ErrorAlert error={start.error} />
      <Button type="submit" busy={start.isPending} disabled={!to || !roleId}>
        {t('ownership.offer')}
      </Button>
    </form>
  );
}

function TransferRow({
  transfer,
  mine,
  isOwner,
  onChanged,
}: {
  transfer: Transfer;
  mine: boolean;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const t = useT();
  const sensitive = useSensitiveAction();
  const [reason, setReason] = useState('');
  const accept = useApiMutation(() =>
    sensitive(() =>
      api.post(`/organizations/current/ownership-transfers/${transfer.id}/accept`, {}),
    ),
  );
  const decline = useApiMutation(() =>
    api.post(`/organizations/current/ownership-transfers/${transfer.id}/decline`, {
      reason: reason || DEFAULT_DECLINE_REASON,
    }),
  );
  const cancel = useApiMutation(() =>
    sensitive(() =>
      api.post(`/organizations/current/ownership-transfers/${transfer.id}/cancel`, {
        reason: reason || DEFAULT_CANCEL_REASON,
      }),
    ),
  );
  const open = OPEN.includes(transfer.status);
  return (
    <tr>
      <td>{personName(transfer.from)}</td>
      <td>{personName(transfer.to)}</td>
      <td>{transfer.replacementRole.name ?? '—'}</td>
      <td>
        {transfer.status}
        {transfer.cancelReason ? ` (${transfer.cancelReason})` : ''}
      </td>
      <td>{new Date(open ? transfer.expiresAt : transfer.initiatedAt).toLocaleString()}</td>
      <td>
        {open && mine ? (
          <>
            <Button
              busy={accept.isPending}
              onClick={() => accept.mutate(undefined, { onSuccess: onChanged })}
            >
              {t('ownership.accept')}
            </Button>{' '}
            <Button
              variant="secondary"
              busy={decline.isPending}
              onClick={() => decline.mutate(undefined, { onSuccess: onChanged })}
            >
              {t('ownership.decline')}
            </Button>
          </>
        ) : null}
        {open && isOwner ? (
          <>
            <input
              aria-label={t('ownership.reason')}
              placeholder={t('ownership.reason')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />{' '}
            <Button
              variant="secondary"
              busy={cancel.isPending}
              onClick={() => cancel.mutate(undefined, { onSuccess: onChanged })}
            >
              {t('ownership.cancel')}
            </Button>
          </>
        ) : null}
        <ErrorAlert error={accept.error ?? decline.error ?? cancel.error} />
      </td>
    </tr>
  );
}

export function OwnershipPage() {
  const t = useT();
  const { activeOrganization } = useAuth();
  const queryClient = useQueryClient();
  const organizationId = activeOrganization?.id ?? 'none';
  const query = useQuery({
    queryKey: ['ownership-transfers', organizationId],
    queryFn: () => api.get<{ items: Transfer[] }>('/organizations/current/ownership-transfers'),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['ownership-transfers', organizationId] });
    void queryClient.invalidateQueries({ queryKey: ['session'] });
    void queryClient.invalidateQueries({ queryKey: ['members', organizationId] });
  };
  const isOwner = activeOrganization?.isOwner === true;
  const items = query.data?.items ?? [];
  const hasOpen = items.some((t) => OPEN.includes(t.status));
  return (
    <>
      <PageHeader title={t('ownership.title')} description={t('ownership.description')} />
      {query.isPending ? <Spinner /> : null}
      <ErrorAlert error={query.error} />
      {isOwner && !hasOpen ? (
        <Card title={t('ownership.offer')}>
          <StartForm organizationId={organizationId} onDone={refresh} />
        </Card>
      ) : null}
      {isOwner && hasOpen ? <Alert tone="info">{t('ownership.openTransfer')}</Alert> : null}
      <Card title={t('ownership.transfers')}>
        {items.length === 0 && !query.isPending ? (
          <p className="muted">{t('ownership.none')}</p>
        ) : null}
        {items.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('ownership.from')}</th>
                <th>{t('ownership.to')}</th>
                <th>{t('ownership.previousBecomes')}</th>
                <th>{t('ownership.status')}</th>
                <th>{t('ownership.date')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <TransferRow
                  key={t.id}
                  transfer={t}
                  mine={t.to.membershipId === activeOrganization?.membershipId}
                  isOwner={isOwner}
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
