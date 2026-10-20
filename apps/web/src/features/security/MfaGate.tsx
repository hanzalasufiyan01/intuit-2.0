import { useState, type FormEvent, type ReactNode } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useT, type Translate } from '../../i18n/i18n';
import { api } from '../../services/api-client';
import type { MfaRequirementReason, SessionState } from '../../services/types';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { TextField } from '../../shared/ui/TextField';
import { MfaEnrollment } from './MfaEnrollment';

export function describeReasons(reasons: MfaRequirementReason[], t: Translate): string {
  return reasons.map((r) => t(`security.mfa.reason.${r}`)).join(t('security.mfa.reasonJoin'));
}

/** An in-session code for an organization that does not accept remembered devices (S7-36). */
function VerifyInSession() {
  const t = useT();
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
        label={
          method === 'totp' ? t('security.mfa.authenticatorCode') : t('security.mfa.recoveryCode')
        }
        inputMode={method === 'totp' ? 'numeric' : 'text'}
        autoComplete={method === 'totp' ? 'one-time-code' : 'off'}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoFocus
      />
      <div className="actions">
        <Button type="submit" busy={mutation.isPending}>
          {t('security.mfa.verify')}
        </Button>
        <button
          type="button"
          className="link-button"
          onClick={() => setMethod(method === 'totp' ? 'recovery_code' : 'totp')}
        >
          {method === 'totp' ? t('security.mfa.useRecovery') : t('security.mfa.useAuthenticator')}
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
  const t = useT();
  const { session, refreshSession } = useAuth();
  const org = session?.mfa.activeOrganization;
  if (!session || !org || !org.required || org.satisfied) return <>{children}</>;
  const why = describeReasons(org.reasons, t);
  const organization = session.activeOrganization?.name ?? t('security.mfa.thisOrganization');
  if (!session.mfa.enrolled) {
    return (
      <>
        <PageHeader
          title={t('security.mfa.setupTitle')}
          description={t('security.mfa.requiresBecause', { organization, reasons: why })}
        />
        <Card title={t('security.mfa.authenticatorCard')}>
          <MfaEnrollment onFinished={() => void refreshSession()} />
        </Card>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={t('security.mfa.verifyTitle')}
        description={t('security.mfa.noRemembered', { organization })}
      />
      <Card title={t('security.mfa.codeCard')}>
        <Alert tone="info">{t('security.mfa.requiredBecause', { reasons: why })}</Alert>
        <VerifyInSession />
      </Card>
    </>
  );
}
