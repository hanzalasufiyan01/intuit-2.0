import { useState, type FormEvent, type ReactNode } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import type { MfaRequirementReason, SessionState } from '../../services/types';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { TextField } from '../../shared/ui/TextField';
import { MfaEnrollment } from './MfaEnrollment';

const REASON_TEXT: Record<MfaRequirementReason, string> = {
  owner: 'you own this organization',
  privileged_permission: 'your role can manage members, roles, approvals or accounting setup',
  organization_policy: 'this organization requires it for all members',
};

export function describeReasons(reasons: MfaRequirementReason[]): string {
  return reasons.map((r) => REASON_TEXT[r]).join(', and ');
}

/** An in-session code for an organization that does not accept remembered devices (S7-36). */
function VerifyInSession() {
  const { updateSession } = useAuth();
  const [method, setMethod] = useState<'totp' | 'recovery_code'>('totp');
  const [code, setCode] = useState('');
  const mutation = useApiMutation((input: { method: string; code: string }) =>
    api.post<SessionState>('/auth/mfa/step-up', input),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate(
      { method, code },
      { onSuccess: (next) => updateSession(next), onError: () => setCode('') },
    );
  };
  return (
    <form className="form" onSubmit={submit} noValidate>
      <ErrorAlert error={mutation.error} />
      <TextField
        label={method === 'totp' ? 'Code from your authenticator app' : 'Recovery code'}
        inputMode={method === 'totp' ? 'numeric' : 'text'}
        autoComplete={method === 'totp' ? 'one-time-code' : 'off'}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoFocus
      />
      <div className="actions">
        <Button type="submit" busy={mutation.isPending}>
          Verify
        </Button>
        <button
          type="button"
          className="link-button"
          onClick={() => setMethod(method === 'totp' ? 'recovery_code' : 'totp')}
        >
          {method === 'totp' ? 'Use a recovery code instead' : 'Use your authenticator app'}
        </button>
      </div>
    </form>
  );
}

/**
 * Server-enforced MFA, shown in the UI (S7-27 B/C): when the active organization requires MFA and
 * this session has not satisfied it, the page is replaced by the setup or verification step. The
 * API refuses every organization request meanwhile, so this is guidance, not the control.
 */
export function MfaGate({ children }: { children: ReactNode }) {
  const { session, refreshSession } = useAuth();
  const org = session?.mfa.activeOrganization;
  if (!session || !org || !org.required || org.satisfied) return <>{children}</>;
  const why = describeReasons(org.reasons);
  if (!session.mfa.enrolled) {
    return (
      <>
        <PageHeader
          title="Set up two-step verification"
          description={`${session.activeOrganization?.name ?? 'This organization'} requires two-step verification because ${why}.`}
        />
        <Card title="Authenticator app">
          <MfaEnrollment onFinished={() => void refreshSession()} />
        </Card>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Verify it’s you"
        description={`${session.activeOrganization?.name ?? 'This organization'} does not accept remembered browsers. Enter a code to continue.`}
      />
      <Card title="Verification code">
        <Alert tone="info">Two-step verification is required because {why}.</Alert>
        <VerifyInSession />
      </Card>
    </>
  );
}
