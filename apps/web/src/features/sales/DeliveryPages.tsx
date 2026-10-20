import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useFormatters, useT } from '../../i18n/i18n';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAnyPermission } from '../../permissions/permissions';

/**
 * Delivery notes of a sales order and stock reservations (migration 0091; reversible defaults of
 * ADR 0015). A delivery note records fulfilment only: it moves no stock and posts nothing. A
 * reservation is an advisory hold on stock. The server enforces every rule.
 */

interface Fulfilment {
  lines: {
    lineNo: number;
    description: string | null;
    ordered: string;
    delivered: string;
    invoiced: string;
    remaining: string;
  }[];
}
interface NoteSummary {
  id: string;
  number: string;
  deliveryDate: string;
  status: 'DRAFT' | 'DELIVERED' | 'VOID';
  version: number;
  voidReason: string | null;
}
interface Reservation {
  id: string;
  itemId: string;
  quantity: string;
  source: 'manual' | 'sales_order';
  note: string;
  expiresOn: string | null;
  status: 'ACTIVE' | 'RELEASED';
}

const STATUS_KEY = {
  DRAFT: 'delivery.status.draft',
  DELIVERED: 'delivery.status.delivered',
  VOID: 'delivery.status.void',
} as const;

export function DeliveryPanel({ orderId, canAct }: { orderId: string; canAct: boolean }) {
  const t = useT();
  const format = useFormatters();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const queryClient = useQueryClient();
  const fulfilment = useQuery({
    queryKey: ['delivery-fulfilment', org, orderId],
    queryFn: () => api.get<Fulfilment>(`/sales/orders/${orderId}/fulfilment`),
  });
  const notes = useQuery({
    queryKey: ['delivery-notes', org, orderId],
    queryFn: () => api.get<NoteSummary[]>(`/sales/delivery-notes?orderId=${orderId}`),
  });
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [qty, setQty] = useState<Record<number, string>>({});
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['delivery-fulfilment', org, orderId] });
    void queryClient.invalidateQueries({ queryKey: ['delivery-notes', org, orderId] });
  };
  const create = useApiMutation(() =>
    api.post('/sales/delivery-notes', {
      orderId,
      deliveryDate: date,
      lines: Object.entries(qty)
        .filter(([, q]) => q.trim())
        .map(([lineNo, q]) => ({ orderLineNo: Number(lineNo), quantity: q.trim() })),
    }),
  );
  const act = useApiMutation(
    (input: { note: NoteSummary; action: 'deliver' | 'void' | 'delete'; reason?: string }) =>
      input.action === 'delete'
        ? api.delete(`/sales/delivery-notes/${input.note.id}?version=${input.note.version}`)
        : api.post(`/sales/delivery-notes/${input.note.id}/${input.action}`, {
            version: input.note.version,
            ...(input.reason ? { reason: input.reason } : {}),
          }),
  );
  const reserve = useApiMutation(() => api.post(`/sales/orders/${orderId}/reserve`, {}));
  const anyQty = Object.values(qty).some((q) => q.trim());
  return (
    <Card title={t('delivery.title')}>
      <p className="muted">{t('delivery.intro')}</p>
      <ErrorAlert error={fulfilment.error ?? notes.error ?? act.error} />
      {fulfilment.isPending ? <Spinner /> : null}
      {fulfilment.data ? (
        <table className="table">
          <thead>
            <tr>
              <th>{t('delivery.line')}</th>
              <th className="num">{t('delivery.ordered')}</th>
              <th className="num">{t('delivery.delivered')}</th>
              <th className="num">{t('delivery.remaining')}</th>
              {canAct ? <th>{t('delivery.deliverNow')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {fulfilment.data.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>{l.description}</td>
                <td className="num">{l.ordered}</td>
                <td className="num">{l.delivered}</td>
                <td className="num">{l.remaining}</td>
                {canAct ? (
                  <td>
                    <input
                      aria-label={t('delivery.quantityFor', { line: l.lineNo })}
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
      ) : null}
      {canAct ? (
        <div className="filters">
          <TextField
            label={t('delivery.date')}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Button
            busy={create.isPending}
            disabled={!anyQty}
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: () => {
                  setQty({});
                  refresh();
                },
              })
            }
          >
            {t('delivery.create')}
          </Button>
          <Button
            variant="secondary"
            busy={reserve.isPending}
            onClick={() => reserve.mutate(undefined)}
          >
            {t('delivery.reserve')}
          </Button>
        </div>
      ) : null}
      <ErrorAlert error={create.error ?? reserve.error} />
      {reserve.isSuccess ? <Alert tone="info">{t('delivery.reserved')}</Alert> : null}
      {notes.data && notes.data.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>{t('delivery.number')}</th>
              <th>{t('delivery.date')}</th>
              <th>{t('delivery.statusLabel')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {notes.data.map((n) => (
              <tr key={n.id}>
                <td>{n.number}</td>
                <td>{format.date(n.deliveryDate)}</td>
                <td>
                  {t(STATUS_KEY[n.status])}
                  {n.voidReason ? ` (${n.voidReason})` : ''}
                </td>
                <td>
                  {canAct && n.status === 'DRAFT' ? (
                    <>
                      <Button
                        aria-label={t('delivery.deliverNote', { number: n.number })}
                        onClick={() =>
                          act.mutate({ note: n, action: 'deliver' }, { onSuccess: refresh })
                        }
                      >
                        {t('delivery.deliver')}
                      </Button>
                      <Button
                        variant="ghost"
                        aria-label={t('delivery.deleteNote', { number: n.number })}
                        onClick={() =>
                          act.mutate({ note: n, action: 'delete' }, { onSuccess: refresh })
                        }
                      >
                        {t('common.delete')}
                      </Button>
                    </>
                  ) : null}
                  {canAct && n.status === 'DELIVERED' ? (
                    <Button
                      variant="ghost"
                      aria-label={t('delivery.voidNote', { number: n.number })}
                      onClick={() => {
                        const reason = window.prompt(t('delivery.voidPrompt'));
                        if (reason?.trim()) {
                          act.mutate(
                            { note: n, action: 'void', reason: reason.trim() },
                            { onSuccess: refresh },
                          );
                        }
                      }}
                    >
                      {t('delivery.void')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">{t('delivery.none')}</p>
      )}
    </Card>
  );
}

export function ReservationsPage() {
  const t = useT();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const queryClient = useQueryClient();
  const canManage = useAnyPermission([Permission.InventoryAdjustmentsCreate]);
  const canView = usePermission(Permission.InventoryView);
  const list = useQuery({
    queryKey: ['reservations', org],
    enabled: canView,
    queryFn: () => api.get<Reservation[]>('/inventory/reservations?status=ACTIVE'),
  });
  const items = useQuery({
    queryKey: ['inventory-items-list', org],
    enabled: canView,
    queryFn: () => api.get<{ items: { itemId: string; name: string }[] }>('/inventory/items'),
  });
  const [form, setForm] = useState({ itemId: '', quantity: '', note: '' });
  const [check, setCheck] = useState('');
  const availability = useQuery({
    queryKey: ['availability', org, check],
    enabled: check !== '',
    queryFn: () =>
      api.get<{ onHand: string; reserved: string; available: string; note: string }>(
        `/inventory/items/${check}/availability`,
      ),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['reservations', org] });
    void queryClient.invalidateQueries({ queryKey: ['availability', org] });
  };
  const create = useApiMutation(() =>
    api.post('/inventory/reservations', {
      itemId: form.itemId,
      quantity: form.quantity.trim(),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    }),
  );
  const release = useApiMutation((id: string) =>
    api.post(`/inventory/reservations/${id}/release`, { reason: 'Released by user' }),
  );
  const nameOf = (id: string) =>
    items.data?.items.find((i) => i.itemId === id)?.name ?? id.slice(0, 8);
  return (
    <>
      <PageHeader title={t('reservations.title')} description={t('reservations.description')} />
      <Card title={t('reservations.availability')}>
        <div className="field">
          <label htmlFor="availability-item">{t('reservations.item')}</label>
          <select id="availability-item" value={check} onChange={(e) => setCheck(e.target.value)}>
            <option value="">{t('common.choose')}</option>
            {(items.data?.items ?? []).map((i) => (
              <option key={i.itemId} value={i.itemId}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
        {availability.data ? (
          <table className="table">
            <tbody>
              <tr>
                <td>{t('reservations.onHand')}</td>
                <td className="num">{availability.data.onHand}</td>
              </tr>
              <tr>
                <td>{t('reservations.reserved')}</td>
                <td className="num">{availability.data.reserved}</td>
              </tr>
              <tr>
                <th>{t('reservations.available')}</th>
                <th className="num">{availability.data.available}</th>
              </tr>
            </tbody>
          </table>
        ) : null}
        <ErrorAlert error={availability.error} />
      </Card>
      <Card title={t('reservations.active')}>
        {list.isPending && canView ? <Spinner /> : null}
        <ErrorAlert error={list.error ?? release.error} />
        {list.data && list.data.length === 0 ? (
          <p className="muted">{t('reservations.none')}</p>
        ) : null}
        {list.data && list.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('reservations.item')}</th>
                <th className="num">{t('reservations.quantity')}</th>
                <th>{t('reservations.source')}</th>
                <th>{t('reservations.note')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td>{nameOf(r.itemId)}</td>
                  <td className="num">{r.quantity}</td>
                  <td>
                    {r.source === 'manual' ? t('reservations.manual') : t('reservations.fromOrder')}
                  </td>
                  <td>{r.note || '—'}</td>
                  <td>
                    <Button
                      variant="ghost"
                      aria-label={t('reservations.releaseFor', { item: nameOf(r.itemId) })}
                      onClick={() => release.mutate(r.id, { onSuccess: refresh })}
                    >
                      {t('reservations.release')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
      {canManage ? (
        <Card title={t('reservations.new')}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined, {
                onSuccess: () => {
                  setForm({ itemId: '', quantity: '', note: '' });
                  refresh();
                },
              });
            }}
            noValidate
          >
            <div className="field">
              <label htmlFor="reserve-item">{t('reservations.item')}</label>
              <select
                id="reserve-item"
                value={form.itemId}
                onChange={(e) => setForm({ ...form, itemId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {(items.data?.items ?? []).map((i) => (
                  <option key={i.itemId} value={i.itemId}>
                    {i.name}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label={t('reservations.quantity')}
              inputMode="decimal"
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
            />
            <TextField
              label={t('reservations.note')}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
            <ErrorAlert error={create.error} />
            <Button
              type="submit"
              busy={create.isPending}
              disabled={!form.itemId || !form.quantity.trim()}
            >
              {t('reservations.create')}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}
