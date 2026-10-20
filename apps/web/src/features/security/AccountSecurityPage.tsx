import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { useT } from '../../i18n/i18n';
import { api } from '../../services/api-client';
import type { MfaStatus, TrustedDevice } from '../../services/types';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { describeReasons } from './MfaGate';
import { MfaEnrollment } from './MfaEnrollment';
import { RecoveryCodesDisplay } from './RecoveryCodes';

const MFA_KEY = ['account-security', 'mfa'] as const;
const DEVICES_KEY = ['account-security', 'devices'] as const;
const SESSIONS_KEY = ['account-security', 'sessions'] as const;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

interface ActiveSession {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

function TwoStepCard({ status }: { status: MfaStatus }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { refreshSession } = useAuth();
  const sensitive = useSensitiveAction();
  const [replacing, setReplacing] = useState(false);
  const factor = status.factors[0];
  const disable = useApiMutation((factorId: string) =>
    sensitive(() => api.post('/auth/mfa/totp/disable', { factorId })),
  );
  const refresh = () => {
    setReplacing(false);
    void queryClient.invalidateQueries({ queryKey: ['account-security'] });
    void refreshSession();
  };

  if (!factor) {
    return (
      <Card title={t('account.twoStep.title')}>
        <p>{t('account.twoStep.off')}</p>
        <MfaEnrollment onFinished={refresh} />
      </Card>
    );
  }
  return (
    <Card title={t('account.twoStep.title')}>
      <p>
        <span className="badge badge--success">{t('account.twoStep.on')}</span>{' '}
        {t('account.twoStep.summary', {
          activated: when(factor.activatedAt),
          lastUsed: when(factor.lastUsedAt),
        })}
      </p>
      {status.requiredBy.length > 0 ? (
        <p className="muted">
          {t('account.twoStep.requiredIn', {
            list: status.requiredBy
              .map((o) => `${o.name} (${describeReasons(o.reasons, t)})`)
              .join('; '),
          })}
        </p>
      ) : null}
      {replacing ? (
        <MfaEnrollment replacing onFinished={refresh} />
      ) : (
        <div className="actions">
          <Button variant="secondary" onClick={() => setReplacing(true)}>
            {t('account.twoStep.replace')}
          </Button>
          {status.canDisable ? (
            <Button
              variant="secondary"
              busy={disable.isPending}
              onClick={() => disable.mutate(factor.id, { onSuccess: refresh })}
            >
              {t('account.twoStep.turnOff')}
            </Button>
          ) : null}
        </div>
      )}
      <ErrorAlert error={disable.error} />
    </Card>
  );
}

function RecoveryCodesCard({ status }: { status: MfaStatus }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { refreshSession } = useAuth();
  const sensitive = useSensitiveAction();
  const [codes, setCodes] = useState<string[] | null>(null);
  const regenerate = useApiMutation(() =>
    sensitive(() => api.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', {})),
  );
  if (status.factors.length === 0) return null;
  const remaining = status.recoveryCodes.remaining;
  return (
    <Card title={t('account.recovery.title')}>
      {codes ? (
        <RecoveryCodesDisplay
          codes={codes}
          doneLabel={t('account.recovery.done')}
          onDone={() => {
            setCodes(null);
            void queryClient.invalidateQueries({ queryKey: MFA_KEY });
            void refreshSession();
          }}
        />
      ) : (
        <>
          <p>
            {t(remaining === 1 ? 'account.recovery.unusedOne' : 'account.recovery.unusedMany', {
              count: remaining,
            })}
            {status.recoveryCodes.issuedAt
              ? t('account.recovery.issued', { date: when(status.recoveryCodes.issuedAt) })
              : ''}
            .
          </p>
          {remaining <= 3 ? (
            <Alert tone={remaining === 0 ? 'error' : 'info'}>
              {remaining === 0 ? t('account.recovery.none') : t('account.recovery.low')}
            </Alert>
          ) : null}
          <ErrorAlert error={regenerate.error} />
          <Button
            variant="secondary"
            busy={regenerate.isPending}
            onClick={() =>
              regenerate.mutate(undefined, { onSuccess: (data) => setCodes(data.recoveryCodes) })
            }
          >
            {t('account.recovery.generate')}
          </Button>
          <p className="muted">{t('account.recovery.generateNote')}</p>
        </>
      )}
    </Card>
  );
}

function DevicesCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const devices = useQuery({
    queryKey: DEVICES_KEY,
    queryFn: () => api.get<TrustedDevice[]>('/auth/trusted-devices'),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
  const revoke = useApiMutation((id: string) => api.delete(`/auth/trusted-devices/${id}`));
  const revokeAll = useApiMutation(() => sensitive(() => api.delete('/auth/trusted-devices')));

  return (
    <Card title={t('account.devices.title')}>
      <p className="muted">{t('account.devices.note')}</p>
      <ErrorAlert error={revoke.error ?? revokeAll.error} />
      {devices.isPending ? (
        <Spinner label={t('account.devices.loading')} />
      ) : devices.isError ? (
        <ErrorAlert error={devices.error} />
      ) : devices.data.length === 0 ? (
        <p className="muted">{t('account.devices.none')}</p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>{t('account.browser')}</th>
                <th>{t('account.devices.lastUsed')}</th>
                <th>{t('account.devices.expires')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.data.map((device) => (
                <tr key={device.id}>
                  <td>
                    {device.userAgent ?? t('account.unknownBrowser')}
                    {device.current ? (
                      <span className="badge">{t('account.devices.thisBrowser')}</span>
                    ) : null}
                  </td>
                  <td>{when(device.lastUsedAt)}</td>
                  <td>{when(device.expiresAt)}</td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => revoke.mutate(device.id, { onSuccess: refresh })}
                    >
                      {t('account.devices.forget')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button
            variant="secondary"
            busy={revokeAll.isPending}
            onClick={() => revokeAll.mutate(undefined, { onSuccess: refresh })}
          >
            {t('account.devices.forgetAll')}
          </Button>
        </>
      )}
    </Card>
  );
}

function SessionsCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const sessions = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => api.get<ActiveSession[]>('/auth/sessions'),
  });
  const revoke = useApiMutation((id: string) =>
    sensitive(() => api.delete(`/auth/sessions/${id}`)),
  );
  return (
    <Card title={t('account.sessions.title')}>
      <ErrorAlert error={revoke.error} />
      {sessions.isPending ? (
        <Spinner label={t('account.sessions.loading')} />
      ) : sessions.isError ? (
        <ErrorAlert error={sessions.error} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('account.browser')}</th>
              <th>{t('account.sessions.lastActive')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.data.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.userAgent ?? t('account.unknownBrowser')}
                  {s.current ? (
                    <span className="badge">{t('account.sessions.thisSession')}</span>
                  ) : null}
                </td>
                <td>{when(s.lastSeenAt)}</td>
                <td>
                  {s.current ? null : (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        revoke.mutate(s.id, {
                          onSuccess: () =>
                            void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY }),
                        })
                      }
                    >
                      {t('account.sessions.signOut')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** The signed-in user's own security settings (S7-42, S7-43). */
export function AccountSecurityPage() {
  const t = useT();
  const status = useQuery({ queryKey: MFA_KEY, queryFn: () => api.get<MfaStatus>('/auth/mfa') });
  return (
    <>
      <PageHeader title={t('account.title')} description={t('account.description')} />
      {status.isPending ? (
        <Spinner label={t('account.loading')} />
      ) : status.isError ? (
        <ErrorAlert error={status.error} />
      ) : (
        <>
          <TwoStepCard status={status.data} />
          <RecoveryCodesCard status={status.data} />
          {status.data.factors.length > 0 ? <DevicesCard /> : null}
        </>
      )}
      <SessionsCard />
    </>
  );
}
