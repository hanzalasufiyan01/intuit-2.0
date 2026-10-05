import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { useT } from '../../i18n/i18n';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts, useAccountingSetup } from '../accounting/shared';
import { orNull, StatusBadge, useOrgKey } from '../sales/shared';
import type { Page } from '../sales/types';
import { PurchasesNav } from './PurchasesSection';
import type {
  PaymentSummary,
  RefundDetail,
  RefundStatus,
  RefundSummary,
  VendorCreditSummary,
} from './types';

/**
 * Vendor refunds (Phase 4B-3; ADR 0004 P4-30, P4-33, P4-42): money a vendor pays back from a
 * payment's prepayment or a vendor credit's unapplied amount. Recorded at once (no draft or
 * approval); voided with a password confirmation. Refunds go to bank or cash accounts only.
 * Permission-aware; the server decides and computes every base amount and realized FX.
 */

type SourceType = 'payment' | 'vendor_credit';

function RefundStatusBadge({ status }: { status: RefundStatus }) {
  const t = useT();
  return status === 'RECORDED' ? (
    <span className="badge badge--posted">{t('purchases.status.recorded')}</span>
  ) : (
    <StatusBadge status={status} />
  );
}

const sourcePath = (type: SourceType, id: string) =>
  type === 'payment' ? `/purchases/payments/${id}` : `/purchases/vendor-credits/${id}`;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function RefundsPage() {
  const t = useT();
  const org = useOrgKey();
  const canCreate = usePermission(Permission.VendorPaymentsCreate);
  const [filters, setFilters] = useState({ status: '', search: '' });
  const [applied, setApplied] = useState(filters);
  const list = useQuery({
    queryKey: ['vendor-refunds', org, applied],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (applied.status) params.set('status', applied.status);
      if (applied.search.trim()) params.set('search', applied.search.trim());
      return api.get<Page<RefundSummary>>(`/purchases/refunds?${params.toString()}`);
    },
  });
  return (
    <>
      <PageHeader
        title={t('purchases.refunds.title')}
        description={t('purchases.refunds.description')}
      />
      <PurchasesNav />
      {canCreate ? (
        <p className="actions">
          <Link className="btn" to="/purchases/refunds/new">
            {t('purchases.refunds.new')}
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
            hint={t('purchases.refunds.searchHint')}
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <div className="field">
            <label htmlFor="refund-status">{t('purchases.field.status')}</label>
            <select
              id="refund-status"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">{t('common.all')}</option>
              <option value="RECORDED">{t('purchases.status.recorded')}</option>
              <option value="VOID">{t('sales.status.void')}</option>
            </select>
          </div>
          <Button type="submit">{t('common.search')}</Button>
        </form>
        {list.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : (
          <RefundTable rows={list.data.items} showVendor />
        )}
      </Card>
    </>
  );
}

function RefundTable({
  rows,
  showVendor,
}: {
  rows: readonly RefundSummary[];
  showVendor: boolean;
}) {
  const t = useT();
  if (rows.length === 0) return <p className="muted">{t('purchases.refunds.none')}</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('purchases.bills.number')}</th>
          {showVendor ? <th>{t('purchases.bills.vendor')}</th> : null}
          <th>{t('purchases.refunds.date')}</th>
          <th className="num">{t('purchases.refunds.amount')}</th>
          <th>{t('purchases.field.status')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <Link to={`/purchases/refunds/${r.id}`}>{r.number}</Link>
            </td>
            {showVendor ? <td>{r.vendorName}</td> : null}
            <td>{r.refundDate}</td>
            <td className="num">
              {formatAmount(r.amount, r.currencyCode)} {r.currencyCode}
            </td>
            <td>
              <RefundStatusBadge status={r.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The refunds taken from a payment or a vendor credit, with a link to record another. */
export function RefundHistory({
  sourceType,
  sourceId,
  canRefund,
}: {
  sourceType: SourceType;
  sourceId: string;
  canRefund: boolean;
}) {
  const t = useT();
  const refunds = useRefundsOf(sourceType, sourceId);
  return (
    <Card title={t('purchases.refunds.history')}>
      {refunds.isPending ? (
        <Spinner label={t('common.loading')} />
      ) : refunds.isError ? (
        <ErrorAlert error={refunds.error} />
      ) : refunds.data.items.length === 0 ? (
        <p className="muted">{t('purchases.refunds.historyNone')}</p>
      ) : (
        <RefundTable rows={refunds.data.items} showVendor={false} />
      )}
      {canRefund ? (
        <p className="actions">
          <Link
            className="btn btn--secondary"
            to={`/purchases/refunds/new?sourceType=${sourceType}&sourceId=${sourceId}`}
          >
            {sourceType === 'payment'
              ? t('purchases.refunds.refundPrepayment')
              : t('purchases.refunds.refundCredit')}
          </Link>
        </p>
      ) : null}
    </Card>
  );
}

/** Refunds of one source (also used to block a payment void while any is active). */
export function useRefundsOf(sourceType: SourceType, sourceId: string, enabled = true) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['vendor-refunds', org, sourceType, sourceId],
    queryFn: () =>
      api.get<Page<RefundSummary>>(
        `/purchases/refunds?${sourceType === 'payment' ? 'paymentId' : 'vendorCreditId'}=${sourceId}&limit=200`,
      ),
    enabled,
  });
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
  date: string;
}

/** Open sources: payments with a prepayment balance and posted credits with an unapplied amount. */
function useOpenSources(canCredits: boolean) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['refund-sources', org, canCredits],
    queryFn: async (): Promise<OpenSource[]> => {
      const payments = await api.get<Page<PaymentSummary>>(
        '/purchases/payments?status=RECORDED&withUnallocated=true&limit=200',
      );
      const credits = canCredits
        ? await api.get<Page<VendorCreditSummary>>(
            '/purchases/vendor-credits?status=POSTED&limit=200',
          )
        : { items: [] as VendorCreditSummary[] };
      return [
        ...payments.items.map((p) => ({
          type: 'payment' as const,
          id: p.id,
          label: `${p.number} · ${p.vendorName ?? ''}`,
          currencyCode: p.currencyCode,
          available: p.amountUnallocated ?? '0',
          date: p.paymentDate,
        })),
        ...credits.items
          .filter((c) => Number(c.amountUnapplied ?? 0) > 0)
          .map((c) => ({
            type: 'vendor_credit' as const,
            id: c.id,
            label: `${c.number} · ${c.vendorName ?? ''}`,
            currencyCode: c.currencyCode,
            available: c.amountUnapplied ?? '0',
            date: c.creditDate,
          })),
      ];
    },
  });
}

export function RecordRefundPage() {
  const t = useT();
  const navigate = useNavigate();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const canCredits = usePermission(Permission.VendorCreditsView);
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
    api.post<RefundDetail>('/purchases/refunds', body, { idempotencyKey }),
  );
  const source = (sources.data ?? []).find((s) => `${s.type}:${s.id}` === sourceKey);
  const baseCurrency = setup.data?.settings?.baseCurrency ?? null;
  const currency = source?.currencyCode ?? '';
  const foreign = currency !== '' && baseCurrency !== null && currency !== baseCurrency;
  // Refunds go to bank or cash only (4B-3); the server checks the currency rule too.
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
          queryClient.setQueryData(['vendor-refund', org, refund.id], refund);
          void queryClient.invalidateQueries({ queryKey: ['vendor-refunds', org] });
          void queryClient.invalidateQueries({ queryKey: ['vendor-payment', org] });
          void queryClient.invalidateQueries({ queryKey: ['vendor-credit', org] });
          void navigate(`/purchases/refunds/${refund.id}`);
        },
      },
    );
  };

  return (
    <>
      <PageHeader title={t('purchases.refunds.new')} />
      <PurchasesNav />
      {sources.isPending ? (
        <Spinner label={t('common.loading')} />
      ) : (
        <form className="form" onSubmit={submit}>
          <ErrorAlert error={record.error} />
          <Card title={t('purchases.refunds.details')}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="refund-source">{t('purchases.refunds.source')}</label>
                <select
                  id="refund-source"
                  value={sourceKey}
                  required
                  onChange={(e) => setSourceKey(e.target.value)}
                >
                  <option value="">{t('purchases.refunds.chooseSource')}</option>
                  {(sources.data ?? []).map((s) => (
                    <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`}>
                      {s.type === 'payment'
                        ? t('purchases.refunds.sourcePayment')
                        : t('purchases.refunds.sourceCredit')}{' '}
                      {s.label} ·{' '}
                      {t('purchases.refunds.available', {
                        amount: formatAmount(s.available, s.currencyCode),
                        currency: s.currencyCode,
                      })}
                    </option>
                  ))}
                </select>
                {(sources.data ?? []).length === 0 ? (
                  <small className="field__hint">{t('purchases.refunds.noSources')}</small>
                ) : null}
                {issue('sourceId') ? (
                  <small className="field__error">{issue('sourceId')}</small>
                ) : null}
              </div>
              <TextField
                label={t('purchases.refunds.date')}
                type="date"
                value={refundDate}
                required
                error={issue('refundDate')}
                onChange={(e) => setRefundDate(e.target.value)}
              />
              <TextField
                label={`${t('purchases.refunds.amount')}${currency ? ` (${currency})` : ''}`}
                inputMode="decimal"
                value={amount}
                required
                error={issue('amount')}
                onChange={(e) => setAmount(e.target.value)}
              />
              <div className="field">
                <label htmlFor="refund-account">{t('purchases.refunds.account')}</label>
                <select
                  id="refund-account"
                  value={refundAccountId}
                  onChange={(e) => setRefundAccountId(e.target.value)}
                >
                  <option value="">{t('purchases.payments.accountDefault')}</option>
                  {refundAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name} ({a.currencyCode})
                    </option>
                  ))}
                </select>
                <small className="field__hint">{t('purchases.refunds.accountHint')}</small>
                {issue('refundAccountId') ? (
                  <small className="field__error">{issue('refundAccountId')}</small>
                ) : null}
              </div>
              {foreign ? (
                <>
                  <TextField
                    label={t('purchases.bills.rateOverride')}
                    inputMode="decimal"
                    hint={t('purchases.bills.rateHint')}
                    value={rateOverride}
                    error={issue('rateOverride')}
                    onChange={(e) => setRateOverride(e.target.value)}
                  />
                  <TextField
                    label={t('purchases.bills.rateReason')}
                    value={rateOverrideReason}
                    error={issue('rateOverrideReason')}
                    onChange={(e) => setRateOverrideReason(e.target.value)}
                  />
                </>
              ) : null}
              <TextField
                label={t('purchases.payments.reference')}
                value={reference}
                error={issue('reference')}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <TextField
              label={t('purchases.field.memo')}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </Card>
          <p className="actions">
            <Button type="submit" busy={record.isPending} disabled={!source}>
              {t('purchases.refunds.new')}
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

export function RefundDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canVoid = usePermission(Permission.VendorPaymentsVoid);
  const canJournals = usePermission(Permission.JournalsView);
  const refund = useQuery({
    queryKey: ['vendor-refund', org, id],
    queryFn: () => api.get<RefundDetail>(`/purchases/refunds/${id}`),
  });
  const [voidReason, setVoidReason] = useState('');
  // P4-42: voiding a refund asks for the password again.
  const voidRefund = useApiMutation(() =>
    sensitive(() =>
      api.post<RefundDetail>(`/purchases/refunds/${id}/void`, {
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
        title={t('purchases.refunds.titleNumber', { number: r.number })}
        description={r.vendorName ?? undefined}
      />
      <PurchasesNav />
      <ErrorAlert error={voidRefund.error} />
      <Card title={t('purchases.bills.summary')} actions={<RefundStatusBadge status={r.status} />}>
        <dl className="facts">
          <dt>{t('purchases.bills.vendor')}</dt>
          <dd>
            <Link to={`/purchases/vendors/${r.vendorId}`}>{r.vendorName}</Link>
          </dd>
          <dt>{t('purchases.refunds.source')}</dt>
          <dd>
            <Link to={sourcePath(r.sourceType, r.sourceId)}>
              {r.sourceType === 'payment'
                ? t('purchases.refunds.sourcePayment')
                : t('purchases.refunds.sourceCredit')}{' '}
              {r.sourceNumber}
            </Link>
          </dd>
          <dt>{t('purchases.refunds.date')}</dt>
          <dd>{r.refundDate}</dd>
          <dt>{t('purchases.refunds.amount')}</dt>
          <dd>
            {formatAmount(r.amount, r.currencyCode)} {r.currencyCode}
          </dd>
          {r.currencyCode !== base ? (
            <>
              <dt>{t('purchases.bills.rate')}</dt>
              <dd>
                {Number(r.exchangeRate)} ({r.exchangeRateSource})
                {r.tableRate && r.exchangeRateSource !== 'table'
                  ? ` · ${t('purchases.bills.tableRate', { rate: String(Number(r.tableRate)) })}`
                  : ''}
                {r.rateOverrideReason ? ` — ${r.rateOverrideReason}` : ''}
              </dd>
            </>
          ) : null}
          <dt>{t('purchases.refunds.received')}</dt>
          <dd>
            {formatAmount(r.baseAmount, base)} {base}
          </dd>
          <dt>{t('purchases.refunds.released')}</dt>
          <dd>
            {formatAmount(r.baseReleased, base)} {base}
          </dd>
          {Number(r.fxDifference) !== 0 ? (
            <>
              <dt>{t('purchases.refunds.fx')}</dt>
              <dd>
                {formatAmount(r.fxDifference, base)} {base}
              </dd>
            </>
          ) : null}
          <dt>{t('purchases.refunds.account')}</dt>
          <dd>
            <RefundAccountName id={r.refundAccountId} /> (
            {r.refundAccountOverridden
              ? t('purchases.payments.overridden')
              : t('purchases.payments.accountDefault')}
            )
          </dd>
          {r.reference ? (
            <>
              <dt>{t('purchases.payments.reference')}</dt>
              <dd>{r.reference}</dd>
            </>
          ) : null}
          {r.voidReason ? (
            <>
              <dt>{t('purchases.bills.voidReason')}</dt>
              <dd>{r.voidReason}</dd>
            </>
          ) : null}
          {canJournals ? (
            <>
              <dt>{t('purchases.payments.journalLabel')}</dt>
              <dd>
                <Link to={`/accounting/journals/${r.journalId}`}>
                  {t('purchases.payments.journal')}
                </Link>
                {r.voidJournalId ? (
                  <>
                    {' · '}
                    <Link to={`/accounting/journals/${r.voidJournalId}`}>
                      {t('purchases.payments.voidJournal')}
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
        <Card title={t('purchases.refunds.voidTitle')}>
          <p className="muted">{t('purchases.refunds.voidNote')}</p>
          <form
            className="form form--inline"
            onSubmit={(e) => {
              e.preventDefault();
              voidRefund.mutate(undefined, {
                onSuccess: (data) => {
                  queryClient.setQueryData(['vendor-refund', org, id], data);
                  void queryClient.invalidateQueries({ queryKey: ['vendor-refunds', org] });
                },
              });
            }}
          >
            <TextField
              label={t('purchases.bills.voidReason')}
              value={voidReason}
              required
              onChange={(e) => setVoidReason(e.target.value)}
            />
            <Button type="submit" variant="secondary" busy={voidRefund.isPending}>
              {t('purchases.bills.void')}
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
