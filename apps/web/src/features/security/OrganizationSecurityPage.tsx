import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { api } from '../../services/api-client';
import type { SecurityPolicy } from '../../services/types';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { useT } from '../../i18n/i18n';

function PolicyForm({ policy, onSaved }: { policy: SecurityPolicy; onSaved(): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { refreshSession } = useAuth();
  const sensitive = useSensitiveAction();
  const [requireAll, setRequireAll] = useState(policy.requireMfaForAllMembers);
  const [allowDevices, setAllowDevices] = useState(policy.allowTrustedDevices);
  const save = useApiMutation(() =>
    sensitive(() =>
      api.put<SecurityPolicy>('/organizations/current/security', {
        requireMfaForAllMembers: requireAll,
        allowTrustedDevices: allowDevices,
        version: policy.version,
      }),
    ),
  );
  const changed =
    requireAll !== policy.requireMfaForAllMembers || allowDevices !== policy.allowTrustedDevices;
  const blocked = policy.members ? policy.members.total - policy.members.enrolled : 0;

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(undefined, {
          onSuccess: () => {
            onSaved();
            void queryClient.invalidateQueries({ queryKey: ['organization-security'] });
            void refreshSession();
          },
        });
      }}
    >
      <label className="checkbox">
        <input
          type="checkbox"
          checked={requireAll}
          onChange={(e) => setRequireAll(e.target.checked)}
        />
        {t('orgSecurity.requireAll')}
      </label>
      <p className="muted">{t('orgSecurity.alwaysNeed')}</p>
      {requireAll && !policy.requireMfaForAllMembers && blocked > 0 ? (
        <Alert tone="info">
          {t(blocked === 1 ? 'orgSecurity.blockedOne' : 'orgSecurity.blockedMany', {
            count: blocked,
          })}
        </Alert>
      ) : null}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={allowDevices}
          onChange={(e) => setAllowDevices(e.target.checked)}
        />
        {t('orgSecurity.allowDevices')}
      </label>
      <p className="muted">{t('orgSecurity.devicesNote')}</p>
      <ErrorAlert error={save.error} />
      <div className="actions">
        <Button type="submit" busy={save.isPending} disabled={!changed}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** Organization MFA policy (S7-29, S7-36, S7-42): members.manage, re-auth and step-up. */
export function OrganizationSecurityPage() {
  const t = useT();
  const { activeOrganization } = useAuth();
  // Kept here: the form remounts with each saved version, which would drop its own message.
  const [saved, setSaved] = useState(false);
  const policy = useQuery({
    queryKey: ['organization-security', activeOrganization?.id],
    queryFn: () => api.get<SecurityPolicy>('/organizations/current/security'),
  });
  return (
    <>
      <PageHeader title={t('orgSecurity.title')} description={t('orgSecurity.description')} />
      <Card title={t('account.twoStep.title')}>
        {policy.isPending ? (
          <Spinner label={t('account.loading')} />
        ) : policy.isError ? (
          <ErrorAlert error={policy.error} />
        ) : (
          <>
            {policy.data.members ? (
              <p>
                {t('orgSecurity.usage', {
                  enrolled: policy.data.members.enrolled,
                  total: policy.data.members.total,
                })}
              </p>
            ) : null}
            {saved ? <Alert tone="success">{t('orgSecurity.saved')}</Alert> : null}
            <PolicyForm
              key={policy.data.version}
              policy={policy.data}
              onSaved={() => setSaved(true)}
            />
          </>
        )}
      </Card>
    </>
  );
}
