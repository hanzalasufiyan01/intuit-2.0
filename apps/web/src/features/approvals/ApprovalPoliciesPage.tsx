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
import {
  describeConditions,
  transactionTypeLabel,
  type ApprovalAction,
  type StepConditions,
} from './conditions';

interface StepDraft {
  name: string;
  requiredApprovals: number;
  roleIds: string[];
  membershipIds: string[];
  /** Condition inputs as typed; empty means "not set" (S10). */
  minBaseAmount: string;
  maxBaseAmount: string;
  transactionTypes: string[];
  /** The currency saved thresholds were set in (read-only). */
  thresholdCurrency: string | null;
}

interface SavedStep {
  name: string;
  requiredApprovals: number;
  roleIds: string[];
  membershipIds: string[];
  conditions?: StepConditions | null;
}

interface PoliciesResponse {
  actions: ApprovalAction[];
  baseCurrency: string | null;
  policies: { actionKey: string; steps: SavedStep[] }[];
}

function toDraft(step: SavedStep): StepDraft {
  return {
    name: step.name,
    requiredApprovals: step.requiredApprovals,
    roleIds: step.roleIds,
    membershipIds: step.membershipIds,
    minBaseAmount: step.conditions?.minBaseAmount ?? '',
    maxBaseAmount: step.conditions?.maxBaseAmount ?? '',
    transactionTypes: step.conditions?.transactionTypes ?? [],
    thresholdCurrency: step.conditions?.thresholdCurrency ?? null,
  };
}

/** The request body for a step: strict on the server, so only known fields are sent. */
function toRequest(step: StepDraft, action: ApprovalAction) {
  const conditions = {
    minBaseAmount: action.conditions.amount ? step.minBaseAmount.trim() || null : null,
    maxBaseAmount: action.conditions.amount ? step.maxBaseAmount.trim() || null : null,
    transactionTypes: step.transactionTypes.length ? step.transactionTypes : null,
  };
  return {
    name: step.name,
    requiredApprovals: step.requiredApprovals,
    roleIds: step.roleIds,
    membershipIds: step.membershipIds,
    conditions,
  };
}

function PolicyEditor({
  action,
  existing,
  baseCurrency,
  roles,
  members,
}: {
  action: ApprovalAction;
  existing: SavedStep[] | undefined;
  baseCurrency: string | null;
  roles: Role[];
  members: Member[];
}) {
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const [steps, setSteps] = useState<StepDraft[]>((existing ?? []).map(toDraft));
  const save = useApiMutation(() =>
    sensitive(() =>
      api.put(`/approvals/policies/${action.actionKey}`, {
        steps: steps.map((s) => toRequest(s, action)),
      }),
    ),
  );
  const remove = useApiMutation(() =>
    sensitive(() => api.delete(`/approvals/policies/${action.actionKey}`)),
  );
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['approval-policies'] });
  const update = (i: number, patch: Partial<StepDraft>) =>
    setSteps(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const canCondition = action.conditions.amount || action.conditions.transactionTypes.length > 1;

  return (
    <Card title={action.label}>
      <p className="muted">
        {existing?.length
          ? 'Approval is required when a step applies. Every step that applies must be satisfied by distinct eligible approvers; a document that no step applies to needs no approval.'
          : 'No approval required: an authorized user may post directly.'}{' '}
        Approvers also need the {action.approverPermission} permission and can never approve their
        own request.
      </p>
      {steps.map((step, i) => {
        const staleCurrency =
          step.thresholdCurrency !== null &&
          baseCurrency !== null &&
          step.thresholdCurrency !== baseCurrency;
        return (
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
            {canCondition ? (
              <div className="step-conditions">
                <strong>Applies when</strong>
                {action.conditions.amount ? (
                  <div className="form form--inline">
                    <TextField
                      label={`Amount from (${baseCurrency ?? 'base currency'})`}
                      inputMode="decimal"
                      value={step.minBaseAmount}
                      placeholder="any"
                      onChange={(e) => update(i, { minBaseAmount: e.target.value })}
                    />
                    <TextField
                      label={`Up to, not including (${baseCurrency ?? 'base currency'})`}
                      inputMode="decimal"
                      value={step.maxBaseAmount}
                      placeholder="no limit"
                      onChange={(e) => update(i, { maxBaseAmount: e.target.value })}
                    />
                  </div>
                ) : null}
                {action.conditions.transactionTypes.length > 1 ? (
                  <fieldset className="choice-row">
                    <legend>Transaction types (none ticked = all)</legend>
                    {action.conditions.transactionTypes.map((type) => (
                      <label key={type} className="checkbox">
                        <input
                          type="checkbox"
                          checked={step.transactionTypes.includes(type)}
                          onChange={() =>
                            update(i, { transactionTypes: toggle(step.transactionTypes, type) })
                          }
                        />{' '}
                        {transactionTypeLabel(type)}
                      </label>
                    ))}
                  </fieldset>
                ) : null}
                <p className="muted" data-testid={`step-summary-${action.actionKey}-${i + 1}`}>
                  {describeConditions(
                    {
                      minBaseAmount: step.minBaseAmount.trim() || null,
                      maxBaseAmount: step.maxBaseAmount.trim() || null,
                      transactionTypes: step.transactionTypes.length ? step.transactionTypes : null,
                      thresholdCurrency: step.thresholdCurrency ?? baseCurrency,
                    },
                    baseCurrency,
                  )}
                </p>
                {staleCurrency ? (
                  <Alert>
                    This step&apos;s amounts were set in {step.thresholdCurrency}, but the base
                    currency is now {baseCurrency}. Until you save it again, the step applies to
                    every document.
                  </Alert>
                ) : null}
              </div>
            ) : null}
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
        );
      })}
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
                minBaseAmount: '',
                maxBaseAmount: '',
                transactionTypes: [],
                thresholdCurrency: null,
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
        description="Configure who must approve sensitive actions, and when: by amount or transaction type, with one or several steps."
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
            baseCurrency={policies.data.baseCurrency}
            existing={policies.data.policies.find((p) => p.actionKey === action.actionKey)?.steps}
            roles={roles.data ?? []}
            members={members.data ?? []}
          />
        ))
      )}
    </>
  );
}
