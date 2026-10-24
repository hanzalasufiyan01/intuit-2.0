import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Badge, toneOf, type BadgeTone } from '../../shared/ui/Badge';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { useBankAccounts, useOrgKey } from './BankingSection';
import type {
  BankAccount,
  BankEntry,
  BankRule,
  BankTransfer,
  Reconciliation,
  ReconciliationPreview,
} from './types';
import { useT } from '../../i18n/i18n';

/**
 * Reconciliation, transfers, rules and bank entries. A reconciliation compares the matched
 * transactions with the statement and never changes a posted journal line.
 */

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export function ReconcilePage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const [statementDate, setStatementDate] = useState(today());
  const [statementBalance, setStatementBalance] = useState('');
  const account = useQuery({
    queryKey: ['banking-account', org, id],
    queryFn: () => api.get<BankAccount>(`/banking/accounts/${id}`),
  });
  const history = useQuery({
    queryKey: ['banking-reconciliations', org, id],
    queryFn: () => api.get<{ items: Reconciliation[] }>(`/banking/accounts/${id}/reconciliations`),
  });
  const preview = useApiMutation(() =>
    api.post<ReconciliationPreview>(`/banking/accounts/${id}/reconciliation/preview`, {
      statementDate,
      statementBalance: statementBalance.trim(),
    }),
  );
  const complete = useApiMutation(() =>
    api.post<Reconciliation>(`/banking/accounts/${id}/reconciliations`, {
      statementDate,
      statementBalance: statementBalance.trim(),
    }),
  );
  const reopen = useApiMutation((r: Reconciliation) => {
    const reason = window.prompt(t('banking.bankingPages.whyIsThisReconciliationReopened'));
    if (!reason?.trim()) return Promise.resolve(null);
    return sensitive(() =>
      api.post(`/banking/reconciliations/${r.id}/reopen`, {
        version: r.version,
        reason: reason.trim(),
      }),
    );
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['banking-reconciliations', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['banking-account', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['banking-accounts', org] });
    preview.reset();
  };
  const canReconcile = usePermission(Permission.BankingReconcile);
  if (account.isPending) return <Spinner />;
  if (account.isError) return <ErrorAlert error={account.error} />;
  const a = account.data;
  const p = preview.data;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    preview.mutate();
  };
  const latestId = history.data?.items.find((r) => r.status === 'COMPLETED')?.id;
  return (
    <>
      <PageHeader
        title={t('banking.bankingPages.reconcile', { name: a.name })}
        description={t('banking.bankingPages.enterTheClosingBalanceOf')}
      />
      <p>
        <Link to={`/banking/accounts/${id}`}>← {a.name}</Link>
      </p>
      <Card title={t('banking.bankingPages.statement')}>
        <form onSubmit={submit} className="form-grid">
          <TextField
            label={t('banking.bankingPages.statementDate')}
            type="date"
            value={statementDate}
            required
            onChange={(e) => setStatementDate(e.target.value)}
          />
          <TextField
            label={t('banking.bankingPages.closingBalance', { currencyCode: a.currencyCode })}
            value={statementBalance}
            required
            inputMode="decimal"
            onChange={(e) => setStatementBalance(e.target.value)}
          />
          <div>
            <Button type="submit" busy={preview.isPending}>
              {t('banking.bankingPages.check')}
            </Button>
          </div>
        </form>
        {preview.isError ? <ErrorAlert error={preview.error} /> : null}
        {p ? (
          <>
            <table className="table">
              <tbody>
                <tr>
                  <td>
                    {t('banking.bankingPages.openingBalance', {
                      value: p.openingFrom
                        ? t('banking.bankingPages.statementOf', {
                            statementDate: p.openingFrom.statementDate,
                          })
                        : '',
                    })}
                  </td>
                  <td className="num">{formatAmount(p.openingBalance, a.currencyCode)}</td>
                </tr>
                <tr>
                  <td>
                    {t('banking.bankingPages.matchedTransactions', { count: p.items.length })}
                  </td>
                  <td className="num">{formatAmount(p.clearedTotal, a.currencyCode)}</td>
                </tr>
                <tr>
                  <td>{t('banking.bankingPages.statementClosingBalance')}</td>
                  <td className="num">{formatAmount(p.statementBalance, a.currencyCode)}</td>
                </tr>
                <tr>
                  <th>{t('banking.bankingPages.difference')}</th>
                  <th className="num">{formatAmount(p.difference, a.currencyCode)}</th>
                </tr>
                <tr>
                  <td className="muted">{t('banking.bankingPages.bookBalanceOnThatDate')}</td>
                  <td className="num muted">{formatAmount(p.bookBalance, a.currencyCode)}</td>
                </tr>
              </tbody>
            </table>
            {p.unmatchedCount ? (
              <Alert tone="info">
                {t('banking.bankingPages.transactionNotMatchedYet', {
                  unmatchedCount: p.unmatchedCount,
                  value:
                    p.unmatchedCount === 1
                      ? t('banking.bankingPages.is')
                      : t('banking.bankingPages.sAre'),
                })}{' '}
                <Link to={`/banking/accounts/${id}`}>
                  {t('banking.bankingPages.matchOrCategorizeThem')}
                </Link>
              </Alert>
            ) : null}
            {canReconcile ? (
              <Button
                busy={complete.isPending}
                disabled={!p.canComplete}
                onClick={() => complete.mutate(undefined, { onSuccess: refresh })}
              >
                {t('banking.bankingPages.finishReconciliation')}
              </Button>
            ) : null}
            {complete.isError ? <ErrorAlert error={complete.error} /> : null}
          </>
        ) : null}
      </Card>
      <Card title={t('banking.bankingPages.history')}>
        {history.isPending ? (
          <Spinner />
        ) : history.data?.items.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('banking.bankingPages.statementDate')}</th>
                <th className="num">{t('banking.bankingPages.closingBalance2')}</th>
                <th className="num">{t('banking.bankingPages.transactions')}</th>
                <th>{t('banking.bankingPages.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.statementDate}</td>
                  <td className="num">{formatAmount(r.statementBalance, a.currencyCode)}</td>
                  <td className="num">{r.itemCount}</td>
                  <td>
                    {r.status === 'COMPLETED'
                      ? t('banking.bankingPages.completed')
                      : t('banking.bankingPages.reopened', { reopenReason: r.reopenReason ?? '' })}
                  </td>
                  <td>
                    {canReconcile && r.id === latestId ? (
                      <Button
                        variant="ghost"
                        busy={reopen.isPending}
                        onClick={() => reopen.mutate(r, { onSuccess: refresh })}
                      >
                        {t('banking.bankingPages.reopen')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">{t('banking.bankingPages.noReconciliationsYet')}</p>
        )}
        {reopen.isError ? <ErrorAlert error={reopen.error} /> : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export function TransfersPage() {
  const translate = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canCreate = usePermission(Permission.BankingTransfersCreate);
  const canVoid = usePermission(Permission.BankingTransfersVoid);
  const sensitive = useSensitiveAction();
  const accounts = useBankAccounts();
  const list = useQuery({
    queryKey: ['banking-transfers', org],
    queryFn: () => api.get<{ items: BankTransfer[] }>('/banking/transfers?limit=100'),
  });
  const [form, setForm] = useState({
    transferDate: today(),
    fromBankingAccountId: '',
    toBankingAccountId: '',
    fromAmount: '',
    toAmount: '',
    memo: '',
  });
  const active = (accounts.data?.items ?? []).filter((a) => a.status === 'ACTIVE');
  const from = active.find((a) => a.id === form.fromBankingAccountId);
  const to = active.find((a) => a.id === form.toBankingAccountId);
  const crossCurrency = Boolean(from && to && from.currencyCode !== to.currencyCode);
  const create = useApiMutation(() =>
    api.post<BankTransfer>(
      '/banking/transfers',
      {
        transferDate: form.transferDate,
        fromBankingAccountId: form.fromBankingAccountId,
        toBankingAccountId: form.toBankingAccountId,
        fromAmount: form.fromAmount.trim(),
        ...(crossCurrency && form.toAmount.trim() ? { toAmount: form.toAmount.trim() } : {}),
        ...(form.memo.trim() ? { memo: form.memo.trim() } : {}),
      },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const voidIt = useApiMutation((t: BankTransfer) => {
    const reason = window.prompt(translate('banking.bankingPages.whyIsThisTransferVoided'));
    if (!reason?.trim()) return Promise.resolve(null);
    return sensitive(() =>
      api.post(`/banking/transfers/${t.id}/void`, { version: t.version, reason: reason.trim() }),
    );
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['banking-transfers', org] });
    void queryClient.invalidateQueries({ queryKey: ['banking-accounts', org] });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: () => {
        setForm({ ...form, fromAmount: '', toAmount: '', memo: '' });
        refresh();
      },
    });
  };
  const error = create.error instanceof ApiError ? create.error : null;
  return (
    <>
      <PageHeader
        title={translate('banking.bankingPages.transfers')}
        description={translate('banking.bankingPages.moveMoneyBetweenYourOwn')}
      />
      {canCreate ? (
        <Card title={translate('banking.bankingPages.newTransfer')}>
          <form onSubmit={submit} className="form-grid">
            <TextField
              label={translate('banking.bankingPages.date')}
              type="date"
              value={form.transferDate}
              required
              onChange={(e) => setForm({ ...form, transferDate: e.target.value })}
              error={error?.fieldError('transferDate')}
            />
            <div className="field">
              <label htmlFor="transfer-from">{translate('banking.bankingPages.from')}</label>
              <select
                id="transfer-from"
                value={form.fromBankingAccountId}
                required
                onChange={(e) => setForm({ ...form, fromBankingAccountId: e.target.value })}
              >
                <option value="">{translate('common.choose')}</option>
                {active.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.currencyCode})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="transfer-to">{translate('banking.bankingPages.to')}</label>
              <select
                id="transfer-to"
                value={form.toBankingAccountId}
                required
                onChange={(e) => setForm({ ...form, toBankingAccountId: e.target.value })}
              >
                <option value="">{translate('common.choose')}</option>
                {active
                  .filter((a) => a.id !== form.fromBankingAccountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.currencyCode})
                    </option>
                  ))}
              </select>
              {error?.fieldError('toBankingAccountId') ? (
                <small className="field__error" role="alert">
                  {error.fieldError('toBankingAccountId')}
                </small>
              ) : null}
            </div>
            <TextField
              label={translate('banking.bankingPages.amountSent', {
                value: from ? ` (${from.currencyCode})` : '',
              })}
              value={form.fromAmount}
              required
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, fromAmount: e.target.value })}
              error={error?.fieldError('fromAmount')}
            />
            {crossCurrency ? (
              <TextField
                label={translate('banking.bankingPages.amountReceived', {
                  value: to ? ` (${to.currencyCode})` : '',
                })}
                value={form.toAmount}
                required
                inputMode="decimal"
                onChange={(e) => setForm({ ...form, toAmount: e.target.value })}
                hint={translate('banking.bankingPages.theExchangeRateIsImplied')}
                error={error?.fieldError('toAmount')}
              />
            ) : null}
            <TextField
              label={translate('banking.bankingPages.memo')}
              value={form.memo}
              maxLength={500}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
            />
            <div>
              <Button type="submit" busy={create.isPending}>
                {translate('banking.bankingPages.recordTransfer')}
              </Button>
            </div>
          </form>
          {create.isError && !error?.issues.length ? <ErrorAlert error={create.error} /> : null}
        </Card>
      ) : null}
      <Card title={translate('banking.bankingPages.recordedTransfers')}>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">{translate('banking.bankingPages.noTransfersYet')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{translate('banking.bankingPages.number')}</th>
                <th>{translate('banking.bankingPages.date')}</th>
                <th>{translate('banking.bankingPages.from')}</th>
                <th>{translate('banking.bankingPages.to')}</th>
                <th className="num">{translate('banking.bankingPages.sent')}</th>
                <th className="num">{translate('banking.bankingPages.received')}</th>
                <th>{translate('banking.bankingPages.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/accounting/journals/${t.journalId}`}>{t.number}</Link>
                  </td>
                  <td>{t.date}</td>
                  <td>{t.fromName}</td>
                  <td>{t.toName}</td>
                  <td className="num">
                    {formatAmount(t.fromAmount, t.fromCurrencyCode)} {t.fromCurrencyCode}
                  </td>
                  <td className="num">
                    {formatAmount(t.toAmount, t.toCurrencyCode)} {t.toCurrencyCode}
                  </td>
                  <td>
                    <TransferStatusBadge status={t.status} />
                  </td>
                  <td>
                    {canVoid && t.status === 'POSTED' ? (
                      <Button
                        variant="ghost"
                        busy={voidIt.isPending}
                        onClick={() => voidIt.mutate(t, { onSuccess: refresh })}
                      >
                        {translate('banking.bankingPages.void')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {voidIt.isError ? <ErrorAlert error={voidIt.error} /> : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Bank entry (the document a categorized transaction posts)
// ---------------------------------------------------------------------------

export function BankEntryPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canVoid = usePermission(Permission.BankingTransfersVoid);
  const entry = useQuery({
    queryKey: ['banking-entry', org, id],
    queryFn: () => api.get<BankEntry>(`/banking/entries/${id}`),
  });
  const voidIt = useApiMutation((e: BankEntry) => {
    const reason = window.prompt(t('banking.bankingPages.whyIsThisEntryVoided'));
    if (!reason?.trim()) return Promise.resolve(null);
    return sensitive(() =>
      api.post(`/banking/entries/${e.id}/void`, { version: e.version, reason: reason.trim() }),
    );
  });
  if (entry.isPending) return <Spinner />;
  if (entry.isError) return <ErrorAlert error={entry.error} />;
  const e = entry.data;
  return (
    <>
      <PageHeader
        title={t('banking.bankingPages.bankEntry', { number: e.number })}
        description={e.memo || undefined}
      />
      <p>
        <Link to={`/banking/accounts/${e.bankingAccountId}`}>
          {t('banking.bankingPages.bankAccount')}
        </Link>
      </p>
      <Card>
        <table className="table">
          <tbody>
            <tr>
              <th>{t('banking.bankingPages.date')}</th>
              <td>{e.date}</td>
            </tr>
            <tr>
              <th>
                {e.direction === 'in'
                  ? t('banking.bankingPages.received')
                  : t('banking.bankingPages.paid')}
              </th>
              <td>
                {formatAmount(e.amount, e.currencyCode)} {e.currencyCode}
              </td>
            </tr>
            <tr>
              <th>{t('banking.bankingPages.status')}</th>
              <td>
                {e.status === 'POSTED'
                  ? t('banking.bankingPages.posted')
                  : t('banking.bankingPages.void2', { voidReason: e.voidReason ?? '' })}
              </td>
            </tr>
            <tr>
              <th>{t('banking.bankingPages.journal')}</th>
              <td>
                <Link to={`/accounting/journals/${e.journalId}`}>
                  {t('banking.bankingPages.openTheJournal')}
                </Link>
              </td>
            </tr>
          </tbody>
        </table>
        {canVoid && e.status === 'POSTED' ? (
          <Button
            variant="secondary"
            busy={voidIt.isPending}
            onClick={() =>
              voidIt.mutate(e, {
                onSuccess: () =>
                  void queryClient.invalidateQueries({ queryKey: ['banking-entry', org, id] }),
              })
            }
          >
            {t('banking.bankingPages.voidEntry')}
          </Button>
        ) : null}
        {voidIt.isError ? <ErrorAlert error={voidIt.error} /> : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export function BankRulesPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.BankingRulesManage);
  const canSeeAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canSeeAccounts);
  const list = useQuery({
    queryKey: ['banking-rules', org],
    queryFn: () => api.get<{ items: BankRule[] }>('/banking/rules'),
  });
  const [form, setForm] = useState({
    name: '',
    direction: 'any',
    descriptionContains: '',
    categoryAccountId: '',
    priority: '100',
  });
  const nameOf = (accountId: string) => {
    const a = accounts.data?.find((x) => x.id === accountId);
    return a ? `${a.code} ${a.name}` : accountId;
  };
  const create = useApiMutation(() =>
    api.post<BankRule>('/banking/rules', {
      name: form.name.trim(),
      direction: form.direction,
      ...(form.descriptionContains.trim()
        ? { descriptionContains: form.descriptionContains.trim() }
        : {}),
      categoryAccountId: form.categoryAccountId,
      priority: Number(form.priority) || 100,
    }),
  );
  const setStatus = useApiMutation((input: { rule: BankRule; to: 'archive' | 'restore' }) =>
    api.post(`/banking/rules/${input.rule.id}/${input.to}`, { version: input.rule.version }),
  );
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['banking-rules', org] });
  const options = (accounts.data ?? []).filter(
    (a) => a.status === 'ACTIVE' && a.isLeaf && !a.isControlAccount && !a.isBankOrCash,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: () => {
        setForm({ ...form, name: '', descriptionContains: '' });
        refresh();
      },
    });
  };
  const error = create.error instanceof ApiError ? create.error : null;
  return (
    <>
      <PageHeader
        title={t('banking.bankingPages.bankRules')}
        description={t('banking.bankingPages.aRuleSuggestsACategory')}
      />
      {canManage ? (
        <Card title={t('banking.bankingPages.newRule')}>
          <form onSubmit={submit} className="form-grid">
            <TextField
              label={t('banking.bankingPages.name')}
              value={form.name}
              required
              maxLength={100}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              error={error?.fieldError('name')}
            />
            <div className="field">
              <label htmlFor="rule-direction">{t('banking.bankingPages.money')}</label>
              <select
                id="rule-direction"
                value={form.direction}
                onChange={(e) => setForm({ ...form, direction: e.target.value })}
              >
                <option value="any">{t('banking.bankingPages.inOrOut')}</option>
                <option value="out">{t('banking.bankingPages.out')}</option>
                <option value="in">{t('banking.bankingPages.in')}</option>
              </select>
            </div>
            <TextField
              label={t('banking.bankingPages.descriptionContains')}
              value={form.descriptionContains}
              maxLength={200}
              onChange={(e) => setForm({ ...form, descriptionContains: e.target.value })}
              error={error?.fieldError('descriptionContains')}
            />
            <div className="field">
              <label htmlFor="rule-category">{t('banking.bankingPages.suggestTheAccount')}</label>
              <select
                id="rule-category"
                value={form.categoryAccountId}
                required
                onChange={(e) => setForm({ ...form, categoryAccountId: e.target.value })}
              >
                <option value="">{t('banking.bankingPages.chooseAnAccount')}</option>
                {options.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
              {error?.fieldError('categoryAccountId') ? (
                <small className="field__error" role="alert">
                  {error.fieldError('categoryAccountId')}
                </small>
              ) : null}
            </div>
            <TextField
              label={t('banking.bankingPages.priority')}
              type="number"
              min={1}
              max={10000}
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
            />
            <div>
              <Button type="submit" busy={create.isPending}>
                {t('banking.bankingPages.addRule')}
              </Button>
            </div>
          </form>
          {create.isError && !error?.issues.length ? <ErrorAlert error={create.error} /> : null}
        </Card>
      ) : null}
      <Card title={t('banking.bankingPages.rules')}>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">{t('banking.bankingPages.noRulesYet')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('banking.bankingPages.priority')}</th>
                <th>{t('banking.bankingPages.name')}</th>
                <th>{t('banking.bankingPages.when')}</th>
                <th>{t('banking.bankingPages.suggests')}</th>
                <th>{t('banking.bankingPages.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.priority}</td>
                  <td>{r.name}</td>
                  <td>
                    {[
                      r.direction === 'any'
                        ? null
                        : r.direction === 'in'
                          ? t('banking.bankingPages.ruleMoneyIn')
                          : t('banking.bankingPages.ruleMoneyOut'),
                      r.descriptionContains
                        ? t('banking.bankingPages.ruleDescriptionContains', {
                            text: r.descriptionContains,
                          })
                        : null,
                      r.minAmount
                        ? t('banking.bankingPages.ruleAtLeast', { amount: r.minAmount })
                        : null,
                      r.maxAmount
                        ? t('banking.bankingPages.ruleAtMost', { amount: r.maxAmount })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </td>
                  <td>{nameOf(r.categoryAccountId)}</td>
                  <td>
                    <RuleStatusBadge status={r.status} />
                  </td>
                  <td>
                    {canManage ? (
                      <Button
                        variant="ghost"
                        busy={setStatus.isPending}
                        onClick={() =>
                          setStatus.mutate(
                            { rule: r, to: r.status === 'ACTIVE' ? 'archive' : 'restore' },
                            { onSuccess: refresh },
                          )
                        }
                      >
                        {r.status === 'ACTIVE' ? t('common.archive') : t('common.restore')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {setStatus.isError ? <ErrorAlert error={setStatus.error} /> : null}
      </Card>
    </>
  );
}

const TRANSFER_STATUS_TONE: Record<'POSTED' | 'VOID', BadgeTone> = {
  POSTED: 'success',
  VOID: 'danger',
};

/** A transfer's status: posted is success, void is danger, any other status is neutral and shown as it came. */
export function TransferStatusBadge({ status }: { status: string }) {
  const t = useT();
  const label =
    status === 'POSTED'
      ? t('banking.bankingPages.posted')
      : status === 'VOID'
        ? t('banking.bankingPages.void')
        : status;
  return <Badge tone={toneOf(TRANSFER_STATUS_TONE, status)}>{label}</Badge>;
}

const RULE_STATUS_TONE: Record<'ACTIVE' | 'ARCHIVED', BadgeTone> = {
  ACTIVE: 'success',
  ARCHIVED: 'neutral',
};

/** A bank rule's status, translated; a status the page does not know is neutral and shown as it came. */
export function RuleStatusBadge({ status }: { status: string }) {
  const t = useT();
  const label =
    status === 'ACTIVE'
      ? t('banking.bankingPages.ruleStatus.ACTIVE')
      : status === 'ARCHIVED'
        ? t('banking.bankingPages.ruleStatus.ARCHIVED')
        : status;
  return <Badge tone={toneOf(RULE_STATUS_TONE, status)}>{label}</Badge>;
}
