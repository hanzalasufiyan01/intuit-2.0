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

function PolicyForm({ policy, onSaved }: { policy: SecurityPolicy; onSaved(): void }) {
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
        Require two-step verification for all members
      </label>
      <p className="muted">
        The Owner and people who can manage members, roles, approvals or accounting setup always
        need it.
      </p>
      {requireAll && !policy.requireMfaForAllMembers && blocked > 0 ? (
        <Alert tone="info">
          {blocked} {blocked === 1 ? 'member has' : 'members have'} not set up two-step verification
          yet and will be asked to before they can continue.
        </Alert>
      ) : null}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={allowDevices}
          onChange={(e) => setAllowDevices(e.target.checked)}
        />
        Allow remembered browsers (skip the code for up to 30 days)
      </label>
      <p className="muted">
        When off, people who signed in on a remembered browser enter a code before using this
        organization.
      </p>
      <ErrorAlert error={save.error} />
      <div className="actions">
        <Button type="submit" busy={save.isPending} disabled={!changed}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** Organization MFA policy (S7-29, S7-36, S7-42): members.manage, re-auth and step-up. */
export function OrganizationSecurityPage() {
  const { activeOrganization } = useAuth();
  // Kept here: the form remounts with each saved version, which would drop its own message.
  const [saved, setSaved] = useState(false);
  const policy = useQuery({
    queryKey: ['organization-security', activeOrganization?.id],
    queryFn: () => api.get<SecurityPolicy>('/organizations/current/security'),
  });
  return (
    <>
      <PageHeader
        title="Security"
        description="Two-step verification rules for everyone in this organization."
      />
      <Card title="Two-step verification">
        {policy.isPending ? (
          <Spinner label="Loading security settings" />
        ) : policy.isError ? (
          <ErrorAlert error={policy.error} />
        ) : (
          <>
            {policy.data.members ? (
              <p>
                {policy.data.members.enrolled} of {policy.data.members.total} active members use
                two-step verification.
              </p>
            ) : null}
            {saved ? <Alert tone="success">Security settings saved.</Alert> : null}
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
