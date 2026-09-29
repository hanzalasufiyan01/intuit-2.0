import { useState } from 'react';
import { Alert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';

/**
 * Shows a new set of recovery codes exactly once (S7-18). The download is generated in the
 * browser; the codes are never sent anywhere else and cannot be shown again.
 */
export function RecoveryCodesDisplay({
  codes,
  onDone,
  doneLabel = 'Continue',
}: {
  codes: string[];
  onDone(): void;
  doneLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `Intuit 2.0 recovery codes\nEach code works once.\n\n${codes.join('\n')}\n`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'intuit2-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <Alert tone="info">
        Save these recovery codes somewhere safe. Each one lets you sign in once if you lose your
        authenticator app. They will not be shown again.
      </Alert>
      <ul className="recovery-codes" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className="actions">
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
        <Button variant="secondary" onClick={download}>
          Download .txt
        </Button>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have
        saved my recovery codes
      </label>
      <Button onClick={onDone} disabled={!saved}>
        {doneLabel}
      </Button>
    </div>
  );
}
