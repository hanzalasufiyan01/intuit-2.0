import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
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

/**
 * Reconciliation, transfers, rules and bank entries. A reconciliation compares the matched
 * transactions with the statement and never changes a posted journal line.
 */

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export function ReconcilePage() {
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
    const reason = window.prompt('Why is this reconciliation reopened?');
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
        title={`Reconcile ${a.name}`}
        description="Enter the closing balance of the statement. It balances when the matched transactions explain it."
      />
      <p>
        <Link to={`/banking/accounts/${id}`}>← {a.name}</Link>
      </p>
      <Card title="Statement">
        <form onSubmit={submit} className="form-grid">
          <TextField
            label="Statement date"
            type="date"
            value={statementDate}
            required
            onChange={(e) => setStatementDate(e.target.value)}
          />
          <TextField
            label={`Closing balance (${a.currencyCode})`}
            value={statementBalance}
            required
            inputMode="decimal"
            onChange={(e) => setStatementBalance(e.target.value)}
          />
          <div>
            <Button type="submit" busy={preview.isPending}>
              Check
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
                    Opening balance
                    {p.openingFrom ? ` (statement of ${p.openingFrom.statementDate})` : ''}
                  </td>
                  <td className="num">{formatAmount(p.openingBalance, a.currencyCode)}</td>
                </tr>
                <tr>
                  <td>Matched transactions ({p.items.length})</td>
                  <td className="num">{formatAmount(p.clearedTotal, a.currencyCode)}</td>
                </tr>
                <tr>
                  <td>Statement closing balance</td>
                  <td className="num">{formatAmount(p.statementBalance, a.currencyCode)}</td>
                </tr>
                <tr>
                  <th>Difference</th>
                  <th className="num">{formatAmount(p.difference, a.currencyCode)}</th>
                </tr>
                <tr>
                  <td className="muted">Book balance on that date</td>
                  <td className="num muted">{formatAmount(p.bookBalance, a.currencyCode)}</td>
                </tr>
              </tbody>
            </table>
            {p.unmatchedCount ? (
              <Alert tone="info">
                {p.unmatchedCount} transaction{p.unmatchedCount === 1 ? ' is' : 's are'} not matched
                yet. <Link to={`/banking/accounts/${id}`}>Match or categorize them.</Link>
              </Alert>
            ) : null}
            {canReconcile ? (
              <Button
                busy={complete.isPending}
                disabled={!p.canComplete}
                onClick={() => complete.mutate(undefined, { onSuccess: refresh })}
              >
                Finish reconciliation
              </Button>
            ) : null}
            {complete.isError ? <ErrorAlert error={complete.error} /> : null}
          </>
        ) : null}
      </Card>
      <Card title="History">
        {history.isPending ? (
          <Spinner />
        ) : history.data?.items.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Statement date</th>
                <th className="num">Closing balance</th>
                <th className="num">Transactions</th>
                <th>Status</th>
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
                    {r.status === 'COMPLETED' ? 'Completed' : `Reopened: ${r.reopenReason ?? ''}`}
                  </td>
                  <td>
                    {canReconcile && r.id === latestId ? (
                      <Button
                        variant="ghost"
                        busy={reopen.isPending}
                        onClick={() => reopen.mutate(r, { onSuccess: refresh })}
                      >
                        Reopen
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No reconciliations yet.</p>
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
    const reason = window.prompt('Why is this transfer voided?');
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
        title="Transfers"
        description="Move money between your own bank accounts. A transfer posts to the ledger; it is not income or expense."
      />
      {canCreate ? (
        <Card title="New transfer">
          <form onSubmit={submit} className="form-grid">
            <TextField
              label="Date"
              type="date"
              value={form.transferDate}
              required
              onChange={(e) => setForm({ ...form, transferDate: e.target.value })}
              error={error?.fieldError('transferDate')}
            />
            <div className="field">
              <label htmlFor="transfer-from">From</label>
              <select
                id="transfer-from"
                value={form.fromBankingAccountId}
                required
                onChange={(e) => setForm({ ...form, fromBankingAccountId: e.target.value })}
              >
                <option value="">Choose…</option>
                {active.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.currencyCode})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="transfer-to">To</label>
              <select
                id="transfer-to"
                value={form.toBankingAccountId}
                required
                onChange={(e) => setForm({ ...form, toBankingAccountId: e.target.value })}
              >
                <option value="">Choose…</option>
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
              label={`Amount sent${from ? ` (${from.currencyCode})` : ''}`}
              value={form.fromAmount}
              required
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, fromAmount: e.target.value })}
              error={error?.fieldError('fromAmount')}
            />
            {crossCurrency ? (
              <TextField
                label={`Amount received${to ? ` (${to.currencyCode})` : ''}`}
                value={form.toAmount}
                required
                inputMode="decimal"
                onChange={(e) => setForm({ ...form, toAmount: e.target.value })}
                hint="The exchange rate is implied by the two amounts."
                error={error?.fieldError('toAmount')}
              />
            ) : null}
            <TextField
              label="Memo"
              value={form.memo}
              maxLength={500}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
            />
            <div>
              <Button type="submit" busy={create.isPending}>
                Record transfer
              </Button>
            </div>
          </form>
          {create.isError && !error?.issues.length ? <ErrorAlert error={create.error} /> : null}
        </Card>
      ) : null}
      <Card title="Recorded transfers">
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">No transfers yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>From</th>
                <th>To</th>
                <th className="num">Sent</th>
                <th className="num">Received</th>
                <th>Status</th>
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
                    <span
                      className={`badge badge--${t.status === 'POSTED' ? 'posted' : 'reversed'}`}
                    >
                      {t.status === 'POSTED' ? 'Posted' : 'Void'}
                    </span>
                  </td>
                  <td>
                    {canVoid && t.status === 'POSTED' ? (
                      <Button
                        variant="ghost"
                        busy={voidIt.isPending}
                        onClick={() => voidIt.mutate(t, { onSuccess: refresh })}
                      >
                        Void
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
    const reason = window.prompt('Why is this entry voided?');
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
      <PageHeader title={`Bank entry ${e.number}`} description={e.memo || undefined} />
      <p>
        <Link to={`/banking/accounts/${e.bankingAccountId}`}>← Bank account</Link>
      </p>
      <Card>
        <table className="table">
          <tbody>
            <tr>
              <th>Date</th>
              <td>{e.date}</td>
            </tr>
            <tr>
              <th>{e.direction === 'in' ? 'Received' : 'Paid'}</th>
              <td>
                {formatAmount(e.amount, e.currencyCode)} {e.currencyCode}
              </td>
            </tr>
            <tr>
              <th>Status</th>
              <td>{e.status === 'POSTED' ? 'Posted' : `Void: ${e.voidReason ?? ''}`}</td>
            </tr>
            <tr>
              <th>Journal</th>
              <td>
                <Link to={`/accounting/journals/${e.journalId}`}>Open the journal</Link>
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
            Void entry
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
        title="Bank rules"
        description="A rule suggests a category for an unmatched transaction. Rules never post anything by themselves; the lowest priority number wins."
      />
      {canManage ? (
        <Card title="New rule">
          <form onSubmit={submit} className="form-grid">
            <TextField
              label="Name"
              value={form.name}
              required
              maxLength={100}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              error={error?.fieldError('name')}
            />
            <div className="field">
              <label htmlFor="rule-direction">Money</label>
              <select
                id="rule-direction"
                value={form.direction}
                onChange={(e) => setForm({ ...form, direction: e.target.value })}
              >
                <option value="any">In or out</option>
                <option value="out">Out</option>
                <option value="in">In</option>
              </select>
            </div>
            <TextField
              label="Description contains"
              value={form.descriptionContains}
              maxLength={200}
              onChange={(e) => setForm({ ...form, descriptionContains: e.target.value })}
              error={error?.fieldError('descriptionContains')}
            />
            <div className="field">
              <label htmlFor="rule-category">Suggest the account</label>
              <select
                id="rule-category"
                value={form.categoryAccountId}
                required
                onChange={(e) => setForm({ ...form, categoryAccountId: e.target.value })}
              >
                <option value="">Choose an account…</option>
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
              label="Priority"
              type="number"
              min={1}
              max={10000}
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
            />
            <div>
              <Button type="submit" busy={create.isPending}>
                Add rule
              </Button>
            </div>
          </form>
          {create.isError && !error?.issues.length ? <ErrorAlert error={create.error} /> : null}
        </Card>
      ) : null}
      <Card title="Rules">
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">No rules yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Priority</th>
                <th>Name</th>
                <th>When</th>
                <th>Suggests</th>
                <th>Status</th>
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
                      r.direction === 'any' ? null : `money ${r.direction}`,
                      r.descriptionContains
                        ? `description contains “${r.descriptionContains}”`
                        : null,
                      r.minAmount ? `at least ${r.minAmount}` : null,
                      r.maxAmount ? `at most ${r.maxAmount}` : null,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </td>
                  <td>{nameOf(r.categoryAccountId)}</td>
                  <td>
                    <span className={`badge badge--${r.status.toLowerCase()}`}>{r.status}</span>
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
                        {r.status === 'ACTIVE' ? 'Archive' : 'Restore'}
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
