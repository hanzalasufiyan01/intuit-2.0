import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { BinsCard } from '../sales/ClassificationPages';
import { TextField } from '../../shared/ui/TextField';
import { useT } from '../../i18n/i18n';

/**
 * Warehouses and transfers (FP-29 A3/A4, ADR 0014). Cost is one average per item: a warehouse
 * holds quantities, and a transfer moves quantity with no journal. The server enforces every rule.
 */

export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  itemsInStock: number;
}

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

export function useWarehouses(enabled = true) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['inventory-warehouses', org],
    enabled,
    queryFn: () => api.get<WarehouseRow[]>('/inventory/warehouses'),
  });
}

interface WarehouseStock {
  warehouse: { id: string; code: string; name: string };
  items: {
    itemId: string;
    name: string | null;
    sku: string | null;
    quantity: string;
    value: string;
  }[];
}

export function WarehousesPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.InventorySettingsManage);
  const warehouses = useWarehouses();
  const [form, setForm] = useState({ code: '', name: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const stock = useQuery({
    queryKey: ['inventory-warehouse-stock', org, openId],
    enabled: openId !== null,
    queryFn: () => api.get<WarehouseStock>(`/inventory/warehouses/${openId}/stock`),
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['inventory-warehouses', org] });
  const create = useApiMutation(() => api.post('/inventory/warehouses', form));
  const update = useApiMutation(
    (v: { w: WarehouseRow; archived?: boolean; makeDefault?: boolean }) =>
      api.patch(`/inventory/warehouses/${v.w.id}`, {
        version: v.w.version,
        ...(v.archived !== undefined ? { archived: v.archived } : {}),
        ...(v.makeDefault ? { makeDefault: true } : {}),
      }),
  );
  return (
    <>
      <PageHeader
        title={t('inventory.warehousePages.warehouses')}
        description={t('inventory.warehousePages.whereStockIsKeptCost')}
      />
      <Card title={t('inventory.warehousePages.warehouses')}>
        {warehouses.isPending ? <Spinner /> : null}
        <ErrorAlert error={warehouses.error ?? update.error} />
        <table className="table">
          <thead>
            <tr>
              <th>{t('inventory.warehousePages.code')}</th>
              <th>{t('inventory.warehousePages.name')}</th>
              <th className="num">{t('inventory.warehousePages.itemsInStock')}</th>
              <th>{t('inventory.warehousePages.status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(warehouses.data ?? []).map((w) => (
              <tr key={w.id}>
                <td>{w.code}</td>
                <td>
                  {w.name}{' '}
                  {w.isDefault ? (
                    <small className="muted">{t('inventory.warehousePages.default')}</small>
                  ) : null}
                </td>
                <td className="num">{w.itemsInStock}</td>
                <td>
                  {w.status === 'ACTIVE'
                    ? t('inventory.warehousePages.active')
                    : t('inventory.warehousePages.archived')}
                </td>
                <td>
                  <Button variant="ghost" onClick={() => setOpenId(openId === w.id ? null : w.id)}>
                    {openId === w.id
                      ? t('inventory.warehousePages.hideStock')
                      : t('inventory.warehousePages.stock')}
                  </Button>{' '}
                  {canManage && !w.isDefault && w.status === 'ACTIVE' ? (
                    <>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          update.mutate({ w, makeDefault: true }, { onSuccess: refresh })
                        }
                      >
                        {t('inventory.warehousePages.makeDefault')}
                      </Button>{' '}
                      <Button
                        variant="ghost"
                        onClick={() => update.mutate({ w, archived: true }, { onSuccess: refresh })}
                      >
                        {t('common.archive')}
                      </Button>
                    </>
                  ) : null}
                  {canManage && w.status === 'ARCHIVED' ? (
                    <Button
                      variant="ghost"
                      onClick={() => update.mutate({ w, archived: false }, { onSuccess: refresh })}
                    >
                      {t('common.restore')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {openId ? (
        <Card
          title={
            stock.data
              ? t('inventory.warehousePages.stockIn', { name: stock.data.warehouse.name })
              : t('inventory.warehousePages.stock')
          }
        >
          {stock.isPending ? <Spinner /> : null}
          <ErrorAlert error={stock.error} />
          {stock.data && stock.data.items.length === 0 ? (
            <p className="muted">{t('inventory.warehousePages.nothingInStockHere')}</p>
          ) : null}
          {stock.data && stock.data.items.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('inventory.warehousePages.item')}</th>
                  <th className="num">{t('inventory.warehousePages.quantity')}</th>
                  <th className="num">{t('inventory.warehousePages.valueAtAverageCost')}</th>
                </tr>
              </thead>
              <tbody>
                {stock.data.items.map((i) => (
                  <tr key={i.itemId}>
                    <td>{i.name}</td>
                    <td className="num">{i.quantity}</td>
                    <td className="num">{formatAmount(i.value, 'MVR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Card>
      ) : null}
      {canManage ? (
        <Card title={t('inventory.warehousePages.addAWarehouse')}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined, {
                onSuccess: () => {
                  setForm({ code: '', name: '' });
                  refresh();
                },
              });
            }}
          >
            <TextField
              label={t('inventory.warehousePages.code')}
              required
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
            <TextField
              label={t('inventory.warehousePages.name')}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <ErrorAlert error={create.error} />
            <Button type="submit" busy={create.isPending}>
              {t('inventory.warehousePages.addWarehouse')}
            </Button>
          </form>
        </Card>
      ) : null}
      <BinsCard />
    </>
  );
}

interface Transfer {
  id: string;
  number: string;
  transferDate: string;
  status: 'POSTED' | 'VOID';
  memo: string;
  from: { name: string | null };
  to: { name: string | null };
  voidReason: string | null;
  version: number;
  lines: { itemId: string; name: string | null; quantity: string }[];
}

export function StockTransfersPage() {
  const tr = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canPost = usePermission(Permission.InventoryAdjustmentsCreate);
  const canVoid = usePermission(Permission.InventoryAdjustmentsVoid);
  const warehouses = useWarehouses();
  const tracked = useQuery({
    queryKey: ['inventory-items', org],
    queryFn: () => api.get<{ items: { itemId: string; name: string }[] }>('/inventory/items'),
    enabled: canPost,
  });
  const transfers = useQuery({
    queryKey: ['inventory-transfers', org],
    queryFn: () => api.get<Transfer[]>('/inventory/transfers'),
  });
  const [form, setForm] = useState({
    transferDate: new Date().toISOString().slice(0, 10),
    fromWarehouseId: '',
    toWarehouseId: '',
    memo: '',
  });
  const [rows, setRows] = useState<{ itemId: string; quantity: string }[]>([
    { itemId: '', quantity: '' },
  ]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['inventory-transfers', org] });
    void queryClient.invalidateQueries({ queryKey: ['inventory-warehouses', org] });
  };
  const post = useApiMutation(() =>
    api.post('/inventory/transfers', {
      ...form,
      memo: form.memo || undefined,
      lines: rows.filter((r) => r.itemId && r.quantity),
    }),
  );
  const voidTransfer = useApiMutation((t: Transfer) =>
    sensitive(async () => {
      const reason =
        window.prompt(tr('inventory.warehousePages.reasonForVoidingThisTransfer')) ?? '';
      if (!reason.trim()) throw new Error(tr('inventory.reasonRequired'));
      return api.post(`/inventory/transfers/${t.id}/void`, { version: t.version, reason });
    }),
  );
  const active = (warehouses.data ?? []).filter((w) => w.status === 'ACTIVE');
  return (
    <>
      <PageHeader
        title={tr('inventory.warehousePages.transfers')}
        description={tr('inventory.warehousePages.moveStockBetweenWarehousesNo')}
      />
      {canPost ? (
        <Card title={tr('inventory.warehousePages.newTransfer')}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              post.mutate(undefined, {
                onSuccess: () => {
                  setRows([{ itemId: '', quantity: '' }]);
                  refresh();
                },
              });
            }}
          >
            <TextField
              label={tr('inventory.warehousePages.date')}
              type="date"
              required
              value={form.transferDate}
              onChange={(e) => setForm({ ...form, transferDate: e.target.value })}
            />
            <div className="field">
              <label htmlFor="tr-from">{tr('inventory.warehousePages.from')}</label>
              <select
                id="tr-from"
                required
                value={form.fromWarehouseId}
                onChange={(e) => setForm({ ...form, fromWarehouseId: e.target.value })}
              >
                <option value="">{tr('common.choose')}</option>
                {active.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} {w.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="tr-to">{tr('inventory.warehousePages.to')}</label>
              <select
                id="tr-to"
                required
                value={form.toWarehouseId}
                onChange={(e) => setForm({ ...form, toWarehouseId: e.target.value })}
              >
                <option value="">{tr('common.choose')}</option>
                {active.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} {w.name}
                  </option>
                ))}
              </select>
            </div>
            {rows.map((r, i) => (
              <div className="filters" key={i}>
                <div className="field">
                  <label htmlFor={`tr-item-${i}`}>
                    {tr('inventory.warehousePages.item2', { value: i + 1 })}
                  </label>
                  <select
                    id={`tr-item-${i}`}
                    value={r.itemId}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))
                    }
                  >
                    <option value="">{tr('common.choose')}</option>
                    {(tracked.data?.items ?? []).map((t) => (
                      <option key={t.itemId} value={t.itemId}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <TextField
                  label={tr('inventory.warehousePages.quantity')}
                  inputMode="decimal"
                  value={r.quantity}
                  onChange={(e) =>
                    setRows(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))
                  }
                />
              </div>
            ))}
            <Button
              variant="ghost"
              onClick={() => setRows([...rows, { itemId: '', quantity: '' }])}
            >
              {tr('inventory.warehousePages.addAnItem')}
            </Button>
            <TextField
              label={tr('inventory.warehousePages.memo')}
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
            />
            <ErrorAlert error={post.error} />
            <Button type="submit" busy={post.isPending}>
              {tr('inventory.warehousePages.postTransfer')}
            </Button>
          </form>
        </Card>
      ) : null}
      <Card title={tr('inventory.warehousePages.transfers')}>
        {transfers.isPending ? <Spinner /> : null}
        <ErrorAlert error={transfers.error ?? voidTransfer.error} />
        {transfers.data && transfers.data.length === 0 ? (
          <p className="muted">{tr('inventory.warehousePages.noTransfersYet')}</p>
        ) : null}
        {(transfers.data ?? []).map((t) => (
          <div key={t.id}>
            <strong>{t.number}</strong> {t.transferDate} · {t.from.name} → {t.to.name} ·{' '}
            {t.status === 'VOID' ? (
              <em>{tr('inventory.warehousePages.void', { voidReason: t.voidReason })}</em>
            ) : (
              tr('inventory.warehousePages.posted')
            )}
            <ul className="list">
              {t.lines.map((l) => (
                <li key={l.itemId}>
                  {l.quantity} × {l.name}
                </li>
              ))}
            </ul>
            {canVoid && t.status === 'POSTED' ? (
              <Button
                variant="ghost"
                onClick={() => voidTransfer.mutate(t, { onSuccess: refresh })}
              >
                {tr('inventory.warehousePages.void2')}
              </Button>
            ) : null}
          </div>
        ))}
      </Card>
      <Alert>{tr('inventory.warehousePages.aTransferCanBeVoided')}</Alert>
    </>
  );
}

/** The warehouse a draft invoice, bill or vendor credit takes stock from or brings it to. */
export function DocumentWarehouse({
  type,
  id,
}: {
  type: 'invoice' | 'bill' | 'vendor_credit';
  id: string;
}) {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canSee = usePermission(Permission.InventoryView);
  const warehouses = useWarehouses(canSee);
  const current = useQuery({
    queryKey: ['inventory-document-warehouse', org, type, id],
    enabled: canSee,
    queryFn: () =>
      api.get<{ warehouseId: string | null }>(`/inventory/document-warehouse/${type}/${id}`),
  });
  const save = useApiMutation((warehouseId: string | null) =>
    api.put(`/inventory/document-warehouse/${type}/${id}`, { warehouseId }),
  );
  const active = (warehouses.data ?? []).filter((w) => w.status === 'ACTIVE');
  // Nothing to choose with a single warehouse.
  if (!canSee || active.length < 2) return null;
  return (
    <Card title={t('inventory.warehousePages.warehouse')}>
      <div className="field">
        <label htmlFor={`doc-wh-${id}`}>
          {t('inventory.warehousePages.warehouseForTrackedItems')}
        </label>
        <select
          id={`doc-wh-${id}`}
          value={current.data?.warehouseId ?? ''}
          onChange={(e) =>
            save.mutate(e.target.value || null, {
              onSuccess: () =>
                void queryClient.invalidateQueries({
                  queryKey: ['inventory-document-warehouse', org, type, id],
                }),
            })
          }
        >
          <option value="">{t('inventory.warehousePages.automaticDefaultWarehouseFirst')}</option>
          {active.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} {w.name}
            </option>
          ))}
        </select>
      </div>
      <ErrorAlert error={save.error} />
    </Card>
  );
}
