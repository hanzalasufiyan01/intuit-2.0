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
import { useT } from '../../i18n/i18n';

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
  const t = useT();
  return status === 'RECORDED' ? (
    <span className="badge badge--posted">{t('sales.refundPages.recorded')}</span>
  ) : (
    <span className="badge badge--void">{t('sales.refundPages.void')}</span>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function CustomerRefundsPage() {
  const t = useT();
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
        title={t('sales.refundPages.customerRefunds')}
        description={t('sales.refundPages.moneyPaidBackToCustomers')}
      />
      <SalesNav />
      {canCreate ? (
        <p className="actions">
          <Link className="btn" to="/sales/refunds/new">
            {t('sales.refundPages.newRefund')}
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
            label={t('common.search')}
            hint={t('sales.refundPages.numberReferenceOrCustomer')}
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <div className="field">
            <label htmlFor="cr-status">{t('sales.refundPages.status')}</label>
            <select
              id="cr-status"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">{t('common.all')}</option>
              <option value="RECORDED">{t('sales.refundPages.recorded')}</option>
              <option value="VOID">{t('sales.refundPages.void')}</option>
            </select>
          </div>
          <Button type="submit">{t('common.search')}</Button>
        </form>
        {list.isPending ? (
          <Spinner label={t('common.loading')} />
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
  const t = useT();
  if (rows.length === 0) return <p className="muted">{t('sales.refundPages.noRefunds')}</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('sales.refundPages.number')}</th>
          {showCustomer ? <th>{t('sales.refundPages.customer')}</th> : null}
          <th>{t('sales.refundPages.date')}</th>
          <th className="num">{t('sales.refundPages.amount')}</th>
          <th>{t('sales.refundPages.status')}</th>
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
  const t = useT();
  const org = useOrgKey();
  const refunds = useQuery({
    queryKey: ['customer-refunds', org, sourceType, sourceId],
    queryFn: () =>
      api.get<Page<RefundSummary>>(
        `/sales/refunds?${sourceType === 'receipt' ? 'receiptId' : 'creditNoteId'}=${sourceId}&limit=200`,
      ),
  });
  return (
    <Card title={t('sales.refundPages.refunds')}>
      {refunds.isPending ? (
        <Spinner label={t('common.loading')} />
      ) : refunds.isError ? (
        <ErrorAlert error={refunds.error} />
      ) : refunds.data.items.length === 0 ? (
        <p className="muted">{t('sales.refundPages.nothingHasBeenRefundedFrom')}</p>
      ) : (
        <RefundTable rows={refunds.data.items} showCustomer={false} />
      )}
      {canRefund ? (
        <p className="actions">
          <Link
            className="btn btn--secondary"
            to={`/sales/refunds/new?sourceType=${sourceType}&sourceId=${sourceId}`}
          >
            {sourceType === 'receipt'
              ? t('sales.refundPages.refundUnallocatedAmount')
              : t('sales.refundPages.refundCredit')}
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
  const t = useT();
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
      <PageHeader title={t('sales.refundPages.newRefund')} />
      <SalesNav />
      {sources.isPending ? (
        <Spinner label={t('common.loading')} />
      ) : (
        <form className="form" onSubmit={submit}>
          <ErrorAlert error={record.error} />
          <Card title={t('sales.refundPages.refundDetails')}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="cr-source">{t('sales.refundPages.refundFrom')}</label>
                <select
                  id="cr-source"
                  value={sourceKey}
                  required
                  onChange={(e) => setSourceKey(e.target.value)}
                >
                  <option value="">{t('sales.refundPages.chooseAReceiptOrCredit')}</option>
                  {(sources.data ?? []).map((s) => (
                    <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`}>
                      {t('sales.refundPages.available', {
                        value:
                          s.type === 'receipt'
                            ? t('sales.refundPages.receipt')
                            : t('sales.refundPages.creditNote'),
                        label: s.label,
                        value2: formatAmount(s.available, s.currencyCode),
                        currencyCode: s.currencyCode,
                      })}
                    </option>
                  ))}
                </select>
                {(sources.data ?? []).length === 0 ? (
                  <small className="field__hint">
                    {t('sales.refundPages.noReceiptHasAnUnallocated')}
                  </small>
                ) : null}
                {issue('sourceId') ? (
                  <small className="field__error">{issue('sourceId')}</small>
                ) : null}
              </div>
              <TextField
                label={t('sales.refundPages.refundDate')}
                type="date"
                value={refundDate}
                required
                error={issue('refundDate')}
                onChange={(e) => setRefundDate(e.target.value)}
              />
              <TextField
                label={t('sales.refundPages.amount2', { value: currency ? ` (${currency})` : '' })}
                inputMode="decimal"
                value={amount}
                required
                error={issue('amount')}
                onChange={(e) => setAmount(e.target.value)}
              />
              <div className="field">
                <label htmlFor="cr-account">{t('sales.refundPages.paidFromAccount')}</label>
                <select
                  id="cr-account"
                  value={refundAccountId}
                  onChange={(e) => setRefundAccountId(e.target.value)}
                >
                  <option value="">{t('sales.refundPages.defaultDepositAccount')}</option>
                  {refundAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name} ({a.currencyCode})
                    </option>
                  ))}
                </select>
                <small className="field__hint">
                  {t('sales.refundPages.bankOrCashAccountsOnly')}
                </small>
                {issue('refundAccountId') ? (
                  <small className="field__error">{issue('refundAccountId')}</small>
                ) : null}
              </div>
              {foreign ? (
                <>
                  <TextField
                    label={t('sales.refundPages.exchangeRateOverride')}
                    inputMode="decimal"
                    hint={t('sales.refundPages.leaveEmptyToUseThe')}
                    value={rateOverride}
                    error={issue('rateOverride')}
                    onChange={(e) => setRateOverride(e.target.value)}
                  />
                  <TextField
                    label={t('sales.refundPages.reasonForTheOverride')}
                    value={rateOverrideReason}
                    error={issue('rateOverrideReason')}
                    onChange={(e) => setRateOverrideReason(e.target.value)}
                  />
                </>
              ) : null}
              <TextField
                label={t('sales.refundPages.reference')}
                value={reference}
                error={issue('reference')}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <TextField
              label={t('sales.refundPages.memo')}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </Card>
          <p className="actions">
            <Button type="submit" busy={record.isPending} disabled={!source}>
              {t('sales.refundPages.recordRefund')}
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
  const t = useT();
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
  if (refund.isPending) return <Spinner label={t('common.loading')} />;
  if (refund.isError) return <ErrorAlert error={refund.error} />;
  const r = refund.data;
  const base = r.baseCurrency;
  return (
    <>
      <PageHeader
        title={t('sales.refundPages.refund', { number: r.number })}
        description={r.customerName ?? undefined}
      />
      <SalesNav />
      <ErrorAlert error={voidRefund.error} />
      <Card title={t('sales.refundPages.summary')} actions={<StatusBadge status={r.status} />}>
        <dl className="facts">
          <dt>{t('sales.refundPages.customer')}</dt>
          <dd>
            <Link to={`/sales/customers/${r.customerId}`}>{r.customerName}</Link>
          </dd>
          <dt>{t('sales.refundPages.refundedFrom')}</dt>
          <dd>
            <Link to={sourcePath(r.sourceType, r.sourceId)}>
              {r.sourceType === 'receipt'
                ? t('sales.refundPages.receipt')
                : t('sales.refundPages.creditNote')}{' '}
              {r.sourceNumber}
            </Link>
          </dd>
          <dt>{t('sales.refundPages.date')}</dt>
          <dd>{r.refundDate}</dd>
          <dt>{t('sales.refundPages.amount')}</dt>
          <dd>
            {formatAmount(r.amount, r.currencyCode)} {r.currencyCode}
          </dd>
          {r.currencyCode !== base ? (
            <>
              <dt>{t('sales.refundPages.exchangeRate')}</dt>
              <dd>
                {Number(r.exchangeRate)} ({r.exchangeRateSource})
                {r.tableRate && r.exchangeRateSource !== 'table'
                  ? t('sales.refundPages.tableRate', { value: Number(r.tableRate) })
                  : ''}
                {r.rateOverrideReason ? ` — ${r.rateOverrideReason}` : ''}
              </dd>
            </>
          ) : null}
          <dt>{t('sales.refundPages.paidOut', { base })}</dt>
          <dd>
            {formatAmount(r.baseAmount, base)} {base}
          </dd>
          <dt>{t('sales.refundPages.releasedFromReceivables', { base })}</dt>
          <dd>
            {formatAmount(r.baseReleased, base)} {base}
          </dd>
          {Number(r.fxDifference) !== 0 ? (
            <>
              <dt>{t('sales.refundPages.realizedFxGainLoss')}</dt>
              <dd>
                {formatAmount(r.fxDifference, base)} {base}
              </dd>
            </>
          ) : null}
          <dt>{t('sales.refundPages.paidFromAccount')}</dt>
          <dd>
            <RefundAccountName id={r.refundAccountId} /> (
            {r.refundAccountOverridden
              ? t('sales.refundPages.overridden')
              : t('sales.refundPages.default')}
            )
          </dd>
          {r.reference ? (
            <>
              <dt>{t('sales.refundPages.reference')}</dt>
              <dd>{r.reference}</dd>
            </>
          ) : null}
          {r.voidReason ? (
            <>
              <dt>{t('sales.refundPages.voidReason')}</dt>
              <dd>{r.voidReason}</dd>
            </>
          ) : null}
          {canJournals ? (
            <>
              <dt>{t('sales.refundPages.journal')}</dt>
              <dd>
                <Link to={`/accounting/journals/${r.journalId}`}>
                  {t('sales.refundPages.journal')}
                </Link>
                {r.voidJournalId ? (
                  <>
                    {' · '}
                    <Link to={`/accounting/journals/${r.voidJournalId}`}>
                      {t('sales.refundPages.voidJournal')}
                    </Link>
                  </>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
        {r.memo ? <p className="memo">{r.memo}</p> : null}
      </Card>
      {r.status === 'RECORDED' && canVoid ? (
        <Card title={t('sales.refundPages.voidThisRefund')}>
          <p className="muted">{t('sales.refundPages.voidingReversesTheJournalAnd')}</p>
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
              label={t('sales.refundPages.voidReason')}
              value={voidReason}
              required
              onChange={(e) => setVoidReason(e.target.value)}
            />
            <Button type="submit" variant="secondary" busy={voidRefund.isPending}>
              {t('sales.refundPages.void')}
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
