import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { api } from '../../services/api-client';
import type { Member, Role } from '../../services/types';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';

interface StepDraft {
  name: string;
  requiredApprovals: number;
  roleIds: string[];
  membershipIds: string[];
}

interface PoliciesResponse {
  actions: { actionKey: string; label: string; approverPermission: string }[];
  policies: { actionKey: string; steps: StepDraft[] }[];
}

function PolicyEditor({
  action,
  existing,
  roles,
  members,
}: {
  action: PoliciesResponse['actions'][number];
  existing: StepDraft[] | undefined;
  roles: Role[];
  members: Member[];
}) {
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const [steps, setSteps] = useState<StepDraft[]>(existing ?? []);
  const save = useApiMutation(() =>
    sensitive(() => api.put(`/approvals/policies/${action.actionKey}`, { steps })),
  );
  const remove = useApiMutation(() =>
    sensitive(() => api.delete(`/approvals/policies/${action.actionKey}`)),
  );
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['approval-policies'] });
  const update = (i: number, patch: Partial<StepDraft>) =>
    setSteps(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  return (
    <Card title={action.label}>
      <p className="muted">
        {existing?.length
          ? 'Approval is required. Every step must be satisfied by distinct eligible approvers.'
          : 'No approval required: an authorized user may post directly.'}{' '}
        Approvers also need the {action.approverPermission} permission and can never approve their
        own request.
      </p>
      {steps.map((step, i) => (
        <fieldset key={i} className="step">
          <legend>Step {i + 1}</legend>
          <div className="form form--inline">
            <TextField
              label="Step name"
              value={step.name}
              onChange={(e) => update(i, { name: e.target.value })}
            />
            <TextField
              label="Approvals required"
              type="number"
              min={1}
              max={20}
              value={String(step.requiredApprovals)}
              onChange={(e) => update(i, { requiredApprovals: Number(e.target.value) || 1 })}
            />
          </div>
          <div className="choice-grid">
            <div>
              <strong>Eligible roles</strong>
              {roles.map((r) => (
                <label key={r.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={step.roleIds.includes(r.id)}
                    onChange={() => update(i, { roleIds: toggle(step.roleIds, r.id) })}
                  />{' '}
                  {r.name}
                </label>
              ))}
            </div>
            <div>
              <strong>Eligible members</strong>
              {members.map((m) => (
                <label key={m.membershipId} className="checkbox">
                  <input
                    type="checkbox"
                    checked={step.membershipIds.includes(m.membershipId)}
                    onChange={() =>
                      update(i, { membershipIds: toggle(step.membershipIds, m.membershipId) })
                    }
                  />{' '}
                  {m.displayName}
                </label>
              ))}
            </div>
          </div>
          <Button variant="ghost" onClick={() => setSteps(steps.filter((_, idx) => idx !== i))}>
            Remove step
          </Button>
        </fieldset>
      ))}
      <ErrorAlert error={save.error ?? remove.error} />
      <div className="actions">
        <Button
          variant="secondary"
          onClick={() =>
            setSteps([
              ...steps,
              {
                name: `Step ${steps.length + 1}`,
                requiredApprovals: 1,
                roleIds: [],
                membershipIds: [],
              },
            ])
          }
        >
          Add step
        </Button>
        <Button
          busy={save.isPending}
          disabled={steps.length === 0}
          onClick={() => save.mutate(undefined, { onSuccess: refresh })}
        >
          Save policy
        </Button>
        {existing?.length ? (
          <Button
            variant="ghost"
            busy={remove.isPending}
            onClick={() => remove.mutate(undefined, { onSuccess: () => (setSteps([]), refresh()) })}
          >
            Remove approval requirement
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** Authority & Approval configuration (approvals.manage). */
export function ApprovalPoliciesPage() {
  const policies = useQuery({
    queryKey: ['approval-policies'],
    queryFn: () => api.get<PoliciesResponse>('/approvals/policies'),
  });
  const roles = useQuery({
    queryKey: ['roles-for-approvals'],
    queryFn: () => api.get<Role[]>('/organizations/current/roles'),
  });
  const members = useQuery({
    queryKey: ['members-for-approvals'],
    queryFn: () => api.get<Member[]>('/organizations/current/members'),
  });

  return (
    <>
      <PageHeader
        title="Approval policies"
        description="Configure who must approve sensitive actions: one approver, any of several, or several people in sequence."
      />
      {policies.isPending ? (
        <Spinner label="Loading policies" />
      ) : policies.isError ? (
        <ErrorAlert error={policies.error} />
      ) : roles.isError || members.isError ? (
        <Alert>Configuring policies also needs permission to view roles and members.</Alert>
      ) : (
        policies.data.actions.map((action) => (
          <PolicyEditor
            key={action.actionKey}
            action={action}
            existing={policies.data.policies.find((p) => p.actionKey === action.actionKey)?.steps}
            roles={roles.data ?? []}
            members={members.data ?? []}
          />
        ))
      )}
    </>
  );
}
