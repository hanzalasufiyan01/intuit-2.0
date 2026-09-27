import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { TextField } from '../../shared/ui/TextField';
import { useApiMutation, useAuth } from '../auth-context';
import { safeRedirectTarget } from '../RequireAuth';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = safeRedirectTarget(location.state);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useApiMutation(login);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate(
      { email, password },
      { onSuccess: () => void navigate(from, { replace: true }) },
    );
  };

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Card title="Sign in to Intuit 2.0">
          <form className="form" onSubmit={submit} noValidate>
            <ErrorAlert error={mutation.error} />
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={mutation.error?.fieldError('email')}
              required
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={mutation.error?.fieldError('password')}
              required
            />
            <Button type="submit" busy={mutation.isPending}>
              Sign in
            </Button>
            <p className="muted">
              <Link to="/forgot-password">Forgot your password?</Link> ·{' '}
              <Link to="/register">Create an account</Link>
            </p>
          </form>
        </Card>
      </div>
    </main>
  );
}
