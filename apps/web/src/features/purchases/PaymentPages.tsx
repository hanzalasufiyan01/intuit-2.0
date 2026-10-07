import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Decimal } from 'decimal.js';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { useT } from '../../i18n/i18n';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { COMMON_CURRENCIES, formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts, useAccountingSetup } from '../accounting/shared';
import type { ApprovalRequestSummary } from '../accounting/types';
import { ApprovalPanel } from '../sales/DocumentParts';
import { orNull, StatusBadge, useOrgKey } from '../sales/shared';
import type { Page } from '../sales/types';
import { PurchasesNav } from './PurchasesSection';
import { RefundHistory, useRefundsOf } from './RefundPages';
import { RemittancePanel } from './RemittancePanel';
import type {
  AllocationView,
  OpenBill,
  PaymentDetail,
  PaymentStatus,
  PaymentSummary,
  VendorSummary,
} from './types';

/**
 * Vendor payments, prepayments and AP credit application (Phase 4B-2; ADR 0004 P4-25 to P4-33).
 * The editor sends inputs only (base amounts and FX come from the server); payments settle posted
 * bills only (C2) and any excess is a prepayment. Recording needs no re-authentication (P4-42);
 * voiding does. Permission-aware; the server decides.
 */

const RECORD_ACTION = 'purchases.payment.record';

function usePayment(id: string) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['vendor-payment', org, id],
    queryFn: () => api.get<PaymentDetail>(`/purchases/payments/${id}`),
  });
}

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const t = useT();
  return status === 'RECORDED' ? (
    <span className="badge badge--posted">{t('purchases.status.recorded')}</span>
  ) : (
    <StatusBadge status={status} />
  );
}

/** Open bills of a vendor in a currency (the targets a payment or a credit can settle). */
function useOpenBills(vendorId: string, currencyCode: string, enabled: boolean) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['open-bills', org, vendorId, currencyCode],
    queryFn: () =>
      api.get<OpenBill[]>(
        `/purchases/payments/open-bills?vendorId=${vendorId}&currencyCode=${currencyCode}`,
      ),
    enabled: enabled && vendorId !== '' && currencyCode !== '',
  });
}

const sumOf = (values: readonly string[]) =>
  values.reduce((s, v) => {
    try {
      return v.trim() ? s.plus(new Decimal(v)) : s;
    } catch {
      return s;
    }
  }, new Decimal(0));

// ---------------------------------------------------------------------------
// List and approval queue
// ---------------------------------------------------------------------------

export function PaymentsPage() {
  const t = useT();
  const org = useOrgKey();
  const canCreate = usePermission(Permission.VendorPaymentsCreate);
  const [filters, setFilters] = useState({ status: '', search: '', withUnallocated: false });
  const [applied, setApplied] = useState(filters);
  const list = useQuery({
    queryKey: ['vendor-payments', org, applied],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (applied.status) params.set('status', applied.status);
      if (applied.search.trim()) params.set('search', applied.search.trim());
      if (applied.withUnallocated) params.set('withUnallocated', 'true');
      return api.get<Page<PaymentSummary>>(`/purchases/payments?${params.toString()}`);
    },
  });
  return (
    <>
      <PageHeader
        title={t('purchases.payments.title')}
        description={t('purchases.payments.description')}
      />
      <PurchasesNav />
      {canCreate ? (
        <p className="actions">
          <Link className="btn" to="/purchases/payments/new">
            {t('purchases.payments.new')}
          </Link>
        </p>
      ) : null}
      <PaymentApprovalQueue />
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
            hint={t('purchases.payments.searchHint')}
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <div className="field">
            <label htmlFor="payment-status">{t('purchases.field.status')}</label>
            <select
              id="payment-status"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">{t('common.all')}</option>
              <option value="DRAFT">{t('sales.status.draft')}</option>
              <option value="PENDING_APPROVAL">{t('sales.status.pendingApproval')}</option>
              <option value="RECORDED">{t('purchases.status.recorded')}</option>
              <option value="VOID">{t('sales.status.void')}</option>
            </select>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={filters.withUnallocated}
              onChange={(e) => setFilters({ ...filters, withUnallocated: e.target.checked })}
            />{' '}
            {t('purchases.payments.withUnallocated')}
          </label>
          <Button type="submit">{t('common.search')}</Button>
        </form>
        {list.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">{t('purchases.payments.none')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('purchases.bills.number')}</th>
                <th>{t('purchases.bills.vendor')}</th>
                <th>{t('purchases.payments.date')}</th>
                <th className="num">{t('purchases.payments.amount')}</th>
                <th className="num">{t('purchases.payments.unallocated')}</th>
                <th>{t('purchases.field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/purchases/payments/${p.id}`}>
                      {p.number ?? t('purchases.bills.draft')}
                    </Link>
                  </td>
                  <td>{p.vendorName}</td>
                  <td>{p.paymentDate}</td>
                  <td className="num">
                    {formatAmount(p.amount, p.currencyCode)} {p.currencyCode}
                  </td>
                  <td className="num">
                    {p.amountUnallocated ? formatAmount(p.amountUnallocated, p.currencyCode) : ''}
                  </td>
                  <td>
                    <PaymentStatusBadge status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

/** Payments awaiting approval that the user may decide (the shared approval routes). */
function PaymentApprovalQueue() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canApprove = usePermission(Permission.VendorPaymentsApprove);
  const requests = useQuery({
    queryKey: ['approval-requests', org],
    queryFn: () => api.get<ApprovalRequestSummary[]>('/approvals/requests'),
    enabled: canApprove,
  });
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const decide = useApiMutation(
    (input: { id: string; decision: 'approve' | 'reject'; comment?: string }) =>
      sensitive(() =>
        api.post(`/approvals/requests/${input.id}/${input.decision}`, {
          ...(input.comment ? { comment: input.comment } : {}),
        }),
      ),
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['approval-requests', org] });
    void queryClient.invalidateQueries({ queryKey: ['vendor-payments', org] });
  };
  const payments = (requests.data ?? []).filter((r) => r.actionKey === RECORD_ACTION);
  if (!canApprove || payments.length === 0) return null;
  return (
    <Card title={t('purchases.payments.approvalQueue')}>
      <ErrorAlert error={decide.error} />
      <table className="table">
        <thead>
          <tr>
            <th>{t('purchases.payments.payment')}</th>
            <th>{t('purchases.bills.amount')}</th>
            <th>{t('purchases.bills.progress')}</th>
            <th>
              <span className="sr-only">{t('common.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {payments.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/purchases/payments/${r.subjectId}`}>
                  {t('purchases.payments.open')}
                </Link>
              </td>
              <td>
                {r.facts?.baseAmount
                  ? `${formatAmount(r.facts.baseAmount, r.facts.baseCurrency ?? '')} ${r.facts.baseCurrency}`
                  : ''}
              </td>
              <td>
                {r.progress
                  .map((s) => `${s.name}: ${s.approvals}/${s.requiredApprovals}`)
                  .join(', ')}
              </td>
              <td>
                {r.canDecide ? (
                  rejecting === r.id ? (
                    <form
                      className="form form--inline"
                      onSubmit={(e) => {
                        e.preventDefault();
                        decide.mutate(
                          { id: r.id, decision: 'reject', comment: comment.trim() },
                          {
                            onSuccess: () => {
                              setRejecting(null);
                              setComment('');
                              refresh();
                            },
                          },
                        );
                      }}
                    >
                      <TextField
                        label={t('purchases.bills.rejectReason')}
                        value={comment}
                        required
                        onChange={(e) => setComment(e.target.value)}
                      />
                      <Button type="submit" variant="secondary" busy={decide.isPending}>
                        {t('purchases.bills.reject')}
                      </Button>
                    </form>
                  ) : (
                    <>
                      <Button
                        busy={decide.isPending}
                        onClick={() =>
                          decide.mutate({ id: r.id, decision: 'approve' }, { onSuccess: refresh })
                        }
                      >
                        {t('purchases.bills.approve')}
                      </Button>
                      <Button variant="ghost" onClick={() => setRejecting(r.id)}>
                        {t('purchases.bills.reject')}
                      </Button>
                    </>
                  )
                ) : (
                  <span className="muted">{t('purchases.bills.notApprover')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** P4-26: bank, cash and credit-card leaf accounts (the server checks the currency rule too). */
const PAYMENT_SUBTYPES = ['BANK', 'CASH', 'CREDIT_CARD'];

function PaymentEditor({
  existing,
  saving,
  error,
  onSave,
}: {
  existing: PaymentDetail | null;
  saving: boolean;
  error: unknown;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const org = useOrgKey();
  const canAccounts = usePermission(Permission.AccountsView);
  const vendors = useQuery({
    queryKey: ['vendor-options', org],
    queryFn: () => api.get<Page<VendorSummary>>('/vendors?limit=200&status=active'),
  });
  const accounts = useAccounts(canAccounts);
  const setup = useAccountingSetup();
  const [vendorId, setVendorId] = useState(existing?.vendorId ?? '');
  const [paymentDate, setPaymentDate] = useState(
    existing?.paymentDate ?? new Date().toISOString().slice(0, 10),
  );
  const [currencyCode, setCurrencyCode] = useState(existing?.currencyCode ?? '');
  const [amount, setAmount] = useState(existing?.amount ?? '');
  const [paymentAccountId, setPaymentAccountId] = useState(existing?.paymentAccountId ?? '');
  const [rateOverride, setRateOverride] = useState(existing?.rateOverride ?? '');
  const [rateOverrideReason, setRateOverrideReason] = useState(existing?.rateOverrideReason ?? '');
  const [reference, setReference] = useState(existing?.reference ?? '');
  const [memo, setMemo] = useState(existing?.memo ?? '');
  const [pay, setPay] = useState<Record<string, string>>(
    Object.fromEntries((existing?.plannedAllocations ?? []).map((p) => [p.billId, p.amount])),
  );
  const vendor = vendors.data?.items.find((v) => v.id === vendorId);
  const currency = currencyCode || vendor?.currencyCode || '';
  const bills = useOpenBills(vendorId, currency, true);
  const baseCurrency = existing?.baseCurrency ?? setup.data?.settings?.baseCurrency ?? null;
  const foreign = currency !== '' && baseCurrency !== null && currency !== baseCurrency;
  const issue = (path: string) => (error instanceof ApiError ? error.fieldError(path) : undefined);
  const paymentAccounts = (accounts.data ?? []).filter(
    (a) =>
      a.status === 'ACTIVE' &&
      a.isLeaf &&
      !a.isControlAccount &&
      a.subtype !== null &&
      PAYMENT_SUBTYPES.includes(a.subtype) &&
      (a.currencyCode === currency || a.currencyCode === baseCurrency),
  );
  const allocations = Object.entries(pay)
    .filter(([, v]) => v.trim() !== '')
    .map(([billId, value]) => ({ billId, amount: value.trim() }));
  const allocated = sumOf(allocations.map((a) => a.amount));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      vendorId,
      paymentDate,
      ...(currencyCode ? { currencyCode } : {}),
      amount: amount.trim(),
      paymentAccountId: paymentAccountId || null,
      rateOverride: foreign ? orNull(rateOverride) : null,
      rateOverrideReason: foreign ? orNull(rateOverrideReason) : null,
      reference: orNull(reference),
      memo: memo.trim(),
      allocations,
    });
  };

  if (vendors.isPending) return <Spinner label={t('common.loading')} />;
  return (
    <form className="form" onSubmit={submit}>
      <ErrorAlert error={error} />
      <Card title={t('purchases.payments.details')}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="payment-vendor">{t('purchases.bills.vendor')}</label>
            <select
              id="payment-vendor"
              value={vendorId}
              required
              onChange={(e) => {
                setVendorId(e.target.value);
                setPay({});
              }}
            >
              <option value="">{t('common.choose')}</option>
              {(vendors.data?.items ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </select>
            {issue('vendorId') ? <small className="field__error">{issue('vendorId')}</small> : null}
          </div>
          <TextField
            label={t('purchases.payments.date')}
            type="date"
            value={paymentDate}
            required
            error={issue('paymentDate')}
            onChange={(e) => setPaymentDate(e.target.value)}
          />
          <div className="field">
            <label htmlFor="payment-currency">{t('purchases.field.currency')}</label>
            <select
              id="payment-currency"
              value={currencyCode}
              onChange={(e) => {
                setCurrencyCode(e.target.value);
                setPay({});
              }}
            >
              <option value="">
                {t('purchases.bills.vendorCurrency', { currency: vendor?.currencyCode ?? '' })}
              </option>
              {COMMON_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('purchases.payments.amount')}
            inputMode="decimal"
            value={amount}
            required
            error={issue('amount')}
            onChange={(e) => setAmount(e.target.value)}
          />
          <div className="field">
            <label htmlFor="payment-account">{t('purchases.payments.account')}</label>
            <select
              id="payment-account"
              value={paymentAccountId}
              onChange={(e) => setPaymentAccountId(e.target.value)}
            >
              <option value="">{t('purchases.payments.accountDefault')}</option>
              {paymentAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name} ({a.currencyCode})
                </option>
              ))}
              {paymentAccountId && !paymentAccounts.some((a) => a.id === paymentAccountId) ? (
                <option value={paymentAccountId}>{paymentAccountId}</option>
              ) : null}
            </select>
            <small className="field__hint">{t('purchases.payments.accountHint')}</small>
            {issue('paymentAccountId') ? (
              <small className="field__error">{issue('paymentAccountId')}</small>
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
      </Card>
      <Card title={t('purchases.payments.bills')}>
        <p className="muted">{t('purchases.payments.billsHint')}</p>
        {issue('allocations') ? (
          <small className="field__error">{issue('allocations')}</small>
        ) : null}
        {bills.isPending && vendorId ? (
          <Spinner label={t('common.loading')} />
        ) : (bills.data ?? []).length === 0 ? (
          <p className="muted">
            {vendorId ? t('purchases.payments.noOpenBills', { currency }) : null}
          </p>
        ) : (
          <table className="table table--editor">
            <thead>
              <tr>
                <th>{t('purchases.bills.number')}</th>
                <th>{t('purchases.field.reference')}</th>
                <th>{t('purchases.field.billDate')}</th>
                <th className="num">{t('purchases.payments.due')}</th>
                <th className="num">{t('purchases.payments.pay')}</th>
              </tr>
            </thead>
            <tbody>
              {(bills.data ?? []).map((b) => {
                const index = allocations.findIndex((a) => a.billId === b.id);
                const problem =
                  index >= 0
                    ? (issue(`allocations.${index}.amount`) ?? issue(`allocations.${index}.billId`))
                    : undefined;
                return (
                  <tr key={b.id}>
                    <td>{b.number}</td>
                    <td>{b.vendorReference}</td>
                    <td>{b.billDate}</td>
                    <td className="num">{formatAmount(b.amountDue, b.currencyCode)}</td>
                    <td className="num">
                      <input
                        aria-label={t('purchases.payments.payBill', { number: b.number })}
                        inputMode="decimal"
                        value={pay[b.id] ?? ''}
                        onChange={(e) => setPay({ ...pay, [b.id]: e.target.value })}
                      />
                      {problem ? <small className="field__error">{problem}</small> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p>
          {t('purchases.payments.allocated', {
            allocated: allocated.toFixed(2),
            amount: amount || '0',
          })}
        </p>
        <TextField
          label={t('purchases.field.memo')}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
      </Card>
      <p className="actions">
        <Button type="submit" busy={saving}>
          {t('purchases.bills.saveDraft')}
        </Button>
      </p>
    </form>
  );
}

export function NewPaymentPage() {
  const t = useT();
  const navigate = useNavigate();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  // A1: one Idempotency-Key per form, so a retried submission replays instead of duplicating.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const create = useApiMutation((body: Record<string, unknown>) =>
    api.post<PaymentDetail>('/purchases/payments', body, { idempotencyKey }),
  );
  return (
    <>
      <PageHeader title={t('purchases.payments.new')} />
      <PurchasesNav />
      <PaymentEditor
        existing={null}
        saving={create.isPending}
        error={create.error}
        onSave={(body) =>
          create.mutate(body, {
            onSuccess: (doc) => {
              queryClient.setQueryData(['vendor-payment', org, doc.id], doc);
              void queryClient.invalidateQueries({ queryKey: ['vendor-payments', org] });
              void navigate(`/purchases/payments/${doc.id}`);
            },
          })
        }
      />
    </>
  );
}

export function EditPaymentPage() {
  const t = useT();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const doc = usePayment(id);
  const save = useApiMutation((body: Record<string, unknown>) =>
    api.put<PaymentDetail>(`/purchases/payments/${id}`, { ...body, version: doc.data!.version }),
  );
  if (doc.isPending) return <Spinner label={t('common.loading')} />;
  if (doc.isError) return <ErrorAlert error={doc.error} />;
  return (
    <>
      <PageHeader title={t('purchases.payments.editTitle')} />
      <PurchasesNav />
      {doc.data.status !== 'DRAFT' ? (
        <Alert tone="info">{t('purchases.payments.notEditable')}</Alert>
      ) : (
        <PaymentEditor
          existing={doc.data}
          saving={save.isPending}
          error={save.error}
          onSave={(body) =>
            save.mutate(body, {
              onSuccess: (saved) => {
                queryClient.setQueryData(['vendor-payment', org, id], saved);
                void queryClient.invalidateQueries({ queryKey: ['vendor-payments', org] });
                void navigate(`/purchases/payments/${id}`);
              },
            })
          }
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Settlement history and credit application (shared with bills and vendor credits)
// ---------------------------------------------------------------------------

/** Settlement rows (payments, applications and their reversals) with links to the journals. */
export function AllocationTable({
  rows,
  show,
}: {
  rows: readonly AllocationView[];
  show: 'bill' | 'source';
}) {
  const t = useT();
  const canJournals = usePermission(Permission.JournalsView);
  if (rows.length === 0) return <p className="muted">{t('purchases.history.none')}</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('purchases.history.date')}</th>
          <th>{show === 'bill' ? t('purchases.history.bill') : t('purchases.history.source')}</th>
          <th className="num">{t('purchases.history.amount')}</th>
          <th className="num">{t('purchases.payments.fx')}</th>
          {canJournals ? (
            <th>
              <span className="sr-only">{t('purchases.payments.journal')}</span>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id}>
            <td>{a.allocationDate}</td>
            <td>
              {show === 'bill' ? (
                <Link to={`/purchases/bills/${a.billId}`}>{a.billNumber ?? a.billId}</Link>
              ) : (
                <Link
                  to={
                    a.sourceType === 'payment'
                      ? `/purchases/payments/${a.sourceId}`
                      : `/purchases/vendor-credits/${a.sourceId}`
                  }
                >
                  {a.sourceNumber ?? a.sourceId}
                </Link>
              )}
              {a.reversesAllocationId ? ` (${t('purchases.history.reversal')})` : ''}
            </td>
            <td className="num">
              {formatAmount(a.amount, a.currencyCode)} {a.currencyCode}
            </td>
            <td className="num">{Number(a.fxDifference) === 0 ? '' : a.fxDifference}</td>
            {canJournals ? (
              <td>
                <Link to={`/accounting/journals/${a.journalId}`}>
                  {t('purchases.payments.journal')}
                </Link>
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The settlement history of a bill or a vendor credit. */
export function SettlementHistory({ path, show }: { path: string; show: 'bill' | 'source' }) {
  const t = useT();
  const org = useOrgKey();
  const history = useQuery({
    queryKey: ['allocations', org, path],
    queryFn: () => api.get<AllocationView[]>(path),
  });
  return (
    <Card title={t('purchases.history.title')}>
      {history.isPending ? (
        <Spinner label={t('common.loading')} />
      ) : history.isError ? (
        <ErrorAlert error={history.error} />
      ) : (
        <AllocationTable rows={history.data} show={show} />
      )}
    </Card>
  );
}

/** A2, A3: applies a vendor credit or a payment's prepayment to open bills of the vendor. */
export function ApplyCreditPanel({
  sourceType,
  sourceId,
  vendorId,
  currencyCode,
  available,
  minDate,
  onApplied,
}: {
  sourceType: 'vendor_credit' | 'payment';
  sourceId: string;
  vendorId: string;
  currencyCode: string;
  available: string;
  minDate: string;
  onApplied: () => void;
}) {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const bills = useOpenBills(vendorId, currencyCode, true);
  const [date, setDate] = useState(() => {
    const today = new Date().toISOString().slice(0, 10);
    return today < minDate ? minDate : today;
  });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const allocations = Object.entries(amounts)
    .filter(([, v]) => v.trim() !== '')
    .map(([billId, amount]) => ({ billId, amount: amount.trim() }));
  const applyCredit = useApiMutation(() =>
    api.post<{ amountApplied: string }>(
      '/purchases/credit-applications',
      { sourceType, sourceId, date, allocations },
      { idempotencyKey },
    ),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    applyCredit.mutate(undefined, {
      onSuccess: () => {
        setAmounts({});
        setIdempotencyKey(crypto.randomUUID());
        void queryClient.invalidateQueries({ queryKey: ['open-bills', org] });
        void queryClient.invalidateQueries({ queryKey: ['allocations', org] });
        onApplied();
      },
    });
  };
  const issue = (path: string) =>
    applyCredit.error instanceof ApiError ? applyCredit.error.fieldError(path) : undefined;
  return (
    <Card title={t('purchases.apply.title')}>
      <p className="muted">
        {t('purchases.apply.hint', {
          available: formatAmount(available, currencyCode),
          currency: currencyCode,
        })}
      </p>
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={applyCredit.error} />
        {applyCredit.isSuccess ? (
          <Alert tone="success">
            {t('purchases.apply.done', {
              amount: formatAmount(applyCredit.data.amountApplied, currencyCode),
              currency: currencyCode,
            })}
          </Alert>
        ) : null}
        <TextField
          label={t('purchases.apply.date')}
          type="date"
          value={date}
          required
          error={issue('date')}
          onChange={(e) => setDate(e.target.value)}
        />
        {issue('allocations') ? (
          <small className="field__error">{issue('allocations')}</small>
        ) : null}
        {bills.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : (bills.data ?? []).length === 0 ? (
          <p className="muted">{t('purchases.payments.noOpenBills', { currency: currencyCode })}</p>
        ) : (
          <table className="table table--editor">
            <thead>
              <tr>
                <th>{t('purchases.bills.number')}</th>
                <th>{t('purchases.field.billDate')}</th>
                <th className="num">{t('purchases.payments.due')}</th>
                <th className="num">{t('purchases.apply.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {(bills.data ?? []).map((b) => (
                <tr key={b.id}>
                  <td>{b.number}</td>
                  <td>{b.billDate}</td>
                  <td className="num">{formatAmount(b.amountDue, b.currencyCode)}</td>
                  <td className="num">
                    <input
                      aria-label={t('purchases.apply.billAmount', { number: b.number })}
                      inputMode="decimal"
                      value={amounts[b.id] ?? ''}
                      onChange={(e) => setAmounts({ ...amounts, [b.id]: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="actions">
          <Button
            type="submit"
            variant="secondary"
            disabled={allocations.length === 0}
            busy={applyCredit.isPending}
          >
            {t('purchases.apply.submit')}
          </Button>
        </p>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Detail and lifecycle
// ---------------------------------------------------------------------------

export function PaymentDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const doc = usePayment(id);
  const can = {
    edit: usePermission(Permission.VendorPaymentsCreate),
    void: usePermission(Permission.VendorPaymentsVoid),
    journals: usePermission(Permission.JournalsView),
  };
  const [voidReason, setVoidReason] = useState('');
  const [recordKey] = useState(() => crypto.randomUUID());
  // 4B-3 / P4-33: refunds taken from the payment must be voided before the payment.
  const refunds = useRefundsOf('payment', id, doc.data?.status === 'RECORDED');
  const activeRefunds = (refunds.data?.items ?? []).filter((r) => r.status === 'RECORDED').length;
  const refresh = (data?: PaymentDetail) => {
    if (data) queryClient.setQueryData(['vendor-payment', org, id], data);
    void queryClient.invalidateQueries({ queryKey: ['vendor-payments', org] });
    void queryClient.invalidateQueries({ queryKey: ['open-bills', org] });
  };
  const action = useApiMutation((name: 'submit' | 'withdraw') =>
    api.post<PaymentDetail>(`/purchases/payments/${id}/${name}`, { version: doc.data!.version }),
  );
  // P4-42: recording has no re-authentication; the approval policy controls it.
  const recordPayment = useApiMutation(() =>
    api.post<PaymentDetail>(
      `/purchases/payments/${id}/record`,
      { version: doc.data!.version },
      { idempotencyKey: recordKey },
    ),
  );
  // P4-42: voiding a payment asks for the password again.
  const voidPayment = useApiMutation(() =>
    sensitive(() =>
      api.post<PaymentDetail>(`/purchases/payments/${id}/void`, {
        version: doc.data!.version,
        reason: voidReason.trim(),
      }),
    ),
  );
  const remove = useApiMutation(() =>
    api.delete(`/purchases/payments/${id}?version=${doc.data!.version}`),
  );

  if (doc.isPending) return <Spinner label={t('common.loading')} />;
  if (doc.isError) return <ErrorAlert error={doc.error} />;
  const p = doc.data;
  const cur = p.currencyCode;
  const conflict =
    [action.error, recordPayment.error, voidPayment.error, remove.error].find(
      (e) => e instanceof ApiError && e.code === 'VERSION_CONFLICT',
    ) !== undefined;
  const open = p.status === 'DRAFT' || p.status === 'PENDING_APPROVAL';
  return (
    <>
      <PageHeader
        title={
          p.number
            ? t('purchases.payments.titleNumber', { number: p.number })
            : t('purchases.payments.draftTitle')
        }
        description={p.vendorName ?? undefined}
      />
      <PurchasesNav />
      <ErrorAlert
        error={action.error ?? recordPayment.error ?? voidPayment.error ?? remove.error}
      />
      {conflict ? (
        <Alert tone="info">
          {t('purchases.bills.conflict')}{' '}
          <Button variant="ghost" onClick={() => void doc.refetch()}>
            {t('purchases.bills.reload')}
          </Button>
        </Alert>
      ) : null}
      {p.warnings.map((w) => (
        <Alert key={`${w.code}-${w.message}`} tone="info">
          {w.message}
        </Alert>
      ))}
      <Card title={t('purchases.bills.summary')} actions={<PaymentStatusBadge status={p.status} />}>
        <dl className="facts">
          <dt>{t('purchases.bills.vendor')}</dt>
          <dd>
            <Link to={`/purchases/vendors/${p.vendorId}`}>{p.vendorName}</Link>
          </dd>
          <dt>{t('purchases.payments.date')}</dt>
          <dd>{p.paymentDate}</dd>
          <dt>{t('purchases.payments.amount')}</dt>
          <dd>
            {formatAmount(p.amount, cur)} {cur}
          </dd>
          {p.exchangeRate && cur !== p.baseCurrency ? (
            <>
              <dt>{t('purchases.bills.rate')}</dt>
              <dd>
                {Number(p.exchangeRate)} ({p.exchangeRateSource})
                {p.tableRate && p.exchangeRateSource !== 'table'
                  ? ` · ${t('purchases.bills.tableRate', { rate: String(Number(p.tableRate)) })}`
                  : ''}
              </dd>
            </>
          ) : null}
          {p.rateOverride ? (
            <>
              <dt>{t('purchases.bills.rateOverride')}</dt>
              <dd>
                {Number(p.rateOverride)} — {p.rateOverrideReason}
              </dd>
            </>
          ) : null}
          {p.baseAmount ? (
            <>
              <dt>{t('purchases.payments.baseAmount')}</dt>
              <dd>
                {formatAmount(p.baseAmount, p.baseCurrency)} {p.baseCurrency}
              </dd>
            </>
          ) : null}
          <dt>{t('purchases.payments.account')}</dt>
          <dd>
            <AccountName id={p.paymentAccountId ?? p.defaultPaymentAccountId} /> (
            {p.paymentAccountId && p.paymentAccountId !== p.defaultPaymentAccountId
              ? t('purchases.payments.overridden')
              : t('purchases.payments.accountDefault')}
            )
          </dd>
          {p.amountUnallocated !== null ? (
            <>
              <dt>{t('purchases.payments.unallocated')}</dt>
              <dd>
                {formatAmount(p.amountUnallocated, cur)} {cur}
              </dd>
            </>
          ) : null}
          {p.reference ? (
            <>
              <dt>{t('purchases.payments.reference')}</dt>
              <dd>{p.reference}</dd>
            </>
          ) : null}
          {p.paymentBatchId ? (
            <>
              <dt>{t('purchases.payBills.batch')}</dt>
              <dd>
                <Link to={`/purchases/payment-batches/${p.paymentBatchId}`}>
                  {t('purchases.payBills.viewBatch')}
                </Link>
              </dd>
            </>
          ) : null}
          {p.voidReason ? (
            <>
              <dt>{t('purchases.bills.voidReason')}</dt>
              <dd>{p.voidReason}</dd>
            </>
          ) : null}
          {p.journalId && can.journals ? (
            <>
              <dt>{t('purchases.payments.journalLabel')}</dt>
              <dd>
                <Link to={`/accounting/journals/${p.journalId}`}>
                  {t('purchases.payments.journal')}
                </Link>
                {p.voidJournalId ? (
                  <>
                    {' · '}
                    <Link to={`/accounting/journals/${p.voidJournalId}`}>
                      {t('purchases.payments.voidJournal')}
                    </Link>
                  </>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
        {p.memo ? <p className="memo">{p.memo}</p> : null}
        <div className="actions">
          {p.status === 'DRAFT' && can.edit ? (
            <Link className="btn btn--secondary" to={`/purchases/payments/${id}/edit`}>
              {t('common.edit')}
            </Link>
          ) : null}
          {p.status === 'DRAFT' && can.edit && p.approval.required && !p.approval.readyToIssue ? (
            <Button
              variant="secondary"
              busy={action.isPending}
              onClick={() => action.mutate('submit', { onSuccess: refresh })}
            >
              {t('purchases.bills.submit')}
            </Button>
          ) : null}
          {p.status === 'PENDING_APPROVAL' && can.edit ? (
            <Button
              variant="secondary"
              busy={action.isPending}
              onClick={() => action.mutate('withdraw', { onSuccess: refresh })}
            >
              {t('purchases.bills.withdraw')}
            </Button>
          ) : null}
          {open && can.edit ? (
            <Button
              disabled={!p.approval.readyToIssue}
              busy={recordPayment.isPending}
              onClick={() => recordPayment.mutate(undefined, { onSuccess: refresh })}
            >
              {t('purchases.payments.record')}
            </Button>
          ) : null}
          {p.status === 'DRAFT' && can.edit ? (
            <Button
              variant="ghost"
              busy={remove.isPending}
              onClick={() => {
                if (window.confirm(t('purchases.payments.confirmDelete'))) {
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      refresh();
                      void navigate('/purchases/payments');
                    },
                  });
                }
              }}
            >
              {t('common.delete')}
            </Button>
          ) : null}
        </div>
      </Card>

      <ApprovalPanel approval={p.approval} readyMessage="purchases.approval.readyRecord" />

      {open ? (
        <Card title={t('purchases.payments.planned')}>
          {p.plannedAllocations.length === 0 ? (
            <p className="muted">{t('purchases.payments.prepayment')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('purchases.history.bill')}</th>
                  <th>{t('purchases.field.billDate')}</th>
                  <th className="num">{t('purchases.payments.due')}</th>
                  <th className="num">{t('purchases.payments.pay')}</th>
                </tr>
              </thead>
              <tbody>
                {p.plannedAllocations.map((a) => (
                  <tr key={a.billId}>
                    <td>
                      <Link to={`/purchases/bills/${a.billId}`}>{a.billNumber ?? a.billId}</Link>
                    </td>
                    <td>{a.billDate}</td>
                    <td className="num">{formatAmount(a.billAmountDue, cur)}</td>
                    <td className="num">{formatAmount(a.amount, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : (
        <Card title={t('purchases.payments.settled')}>
          <AllocationTable rows={p.allocations} show="bill" />
        </Card>
      )}

      {p.status === 'RECORDED' && can.edit && Number(p.amountUnallocated ?? 0) > 0 ? (
        <ApplyCreditPanel
          sourceType="payment"
          sourceId={id}
          vendorId={p.vendorId}
          currencyCode={cur}
          available={p.amountUnallocated!}
          minDate={p.paymentDate}
          onApplied={() => void doc.refetch()}
        />
      ) : null}

      {p.status === 'RECORDED' || p.status === 'VOID' ? (
        <RefundHistory
          sourceType="payment"
          sourceId={id}
          canRefund={p.status === 'RECORDED' && can.edit && Number(p.amountUnallocated ?? 0) > 0}
        />
      ) : null}

      {/* Phase 4B-7: the vendor's remittance advice (view with the page; create to generate and email). */}
      {p.status === 'RECORDED' || p.status === 'VOID' ? (
        <RemittancePanel paymentId={id} vendorId={p.vendorId} status={p.status} />
      ) : null}

      {p.status === 'RECORDED' && can.void && activeRefunds > 0 ? (
        <Card title={t('purchases.payments.voidTitle')}>
          <p className="muted">{t('purchases.payments.voidBlocked')}</p>
        </Card>
      ) : null}
      {p.status === 'RECORDED' && can.void && activeRefunds === 0 && !refunds.isPending ? (
        <Card title={t('purchases.payments.voidTitle')}>
          <p className="muted">{t('purchases.payments.voidNote')}</p>
          <form
            className="form form--inline"
            onSubmit={(e) => {
              e.preventDefault();
              voidPayment.mutate(undefined, { onSuccess: refresh });
            }}
          >
            <TextField
              label={t('purchases.bills.voidReason')}
              value={voidReason}
              required
              onChange={(e) => setVoidReason(e.target.value)}
            />
            <Button type="submit" variant="secondary" busy={voidPayment.isPending}>
              {t('purchases.bills.void')}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}

/** The payment account's code and name when the viewer can read accounts. */
function AccountName({ id }: { id: string | null }) {
  const canAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canAccounts);
  const account = accounts.data?.find((a) => a.id === id);
  return account ? (
    <>
      {account.code} · {account.name}
    </>
  ) : null;
}
