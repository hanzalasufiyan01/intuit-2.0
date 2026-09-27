import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { TextField } from '../../shared/ui/TextField';
import { useApiMutation, useAuth } from '../auth-context';

export const PASSWORD_HINT = 'At least 12 characters. A passphrase works well.';

/** Registration creates the user and a new organization, with the user as its Owner. */
export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    displayName: '',
    email: '',
    password: '',
    organizationName: '',
  });
  const mutation = useApiMutation(register);
  const update = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: e.target.value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate(form, { onSuccess: () => void navigate('/', { replace: true }) });
  };
  const fieldError = (path: string) => mutation.error?.fieldError(path);

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Card title="Create your Intuit 2.0 account">
          <form className="form" onSubmit={submit} noValidate>
            <ErrorAlert error={mutation.error?.issues.length ? null : mutation.error} />
            <TextField
              label="Your name"
              autoComplete="name"
              value={form.displayName}
              onChange={update('displayName')}
              error={fieldError('displayName')}
            />
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={update('email')}
              error={fieldError('email')}
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={update('password')}
              error={fieldError('password')}
              hint={PASSWORD_HINT}
            />
            <TextField
              label="Organization name"
              autoComplete="organization"
              value={form.organizationName}
              onChange={update('organizationName')}
              error={fieldError('organizationName')}
            />
            <Button type="submit" busy={mutation.isPending}>
              Create account
            </Button>
            <p className="muted">
              Already have an account? <Link to="/login">Sign in</Link>
            </p>
          </form>
        </Card>
      </div>
    </main>
  );
}
