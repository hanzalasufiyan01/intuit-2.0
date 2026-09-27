import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { TextField } from '../../shared/ui/TextField';
import { useApiMutation } from '../auth-context';
import { PASSWORD_HINT } from './RegisterPage';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const mutation = useApiMutation((input: { email: string }) =>
    api.post<{ message: string }>('/auth/password-reset/request', input),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate({ email });
  };
  return (
    <main className="auth-page">
      <div className="auth-card">
        <Card title="Reset your password">
          {mutation.isSuccess ? (
            <Alert tone="success">{mutation.data.message}</Alert>
          ) : (
            <form className="form" onSubmit={submit} noValidate>
              <ErrorAlert error={mutation.error} />
              <TextField
                label="Email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button type="submit" busy={mutation.isPending}>
                Send reset link
              </Button>
            </form>
          )}
          <p className="muted">
            <Link to="/login">Back to sign in</Link>
          </p>
        </Card>
      </div>
    </main>
  );
}

/** Reads the one-time token from the URL fragment (never sent to servers or logged). */
export function readTokenFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token');
}

export function ResetPasswordPage() {
  const [token] = useState(() => readTokenFromHash(window.location.hash));
  const [newPassword, setNewPassword] = useState('');
  const mutation = useApiMutation((input: { token: string; newPassword: string }) =>
    api.post<{ message: string }>('/auth/password-reset/complete', input),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token) mutation.mutate({ token, newPassword });
  };
  return (
    <main className="auth-page">
      <div className="auth-card">
        <Card title="Choose a new password">
          {!token ? (
            <Alert>This reset link is incomplete. Request a new one.</Alert>
          ) : mutation.isSuccess ? (
            <Alert tone="success">{mutation.data.message}</Alert>
          ) : (
            <form className="form" onSubmit={submit} noValidate>
              <ErrorAlert error={mutation.error?.issues.length ? null : mutation.error} />
              <TextField
                label="New password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                error={mutation.error?.fieldError('newPassword')}
                hint={PASSWORD_HINT}
              />
              <Button type="submit" busy={mutation.isPending}>
                Change password
              </Button>
            </form>
          )}
          <p className="muted">
            <Link to="/login">Back to sign in</Link>
          </p>
        </Card>
      </div>
    </main>
  );
}
