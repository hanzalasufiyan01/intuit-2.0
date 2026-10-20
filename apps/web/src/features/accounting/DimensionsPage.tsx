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
import { useT, type Translate } from '../../i18n/i18n';

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
  const tr = useT();
  return (
    <fieldset className="fieldset">
      <legend>{tr('accounting.dimensionsPage.requirement')}</legend>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={isRequired}
          onChange={(e) => onChange({ isRequired: e.target.checked, scope })}
        />{' '}
        {tr('accounting.dimensionsPage.required')}
      </label>
      <p className="muted">{tr('accounting.dimensionsPage.requiredOnManualJournalLines')}</p>
      <div className="choice-grid">
        <div>
          <strong>{tr('accounting.dimensionsPage.accountTypes')}</strong>
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
          <strong>{tr('accounting.dimensionsPage.accountSubtypes')}</strong>
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
              {tr(SUBTYPE_LABELS[st])}
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

function scopeLabel(type: DimensionType, t: Translate): string {
  const parts = [
    ...type.scope.accountTypes,
    ...type.scope.accountSubtypes.map((s) => t(SUBTYPE_LABELS[s])),
  ];
  if (!type.isRequired) return t('accounting.dimensionsPage.scopeOptional');
  return parts.length
    ? t('accounting.dimensionsPage.scopeRequiredFor', { parts: parts.join(', ') })
    : t('accounting.dimensionsPage.scopeRequiredEmpty');
}

function useRefresh() {
  const org = useOrgKey();
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['accounting-dimensions', org] });
}

function CreateTypeForm() {
  const t = useT();
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
          label={t('accounting.dimensionsPage.code')}
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
          error={create.error?.fieldError('code')}
        />
        <TextField
          label={t('accounting.dimensionsPage.name')}
          value={form.name}
          placeholder={t('accounting.dimensionsPage.eGDepartment')}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          error={create.error?.fieldError('name')}
        />
        <TextField
          label={t('accounting.dimensionsPage.description')}
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
        {t('accounting.dimensionsPage.addDimension')}
      </Button>
      <ErrorAlert error={create.error?.issues.length ? null : create.error} />
    </form>
  );
}

function DimensionTypeCard({ type }: { type: DimensionType }) {
  const t = useT();
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
                {editing ? t('common.cancel') : t('accounting.dimensionsPage.editRequirement')}
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
              {type.status === 'ACTIVE' ? t('common.archive') : t('common.restore')}
            </Button>
          </>
        ) : null
      }
    >
      <p>
        <StatusBadge status={type.status} /> {scopeLabel(type, t)}
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
            {t('accounting.dimensionsPage.saveRequirement')}
          </Button>
        </form>
      ) : null}
      <table className="table">
        <thead>
          <tr>
            <th>{t('accounting.dimensionsPage.code')}</th>
            <th>{t('accounting.dimensionsPage.value')}</th>
            <th>{t('accounting.dimensionsPage.status')}</th>
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
                    {v.status === 'ACTIVE' ? t('common.archive') : t('common.restore')}
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
            label={t('accounting.dimensionsPage.valueCode', { name: type.name })}
            value={value.code}
            onChange={(e) => setValue({ ...value, code: e.target.value })}
            error={addValue.error?.fieldError('code')}
          />
          <TextField
            label={t('accounting.dimensionsPage.valueName', { name: type.name })}
            value={value.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
            error={addValue.error?.fieldError('name')}
          />
          <Button type="submit" busy={addValue.isPending}>
            {t('accounting.dimensionsPage.addValue')}
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
  const t = useT();
  const dimensions = useDimensions();
  return (
    <>
      <PageHeader
        title={t('accounting.dimensionsPage.dimensions')}
        description={t('accounting.dimensionsPage.tagJournalLinesByBranch')}
      />
      <AccountingPage>
        <p className="actions">
          <ExportButton domain="dimension_values" />
        </p>
        <Can permission={Permission.DimensionsManage}>
          <Card title={t('accounting.dimensionsPage.newDimension')}>
            <CreateTypeForm />
          </Card>
        </Can>
        {dimensions.isPending ? (
          <Spinner label={t('accounting.dimensionsPage.loadingDimensions')} />
        ) : dimensions.isError ? (
          <ErrorAlert error={dimensions.error} />
        ) : dimensions.data.length === 0 ? (
          <Card>
            <p className="muted">{t('accounting.dimensionsPage.noDimensionsYet')}</p>
          </Card>
        ) : (
          dimensions.data.map((type) => <DimensionTypeCard key={type.id} type={type} />)
        )}
      </AccountingPage>
    </>
  );
}
