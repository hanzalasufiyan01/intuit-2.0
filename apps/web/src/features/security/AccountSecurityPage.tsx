import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
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
      <Card title="Two-step verification">
        <p>Off. Add an authenticator app so a password alone cannot open your account.</p>
        <MfaEnrollment onFinished={refresh} />
      </Card>
    );
  }
  return (
    <Card title="Two-step verification">
      <p>
        <span className="badge badge--success">On</span> Authenticator app, set up{' '}
        {when(factor.activatedAt)}; last used {when(factor.lastUsedAt)}.
      </p>
      {status.requiredBy.length > 0 ? (
        <p className="muted">
          Required for you in{' '}
          {status.requiredBy.map((o) => `${o.name} (${describeReasons(o.reasons)})`).join('; ')}.
        </p>
      ) : null}
      {replacing ? (
        <MfaEnrollment replacing onFinished={refresh} />
      ) : (
        <div className="actions">
          <Button variant="secondary" onClick={() => setReplacing(true)}>
            Replace authenticator
          </Button>
          {status.canDisable ? (
            <Button
              variant="secondary"
              busy={disable.isPending}
              onClick={() => disable.mutate(factor.id, { onSuccess: refresh })}
            >
              Turn off
            </Button>
          ) : null}
        </div>
      )}
      <ErrorAlert error={disable.error} />
    </Card>
  );
}

function RecoveryCodesCard({ status }: { status: MfaStatus }) {
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
    <Card title="Recovery codes">
      {codes ? (
        <RecoveryCodesDisplay
          codes={codes}
          doneLabel="Done"
          onDone={() => {
            setCodes(null);
            void queryClient.invalidateQueries({ queryKey: MFA_KEY });
            void refreshSession();
          }}
        />
      ) : (
        <>
          <p>
            {remaining} unused recovery {remaining === 1 ? 'code' : 'codes'}
            {status.recoveryCodes.issuedAt ? `, issued ${when(status.recoveryCodes.issuedAt)}` : ''}
            .
          </p>
          {remaining <= 3 ? (
            <Alert tone={remaining === 0 ? 'error' : 'info'}>
              {remaining === 0
                ? 'You have no recovery codes left. Generate new ones now.'
                : 'You are running low on recovery codes. Generate a new set.'}
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
            Generate new codes
          </Button>
          <p className="muted">Generating new codes makes the old ones stop working.</p>
        </>
      )}
    </Card>
  );
}

function DevicesCard() {
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
    <Card title="Remembered browsers">
      <p className="muted">
        A remembered browser skips the verification code at sign-in for up to 30 days. Your password
        is still required, and security changes still ask for a code.
      </p>
      <ErrorAlert error={revoke.error ?? revokeAll.error} />
      {devices.isPending ? (
        <Spinner label="Loading remembered browsers" />
      ) : devices.isError ? (
        <ErrorAlert error={devices.error} />
      ) : devices.data.length === 0 ? (
        <p className="muted">No remembered browsers.</p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Browser</th>
                <th>Last used</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.data.map((device) => (
                <tr key={device.id}>
                  <td>
                    {device.userAgent ?? 'Unknown browser'}
                    {device.current ? <span className="badge">This browser</span> : null}
                  </td>
                  <td>{when(device.lastUsedAt)}</td>
                  <td>{when(device.expiresAt)}</td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => revoke.mutate(device.id, { onSuccess: refresh })}
                    >
                      Forget
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
            Forget all browsers
          </Button>
        </>
      )}
    </Card>
  );
}

function SessionsCard() {
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
    <Card title="Signed-in sessions">
      <ErrorAlert error={revoke.error} />
      {sessions.isPending ? (
        <Spinner label="Loading sessions" />
      ) : sessions.isError ? (
        <ErrorAlert error={sessions.error} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Browser</th>
              <th>Last active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.data.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.userAgent ?? 'Unknown browser'}
                  {s.current ? <span className="badge">This session</span> : null}
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
                      Sign out
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
  const status = useQuery({ queryKey: MFA_KEY, queryFn: () => api.get<MfaStatus>('/auth/mfa') });
  return (
    <>
      <PageHeader
        title="Account security"
        description="Two-step verification, recovery codes, remembered browsers and sessions."
      />
      {status.isPending ? (
        <Spinner label="Loading security settings" />
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
