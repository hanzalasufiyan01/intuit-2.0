import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Badge, toneOf, type BadgeTone } from '../../shared/ui/Badge';
import { MappedStatusBadge, type StatusEntry } from '../../shared/ui/StatusBadge';
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
import { useT } from '../../i18n/i18n';

/**
 * Bank accounts and their statement transactions: import (CSV with a column mapping, or OFX),
 * match to posted journal lines, categorize into a bank entry, exclude, or leave for later. The
 * server authorizes and validates everything; these pages only guide. Nothing here changes a
 * posted journal.
 */

const TRANSACTION_STATUS = {
  UNMATCHED: { key: 'banking.bankAccountPages.status.UNMATCHED', tone: 'warning' },
  MATCHED: { key: 'banking.bankAccountPages.status.MATCHED', tone: 'success' },
  EXCLUDED: { key: 'banking.bankAccountPages.status.EXCLUDED', tone: 'neutral' },
} satisfies Record<BankTransactionStatus, StatusEntry>;

/** A statement transaction's status; one the page does not know is neutral and shown as it came. */
export function StatusBadge({ status }: { status: string }) {
  return <MappedStatusBadge map={TRANSACTION_STATUS} status={status} />;
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

export function BankAccountsPage() {
  const t = useT();
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
        title={t('banking.bankAccountPages.bankAccounts')}
        description={t('banking.bankAccountPages.followABankCashOr')}
      />
      <Card title={t('banking.bankAccountPages.accounts')}>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">{t('banking.bankAccountPages.noBankAccountsYet')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('banking.bankAccountPages.name')}</th>
                <th>{t('banking.bankAccountPages.account')}</th>
                <th>{t('banking.bankAccountPages.currency')}</th>
                <th className="num">{t('banking.bankAccountPages.bookBalance')}</th>
                <th className="num">{t('banking.bankAccountPages.toMatch')}</th>
                <th>{t('banking.bankAccountPages.lastReconciled')}</th>
                <th>{t('banking.bankAccountPages.status')}</th>
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
                    <AccountStatusBadge status={a.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {canManage ? (
        <Card title={t('banking.bankAccountPages.addABankAccount')}>
          <form onSubmit={submit} className="form-grid">
            <div className="field">
              <label htmlFor="bank-ledger-account">
                {t('banking.bankAccountPages.chartAccount')}
              </label>
              <select
                id="bank-ledger-account"
                value={accountId}
                required
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">{t('common.choose')}</option>
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
              label={t('banking.bankAccountPages.name')}
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              hint={t('banking.bankAccountPages.defaultsToTheAccountName')}
            />
            <TextField
              label={t('banking.bankAccountPages.statementBalanceToStartFrom')}
              value={openingBalance}
              inputMode="decimal"
              onChange={(e) => setOpeningBalance(e.target.value)}
              error={error?.fieldError('openingBalance')}
            />
            <TextField
              label={t('banking.bankAccountPages.asOf')}
              type="date"
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
              error={error?.fieldError('openingBalanceDate')}
            />
            <div>
              <Button type="submit" busy={create.isPending}>
                {t('banking.bankAccountPages.addBankAccount')}
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
  const t = useT();
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
        <option value="">{required ? t('common.choose') : t('common.none')}</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <Card title={t('banking.bankAccountPages.importAStatement')}>
      <form onSubmit={submit} className="form-grid">
        <div className="field">
          <label htmlFor="statement-file">
            {t('banking.bankAccountPages.statementFileCsvOrOfx')}
          </label>
          <input
            id="statement-file"
            type="file"
            accept=".csv,.ofx,.qfx,text/csv"
            onChange={(e) => void load(e.target.files?.[0])}
          />
        </div>
        {content && format === 'csv' ? (
          <>
            {column(t('banking.bankAccountPages.dateColumn'), 'dateColumn', true)}
            {column(t('banking.bankAccountPages.descriptionColumn'), 'descriptionColumn', true)}
            {column(t('banking.bankAccountPages.amountColumn'), 'amountColumn', false)}
            {column(t('banking.bankAccountPages.debitColumn'), 'debitColumn', false)}
            {column(t('banking.bankAccountPages.creditColumn'), 'creditColumn', false)}
            <div className="field">
              <label htmlFor="map-date-format">{t('banking.bankAccountPages.dateFormat')}</label>
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
              <label htmlFor="map-decimal">{t('banking.bankAccountPages.decimalSeparator')}</label>
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
            {t('banking.bankAccountPages.import')}
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
          {t('banking.bankAccountPages.importedTransaction', {
            imported: result.imported,
            value: result.imported === 1 ? '' : 's',
            value2: result.duplicates
              ? t('banking.bankAccountPages.alreadyInTheAccountWere', {
                  duplicates: result.duplicates,
                })
              : '',
          })}
        </Alert>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Transaction row actions
// ---------------------------------------------------------------------------

function MatchPanel({ transaction, onDone }: { transaction: BankTransaction; onDone: () => void }) {
  const t = useT();
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
      <h4>{t('banking.bankAccountPages.postedEntriesWithThisAmount')}</h4>
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
                    {t('banking.bankAccountPages.match')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">{t('banking.bankAccountPages.nothingInYourBooksHas')}</p>
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
  const t = useT();
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
        <Alert tone="info">
          {t('banking.bankAccountPages.suggestedByTheRule', {
            ruleName: transaction.suggestion.ruleName,
          })}
        </Alert>
      ) : null}
      <div className="field">
        <label htmlFor={`cat-${transaction.id}`}>
          {Number(transaction.amount) < 0
            ? t('banking.bankAccountPages.spentOn')
            : t('banking.bankAccountPages.receivedFor')}
        </label>
        <select
          id={`cat-${transaction.id}`}
          value={categoryAccountId}
          required
          onChange={(e) => setCategoryAccountId(e.target.value)}
        >
          <option value="">{t('banking.bankAccountPages.chooseAnAccount')}</option>
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label={t('banking.bankAccountPages.memo')}
        value={memo}
        maxLength={500}
        onChange={(e) => setMemo(e.target.value)}
      />
      <div>
        <Button type="submit" busy={post.isPending}>
          {t('banking.bankAccountPages.postEntry')}
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
  const t = useT();
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
              {t('banking.bankAccountPages.match')}
            </Button>
          ) : null}{' '}
          {transaction.status === 'UNMATCHED' && canCategorize ? (
            <Button
              variant="secondary"
              onClick={() => setPanel(panel === 'categorize' ? null : 'categorize')}
            >
              {t('banking.bankAccountPages.categorize')}
            </Button>
          ) : null}{' '}
          {transaction.status === 'UNMATCHED' && canMatch ? (
            <Button
              variant="ghost"
              onClick={() => {
                const reason = window.prompt(
                  t('banking.bankAccountPages.whyIsThisTransactionExcluded'),
                );
                if (reason?.trim()) exclude.mutate(reason.trim(), { onSuccess: onChanged });
              }}
            >
              {t('banking.bankAccountPages.exclude')}
            </Button>
          ) : null}
          {transaction.status === 'MATCHED' &&
          transaction.match?.source === 'manual' &&
          canMatch ? (
            <Button
              variant="ghost"
              onClick={() => unmatch.mutate(undefined, { onSuccess: onChanged })}
            >
              {t('banking.bankAccountPages.unmatch')}
            </Button>
          ) : null}
          {transaction.status === 'EXCLUDED' && canMatch ? (
            <Button
              variant="ghost"
              onClick={() => restore.mutate(undefined, { onSuccess: onChanged })}
            >
              {t('common.restore')}
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
  const translate = useT();
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
        description={translate('banking.bankAccountPages.bookBalance2', {
          accountCode: a.accountCode ?? '',
          accountName: a.accountName ?? '',
          currencyCode: a.currencyCode,
          value: formatAmount(a.bookBalance, a.currencyCode),
        })}
      />
      <p>
        <Link to="/banking">{translate('banking.bankAccountPages.bankAccounts2')}</Link>
        {canReconcile ? (
          <>
            {' · '}
            <Link to={`/banking/accounts/${id}/reconcile`}>
              {translate('banking.bankAccountPages.reconcile')}
            </Link>
          </>
        ) : null}
      </p>
      {canImport && a.status === 'ACTIVE' ? <ImportPanel account={a} onDone={refresh} /> : null}
      <Card
        title={translate('banking.bankAccountPages.statementTransactions')}
        actions={
          canMatch ? (
            <Button
              variant="secondary"
              busy={autoMatch.isPending}
              onClick={() => autoMatch.mutate(undefined, { onSuccess: refresh })}
            >
              {translate('banking.bankAccountPages.autoMatch')}
            </Button>
          ) : undefined
        }
      >
        {autoMatch.data ? (
          <Alert tone="success">
            {translate('banking.bankAccountPages.matchedNeedADecision', {
              matched: autoMatch.data.matched,
              remaining: autoMatch.data.remaining,
            })}
          </Alert>
        ) : null}
        {autoMatch.isError ? <ErrorAlert error={autoMatch.error} /> : null}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="txn-status">{translate('banking.bankAccountPages.show')}</label>
            <select
              id="txn-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as BankTransactionStatus | '')}
            >
              <option value="UNMATCHED">{translate('banking.bankAccountPages.unmatched')}</option>
              <option value="MATCHED">{translate('banking.bankAccountPages.matched')}</option>
              <option value="EXCLUDED">{translate('banking.bankAccountPages.excluded')}</option>
              <option value="">{translate('common.all')}</option>
            </select>
          </div>
          <TextField
            label={translate('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {transactions.isPending ? (
          <Spinner />
        ) : transactions.isError ? (
          <ErrorAlert error={transactions.error} />
        ) : transactions.data.items.length === 0 ? (
          <p className="muted">{translate('banking.bankAccountPages.noTransactionsHere')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{translate('banking.bankAccountPages.date')}</th>
                <th>{translate('banking.bankAccountPages.description')}</th>
                <th className="num">{translate('banking.bankAccountPages.amount')}</th>
                <th>{translate('banking.bankAccountPages.status')}</th>
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

const ACCOUNT_STATUS_TONE: Record<'ACTIVE' | 'ARCHIVED', BadgeTone> = {
  ACTIVE: 'success',
  ARCHIVED: 'neutral',
};

/** A bank account's status, translated; a status the page does not know is neutral and shown as it came. */
export function AccountStatusBadge({ status }: { status: string }) {
  const t = useT();
  const label =
    status === 'ACTIVE'
      ? t('banking.bankAccountPages.accountStatus.ACTIVE')
      : status === 'ARCHIVED'
        ? t('banking.bankAccountPages.accountStatus.ARCHIVED')
        : status;
  return <Badge tone={toneOf(ACCOUNT_STATUS_TONE, status)}>{label}</Badge>;
}
