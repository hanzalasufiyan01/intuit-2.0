import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Decimal } from 'decimal.js';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { useT } from '../../i18n/i18n';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount, isDecimalString, sumAmounts } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { ExportButton } from '../data-exchange/ExportButton';
import { AttachmentsCard } from '../files/AttachmentsCard';
import { issueHint, orNull, SalesNav, StatusBadge, useCustomerOptions, useOrgKey } from './shared';
import type { InvoiceSummary, Page, ReceiptDetail, ReceiptSummary } from './types';

export function ReceiptsPage() {
  const t = useT();
  const org = useOrgKey();
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const list = useInfiniteQuery({
    queryKey: ['receipts', org, applied],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (applied.trim()) params.set('search', applied.trim());
      if (pageParam) params.set('after', pageParam);
      return api.get<Page<ReceiptSummary>>(`/sales/receipts?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader title={t('sales.receipts.title')} description={t('sales.receipts.description')} />
      <SalesNav />
      <p className="actions">
        <ExportButton domain="receipts" label={t('sales.receipts.export')} />
      </p>
      <Card
        actions={
          <Can permission={Permission.ReceiptsCreate}>
            <Link className="btn btn--primary" to="/sales/receipts/new">
              {t('sales.receipts.new')}
            </Link>
          </Can>
        }
      >
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(search);
          }}
        >
          <TextField
            label={t('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button type="submit">{t('common.search')}</Button>
        </form>
      </Card>
      <Card>
        {list.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : items.length === 0 ? (
          <p className="muted">{t('sales.receipts.none')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('sales.field.number')}</th>
                <th>{t('sales.field.customer')}</th>
                <th>{t('sales.field.date')}</th>
                <th className="num">{t('sales.field.amount')}</th>
                <th className="num">{t('sales.field.unallocated')}</th>
                <th>{t('sales.field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/sales/receipts/${r.id}`}>{r.number}</Link>
                  </td>
                  <td>{r.customerName}</td>
                  <td>{r.receiptDate}</td>
                  <td className="num">
                    {formatAmount(r.amount, r.currencyCode)} {r.currencyCode}
                  </td>
                  <td className="num">{formatAmount(r.amountUnallocated, r.currencyCode)}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {list.hasNextPage ? (
          <Button
            variant="secondary"
            busy={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('common.loadMore')}
          </Button>
        ) : null}
      </Card>
    </>
  );
}

/** The customer's open invoices, for the allocation grid. */
function useOpenInvoices(customerId: string) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['open-invoices', org, customerId],
    queryFn: () =>
      api.get<Page<InvoiceSummary>>(`/sales/invoices?customerId=${customerId}&open=true&limit=200`),
    enabled: customerId !== '',
  });
}

function AllocationGrid({
  invoices,
  currency,
  amounts,
  onChange,
}: {
  invoices: InvoiceSummary[];
  currency: string;
  amounts: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const t = useT();
  const eligible = invoices.filter((i) => i.currencyCode === currency);
  if (eligible.length === 0)
    return <p className="muted">{t('sales.receipts.noOpenInvoices', { currency })}</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('sales.field.number')}</th>
          <th>{t('sales.field.dueDate')}</th>
          <th className="num">{t('sales.field.amountDue')}</th>
          <th className="num">{t('sales.field.allocate')}</th>
        </tr>
      </thead>
      <tbody>
        {eligible.map((i) => (
          <tr key={i.id}>
            <td>{i.number}</td>
            <td>{i.dueDate}</td>
            <td className="num">{formatAmount(i.amountDue, currency)}</td>
            <td>
              <input
                className="num"
                inputMode="decimal"
                aria-label={t('sales.receipts.allocateTo', { number: i.number })}
                value={amounts[i.id] ?? ''}
                onChange={(e) => onChange({ ...amounts, [i.id]: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => onChange({ ...amounts, [i.id]: i.amountDue ?? '' })}
              >
                {t('sales.receipts.full')}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RecordReceiptPage() {
  const t = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const customers = useCustomerOptions();
  const canAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canAccounts);
  const [customerId, setCustomerId] = useState(params.get('customerId') ?? '');
  const customer = customers.data?.items.find((c) => c.id === customerId);
  const [currency, setCurrency] = useState('');
  const effectiveCurrency = currency || customer?.currencyCode || '';
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [deposit, setDeposit] = useState('');
  const [override, setOverride] = useState(false);
  const [rate, setRate] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const open = useOpenInvoices(customerId);
  const preset = params.get('invoiceId');
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const presetInvoice = open.data?.items.find((i) => i.id === preset);
  if (presetInvoice && allocations[presetInvoice.id] === undefined) {
    setAllocations({ [presetInvoice.id]: presetInvoice.amountDue ?? '' });
    if (!amount) setAmount(presetInvoice.amountDue ?? '');
  }
  const allocated = sumAmounts(Object.values(allocations));
  const credit = isDecimalString(amount) ? new Decimal(amount).minus(allocated) : null;
  // One key per form: a retried or double-clicked submission cannot record the receipt twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const record = useApiMutation((body: Record<string, unknown>) =>
    api.post<ReceiptDetail>('/sales/receipts', body, { idempotencyKey }),
  );
  const bankAccounts = (accounts.data ?? []).filter(
    (a) =>
      a.status === 'ACTIVE' && (a.subtype === 'BANK' || a.subtype === 'CASH') && a.isLeaf !== false,
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    record.mutate(
      {
        customerId,
        receiptDate: date,
        ...(currency ? { currencyCode: currency } : {}),
        amount: amount.trim(),
        ...(deposit ? { depositAccountId: deposit } : {}),
        ...(override ? { exchangeRate: rate.trim(), rateOverrideReason: reason.trim() } : {}),
        reference: orNull(reference),
        memo: memo.trim(),
        allocations: Object.entries(allocations)
          .filter(([, v]) => v.trim() !== '' && Number(v) !== 0)
          .map(([invoiceId, v]) => ({ invoiceId, amount: v.trim() })),
      },
      { onSuccess: (receipt) => void navigate(`/sales/receipts/${receipt.id}`) },
    );
  };
  const issue = (path: string) =>
    record.error instanceof ApiError ? record.error.fieldError(path) : undefined;
  const hint = record.error instanceof ApiError ? issueHint(record.error.code) : null;

  return (
    <>
      <PageHeader
        title={t('sales.receipts.new')}
        description={t('sales.receipts.newDescription')}
      />
      <SalesNav />
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={record.error} />
        {hint ? <Alert tone="info">{t(hint)}</Alert> : null}
        <Card title={t('sales.editor.details')}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="receipt-customer">{t('sales.field.customer')}</label>
              <select
                id="receipt-customer"
                value={customerId}
                required
                onChange={(e) => {
                  setCustomerId(e.target.value);
                  setAllocations({});
                }}
              >
                <option value="">{t('common.choose')}</option>
                {customers.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label={t('sales.field.date')}
              type="date"
              value={date}
              required
              onChange={(e) => setDate(e.target.value)}
            />
            <TextField
              label={t('sales.field.currency')}
              value={currency}
              placeholder={customer?.currencyCode ?? ''}
              hint={t('sales.receipts.currencyHint')}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
            <TextField
              label={t('sales.field.amountReceived')}
              inputMode="decimal"
              value={amount}
              required
              error={issue('amount')}
              onChange={(e) => setAmount(e.target.value)}
            />
            {canAccounts ? (
              <div className="field">
                <label htmlFor="receipt-deposit">{t('sales.field.depositAccount')}</label>
                <select
                  id="receipt-deposit"
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                >
                  <option value="">{t('sales.receipts.defaultDeposit')}</option>
                  {bankAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name} ({a.currencyCode})
                    </option>
                  ))}
                </select>
                {issue('depositAccountId') ? (
                  <small className="field__error">{issue('depositAccountId')}</small>
                ) : null}
              </div>
            ) : null}
            <TextField
              label={t('sales.field.reference')}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />
            {t('sales.receipts.overrideRate')}
          </label>
          {override ? (
            <div className="form-grid">
              <TextField
                label={t('sales.field.exchangeRate')}
                inputMode="decimal"
                value={rate}
                required
                error={issue('exchangeRate')}
                onChange={(e) => setRate(e.target.value)}
              />
              <TextField
                label={t('sales.field.overrideReason')}
                value={reason}
                required
                error={issue('rateOverrideReason')}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          ) : null}
        </Card>
        <Card title={t('sales.receipts.allocations')}>
          {customerId === '' ? (
            <p className="muted">{t('sales.receipts.chooseCustomer')}</p>
          ) : open.isPending ? (
            <Spinner label={t('common.loading')} />
          ) : (
            <AllocationGrid
              invoices={open.data?.items ?? []}
              currency={effectiveCurrency}
              amounts={allocations}
              onChange={setAllocations}
            />
          )}
          <p className="muted">
            {t('sales.receipts.allocatedSummary', {
              allocated: formatAmount(allocated.toFixed(), effectiveCurrency || 'MVR'),
              credit: credit ? formatAmount(credit.toFixed(), effectiveCurrency || 'MVR') : '—',
            })}
          </p>
          {credit?.isNegative() ? <Alert>{t('sales.receipts.overAllocated')}</Alert> : null}
          {issue('allocations') ? <Alert>{issue('allocations')}</Alert> : null}
          <div className="field">
            <label htmlFor="receipt-memo">{t('sales.field.memo')}</label>
            <textarea
              id="receipt-memo"
              rows={2}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
        </Card>
        <p className="actions">
          <Button type="submit" busy={record.isPending} disabled={credit?.isNegative() === true}>
            {t('sales.receipts.record')}
          </Button>
        </p>
      </form>
    </>
  );
}

export function ReceiptDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canVoid = usePermission(Permission.ReceiptsVoid);
  const canCreate = usePermission(Permission.ReceiptsCreate);
  const receipt = useQuery({
    queryKey: ['receipt', org, id],
    queryFn: () => api.get<ReceiptDetail>(`/sales/receipts/${id}`),
  });
  const [reason, setReason] = useState('');
  const voidReceipt = useApiMutation(() =>
    sensitive(() =>
      api.post<ReceiptDetail>(`/sales/receipts/${id}/void`, {
        version: receipt.data!.version,
        reason: reason.trim(),
      }),
    ),
  );
  if (receipt.isPending) return <Spinner label={t('common.loading')} />;
  if (receipt.isError) return <ErrorAlert error={receipt.error} />;
  const r = receipt.data;
  const c = r.currencyCode;
  return (
    <>
      <PageHeader
        title={t('sales.receipts.titleNumber', { number: r.number })}
        description={r.customerName ?? undefined}
      />
      <SalesNav />
      <ErrorAlert error={voidReceipt.error} />
      <Card title={t('sales.invoices.summary')} actions={<StatusBadge status={r.status} />}>
        <dl className="facts">
          <dt>{t('sales.field.date')}</dt>
          <dd>{r.receiptDate}</dd>
          <dt>{t('sales.field.amount')}</dt>
          <dd>
            {formatAmount(r.amount, c)} {c}
          </dd>
          <dt>{t('sales.field.exchangeRate')}</dt>
          <dd>
            {Number(r.exchangeRate)} ({t(`sales.rateSource.${r.exchangeRateSource}`)})
            {r.tableRate
              ? ` · ${t('sales.receipts.tableRate', { rate: Number(r.tableRate) })}`
              : ''}
          </dd>
          {r.rateOverrideReason ? (
            <>
              <dt>{t('sales.field.overrideReason')}</dt>
              <dd>{r.rateOverrideReason}</dd>
            </>
          ) : null}
          <dt>{t('sales.field.unallocated')}</dt>
          <dd>{formatAmount(r.amountUnallocated, c)}</dd>
          {r.reference ? (
            <>
              <dt>{t('sales.field.reference')}</dt>
              <dd>{r.reference}</dd>
            </>
          ) : null}
          {r.voidReason ? (
            <>
              <dt>{t('sales.field.voidReason')}</dt>
              <dd>{r.voidReason}</dd>
            </>
          ) : null}
        </dl>
        {r.status === 'RECORDED' && Number(r.amountUnallocated) > 0 && canCreate ? (
          <p className="actions">
            <Link
              className="btn btn--secondary"
              to={`/sales/customer-credit/apply?sourceType=receipt&sourceId=${id}`}
            >
              {t('sales.action.applyCredit')}
            </Link>
          </p>
        ) : null}
      </Card>
      <Card title={t('sales.receipts.allocations')}>
        {r.allocations.length === 0 ? (
          <p className="muted">{t('sales.receipts.noAllocations')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('sales.field.date')}</th>
                <th>{t('sales.field.invoice')}</th>
                <th className="num">{t('sales.field.amount')}</th>
                <th className="num">{t('sales.field.realizedFx')}</th>
              </tr>
            </thead>
            <tbody>
              {r.allocations.map((a) => (
                <tr key={a.id}>
                  <td>{a.allocationDate}</td>
                  <td>
                    <Link to={`/sales/invoices/${a.invoiceId}`}>
                      {t('sales.receipts.viewInvoice')}
                    </Link>
                    {a.mode === 'credit' ? ` · ${t('sales.receipts.creditApplied')}` : ''}
                    {a.reversesAllocationId ? ` · ${t('sales.invoices.reversed')}` : ''}
                  </td>
                  <td className="num">{formatAmount(a.amount, c)}</td>
                  <td className="num">{Number(a.fxDifference) === 0 ? '' : a.fxDifference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {r.status === 'RECORDED' && canVoid ? (
        <Card title={t('sales.receipts.voidTitle')}>
          <p className="muted">{t('sales.receipts.voidNote')}</p>
          <form
            className="form form--inline"
            onSubmit={(e) => {
              e.preventDefault();
              voidReceipt.mutate(undefined, {
                onSuccess: (data) => {
                  queryClient.setQueryData(['receipt', org, id], data);
                  void queryClient.invalidateQueries({ queryKey: ['receipts', org] });
                },
              });
            }}
          >
            <TextField
              label={t('sales.field.voidReason')}
              value={reason}
              required
              onChange={(e) => setReason(e.target.value)}
            />
            <Button type="submit" variant="secondary" busy={voidReceipt.isPending}>
              {t('sales.action.void')}
            </Button>
          </form>
        </Card>
      ) : null}
      <AttachmentsCard
        linkType="receipt"
        linkId={id}
        canChange={canCreate}
        canRemove={false}
        removeNote={t('sales.attachments.lockedNote')}
      />
    </>
  );
}

/** Applies a receipt's excess or a credit note to open invoices (Decisions 38, 39). */
export function ApplyCreditPage() {
  const t = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const sourceType = params.get('sourceType') === 'credit_note' ? 'credit_note' : 'receipt';
  const sourceId = params.get('sourceId') ?? '';
  const org = useOrgKey();
  const source = useQuery({
    queryKey: ['credit-source', org, sourceType, sourceId],
    queryFn: async () => {
      if (sourceType === 'receipt') {
        const r = await api.get<ReceiptDetail>(`/sales/receipts/${sourceId}`);
        return {
          customerId: r.customerId,
          number: r.number,
          currency: r.currencyCode,
          available: r.amountUnallocated,
        };
      }
      const n = await api.get<{
        customerId: string;
        number: string;
        currencyCode: string;
        amountUnapplied: string;
      }>(`/sales/credit-notes/${sourceId}`);
      return {
        customerId: n.customerId,
        number: n.number,
        currency: n.currencyCode,
        available: n.amountUnapplied,
      };
    },
  });
  const open = useOpenInvoices(source.data?.customerId ?? '');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const apply = useApiMutation((body: Record<string, unknown>) =>
    api.post('/sales/customer-credit/apply', body, { idempotencyKey }),
  );
  if (source.isPending) return <Spinner label={t('common.loading')} />;
  if (source.isError) return <ErrorAlert error={source.error} />;
  const s = source.data;
  const back =
    sourceType === 'receipt' ? `/sales/receipts/${sourceId}` : `/sales/credit-notes/${sourceId}`;
  return (
    <>
      <PageHeader
        title={t('sales.credit.title')}
        description={t('sales.credit.description', {
          number: s.number,
          available: formatAmount(s.available, s.currency),
          currency: s.currency,
        })}
      />
      <SalesNav />
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          apply.mutate(
            {
              sourceType,
              sourceId,
              date,
              allocations: Object.entries(amounts)
                .filter(([, v]) => v.trim() !== '' && Number(v) !== 0)
                .map(([invoiceId, v]) => ({ invoiceId, amount: v.trim() })),
            },
            { onSuccess: () => void navigate(back) },
          );
        }}
      >
        <ErrorAlert error={apply.error} />
        <Card>
          <TextField
            label={t('sales.field.date')}
            type="date"
            value={date}
            required
            onChange={(e) => setDate(e.target.value)}
          />
          {open.isPending ? (
            <Spinner label={t('common.loading')} />
          ) : (
            <AllocationGrid
              invoices={open.data?.items ?? []}
              currency={s.currency}
              amounts={amounts}
              onChange={setAmounts}
            />
          )}
        </Card>
        <p className="actions">
          <Button type="submit" busy={apply.isPending}>
            {t('sales.action.applyCredit')}
          </Button>
          <Link className="btn btn--secondary" to={back}>
            {t('common.cancel')}
          </Link>
        </p>
      </form>
    </>
  );
}
