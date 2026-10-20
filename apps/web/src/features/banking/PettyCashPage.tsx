import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useFormatters, useT } from '../../i18n/i18n';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';

/**
 * Petty cash (migration 0093): funds with a custodian on a cash account, and counts that compare
 * the cash counted with the ledger. A difference is posted to the cash over/short account chosen
 * here. Spending and top-ups are ordinary entries made elsewhere.
 */

interface Fund {
  id: string;
  name: string;
  accountId: string;
  custodianName: string;
  floatAmount: string;
  bookBalance: string;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
}
interface Count {
  id: string;
  number: string;
  fundId: string;
  countDate: string;
  countedAmount: string;
  bookBalance: string;
  difference: string;
}

export function PettyCashPage() {
  const t = useT();
  const format = useFormatters();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.BankingAccountsManage);
  const canCount = usePermission(Permission.BankingReconcile);
  const canAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canAccounts);
  const funds = useQuery({
    queryKey: ['petty-cash-funds', org],
    queryFn: () => api.get<Fund[]>('/petty-cash/funds'),
  });
  const counts = useQuery({
    queryKey: ['petty-cash-counts', org],
    queryFn: () => api.get<Count[]>('/petty-cash/counts'),
  });
  const settings = useQuery({
    queryKey: ['petty-cash-settings', org],
    queryFn: () =>
      api.get<{ overShortAccountId: string | null; version: number }>('/petty-cash/settings'),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['petty-cash-funds', org] });
    void queryClient.invalidateQueries({ queryKey: ['petty-cash-counts', org] });
    void queryClient.invalidateQueries({ queryKey: ['petty-cash-settings', org] });
  };
  const [fundForm, setFundForm] = useState({
    name: '',
    accountId: '',
    custodianName: '',
    floatAmount: '',
  });
  const createFund = useApiMutation(() =>
    api.post('/petty-cash/funds', {
      name: fundForm.name.trim(),
      accountId: fundForm.accountId,
      custodianName: fundForm.custodianName.trim(),
      floatAmount: fundForm.floatAmount.trim(),
    }),
  );
  const [countForm, setCountForm] = useState({
    fundId: '',
    countDate: new Date().toISOString().slice(0, 10),
    countedAmount: '',
    memo: '',
  });
  const record = useApiMutation(() =>
    api.post(`/petty-cash/funds/${countForm.fundId}/counts`, {
      countDate: countForm.countDate,
      countedAmount: countForm.countedAmount.trim(),
      ...(countForm.memo.trim() ? { memo: countForm.memo.trim() } : {}),
    }),
  );
  const [overShort, setOverShort] = useState<string | null>(null);
  const saveSettings = useApiMutation(() =>
    api.put('/petty-cash/settings', {
      overShortAccountId: (overShort ?? settings.data?.overShortAccountId ?? '') || null,
      version: settings.data?.version ?? 0,
    }),
  );
  const cashAccounts = (accounts.data ?? []).filter(
    (a) => a.type === 'ASSET' && a.subtype === 'CASH' && a.status === 'ACTIVE',
  );
  const expenseAccounts = (accounts.data ?? []).filter(
    (a) => a.type === 'EXPENSE' && a.status === 'ACTIVE' && a.isLeaf !== false,
  );
  const fundName = (id: string) => funds.data?.find((f) => f.id === id)?.name ?? id.slice(0, 8);
  const active = (funds.data ?? []).filter((f) => f.status === 'ACTIVE');
  return (
    <>
      <PageHeader title={t('pettyCash.title')} description={t('pettyCash.description')} />
      <Card title={t('pettyCash.funds')}>
        {funds.isPending ? <Spinner /> : null}
        <ErrorAlert error={funds.error} />
        {funds.data && funds.data.length === 0 ? (
          <p className="muted">{t('pettyCash.noFunds')}</p>
        ) : null}
        {funds.data && funds.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('pettyCash.name')}</th>
                <th>{t('pettyCash.custodian')}</th>
                <th className="num">{t('pettyCash.float')}</th>
                <th className="num">{t('pettyCash.bookBalance')}</th>
                <th>{t('pettyCash.status')}</th>
              </tr>
            </thead>
            <tbody>
              {funds.data.map((f) => (
                <tr key={f.id}>
                  <td>{f.name}</td>
                  <td>{f.custodianName}</td>
                  <td className="num">{f.floatAmount}</td>
                  <td className="num">{f.bookBalance}</td>
                  <td>{f.status === 'ACTIVE' ? t('pettyCash.active') : t('pettyCash.archived')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {canManage ? (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              createFund.mutate(undefined, {
                onSuccess: () => {
                  setFundForm({ name: '', accountId: '', custodianName: '', floatAmount: '' });
                  refresh();
                },
              });
            }}
            noValidate
          >
            <TextField
              label={t('pettyCash.fundName')}
              value={fundForm.name}
              onChange={(e) => setFundForm({ ...fundForm, name: e.target.value })}
            />
            <div className="field">
              <label htmlFor="fund-account">{t('pettyCash.cashAccount')}</label>
              <select
                id="fund-account"
                value={fundForm.accountId}
                onChange={(e) => setFundForm({ ...fundForm, accountId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {cashAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label={t('pettyCash.custodian')}
              value={fundForm.custodianName}
              onChange={(e) => setFundForm({ ...fundForm, custodianName: e.target.value })}
            />
            <TextField
              label={t('pettyCash.float')}
              inputMode="decimal"
              value={fundForm.floatAmount}
              onChange={(e) => setFundForm({ ...fundForm, floatAmount: e.target.value })}
            />
            <ErrorAlert error={createFund.error} />
            <Button
              type="submit"
              busy={createFund.isPending}
              disabled={
                !fundForm.name.trim() ||
                !fundForm.accountId ||
                !fundForm.custodianName.trim() ||
                !fundForm.floatAmount.trim()
              }
            >
              {t('pettyCash.addFund')}
            </Button>
          </form>
        ) : null}
      </Card>
      {canManage ? (
        <Card title={t('pettyCash.settings')}>
          <div className="field">
            <label htmlFor="over-short">{t('pettyCash.overShort')}</label>
            <select
              id="over-short"
              value={overShort ?? settings.data?.overShortAccountId ?? ''}
              onChange={(e) => setOverShort(e.target.value)}
            >
              <option value="">{t('common.choose')}</option>
              {expenseAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
            <small className="field__hint">{t('pettyCash.overShortHint')}</small>
          </div>
          <ErrorAlert error={saveSettings.error} />
          <Button
            busy={saveSettings.isPending}
            onClick={() =>
              saveSettings.mutate(undefined, {
                onSuccess: () => {
                  setOverShort(null);
                  refresh();
                },
              })
            }
          >
            {t('pettyCash.saveSettings')}
          </Button>
        </Card>
      ) : null}
      {canCount ? (
        <Card title={t('pettyCash.newCount')}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              record.mutate(undefined, {
                onSuccess: () => {
                  setCountForm({ ...countForm, countedAmount: '', memo: '' });
                  refresh();
                },
              });
            }}
            noValidate
          >
            <div className="field">
              <label htmlFor="count-fund">{t('pettyCash.fund')}</label>
              <select
                id="count-fund"
                value={countForm.fundId}
                onChange={(e) => setCountForm({ ...countForm, fundId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {active.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label={t('pettyCash.countDate')}
              type="date"
              value={countForm.countDate}
              onChange={(e) => setCountForm({ ...countForm, countDate: e.target.value })}
            />
            <TextField
              label={t('pettyCash.counted')}
              inputMode="decimal"
              value={countForm.countedAmount}
              onChange={(e) => setCountForm({ ...countForm, countedAmount: e.target.value })}
            />
            <TextField
              label={t('pettyCash.memo')}
              value={countForm.memo}
              onChange={(e) => setCountForm({ ...countForm, memo: e.target.value })}
            />
            <ErrorAlert error={record.error} />
            <Button
              type="submit"
              busy={record.isPending}
              disabled={!countForm.fundId || !countForm.countedAmount.trim()}
            >
              {t('pettyCash.record')}
            </Button>
          </form>
        </Card>
      ) : null}
      <Card title={t('pettyCash.counts')}>
        {counts.data && counts.data.length === 0 ? (
          <p className="muted">{t('pettyCash.noCounts')}</p>
        ) : null}
        {counts.data && counts.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('pettyCash.number')}</th>
                <th>{t('pettyCash.fund')}</th>
                <th>{t('pettyCash.countDate')}</th>
                <th className="num">{t('pettyCash.counted')}</th>
                <th className="num">{t('pettyCash.bookBalance')}</th>
                <th className="num">{t('pettyCash.difference')}</th>
              </tr>
            </thead>
            <tbody>
              {counts.data.map((c) => (
                <tr key={c.id}>
                  <td>{c.number}</td>
                  <td>{fundName(c.fundId)}</td>
                  <td>{format.date(c.countDate)}</td>
                  <td className="num">{c.countedAmount}</td>
                  <td className="num">{c.bookBalance}</td>
                  <td className="num">{c.difference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </>
  );
}
