import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { AccountingPage, StatusBadge, useAccounts, useOrgKey } from './shared';
import { ACCOUNT_TYPES, type Account, type AccountType } from './types';

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
  const [form, setForm] = useState({
    code: '',
    name: '',
    type: 'ASSET' as AccountType,
    parentId: '',
  });
  const mutation = useApiMutation((input: typeof form) =>
    api.post('/accounting/accounts', { ...input, parentId: input.parentId || null }),
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
          onChange={(e) => setForm({ ...form, type: e.target.value as AccountType, parentId: '' })}
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
  const [name, setName] = useState(account.name);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['accounting-accounts', org] });
  const rename = useApiMutation(() => api.patch(`/accounting/accounts/${account.id}`, { name }));
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
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
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
        <StatusBadge status={account.status} />{' '}
        {account.isSystem ? <span className="muted">system</span> : null}
      </td>
      <td className="actions">
        {canUpdate && !editing ? (
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Rename
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
