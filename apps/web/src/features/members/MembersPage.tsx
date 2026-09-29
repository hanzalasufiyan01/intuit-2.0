import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import type { Invitation, Member, Role } from '../../services/types';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';

function InviteForm({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const roles = useQuery({
    queryKey: ['roles', organizationId],
    queryFn: () => api.get<Role[]>('/organizations/current/roles'),
  });
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const mutation = useApiMutation((input: { email: string; roleId: string }) =>
    api.post<Invitation>('/organizations/current/invitations', input),
  );
  const assignable = (roles.data ?? []).filter((role) => !role.isOwner);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate(
      { email, roleId: roleId || assignable[0]?.id || '' },
      {
        onSuccess: () => {
          setEmail('');
          void queryClient.invalidateQueries({ queryKey: ['invitations', organizationId] });
        },
      },
    );
  };

  if (roles.isError)
    return <Alert>You need permission to view roles before inviting people.</Alert>;
  return (
    <form className="form form--inline" onSubmit={submit} noValidate>
      <TextField
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={mutation.error?.fieldError('email')}
      />
      <div className="field">
        <label htmlFor="invite-role">Role</label>
        <select id="invite-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {assignable.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" busy={mutation.isPending}>
        Send invitation
      </Button>
      {mutation.isSuccess ? (
        <Alert tone="success">Invitation sent to {mutation.data.email}.</Alert>
      ) : null}
      <ErrorAlert error={mutation.error?.issues.length ? null : mutation.error} />
    </form>
  );
}

/**
 * Admin MFA reset (S7-38): members.manage, re-authentication and a verification code. Not offered
 * for the Owner or oneself; the server also refuses anyone who belongs to another organization.
 */
function ResetMfa({ member, organizationId }: { member: Member; organizationId: string }) {
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const [confirming, setConfirming] = useState(false);
  const reset = useApiMutation(() =>
    sensitive(() =>
      api.post(`/organizations/current/members/${member.membershipId}/mfa-reset`, {}),
    ),
  );
  if (reset.isSuccess) return <span className="muted">Reset</span>;
  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        Reset two-step verification
      </Button>
    );
  }
  return (
    <div className="stack">
      <p className="muted">
        {member.displayName} will be signed out everywhere and must set up a new authenticator.
      </p>
      <div className="actions">
        <Button
          busy={reset.isPending}
          onClick={() =>
            reset.mutate(undefined, {
              onSuccess: () =>
                void queryClient.invalidateQueries({ queryKey: ['members', organizationId] }),
            })
          }
        >
          Reset
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
      <ErrorAlert error={reset.error} />
    </div>
  );
}

function InvitationList({ organizationId }: { organizationId: string }) {
  const invitations = useQuery({
    queryKey: ['invitations', organizationId],
    queryFn: () => api.get<Invitation[]>('/organizations/current/invitations'),
  });
  if (invitations.isPending) return <Spinner label="Loading invitations" />;
  if (invitations.isError) return <ErrorAlert error={invitations.error} />;
  if (invitations.data.length === 0) return <p className="muted">No invitations yet.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Status</th>
          <th>Expires</th>
        </tr>
      </thead>
      <tbody>
        {invitations.data.map((invitation) => (
          <tr key={invitation.id}>
            <td>{invitation.email}</td>
            <td>{invitation.status}</td>
            <td>{new Date(invitation.expiresAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MembersPage() {
  const { activeOrganization, session } = useAuth();
  const organizationId = activeOrganization?.id ?? 'none';
  const members = useQuery({
    queryKey: ['members', organizationId],
    queryFn: () => api.get<Member[]>('/organizations/current/members'),
  });

  return (
    <>
      <PageHeader title="Members" description="People who belong to this organization." />
      <Card title="Members">
        {members.isPending ? (
          <Spinner label="Loading members" />
        ) : members.isError ? (
          <ErrorAlert error={members.error} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Roles</th>
                <th>Status</th>
                {members.data.some((m) => m.mfa) ? <th>Two-step verification</th> : null}
              </tr>
            </thead>
            <tbody>
              {members.data.map((member) => (
                <tr key={member.membershipId}>
                  <td>{member.displayName}</td>
                  <td>{member.email}</td>
                  <td>
                    {member.roles.map((role) => (
                      <span key={role.id} className="badge">
                        {role.name}
                      </span>
                    ))}
                  </td>
                  <td>{member.status}</td>
                  {member.mfa ? (
                    <td>
                      {member.mfa.enrolled
                        ? 'On'
                        : member.mfa.required
                          ? 'Required, not set up'
                          : 'Off'}
                      {member.mfa.enrolled &&
                      !member.isOwner &&
                      member.userId !== session?.user.id ? (
                        <Can permission={Permission.MembersManage}>
                          <ResetMfa member={member} organizationId={organizationId} />
                        </Can>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Can permission={Permission.MembersInvite}>
        <Card title="Invite someone">
          <InviteForm organizationId={organizationId} />
        </Card>
        <Card title="Invitations">
          <InvitationList organizationId={organizationId} />
        </Card>
      </Can>
    </>
  );
}
