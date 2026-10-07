import { useQuery, useQueryClient } from '@tanstack/react-query';
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

const KIND_LABEL: Record<string, string> = {
  purchase: 'Bought (bill)',
  purchase_void: 'Bill voided',
  sale: 'Sold (invoice)',
  sale_void: 'Invoice voided',
  adjustment: 'Adjustment',
  adjustment_void: 'Adjustment voided',
};

const today = () => new Date().toISOString().slice(0, 10);

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

export function InventorySection() {
  return (
    <>
      <nav className="subnav" aria-label="Inventory">
        <NavLink to="/inventory" end>
          Stock
        </NavLink>
        <Can permission={Permission.InventoryView}>
          <NavLink to="/inventory/adjustments">Adjustments</NavLink>
          <NavLink to="/inventory/valuation">Valuation</NavLink>
          <NavLink to="/inventory/settings">Settings</NavLink>
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
  const [form, setForm] = useState({ itemId: '', inventoryAccountId: '', cogsAccountId: '' });
  const tracked = new Set((items.data?.items ?? []).map((i) => i.itemId));
  const products = (catalog.data?.items ?? []).filter(
    (i) => i.itemType === 'product' && !tracked.has(i.id),
  );
  const track = useApiMutation(() =>
    api.post(`/inventory/items/${form.itemId}`, {
      inventoryAccountId: form.inventoryAccountId,
      cogsAccountId: form.cogsAccountId,
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    track.mutate(undefined, {
      onSuccess: () => {
        setForm({ itemId: '', inventoryAccountId: '', cogsAccountId: '' });
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
        title="Stock"
        description="Items tracked in stock at weighted-average cost. Stock comes in on bills and goes out on invoices."
      />
      <Card title="Tracked items">
        {items.isPending ? (
          <Spinner />
        ) : items.isError ? (
          <ErrorAlert error={items.error} />
        ) : items.data.items.length === 0 ? (
          <p className="muted">No items are tracked in stock yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">On hand</th>
                <th className="num">Average cost</th>
                <th className="num">Value</th>
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
                      <span className="badge badge--pending">Reorder</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {canManage ? (
        <Card title="Track an item in stock">
          <form onSubmit={submit} className="form-grid">
            <div className="field">
              <label htmlFor="inv-item">Product</label>
              <select
                id="inv-item"
                value={form.itemId}
                required
                onChange={(e) => setForm({ ...form, itemId: e.target.value })}
              >
                <option value="">Choose…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="inv-account">Inventory account</label>
              <select
                id="inv-account"
                value={form.inventoryAccountId}
                required
                onChange={(e) => setForm({ ...form, inventoryAccountId: e.target.value })}
              >
                <option value="">Choose…</option>
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
              <label htmlFor="inv-cogs">Cost of goods sold account</label>
              <select
                id="inv-cogs"
                value={form.cogsAccountId}
                required
                onChange={(e) => setForm({ ...form, cogsAccountId: e.target.value })}
              >
                <option value="">Choose…</option>
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
                Track in stock
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
        description={`${i.quantity} on hand · average cost ${formatAmount(i.averageCost, 'MVR')} · value ${formatAmount(i.value, 'MVR')}`}
      />
      <p>
        <Link to="/inventory">← Stock</Link>
      </p>
      <Card title="Stock ledger">
        {moves.isPending ? (
          <Spinner />
        ) : moves.isError ? (
          <ErrorAlert error={moves.error} />
        ) : moves.data.items.length === 0 ? (
          <p className="muted">No movements yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Movement</th>
                <th className="num">Quantity</th>
                <th className="num">Value</th>
                <th className="num">On hand after</th>
                <th className="num">Value after</th>
              </tr>
            </thead>
            <tbody>
              {moves.data.items.map((m) => (
                <tr key={m.id}>
                  <td>{m.date}</td>
                  <td>
                    {KIND_LABEL[m.kind] ?? m.kind}
                    {m.journalId ? (
                      <small>
                        {' '}
                        <Link to={`/accounting/journals/${m.journalId}`}>journal</Link>
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
    const reason = window.prompt('Why is this adjustment voided?');
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
        title="Stock adjustments"
        description="Correct the quantity on hand after a count, breakage or an opening count. An increase needs a unit cost when there is no stock; a decrease is costed at the average."
      />
      {canCreate ? (
        <Card title="New adjustment">
          <form onSubmit={submit} className="form-grid">
            <TextField
              label="Date"
              type="date"
              value={form.adjustmentDate}
              required
              onChange={(e) => setForm({ ...form, adjustmentDate: e.target.value })}
              error={error?.fieldError('adjustmentDate')}
            />
            <TextField
              label="Reason"
              value={form.reason}
              required
              maxLength={500}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              error={error?.fieldError('reason')}
            />
            <div className="field">
              <label htmlFor="adj-item">Item</label>
              <select
                id="adj-item"
                value={form.itemId}
                required
                onChange={(e) => setForm({ ...form, itemId: e.target.value })}
              >
                <option value="">Choose…</option>
                {(items.data?.items ?? []).map((i) => (
                  <option key={i.itemId} value={i.itemId}>
                    {i.name}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label="Quantity change (negative to remove)"
              value={form.quantityChange}
              required
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, quantityChange: e.target.value })}
              error={error?.fieldError('lines.0.quantityChange')}
            />
            <TextField
              label="Unit cost (increases)"
              value={form.unitCost}
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, unitCost: e.target.value })}
              error={error?.fieldError('lines.0.unitCost')}
            />
            <div>
              <Button type="submit" busy={post.isPending}>
                Post adjustment
              </Button>
            </div>
          </form>
          {post.isError ? <ErrorAlert error={post.error} /> : null}
        </Card>
      ) : null}
      <Card title="Adjustments">
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">No adjustments yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Reason</th>
                <th>Lines</th>
                <th className="num">Net value</th>
                <th>Status</th>
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
                      {a.status === 'POSTED' ? 'Posted' : 'Void'}
                    </span>
                  </td>
                  <td>
                    {canVoid && a.status === 'POSTED' ? (
                      <Button
                        variant="ghost"
                        busy={voidIt.isPending}
                        onClick={() => voidIt.mutate(a, { onSuccess: refresh })}
                      >
                        Void
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
        title="Inventory valuation"
        description="The value of the stock on hand, and how it compares with the inventory accounts of the general ledger."
      />
      <Card title="By item">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">On hand</th>
              <th className="num">Average cost</th>
              <th className="num">Value</th>
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
              <th colSpan={3}>Total</th>
              <th className="num">{formatAmount(v.totalValue, 'MVR')}</th>
            </tr>
          </tfoot>
        </table>
      </Card>
      <Card title="Against the general ledger">
        <table className="table">
          <thead>
            <tr>
              <th>Inventory account</th>
              <th className="num">Stock value</th>
              <th className="num">Ledger balance</th>
              <th className="num">Difference</th>
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
          <Alert tone="info">
            A difference means something other than a bill, an invoice or a stock adjustment posted
            to an inventory account, such as a manual journal.
          </Alert>
        ) : null}
      </Card>
    </>
  );
}

export function InventorySettingsPage() {
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
      <PageHeader title="Inventory settings" />
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
            <label htmlFor="inv-policy">Negative stock</label>
            <select
              id="inv-policy"
              value={policy ?? s.negativeStockPolicy}
              disabled={!canManage}
              onChange={(e) => setPolicy(e.target.value as 'block' | 'allow')}
            >
              <option value="block">Block invoices that would take stock below zero</option>
              <option value="allow">Allow negative stock</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="inv-offset">Stock differences account</label>
            <select
              id="inv-offset"
              value={account ?? s.adjustmentAccountId ?? ''}
              disabled={!canManage}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">None</option>
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
                Save settings
              </Button>
            </div>
          ) : null}
        </form>
        {save.isError ? <ErrorAlert error={save.error} /> : null}
      </Card>
    </>
  );
}
