import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { ExportButton } from '../data-exchange/ExportButton';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { AccountingPage, StatusBadge, useAccountingSetup, useAccounts, useOrgKey } from './shared';
import {
  ACCOUNT_SUBTYPES,
  ACCOUNT_TYPES,
  ALWAYS_MONETARY,
  OPTIONALLY_MONETARY,
  SUBTYPE_LABELS,
  type Account,
  type AccountSubtype,
  type AccountType,
} from './types';

/** Subtype picker limited to the subtypes of the account's nature (Decision 53). */
function SubtypeField({
  id,
  type,
  value,
  onChange,
  error,
}: {
  id: string;
  type: AccountType;
  value: AccountSubtype | '';
  onChange: (value: AccountSubtype | '') => void;
  error?: string | undefined;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Subtype</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as AccountSubtype | '')}
      >
        <option value="">Unclassified</option>
        {ACCOUNT_SUBTYPES[type].map((t) => (
          <option key={t} value={t}>
            {SUBTYPE_LABELS[t]}
          </option>
        ))}
      </select>
      {error ? (
        <small className="field__error" role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}

/** Explicit monetary marking, offered only where Decision 53 allows a choice. */
function MonetaryField({
  subtype,
  checked,
  onChange,
}: {
  subtype: AccountSubtype | '';
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  if (subtype && ALWAYS_MONETARY.includes(subtype)) {
    return <span className="muted">Monetary</span>;
  }
  if (!subtype || !OPTIONALLY_MONETARY.includes(subtype)) return null;
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{' '}
      Monetary (revalued in foreign currency)
    </label>
  );
}

function classificationLabel(account: Account): string {
  if (!account.subtype) return 'Unclassified';
  return SUBTYPE_LABELS[account.subtype] + (account.isMonetary ? ' · monetary' : '');
}

/** Accounts in tree order (parents first), with their depth. */
function treeOrder(accounts: Account[]): { account: Account; depth: number }[] {
  const children = new Map<string | null, Account[]>();
  for (const a of accounts) {
    const list = children.get(a.parentId) ?? [];
    list.push(a);
    children.set(a.parentId, list);
  }
  const out: { account: Account; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const a of (children.get(parentId) ?? []).sort((x, y) => x.code.localeCompare(y.code))) {
      out.push({ account: a, depth });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function CreateAccountForm({ accounts }: { accounts: Account[] }) {
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const baseCurrency = useAccountingSetup().data?.settings?.baseCurrency ?? '';
  const [form, setForm] = useState({
    code: '',
    name: '',
    type: 'ASSET' as AccountType,
    parentId: '',
    currencyCode: '',
    subtype: '' as AccountSubtype | '',
    isMonetary: false,
  });
  const mutation = useApiMutation((input: typeof form) =>
    api.post('/accounting/accounts', {
      code: input.code,
      name: input.name,
      type: input.type,
      parentId: input.parentId || null,
      currencyCode: input.currencyCode.trim().toUpperCase() || undefined,
      subtype: input.subtype || null,
      ...(input.subtype && OPTIONALLY_MONETARY.includes(input.subtype)
        ? { isMonetary: input.isMonetary }
        : {}),
    }),
  );
  const parents = accounts.filter(
    (a) => a.type === form.type && a.status === 'ACTIVE' && !a.usedInPostedJournals,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate(form, {
      onSuccess: () => {
        setForm({ ...form, code: '', name: '' });
        void queryClient.invalidateQueries({ queryKey: ['accounting-accounts', org] });
      },
    });
  };
  return (
    <form className="form form--inline" onSubmit={submit} noValidate>
      <TextField
        label="Code"
        value={form.code}
        onChange={(e) => setForm({ ...form, code: e.target.value })}
        error={mutation.error?.fieldError('code')}
      />
      <TextField
        label="Name"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        error={mutation.error?.fieldError('name')}
      />
      <div className="field">
        <label htmlFor="account-type">Type</label>
        <select
          id="account-type"
          value={form.type}
          onChange={(e) =>
            setForm({
              ...form,
              type: e.target.value as AccountType,
              parentId: '',
              subtype: '',
              isMonetary: false,
            })
          }
        >
          {ACCOUNT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="account-parent">Parent</label>
        <select
          id="account-parent"
          value={form.parentId}
          onChange={(e) => setForm({ ...form, parentId: e.target.value })}
        >
          <option value="">(none)</option>
          {parents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name}
            </option>
          ))}
        </select>
      </div>
      <SubtypeField
        id="account-subtype"
        type={form.type}
        value={form.subtype}
        onChange={(subtype) => setForm({ ...form, subtype, isMonetary: false })}
        error={mutation.error?.fieldError('subtype')}
      />
      <TextField
        label="Currency"
        value={form.currencyCode}
        placeholder={baseCurrency}
        hint="Leave empty for the base currency."
        maxLength={3}
        onChange={(e) => setForm({ ...form, currencyCode: e.target.value })}
        error={mutation.error?.fieldError('currencyCode')}
      />
      <MonetaryField
        subtype={form.subtype}
        checked={form.isMonetary}
        onChange={(isMonetary) => setForm({ ...form, isMonetary })}
      />
      <Button type="submit" busy={mutation.isPending}>
        Add account
      </Button>
      <ErrorAlert error={mutation.error?.issues.length ? null : mutation.error} />
    </form>
  );
}

function AccountRow({ account, depth }: { account: Account; depth: number }) {
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canUpdate = usePermission(Permission.AccountsUpdate);
  const canArchive = usePermission(Permission.AccountsArchive);
  const canDelete = usePermission(Permission.AccountsDelete);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({
    name: account.name,
    subtype: (account.subtype ?? '') as AccountSubtype | '',
    isMonetary: account.isMonetary ?? false,
    currencyCode: account.currencyCode ?? '',
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['accounting-accounts', org] });
  const rename = useApiMutation(() =>
    api.patch(`/accounting/accounts/${account.id}`, {
      name: edit.name,
      subtype: edit.subtype || null,
      currencyCode: edit.currencyCode.trim().toUpperCase(),
      ...(edit.subtype && OPTIONALLY_MONETARY.includes(edit.subtype)
        ? { isMonetary: edit.isMonetary }
        : {}),
    }),
  );
  const archive = useApiMutation(() => api.post(`/accounting/accounts/${account.id}/archive`));
  const remove = useApiMutation(() =>
    sensitive(() => api.delete(`/accounting/accounts/${account.id}`)),
  );
  const error = rename.error ?? archive.error ?? remove.error;

  return (
    <tr>
      <td style={{ paddingLeft: 8 + depth * 18 }}>{account.code}</td>
      <td>
        {editing ? (
          <form
            className="form form--inline"
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate(undefined, { onSuccess: () => (setEditing(false), refresh()) });
            }}
          >
            <TextField
              label="Name"
              value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            />
            <SubtypeField
              id={`subtype-${account.id}`}
              type={account.type}
              value={edit.subtype}
              onChange={(subtype) => setEdit({ ...edit, subtype, isMonetary: false })}
              error={rename.error?.fieldError('subtype')}
            />
            <TextField
              label="Currency"
              value={edit.currencyCode}
              maxLength={3}
              onChange={(e) => setEdit({ ...edit, currencyCode: e.target.value })}
              error={rename.error?.fieldError('currencyCode')}
            />
            <MonetaryField
              subtype={edit.subtype}
              checked={edit.isMonetary}
              onChange={(isMonetary) => setEdit({ ...edit, isMonetary })}
            />
            <Button type="submit" busy={rename.isPending}>
              Save
            </Button>
          </form>
        ) : (
          <>
            {account.name} {account.isLeaf ? null : <span className="muted">(group)</span>}
          </>
        )}
        {error ? <ErrorAlert error={error} /> : null}
      </td>
      <td>{account.type}</td>
      <td>
        {classificationLabel(account)}
        {account.isControlAccount ? <span className="muted"> · control</span> : null}
      </td>
      <td>{account.currencyCode}</td>
      <td>
        <StatusBadge status={account.status} />{' '}
        {account.isSystem ? <span className="muted">system</span> : null}
      </td>
      <td className="actions">
        {canUpdate && !editing ? (
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
        {canArchive && account.status === 'ACTIVE' ? (
          <Button
            variant="ghost"
            busy={archive.isPending}
            onClick={() => archive.mutate(undefined, { onSuccess: refresh })}
          >
            Archive
          </Button>
        ) : null}
        {canDelete && !account.usedInPostedJournals && account.isLeaf ? (
          <Button
            variant="ghost"
            busy={remove.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Delete account ${account.code}? Draft journal lines using it will lose their account.`,
                )
              ) {
                remove.mutate(undefined, { onSuccess: refresh });
              }
            }}
          >
            Delete
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

export function AccountsPage() {
  const accounts = useAccounts();
  const rows = useMemo(() => treeOrder(accounts.data ?? []), [accounts.data]);
  return (
    <>
      <PageHeader
        title="Chart of Accounts"
        description="Only leaf accounts receive postings; parent accounts group them for reporting."
      />
      <AccountingPage>
        <p className="actions">
          <ExportButton domain="chart_of_accounts" />
        </p>
        <Can permission={Permission.AccountsCreate}>
          <Card title="New account">
            <CreateAccountForm accounts={accounts.data ?? []} />
          </Card>
        </Can>
        <Card>
          {accounts.isPending ? (
            <Spinner label="Loading accounts" />
          ) : accounts.isError ? (
            <ErrorAlert error={accounts.error} />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Classification</th>
                  <th>Currency</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ account, depth }) => (
                  <AccountRow key={account.id} account={account} depth={depth} />
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </AccountingPage>
    </>
  );
}
