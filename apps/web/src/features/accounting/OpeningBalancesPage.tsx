import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { AppliedSteps, describeFacts } from '../approvals/conditions';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount, isDecimalString, sumAmounts } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { ExportButton } from '../data-exchange/ExportButton';
import { AttachmentsCard } from '../files/AttachmentsCard';
import { AccountingPage, useAccounts, useDimensions, useOrgKey } from './shared';
import type {
  Account,
  DesignationEntry,
  DimensionType,
  OpeningBatchDetail,
  OpeningBatchStatus,
  OpeningList,
  OpeningPreview,
} from './types';

/**
 * Opening balances / conversion balances (S8-22): conversion date, the balances grid per
 * currency, preview, approval, re-authenticated posting, reversal, import/export and evidence.
 * The server authorizes and validates everything; this page only guides.
 */

const STATUS_LABEL: Record<OpeningBatchStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Awaiting approval',
  POSTED: 'Posted',
  REVERSED: 'Reversed',
};

function StatusLabel({ status }: { status: OpeningBatchStatus }) {
  return <span className={`badge badge--${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>;
}

function useOpeningList() {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['opening-balances', org],
    queryFn: () => api.get<OpeningList>('/accounting/opening-balances'),
  });
}

function useOpeningBatch(id: string | undefined) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['opening-balance', org, id],
    queryFn: () => api.get<OpeningBatchDetail>(`/accounting/opening-balances/${id}`),
    enabled: Boolean(id),
  });
}

function useInvalidateOpening() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['opening-balances'] }),
      queryClient.invalidateQueries({ queryKey: ['opening-balance'] }),
    ]);
}

// ---------------------------------------------------------------------------
// Conversion date
// ---------------------------------------------------------------------------

function ConversionDateCard({
  list,
  openStatus,
}: {
  list: OpeningList;
  openStatus: OpeningBatchStatus | null;
}) {
  const canEdit = usePermission(Permission.AccountingSetup);
  const sensitive = useSensitiveAction();
  const invalidate = useInvalidateOpening();
  const [date, setDate] = useState(list.conversionDate ?? '');
  const save = useApiMutation((conversionDate: string) =>
    sensitive(() => api.put('/accounting/settings/conversion-date', { conversionDate })),
  );
  const locked = openStatus === 'PENDING_APPROVAL' || openStatus === 'POSTED';
  return (
    <Card title="Conversion date">
      <p>
        {list.conversionDate ? (
          <>
            Books start on <strong>{list.conversionDate}</strong>; opening balances are dated{' '}
            <strong>{list.openingDate}</strong>.
          </>
        ) : (
          'Choose the first day your books are kept in Intuit 2.0.'
        )}
      </p>
      {canEdit ? (
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(date, { onSuccess: () => void invalidate() });
          }}
        >
          <TextField
            label="Conversion date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={locked}
          />
          <Button type="submit" busy={save.isPending} disabled={locked || !date}>
            Save date
          </Button>
          <ErrorAlert error={save.error} />
        </form>
      ) : null}
      {locked ? (
        <p className="muted">
          The conversion date is fixed while opening balances are awaiting approval or posted.
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Balances grid
// ---------------------------------------------------------------------------

interface Entry {
  key: string;
  accountId: string;
  description: string;
  debit: string;
  credit: string;
  baseAmount: string;
  dims: Record<string, string>;
}

let entryKey = 0;
const newKey = () => `e${++entryKey}`;

function eligible(account: Account, obeId: string | null, includeProfitAndLoss: boolean) {
  return (
    account.status === 'ACTIVE' &&
    account.isLeaf &&
    !account.isControlAccount &&
    // S8-07 final ruling: an explicit subtype is required; receivables are excluded, and
    // payables too (ADR 0004 P4-36: vendor balances come in as opening bills).
    account.subtype !== null &&
    account.subtype !== 'ACCOUNTS_RECEIVABLE' &&
    account.subtype !== 'ACCOUNTS_PAYABLE' &&
    account.id !== obeId &&
    (includeProfitAndLoss || (account.type !== 'REVENUE' && account.type !== 'EXPENSE'))
  );
}

function initialEntries(batch: OpeningBatchDetail, accounts: Account[], obeId: string | null) {
  const entries: Entry[] = batch.lines.map((l) => ({
    key: newKey(),
    accountId: l.accountId,
    description: l.description,
    debit: l.debit ?? '',
    credit: l.credit ?? '',
    baseAmount: l.baseAmount ?? '',
    dims: Object.fromEntries(l.dimensions.map((d) => [d.dimensionTypeId, d.dimensionValueId])),
  }));
  const used = new Set(entries.map((e) => e.accountId));
  for (const account of accounts) {
    if (!used.has(account.id) && eligible(account, obeId, true)) {
      entries.push({
        key: newKey(),
        accountId: account.id,
        description: '',
        debit: '',
        credit: '',
        baseAmount: '',
        dims: {},
      });
    }
  }
  return entries;
}

function lineErrors(error: unknown): Map<number, string[]> {
  const byLine = new Map<number, string[]>();
  if (!(error instanceof ApiError)) return byLine;
  for (const issue of error.issues) {
    const match = /^lines\.(\d+)/.exec(issue.path);
    if (!match) continue;
    const i = Number(match[1]);
    byLine.set(i, [...(byLine.get(i) ?? []), issue.message]);
  }
  return byLine;
}

function BalancesEditor({
  batch,
  accounts,
  types,
  obeId,
}: {
  batch: OpeningBatchDetail;
  accounts: Account[];
  types: DimensionType[];
  obeId: string | null;
}) {
  const invalidate = useInvalidateOpening();
  const [entries, setEntries] = useState<Entry[]>(() => initialEntries(batch, accounts, obeId));
  const [search, setSearch] = useState('');
  const [includePnl, setIncludePnl] = useState(
    batch.lines.some((l) => {
      const a = accounts.find((x) => x.id === l.accountId);
      return a?.type === 'REVENUE' || a?.type === 'EXPENSE';
    }),
  );
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const currencyOf = (accountId: string) => byId.get(accountId)?.currencyCode ?? batch.baseCurrency;
  const currencies = [...new Set(entries.map((e) => currencyOf(e.accountId)))].sort((a, b) =>
    a === batch.baseCurrency ? -1 : b === batch.baseCurrency ? 1 : a.localeCompare(b),
  );
  const [tab, setTab] = useState(batch.baseCurrency);
  const activeTypes = types.filter((t) => t.status === 'ACTIVE');

  const filled = entries.filter((e) => e.debit.trim() || e.credit.trim());
  const save = useApiMutation(() =>
    api.put<OpeningBatchDetail>(`/accounting/opening-balances/${batch.id}/lines`, {
      version: batch.version,
      lines: filled.map((e) => ({
        accountId: e.accountId,
        description: e.description,
        debit: e.debit.trim() || null,
        credit: e.credit.trim() || null,
        baseAmount: e.baseAmount.trim() || null,
        dimensions: Object.entries(e.dims)
          .filter(([, v]) => v)
          .map(([dimensionTypeId, dimensionValueId]) => ({ dimensionTypeId, dimensionValueId })),
      })),
    }),
  );
  const errorsByFilledIndex = lineErrors(save.error);
  const filledIndex = new Map(filled.map((e, i) => [e.key, i]));

  const update = (key: string, patch: Partial<Entry>) =>
    setEntries((all) => all.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  const visible = entries.filter((e) => {
    const account = byId.get(e.accountId);
    if (!account || currencyOf(e.accountId) !== tab) return false;
    const hasValue = Boolean(e.debit || e.credit);
    if (!hasValue && !eligible(account, obeId, includePnl)) return false;
    const q = search.trim().toLowerCase();
    return !q || account.code.toLowerCase().includes(q) || account.name.toLowerCase().includes(q);
  });
  const tabEntries = entries.filter((e) => currencyOf(e.accountId) === tab);
  const debit = sumAmounts(tabEntries.map((e) => (isDecimalString(e.debit) ? e.debit : null)));
  const credit = sumAmounts(tabEntries.map((e) => (isDecimalString(e.credit) ? e.credit : null)));
  const net = debit.minus(credit);
  const foreign = tab !== batch.baseCurrency;
  const unclassified = accounts.filter(
    (a) => a.status === 'ACTIVE' && a.isLeaf && a.subtype === null,
  ).length;

  return (
    <Card title="Opening balances">
      <p className="muted">
        Enter each balance in the account&apos;s own currency. Opening Balance Equity is calculated
        for you. Receivables are brought in later as opening invoices, so receivable and control
        accounts are not listed.
      </p>
      {unclassified > 0 ? (
        <p className="muted" role="note">
          {unclassified === 1 ? '1 account has' : `${unclassified} accounts have`} no subtype and
          {unclassified === 1 ? ' is' : ' are'} not listed. Classify them under{' '}
          <Link to="/accounting/accounts">Chart of accounts</Link> to enter their balances.
        </p>
      ) : null}
      <div className="tabs" role="tablist" aria-label="Currencies">
        {currencies.map((c) => (
          <Button
            key={c}
            role="tab"
            aria-selected={tab === c}
            variant={tab === c ? 'primary' : 'ghost'}
            onClick={() => setTab(c)}
          >
            {c}
          </Button>
        ))}
      </div>
      <div className="form form--inline">
        <TextField
          label="Find an account"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includePnl}
            onChange={(e) => setIncludePnl(e.target.checked)}
          />
          Show income and expense accounts (mid-year conversions)
        </label>
      </div>
      <div className="table-scroll">
        <table className="table" aria-label={`${tab} opening balances`}>
          <thead>
            <tr>
              <th>Account</th>
              <th>Debit ({tab})</th>
              <th>Credit ({tab})</th>
              {foreign ? <th>Base amount ({batch.baseCurrency})</th> : null}
              {activeTypes.map((t) => (
                <th key={t.id}>
                  {t.name}
                  {t.isRequired ? ' *' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => {
              const account = byId.get(e.accountId)!;
              const problems = errorsByFilledIndex.get(filledIndex.get(e.key) ?? -1) ?? [];
              return (
                <tr key={e.key}>
                  <td>
                    {account.code} {account.name}
                    {problems.map((p) => (
                      <div key={p} className="text-error">
                        {p}
                      </div>
                    ))}
                  </td>
                  <td>
                    <input
                      aria-label={`Debit ${account.code}`}
                      inputMode="decimal"
                      value={e.debit}
                      onChange={(ev) => update(e.key, { debit: ev.target.value, credit: '' })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Credit ${account.code}`}
                      inputMode="decimal"
                      value={e.credit}
                      onChange={(ev) => update(e.key, { credit: ev.target.value, debit: '' })}
                    />
                  </td>
                  {foreign ? (
                    <td>
                      <input
                        aria-label={`Base amount ${account.code}`}
                        inputMode="decimal"
                        placeholder="rate table"
                        value={e.baseAmount}
                        onChange={(ev) => update(e.key, { baseAmount: ev.target.value })}
                      />
                    </td>
                  ) : null}
                  {activeTypes.map((t) => (
                    <td key={t.id}>
                      <select
                        aria-label={`${t.name} ${account.code}`}
                        value={e.dims[t.id] ?? ''}
                        onChange={(ev) =>
                          update(e.key, { dims: { ...e.dims, [t.id]: ev.target.value } })
                        }
                      >
                        <option value="">—</option>
                        {t.values
                          .filter((v) => v.status === 'ACTIVE' || v.id === e.dims[t.id])
                          .map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.code} {v.name}
                            </option>
                          ))}
                      </select>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th>Total {tab}</th>
              <th>{formatAmount(debit.toFixed(), tab)}</th>
              <th>{formatAmount(credit.toFixed(), tab)}</th>
            </tr>
          </tfoot>
        </table>
      </div>
      <p aria-live="polite">
        Opening Balance Equity ({tab}):{' '}
        {net.isZero()
          ? 'none — the balances net to zero.'
          : `${formatAmount(net.abs().toFixed(), tab)} ${net.gt(0) ? 'credit' : 'debit'}`}
      </p>
      <ErrorAlert error={save.error} />
      {save.isSuccess ? <Alert tone="success">Opening balances saved.</Alert> : null}
      <div className="actions">
        <Button
          busy={save.isPending}
          onClick={() => save.mutate(undefined, { onSuccess: () => void invalidate() })}
        >
          Save balances
        </Button>
      </div>
    </Card>
  );
}

function ReadOnlyLines({ batch }: { batch: OpeningBatchDetail }) {
  return (
    <Card title="Opening balances">
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Currency</th>
              <th>Debit</th>
              <th>Credit</th>
              <th>Base amount</th>
            </tr>
          </thead>
          <tbody>
            {batch.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  {l.accountCode} {l.accountName}
                </td>
                <td>{l.currency}</td>
                <td>{formatAmount(l.debit, l.currency)}</td>
                <td>{formatAmount(l.credit, l.currency)}</td>
                <td>{l.baseAmount ? formatAmount(l.baseAmount, batch.baseCurrency) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Totals batch={batch} />
    </Card>
  );
}

function Totals({ batch }: { batch: OpeningBatchDetail }) {
  return (
    <ul className="summary-list" aria-label="Totals by currency">
      {batch.totals.map((t) => (
        <li key={t.currency}>
          {t.currency}: debit {formatAmount(t.debit, t.currency)}, credit{' '}
          {formatAmount(t.credit, t.currency)}
          {t.openingBalanceEquity
            ? `, Opening Balance Equity ${formatAmount(t.openingBalanceEquity.amount, t.currency)} ${t.openingBalanceEquity.side}`
            : ''}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Preview and workflow
// ---------------------------------------------------------------------------

function PreviewCard({ batch }: { batch: OpeningBatchDetail }) {
  const preview = useApiMutation(() =>
    api.post<OpeningPreview>(`/accounting/opening-balances/${batch.id}/preview`, {}),
  );
  const data = preview.data;
  return (
    <Card title="Preview">
      <p className="muted">
        See the journals that posting will create: one per currency, dated {batch.openingDate}.
      </p>
      <Button variant="secondary" busy={preview.isPending} onClick={() => preview.mutate()}>
        Preview journals
      </Button>
      <ErrorAlert error={preview.error} />
      {data ? (
        <div className="stack">
          {data.errors.length ? (
            <Alert>
              <strong>Fix these before submitting or posting:</strong>
              <ul>
                {data.errors.map((e, i) => (
                  <li key={i}>{e.message}</li>
                ))}
              </ul>
            </Alert>
          ) : (
            <Alert tone="success">The opening balances are ready.</Alert>
          )}
          {data.warnings.map((w, i) => (
            <Alert key={i} tone="info">
              {w.message}
            </Alert>
          ))}
          {data.journals.map((j) => (
            <div key={j.currency} className="table-scroll">
              <h3>
                {j.currency} journal —{' '}
                {j.rateSource === 'base'
                  ? 'base currency'
                  : j.rateSource === 'table'
                    ? `rate ${j.rate} from the rate table`
                    : `carrying values (effective rate ${j.rate})`}
              </h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Debit</th>
                    <th>Credit</th>
                    {j.rateSource === 'explicit' ? <th>Base</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {j.lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        {l.accountCode} {l.accountName}
                      </td>
                      <td>{formatAmount(l.debit, j.currency)}</td>
                      <td>{formatAmount(l.credit, j.currency)}</td>
                      {j.rateSource === 'explicit' ? (
                        <td>{formatAmount(l.baseDebit ?? l.baseCredit, data.baseCurrency)}</td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function WorkflowCard({ batch }: { batch: OpeningBatchDetail }) {
  const canEdit = usePermission(Permission.AccountingSetup);
  const sensitive = useSensitiveAction();
  const invalidate = useInvalidateOpening();
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const act = useApiMutation((name: 'submit' | 'withdraw' | 'post' | 'reverse' | 'delete') => {
    const path = `/accounting/opening-balances/${batch.id}`;
    if (name === 'delete') return api.delete(path);
    if (name === 'withdraw') return api.post(`${path}/withdraw`, {});
    if (name === 'submit') return api.post(`${path}/submit`, { version: batch.version });
    if (name === 'post')
      return sensitive(() => api.post(`${path}/post`, { version: batch.version }));
    return sensitive(() => api.post(`${path}/reverse`, { reason }));
  });
  const run = (name: Parameters<typeof act.mutate>[0]) =>
    act.mutate(name, {
      onSuccess: () => {
        void invalidate();
        if (name === 'delete') void navigate('/accounting/opening-balances');
      },
    });
  const approval = batch.approval;

  return (
    <Card title="Status">
      <p>
        <StatusLabel status={batch.status} />{' '}
        {batch.status === 'POSTED' && batch.postedAt
          ? `on ${new Date(batch.postedAt).toLocaleString()}.`
          : null}
        {batch.status === 'REVERSED' && batch.reversedAt
          ? `on ${new Date(batch.reversedAt).toLocaleString()}: ${batch.reversalReason ?? ''}`
          : null}
      </p>
      {approval.facts && (batch.status === 'DRAFT' || batch.status === 'PENDING_APPROVAL') ? (
        <div className="approval-requirement" data-testid="approval-requirement">
          <p>
            {approval.required
              ? 'Approval is required before posting'
              : 'No approval is required to post these balances'}{' '}
            <span className="muted">({describeFacts(approval.facts)})</span>
          </p>
          <AppliedSteps steps={approval.appliedSteps} baseCurrency={batch.baseCurrency} />
        </div>
      ) : null}
      {approval.required || approval.requestId ? (
        <div>
          <p>
            Approval: {approval.requestStatus ?? 'not requested yet'}
            {approval.readyToPost && batch.status === 'PENDING_APPROVAL' ? ' — ready to post.' : ''}
          </p>
          {approval.steps.length ? (
            <ul>
              {approval.steps.map((s) => (
                <li key={s.name}>
                  {s.name}: {s.approvals}/{s.requiredApprovals} {s.satisfied ? '✓' : ''}
                </li>
              ))}
            </ul>
          ) : null}
          {batch.status === 'PENDING_APPROVAL' && !approval.readyToPost ? (
            <p className="muted">
              Approvers decide from{' '}
              <Link to="/accounting/journals/approvals">the approval queue</Link>.
            </p>
          ) : null}
        </div>
      ) : null}
      {batch.journals.length ? (
        <div>
          <p>Journals:</p>
          <ul>
            {batch.journals.map((j) => (
              <li key={j.id}>
                <Link to={`/accounting/journals/${j.id}`}>
                  {j.journalNumber ? `Journal #${j.journalNumber}` : 'Journal'} ({j.currency})
                </Link>{' '}
                — {j.status.toLowerCase()}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ErrorAlert error={act.error} />
      {canEdit ? (
        <div className="actions">
          {batch.status === 'DRAFT' && approval.required ? (
            <Button busy={act.isPending} onClick={() => run('submit')}>
              Submit for approval
            </Button>
          ) : null}
          {batch.status === 'PENDING_APPROVAL' ? (
            <Button variant="secondary" busy={act.isPending} onClick={() => run('withdraw')}>
              Withdraw
            </Button>
          ) : null}
          {approval.readyToPost ? (
            <Button busy={act.isPending} onClick={() => run('post')}>
              Post opening balances
            </Button>
          ) : null}
          {batch.status === 'DRAFT' ? (
            <Button variant="ghost" busy={act.isPending} onClick={() => run('delete')}>
              Delete draft
            </Button>
          ) : null}
        </div>
      ) : null}
      {canEdit && batch.status === 'POSTED' ? (
        <form
          className="form form--inline"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            run('reverse');
          }}
        >
          <TextField
            label="Reason for reversing"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
          <Button type="submit" variant="secondary" busy={act.isPending} disabled={!reason.trim()}>
            Reverse opening batch
          </Button>
        </form>
      ) : null}
      {batch.status === 'POSTED' ? (
        <p className="muted">
          Posting fixed the base currency and the currencies of the accounts used. To correct
          opening balances, reverse the whole batch and post a new one.
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function BatchView({ id }: { id: string }) {
  const canEdit = usePermission(Permission.AccountingSetup);
  const canSeeDimensions = usePermission(Permission.DimensionsView);
  const batch = useOpeningBatch(id);
  const accounts = useAccounts(canEdit);
  const dimensions = useDimensions(canEdit && canSeeDimensions);
  const org = useOrgKey();
  const designations = useQuery({
    queryKey: ['accounting-designations', org],
    queryFn: () => api.get<DesignationEntry[]>('/accounting/designations'),
    enabled: canEdit,
  });
  if (batch.isPending) return <Spinner label="Loading opening balances" />;
  if (batch.isError) return <ErrorAlert error={batch.error} />;
  const b = batch.data;
  const editable = canEdit && b.status === 'DRAFT';
  const obeId =
    designations.data?.find((d) => d.designation === 'OPENING_BALANCE_EQUITY')?.accountId ?? null;
  return (
    <>
      <WorkflowCard batch={b} />
      {editable ? (
        accounts.isPending || designations.isPending ? (
          <Spinner label="Loading accounts" />
        ) : (
          <BalancesEditor
            key={b.version}
            batch={b}
            accounts={accounts.data ?? []}
            types={dimensions.data ?? []}
            obeId={obeId}
          />
        )
      ) : (
        <ReadOnlyLines batch={b} />
      )}
      {canEdit ? <PreviewCard batch={b} /> : null}
      <Card title="Import and export">
        <div className="actions">
          {editable ? (
            <Link className="btn btn--secondary" to="/imports?domain=opening_balances">
              Import from CSV
            </Link>
          ) : null}
          <ExportButton domain="opening_balances" params={{ batchId: b.id }} />
        </div>
        {editable ? (
          <p className="muted">An import replaces this draft&apos;s balances; it never posts.</p>
        ) : null}
      </Card>
      <AttachmentsCard
        linkType="opening_balance_batch"
        linkId={b.id}
        canChange={editable}
        canRemove={editable}
        removeNote="Evidence can be changed only while the batch is a draft."
      />
    </>
  );
}

export function OpeningBalancesPage() {
  const { id } = useParams();
  const canEdit = usePermission(Permission.AccountingSetup);
  const list = useOpeningList();
  const invalidate = useInvalidateOpening();
  const navigate = useNavigate();
  const create = useApiMutation(() =>
    api.post<OpeningBatchDetail>('/accounting/opening-balances', { notes: '' }),
  );
  const open = list.data?.batches.find((b) => b.status !== 'REVERSED') ?? null;
  const shownId = id ?? open?.id;

  return (
    <>
      <PageHeader
        title="Opening balances"
        description="Bring balances over from your previous system as at the conversion date."
      />
      <AccountingPage>
        {list.isPending ? (
          <Spinner label="Loading opening balances" />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : (
          <>
            <ConversionDateCard
              key={list.data.conversionDate ?? 'none'}
              list={list.data}
              openStatus={open?.status ?? null}
            />
            {shownId ? (
              <BatchView id={shownId} />
            ) : canEdit ? (
              <Card title="Start">
                <p>
                  {list.data.conversionDate
                    ? 'Create an opening batch to enter balances, or import them from CSV.'
                    : 'Set the conversion date first.'}
                </p>
                <ErrorAlert error={create.error} />
                <Button
                  disabled={!list.data.conversionDate}
                  busy={create.isPending}
                  onClick={() =>
                    create.mutate(undefined, {
                      onSuccess: (created) => {
                        void invalidate();
                        void navigate(`/accounting/opening-balances/${created.id}`);
                      },
                    })
                  }
                >
                  Enter opening balances
                </Button>
              </Card>
            ) : (
              <Alert tone="info">No opening balances have been entered yet.</Alert>
            )}
            {list.data.batches.some((b) => b.id !== shownId) ? (
              <Card title="History">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Created</th>
                      <th>Status</th>
                      <th>Opening date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.batches.map((b) => (
                      <tr key={b.id}>
                        <td>
                          <Link to={`/accounting/opening-balances/${b.id}`}>
                            {new Date(b.createdAt).toLocaleString()}
                          </Link>
                        </td>
                        <td>
                          <StatusLabel status={b.status} />
                        </td>
                        <td>{b.openingDate}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            ) : null}
          </>
        )}
      </AccountingPage>
    </>
  );
}
