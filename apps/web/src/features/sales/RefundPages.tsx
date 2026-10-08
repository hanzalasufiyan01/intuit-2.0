import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts, useAccountingSetup } from '../accounting/shared';
import { orNull, SalesNav, useOrgKey } from './shared';
import type { CreditNoteSummary, Page, ReceiptSummary } from './types';

/**
 * Customer refunds: money paid back from a receipt's unallocated amount or a credit note's
 * unapplied amount. Recorded at once (no draft or approval); voided with a password confirmation.
 * Refunds are paid from bank or cash accounts only. The server decides and computes every base
 * amount and realized FX.
 */

type SourceType = 'receipt' | 'credit_note';
type RefundStatus = 'RECORDED' | 'VOID';

interface RefundSummary {
  id: string;
  status: RefundStatus;
  number: string;
  customerId: string;
  customerName: string | null;
  sourceType: SourceType;
  sourceId: string;
  refundDate: string;
  currencyCode: string;
  amount: string;
  baseAmount: string;
  reference: string | null;
  version: number;
}

interface RefundDetail extends RefundSummary {
  sourceNumber: string | null;
  refundAccountId: string;
  refundAccountOverridden: boolean;
  exchangeRate: string;
  exchangeRateSource: 'base' | 'table' | 'manual';
  tableRate: string | null;
  rateOverrideReason: string | null;
  baseReleased: string;
  fxDifference: string;
  memo: string;
  journalId: string;
  voidReason: string | null;
  voidJournalId: string | null;
  baseCurrency: string;
}

const sourcePath = (type: SourceType, id: string) =>
  type === 'receipt' ? `/sales/receipts/${id}` : `/sales/credit-notes/${id}`;

function StatusBadge({ status }: { status: RefundStatus }) {
  return status === 'RECORDED' ? (
    <span className="badge badge--posted">Recorded</span>
  ) : (
    <span className="badge badge--void">Void</span>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function CustomerRefundsPage() {
  const org = useOrgKey();
  const canCreate = usePermission(Permission.ReceiptsCreate);
  const [filters, setFilters] = useState({ status: '', search: '' });
  const [applied, setApplied] = useState(filters);
  const list = useQuery({
    queryKey: ['customer-refunds', org, applied],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (applied.status) params.set('status', applied.status);
      if (applied.search.trim()) params.set('search', applied.search.trim());
      return api.get<Page<RefundSummary>>(`/sales/refunds?${params.toString()}`);
    },
  });
  return (
    <>
      <PageHeader
        title="Customer refunds"
        description="Money paid back to customers from unallocated receipts and unapplied credit notes."
      />
      <SalesNav />
      {canCreate ? (
        <p className="actions">
          <Link className="btn" to="/sales/refunds/new">
            New refund
          </Link>
        </p>
      ) : null}
      <Card>
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(filters);
          }}
        >
          <TextField
            label="Search"
            hint="Number, reference or customer"
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <div className="field">
            <label htmlFor="cr-status">Status</label>
            <select
              id="cr-status"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">All</option>
              <option value="RECORDED">Recorded</option>
              <option value="VOID">Void</option>
            </select>
          </div>
          <Button type="submit">Search</Button>
        </form>
        {list.isPending ? (
          <Spinner label="Loading…" />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : (
          <RefundTable rows={list.data.items} showCustomer />
        )}
      </Card>
    </>
  );
}

function RefundTable({
  rows,
  showCustomer,
}: {
  rows: readonly RefundSummary[];
  showCustomer: boolean;
}) {
  if (rows.length === 0) return <p className="muted">No refunds.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Number</th>
          {showCustomer ? <th>Customer</th> : null}
          <th>Date</th>
          <th className="num">Amount</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <Link to={`/sales/refunds/${r.id}`}>{r.number}</Link>
            </td>
            {showCustomer ? <td>{r.customerName}</td> : null}
            <td>{r.refundDate}</td>
            <td className="num">
              {formatAmount(r.amount, r.currencyCode)} {r.currencyCode}
            </td>
            <td>
              <StatusBadge status={r.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The refunds taken from a receipt or a credit note, with a link to record another. */
export function CustomerRefundHistory({
  sourceType,
  sourceId,
  canRefund,
}: {
  sourceType: SourceType;
  sourceId: string;
  canRefund: boolean;
}) {
  const org = useOrgKey();
  const refunds = useQuery({
    queryKey: ['customer-refunds', org, sourceType, sourceId],
    queryFn: () =>
      api.get<Page<RefundSummary>>(
        `/sales/refunds?${sourceType === 'receipt' ? 'receiptId' : 'creditNoteId'}=${sourceId}&limit=200`,
      ),
  });
  return (
    <Card title="Refunds">
      {refunds.isPending ? (
        <Spinner label="Loading…" />
      ) : refunds.isError ? (
        <ErrorAlert error={refunds.error} />
      ) : refunds.data.items.length === 0 ? (
        <p className="muted">Nothing has been refunded from this document.</p>
      ) : (
        <RefundTable rows={refunds.data.items} showCustomer={false} />
      )}
      {canRefund ? (
        <p className="actions">
          <Link
            className="btn btn--secondary"
            to={`/sales/refunds/new?sourceType=${sourceType}&sourceId=${sourceId}`}
          >
            {sourceType === 'receipt' ? 'Refund unallocated amount' : 'Refund credit'}
          </Link>
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

interface OpenSource {
  type: SourceType;
  id: string;
  label: string;
  currencyCode: string;
  available: string;
}

function useOpenSources(canCredits: boolean) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['customer-refund-sources', org, canCredits],
    queryFn: async (): Promise<OpenSource[]> => {
      const receipts = await api.get<Page<ReceiptSummary>>(
        '/sales/receipts?status=RECORDED&withCredit=true&limit=200',
      );
      const notes = canCredits
        ? await api.get<Page<CreditNoteSummary>>('/sales/credit-notes?status=ISSUED&limit=200')
        : { items: [] as CreditNoteSummary[] };
      return [
        ...receipts.items.map((r) => ({
          type: 'receipt' as const,
          id: r.id,
          label: `${r.number} · ${r.customerName ?? ''}`,
          currencyCode: r.currencyCode,
          available: r.amountUnallocated,
        })),
        ...notes.items
          .filter((n) => Number(n.amountUnapplied ?? 0) > 0)
          .map((n) => ({
            type: 'credit_note' as const,
            id: n.id,
            label: `${n.number ?? ''} · ${n.customerName ?? ''}`,
            currencyCode: n.currencyCode,
            available: n.amountUnapplied ?? '0',
          })),
      ];
    },
  });
}

export function RecordCustomerRefundPage() {
  const navigate = useNavigate();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const canCredits = usePermission(Permission.CreditNotesView);
  const canAccounts = usePermission(Permission.AccountsView);
  const sources = useOpenSources(canCredits);
  const accounts = useAccounts(canAccounts);
  const setup = useAccountingSetup();
  const [sourceKey, setSourceKey] = useState(() => {
    const type = params.get('sourceType');
    const id = params.get('sourceId');
    return type && id ? `${type}:${id}` : '';
  });
  const [refundDate, setRefundDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [refundAccountId, setRefundAccountId] = useState('');
  const [rateOverride, setRateOverride] = useState('');
  const [rateOverrideReason, setRateOverrideReason] = useState('');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  // One Idempotency-Key per form: a retried submission replays instead of refunding twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const record = useApiMutation((body: Record<string, unknown>) =>
    api.post<RefundDetail>('/sales/refunds', body, { idempotencyKey }),
  );
  const source = (sources.data ?? []).find((s) => `${s.type}:${s.id}` === sourceKey);
  const baseCurrency = setup.data?.settings?.baseCurrency ?? null;
  const currency = source?.currencyCode ?? '';
  const foreign = currency !== '' && baseCurrency !== null && currency !== baseCurrency;
  // Refunds are paid from bank or cash only; the server checks the currency rule too.
  const refundAccounts = (accounts.data ?? []).filter(
    (a) =>
      a.status === 'ACTIVE' &&
      a.isLeaf &&
      !a.isControlAccount &&
      (a.subtype === 'BANK' || a.subtype === 'CASH') &&
      (a.currencyCode === currency || a.currencyCode === baseCurrency),
  );
  const issue = (path: string) =>
    record.error instanceof ApiError ? record.error.fieldError(path) : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!source) return;
    record.mutate(
      {
        sourceType: source.type,
        sourceId: source.id,
        refundDate,
        amount: amount.trim(),
        refundAccountId: refundAccountId || null,
        rateOverride: foreign ? orNull(rateOverride) : null,
        rateOverrideReason: foreign ? orNull(rateOverrideReason) : null,
        reference: orNull(reference),
        memo: memo.trim(),
      },
      {
        onSuccess: (refund) => {
          queryClient.setQueryData(['customer-refund', org, refund.id], refund);
          void queryClient.invalidateQueries({ queryKey: ['customer-refunds', org] });
          void queryClient.invalidateQueries({ queryKey: ['receipt', org] });
          void queryClient.invalidateQueries({ queryKey: ['credit-note', org] });
          void navigate(`/sales/refunds/${refund.id}`);
        },
      },
    );
  };

  return (
    <>
      <PageHeader title="New refund" />
      <SalesNav />
      {sources.isPending ? (
        <Spinner label="Loading…" />
      ) : (
        <form className="form" onSubmit={submit}>
          <ErrorAlert error={record.error} />
          <Card title="Refund details">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="cr-source">Refund from</label>
                <select
                  id="cr-source"
                  value={sourceKey}
                  required
                  onChange={(e) => setSourceKey(e.target.value)}
                >
                  <option value="">Choose a receipt or credit note</option>
                  {(sources.data ?? []).map((s) => (
                    <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`}>
                      {s.type === 'receipt' ? 'Receipt' : 'Credit note'} {s.label} · available{' '}
                      {formatAmount(s.available, s.currencyCode)} {s.currencyCode}
                    </option>
                  ))}
                </select>
                {(sources.data ?? []).length === 0 ? (
                  <small className="field__hint">
                    No receipt has an unallocated amount and no credit note has an unapplied amount.
                  </small>
                ) : null}
                {issue('sourceId') ? (
                  <small className="field__error">{issue('sourceId')}</small>
                ) : null}
              </div>
              <TextField
                label="Refund date"
                type="date"
                value={refundDate}
                required
                error={issue('refundDate')}
                onChange={(e) => setRefundDate(e.target.value)}
              />
              <TextField
                label={`Amount${currency ? ` (${currency})` : ''}`}
                inputMode="decimal"
                value={amount}
                required
                error={issue('amount')}
                onChange={(e) => setAmount(e.target.value)}
              />
              <div className="field">
                <label htmlFor="cr-account">Paid from account</label>
                <select
                  id="cr-account"
                  value={refundAccountId}
                  onChange={(e) => setRefundAccountId(e.target.value)}
                >
                  <option value="">Default deposit account</option>
                  {refundAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name} ({a.currencyCode})
                    </option>
                  ))}
                </select>
                <small className="field__hint">Bank or cash accounts only.</small>
                {issue('refundAccountId') ? (
                  <small className="field__error">{issue('refundAccountId')}</small>
                ) : null}
              </div>
              {foreign ? (
                <>
                  <TextField
                    label="Exchange rate override"
                    inputMode="decimal"
                    hint="Leave empty to use the table rate on the refund date."
                    value={rateOverride}
                    error={issue('rateOverride')}
                    onChange={(e) => setRateOverride(e.target.value)}
                  />
                  <TextField
                    label="Reason for the override"
                    value={rateOverrideReason}
                    error={issue('rateOverrideReason')}
                    onChange={(e) => setRateOverrideReason(e.target.value)}
                  />
                </>
              ) : null}
              <TextField
                label="Reference"
                value={reference}
                error={issue('reference')}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <TextField label="Memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Card>
          <p className="actions">
            <Button type="submit" busy={record.isPending} disabled={!source}>
              Record refund
            </Button>
          </p>
        </form>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail and void
// ---------------------------------------------------------------------------

export function CustomerRefundDetailPage() {
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canVoid = usePermission(Permission.ReceiptsVoid);
  const canJournals = usePermission(Permission.JournalsView);
  const refund = useQuery({
    queryKey: ['customer-refund', org, id],
    queryFn: () => api.get<RefundDetail>(`/sales/refunds/${id}`),
  });
  const [voidReason, setVoidReason] = useState('');
  // Voiding a refund asks for the password again.
  const voidRefund = useApiMutation(() =>
    sensitive(() =>
      api.post<RefundDetail>(`/sales/refunds/${id}/void`, {
        version: refund.data!.version,
        reason: voidReason.trim(),
      }),
    ),
  );
  if (refund.isPending) return <Spinner label="Loading…" />;
  if (refund.isError) return <ErrorAlert error={refund.error} />;
  const r = refund.data;
  const base = r.baseCurrency;
  return (
    <>
      <PageHeader title={`Refund ${r.number}`} description={r.customerName ?? undefined} />
      <SalesNav />
      <ErrorAlert error={voidRefund.error} />
      <Card title="Summary" actions={<StatusBadge status={r.status} />}>
        <dl className="facts">
          <dt>Customer</dt>
          <dd>
            <Link to={`/sales/customers/${r.customerId}`}>{r.customerName}</Link>
          </dd>
          <dt>Refunded from</dt>
          <dd>
            <Link to={sourcePath(r.sourceType, r.sourceId)}>
              {r.sourceType === 'receipt' ? 'Receipt' : 'Credit note'} {r.sourceNumber}
            </Link>
          </dd>
          <dt>Date</dt>
          <dd>{r.refundDate}</dd>
          <dt>Amount</dt>
          <dd>
            {formatAmount(r.amount, r.currencyCode)} {r.currencyCode}
          </dd>
          {r.currencyCode !== base ? (
            <>
              <dt>Exchange rate</dt>
              <dd>
                {Number(r.exchangeRate)} ({r.exchangeRateSource})
                {r.tableRate && r.exchangeRateSource !== 'table'
                  ? ` · table rate ${Number(r.tableRate)}`
                  : ''}
                {r.rateOverrideReason ? ` — ${r.rateOverrideReason}` : ''}
              </dd>
            </>
          ) : null}
          <dt>Paid out ({base})</dt>
          <dd>
            {formatAmount(r.baseAmount, base)} {base}
          </dd>
          <dt>Released from receivables ({base})</dt>
          <dd>
            {formatAmount(r.baseReleased, base)} {base}
          </dd>
          {Number(r.fxDifference) !== 0 ? (
            <>
              <dt>Realized FX (gain +, loss −)</dt>
              <dd>
                {formatAmount(r.fxDifference, base)} {base}
              </dd>
            </>
          ) : null}
          <dt>Paid from account</dt>
          <dd>
            <RefundAccountName id={r.refundAccountId} /> (
            {r.refundAccountOverridden ? 'overridden' : 'default'})
          </dd>
          {r.reference ? (
            <>
              <dt>Reference</dt>
              <dd>{r.reference}</dd>
            </>
          ) : null}
          {r.voidReason ? (
            <>
              <dt>Void reason</dt>
              <dd>{r.voidReason}</dd>
            </>
          ) : null}
          {canJournals ? (
            <>
              <dt>Journal</dt>
              <dd>
                <Link to={`/accounting/journals/${r.journalId}`}>Journal</Link>
                {r.voidJournalId ? (
                  <>
                    {' · '}
                    <Link to={`/accounting/journals/${r.voidJournalId}`}>Void journal</Link>
                  </>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
        {r.memo ? <p className="memo">{r.memo}</p> : null}
      </Card>
      {r.status === 'RECORDED' && canVoid ? (
        <Card title="Void this refund">
          <p className="muted">
            Voiding reverses the journal and restores the receipt or credit note to its earlier
            balance. You will be asked for your password.
          </p>
          <form
            className="form form--inline"
            onSubmit={(e) => {
              e.preventDefault();
              voidRefund.mutate(undefined, {
                onSuccess: (data) => {
                  queryClient.setQueryData(['customer-refund', org, id], data);
                  void queryClient.invalidateQueries({ queryKey: ['customer-refunds', org] });
                },
              });
            }}
          >
            <TextField
              label="Void reason"
              value={voidReason}
              required
              onChange={(e) => setVoidReason(e.target.value)}
            />
            <Button type="submit" variant="secondary" busy={voidRefund.isPending}>
              Void
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}

function RefundAccountName({ id }: { id: string }) {
  const canAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canAccounts);
  const account = accounts.data?.find((a) => a.id === id);
  return account ? (
    <>
      {account.code} · {account.name}
    </>
  ) : null;
}
