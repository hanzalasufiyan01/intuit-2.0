import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { TextField } from '../../shared/ui/TextField';
import { useApiMutation, useAuth } from '../auth-context';

function useSecondsLeft(until: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return until ? Math.max(0, Math.round((new Date(until).getTime() - now) / 1000)) : 0;
}

/** Second step of sign-in (S7-14, S7-40): an authenticator code or a recovery code. */
export function MfaChallengePage() {
  const { pending, completeChallenge, logout } = useAuth();
  const navigate = useNavigate();
  const [method, setMethod] = useState<'totp' | 'recovery_code'>('totp');
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(false);
  const mutation = useApiMutation(completeChallenge);
  const secondsLeft = useSecondsLeft(pending?.expiresAt);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate(
      { method, code, rememberDevice: remember },
      {
        // On success the session becomes complete and RequirePendingMfa moves on to the page
        // the user was going to (declarative, so it cannot race the session update).
        onError: (error) => {
          setCode('');
          // Too many wrong codes ended this sign-in: start again from the password.
          if (error instanceof ApiError && error.code === 'MFA_CHALLENGE_FAILED') {
            void logout().then(() => navigate('/login', { replace: true }));
          }
        },
      },
    );
  };

  const startOver = async () => {
    await logout();
    void navigate('/login', { replace: true });
  };

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Card title="Two-step verification">
          <form className="form" onSubmit={submit} noValidate>
            <p className="muted">
              Signing in as <strong>{pending?.user.email}</strong>.{' '}
              {secondsLeft > 0
                ? `This step expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}.`
                : 'This step has expired. Start again.'}
            </p>
            <ErrorAlert error={mutation.error} />
            {method === 'totp' ? (
              <TextField
                label="Code from your authenticator app"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                required
              />
            ) : (
              <TextField
                label="Recovery code"
                autoComplete="off"
                spellCheck={false}
                maxLength={24}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                hint="Each recovery code works once."
                autoFocus
                required
              />
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Remember this browser for 30 days (you will still need your password)
            </label>
            <Button type="submit" busy={mutation.isPending} disabled={secondsLeft === 0}>
              Verify
            </Button>
            <p className="muted">
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setMethod(method === 'totp' ? 'recovery_code' : 'totp');
                  setCode('');
                }}
              >
                {method === 'totp' ? 'Use a recovery code instead' : 'Use your authenticator app'}
              </button>{' '}
              ·{' '}
              <button type="button" className="link-button" onClick={() => void startOver()}>
                Start again
              </button>
            </p>
          </form>
        </Card>
      </div>
    </main>
  );
}
