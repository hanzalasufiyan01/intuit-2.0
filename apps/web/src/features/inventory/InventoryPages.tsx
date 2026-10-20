import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ItemLotsCard, ItemUnitsCard } from './AdvancedPages';
import { useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { useT, type MessageKey } from '../../i18n/i18n';

/**
 * Inventory: items tracked in stock at weighted-average cost, the stock ledger, stock
 * adjustments, settings and valuation against the general ledger. The server computes every cost
 * and balance and enforces the negative-stock policy; these pages only guide.
 */

export const INVENTORY_VIEW_PERMISSIONS = [Permission.InventoryView] as const;

interface TrackedItem {
  itemId: string;
  sku: string | null;
  name: string;
  inventoryAccountId: string;
  cogsAccountId: string;
  reorderPoint: string | null;
  trackingMode?: 'none' | 'lot' | 'serial';
  quantity: string;
  averageCost: string;
  value: string;
  belowReorderPoint: boolean;
  version: number;
}

interface Movement {
  id: string;
  date: string;
  kind: string;
  quantity: string;
  value: string;
  quantityAfter: string;
  valueAfter: string;
  sourceType: string;
  journalId: string | null;
}

interface Adjustment {
  id: string;
  number: string;
  status: 'POSTED' | 'VOID';
  date: string;
  reason: string;
  netValue: string;
  journalId: string | null;
  voidReason: string | null;
  version: number;
  lines: { lineNo: number; itemId: string; quantityChange: string; value: string }[];
}

interface Valuation {
  items: TrackedItem[];
  totalValue: string;
  accounts: { accountId: string; stockValue: string; glBalance: string; difference: string }[];
}

interface Settings {
  negativeStockPolicy: 'block' | 'allow';
  adjustmentAccountId: string | null;
  version: number;
}

const KIND_LABEL: Record<string, MessageKey> = {
  purchase: 'inventory.inventoryPages.kind.purchase',
  purchase_void: 'inventory.inventoryPages.kind.purchase_void',
  sale: 'inventory.inventoryPages.kind.sale',
  sale_void: 'inventory.inventoryPages.kind.sale_void',
  adjustment: 'inventory.inventoryPages.kind.adjustment',
  adjustment_void: 'inventory.inventoryPages.kind.adjustment_void',
  sales_return: 'inventory.inventoryPages.kind.sales_return',
  sales_return_void: 'inventory.inventoryPages.kind.sales_return_void',
};

const today = () => new Date().toISOString().slice(0, 10);

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

export function InventorySection() {
  const t = useT();
  return (
    <>
      <nav className="subnav" aria-label={t('inventory.inventoryPages.inventory')}>
        <NavLink to="/inventory" end>
          {t('inventory.inventoryPages.stock')}
        </NavLink>
        <Can permission={Permission.InventoryView}>
          <NavLink to="/inventory/adjustments">{t('inventory.inventoryPages.adjustments')}</NavLink>
          <NavLink to="/inventory/returns">{t('inventory.inventoryPages.returns')}</NavLink>
          <NavLink to="/inventory/bundles">{t('inventory.inventoryPages.bundles')}</NavLink>
          <NavLink to="/inventory/warehouses">{t('inventory.inventoryPages.warehouses')}</NavLink>
          <NavLink to="/inventory/reservations">
            {t('inventory.inventoryPages.reservations')}
          </NavLink>
          <NavLink to="/inventory/transfers">{t('inventory.inventoryPages.transfers')}</NavLink>
          <NavLink to="/inventory/lots">{t('inventory.inventoryPages.expiring')}</NavLink>
          <NavLink to="/inventory/landed-costs">{t('inventory.inventoryPages.landedCost')}</NavLink>
          <Can permission={Permission.InventoryCountsManage}>
            <NavLink to="/inventory/counts">{t('inventory.inventoryPages.counts')}</NavLink>
          </Can>
          <NavLink to="/inventory/valuation">{t('inventory.inventoryPages.valuation')}</NavLink>
          <NavLink to="/inventory/reports">{t('inventory.inventoryPages.reports')}</NavLink>
          <Can permission={Permission.PurchaseOrdersView}>
            <NavLink to="/inventory/purchase-suggestions">
              {t('inventory.inventoryPages.purchaseSuggestions')}
            </NavLink>
          </Can>
          <NavLink to="/inventory/settings">{t('inventory.inventoryPages.settings')}</NavLink>
        </Can>
      </nav>
      <Outlet />
    </>
  );
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

export function StockPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.InventoryItemsManage);
  const canSeeAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canManage && canSeeAccounts);
  const items = useQuery({
    queryKey: ['inventory-items', org],
    queryFn: () => api.get<{ items: TrackedItem[] }>('/inventory/items'),
  });
  const catalog = useQuery({
    queryKey: ['inventory-catalog', org],
    queryFn: () =>
      api.get<{ items: { id: string; name: string; itemType: string }[] }>(
        '/sales/items?limit=200&status=active',
      ),
    enabled: canManage,
  });
  const [form, setForm] = useState({
    itemId: '',
    inventoryAccountId: '',
    cogsAccountId: '',
    trackingMode: 'none',
    expiryTracked: false,
  });
  const tracked = new Set((items.data?.items ?? []).map((i) => i.itemId));
  const products = (catalog.data?.items ?? []).filter(
    (i) => i.itemType === 'product' && !tracked.has(i.id),
  );
  const track = useApiMutation(() =>
    api.post(`/inventory/items/${form.itemId}`, {
      inventoryAccountId: form.inventoryAccountId,
      cogsAccountId: form.cogsAccountId,
      trackingMode: form.trackingMode,
      expiryTracked: form.expiryTracked,
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    track.mutate(undefined, {
      onSuccess: () => {
        setForm({
          itemId: '',
          inventoryAccountId: '',
          cogsAccountId: '',
          trackingMode: 'none',
          expiryTracked: false,
        });
        void queryClient.invalidateQueries({ queryKey: ['inventory-items', org] });
      },
    });
  };
  const usable = (accounts.data ?? []).filter(
    (a) => a.status === 'ACTIVE' && a.isLeaf && !a.isControlAccount,
  );
  const error = track.error instanceof ApiError ? track.error : null;
  return (
    <>
      <PageHeader
        title={t('inventory.inventoryPages.stock')}
        description={t('inventory.inventoryPages.itemsTrackedInStockAt')}
      />
      <Card title={t('inventory.inventoryPages.trackedItems')}>
        {items.isPending ? (
          <Spinner />
        ) : items.isError ? (
          <ErrorAlert error={items.error} />
        ) : items.data.items.length === 0 ? (
          <p className="muted">{t('inventory.inventoryPages.noItemsAreTrackedIn')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('inventory.inventoryPages.item')}</th>
                <th className="num">{t('inventory.inventoryPages.onHand')}</th>
                <th className="num">{t('inventory.inventoryPages.averageCost')}</th>
                <th className="num">{t('inventory.inventoryPages.value')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.data.items.map((i) => (
                <tr key={i.itemId}>
                  <td>
                    <Link to={`/inventory/items/${i.itemId}`}>{i.name}</Link>
                    {i.sku ? <small className="muted"> {i.sku}</small> : null}
                  </td>
                  <td className="num">{i.quantity}</td>
                  <td className="num">{formatAmount(i.averageCost, 'MVR')}</td>
                  <td className="num">{formatAmount(i.value, 'MVR')}</td>
                  <td>
                    {i.belowReorderPoint ? (
                      <span className="badge badge--pending">
                        {t('inventory.inventoryPages.reorder')}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {canManage ? (
        <Card title={t('inventory.inventoryPages.trackAnItemInStock')}>
          <form onSubmit={submit} className="form-grid">
            <div className="field">
              <label htmlFor="inv-item">{t('inventory.inventoryPages.product')}</label>
              <select
                id="inv-item"
                value={form.itemId}
                required
                onChange={(e) => setForm({ ...form, itemId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="inv-account">{t('inventory.inventoryPages.inventoryAccount')}</label>
              <select
                id="inv-account"
                value={form.inventoryAccountId}
                required
                onChange={(e) => setForm({ ...form, inventoryAccountId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {usable
                  .filter((a) => a.type === 'ASSET')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
              </select>
              {error?.fieldError('inventoryAccountId') ? (
                <small className="field__error" role="alert">
                  {error.fieldError('inventoryAccountId')}
                </small>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="inv-mode">{t('inventory.inventoryPages.tracking')}</label>
              <select
                id="inv-mode"
                value={form.trackingMode}
                onChange={(e) =>
                  setForm({
                    ...form,
                    trackingMode: e.target.value,
                    expiryTracked: e.target.value === 'none' ? false : form.expiryTracked,
                  })
                }
              >
                <option value="none">{t('inventory.inventoryPages.quantityOnly')}</option>
                <option value="lot">{t('inventory.inventoryPages.byLot')}</option>
                <option value="serial">{t('inventory.inventoryPages.bySerialNumber')}</option>
              </select>
            </div>
            {form.trackingMode !== 'none' ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.expiryTracked}
                  onChange={(e) => setForm({ ...form, expiryTracked: e.target.checked })}
                />{' '}
                {t('inventory.inventoryPages.hasAnExpiryDate')}
              </label>
            ) : null}
            <div className="field">
              <label htmlFor="inv-cogs">
                {t('inventory.inventoryPages.costOfGoodsSoldAccount')}
              </label>
              <select
                id="inv-cogs"
                value={form.cogsAccountId}
                required
                onChange={(e) => setForm({ ...form, cogsAccountId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {usable
                  .filter((a) => a.type === 'EXPENSE')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
              </select>
              {error?.fieldError('cogsAccountId') ? (
                <small className="field__error" role="alert">
                  {error.fieldError('cogsAccountId')}
                </small>
              ) : null}
            </div>
            <div>
              <Button type="submit" busy={track.isPending}>
                {t('inventory.inventoryPages.trackInStock')}
              </Button>
            </div>
          </form>
          {track.isError && !error?.issues.length ? <ErrorAlert error={track.error} /> : null}
        </Card>
      ) : null}
    </>
  );
}

export function StockItemPage() {
  const t = useT();
  const { itemId = '' } = useParams();
  const org = useOrgKey();
  const item = useQuery({
    queryKey: ['inventory-item', org, itemId],
    queryFn: () => api.get<TrackedItem>(`/inventory/items/${itemId}`),
  });
  const moves = useQuery({
    queryKey: ['inventory-movements', org, itemId],
    queryFn: () =>
      api.get<{ items: Movement[]; nextCursor: string | null }>(
        `/inventory/items/${itemId}/movements?limit=100`,
      ),
  });
  if (item.isPending) return <Spinner />;
  if (item.isError) return <ErrorAlert error={item.error} />;
  const i = item.data;
  return (
    <>
      <PageHeader
        title={i.name}
        description={t('inventory.inventoryPages.onHandAverageCostValue', {
          quantity: i.quantity,
          value: formatAmount(i.averageCost, 'MVR'),
          value2: formatAmount(i.value, 'MVR'),
        })}
      />
      <p>
        <Link to="/inventory">{t('inventory.inventoryPages.stock2')}</Link>
      </p>
      <ItemLotsCard itemId={itemId} trackingMode={i.trackingMode ?? 'none'} />
      <ItemUnitsCard itemId={itemId} />
      <Card title={t('inventory.inventoryPages.stockLedger')}>
        {moves.isPending ? (
          <Spinner />
        ) : moves.isError ? (
          <ErrorAlert error={moves.error} />
        ) : moves.data.items.length === 0 ? (
          <p className="muted">{t('inventory.inventoryPages.noMovementsYet')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('inventory.inventoryPages.date')}</th>
                <th>{t('inventory.inventoryPages.movement')}</th>
                <th className="num">{t('inventory.inventoryPages.quantity')}</th>
                <th className="num">{t('inventory.inventoryPages.value')}</th>
                <th className="num">{t('inventory.inventoryPages.onHandAfter')}</th>
                <th className="num">{t('inventory.inventoryPages.valueAfter')}</th>
              </tr>
            </thead>
            <tbody>
              {moves.data.items.map((m) => (
                <tr key={m.id}>
                  <td>{m.date}</td>
                  <td>
                    {KIND_LABEL[m.kind] ? t(KIND_LABEL[m.kind]!) : m.kind}
                    {m.journalId ? (
                      <small>
                        {' '}
                        <Link to={`/accounting/journals/${m.journalId}`}>
                          {t('inventory.inventoryPages.journal')}
                        </Link>
                      </small>
                    ) : null}
                  </td>
                  <td className="num">{m.quantity}</td>
                  <td className="num">{formatAmount(m.value, 'MVR')}</td>
                  <td className="num">{m.quantityAfter}</td>
                  <td className="num">{formatAmount(m.valueAfter, 'MVR')}</td>
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
// Adjustments
// ---------------------------------------------------------------------------

export function AdjustmentsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canCreate = usePermission(Permission.InventoryAdjustmentsCreate);
  const canVoid = usePermission(Permission.InventoryAdjustmentsVoid);
  const items = useQuery({
    queryKey: ['inventory-items', org],
    queryFn: () => api.get<{ items: TrackedItem[] }>('/inventory/items'),
  });
  const list = useQuery({
    queryKey: ['inventory-adjustments', org],
    queryFn: () => api.get<{ items: Adjustment[] }>('/inventory/adjustments?limit=100'),
  });
  const [form, setForm] = useState({
    adjustmentDate: today(),
    reason: '',
    itemId: '',
    quantityChange: '',
    unitCost: '',
  });
  const post = useApiMutation(() =>
    api.post<Adjustment>(
      '/inventory/adjustments',
      {
        adjustmentDate: form.adjustmentDate,
        reason: form.reason.trim(),
        lines: [
          {
            itemId: form.itemId,
            quantityChange: form.quantityChange.trim(),
            ...(form.unitCost.trim() ? { unitCost: form.unitCost.trim() } : {}),
          },
        ],
      },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const voidIt = useApiMutation((a: Adjustment) => {
    const reason = window.prompt(t('inventory.inventoryPages.whyIsThisAdjustmentVoided'));
    if (!reason?.trim()) return Promise.resolve(null);
    return sensitive(() =>
      api.post(`/inventory/adjustments/${a.id}/void`, {
        version: a.version,
        reason: reason.trim(),
      }),
    );
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['inventory-adjustments', org] });
    void queryClient.invalidateQueries({ queryKey: ['inventory-items', org] });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    post.mutate(undefined, {
      onSuccess: () => {
        setForm({ ...form, reason: '', quantityChange: '', unitCost: '' });
        refresh();
      },
    });
  };
  const nameOf = (id: string) => items.data?.items.find((i) => i.itemId === id)?.name ?? id;
  const error = post.error instanceof ApiError ? post.error : null;
  return (
    <>
      <PageHeader
        title={t('inventory.inventoryPages.stockAdjustments')}
        description={t('inventory.inventoryPages.correctTheQuantityOnHand')}
      />
      {canCreate ? (
        <Card title={t('inventory.inventoryPages.newAdjustment')}>
          <form onSubmit={submit} className="form-grid">
            <TextField
              label={t('inventory.inventoryPages.date')}
              type="date"
              value={form.adjustmentDate}
              required
              onChange={(e) => setForm({ ...form, adjustmentDate: e.target.value })}
              error={error?.fieldError('adjustmentDate')}
            />
            <TextField
              label={t('inventory.inventoryPages.reason')}
              value={form.reason}
              required
              maxLength={500}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              error={error?.fieldError('reason')}
            />
            <div className="field">
              <label htmlFor="adj-item">{t('inventory.inventoryPages.item')}</label>
              <select
                id="adj-item"
                value={form.itemId}
                required
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
              label={t('inventory.inventoryPages.quantityChangeNegativeToRemove')}
              value={form.quantityChange}
              required
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, quantityChange: e.target.value })}
              error={error?.fieldError('lines.0.quantityChange')}
            />
            <TextField
              label={t('inventory.inventoryPages.unitCostIncreases')}
              value={form.unitCost}
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, unitCost: e.target.value })}
              error={error?.fieldError('lines.0.unitCost')}
            />
            <div>
              <Button type="submit" busy={post.isPending}>
                {t('inventory.inventoryPages.postAdjustment')}
              </Button>
            </div>
          </form>
          {post.isError ? <ErrorAlert error={post.error} /> : null}
        </Card>
      ) : null}
      <Card title={t('inventory.inventoryPages.adjustments')}>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">{t('inventory.inventoryPages.noAdjustmentsYet')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('inventory.inventoryPages.number')}</th>
                <th>{t('inventory.inventoryPages.date')}</th>
                <th>{t('inventory.inventoryPages.reason')}</th>
                <th>{t('inventory.inventoryPages.lines')}</th>
                <th className="num">{t('inventory.inventoryPages.netValue')}</th>
                <th>{t('inventory.inventoryPages.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.journalId ? (
                      <Link to={`/accounting/journals/${a.journalId}`}>{a.number}</Link>
                    ) : (
                      a.number
                    )}
                  </td>
                  <td>{a.date}</td>
                  <td>{a.reason}</td>
                  <td>
                    {a.lines.map((l) => `${nameOf(l.itemId)} ${l.quantityChange}`).join(', ')}
                  </td>
                  <td className="num">{formatAmount(a.netValue, 'MVR')}</td>
                  <td>
                    <span
                      className={`badge badge--${a.status === 'POSTED' ? 'posted' : 'reversed'}`}
                    >
                      {a.status === 'POSTED'
                        ? t('inventory.inventoryPages.posted')
                        : t('inventory.inventoryPages.void')}
                    </span>
                  </td>
                  <td>
                    {canVoid && a.status === 'POSTED' ? (
                      <Button
                        variant="ghost"
                        busy={voidIt.isPending}
                        onClick={() => voidIt.mutate(a, { onSuccess: refresh })}
                      >
                        {t('inventory.inventoryPages.void')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {voidIt.isError ? <ErrorAlert error={voidIt.error} /> : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Customer returns
// ---------------------------------------------------------------------------

interface StockReturn {
  id: string;
  number: string;
  status: 'POSTED' | 'VOID';
  returnDate: string;
  creditNoteId: string;
  reason: string;
  totalValue: string;
  journalId: string | null;
  version: number;
  lines: { lineNo: number; itemId: string; quantity: string; unitCost: string; value: string }[];
}

interface Returnable {
  creditNoteId: string;
  number: string;
  items: { itemId: string; credited: string; returned: string; remaining: string }[];
}

export function ReturnsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canCreate = usePermission(Permission.InventoryAdjustmentsCreate);
  const canVoid = usePermission(Permission.InventoryAdjustmentsVoid);
  const items = useQuery({
    queryKey: ['inventory-items', org],
    queryFn: () => api.get<{ items: TrackedItem[] }>('/inventory/items'),
  });
  const list = useQuery({
    queryKey: ['inventory-returns', org],
    queryFn: () => api.get<{ items: StockReturn[] }>('/inventory/returns?limit=100'),
  });
  const notes = useQuery({
    queryKey: ['inventory-return-credit-notes', org],
    enabled: canCreate,
    queryFn: () =>
      api.get<{ items: { id: string; number: string; status: string }[] }>(
        '/sales/credit-notes?limit=100',
      ),
  });
  const [form, setForm] = useState({
    returnDate: today(),
    reason: '',
    creditNoteId: '',
    itemId: '',
    quantity: '',
  });
  const returnable = useQuery({
    queryKey: ['inventory-returnable', org, form.creditNoteId],
    enabled: Boolean(form.creditNoteId),
    queryFn: () => api.get<Returnable>(`/inventory/returns/returnable/${form.creditNoteId}`),
  });
  const post = useApiMutation(() =>
    api.post<StockReturn>(
      '/inventory/returns',
      {
        returnDate: form.returnDate,
        creditNoteId: form.creditNoteId,
        reason: form.reason.trim(),
        lines: [{ itemId: form.itemId, quantity: form.quantity.trim() }],
      },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const voidIt = useApiMutation((r: StockReturn) => {
    const reason = window.prompt(t('inventory.inventoryPages.whyIsThisReturnVoided'));
    if (!reason?.trim()) return Promise.resolve(null);
    return sensitive(() =>
      api.post(`/inventory/returns/${r.id}/void`, { version: r.version, reason: reason.trim() }),
    );
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['inventory-returns', org] });
    void queryClient.invalidateQueries({ queryKey: ['inventory-returnable', org] });
    void queryClient.invalidateQueries({ queryKey: ['inventory-items', org] });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    post.mutate(undefined, {
      onSuccess: () => {
        setForm({ ...form, reason: '', itemId: '', quantity: '' });
        refresh();
      },
    });
  };
  const nameOf = (id: string) => items.data?.items.find((i) => i.itemId === id)?.name ?? id;
  const error = post.error instanceof ApiError ? post.error : null;
  return (
    <>
      <PageHeader
        title={t('inventory.inventoryPages.customerReturns')}
        description={t('inventory.inventoryPages.putGoodsThatCameBack')}
      />
      {canCreate ? (
        <Card title={t('inventory.inventoryPages.newReturn')}>
          <form onSubmit={submit} className="form-grid">
            <TextField
              label={t('inventory.inventoryPages.date')}
              type="date"
              value={form.returnDate}
              required
              onChange={(e) => setForm({ ...form, returnDate: e.target.value })}
              error={error?.fieldError('returnDate')}
            />
            <div className="field">
              <label htmlFor="ret-note">{t('inventory.inventoryPages.creditNote')}</label>
              <select
                id="ret-note"
                value={form.creditNoteId}
                required
                onChange={(e) => setForm({ ...form, creditNoteId: e.target.value, itemId: '' })}
              >
                <option value="">{t('common.choose')}</option>
                {(notes.data?.items ?? [])
                  .filter((n) => n.status === 'ISSUED')
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.number}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ret-item">{t('inventory.inventoryPages.item')}</label>
              <select
                id="ret-item"
                value={form.itemId}
                required
                onChange={(e) => setForm({ ...form, itemId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {(returnable.data?.items ?? []).map((i) => (
                  <option key={i.itemId} value={i.itemId}>
                    {t('inventory.inventoryPages.upTo', {
                      value: nameOf(i.itemId),
                      remaining: i.remaining,
                    })}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label={t('inventory.inventoryPages.quantityReturned')}
              value={form.quantity}
              required
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              error={error?.fieldError('lines.0.quantity')}
            />
            <TextField
              label={t('inventory.inventoryPages.reason')}
              value={form.reason}
              required
              maxLength={500}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              error={error?.fieldError('reason')}
            />
            <div>
              <Button type="submit" busy={post.isPending}>
                {t('inventory.inventoryPages.postReturn')}
              </Button>
            </div>
          </form>
          {post.isError ? <ErrorAlert error={post.error} /> : null}
        </Card>
      ) : null}
      <Card title={t('inventory.inventoryPages.returns')}>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">{t('inventory.inventoryPages.noReturnsYet')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('inventory.inventoryPages.number')}</th>
                <th>{t('inventory.inventoryPages.date')}</th>
                <th>{t('inventory.inventoryPages.reason')}</th>
                <th>{t('inventory.inventoryPages.lines')}</th>
                <th className="num">{t('inventory.inventoryPages.value')}</th>
                <th>{t('inventory.inventoryPages.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.journalId ? (
                      <Link to={`/accounting/journals/${r.journalId}`}>{r.number}</Link>
                    ) : (
                      r.number
                    )}
                  </td>
                  <td>{r.returnDate}</td>
                  <td>{r.reason}</td>
                  <td>{r.lines.map((l) => `${nameOf(l.itemId)} ${l.quantity}`).join(', ')}</td>
                  <td className="num">{formatAmount(r.totalValue, 'MVR')}</td>
                  <td>
                    <span
                      className={`badge badge--${r.status === 'POSTED' ? 'posted' : 'reversed'}`}
                    >
                      {r.status === 'POSTED'
                        ? t('inventory.inventoryPages.posted')
                        : t('inventory.inventoryPages.void')}
                    </span>
                  </td>
                  <td>
                    {canVoid && r.status === 'POSTED' ? (
                      <Button
                        variant="ghost"
                        busy={voidIt.isPending}
                        onClick={() => voidIt.mutate(r, { onSuccess: refresh })}
                      >
                        {t('inventory.inventoryPages.void')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {voidIt.isError ? <ErrorAlert error={voidIt.error} /> : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Valuation and settings
// ---------------------------------------------------------------------------

export function ValuationPage() {
  const t = useT();
  const org = useOrgKey();
  const accounts = useAccounts(usePermission(Permission.AccountsView));
  const valuation = useQuery({
    queryKey: ['inventory-valuation', org],
    queryFn: () => api.get<Valuation>('/inventory/valuation'),
  });
  if (valuation.isPending) return <Spinner />;
  if (valuation.isError) return <ErrorAlert error={valuation.error} />;
  const v = valuation.data;
  const name = (id: string) => {
    const a = accounts.data?.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : id;
  };
  return (
    <>
      <PageHeader
        title={t('inventory.inventoryPages.inventoryValuation')}
        description={t('inventory.inventoryPages.theValueOfTheStock')}
      />
      <Card title={t('inventory.inventoryPages.byItem')}>
        <table className="table">
          <thead>
            <tr>
              <th>{t('inventory.inventoryPages.item')}</th>
              <th className="num">{t('inventory.inventoryPages.onHand')}</th>
              <th className="num">{t('inventory.inventoryPages.averageCost')}</th>
              <th className="num">{t('inventory.inventoryPages.value')}</th>
            </tr>
          </thead>
          <tbody>
            {v.items.map((i) => (
              <tr key={i.itemId}>
                <td>{i.name}</td>
                <td className="num">{i.quantity}</td>
                <td className="num">{formatAmount(i.averageCost, 'MVR')}</td>
                <td className="num">{formatAmount(i.value, 'MVR')}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={3}>{t('inventory.inventoryPages.total')}</th>
              <th className="num">{formatAmount(v.totalValue, 'MVR')}</th>
            </tr>
          </tfoot>
        </table>
      </Card>
      <Card title={t('inventory.inventoryPages.againstTheGeneralLedger')}>
        <table className="table">
          <thead>
            <tr>
              <th>{t('inventory.inventoryPages.inventoryAccount')}</th>
              <th className="num">{t('inventory.inventoryPages.stockValue')}</th>
              <th className="num">{t('inventory.inventoryPages.ledgerBalance')}</th>
              <th className="num">{t('inventory.inventoryPages.difference')}</th>
            </tr>
          </thead>
          <tbody>
            {v.accounts.map((a) => (
              <tr key={a.accountId}>
                <td>{name(a.accountId)}</td>
                <td className="num">{formatAmount(a.stockValue, 'MVR')}</td>
                <td className="num">{formatAmount(a.glBalance, 'MVR')}</td>
                <td className="num">{formatAmount(a.difference, 'MVR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {v.accounts.some((a) => Number(a.difference) !== 0) ? (
          <Alert tone="info">{t('inventory.inventoryPages.aDifferenceMeansSomethingOther')}</Alert>
        ) : null}
      </Card>
    </>
  );
}

export function InventorySettingsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canManage = usePermission(Permission.InventorySettingsManage);
  const accounts = useAccounts(usePermission(Permission.AccountsView));
  const settings = useQuery({
    queryKey: ['inventory-settings', org],
    queryFn: () => api.get<Settings>('/inventory/settings'),
  });
  const [policy, setPolicy] = useState<'block' | 'allow' | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const save = useApiMutation((s: Settings) =>
    sensitive(() =>
      api.put<Settings>('/inventory/settings', {
        version: s.version,
        negativeStockPolicy: policy ?? s.negativeStockPolicy,
        adjustmentAccountId: account === null ? s.adjustmentAccountId : account || null,
      }),
    ),
  );
  if (settings.isPending) return <Spinner />;
  if (settings.isError) return <ErrorAlert error={settings.error} />;
  const s = settings.data;
  const options = (accounts.data ?? []).filter(
    (a) => a.status === 'ACTIVE' && a.isLeaf && !a.isControlAccount && a.type === 'EXPENSE',
  );
  return (
    <>
      <PageHeader title={t('inventory.inventoryPages.inventorySettings')} />
      <Card>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(s, {
              onSuccess: () => {
                setPolicy(null);
                setAccount(null);
                void queryClient.invalidateQueries({ queryKey: ['inventory-settings', org] });
              },
            });
          }}
        >
          <div className="field">
            <label htmlFor="inv-policy">{t('inventory.inventoryPages.negativeStock')}</label>
            <select
              id="inv-policy"
              value={policy ?? s.negativeStockPolicy}
              disabled={!canManage}
              onChange={(e) => setPolicy(e.target.value as 'block' | 'allow')}
            >
              <option value="block">
                {t('inventory.inventoryPages.blockInvoicesThatWouldTake')}
              </option>
              <option value="allow">{t('inventory.inventoryPages.allowNegativeStock')}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="inv-offset">
              {t('inventory.inventoryPages.stockDifferencesAccount')}
            </label>
            <select
              id="inv-offset"
              value={account ?? s.adjustmentAccountId ?? ''}
              disabled={!canManage}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">{t('common.none')}</option>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
          </div>
          {canManage ? (
            <div>
              <Button type="submit" busy={save.isPending}>
                {t('inventory.inventoryPages.saveSettings')}
              </Button>
            </div>
          ) : null}
        </form>
        {save.isError ? <ErrorAlert error={save.error} /> : null}
      </Card>
    </>
  );
}
