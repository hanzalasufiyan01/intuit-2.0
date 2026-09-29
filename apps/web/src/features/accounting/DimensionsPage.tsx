import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { ExportButton } from '../data-exchange/ExportButton';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { AccountingPage, StatusBadge, useDimensions, useOrgKey } from './shared';
import {
  ACCOUNT_SUBTYPES,
  ACCOUNT_TYPES,
  SUBTYPE_LABELS,
  type AccountSubtype,
  type AccountType,
  type DimensionType,
} from './types';

type Scope = DimensionType['scope'];

const toggle = <T,>(list: readonly T[], item: T): T[] =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

/**
 * Required/optional setting and account-classification scope (Decision 84): a required type
 * applies to manual-journal lines whose account's type or subtype is in the scope. An empty
 * scope enforces nothing.
 */
function RequirementFields({
  idPrefix,
  isRequired,
  scope,
  onChange,
}: {
  idPrefix: string;
  isRequired: boolean;
  scope: Scope;
  onChange: (next: { isRequired: boolean; scope: Scope }) => void;
}) {
  return (
    <fieldset className="fieldset">
      <legend>Requirement</legend>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={isRequired}
          onChange={(e) => onChange({ isRequired: e.target.checked, scope })}
        />{' '}
        Required
      </label>
      <p className="muted">
        Required on manual journal lines whose account is in this scope. Leave the scope empty to
        enforce it nowhere.
      </p>
      <div className="choice-grid">
        <div>
          <strong>Account types</strong>
          {ACCOUNT_TYPES.map((t: AccountType) => (
            <label key={t} className="checkbox">
              <input
                type="checkbox"
                id={`${idPrefix}-type-${t}`}
                checked={scope.accountTypes.includes(t)}
                onChange={() =>
                  onChange({
                    isRequired,
                    scope: { ...scope, accountTypes: toggle(scope.accountTypes, t) },
                  })
                }
              />{' '}
              {t}
            </label>
          ))}
        </div>
        <div>
          <strong>Account subtypes</strong>
          {ACCOUNT_TYPES.flatMap((t) => ACCOUNT_SUBTYPES[t]).map((st: AccountSubtype) => (
            <label key={st} className="checkbox">
              <input
                type="checkbox"
                checked={scope.accountSubtypes.includes(st)}
                onChange={() =>
                  onChange({
                    isRequired,
                    scope: { ...scope, accountSubtypes: toggle(scope.accountSubtypes, st) },
                  })
                }
              />{' '}
              {SUBTYPE_LABELS[st]}
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

function scopeLabel(type: DimensionType): string {
  const parts = [
    ...type.scope.accountTypes,
    ...type.scope.accountSubtypes.map((s) => SUBTYPE_LABELS[s]),
  ];
  if (!type.isRequired) return 'Optional';
  return parts.length ? `Required for ${parts.join(', ')}` : 'Required (empty scope: not enforced)';
}

function useRefresh() {
  const org = useOrgKey();
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['accounting-dimensions', org] });
}

function CreateTypeForm() {
  const refresh = useRefresh();
  const empty = {
    code: '',
    name: '',
    description: '',
    isRequired: false,
    scope: { accountTypes: [], accountSubtypes: [] } as Scope,
  };
  const [form, setForm] = useState(empty);
  const create = useApiMutation((body: typeof form) => api.post('/accounting/dimensions', body));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(form, { onSuccess: () => (setForm(empty), refresh()) });
  };
  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="form form--inline">
        <TextField
          label="Code"
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
          error={create.error?.fieldError('code')}
        />
        <TextField
          label="Name"
          value={form.name}
          placeholder="e.g. Department"
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          error={create.error?.fieldError('name')}
        />
        <TextField
          label="Description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </div>
      <RequirementFields
        idPrefix="new"
        isRequired={form.isRequired}
        scope={form.scope}
        onChange={(next) => setForm({ ...form, ...next })}
      />
      <Button type="submit" busy={create.isPending}>
        Add dimension
      </Button>
      <ErrorAlert error={create.error?.issues.length ? null : create.error} />
    </form>
  );
}

function DimensionTypeCard({ type }: { type: DimensionType }) {
  const refresh = useRefresh();
  const canManage = usePermission(Permission.DimensionsManage);
  const [editing, setEditing] = useState(false);
  const [requirement, setRequirement] = useState({
    isRequired: type.isRequired,
    scope: type.scope,
  });
  const [value, setValue] = useState({ code: '', name: '' });
  const saveRequirement = useApiMutation(() =>
    api.patch(`/accounting/dimensions/${type.id}`, requirement),
  );
  const setStatus = useApiMutation((action: 'archive' | 'restore') =>
    api.post(`/accounting/dimensions/${type.id}/${action}`),
  );
  const addValue = useApiMutation(() =>
    api.post(`/accounting/dimensions/${type.id}/values`, value),
  );
  const setValueStatus = useApiMutation((input: { id: string; action: 'archive' | 'restore' }) =>
    api.post(`/accounting/dimensions/${type.id}/values/${input.id}/${input.action}`),
  );
  const error = saveRequirement.error ?? setStatus.error ?? setValueStatus.error;

  return (
    <Card
      title={`${type.name} (${type.code})`}
      actions={
        canManage ? (
          <>
            {type.status === 'ACTIVE' ? (
              <Button variant="ghost" onClick={() => setEditing(!editing)}>
                {editing ? 'Cancel' : 'Edit requirement'}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              busy={setStatus.isPending}
              onClick={() =>
                setStatus.mutate(type.status === 'ACTIVE' ? 'archive' : 'restore', {
                  onSuccess: refresh,
                })
              }
            >
              {type.status === 'ACTIVE' ? 'Archive' : 'Restore'}
            </Button>
          </>
        ) : null
      }
    >
      <p>
        <StatusBadge status={type.status} /> {scopeLabel(type)}
        {type.description ? <span className="muted"> · {type.description}</span> : null}
      </p>
      {editing ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            saveRequirement.mutate(undefined, {
              onSuccess: () => (setEditing(false), refresh()),
            });
          }}
        >
          <RequirementFields
            idPrefix={type.id}
            isRequired={requirement.isRequired}
            scope={requirement.scope}
            onChange={setRequirement}
          />
          <Button type="submit" busy={saveRequirement.isPending}>
            Save requirement
          </Button>
        </form>
      ) : null}
      <table className="table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Value</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {type.values.map((v) => (
            <tr key={v.id}>
              <td>{v.code}</td>
              <td>{v.name}</td>
              <td>
                <StatusBadge status={v.status} />
              </td>
              <td className="actions">
                {canManage ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setValueStatus.mutate(
                        { id: v.id, action: v.status === 'ACTIVE' ? 'archive' : 'restore' },
                        { onSuccess: refresh },
                      )
                    }
                  >
                    {v.status === 'ACTIVE' ? 'Archive' : 'Restore'}
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canManage && type.status === 'ACTIVE' ? (
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            addValue.mutate(undefined, {
              onSuccess: () => (setValue({ code: '', name: '' }), refresh()),
            });
          }}
        >
          <TextField
            label={`${type.name} value code`}
            value={value.code}
            onChange={(e) => setValue({ ...value, code: e.target.value })}
            error={addValue.error?.fieldError('code')}
          />
          <TextField
            label={`${type.name} value name`}
            value={value.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
            error={addValue.error?.fieldError('name')}
          />
          <Button type="submit" busy={addValue.isPending}>
            Add value
          </Button>
          <ErrorAlert error={addValue.error?.issues.length ? null : addValue.error} />
        </form>
      ) : null}
      <ErrorAlert error={error} />
    </Card>
  );
}

/** Dimension types and values (Decisions 3, 16, 84). Manual journals tag lines only. */
export function DimensionsPage() {
  const dimensions = useDimensions();
  return (
    <>
      <PageHeader
        title="Dimensions"
        description="Tag journal lines by branch, department, project, cost center or your own dimensions. Dimensions never affect balancing."
      />
      <AccountingPage>
        <p className="actions">
          <ExportButton domain="dimension_values" />
        </p>
        <Can permission={Permission.DimensionsManage}>
          <Card title="New dimension">
            <CreateTypeForm />
          </Card>
        </Can>
        {dimensions.isPending ? (
          <Spinner label="Loading dimensions" />
        ) : dimensions.isError ? (
          <ErrorAlert error={dimensions.error} />
        ) : dimensions.data.length === 0 ? (
          <Card>
            <p className="muted">No dimensions yet.</p>
          </Card>
        ) : (
          dimensions.data.map((type) => <DimensionTypeCard key={type.id} type={type} />)
        )}
      </AccountingPage>
    </>
  );
}
