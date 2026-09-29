import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../services/api-client';
import type { SessionState } from '../services/types';
import { ErrorAlert } from '../shared/ui/Alert';
import { Button } from '../shared/ui/Button';
import { Card } from '../shared/ui/Card';
import { TextField } from '../shared/ui/TextField';
import { SESSION_QUERY_KEY } from './auth-context';

type Runner = <T>(action: () => Promise<T>) => Promise<T>;
type Prompt = 'password' | 'code';

const ReauthContext = createContext<Runner | null>(null);

/**
 * Sensitive actions (posting, reversal, period close/reopen, setup, approval policies, account
 * deletion, member and role changes) require a recent password confirmation. MFA management and
 * security actions also need a recent verification code (step-up, S7-33). When the API answers
 * REAUTHENTICATION_REQUIRED or MFA_STEP_UP_REQUIRED, this asks once for what is missing and
 * retries the action.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [value, setValue] = useState('');
  const [method, setMethod] = useState<'totp' | 'recovery_code'>('totp');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const ask = (kind: Prompt) =>
    new Promise<void>((resolve, reject) => {
      pending.current = { resolve, reject };
      setValue('');
      setMethod('totp');
      setError(null);
      setPrompt(kind);
    });

  const run: Runner = useCallback(async (action) => {
    // At most one password prompt and one code prompt per action.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await action();
      } catch (e) {
        if (!(e instanceof ApiError) || attempt === 2) throw e;
        if (e.code === 'REAUTHENTICATION_REQUIRED') await ask('password');
        else if (e.code === 'MFA_STEP_UP_REQUIRED') await ask('code');
        else throw e;
      }
    }
    return action();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (prompt === 'password') {
        await api.post('/auth/reauthenticate', { password: value });
      } else {
        const next = await api.post<SessionState>('/auth/mfa/step-up', { method, code: value });
        queryClient.setQueryData(SESSION_QUERY_KEY, next);
      }
      setPrompt(null);
      pending.current?.resolve();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setValue('');
    }
  };
  const cancel = () => {
    const kind = prompt;
    setPrompt(null);
    pending.current?.reject(
      kind === 'code'
        ? new ApiError(403, 'MFA_STEP_UP_REQUIRED', 'Verification cancelled.', null)
        : new ApiError(403, 'REAUTHENTICATION_REQUIRED', 'Password confirmation cancelled.', null),
    );
  };

  return (
    <ReauthContext.Provider value={run}>
      {children}
      {prompt ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={prompt === 'password' ? 'Confirm your password' : 'Enter a verification code'}
        >
          <div className="modal">
            <Card
              title={prompt === 'password' ? 'Confirm your password' : 'Enter a verification code'}
            >
              <p className="muted">
                {prompt === 'password'
                  ? 'This is a sensitive action. Confirm your password to continue.'
                  : 'This is a security change. Enter a code from your authenticator app to confirm it.'}
              </p>
              <form className="form" onSubmit={(e) => void submit(e)}>
                <ErrorAlert error={error} />
                {prompt === 'password' ? (
                  <TextField
                    label="Password"
                    type="password"
                    autoComplete="current-password"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    autoFocus
                  />
                ) : (
                  <>
                    <TextField
                      label={method === 'totp' ? 'Authenticator code' : 'Recovery code'}
                      inputMode={method === 'totp' ? 'numeric' : 'text'}
                      autoComplete={method === 'totp' ? 'one-time-code' : 'off'}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setMethod(method === 'totp' ? 'recovery_code' : 'totp')}
                    >
                      {method === 'totp'
                        ? 'Use a recovery code instead'
                        : 'Use your authenticator app'}
                    </button>
                  </>
                )}
                <div className="actions">
                  <Button type="submit" busy={busy}>
                    Confirm
                  </Button>
                  <Button variant="secondary" onClick={cancel}>
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          </div>
        </div>
      ) : null}
    </ReauthContext.Provider>
  );
}

export function useSensitiveAction(): Runner {
  const run = useContext(ReauthContext);
  if (!run) throw new Error('useSensitiveAction must be used inside <ReauthProvider>');
  return run;
}
