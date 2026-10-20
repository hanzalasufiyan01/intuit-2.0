import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { PayOnlinePanel } from './PaymentPages';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { SalesNav, useCustomerOptions, useItemOptions } from './shared';
import { DeliveryPanel } from './DeliveryPages';
import { useT } from '../../i18n/i18n';

/**
 * Sales orders, payment reminders and invoice share links (FP-28). None of them posts to the
 * ledger. The public invoice view is outside the signed-in area: it shows one issued invoice.
 */

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------

interface OrderLine {
  lineNo: number;
  description: string;
  quantity: string;
  unitPrice: string;
  netAmount: string;
  invoiced: string;
  remaining: string;
}
interface Order {
  id: string;
  number: string;
  customerId: string;
  orderDate: string;
  status: 'DRAFT' | 'CONFIRMED' | 'PARTIALLY_INVOICED' | 'INVOICED' | 'CANCELLED';
  reference: string | null;
  netTotal: string;
  cancelReason: string | null;
  version: number;
  lines: OrderLine[];
}

export function SalesOrdersPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canCreate = usePermission(Permission.SalesOrdersCreate);
  const customers = useCustomerOptions();
  const items = useItemOptions();
  const list = useQuery({
    queryKey: ['sales-orders', org],
    queryFn: () => api.get<Order[]>('/sales/orders'),
  });
  const [form, setForm] = useState({ customerId: '', orderDate: today(), reference: '' });
  const [lines, setLines] = useState([
    { itemId: '', description: '', quantity: '1', unitPrice: '' },
  ]);
  const create = useApiMutation(() =>
    api.post<Order>(
      '/sales/orders',
      {
        customerId: form.customerId,
        orderDate: form.orderDate,
        reference: form.reference.trim() || null,
        lines: lines.map((l) => ({
          ...(l.itemId ? { itemId: l.itemId } : {}),
          ...(l.description.trim() ? { description: l.description.trim() } : {}),
          quantity: l.quantity.trim(),
          unitPrice: l.unitPrice.trim() || '0',
        })),
      },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const nameOf = (id: string) =>
    customers.data?.items.find((c) => c.id === id)?.displayName ?? id.slice(0, 8);
  const set = (i: number, patch: Partial<(typeof lines)[number]>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <>
      <SalesNav />
      <PageHeader
        title={t('sales.extraPages.salesOrders')}
        description={t('sales.extraPages.aCustomerSConfirmedOrder')}
      />
      <Card title={t('sales.extraPages.orders')}>
        {list.isPending ? <Spinner /> : null}
        <ErrorAlert error={list.error} />
        {list.data ? (
          list.data.length === 0 ? (
            <p className="muted">{t('sales.extraPages.noOrdersYet')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('sales.extraPages.number')}</th>
                  <th>{t('sales.extraPages.customer')}</th>
                  <th>{t('sales.extraPages.date')}</th>
                  <th className="num">{t('sales.extraPages.netTotal')}</th>
                  <th>{t('sales.extraPages.status')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/sales/orders/${o.id}`}>{o.number}</Link>
                    </td>
                    <td>{nameOf(o.customerId)}</td>
                    <td>{o.orderDate}</td>
                    <td className="num">{formatAmount(o.netTotal, 'MVR')}</td>
                    <td>{o.status.toLowerCase().replace('_', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </Card>
      {canCreate ? (
        <Card title={t('sales.extraPages.newOrder')}>
          <form
            className="form"
            noValidate
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              create.mutate(undefined, {
                onSuccess: (o) => {
                  void queryClient.invalidateQueries({ queryKey: ['sales-orders', org] });
                  void navigate(`/sales/orders/${o.id}`);
                },
              });
            }}
          >
            <div className="field">
              <label htmlFor="order-customer">{t('sales.extraPages.customer')}</label>
              <select
                id="order-customer"
                value={form.customerId}
                onChange={(e) => setForm({ ...form, customerId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {(customers.data?.items ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label={t('sales.extraPages.orderDate')}
              type="date"
              value={form.orderDate}
              onChange={(e) => setForm({ ...form, orderDate: e.target.value })}
            />
            <TextField
              label={t('sales.extraPages.customerReference')}
              value={form.reference}
              onChange={(e) => setForm({ ...form, reference: e.target.value })}
            />
            {lines.map((l, i) => (
              <div key={i} className="filters">
                <div className="field">
                  <label htmlFor={`order-item-${i}`}>{t('sales.extraPages.item')}</label>
                  <select
                    id={`order-item-${i}`}
                    value={l.itemId}
                    onChange={(e) => {
                      const item = items.data?.items.find((x) => x.id === e.target.value);
                      set(i, {
                        itemId: e.target.value,
                        ...(item && !l.unitPrice && item.unitPrice
                          ? { unitPrice: item.unitPrice }
                          : {}),
                      });
                    }}
                  >
                    <option value="">{t('sales.extraPages.noItem')}</option>
                    {(items.data?.items ?? []).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </div>
                <TextField
                  label={t('sales.extraPages.description')}
                  value={l.description}
                  onChange={(e) => set(i, { description: e.target.value })}
                />
                <TextField
                  label={t('sales.extraPages.quantity')}
                  value={l.quantity}
                  inputMode="decimal"
                  onChange={(e) => set(i, { quantity: e.target.value })}
                />
                <TextField
                  label={t('sales.extraPages.unitPrice')}
                  value={l.unitPrice}
                  inputMode="decimal"
                  onChange={(e) => set(i, { unitPrice: e.target.value })}
                />
              </div>
            ))}
            <Button
              variant="secondary"
              onClick={() =>
                setLines([...lines, { itemId: '', description: '', quantity: '1', unitPrice: '' }])
              }
            >
              {t('sales.extraPages.addLine')}
            </Button>
            <ErrorAlert error={create.error} />
            <Button type="submit" busy={create.isPending} disabled={!form.customerId}>
              {t('sales.extraPages.createOrder')}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}

export function SalesOrderDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canCreate = usePermission(Permission.SalesOrdersCreate);
  const canInvoice = usePermission(Permission.SalesOrdersInvoice);
  const order = useQuery({
    queryKey: ['sales-order', org, id],
    queryFn: () => api.get<Order>(`/sales/orders/${id}`),
  });
  const [qty, setQty] = useState<Record<number, string>>({});
  const act = useApiMutation((input: { action: string; body?: object }) =>
    api.post<{ invoiceId?: string }>(`/sales/orders/${id}/${input.action}`, {
      version: order.data?.version,
      ...input.body,
    }),
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['sales-order', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['sales-orders', org] });
  };
  const o = order.data;
  const money = (v: string) => formatAmount(v, 'MVR');
  const open = o?.status === 'CONFIRMED' || o?.status === 'PARTIALLY_INVOICED';
  return (
    <>
      <SalesNav />
      <PageHeader
        title={o ? t('sales.extraPages.order', { number: o.number }) : t('sales.extraPages.order2')}
        description={o ? o.status.toLowerCase().replace('_', ' ') : undefined}
      />
      {order.isPending ? <Spinner /> : null}
      <ErrorAlert error={order.error} />
      {o && open ? <DeliveryPanel orderId={o.id} canAct={canCreate} /> : null}
      {o ? (
        <Card title={t('sales.extraPages.lines')}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('sales.extraPages.description')}</th>
                <th className="num">{t('sales.extraPages.ordered')}</th>
                <th className="num">{t('sales.extraPages.invoiced')}</th>
                <th className="num">{t('sales.extraPages.remaining')}</th>
                <th className="num">{t('sales.extraPages.unitPrice')}</th>
                {open && canInvoice ? <th>{t('sales.extraPages.invoiceNow')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td>{l.description}</td>
                  <td className="num">{l.quantity}</td>
                  <td className="num">{l.invoiced}</td>
                  <td className="num">{l.remaining}</td>
                  <td className="num">{money(l.unitPrice)}</td>
                  {open && canInvoice ? (
                    <td>
                      <input
                        aria-label={t('sales.extraPages.quantityToInvoiceLine', {
                          lineNo: l.lineNo,
                        })}
                        value={qty[l.lineNo] ?? ''}
                        placeholder={l.remaining}
                        inputMode="decimal"
                        onChange={(e) => setQty({ ...qty, [l.lineNo]: e.target.value })}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {o.cancelReason ? (
            <Alert>{t('sales.extraPages.cancelled', { cancelReason: o.cancelReason })}</Alert>
          ) : null}
          <div className="filters">
            {o.status === 'DRAFT' && canCreate ? (
              <Button onClick={() => act.mutate({ action: 'confirm' }, { onSuccess: refresh })}>
                {t('sales.extraPages.confirmOrder')}
              </Button>
            ) : null}
            {open && canInvoice ? (
              <Button
                onClick={() => {
                  const chosen = Object.entries(qty)
                    .filter(([, v]) => v.trim())
                    .map(([lineNo, quantity]) => ({
                      lineNo: Number(lineNo),
                      quantity: quantity.trim(),
                    }));
                  act.mutate(
                    { action: 'invoice', body: chosen.length ? { lines: chosen } : {} },
                    {
                      onSuccess: (r) => {
                        refresh();
                        if (r.invoiceId) void navigate(`/sales/invoices/${r.invoiceId}`);
                      },
                    },
                  );
                }}
              >
                {t('sales.extraPages.createDraftInvoice')}
              </Button>
            ) : null}
            {['DRAFT', 'CONFIRMED'].includes(o.status) && canCreate ? (
              <Button
                variant="ghost"
                onClick={() => {
                  const reason = window.prompt(t('sales.extraPages.whyIsThisOrderCancelled'));
                  if (reason?.trim()) {
                    act.mutate(
                      { action: 'cancel', body: { reason: reason.trim() } },
                      { onSuccess: refresh },
                    );
                  }
                }}
              >
                {t('sales.extraPages.cancelOrder')}
              </Button>
            ) : null}
          </div>
          <ErrorAlert error={act.error} />
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Payment reminders
// ---------------------------------------------------------------------------

interface Overdue {
  invoiceId: string;
  number: string;
  customerName: string | null;
  hasEmail: boolean;
  currencyCode: string;
  dueDate: string;
  daysOverdue: number;
  openAmount: string;
  remindersSent: number;
  lastReminderAt: string | null;
}
interface ReminderSettings {
  autoEnabled: boolean;
  firstAfterDays: number;
  repeatEveryDays: number;
  maxReminders: number;
  version: number;
}

export function RemindersPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canSend = usePermission(Permission.PaymentRemindersSend);
  const canSettings = usePermission(Permission.PaymentRemindersSettings);
  const overdue = useQuery({
    queryKey: ['reminders-overdue', org],
    queryFn: () => api.get<Overdue[]>('/sales/reminders/overdue'),
  });
  const settings = useQuery({
    queryKey: ['reminder-settings', org],
    queryFn: () => api.get<ReminderSettings>('/sales/reminders/settings'),
  });
  const [draft, setDraft] = useState<ReminderSettings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const send = useApiMutation((i: Overdue) =>
    api.post<{ sentTo: string }>(`/sales/reminders/invoices/${i.invoiceId}/send`, {}),
  );
  const save = useApiMutation((value: ReminderSettings) =>
    sensitive(() => api.put('/sales/reminders/settings', value)),
  );
  const current = draft ?? settings.data ?? null;
  return (
    <>
      <SalesNav />
      <PageHeader
        title={t('sales.extraPages.paymentReminders')}
        description={t('sales.extraPages.overdueInvoicesAndTheReminders')}
      />
      {notice ? <Alert>{notice}</Alert> : null}
      <Card title={t('sales.extraPages.overdueInvoices')}>
        {overdue.isPending ? <Spinner /> : null}
        <ErrorAlert error={overdue.error} />
        {overdue.data ? (
          overdue.data.length === 0 ? (
            <p className="muted">{t('sales.extraPages.noInvoiceIsOverdue')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('sales.extraPages.invoice')}</th>
                  <th>{t('sales.extraPages.customer')}</th>
                  <th>{t('sales.extraPages.due')}</th>
                  <th className="num">{t('sales.extraPages.daysOverdue')}</th>
                  <th className="num">{t('sales.extraPages.open')}</th>
                  <th className="num">{t('sales.extraPages.reminders')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {overdue.data.map((i) => (
                  <tr key={i.invoiceId}>
                    <td>
                      <Link to={`/sales/invoices/${i.invoiceId}`}>{i.number}</Link>
                    </td>
                    <td>
                      {i.customerName ?? '—'}
                      {i.hasEmail ? '' : t('sales.extraPages.noEMail')}
                    </td>
                    <td>{i.dueDate}</td>
                    <td className="num">{i.daysOverdue}</td>
                    <td className="num">{formatAmount(i.openAmount, i.currencyCode)}</td>
                    <td className="num">{i.remindersSent}</td>
                    <td>
                      {canSend && i.hasEmail ? (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            send.mutate(i, {
                              onSuccess: (r) => {
                                setNotice(
                                  t('sales.extraPages.reminderSent', {
                                    number: i.number,
                                    sentTo: r.sentTo,
                                  }),
                                );
                                void queryClient.invalidateQueries({
                                  queryKey: ['reminders-overdue', org],
                                });
                              },
                            })
                          }
                        >
                          {t('sales.extraPages.sendReminder')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
        <ErrorAlert error={send.error} />
      </Card>
      {current ? (
        <Card title={t('sales.extraPages.automaticReminders')}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(current, {
                onSuccess: () => {
                  setDraft(null);
                  void queryClient.invalidateQueries({ queryKey: ['reminder-settings', org] });
                },
              });
            }}
          >
            <label className="check">
              <input
                type="checkbox"
                disabled={!canSettings}
                checked={current.autoEnabled}
                onChange={(e) => setDraft({ ...current, autoEnabled: e.target.checked })}
              />{' '}
              {t('sales.extraPages.sendRemindersAutomaticallyOffBy')}
            </label>
            <TextField
              label={t('sales.extraPages.firstReminderAfterDaysOverdue')}
              value={String(current.firstAfterDays)}
              inputMode="numeric"
              disabled={!canSettings}
              onChange={(e) =>
                setDraft({ ...current, firstAfterDays: Number(e.target.value) || 0 })
              }
            />
            <TextField
              label={t('sales.extraPages.thenEveryDays')}
              value={String(current.repeatEveryDays)}
              inputMode="numeric"
              disabled={!canSettings}
              onChange={(e) =>
                setDraft({ ...current, repeatEveryDays: Number(e.target.value) || 1 })
              }
            />
            <TextField
              label={t('sales.extraPages.atMostRemindersPerInvoice')}
              value={String(current.maxReminders)}
              inputMode="numeric"
              disabled={!canSettings}
              onChange={(e) => setDraft({ ...current, maxReminders: Number(e.target.value) || 1 })}
            />
            <ErrorAlert error={save.error} />
            {canSettings ? (
              <Button type="submit" busy={save.isPending}>
                {t('common.save')}
              </Button>
            ) : null}
          </form>
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Invoice share links
// ---------------------------------------------------------------------------

interface ShareLink {
  id: string;
  status: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  viewCount: number;
  lastViewedAt: string | null;
}

/** Create, copy once and revoke read-only links to one issued invoice. */
export function ShareLinksPanel({ invoiceId }: { invoiceId: string }) {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canManage = usePermission(Permission.InvoiceLinksManage);
  const [shown, setShown] = useState<string | null>(null);
  const [days, setDays] = useState('30');
  const links = useQuery({
    queryKey: ['share-links', org, invoiceId],
    enabled: canManage,
    queryFn: () => api.get<ShareLink[]>(`/sales/invoices/${invoiceId}/share-links`),
  });
  const create = useApiMutation(() =>
    sensitive(() =>
      api.post<ShareLink & { url: string }>(`/sales/invoices/${invoiceId}/share-links`, {
        expiresInDays: Number(days) || 30,
      }),
    ),
  );
  const revoke = useApiMutation((l: ShareLink) =>
    sensitive(() => api.post(`/sales/share-links/${l.id}/revoke`, {})),
  );
  if (!canManage) return null;
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['share-links', org, invoiceId] });
  return (
    <Card title={t('sales.extraPages.shareWithTheCustomer')}>
      <p className="muted">{t('sales.extraPages.aLinkLetsAnyoneWho')}</p>
      {shown ? (
        <>
          <Alert>{t('sales.extraPages.copyThisLinkNowIt')}</Alert>
          <input
            aria-label={t('sales.extraPages.shareLink')}
            readOnly
            value={shown}
            style={{ width: '100%' }}
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(shown)}>
            {t('sales.extraPages.copy')}
          </Button>
          <Button variant="ghost" onClick={() => setShown(null)}>
            {t('sales.extraPages.iHaveCopiedIt')}
          </Button>
        </>
      ) : null}
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined, {
            onSuccess: (l) => {
              setShown(l.url);
              refresh();
            },
          });
        }}
      >
        <TextField
          label={t('sales.extraPages.validForDays')}
          value={days}
          inputMode="numeric"
          onChange={(e) => setDays(e.target.value)}
        />
        <Button type="submit" busy={create.isPending}>
          {t('sales.extraPages.createLink')}
        </Button>
      </form>
      <ErrorAlert error={create.error ?? revoke.error} />
      {links.data && links.data.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>{t('sales.extraPages.status')}</th>
              <th>{t('sales.extraPages.expires')}</th>
              <th className="num">{t('sales.extraPages.views')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {links.data.map((l) => (
              <tr key={l.id}>
                <td>{l.status}</td>
                <td>{new Date(l.expiresAt).toLocaleDateString()}</td>
                <td className="num">{l.viewCount}</td>
                <td>
                  {l.status === 'active' ? (
                    <Button
                      variant="ghost"
                      onClick={() => revoke.mutate(l, { onSuccess: refresh })}
                    >
                      {t('sales.extraPages.revoke')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The public, signed-out invoice view
// ---------------------------------------------------------------------------

interface PublicInvoice {
  organizationName: string;
  number: string;
  status: string;
  voided: boolean;
  invoiceDate: string;
  dueDate: string;
  currencyCode: string;
  customerName: string;
  reference?: string | null;
  subtotal?: string;
  discountTotal?: string;
  taxTotal?: string;
  total?: string;
  amountDue?: string;
  lines?: {
    description: string;
    quantity: string;
    unitPrice: string;
    netAmount: string;
    total: string;
  }[];
}

export function PublicInvoicePage() {
  const t = useT();
  const { token = '' } = useParams();
  const invoice = useQuery({
    queryKey: ['public-invoice', token],
    queryFn: () => api.get<PublicInvoice>(`/public/invoices/${token}`),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const inv = invoice.data;
  const money = (v: string | undefined) => formatAmount(v ?? '0', inv?.currencyCode ?? 'MVR');
  return (
    <main className="container" style={{ maxWidth: 780, margin: '2rem auto', padding: '0 1rem' }}>
      {invoice.isPending ? <Spinner /> : null}
      {invoice.isError ? <Alert>{t('sales.extraPages.thisLinkIsNotValid')}</Alert> : null}
      {inv ? (
        <>
          <h1>{inv.organizationName}</h1>
          <h2>{t('sales.extraPages.invoice2', { number: inv.number })}</h2>
          {inv.voided ? (
            <Alert>{t('sales.extraPages.thisInvoiceHasBeenCancelled')}</Alert>
          ) : (
            <>
              <p>
                {t('sales.extraPages.forDatedDue', {
                  customerName: inv.customerName,
                  invoiceDate: inv.invoiceDate,
                  dueDate: inv.dueDate,
                  value: inv.reference
                    ? t('sales.extraPages.reference', { reference: inv.reference })
                    : '',
                })}
              </p>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('sales.extraPages.description')}</th>
                    <th className="num">{t('sales.extraPages.quantity')}</th>
                    <th className="num">{t('sales.extraPages.unitPrice')}</th>
                    <th className="num">{t('sales.extraPages.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(inv.lines ?? []).map((l, i) => (
                    <tr key={i}>
                      <td>{l.description}</td>
                      <td className="num">{l.quantity}</td>
                      <td className="num">{money(l.unitPrice)}</td>
                      <td className="num">{money(l.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>{t('sales.extraPages.tax')}</td>
                    <td className="num">{money(inv.taxTotal)}</td>
                  </tr>
                  <tr>
                    <th colSpan={3}>{t('sales.extraPages.total')}</th>
                    <th className="num">{money(inv.total)}</th>
                  </tr>
                  <tr>
                    <th colSpan={3}>{t('sales.extraPages.amountDue')}</th>
                    <th className="num">{money(inv.amountDue)}</th>
                  </tr>
                </tfoot>
              </table>
              <PayOnlinePanel
                token={token}
                currencyCode={inv.currencyCode}
                amountDue={inv.amountDue ?? '0'}
              />
            </>
          )}
        </>
      ) : null}
    </main>
  );
}
