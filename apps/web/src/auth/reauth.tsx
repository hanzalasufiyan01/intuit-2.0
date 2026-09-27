import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { api, ApiError } from '../services/api-client';
import { ErrorAlert } from '../shared/ui/Alert';
import { Button } from '../shared/ui/Button';
import { Card } from '../shared/ui/Card';
import { TextField } from '../shared/ui/TextField';

type Runner = <T>(action: () => Promise<T>) => Promise<T>;

const ReauthContext = createContext<Runner | null>(null);

/**
 * Sensitive actions (posting, reversal, period close/reopen, setup, approval policies,
 * account deletion) require a recent password confirmation. When the API answers
 * REAUTHENTICATION_REQUIRED, this asks for the password once and retries the action.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const askForPassword = () =>
    new Promise<void>((resolve, reject) => {
      pending.current = { resolve, reject };
      setPassword('');
      setError(null);
      setOpen(true);
    });

  const run: Runner = useCallback(async (action) => {
    try {
      return await action();
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'REAUTHENTICATION_REQUIRED') throw e;
      await askForPassword();
      return action();
    }
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/reauthenticate', { password });
      setOpen(false);
      pending.current?.resolve();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setPassword('');
    }
  };
  const cancel = () => {
    setOpen(false);
    pending.current?.reject(
      new ApiError(403, 'REAUTHENTICATION_REQUIRED', 'Password confirmation cancelled.', null),
    );
  };

  return (
    <ReauthContext.Provider value={run}>
      {children}
      {open ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm your password"
        >
          <div className="modal">
            <Card title="Confirm your password">
              <p className="muted">
                This is a sensitive action. Confirm your password to continue.
              </p>
              <form className="form" onSubmit={(e) => void submit(e)}>
                <ErrorAlert error={error} />
                <TextField
                  label="Password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
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
