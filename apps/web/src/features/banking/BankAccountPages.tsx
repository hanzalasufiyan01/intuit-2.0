import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
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
  BankTransaction,
  BankTransactionStatus,
  ImportResult,
  MatchSuggestion,
} from './types';

/**
 * Bank accounts and their statement transactions: import (CSV with a column mapping, or OFX),
 * match to posted journal lines, categorize into a bank entry, exclude, or leave for later. The
 * server authorizes and validates everything; these pages only guide. Nothing here changes a
 * posted journal.
 */

const STATUS_LABEL: Record<BankTransactionStatus, string> = {
  UNMATCHED: 'Unmatched',
  MATCHED: 'Matched',
  EXCLUDED: 'Excluded',
};

function StatusBadge({ status }: { status: BankTransactionStatus }) {
  const tone = status === 'MATCHED' ? 'posted' : status === 'EXCLUDED' ? 'archived' : 'pending';
  return <span className={`badge badge--${tone}`}>{STATUS_LABEL[status]}</span>;
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

export function BankAccountsPage() {
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.BankingAccountsManage);
  const canSeeAccounts = usePermission(Permission.AccountsView);
  const list = useBankAccounts();
  const accounts = useAccounts(canManage && canSeeAccounts);
  const [accountId, setAccountId] = useState('');
  const [name, setName] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [openingDate, setOpeningDate] = useState('');
  const taken = new Set((list.data?.items ?? []).map((a) => a.accountId));
  const eligible = (accounts.data ?? []).filter(
    (a) =>
      a.status === 'ACTIVE' &&
      a.isLeaf &&
      !a.isControlAccount &&
      (a.subtype === 'BANK' || a.subtype === 'CASH' || a.subtype === 'CREDIT_CARD') &&
      !taken.has(a.id),
  );
  const create = useApiMutation(() =>
    api.post<BankAccount>('/banking/accounts', {
      accountId,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(openingBalance.trim() ? { openingBalance: openingBalance.trim() } : {}),
      ...(openingDate ? { openingBalanceDate: openingDate } : {}),
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: () => {
        setAccountId('');
        setName('');
        setOpeningBalance('');
        setOpeningDate('');
        void queryClient.invalidateQueries({ queryKey: ['banking-accounts', org] });
      },
    });
  };
  const error = create.error instanceof ApiError ? create.error : null;
  return (
    <>
      <PageHeader
        title="Bank accounts"
        description="Follow a bank, cash or card account of your chart: import its statements, match them to your books and reconcile."
      />
      <Card title="Accounts">
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">No bank accounts yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Account</th>
                <th>Currency</th>
                <th className="num">Book balance</th>
                <th className="num">To match</th>
                <th>Last reconciled</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/banking/accounts/${a.id}`}>{a.name}</Link>
                  </td>
                  <td>
                    {a.accountCode} {a.accountName}
                  </td>
                  <td>{a.currencyCode}</td>
                  <td className="num">{formatAmount(a.bookBalance, a.currencyCode)}</td>
                  <td className="num">{a.unmatchedCount}</td>
                  <td>{a.lastReconciledDate ?? '—'}</td>
                  <td>
                    <span className={`badge badge--${a.status.toLowerCase()}`}>{a.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {canManage ? (
        <Card title="Add a bank account">
          <form onSubmit={submit} className="form-grid">
            <div className="field">
              <label htmlFor="bank-ledger-account">Chart account</label>
              <select
                id="bank-ledger-account"
                value={accountId}
                required
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">Choose…</option>
                {eligible.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name} ({a.currencyCode})
                  </option>
                ))}
              </select>
              {error?.fieldError('accountId') ? (
                <small className="field__error" role="alert">
                  {error.fieldError('accountId')}
                </small>
              ) : null}
            </div>
            <TextField
              label="Name"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              hint="Defaults to the account name."
            />
            <TextField
              label="Statement balance to start from"
              value={openingBalance}
              inputMode="decimal"
              onChange={(e) => setOpeningBalance(e.target.value)}
              error={error?.fieldError('openingBalance')}
            />
            <TextField
              label="As of"
              type="date"
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
              error={error?.fieldError('openingBalanceDate')}
            />
            <div>
              <Button type="submit" busy={create.isPending}>
                Add bank account
              </Button>
            </div>
          </form>
          {create.isError && !error?.issues.length ? <ErrorAlert error={create.error} /> : null}
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Statement import
// ---------------------------------------------------------------------------

interface CsvPreview {
  delimiter: string;
  columns: string[];
  sample: string[][];
}

function ImportPanel({ account, onDone }: { account: BankAccount; onDone: () => void }) {
  const [format, setFormat] = useState<'csv' | 'ofx'>('csv');
  const [content, setContent] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [mapping, setMapping] = useState({
    dateColumn: '',
    descriptionColumn: '',
    amountColumn: '',
    debitColumn: '',
    creditColumn: '',
    dateFormat: 'YYYY-MM-DD',
    decimalSeparator: '.',
  });
  const [result, setResult] = useState<ImportResult | null>(null);
  const preview = useApiMutation((text: string) =>
    api.post<CsvPreview>('/banking/statements/preview', { content: text }),
  );
  const run = useApiMutation(() =>
    api.post<ImportResult>(
      `/banking/accounts/${account.id}/statements`,
      format === 'ofx'
        ? { format, content }
        : {
            format,
            content,
            mapping: {
              dateColumn: mapping.dateColumn,
              descriptionColumn: mapping.descriptionColumn,
              ...(mapping.amountColumn ? { amountColumn: mapping.amountColumn } : {}),
              ...(mapping.debitColumn ? { debitColumn: mapping.debitColumn } : {}),
              ...(mapping.creditColumn ? { creditColumn: mapping.creditColumn } : {}),
              dateFormat: mapping.dateFormat,
              decimalSeparator: mapping.decimalSeparator,
              delimiter: 'auto',
            },
          },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const load = async (file: File | undefined) => {
    setResult(null);
    if (!file) return;
    const text = await file.text();
    setContent(text);
    if (/\.ofx$|\.qfx$/i.test(file.name) || /<OFX>/i.test(text.slice(0, 2000))) {
      setFormat('ofx');
      setColumns([]);
    } else {
      setFormat('csv');
      preview.mutate(text, {
        onSuccess: (p) => {
          setColumns(p.columns);
          const find = (...names: string[]) =>
            p.columns.find((c) => names.includes(c.toLowerCase())) ?? '';
          setMapping((m) => ({
            ...m,
            dateColumn: find('date', 'posting date', 'transaction date'),
            descriptionColumn: find('description', 'details', 'narrative', 'memo'),
            amountColumn: find('amount'),
          }));
        },
      });
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    run.mutate(undefined, {
      onSuccess: (r) => {
        setResult(r);
        onDone();
      },
    });
  };
  const problems = run.error instanceof ApiError ? run.error.issues : [];
  const column = (
    label: string,
    key: 'dateColumn' | 'descriptionColumn' | 'amountColumn' | 'debitColumn' | 'creditColumn',
    required: boolean,
  ) => (
    <div className="field" key={key}>
      <label htmlFor={`map-${key}`}>{label}</label>
      <select
        id={`map-${key}`}
        value={mapping[key]}
        required={required}
        onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}
      >
        <option value="">{required ? 'Choose…' : 'None'}</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <Card title="Import a statement">
      <form onSubmit={submit} className="form-grid">
        <div className="field">
          <label htmlFor="statement-file">Statement file (CSV or OFX)</label>
          <input
            id="statement-file"
            type="file"
            accept=".csv,.ofx,.qfx,text/csv"
            onChange={(e) => void load(e.target.files?.[0])}
          />
        </div>
        {content && format === 'csv' ? (
          <>
            {column('Date column', 'dateColumn', true)}
            {column('Description column', 'descriptionColumn', true)}
            {column('Amount column (signed)', 'amountColumn', false)}
            {column('Debit column (money out)', 'debitColumn', false)}
            {column('Credit column (money in)', 'creditColumn', false)}
            <div className="field">
              <label htmlFor="map-date-format">Date format</label>
              <select
                id="map-date-format"
                value={mapping.dateFormat}
                onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value })}
              >
                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="map-decimal">Decimal separator</label>
              <select
                id="map-decimal"
                value={mapping.decimalSeparator}
                onChange={(e) => setMapping({ ...mapping, decimalSeparator: e.target.value })}
              >
                <option value=".">. (1,234.50)</option>
                <option value=",">, (1.234,50)</option>
              </select>
            </div>
          </>
        ) : null}
        <div>
          <Button type="submit" busy={run.isPending} disabled={!content}>
            Import
          </Button>
        </div>
      </form>
      {preview.isError ? <ErrorAlert error={preview.error} /> : null}
      {run.isError ? (
        <Alert>
          {run.error.message}
          {problems.length ? (
            <ul>
              {problems.map((p, i) => (
                <li key={i}>
                  {p.path}: {p.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
      {result ? (
        <Alert tone="success">
          Imported {result.imported} transaction{result.imported === 1 ? '' : 's'}
          {result.duplicates ? `; ${result.duplicates} already in the account were skipped` : ''}.
        </Alert>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Transaction row actions
// ---------------------------------------------------------------------------

function MatchPanel({ transaction, onDone }: { transaction: BankTransaction; onDone: () => void }) {
  const suggestions = useQuery({
    queryKey: ['banking-suggestions', transaction.id],
    queryFn: () =>
      api.get<{ items: MatchSuggestion[] }>(`/banking/transactions/${transaction.id}/suggestions`),
  });
  const match = useApiMutation((journalLineId: string) =>
    api.post(`/banking/transactions/${transaction.id}/match`, { journalLineId }),
  );
  return (
    <div>
      <h4>Posted entries with this amount</h4>
      {suggestions.isPending ? (
        <Spinner />
      ) : suggestions.data?.items.length ? (
        <table className="table">
          <tbody>
            {suggestions.data.items.map((s) => (
              <tr key={s.journalLineId}>
                <td>{s.date}</td>
                <td>
                  <Link to={`/accounting/journals/${s.journalId}`}>#{s.journalNumber}</Link>{' '}
                  {s.description}
                </td>
                <td className="num">{formatAmount(s.amount, transaction.currencyCode)}</td>
                <td>
                  <Button
                    variant="secondary"
                    busy={match.isPending}
                    onClick={() => match.mutate(s.journalLineId, { onSuccess: onDone })}
                  >
                    Match
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">
          Nothing in your books has this amount. Categorize the transaction to post it.
        </p>
      )}
      {match.isError ? <ErrorAlert error={match.error} /> : null}
    </div>
  );
}

function CategorizePanel({
  transaction,
  onDone,
}: {
  transaction: BankTransaction;
  onDone: () => void;
}) {
  const canSeeAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canSeeAccounts);
  const [categoryAccountId, setCategoryAccountId] = useState(
    transaction.suggestion?.categoryAccountId ?? '',
  );
  const [memo, setMemo] = useState(transaction.suggestion?.memo ?? '');
  const post = useApiMutation(() =>
    api.post(
      `/banking/transactions/${transaction.id}/categorize`,
      { categoryAccountId, ...(memo.trim() ? { memo: memo.trim() } : {}) },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const options = (accounts.data ?? []).filter(
    (a) => a.status === 'ACTIVE' && a.isLeaf && !a.isControlAccount && !a.isBankOrCash,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    post.mutate(undefined, { onSuccess: onDone });
  };
  return (
    <form onSubmit={submit} className="form-grid">
      {transaction.suggestion ? (
        <Alert tone="info">Suggested by the rule “{transaction.suggestion.ruleName}”.</Alert>
      ) : null}
      <div className="field">
        <label htmlFor={`cat-${transaction.id}`}>
          {Number(transaction.amount) < 0 ? 'Spent on' : 'Received for'}
        </label>
        <select
          id={`cat-${transaction.id}`}
          value={categoryAccountId}
          required
          onChange={(e) => setCategoryAccountId(e.target.value)}
        >
          <option value="">Choose an account…</option>
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label="Memo"
        value={memo}
        maxLength={500}
        onChange={(e) => setMemo(e.target.value)}
      />
      <div>
        <Button type="submit" busy={post.isPending}>
          Post entry
        </Button>
      </div>
      {post.isError ? <ErrorAlert error={post.error} /> : null}
    </form>
  );
}

type Panel = 'match' | 'categorize' | null;

function TransactionRow({
  transaction,
  onChanged,
}: {
  transaction: BankTransaction;
  onChanged: () => void;
}) {
  const canMatch = usePermission(Permission.BankingTransactionsMatch);
  const canCategorize = usePermission(Permission.BankingTransactionsCategorize);
  const [panel, setPanel] = useState<Panel>(null);
  const done = () => {
    setPanel(null);
    onChanged();
  };
  const unmatch = useApiMutation(() => api.post(`/banking/transactions/${transaction.id}/unmatch`));
  const exclude = useApiMutation((reason: string) =>
    api.post(`/banking/transactions/${transaction.id}/exclude`, { reason }),
  );
  const restore = useApiMutation(() => api.post(`/banking/transactions/${transaction.id}/restore`));
  const error = unmatch.error ?? exclude.error ?? restore.error;
  const c = transaction.currencyCode;
  return (
    <>
      <tr>
        <td>{transaction.date}</td>
        <td>
          {transaction.description}
          {transaction.reference ? (
            <small className="muted"> · {transaction.reference}</small>
          ) : null}
        </td>
        <td className="num">{formatAmount(transaction.amount, c)}</td>
        <td>
          <StatusBadge status={transaction.status} />
          {transaction.match ? (
            <small>
              {' '}
              <Link to={`/accounting/journals/${transaction.match.journalId}`}>
                #{transaction.match.journalNumber}
              </Link>
            </small>
          ) : null}
          {transaction.status === 'EXCLUDED' && transaction.excludedReason ? (
            <small className="muted"> {transaction.excludedReason}</small>
          ) : null}
        </td>
        <td>
          {transaction.status === 'UNMATCHED' && canMatch ? (
            <Button
              variant="secondary"
              onClick={() => setPanel(panel === 'match' ? null : 'match')}
            >
              Match
            </Button>
          ) : null}{' '}
          {transaction.status === 'UNMATCHED' && canCategorize ? (
            <Button
              variant="secondary"
              onClick={() => setPanel(panel === 'categorize' ? null : 'categorize')}
            >
              Categorize
            </Button>
          ) : null}{' '}
          {transaction.status === 'UNMATCHED' && canMatch ? (
            <Button
              variant="ghost"
              onClick={() => {
                const reason = window.prompt('Why is this transaction excluded?');
                if (reason?.trim()) exclude.mutate(reason.trim(), { onSuccess: onChanged });
              }}
            >
              Exclude
            </Button>
          ) : null}
          {transaction.status === 'MATCHED' &&
          transaction.match?.source === 'manual' &&
          canMatch ? (
            <Button
              variant="ghost"
              onClick={() => unmatch.mutate(undefined, { onSuccess: onChanged })}
            >
              Unmatch
            </Button>
          ) : null}
          {transaction.status === 'EXCLUDED' && canMatch ? (
            <Button
              variant="ghost"
              onClick={() => restore.mutate(undefined, { onSuccess: onChanged })}
            >
              Restore
            </Button>
          ) : null}
        </td>
      </tr>
      {error ? (
        <tr>
          <td colSpan={5}>
            <ErrorAlert error={error} />
          </td>
        </tr>
      ) : null}
      {panel ? (
        <tr>
          <td colSpan={5}>
            {panel === 'match' ? (
              <MatchPanel transaction={transaction} onDone={done} />
            ) : (
              <CategorizePanel transaction={transaction} onDone={done} />
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// One bank account
// ---------------------------------------------------------------------------

export function BankAccountPage() {
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canImport = usePermission(Permission.BankingTransactionsImport);
  const canMatch = usePermission(Permission.BankingTransactionsMatch);
  const canReconcile = usePermission(Permission.BankingReconcile);
  const [status, setStatus] = useState<BankTransactionStatus | ''>('UNMATCHED');
  const [search, setSearch] = useState('');
  const account = useQuery({
    queryKey: ['banking-account', org, id],
    queryFn: () => api.get<BankAccount>(`/banking/accounts/${id}`),
  });
  const query = new URLSearchParams({ limit: '100' });
  if (status) query.set('status', status);
  if (search.trim()) query.set('search', search.trim());
  const transactions = useQuery({
    queryKey: ['banking-transactions', org, id, status, search],
    queryFn: () =>
      api.get<{ items: BankTransaction[]; nextCursor: string | null }>(
        `/banking/accounts/${id}/transactions?${query.toString()}`,
      ),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['banking-transactions', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['banking-account', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['banking-accounts', org] });
  };
  const autoMatch = useApiMutation(() =>
    api.post<{ matched: number; remaining: number }>(`/banking/accounts/${id}/auto-match`),
  );
  if (account.isPending) return <Spinner />;
  if (account.isError) return <ErrorAlert error={account.error} />;
  const a = account.data;
  return (
    <>
      <PageHeader
        title={a.name}
        description={`${a.accountCode ?? ''} ${a.accountName ?? ''} · ${a.currencyCode} · book balance ${formatAmount(a.bookBalance, a.currencyCode)}`}
      />
      <p>
        <Link to="/banking">← Bank accounts</Link>
        {canReconcile ? (
          <>
            {' · '}
            <Link to={`/banking/accounts/${id}/reconcile`}>Reconcile</Link>
          </>
        ) : null}
      </p>
      {canImport && a.status === 'ACTIVE' ? <ImportPanel account={a} onDone={refresh} /> : null}
      <Card
        title="Statement transactions"
        actions={
          canMatch ? (
            <Button
              variant="secondary"
              busy={autoMatch.isPending}
              onClick={() => autoMatch.mutate(undefined, { onSuccess: refresh })}
            >
              Auto-match
            </Button>
          ) : undefined
        }
      >
        {autoMatch.data ? (
          <Alert tone="success">
            Matched {autoMatch.data.matched}; {autoMatch.data.remaining} need a decision.
          </Alert>
        ) : null}
        {autoMatch.isError ? <ErrorAlert error={autoMatch.error} /> : null}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="txn-status">Show</label>
            <select
              id="txn-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as BankTransactionStatus | '')}
            >
              <option value="UNMATCHED">Unmatched</option>
              <option value="MATCHED">Matched</option>
              <option value="EXCLUDED">Excluded</option>
              <option value="">All</option>
            </select>
          </div>
          <TextField label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {transactions.isPending ? (
          <Spinner />
        ) : transactions.isError ? (
          <ErrorAlert error={transactions.error} />
        ) : transactions.data.items.length === 0 ? (
          <p className="muted">No transactions here.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {transactions.data.items.map((t) => (
                <TransactionRow key={t.id} transaction={t} onChanged={refresh} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
