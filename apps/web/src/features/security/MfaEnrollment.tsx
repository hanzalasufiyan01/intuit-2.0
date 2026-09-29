import { useState, type FormEvent } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { api } from '../../services/api-client';
import type { MfaEnrollment as Enrollment, SessionState } from '../../services/types';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { RecoveryCodesDisplay } from './RecoveryCodes';

/** Groups a base32 secret in blocks of four for manual entry (S7-13). */
function grouped(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

/**
 * Authenticator setup (S7-12, S7-39): confirm the password, scan the QR code (or type the key),
 * enter a code, save the recovery codes. Used by the enforcement screen and Account security.
 */
export function MfaEnrollment({
  replacing = false,
  onFinished,
}: {
  replacing?: boolean;
  onFinished(): void;
}) {
  const { updateSession } = useAuth();
  const sensitive = useSensitiveAction();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  // The new session view is applied only once the codes are saved: applying it earlier would
  // satisfy the enforcement screen and hide the codes before the user has kept them.
  const [verified, setVerified] = useState<SessionState | null>(null);
  const [copied, setCopied] = useState(false);

  const start = useApiMutation(() =>
    sensitive(() => api.post<Enrollment>('/auth/mfa/totp/enroll', {})),
  );
  const verify = useApiMutation((input: { enrollmentId: string; code: string }) =>
    api.post<{ recoveryCodes: string[] | null; session: SessionState }>(
      '/auth/mfa/totp/verify',
      input,
    ),
  );

  const begin = () =>
    start.mutate(undefined, {
      onSuccess: (data) => {
        setEnrollment(data);
        setCode('');
      },
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!enrollment) return;
    verify.mutate(
      { enrollmentId: enrollment.enrollmentId, code },
      {
        onSuccess: (result) => {
          setEnrollment(null);
          if (result.recoveryCodes) {
            setVerified(result.session);
            setCodes(result.recoveryCodes);
          } else {
            updateSession(result.session);
            onFinished();
          }
        },
        onError: () => setCode(''),
      },
    );
  };

  if (codes) {
    return (
      <RecoveryCodesDisplay
        codes={codes}
        onDone={() => {
          if (verified) updateSession(verified);
          setCodes(null);
          setVerified(null);
          onFinished();
        }}
      />
    );
  }

  if (!enrollment) {
    return (
      <div className="stack">
        <p>
          {replacing
            ? 'Set up a new authenticator app. The current one stops working when the new one is confirmed.'
            : 'Use an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password to create six-digit sign-in codes.'}
        </p>
        <ErrorAlert error={start.error} />
        <Button onClick={begin} busy={start.isPending}>
          {replacing ? 'Set up a new authenticator' : 'Set up two-step verification'}
        </Button>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <ol className="steps-list">
        <li>Scan this QR code with your authenticator app.</li>
      </ol>
      <img className="qr-code" src={enrollment.qrCode} alt="QR code for your authenticator app" />
      <details>
        <summary>Can’t scan it? Enter the key instead</summary>
        <p className="muted">
          Account <strong>{enrollment.account}</strong>, issuer <strong>{enrollment.issuer}</strong>
          , time-based, 6 digits.
        </p>
        <p>
          <code className="secret-key" aria-label="Setup key">
            {grouped(enrollment.secret)}
          </code>{' '}
          <Button
            variant="ghost"
            onClick={() =>
              void navigator.clipboard
                .writeText(enrollment.secret)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          >
            {copied ? 'Copied' : 'Copy key'}
          </Button>
        </p>
      </details>
      <ErrorAlert error={verify.error} />
      <TextField
        label="Enter the six-digit code from the app"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoFocus
      />
      <div className="actions">
        <Button type="submit" busy={verify.isPending}>
          Confirm
        </Button>
        <Button variant="secondary" onClick={() => setEnrollment(null)}>
          Cancel
        </Button>
      </div>
      <p className="muted">
        This setup expires at {new Date(enrollment.expiresAt).toLocaleTimeString()}.
      </p>
    </form>
  );
}
