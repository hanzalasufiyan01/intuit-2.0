import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { EmptyState } from '../../shared/ui/EmptyState';
import { LoadingState } from '../../shared/ui/LoadingState';
import { MappedStatusBadge, type StatusEntry } from '../../shared/ui/StatusBadge';
import { DataTable, NumCell, NumHeader } from '../../shared/ui/Table';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useT } from '../../i18n/i18n';

/**
 * Purchase orders, goods receiving and three-way matching. An order creates no journal. The
 * server computes totals, numbers the order, runs approval and the match and enforces tolerances;
 * these pages only guide.
 */

type OrderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CLOSED'
  | 'CANCELLED';

interface OrderSummary {
  id: string;
  status: OrderStatus;
  number: string | null;
  vendorId: string;
  vendorName: string | null;
  orderDate: string;
  expectedDate: string | null;
  currencyCode: string;
  total: string;
  version: number;
}

interface OrderLine {
  id: string;
  lineNo: number;
  itemId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  total: string;
  receivedQuantity: string;
  billedQuantity: string;
  remainingToReceive: string;
  remainingToBill: string;
}

interface OrderDetail extends OrderSummary {
  memo: string;
  closeReason: string | null;
  cancelReason: string | null;
  lines: OrderLine[];
  bills: {
    billId: string;
    number: string | null;
    status: string | null;
    total: string | null;
    match: { mode: string; status: string; issues: { kind: string; message: string }[] } | null;
  }[];
  receipts: { id: string; number: string; date: string; status: string; version: number }[];
  approval: { requestId: string | null; requestStatus: string | null } | null;
}

interface MatchSettings {
  matchMode: 'off' | 'warning' | 'block';
  quantityTolerancePct: string;
  priceTolerancePct: string;
  version: number;
}

const ORDER_STATUS = {
  DRAFT: { key: 'purchases.orderPages.status.DRAFT', tone: 'neutral' },
  PENDING_APPROVAL: { key: 'purchases.orderPages.status.PENDING_APPROVAL', tone: 'warning' },
  APPROVED: { key: 'purchases.orderPages.status.APPROVED', tone: 'success' },
  PARTIALLY_RECEIVED: { key: 'purchases.orderPages.status.PARTIALLY_RECEIVED', tone: 'success' },
  RECEIVED: { key: 'purchases.orderPages.status.RECEIVED', tone: 'success' },
  CLOSED: { key: 'purchases.orderPages.status.CLOSED', tone: 'danger' },
  CANCELLED: { key: 'purchases.orderPages.status.CANCELLED', tone: 'danger' },
} satisfies Record<OrderStatus, StatusEntry>;

/** A purchase order's status; one the page does not know is neutral and shown as it came. */
export function StatusBadge({ status }: { status: string }) {
  return <MappedStatusBadge map={ORDER_STATUS} status={status} />;
}

const today = () => new Date().toISOString().slice(0, 10);

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function OrdersPage() {
  const t = useT();
  const org = useOrgKey();
  const canCreate = usePermission(Permission.PurchaseOrdersCreate);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const query = new URLSearchParams({ limit: '100' });
  if (status) query.set('status', status);
  if (search.trim()) query.set('search', search.trim());
  const list = useQuery({
    queryKey: ['purchase-orders', org, status, search],
    queryFn: () =>
      api.get<{ items: OrderSummary[]; nextCursor: string | null }>(
        `/purchases/orders?${query.toString()}`,
      ),
  });
  return (
    <>
      <PageHeader
        title={t('purchases.orderPages.purchaseOrders')}
        description={t('purchases.orderPages.commitToAVendorBefore')}
      />
      <Card
        actions={
          canCreate ? (
            <Link className="btn btn--primary" to="/purchases/orders/new">
              {t('purchases.orderPages.newPurchaseOrder')}
            </Link>
          ) : undefined
        }
      >
        <div className="form-grid">
          <div className="field">
            <label htmlFor="po-status">{t('purchases.orderPages.status')}</label>
            <select id="po-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {(Object.keys(ORDER_STATUS) as OrderStatus[]).map((s) => (
                <option key={s} value={s}>
                  {t(ORDER_STATUS[s].key)}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {list.isPending ? (
          <LoadingState />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <EmptyState message={t('purchases.orderPages.noPurchaseOrders')} />
        ) : (
          <DataTable label={t('purchases.orderPages.purchaseOrders')}>
            <thead>
              <tr>
                <th>{t('purchases.orderPages.number')}</th>
                <th>{t('purchases.orderPages.vendor')}</th>
                <th>{t('purchases.orderPages.date')}</th>
                <th>{t('purchases.orderPages.expected')}</th>
                <NumHeader>{t('purchases.orderPages.total')}</NumHeader>
                <th>{t('purchases.orderPages.status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/purchases/orders/${o.id}`}>
                      {o.number ?? t('purchases.orderPages.draft')}
                    </Link>
                  </td>
                  <td>{o.vendorName}</td>
                  <td>{o.orderDate}</td>
                  <td>{o.expectedDate ?? '—'}</td>
                  <NumCell>
                    {formatAmount(o.total, o.currencyCode)} {o.currencyCode}
                  </NumCell>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// New order
// ---------------------------------------------------------------------------

interface DraftLine {
  itemId: string;
  description: string;
  quantity: string;
  unitPrice: string;
}

export function NewOrderPage() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const org = useOrgKey();
  const vendors = useQuery({
    queryKey: ['po-vendors', org],
    queryFn: () =>
      api.get<{ items: { id: string; displayName: string }[] }>('/vendors?limit=200&status=active'),
  });
  const items = useQuery({
    queryKey: ['po-items', org],
    queryFn: () =>
      api.get<{ items: { id: string; name: string; purchaseUnitCost: string | null }[] }>(
        '/sales/items?limit=200&status=active',
      ),
  });
  const [vendorId, setVendorId] = useState('');
  const [orderDate, setOrderDate] = useState(today());
  const [expectedDate, setExpectedDate] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([
    { itemId: '', description: '', quantity: '1', unitPrice: '' },
  ]);
  const create = useApiMutation(() =>
    api.post<OrderDetail>(
      '/purchases/orders',
      {
        vendorId,
        orderDate,
        ...(expectedDate ? { expectedDate } : {}),
        ...(memo.trim() ? { memo: memo.trim() } : {}),
        lines: lines.map((l) => ({
          ...(l.itemId ? { itemId: l.itemId } : {}),
          ...(l.description.trim() ? { description: l.description.trim() } : {}),
          quantity: l.quantity.trim(),
          ...(l.unitPrice.trim() ? { unitPrice: l.unitPrice.trim() } : {}),
        })),
      },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: (order) => {
        void queryClient.invalidateQueries({ queryKey: ['purchase-orders', org] });
        void navigate(`/purchases/orders/${order.id}`);
      },
    });
  };
  const error = create.error instanceof ApiError ? create.error : null;
  return (
    <>
      <PageHeader title={t('purchases.orderPages.newPurchaseOrder')} />
      <p>
        <Link to="/purchases/orders">{t('purchases.orderPages.purchaseOrders2')}</Link>
      </p>
      <Card>
        <form onSubmit={submit}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="po-vendor">{t('purchases.orderPages.vendor')}</label>
              <select
                id="po-vendor"
                value={vendorId}
                required
                onChange={(e) => setVendorId(e.target.value)}
              >
                <option value="">{t('common.choose')}</option>
                {(vendors.data?.items ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.displayName}
                  </option>
                ))}
              </select>
              {error?.fieldError('vendorId') ? (
                <small className="field__error" role="alert">
                  {error.fieldError('vendorId')}
                </small>
              ) : null}
            </div>
            <TextField
              label={t('purchases.orderPages.orderDate')}
              type="date"
              value={orderDate}
              required
              onChange={(e) => setOrderDate(e.target.value)}
              error={error?.fieldError('orderDate')}
            />
            <TextField
              label={t('purchases.orderPages.expectedDelivery')}
              type="date"
              value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)}
              error={error?.fieldError('expectedDate')}
            />
            <TextField
              label={t('purchases.orderPages.memo')}
              value={memo}
              maxLength={2000}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
          <table className="table table--editor">
            <thead>
              <tr>
                <th>{t('purchases.orderPages.item')}</th>
                <th>{t('purchases.orderPages.description')}</th>
                <th className="num">{t('purchases.orderPages.quantity')}</th>
                <th className="num">{t('purchases.orderPages.unitPrice')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td>
                    <select
                      aria-label={t('purchases.orderPages.itemLine', { value: i + 1 })}
                      value={line.itemId}
                      onChange={(e) => {
                        const item = items.data?.items.find((x) => x.id === e.target.value);
                        setLine(i, {
                          itemId: e.target.value,
                          description: line.description || item?.name || '',
                          unitPrice: line.unitPrice || item?.purchaseUnitCost || '',
                        });
                      }}
                    >
                      <option value="">{t('common.none')}</option>
                      {(items.data?.items ?? []).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label={t('purchases.orderPages.descriptionLine', { value: i + 1 })}
                      value={line.description}
                      onChange={(e) => setLine(i, { description: e.target.value })}
                    />
                  </td>
                  <td className="num">
                    <input
                      aria-label={t('purchases.orderPages.quantityLine', { value: i + 1 })}
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => setLine(i, { quantity: e.target.value })}
                    />
                  </td>
                  <td className="num">
                    <input
                      aria-label={t('purchases.orderPages.unitPriceLine', { value: i + 1 })}
                      inputMode="decimal"
                      value={line.unitPrice}
                      onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                    />
                  </td>
                  <td>
                    {lines.length > 1 ? (
                      <Button
                        variant="ghost"
                        onClick={() => setLines(lines.filter((_, x) => x !== i))}
                      >
                        {t('common.remove')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {error?.fieldError('lines') ? (
            <small className="field__error" role="alert">
              {error.fieldError('lines')}
            </small>
          ) : null}
          <p>
            <Button
              variant="secondary"
              onClick={() =>
                setLines([...lines, { itemId: '', description: '', quantity: '1', unitPrice: '' }])
              }
            >
              {t('purchases.orderPages.addALine')}
            </Button>{' '}
            <Button type="submit" busy={create.isPending}>
              {t('purchases.orderPages.saveDraft')}
            </Button>
          </p>
          {create.isError && !error?.issues.length ? <ErrorAlert error={create.error} /> : null}
        </form>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function OrderDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canCreate = usePermission(Permission.PurchaseOrdersCreate);
  const canReceive = usePermission(Permission.PurchaseOrdersReceive);
  const canClose = usePermission(Permission.PurchaseOrdersClose);
  const canBill = usePermission(Permission.BillsCreate);
  const order = useQuery({
    queryKey: ['purchase-order', org, id],
    queryFn: () => api.get<OrderDetail>(`/purchases/orders/${id}`),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['purchase-order', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['purchase-orders', org] });
  };
  const act = useApiMutation((input: { path: string; body: unknown }) =>
    api.post<OrderDetail>(`/purchases/orders/${id}/${input.path}`, input.body),
  );
  const del = useApiMutation((o: OrderDetail) =>
    api.delete(`/purchases/orders/${id}?version=${o.version}`),
  );
  const toBill = useApiMutation((basis: 'received' | 'ordered') =>
    api.post<{ id: string }>(
      `/purchases/orders/${id}/create-bill`,
      { basis, billDate: today() },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const [receiving, setReceiving] = useState<Record<string, string>>({});
  const receive = useApiMutation((o: OrderDetail) =>
    api.post<OrderDetail>(
      `/purchases/orders/${id}/receipts`,
      {
        receiptDate: today(),
        lines: o.lines
          .filter((l) => Number(receiving[l.id] ?? 0) > 0)
          .map((l) => ({ orderLineId: l.id, quantity: receiving[l.id]!.trim() })),
      },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  if (order.isPending) return <Spinner />;
  if (order.isError) return <ErrorAlert error={order.error} />;
  const o = order.data;
  const live =
    o.status === 'APPROVED' || o.status === 'PARTIALLY_RECEIVED' || o.status === 'RECEIVED';
  const run = (path: string, body: object) => act.mutate({ path, body }, { onSuccess: refresh });
  const error = act.error ?? del.error ?? toBill.error ?? receive.error;
  return (
    <>
      <PageHeader
        title={
          o.number
            ? t('purchases.orderPages.purchaseOrder', { number: o.number })
            : t('purchases.orderPages.purchaseOrderDraft')
        }
        description={`${o.vendorName ?? ''} · ${o.orderDate}${o.expectedDate ? ` · expected ${o.expectedDate}` : ''} · ${formatAmount(o.total, o.currencyCode)} ${o.currencyCode}`}
      />
      <p>
        <Link to="/purchases/orders">{t('purchases.orderPages.purchaseOrders2')}</Link>{' '}
        <StatusBadge status={o.status} />
      </p>
      {error ? <ErrorAlert error={error} /> : null}
      {o.status === 'PENDING_APPROVAL' ? (
        <Alert tone="info">{t('purchases.orderPages.waitingForApprovalUnderThe')}</Alert>
      ) : null}
      <Card
        title={t('purchases.orderPages.lines')}
        actions={
          <span>
            {canCreate && o.status === 'DRAFT' ? (
              <>
                <Button busy={act.isPending} onClick={() => run('submit', { version: o.version })}>
                  {t('purchases.orderPages.submit')}
                </Button>{' '}
                <Button
                  variant="ghost"
                  onClick={() =>
                    del.mutate(o, {
                      onSuccess: () => {
                        refresh();
                        void navigate('/purchases/orders');
                      },
                    })
                  }
                >
                  {t('common.delete')}
                </Button>
              </>
            ) : null}
            {canCreate && o.status === 'PENDING_APPROVAL' ? (
              <Button variant="secondary" onClick={() => run('withdraw', { version: o.version })}>
                {t('purchases.orderPages.withdraw')}
              </Button>
            ) : null}
          </span>
        }
      >
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('purchases.orderPages.description')}</th>
              <th className="num">{t('purchases.orderPages.ordered')}</th>
              <th className="num">{t('purchases.orderPages.price')}</th>
              <th className="num">{t('purchases.orderPages.received')}</th>
              <th className="num">{t('purchases.orderPages.billed')}</th>
              {live && canReceive ? (
                <th className="num">{t('purchases.orderPages.receiveNow')}</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.lineNo}</td>
                <td>{l.description}</td>
                <td className="num">{l.quantity}</td>
                <td className="num">{formatAmount(l.unitPrice, o.currencyCode)}</td>
                <td className="num">{l.receivedQuantity}</td>
                <td className="num">{l.billedQuantity}</td>
                {live && canReceive ? (
                  <td className="num">
                    <input
                      aria-label={t('purchases.orderPages.receiveLine', { lineNo: l.lineNo })}
                      inputMode="decimal"
                      value={receiving[l.id] ?? ''}
                      placeholder={l.remainingToReceive}
                      onChange={(e) => setReceiving({ ...receiving, [l.id]: e.target.value })}
                    />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {live && canReceive ? (
          <p>
            <Button
              busy={receive.isPending}
              onClick={() =>
                receive.mutate(o, {
                  onSuccess: () => {
                    setReceiving({});
                    refresh();
                  },
                })
              }
            >
              {t('purchases.orderPages.recordGoodsReceived')}
            </Button>
          </p>
        ) : null}
        {live && canBill ? (
          <p>
            <Button
              variant="secondary"
              busy={toBill.isPending}
              onClick={() =>
                toBill.mutate('received', {
                  onSuccess: (bill) => void navigate(`/purchases/bills/${bill.id}`),
                })
              }
            >
              {t('purchases.orderPages.createBillFromWhatWas')}
            </Button>{' '}
            <Button
              variant="ghost"
              onClick={() =>
                toBill.mutate('ordered', {
                  onSuccess: (bill) => void navigate(`/purchases/bills/${bill.id}`),
                })
              }
            >
              {t('purchases.orderPages.billEverythingOrdered')}
            </Button>
          </p>
        ) : null}
        {live && canClose ? (
          <p>
            <Button
              variant="ghost"
              onClick={() => {
                const reason = window.prompt(t('purchases.orderPages.whyIsTheOrderClosed')) ?? '';
                run('close', { version: o.version, reason: reason.trim() || undefined });
              }}
            >
              {t('purchases.orderPages.closeOrder')}
            </Button>
            {o.status === 'APPROVED' ? (
              <Button
                variant="ghost"
                onClick={() => {
                  const reason = window.prompt(t('purchases.orderPages.whyIsTheOrderCancelled'));
                  if (reason?.trim()) run('cancel', { version: o.version, reason: reason.trim() });
                }}
              >
                {t('purchases.orderPages.cancelOrder')}
              </Button>
            ) : null}
          </p>
        ) : null}
      </Card>
      <Card title={t('purchases.orderPages.bills')}>
        {o.bills.length === 0 ? (
          <p className="muted">{t('purchases.orderPages.noBillsAreLinkedTo')}</p>
        ) : (
          <table className="table">
            <tbody>
              {o.bills.map((b) => (
                <tr key={b.billId}>
                  <td>
                    <Link to={`/purchases/bills/${b.billId}`}>
                      {b.number ?? t('purchases.orderPages.draftBill')}
                    </Link>
                  </td>
                  <td>{b.status}</td>
                  <td>
                    {b.match ? (
                      <>
                        {b.match.status === 'matched'
                          ? t('purchases.orderPages.matched')
                          : t('purchases.orderPages.matchedWithWarnings')}{' '}
                        ({b.match.mode})
                        {b.match.issues.length ? (
                          <ul>
                            {b.match.issues.map((i, n) => (
                              <li key={n}>{i.message}</li>
                            ))}
                          </ul>
                        ) : null}
                      </>
                    ) : (
                      t('purchases.orderPages.notPostedYet')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title={t('purchases.orderPages.goodsReceipts')}>
        {o.receipts.length === 0 ? (
          <p className="muted">{t('purchases.orderPages.nothingReceivedYet')}</p>
        ) : (
          <table className="table">
            <tbody>
              {o.receipts.map((r) => (
                <tr key={r.id}>
                  <td>{r.number}</td>
                  <td>{r.date}</td>
                  <td>
                    {r.status === 'POSTED'
                      ? t('purchases.orderPages.recorded')
                      : t('purchases.orderPages.void')}
                  </td>
                  <td>
                    {canReceive && r.status === 'POSTED' ? (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          const reason = window.prompt(
                            t('purchases.orderPages.whyIsThisReceiptVoided'),
                          );
                          if (!reason?.trim()) return;
                          void api
                            .post(`/purchases/receipts/${r.id}/void`, {
                              version: r.version,
                              reason: reason.trim(),
                            })
                            .then(refresh);
                        }}
                      >
                        {t('purchases.orderPages.void')}
                      </Button>
                    ) : null}
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

// ---------------------------------------------------------------------------
// Commitments and matching settings
// ---------------------------------------------------------------------------

export function CommitmentsPage() {
  const t = useT();
  const org = useOrgKey();
  const report = useQuery({
    queryKey: ['po-commitments', org],
    queryFn: () =>
      api.get<{
        items: {
          vendorId: string;
          vendorName: string | null;
          currencyCode: string;
          orderCount: number;
          ordered: string;
          openValue: string;
        }[];
      }>('/purchases/reports/commitments'),
  });
  return (
    <>
      <PageHeader
        title={t('purchases.orderPages.purchaseCommitments')}
        description={t('purchases.orderPages.whatIsStillToBe')}
      />
      <Card>
        {report.isPending ? (
          <Spinner />
        ) : report.isError ? (
          <ErrorAlert error={report.error} />
        ) : report.data.items.length === 0 ? (
          <p className="muted">{t('purchases.orderPages.noOpenPurchaseOrders')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('purchases.orderPages.vendor')}</th>
                <th>{t('purchases.orderPages.orders')}</th>
                <th className="num">{t('purchases.orderPages.ordered')}</th>
                <th className="num">{t('purchases.orderPages.stillToBill')}</th>
              </tr>
            </thead>
            <tbody>
              {report.data.items.map((r) => (
                <tr key={`${r.vendorId}-${r.currencyCode}`}>
                  <td>{r.vendorName}</td>
                  <td>{r.orderCount}</td>
                  <td className="num">
                    {formatAmount(r.ordered, r.currencyCode)} {r.currencyCode}
                  </td>
                  <td className="num">
                    {formatAmount(r.openValue, r.currencyCode)} {r.currencyCode}
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

export function MatchSettingsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.PurchaseOrdersSettingsManage);
  const settings = useQuery({
    queryKey: ['po-settings', org],
    queryFn: () => api.get<MatchSettings>('/purchases/order-settings'),
  });
  const [form, setForm] = useState<Partial<MatchSettings>>({});
  const save = useApiMutation((s: MatchSettings) =>
    api.put<MatchSettings>('/purchases/order-settings', {
      version: s.version,
      matchMode: form.matchMode ?? s.matchMode,
      quantityTolerancePct: form.quantityTolerancePct ?? s.quantityTolerancePct,
      priceTolerancePct: form.priceTolerancePct ?? s.priceTolerancePct,
    }),
  );
  if (settings.isPending) return <Spinner />;
  if (settings.isError) return <ErrorAlert error={settings.error} />;
  const s = settings.data;
  const error = save.error instanceof ApiError ? save.error : null;
  return (
    <>
      <PageHeader
        title={t('purchases.orderPages.threeWayMatching')}
        description={t('purchases.orderPages.compareABillWithIts')}
      />
      <Card>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(s, {
              onSuccess: () => {
                setForm({});
                void queryClient.invalidateQueries({ queryKey: ['po-settings', org] });
              },
            });
          }}
        >
          <div className="field">
            <label htmlFor="po-match-mode">{t('purchases.orderPages.whenABillDoesNot')}</label>
            <select
              id="po-match-mode"
              value={form.matchMode ?? s.matchMode}
              disabled={!canManage}
              onChange={(e) =>
                setForm({ ...form, matchMode: e.target.value as MatchSettings['matchMode'] })
              }
            >
              <option value="off">{t('purchases.orderPages.doNotCheck')}</option>
              <option value="warning">{t('purchases.orderPages.postItAndRecordA')}</option>
              <option value="block">{t('purchases.orderPages.blockPosting')}</option>
            </select>
          </div>
          <TextField
            label={t('purchases.orderPages.quantityTolerance')}
            value={form.quantityTolerancePct ?? s.quantityTolerancePct}
            disabled={!canManage}
            inputMode="decimal"
            onChange={(e) => setForm({ ...form, quantityTolerancePct: e.target.value })}
            error={error?.fieldError('quantityTolerancePct')}
          />
          <TextField
            label={t('purchases.orderPages.priceTolerance')}
            value={form.priceTolerancePct ?? s.priceTolerancePct}
            disabled={!canManage}
            inputMode="decimal"
            onChange={(e) => setForm({ ...form, priceTolerancePct: e.target.value })}
            error={error?.fieldError('priceTolerancePct')}
          />
          {canManage ? (
            <div>
              <Button type="submit" busy={save.isPending}>
                {t('common.save')}
              </Button>
            </div>
          ) : null}
        </form>
        {save.isError && !error?.issues.length ? <ErrorAlert error={save.error} /> : null}
      </Card>
    </>
  );
}
