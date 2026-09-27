import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { readTokenFromHash } from '../../auth/pages/PasswordResetPages';
import { PASSWORD_HINT } from '../../auth/pages/RegisterPage';
import { api } from '../../services/api-client';
import type { InvitationPreview, SessionState } from '../../services/types';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';

export function AcceptInvitationPage() {
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
  if (!token) body = <Alert>This invitation link is incomplete.</Alert>;
  else if (preview.isPending || status === 'loading')
    body = <Spinner label="Checking invitation" />;
  else if (preview.isError) body = <ErrorAlert error={preview.error} />;
  else if (preview.data.status !== 'pending') {
    body = <Alert>This invitation is {preview.data.status}. Ask for a new invitation.</Alert>;
  } else if (status === 'anonymous' && preview.data.accountExists) {
    body = (
      <Alert tone="info">
        An account already exists for {preview.data.email}.{' '}
        <Link to="/login" state={{ from: `/invitations/accept${window.location.hash}` }}>
          Sign in
        </Link>{' '}
        with it, then open this link again.
      </Alert>
    );
  } else {
    body = (
      <form className="form" onSubmit={submit} noValidate>
        <p>
          {preview.data.invitedBy ?? 'Someone'} invited <strong>{preview.data.email}</strong> to
          join <strong>{preview.data.organizationName}</strong>
          {preview.data.roleName ? ` as ${preview.data.roleName}` : ''}.
        </p>
        <ErrorAlert error={accept.error?.issues.length ? null : accept.error} />
        {status === 'authenticated' ? (
          <p className="muted">You are signed in as {session?.user.email}.</p>
        ) : (
          <>
            <TextField
              label="Your name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              error={accept.error?.fieldError('displayName')}
            />
            <TextField
              label="Choose a password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={accept.error?.fieldError('password')}
              hint={PASSWORD_HINT}
            />
          </>
        )}
        <Button type="submit" busy={accept.isPending}>
          Accept invitation
        </Button>
      </form>
    );
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Card title="Join an organization">{body}</Card>
      </div>
    </main>
  );
}
