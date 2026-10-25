import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Badge, toneOf, type BadgeTone } from '../../shared/ui/Badge';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { useT } from '../../i18n/i18n';

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
  depreciationMethod: DepreciationMethod;
  decliningRate: string | null;
  doubleDecliningRate: string | null;
  accumulatedDepreciation: string;
  bookValue: string;
  status: 'ACTIVE' | 'DISPOSED';
  location: string;
  custodian: string;
  serialNumber: string;
  version: number;
}

type DepreciationMethod = 'straight_line' | 'declining_balance' | 'double_declining_balance';

/** What the server says an unsaved asset's schedule would be (R-11); nothing is saved. */
interface SchedulePreview {
  depreciationMethod: DepreciationMethod;
  lifeMonths: number;
  warnings: ('NOTHING_TO_DEPRECIATE' | 'STRAIGHT_LINE_EQUIVALENT')[];
  schedule: { monthEnd: string; amount: string; accumulated: string; bookValue: string }[];
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
  const t = useT();
  return (
    <>
      <nav className="subnav" aria-label={t('assets.assetPages.fixedAssets')}>
        <NavLink to="/assets" end>
          {t('assets.assetPages.register')}
        </NavLink>
        <Can permission={Permission.FixedAssetsView}>
          <NavLink to="/assets/depreciation">{t('assets.assetPages.depreciation')}</NavLink>
          <NavLink to="/assets/categories">{t('assets.assetPages.categories')}</NavLink>
          <NavLink to="/assets/reports">{t('assets.assetPages.reports')}</NavLink>
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
  const t = useT();
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
    depreciationMethod: 'straight_line' as DepreciationMethod,
    decliningRate: '',
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
  // The schedule terms, shared by the schedule check and registration.
  const terms = () => ({
    categoryId: form.categoryId,
    acquisitionDate: form.acquisitionDate,
    cost: form.cost.trim(),
    ...(form.salvageValue.trim() ? { salvageValue: form.salvageValue.trim() } : {}),
    ...(form.lifeMonths.trim() ? { lifeMonths: Number(form.lifeMonths) } : {}),
    ...(form.depreciationMethod === 'straight_line'
      ? {}
      : { depreciationMethod: form.depreciationMethod }),
    ...(form.depreciationMethod === 'declining_balance'
      ? { decliningRate: form.decliningRate.trim() }
      : {}),
  });
  // The schedule check runs by itself for the declining methods once the terms are complete and
  // typing has paused; straight line asks nothing. A result is shown only for the current terms.
  const termsKey = JSON.stringify(terms());
  const previewReady =
    form.depreciationMethod !== 'straight_line' &&
    Boolean(form.categoryId && form.cost.trim()) &&
    (form.depreciationMethod !== 'declining_balance' || Boolean(form.decliningRate.trim()));
  const settledTerms = useSettled(previewReady ? termsKey : null, 400);
  const previewCurrent = previewReady && settledTerms === termsKey;
  const preview = useQuery({
    queryKey: ['asset-schedule-preview', org, settledTerms],
    queryFn: () =>
      api.post<SchedulePreview>(
        '/fixed-assets/assets/schedule-preview',
        JSON.parse(settledTerms!) as unknown,
      ),
    enabled: previewCurrent,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const create = useApiMutation(() =>
    api.post<Asset>(
      '/fixed-assets/assets',
      {
        name: form.name.trim(),
        ...terms(),
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
  const previewError = previewCurrent && preview.error instanceof ApiError ? preview.error : null;
  const error = create.error instanceof ApiError ? create.error : previewError;
  return (
    <>
      <PageHeader
        title={t('assets.assetPages.fixedAssets')}
        description={t('assets.assetPages.theRegisterOfWhatThe')}
      />
      <Card>
        <div className="field">
          <label htmlFor="asset-status">{t('assets.assetPages.show')}</label>
          <select id="asset-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('common.all')}</option>
            <option value="ACTIVE">{t('assets.assetPages.inUse')}</option>
            <option value="DISPOSED">{t('assets.assetPages.disposedOf')}</option>
          </select>
        </div>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">{t('assets.assetPages.noFixedAssetsYet')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('assets.assetPages.number')}</th>
                <th>{t('assets.assetPages.name')}</th>
                <th>{t('assets.assetPages.category')}</th>
                <th className="num">{t('assets.assetPages.cost')}</th>
                <th className="num">{t('assets.assetPages.accumulated')}</th>
                <th className="num">{t('assets.assetPages.bookValue')}</th>
                <th>{t('assets.assetPages.status')}</th>
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
                    <AssetStatusBadge status={a.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {canManage ? (
        <Card title={t('assets.assetPages.registerAnAsset')}>
          <form onSubmit={submit} className="form-grid">
            <TextField
              label={t('assets.assetPages.name')}
              value={form.name}
              required
              maxLength={200}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              error={error?.fieldError('name')}
            />
            <div className="field">
              <label htmlFor="asset-category">{t('assets.assetPages.category')}</label>
              <select
                id="asset-category"
                value={form.categoryId}
                required
                onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
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
              label={t('assets.assetPages.acquiredOn')}
              type="date"
              value={form.acquisitionDate}
              required
              onChange={(e) => setForm({ ...form, acquisitionDate: e.target.value })}
              error={error?.fieldError('acquisitionDate')}
            />
            <TextField
              label={t('assets.assetPages.cost')}
              value={form.cost}
              required
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, cost: e.target.value })}
              error={error?.fieldError('cost')}
            />
            <TextField
              label={t('assets.assetPages.salvageValue')}
              value={form.salvageValue}
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, salvageValue: e.target.value })}
              error={error?.fieldError('salvageValue')}
            />
            <TextField
              label={t('assets.assetPages.lifeInMonths')}
              value={form.lifeMonths}
              inputMode="numeric"
              onChange={(e) => setForm({ ...form, lifeMonths: e.target.value })}
              hint={t('assets.assetPages.defaultsToTheCategory')}
              error={error?.fieldError('lifeMonths')}
            />
            <div className="field">
              <label htmlFor="asset-method">{t('assets.assetPages.depreciationMethod')}</label>
              <select
                id="asset-method"
                value={form.depreciationMethod}
                onChange={(e) =>
                  setForm({
                    ...form,
                    depreciationMethod: e.target.value as DepreciationMethod,
                    decliningRate: '',
                  })
                }
              >
                <option value="straight_line">{t('assets.assetPages.straightLine')}</option>
                <option value="declining_balance">{t('assets.assetPages.decliningBalance')}</option>
                <option value="double_declining_balance">
                  {t('assets.assetPages.doubleDecliningBalance')}
                </option>
              </select>
              <small className="field__hint">{t('assets.assetPages.methodIsFixedOnce')}</small>
            </div>
            {form.depreciationMethod === 'declining_balance' ? (
              <TextField
                label={t('assets.assetPages.annualRatePercent')}
                value={form.decliningRate}
                required
                inputMode="decimal"
                onChange={(e) => setForm({ ...form, decliningRate: e.target.value })}
                hint={t('assets.assetPages.greaterThan0AtMost100')}
                error={error?.fieldError('decliningRate')}
              />
            ) : null}
            <div className="field">
              <label htmlFor="asset-credit">{t('assets.assetPages.paidFrom')}</label>
              <select
                id="asset-credit"
                value={form.creditAccountId}
                required={!form.sourceBillId}
                disabled={Boolean(form.sourceBillId)}
                onChange={(e) => setForm({ ...form, creditAccountId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
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
                <label htmlFor="asset-bill">{t('assets.assetPages.capitalizedByABill')}</label>
                <select
                  id="asset-bill"
                  value={form.sourceBillId}
                  onChange={(e) => setForm({ ...form, sourceBillId: e.target.value })}
                >
                  <option value="">{t('assets.assetPages.noBillPostTheAcquisition')}</option>
                  {(bills.data?.items ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.number} · {b.vendorName} · {b.total}
                    </option>
                  ))}
                </select>
                <small className="field__hint">
                  {t('assets.assetPages.chooseTheBillThatAlready')}
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
                label={t('assets.assetPages.differentPurchaseSayWhy')}
                value={form.duplicateOverrideReason}
                hint={t('assets.assetPages.aMatchingBillExistsOnly')}
                onChange={(e) => setForm({ ...form, duplicateOverrideReason: e.target.value })}
              />
            ) : null}
            {previewReady && previewCurrent && preview.data ? (
              <ScheduleCheck preview={preview.data} />
            ) : previewReady && !previewError ? (
              <p className="muted" role="status">
                {t('assets.assetPages.checkingSchedule')}
              </p>
            ) : null}
            <div>
              <Button type="submit" busy={create.isPending}>
                {t('assets.assetPages.registerAsset')}
              </Button>
            </div>
          </form>
          {create.isError && !error?.issues.length ? <ErrorAlert error={create.error} /> : null}
          {previewCurrent && preview.isError && !create.isError && !error?.issues.length ? (
            <ErrorAlert error={preview.error} />
          ) : null}
        </Card>
      ) : null}
    </>
  );
}

/** A value that follows another once it has stopped changing for `delayMs`. */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/** The schedule check before registering (R-11): the warnings inform and never block. */
function ScheduleCheck({ preview }: { preview: SchedulePreview }) {
  const t = useT();
  const firstYear = preview.schedule.slice(0, 12);
  return (
    <div>
      {preview.warnings.includes('NOTHING_TO_DEPRECIATE') ? (
        <Alert tone="info">{t('assets.assetPages.nothingToDepreciate')}</Alert>
      ) : preview.warnings.includes('STRAIGHT_LINE_EQUIVALENT') ? (
        <Alert tone="info">{t('assets.assetPages.sameAsStraightLine')}</Alert>
      ) : null}
      <table className="table" aria-label={t('assets.assetPages.scheduleCheck')}>
        <thead>
          <tr>
            <th>{t('assets.assetPages.monthEnd')}</th>
            <th className="num">{t('assets.assetPages.depreciation')}</th>
            <th className="num">{t('assets.assetPages.accumulated')}</th>
            <th className="num">{t('assets.assetPages.bookValue')}</th>
          </tr>
        </thead>
        <tbody>
          {firstYear.map((row) => (
            <tr key={row.monthEnd}>
              <td>{row.monthEnd}</td>
              <td className="num">{formatAmount(row.amount, 'MVR')}</td>
              <td className="num">{formatAmount(row.accumulated, 'MVR')}</td>
              <td className="num">{formatAmount(row.bookValue, 'MVR')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview.schedule.length > firstYear.length ? (
        <small className="field__hint">
          {t('assets.assetPages.firstMonthsOfTotal', {
            shown: firstYear.length,
            total: preview.schedule.length,
          })}
        </small>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One asset
// ---------------------------------------------------------------------------

export function AssetPage() {
  const t = useT();
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
    const reason = window.prompt(t('assets.assetPages.whyIsThisDisposalVoided'));
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
        description={t('assets.assetPages.costBookValueMonths', {
          categoryName: a.categoryName ?? '',
          value: formatAmount(a.cost, 'MVR'),
          value2: formatAmount(a.bookValue, 'MVR'),
          lifeMonths: a.lifeMonths,
        })}
      />
      <p>
        <Link to="/assets">{t('assets.assetPages.register2')}</Link>{' '}
        <AssetStatusBadge status={a.status} />
      </p>
      <p className="muted">
        {a.depreciationMethod === 'declining_balance'
          ? t('assets.assetPages.decliningBalanceAt', { rate: a.decliningRate ?? '' })
          : a.depreciationMethod === 'double_declining_balance'
            ? t('assets.assetPages.doubleDecliningBalanceAt', {
                rate: a.doubleDecliningRate ?? '',
              })
            : t('assets.assetPages.straightLine')}
      </p>
      {canDispose && a.status === 'ACTIVE' ? (
        <Card title={t('assets.assetPages.disposeOfThisAsset')}>
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
                label={t('assets.assetPages.disposalDate')}
                type="date"
                value={disposal.disposalDate}
                required
                onChange={(e) => setDisposal({ ...disposal, disposalDate: e.target.value })}
              />
              <TextField
                label={t('assets.assetPages.proceeds')}
                value={disposal.proceeds}
                inputMode="decimal"
                onChange={(e) => setDisposal({ ...disposal, proceeds: e.target.value })}
                hint={t('assets.assetPages.leaveEmptyForAWrite')}
              />
              <div className="field">
                <label htmlFor="disposal-account">{t('assets.assetPages.proceedsGoTo')}</label>
                <select
                  id="disposal-account"
                  value={disposal.proceedsAccountId}
                  onChange={(e) => setDisposal({ ...disposal, proceedsAccountId: e.target.value })}
                >
                  <option value="">{t('common.none')}</option>
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
                  {t('assets.assetPages.postDisposal')}
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="secondary" onClick={() => setDisposing(true)}>
              {t('assets.assetPages.dispose')}
            </Button>
          )}
          {dispose.isError ? <ErrorAlert error={dispose.error} /> : null}
        </Card>
      ) : null}
      {active ? (
        <Alert tone="info">
          {t('assets.assetPages.disposedOfOnProceedsGain', {
            date: active.date,
            value: formatAmount(active.proceeds, 'MVR'),
            value2: formatAmount(active.gainLoss, 'MVR'),
          })}{' '}
          {canVoid ? (
            <Button
              variant="ghost"
              onClick={() => voidDisposal.mutate(active, { onSuccess: refresh })}
            >
              {t('assets.assetPages.voidTheDisposal')}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {voidDisposal.isError ? <ErrorAlert error={voidDisposal.error} /> : null}
      <Card title={t('assets.assetPages.depreciationSchedule')}>
        <table className="table">
          <thead>
            <tr>
              <th>{t('assets.assetPages.monthEnd')}</th>
              <th className="num">{t('assets.assetPages.depreciation')}</th>
              <th className="num">{t('assets.assetPages.accumulated')}</th>
              <th className="num">{t('assets.assetPages.bookValue')}</th>
              <th>{t('assets.assetPages.booked')}</th>
            </tr>
          </thead>
          <tbody>
            {a.schedule.map((row) => (
              <tr key={row.monthEnd}>
                <td>{row.monthEnd}</td>
                <td className="num">{formatAmount(row.amount, 'MVR')}</td>
                <td className="num">{formatAmount(row.accumulated, 'MVR')}</td>
                <td className="num">{formatAmount(row.bookValue, 'MVR')}</td>
                <td>{row.booked ? t('assets.assetPages.yes') : ''}</td>
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
  const t = useT();
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
    const reason = window.prompt(t('assets.assetPages.whyIsThisRunVoided'));
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
        title={t('assets.assetPages.depreciation')}
        description={t('assets.assetPages.bookTheDepreciationOwingUp')}
      />
      <Card title={t('assets.assetPages.runDepreciation')}>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            preview.mutate();
          }}
        >
          <TextField
            label={t('assets.assetPages.monthEnd')}
            type="date"
            value={monthEnd}
            required
            onChange={(e) => setMonthEnd(e.target.value)}
          />
          <div>
            <Button type="submit" busy={preview.isPending}>
              {t('assets.assetPages.preview')}
            </Button>
          </div>
        </form>
        {preview.isError ? <ErrorAlert error={preview.error} /> : null}
        {p ? (
          <>
            {p.lines.length === 0 ? (
              <p className="muted">
                {t('assets.assetPages.nothingIsOwingUpTo', { monthEnd: p.monthEnd })}
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('assets.assetPages.asset')}</th>
                    <th>{t('assets.assetPages.category')}</th>
                    <th className="num">{t('assets.assetPages.depreciation')}</th>
                    <th className="num">{t('assets.assetPages.bookValueAfter')}</th>
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
                    <th colSpan={2}>{t('assets.assetPages.total')}</th>
                    <th className="num">{formatAmount(p.total, 'MVR')}</th>
                    <th />
                  </tr>
                </tfoot>
              </table>
            )}
            {!p.canRun ? (
              <Alert tone="info">
                {t('assets.assetPages.depreciationHasAlreadyRunThrough', {
                  latestRunMonthEnd: p.latestRunMonthEnd,
                })}
              </Alert>
            ) : null}
            {canRun ? (
              <Button
                busy={run.isPending}
                disabled={!p.canRun || p.lines.length === 0}
                onClick={() => run.mutate(undefined, { onSuccess: refresh })}
              >
                {t('assets.assetPages.postDepreciation')}
              </Button>
            ) : null}
            {run.isError ? <ErrorAlert error={run.error} /> : null}
          </>
        ) : null}
      </Card>
      <Card title={t('assets.assetPages.runs')}>
        {runs.isPending ? (
          <Spinner />
        ) : runs.data?.items.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('assets.assetPages.number')}</th>
                <th>{t('assets.assetPages.monthEnd')}</th>
                <th className="num">{t('assets.assetPages.total')}</th>
                <th className="num">{t('assets.assetPages.assets')}</th>
                <th>{t('assets.assetPages.status')}</th>
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
                  <td>
                    {r.status === 'POSTED'
                      ? t('assets.assetPages.posted')
                      : t('assets.assetPages.void')}
                  </td>
                  <td>
                    {canVoid && r.id === latestId ? (
                      <Button
                        variant="ghost"
                        onClick={() => voidRun.mutate(r, { onSuccess: refresh })}
                      >
                        {t('assets.assetPages.void')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">{t('assets.assetPages.noDepreciationHasRunYet')}</p>
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
  const t = useT();
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
        <option value="">{t('common.choose')}</option>
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
        title={t('assets.assetPages.assetCategories')}
        description={t('assets.assetPages.eachCategoryNamesTheAccounts')}
      />
      <Card>
        {categories.isPending ? (
          <Spinner />
        ) : categories.data?.items.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('assets.assetPages.name')}</th>
                <th>{t('assets.assetPages.cost')}</th>
                <th>{t('assets.assetPages.accumulatedDepreciation')}</th>
                <th>{t('assets.assetPages.expense')}</th>
                <th className="num">{t('assets.assetPages.lifeMonths')}</th>
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
          <p className="muted">{t('assets.assetPages.noCategoriesYet')}</p>
        )}
      </Card>
      {canManage ? (
        <Card title={t('assets.assetPages.newCategory')}>
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
              label={t('assets.assetPages.name')}
              value={form.name}
              required
              maxLength={100}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              error={error?.fieldError('name')}
            />
            {select(t('assets.assetPages.costAccount'), 'costAccountId', 'ASSET')}
            {select(t('assets.assetPages.accumulatedAccount'), 'accumulatedAccountId', 'ASSET')}
            {select(t('assets.assetPages.expenseAccount'), 'expenseAccountId', 'EXPENSE')}
            <TextField
              label={t('assets.assetPages.defaultLifeMonths')}
              value={form.defaultLifeMonths}
              required
              inputMode="numeric"
              onChange={(e) => setForm({ ...form, defaultLifeMonths: e.target.value })}
            />
            <div>
              <Button type="submit" busy={create.isPending}>
                {t('assets.assetPages.addCategory')}
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
  const t = useT();
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
      <PageHeader title={t('assets.assetPages.fixedAssetReports')} />
      <Card>
        <TextField
          label={t('assets.assetPages.asOf')}
          type="date"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
        />
      </Card>
      <Card title={t('assets.assetPages.register')}>
        {register.isPending ? (
          <Spinner />
        ) : register.isError ? (
          <ErrorAlert error={register.error} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('assets.assetPages.asset')}</th>
                <th>{t('assets.assetPages.category')}</th>
                <th className="num">{t('assets.assetPages.cost')}</th>
                <th className="num">{t('assets.assetPages.accumulated')}</th>
                <th className="num">{t('assets.assetPages.bookValue')}</th>
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
                <th colSpan={2}>{t('assets.assetPages.total')}</th>
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
      <Card title={t('assets.assetPages.againstTheGeneralLedger')}>
        {reconciliation.isPending ? (
          <Spinner />
        ) : reconciliation.isError ? (
          <ErrorAlert error={reconciliation.error} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('assets.assetPages.account')}</th>
                <th className="num">{t('assets.assetPages.register')}</th>
                <th className="num">{t('assets.assetPages.ledger')}</th>
                <th className="num">{t('assets.assetPages.difference')}</th>
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

const ASSET_STATUS_TONE: Record<'ACTIVE' | 'DISPOSED', BadgeTone> = {
  ACTIVE: 'success',
  DISPOSED: 'danger',
};

/** An asset's status: in use is success, disposed is danger, any other status is neutral and shown as it came. */
export function AssetStatusBadge({ status }: { status: string }) {
  const t = useT();
  const label =
    status === 'ACTIVE'
      ? t('assets.assetPages.inUse')
      : status === 'DISPOSED'
        ? t('assets.assetPages.disposed')
        : status;
  return <Badge tone={toneOf(ASSET_STATUS_TONE, status)}>{label}</Badge>;
}
