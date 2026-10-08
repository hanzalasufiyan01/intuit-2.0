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
 * Fixed assets: the register, categories, depreciation runs, disposal and transfers. The server
 * computes depreciation and every posting; these pages only guide.
 */

export const ASSET_VIEW_PERMISSIONS = [Permission.FixedAssetsView] as const;

interface Asset {
  id: string;
  number: string;
  name: string;
  description: string;
  categoryId: string;
  categoryName: string | null;
  acquisitionDate: string;
  inServiceDate: string;
  cost: string;
  salvageValue: string;
  lifeMonths: number;
  accumulatedDepreciation: string;
  bookValue: string;
  status: 'ACTIVE' | 'DISPOSED';
  location: string;
  custodian: string;
  serialNumber: string;
  version: number;
}

interface AssetDetail extends Asset {
  schedule: {
    monthEnd: string;
    amount: string;
    accumulated: string;
    bookValue: string;
    booked: boolean;
  }[];
  disposals: {
    id: string;
    date: string;
    proceeds: string;
    gainLoss: string;
    status: string;
    version: number;
  }[];
}

interface Category {
  id: string;
  name: string;
  costAccountId: string;
  accumulatedAccountId: string;
  expenseAccountId: string;
  defaultLifeMonths: number;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
}

interface Run {
  id: string;
  number: string;
  monthEnd: string;
  status: 'POSTED' | 'VOID';
  total: string;
  assetCount: number;
  version: number;
}

interface Preview {
  monthEnd: string;
  latestRunMonthEnd: string | null;
  canRun: boolean;
  total: string;
  lines: {
    assetId: string;
    number: string;
    name: string;
    categoryName: string;
    amount: string;
    bookValueAfter: string;
  }[];
}

const today = () => new Date().toISOString().slice(0, 10);
const lastDayOfThisMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

export function AssetsSection() {
  return (
    <>
      <nav className="subnav" aria-label="Fixed assets">
        <NavLink to="/assets" end>
          Register
        </NavLink>
        <Can permission={Permission.FixedAssetsView}>
          <NavLink to="/assets/depreciation">Depreciation</NavLink>
          <NavLink to="/assets/categories">Categories</NavLink>
          <NavLink to="/assets/reports">Reports</NavLink>
        </Can>
      </nav>
      <Outlet />
    </>
  );
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export function AssetsPage() {
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.FixedAssetsManage);
  const canSeeAccounts = usePermission(Permission.AccountsView);
  const canBills = usePermission(Permission.BillsView);
  const accounts = useAccounts(canManage && canSeeAccounts);
  const [status, setStatus] = useState('');
  const list = useQuery({
    queryKey: ['assets', org, status],
    queryFn: () =>
      api.get<{ items: Asset[]; nextCursor: string | null }>(
        `/fixed-assets/assets?limit=200${status ? `&status=${status}` : ''}`,
      ),
  });
  const categories = useQuery({
    queryKey: ['asset-categories', org],
    queryFn: () => api.get<{ items: Category[] }>('/fixed-assets/categories'),
  });
  const [form, setForm] = useState({
    name: '',
    categoryId: '',
    acquisitionDate: today(),
    cost: '',
    salvageValue: '',
    lifeMonths: '',
    creditAccountId: '',
    sourceBillId: '',
    duplicateOverrideReason: '',
  });
  const bills = useQuery({
    queryKey: ['asset-source-bills', org],
    queryFn: () =>
      api.get<{
        items: { id: string; number: string | null; vendorName: string | null; total: string }[];
      }>('/purchases/bills?status=POSTED&limit=100'),
    enabled: canBills,
  });
  const create = useApiMutation(() =>
    api.post<Asset>(
      '/fixed-assets/assets',
      {
        name: form.name.trim(),
        categoryId: form.categoryId,
        acquisitionDate: form.acquisitionDate,
        cost: form.cost.trim(),
        ...(form.salvageValue.trim() ? { salvageValue: form.salvageValue.trim() } : {}),
        ...(form.lifeMonths.trim() ? { lifeMonths: Number(form.lifeMonths) } : {}),
        // A bill-capitalized asset is registered as already in the ledger (nothing is posted).
        ...(form.sourceBillId
          ? { alreadyInLedger: true, sourceBillId: form.sourceBillId }
          : { creditAccountId: form.creditAccountId }),
        ...(form.duplicateOverrideReason.trim()
          ? { duplicateOverrideReason: form.duplicateOverrideReason.trim() }
          : {}),
      },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: () => {
        setForm({ ...form, name: '', cost: '', salvageValue: '', lifeMonths: '' });
        void queryClient.invalidateQueries({ queryKey: ['assets', org] });
      },
    });
  };
  const funding = (accounts.data ?? []).filter(
    (a) => a.status === 'ACTIVE' && a.isLeaf && !a.isControlAccount,
  );
  const error = create.error instanceof ApiError ? create.error : null;
  return (
    <>
      <PageHeader
        title="Fixed assets"
        description="The register of what the business owns, its cost, accumulated depreciation and book value."
      />
      <Card>
        <div className="field">
          <label htmlFor="asset-status">Show</label>
          <select id="asset-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="ACTIVE">In use</option>
            <option value="DISPOSED">Disposed of</option>
          </select>
        </div>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">No fixed assets yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Name</th>
                <th>Category</th>
                <th className="num">Cost</th>
                <th className="num">Accumulated</th>
                <th className="num">Book value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/assets/${a.id}`}>{a.number}</Link>
                  </td>
                  <td>{a.name}</td>
                  <td>{a.categoryName}</td>
                  <td className="num">{formatAmount(a.cost, 'MVR')}</td>
                  <td className="num">{formatAmount(a.accumulatedDepreciation, 'MVR')}</td>
                  <td className="num">{formatAmount(a.bookValue, 'MVR')}</td>
                  <td>
                    <span
                      className={`badge badge--${a.status === 'ACTIVE' ? 'posted' : 'reversed'}`}
                    >
                      {a.status === 'ACTIVE' ? 'In use' : 'Disposed'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {canManage ? (
        <Card title="Register an asset">
          <form onSubmit={submit} className="form-grid">
            <TextField
              label="Name"
              value={form.name}
              required
              maxLength={200}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              error={error?.fieldError('name')}
            />
            <div className="field">
              <label htmlFor="asset-category">Category</label>
              <select
                id="asset-category"
                value={form.categoryId}
                required
                onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              >
                <option value="">Choose…</option>
                {(categories.data?.items ?? [])
                  .filter((c) => c.status === 'ACTIVE')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
            <TextField
              label="Acquired on"
              type="date"
              value={form.acquisitionDate}
              required
              onChange={(e) => setForm({ ...form, acquisitionDate: e.target.value })}
              error={error?.fieldError('acquisitionDate')}
            />
            <TextField
              label="Cost"
              value={form.cost}
              required
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, cost: e.target.value })}
              error={error?.fieldError('cost')}
            />
            <TextField
              label="Salvage value"
              value={form.salvageValue}
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, salvageValue: e.target.value })}
              error={error?.fieldError('salvageValue')}
            />
            <TextField
              label="Life in months"
              value={form.lifeMonths}
              inputMode="numeric"
              onChange={(e) => setForm({ ...form, lifeMonths: e.target.value })}
              hint="Defaults to the category."
            />
            <div className="field">
              <label htmlFor="asset-credit">Paid from</label>
              <select
                id="asset-credit"
                value={form.creditAccountId}
                required={!form.sourceBillId}
                disabled={Boolean(form.sourceBillId)}
                onChange={(e) => setForm({ ...form, creditAccountId: e.target.value })}
              >
                <option value="">Choose…</option>
                {funding.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
              {error?.fieldError('creditAccountId') ? (
                <small className="field__error" role="alert">
                  {error.fieldError('creditAccountId')}
                </small>
              ) : null}
            </div>
            {canBills ? (
              <div className="field">
                <label htmlFor="asset-bill">Capitalized by a bill</label>
                <select
                  id="asset-bill"
                  value={form.sourceBillId}
                  onChange={(e) => setForm({ ...form, sourceBillId: e.target.value })}
                >
                  <option value="">No bill: post the acquisition</option>
                  {(bills.data?.items ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.number} · {b.vendorName} · {b.total}
                    </option>
                  ))}
                </select>
                <small className="field__hint">
                  Choose the bill that already debited the asset account so the cost is not posted
                  twice.
                </small>
                {error?.fieldError('sourceBillId') ? (
                  <small className="field__error" role="alert">
                    {error.fieldError('sourceBillId')}
                  </small>
                ) : null}
              </div>
            ) : null}
            {error?.code === 'DUPLICATE_CAPITALIZATION' && !form.sourceBillId ? (
              <TextField
                label="Different purchase? Say why"
                value={form.duplicateOverrideReason}
                hint="A matching bill exists. Only confirm if this is a separate purchase."
                onChange={(e) => setForm({ ...form, duplicateOverrideReason: e.target.value })}
              />
            ) : null}
            <div>
              <Button type="submit" busy={create.isPending}>
                Register asset
              </Button>
            </div>
          </form>
          {create.isError && !error?.issues.length ? <ErrorAlert error={create.error} /> : null}
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// One asset
// ---------------------------------------------------------------------------

export function AssetPage() {
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canDispose = usePermission(Permission.FixedAssetsDispose);
  const canVoid = usePermission(Permission.FixedAssetsVoid);
  const canSeeAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canDispose && canSeeAccounts);
  const asset = useQuery({
    queryKey: ['asset', org, id],
    queryFn: () => api.get<AssetDetail>(`/fixed-assets/assets/${id}`),
  });
  const [disposing, setDisposing] = useState(false);
  const [disposal, setDisposal] = useState({
    disposalDate: today(),
    proceeds: '',
    proceedsAccountId: '',
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['asset', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['assets', org] });
  };
  const dispose = useApiMutation((a: Asset) =>
    api.post(
      `/fixed-assets/assets/${id}/dispose`,
      {
        version: a.version,
        disposalDate: disposal.disposalDate,
        ...(disposal.proceeds.trim() ? { proceeds: disposal.proceeds.trim() } : {}),
        ...(disposal.proceedsAccountId ? { proceedsAccountId: disposal.proceedsAccountId } : {}),
      },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const voidDisposal = useApiMutation((d: { id: string; version: number }) => {
    const reason = window.prompt('Why is this disposal voided?');
    if (!reason?.trim()) return Promise.resolve(null);
    return sensitive(() =>
      api.post(`/fixed-assets/disposals/${d.id}/void`, {
        version: d.version,
        reason: reason.trim(),
      }),
    );
  });
  if (asset.isPending) return <Spinner />;
  if (asset.isError) return <ErrorAlert error={asset.error} />;
  const a = asset.data;
  const active = a.disposals.find((d) => d.status === 'POSTED');
  return (
    <>
      <PageHeader
        title={`${a.number} — ${a.name}`}
        description={`${a.categoryName ?? ''} · cost ${formatAmount(a.cost, 'MVR')} · book value ${formatAmount(a.bookValue, 'MVR')} · ${a.lifeMonths} months`}
      />
      <p>
        <Link to="/assets">← Register</Link>{' '}
        <span className={`badge badge--${a.status === 'ACTIVE' ? 'posted' : 'reversed'}`}>
          {a.status === 'ACTIVE' ? 'In use' : 'Disposed'}
        </span>
      </p>
      {canDispose && a.status === 'ACTIVE' ? (
        <Card title="Dispose of this asset">
          {disposing ? (
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                dispose.mutate(a, {
                  onSuccess: () => {
                    setDisposing(false);
                    refresh();
                  },
                });
              }}
            >
              <TextField
                label="Disposal date"
                type="date"
                value={disposal.disposalDate}
                required
                onChange={(e) => setDisposal({ ...disposal, disposalDate: e.target.value })}
              />
              <TextField
                label="Proceeds"
                value={disposal.proceeds}
                inputMode="decimal"
                onChange={(e) => setDisposal({ ...disposal, proceeds: e.target.value })}
                hint="Leave empty for a write-off."
              />
              <div className="field">
                <label htmlFor="disposal-account">Proceeds go to</label>
                <select
                  id="disposal-account"
                  value={disposal.proceedsAccountId}
                  onChange={(e) => setDisposal({ ...disposal, proceedsAccountId: e.target.value })}
                >
                  <option value="">None</option>
                  {(accounts.data ?? [])
                    .filter((x) => x.status === 'ACTIVE' && x.isLeaf && !x.isControlAccount)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.code} {x.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <Button type="submit" busy={dispose.isPending}>
                  Post disposal
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="secondary" onClick={() => setDisposing(true)}>
              Dispose…
            </Button>
          )}
          {dispose.isError ? <ErrorAlert error={dispose.error} /> : null}
        </Card>
      ) : null}
      {active ? (
        <Alert tone="info">
          Disposed of on {active.date}: proceeds {formatAmount(active.proceeds, 'MVR')}, gain or
          loss {formatAmount(active.gainLoss, 'MVR')}.{' '}
          {canVoid ? (
            <Button
              variant="ghost"
              onClick={() => voidDisposal.mutate(active, { onSuccess: refresh })}
            >
              Void the disposal
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {voidDisposal.isError ? <ErrorAlert error={voidDisposal.error} /> : null}
      <Card title="Depreciation schedule">
        <table className="table">
          <thead>
            <tr>
              <th>Month end</th>
              <th className="num">Depreciation</th>
              <th className="num">Accumulated</th>
              <th className="num">Book value</th>
              <th>Booked</th>
            </tr>
          </thead>
          <tbody>
            {a.schedule.map((row) => (
              <tr key={row.monthEnd}>
                <td>{row.monthEnd}</td>
                <td className="num">{formatAmount(row.amount, 'MVR')}</td>
                <td className="num">{formatAmount(row.accumulated, 'MVR')}</td>
                <td className="num">{formatAmount(row.bookValue, 'MVR')}</td>
                <td>{row.booked ? 'Yes' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Depreciation runs
// ---------------------------------------------------------------------------

export function DepreciationPage() {
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canRun = usePermission(Permission.FixedAssetsDepreciate);
  const canVoid = usePermission(Permission.FixedAssetsVoid);
  const [monthEnd, setMonthEnd] = useState(lastDayOfThisMonth());
  const runs = useQuery({
    queryKey: ['asset-runs', org],
    queryFn: () => api.get<{ items: Run[] }>('/fixed-assets/depreciation/runs?limit=100'),
  });
  const preview = useApiMutation(() =>
    api.get<Preview>(`/fixed-assets/depreciation/preview?monthEnd=${monthEnd}`),
  );
  const run = useApiMutation(() =>
    api.post<Run>(
      '/fixed-assets/depreciation/runs',
      { monthEnd },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const voidRun = useApiMutation((r: Run) => {
    const reason = window.prompt('Why is this run voided?');
    if (!reason?.trim()) return Promise.resolve(null);
    return sensitive(() =>
      api.post(`/fixed-assets/depreciation/runs/${r.id}/void`, {
        version: r.version,
        reason: reason.trim(),
      }),
    );
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['asset-runs', org] });
    void queryClient.invalidateQueries({ queryKey: ['assets', org] });
    preview.reset();
  };
  const p = preview.data;
  const latestId = runs.data?.items.find((r) => r.status === 'POSTED')?.id;
  return (
    <>
      <PageHeader
        title="Depreciation"
        description="Book the depreciation owing up to a month end. Months not yet run are caught up in one run."
      />
      <Card title="Run depreciation">
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            preview.mutate();
          }}
        >
          <TextField
            label="Month end"
            type="date"
            value={monthEnd}
            required
            onChange={(e) => setMonthEnd(e.target.value)}
          />
          <div>
            <Button type="submit" busy={preview.isPending}>
              Preview
            </Button>
          </div>
        </form>
        {preview.isError ? <ErrorAlert error={preview.error} /> : null}
        {p ? (
          <>
            {p.lines.length === 0 ? (
              <p className="muted">Nothing is owing up to {p.monthEnd}.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Category</th>
                    <th className="num">Depreciation</th>
                    <th className="num">Book value after</th>
                  </tr>
                </thead>
                <tbody>
                  {p.lines.map((l) => (
                    <tr key={l.assetId}>
                      <td>
                        {l.number} {l.name}
                      </td>
                      <td>{l.categoryName}</td>
                      <td className="num">{formatAmount(l.amount, 'MVR')}</td>
                      <td className="num">{formatAmount(l.bookValueAfter, 'MVR')}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={2}>Total</th>
                    <th className="num">{formatAmount(p.total, 'MVR')}</th>
                    <th />
                  </tr>
                </tfoot>
              </table>
            )}
            {!p.canRun ? (
              <Alert tone="info">
                Depreciation has already run through {p.latestRunMonthEnd}. Run a later month, or
                void the later runs first.
              </Alert>
            ) : null}
            {canRun ? (
              <Button
                busy={run.isPending}
                disabled={!p.canRun || p.lines.length === 0}
                onClick={() => run.mutate(undefined, { onSuccess: refresh })}
              >
                Post depreciation
              </Button>
            ) : null}
            {run.isError ? <ErrorAlert error={run.error} /> : null}
          </>
        ) : null}
      </Card>
      <Card title="Runs">
        {runs.isPending ? (
          <Spinner />
        ) : runs.data?.items.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Month end</th>
                <th className="num">Total</th>
                <th className="num">Assets</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.number}</td>
                  <td>{r.monthEnd}</td>
                  <td className="num">{formatAmount(r.total, 'MVR')}</td>
                  <td className="num">{r.assetCount}</td>
                  <td>{r.status === 'POSTED' ? 'Posted' : 'Void'}</td>
                  <td>
                    {canVoid && r.id === latestId ? (
                      <Button
                        variant="ghost"
                        onClick={() => voidRun.mutate(r, { onSuccess: refresh })}
                      >
                        Void
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No depreciation has run yet.</p>
        )}
        {voidRun.isError ? <ErrorAlert error={voidRun.error} /> : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Categories and settings
// ---------------------------------------------------------------------------

export function AssetCategoriesPage() {
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.FixedAssetsManage);
  const accounts = useAccounts(usePermission(Permission.AccountsView));
  const categories = useQuery({
    queryKey: ['asset-categories', org],
    queryFn: () => api.get<{ items: Category[] }>('/fixed-assets/categories'),
  });
  const [form, setForm] = useState({
    name: '',
    costAccountId: '',
    accumulatedAccountId: '',
    expenseAccountId: '',
    defaultLifeMonths: '60',
  });
  const create = useApiMutation(() =>
    api.post<Category>('/fixed-assets/categories', {
      name: form.name.trim(),
      costAccountId: form.costAccountId,
      accumulatedAccountId: form.accumulatedAccountId,
      expenseAccountId: form.expenseAccountId,
      defaultLifeMonths: Number(form.defaultLifeMonths),
    }),
  );
  const nameOf = (id: string) => {
    const a = accounts.data?.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : id;
  };
  const usable = (type: 'ASSET' | 'EXPENSE') =>
    (accounts.data ?? []).filter(
      (a) => a.status === 'ACTIVE' && a.isLeaf && !a.isControlAccount && a.type === type,
    );
  const select = (
    label: string,
    key: 'costAccountId' | 'accumulatedAccountId' | 'expenseAccountId',
    type: 'ASSET' | 'EXPENSE',
  ) => (
    <div className="field" key={key}>
      <label htmlFor={`cat-${key}`}>{label}</label>
      <select
        id={`cat-${key}`}
        value={form[key]}
        required
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      >
        <option value="">Choose…</option>
        {usable(type).map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} {a.name}
          </option>
        ))}
      </select>
    </div>
  );
  const error = create.error instanceof ApiError ? create.error : null;
  return (
    <>
      <PageHeader
        title="Asset categories"
        description="Each category names the accounts its assets post to."
      />
      <Card>
        {categories.isPending ? (
          <Spinner />
        ) : categories.data?.items.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Cost</th>
                <th>Accumulated depreciation</th>
                <th>Expense</th>
                <th className="num">Life (months)</th>
              </tr>
            </thead>
            <tbody>
              {categories.data.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{nameOf(c.costAccountId)}</td>
                  <td>{nameOf(c.accumulatedAccountId)}</td>
                  <td>{nameOf(c.expenseAccountId)}</td>
                  <td className="num">{c.defaultLifeMonths}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No categories yet.</p>
        )}
      </Card>
      {canManage ? (
        <Card title="New category">
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(undefined, {
                onSuccess: () => {
                  setForm({ ...form, name: '' });
                  void queryClient.invalidateQueries({ queryKey: ['asset-categories', org] });
                },
              });
            }}
          >
            <TextField
              label="Name"
              value={form.name}
              required
              maxLength={100}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              error={error?.fieldError('name')}
            />
            {select('Asset account (cost)', 'costAccountId', 'ASSET')}
            {select('Accumulated depreciation account', 'accumulatedAccountId', 'ASSET')}
            {select('Depreciation expense account', 'expenseAccountId', 'EXPENSE')}
            <TextField
              label="Default life (months)"
              value={form.defaultLifeMonths}
              required
              inputMode="numeric"
              onChange={(e) => setForm({ ...form, defaultLifeMonths: e.target.value })}
            />
            <div>
              <Button type="submit" busy={create.isPending}>
                Add category
              </Button>
            </div>
          </form>
          {create.isError && !error?.issues.length ? <ErrorAlert error={create.error} /> : null}
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function AssetReportsPage() {
  const org = useOrgKey();
  const [asOf, setAsOf] = useState(today());
  const accounts = useAccounts(usePermission(Permission.AccountsView));
  const register = useQuery({
    queryKey: ['asset-register', org, asOf],
    queryFn: () =>
      api.get<{
        items: {
          assetId: string;
          number: string;
          name: string;
          categoryName: string | null;
          cost: string;
          accumulatedDepreciation: string;
          bookValue: string;
        }[];
        totals: { cost: string; accumulatedDepreciation: string; bookValue: string };
      }>(`/fixed-assets/reports/register?asOf=${asOf}`),
  });
  const reconciliation = useQuery({
    queryKey: ['asset-reconciliation', org, asOf],
    queryFn: () =>
      api.get<{
        accounts: {
          kind: string;
          accountId: string;
          register: string;
          ledger: string;
          difference: string;
        }[];
      }>(`/fixed-assets/reports/reconciliation?asOf=${asOf}`),
  });
  const nameOf = (id: string) => {
    const a = accounts.data?.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : id;
  };
  return (
    <>
      <PageHeader title="Fixed asset reports" />
      <Card>
        <TextField
          label="As of"
          type="date"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
        />
      </Card>
      <Card title="Register">
        {register.isPending ? (
          <Spinner />
        ) : register.isError ? (
          <ErrorAlert error={register.error} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Category</th>
                <th className="num">Cost</th>
                <th className="num">Accumulated</th>
                <th className="num">Book value</th>
              </tr>
            </thead>
            <tbody>
              {register.data.items.map((r) => (
                <tr key={r.assetId}>
                  <td>
                    {r.number} {r.name}
                  </td>
                  <td>{r.categoryName}</td>
                  <td className="num">{formatAmount(r.cost, 'MVR')}</td>
                  <td className="num">{formatAmount(r.accumulatedDepreciation, 'MVR')}</td>
                  <td className="num">{formatAmount(r.bookValue, 'MVR')}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={2}>Total</th>
                <th className="num">{formatAmount(register.data.totals.cost, 'MVR')}</th>
                <th className="num">
                  {formatAmount(register.data.totals.accumulatedDepreciation, 'MVR')}
                </th>
                <th className="num">{formatAmount(register.data.totals.bookValue, 'MVR')}</th>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>
      <Card title="Against the general ledger">
        {reconciliation.isPending ? (
          <Spinner />
        ) : reconciliation.isError ? (
          <ErrorAlert error={reconciliation.error} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">Register</th>
                <th className="num">Ledger</th>
                <th className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {reconciliation.data.accounts.map((r) => (
                <tr key={`${r.kind}-${r.accountId}`}>
                  <td>{nameOf(r.accountId)}</td>
                  <td className="num">{formatAmount(r.register, 'MVR')}</td>
                  <td className="num">{formatAmount(r.ledger, 'MVR')}</td>
                  <td className="num">{formatAmount(r.difference, 'MVR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
