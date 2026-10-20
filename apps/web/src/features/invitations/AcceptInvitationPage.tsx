import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { readTokenFromHash } from '../../auth/pages/PasswordResetPages';
import { api } from '../../services/api-client';
import type { InvitationPreview, SessionState } from '../../services/types';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useT } from '../../i18n/i18n';

export function AcceptInvitationPage() {
  const t = useT();
  const { status, session, setSession } = useAuth();
  const navigate = useNavigate();
  const [token] = useState(() => readTokenFromHash(window.location.hash));
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');

  const preview = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () => api.post<InvitationPreview>('/invitations/lookup', { token }),
    enabled: Boolean(token),
    retry: false,
  });
  const accept = useApiMutation(
    (input: { token: string; displayName?: string; password?: string }) =>
      api.post<SessionState>('/invitations/accept', input),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    const input = status === 'authenticated' ? { token } : { token, displayName, password };
    accept.mutate(input, {
      onSuccess: (next) => {
        setSession(next);
        void navigate('/', { replace: true });
      },
    });
  };

  let body;
  if (!token) body = <Alert>{t('invite.incomplete')}</Alert>;
  else if (preview.isPending || status === 'loading')
    body = <Spinner label={t('invite.checking')} />;
  else if (preview.isError) body = <ErrorAlert error={preview.error} />;
  else if (preview.data.status !== 'pending') {
    body = <Alert>{t('invite.notPending', { status: preview.data.status })}</Alert>;
  } else if (status === 'anonymous' && preview.data.accountExists) {
    body = (
      <Alert tone="info">
        {t('invite.accountExists', { email: preview.data.email })}{' '}
        <Link to="/login" state={{ from: `/invitations/accept${window.location.hash}` }}>
          {t('invite.signIn')}
        </Link>{' '}
        {t('invite.thenOpenAgain')}
      </Alert>
    );
  } else {
    body = (
      <form className="form" onSubmit={submit} noValidate>
        <p>
          {t('invite.invited', {
            inviter: preview.data.invitedBy ?? t('invite.someone'),
            email: preview.data.email,
            organization: preview.data.organizationName,
          })}
          {preview.data.roleName ? t('invite.asRole', { role: preview.data.roleName }) : ''}.
        </p>
        <ErrorAlert error={accept.error?.issues.length ? null : accept.error} />
        {status === 'authenticated' ? (
          <p className="muted">{t('invite.signedInAs', { email: session?.user.email ?? '' })}</p>
        ) : (
          <>
            <TextField
              label={t('invite.yourName')}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              error={accept.error?.fieldError('displayName')}
            />
            <TextField
              label={t('invite.choosePassword')}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={accept.error?.fieldError('password')}
              hint={t('invite.passwordHint')}
            />
          </>
        )}
        <Button type="submit" busy={accept.isPending}>
          {t('invite.accept')}
        </Button>
      </form>
    );
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Card title={t('invite.title')}>{body}</Card>
      </div>
    </main>
  );
}
