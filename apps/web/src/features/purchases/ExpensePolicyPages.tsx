import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useT } from '../../i18n/i18n';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { PurchasesNav } from './PurchasesSection';

/**
 * Expense policies (migration 0092; master specification section 13): rules the organization sets
 * and the server checks when an expense is posted. Nothing is built in: every amount is yours.
 */

interface Policy {
  id: string;
  name: string;
  ruleType: 'max_amount' | 'receipt_required_above';
  amount: string;
  accountId: string | null;
  action: 'warn' | 'block';
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
}

export function ExpensePoliciesPage() {
  const t = useT();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.PurchasesSettingsManage);
  const canAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canManage && canAccounts);
  const list = useQuery({
    queryKey: ['expense-policies', org],
    queryFn: () => api.get<Policy[]>('/purchases/expense-policies'),
  });
  const blank = { name: '', ruleType: 'max_amount', amount: '', accountId: '', action: 'warn' };
  const [form, setForm] = useState(blank);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['expense-policies', org] });
  const create = useApiMutation(() =>
    api.post('/purchases/expense-policies', {
      name: form.name.trim(),
      ruleType: form.ruleType,
      amount: form.amount.trim(),
      action: form.action,
      ...(form.ruleType === 'max_amount' && form.accountId ? { accountId: form.accountId } : {}),
    }),
  );
  const toggle = useApiMutation((p: Policy) =>
    api.patch(`/purchases/expense-policies/${p.id}`, {
      version: p.version,
      status: p.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE',
    }),
  );
  const expenseAccounts = (accounts.data ?? []).filter(
    (a) => a.type === 'EXPENSE' && a.status === 'ACTIVE' && a.isLeaf !== false,
  );
  const accountName = (id: string | null) => {
    if (!id) return t('policies.wholeExpense');
    const a = accounts.data?.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : t('policies.oneAccount');
  };
  return (
    <>
      <PurchasesNav />
      <PageHeader title={t('policies.title')} description={t('policies.description')} />
      <Card title={t('policies.list')}>
        {list.isPending ? <Spinner /> : null}
        <ErrorAlert error={list.error ?? toggle.error} />
        {list.data && list.data.length === 0 ? <p className="muted">{t('policies.none')}</p> : null}
        {list.data && list.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('policies.name')}</th>
                <th>{t('policies.rule')}</th>
                <th className="num">{t('policies.amount')}</th>
                <th>{t('policies.appliesTo')}</th>
                <th>{t('policies.action')}</th>
                <th>{t('policies.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.ruleType === 'max_amount' ? t('policies.max') : t('policies.receipt')}</td>
                  <td className="num">{p.amount}</td>
                  <td>{p.ruleType === 'max_amount' ? accountName(p.accountId) : '—'}</td>
                  <td>{p.action === 'warn' ? t('policies.warn') : t('policies.block')}</td>
                  <td>{p.status === 'ACTIVE' ? t('policies.active') : t('policies.archived')}</td>
                  <td>
                    {canManage ? (
                      <Button
                        variant="ghost"
                        aria-label={t(
                          p.status === 'ACTIVE' ? 'policies.archiveFor' : 'policies.restoreFor',
                          {
                            name: p.name,
                          },
                        )}
                        onClick={() => toggle.mutate(p, { onSuccess: refresh })}
                      >
                        {p.status === 'ACTIVE' ? t('common.archive') : t('common.restore')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
      {canManage ? (
        <Card title={t('policies.new')}>
          <Alert tone="info">{t('policies.currency')}</Alert>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined, {
                onSuccess: () => {
                  setForm(blank);
                  refresh();
                },
              });
            }}
            noValidate
          >
            <TextField
              label={t('policies.name')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <div className="field">
              <label htmlFor="policy-rule">{t('policies.rule')}</label>
              <select
                id="policy-rule"
                value={form.ruleType}
                onChange={(e) => setForm({ ...form, ruleType: e.target.value })}
              >
                <option value="max_amount">{t('policies.max')}</option>
                <option value="receipt_required_above">{t('policies.receipt')}</option>
              </select>
            </div>
            <TextField
              label={t('policies.amount')}
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
            {form.ruleType === 'max_amount' ? (
              <div className="field">
                <label htmlFor="policy-account">{t('policies.appliesTo')}</label>
                <select
                  id="policy-account"
                  value={form.accountId}
                  onChange={(e) => setForm({ ...form, accountId: e.target.value })}
                >
                  <option value="">{t('policies.wholeExpense')}</option>
                  {expenseAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="policy-action">{t('policies.action')}</label>
              <select
                id="policy-action"
                value={form.action}
                onChange={(e) => setForm({ ...form, action: e.target.value })}
              >
                <option value="warn">{t('policies.warn')}</option>
                <option value="block">{t('policies.block')}</option>
              </select>
              <small className="field__hint">{t('policies.actionHint')}</small>
            </div>
            <ErrorAlert error={create.error} />
            <Button
              type="submit"
              busy={create.isPending}
              disabled={!form.name.trim() || !form.amount.trim()}
            >
              {t('policies.create')}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}
