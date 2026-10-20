import { useState } from 'react';
import { useT } from '../../i18n/i18n';
import { ApiError } from '../../services/api-client';
import { Alert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { TextField } from '../../shared/ui/TextField';

/** The two codes the server answers with when an expense policy stops a claim at submission. */
export function isClaimPolicyError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    (error.code === 'EXPENSE_POLICY_WARNING' || error.code === 'EXPENSE_POLICY_BLOCKED')
  );
}

/**
 * Shown when an organization's expense policy (R-04) warns about or blocks a claim. A warning can
 * be confirmed with a reason that is audited; a block cannot be overridden. The server decides.
 */
export function ClaimPolicyNotice({
  error,
  busy,
  onConfirm,
}: {
  error: ApiError;
  busy: boolean;
  onConfirm: (reason: string) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const blocked = error.code === 'EXPENSE_POLICY_BLOCKED';
  return (
    <Card title={blocked ? t('claims.policy.blockedTitle') : t('policies.warningTitle')}>
      <Alert tone={blocked ? 'error' : 'info'}>{error.message}</Alert>
      <ul>
        {error.issues.map((i) => (
          <li key={i.message}>{i.message}</li>
        ))}
      </ul>
      {blocked ? null : (
        <form
          className="form form--inline"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm(reason.trim());
          }}
        >
          <TextField
            label={t('claims.policy.reason')}
            value={reason}
            required
            onChange={(event) => setReason(event.target.value)}
          />
          <Button type="submit" busy={busy} disabled={!reason.trim()}>
            {t('claims.policy.submitAnyway')}
          </Button>
        </form>
      )}
    </Card>
  );
}
