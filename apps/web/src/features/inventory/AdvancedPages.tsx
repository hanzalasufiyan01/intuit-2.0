import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { useT } from '../../i18n/i18n';

/**
 * Lots, serials, expiry, units of measure and landed cost (FP-29, ADR 0014). The server enforces
 * every rule; these pages show the data and send the requests.
 */

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

// ---------------------------------------------------------------------------
// Lots of an item and the expiry report
// ---------------------------------------------------------------------------

interface ItemLot {
  lotId: string;
  code: string;
  expiryDate: string | null;
  quantity: string;
  warehouses: { warehouseId: string; name: string | null; quantity: string }[];
}

/** The lots (or serial numbers) of one tracked item, shown on its stock page. */
export function ItemLotsCard({ itemId, trackingMode }: { itemId: string; trackingMode: string }) {
  const t = useT();
  const org = useOrgKey();
  const lots = useQuery({
    queryKey: ['inventory-item-lots', org, itemId],
    enabled: trackingMode !== 'none',
    queryFn: () => api.get<ItemLot[]>(`/inventory/items/${itemId}/lots`),
  });
  if (trackingMode === 'none') return null;
  return (
    <Card
      title={
        trackingMode === 'serial'
          ? t('inventory.advancedPages.serialNumbers')
          : t('inventory.advancedPages.lots')
      }
    >
      {lots.isPending ? <Spinner /> : null}
      <ErrorAlert error={lots.error} />
      {lots.data && lots.data.length === 0 ? (
        <p className="muted">{t('inventory.advancedPages.nothingReceivedYet')}</p>
      ) : null}
      {lots.data && lots.data.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>
                {trackingMode === 'serial'
                  ? t('inventory.advancedPages.serialNumber')
                  : t('inventory.advancedPages.lot')}
              </th>
              <th>{t('inventory.advancedPages.expires')}</th>
              <th className="num">{t('inventory.advancedPages.inStock')}</th>
              <th>{t('inventory.advancedPages.where')}</th>
            </tr>
          </thead>
          <tbody>
            {lots.data.map((l) => (
              <tr key={l.lotId}>
                <td>{l.code}</td>
                <td>{l.expiryDate ?? ''}</td>
                <td className="num">{l.quantity}</td>
                <td>
                  {l.warehouses
                    .filter((w) => Number(w.quantity) !== 0)
                    .map((w) => `${w.name}: ${w.quantity}`)
                    .join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Card>
  );
}

interface ExpiringReport {
  asOf: string;
  through: string;
  lots: {
    lotId: string;
    itemId: string;
    itemName: string;
    code: string;
    expiryDate: string;
    daysToExpiry: number;
    expired: boolean;
    warehouseName: string | null;
    quantity: string;
  }[];
}

export function ExpiringLotsPage() {
  const t = useT();
  const org = useOrgKey();
  const [days, setDays] = useState('30');
  const [applied, setApplied] = useState('30');
  const report = useQuery({
    queryKey: ['inventory-expiring', org, applied],
    queryFn: () =>
      api.get<ExpiringReport>(`/inventory/lots/expiring?days=${Number(applied) || 30}`),
  });
  return (
    <>
      <PageHeader
        title={t('inventory.advancedPages.expiringStock')}
        description={t('inventory.advancedPages.lotsWithStockThatExpire')}
      />
      <Card>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(days);
          }}
        >
          <TextField
            label={t('inventory.advancedPages.expiringWithinDays')}
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
          <Button type="submit">{t('inventory.advancedPages.show')}</Button>
        </form>
      </Card>
      <Card>
        {report.isPending ? <Spinner /> : null}
        <ErrorAlert error={report.error} />
        {report.data && report.data.lots.length === 0 ? (
          <p className="muted">{t('inventory.advancedPages.nothingExpiresInThisPeriod')}</p>
        ) : null}
        {report.data && report.data.lots.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('inventory.advancedPages.item')}</th>
                <th>{t('inventory.advancedPages.lot')}</th>
                <th>{t('inventory.advancedPages.expires')}</th>
                <th>{t('inventory.advancedPages.warehouse')}</th>
                <th className="num">{t('inventory.advancedPages.quantity')}</th>
              </tr>
            </thead>
            <tbody>
              {report.data.lots.map((l) => (
                <tr key={`${l.lotId}-${l.warehouseName}`}>
                  <td>
                    <Link to={`/inventory/items/${l.itemId}`}>{l.itemName}</Link>
                  </td>
                  <td>{l.code}</td>
                  <td>
                    {l.expiryDate}{' '}
                    {l.expired ? (
                      <span className="badge badge--error">
                        {t('inventory.advancedPages.expired')}
                      </span>
                    ) : (
                      <small className="muted">
                        {t('inventory.advancedPages.inDays', { daysToExpiry: l.daysToExpiry })}
                      </small>
                    )}
                  </td>
                  <td>{l.warehouseName}</td>
                  <td className="num">{l.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// The lots of a draft bill or vendor credit
// ---------------------------------------------------------------------------

interface DocLot {
  itemId: string;
  lotCode: string;
  expiryDate: string | null;
  quantity: string;
}

/** Names the lots a draft bill brings in (or a draft vendor credit sends back). */
export function DocumentLots({ type, id }: { type: 'bill' | 'vendor_credit'; id: string }) {
  const tr = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canSee = usePermission(Permission.InventoryView);
  const tracked = useQuery({
    queryKey: ['inventory-items', org],
    enabled: canSee,
    queryFn: () =>
      api.get<{
        items: { itemId: string; name: string; trackingMode: string; expiryTracked: boolean }[];
      }>('/inventory/items'),
  });
  const current = useQuery({
    queryKey: ['inventory-document-lots', org, type, id],
    enabled: canSee,
    queryFn: () => api.get<DocLot[]>(`/inventory/document-lots/${type}/${id}`),
  });
  const [rows, setRows] = useState<DocLot[] | null>(null);
  const lotItems = (tracked.data?.items ?? []).filter((i) => i.trackingMode !== 'none');
  const save = useApiMutation((value: DocLot[]) =>
    api.put(`/inventory/document-lots/${type}/${id}`, {
      lots: value
        .filter((r) => r.itemId && r.lotCode)
        .map((r) => ({ ...r, expiryDate: r.expiryDate || null })),
    }),
  );
  if (!canSee || lotItems.length === 0) return null;
  const shown = rows ?? current.data ?? [];
  const set = (next: DocLot[]) => setRows(next);
  return (
    <Card
      title={
        type === 'bill'
          ? tr('inventory.advancedPages.lotsAndSerialNumbersReceived')
          : tr('inventory.advancedPages.lotsAndSerialNumbersReturned')
      }
    >
      <Alert>{tr('inventory.advancedPages.itemsTrackedByLotOr')}</Alert>
      {shown.map((r, i) => (
        <div className="filters" key={i}>
          <div className="field">
            <label htmlFor={`dl-item-${i}`}>{tr('inventory.advancedPages.item')}</label>
            <select
              id={`dl-item-${i}`}
              value={r.itemId}
              onChange={(e) =>
                set(shown.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))
              }
            >
              <option value="">{tr('common.choose')}</option>
              {lotItems.map((t) => (
                <option key={t.itemId} value={t.itemId}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={tr('inventory.advancedPages.lotOrSerial')}
            value={r.lotCode}
            onChange={(e) =>
              set(shown.map((x, j) => (j === i ? { ...x, lotCode: e.target.value } : x)))
            }
          />
          <TextField
            label={tr('inventory.advancedPages.expiry')}
            type="date"
            value={r.expiryDate ?? ''}
            onChange={(e) =>
              set(shown.map((x, j) => (j === i ? { ...x, expiryDate: e.target.value } : x)))
            }
          />
          <TextField
            label={tr('inventory.advancedPages.quantity')}
            inputMode="decimal"
            value={r.quantity}
            onChange={(e) =>
              set(shown.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))
            }
          />
        </div>
      ))}
      <Button
        variant="ghost"
        onClick={() =>
          set([...shown, { itemId: '', lotCode: '', expiryDate: null, quantity: '1' }])
        }
      >
        {tr('inventory.advancedPages.addALot')}
      </Button>{' '}
      <Button
        busy={save.isPending}
        onClick={() =>
          save.mutate(shown, {
            onSuccess: () => {
              setRows(null);
              void queryClient.invalidateQueries({
                queryKey: ['inventory-document-lots', org, type, id],
              });
            },
          })
        }
      >
        {tr('inventory.advancedPages.saveLots')}
      </Button>
      <ErrorAlert error={save.error} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Units of measure
// ---------------------------------------------------------------------------

interface Units {
  baseUnit: string;
  purchaseUnit: { unit: string; factor: string } | null;
  salesUnit: { unit: string; factor: string } | null;
  version: number;
}

export function ItemUnitsCard({ itemId }: { itemId: string }) {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.InventoryItemsManage);
  const units = useQuery({
    queryKey: ['inventory-item-units', org, itemId],
    queryFn: () => api.get<Units>(`/inventory/items/${itemId}/units`),
  });
  const [form, setForm] = useState<{
    baseUnit: string;
    pUnit: string;
    pFactor: string;
    sUnit: string;
    sFactor: string;
  } | null>(null);
  const u = units.data;
  const value = form ?? {
    baseUnit: u?.baseUnit ?? 'unit',
    pUnit: u?.purchaseUnit?.unit ?? '',
    pFactor: u?.purchaseUnit?.factor ?? '',
    sUnit: u?.salesUnit?.unit ?? '',
    sFactor: u?.salesUnit?.factor ?? '',
  };
  const save = useApiMutation(() =>
    api.put(`/inventory/items/${itemId}/units`, {
      version: u!.version,
      baseUnit: value.baseUnit,
      purchaseUnit: value.pUnit ? { unit: value.pUnit, factor: value.pFactor } : null,
      salesUnit: value.sUnit ? { unit: value.sUnit, factor: value.sFactor } : null,
    }),
  );
  if (!u) return null;
  return (
    <Card title={t('inventory.advancedPages.unitsOfMeasure')}>
      <p className="muted">{t('inventory.advancedPages.stockIsKeptInThe')}</p>
      {canManage ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined, {
              onSuccess: () => {
                setForm(null);
                void queryClient.invalidateQueries({
                  queryKey: ['inventory-item-units', org, itemId],
                });
              },
            });
          }}
        >
          <TextField
            label={t('inventory.advancedPages.baseUnit')}
            value={value.baseUnit}
            onChange={(e) => setForm({ ...value, baseUnit: e.target.value })}
          />
          <TextField
            label={t('inventory.advancedPages.purchaseUnit')}
            value={value.pUnit}
            onChange={(e) => setForm({ ...value, pUnit: e.target.value })}
          />
          <TextField
            label={t('inventory.advancedPages.baseUnitsPerPurchaseUnit')}
            inputMode="decimal"
            value={value.pFactor}
            onChange={(e) => setForm({ ...value, pFactor: e.target.value })}
          />
          <TextField
            label={t('inventory.advancedPages.salesUnit')}
            value={value.sUnit}
            onChange={(e) => setForm({ ...value, sUnit: e.target.value })}
          />
          <TextField
            label={t('inventory.advancedPages.baseUnitsPerSalesUnit')}
            inputMode="decimal"
            value={value.sFactor}
            onChange={(e) => setForm({ ...value, sFactor: e.target.value })}
          />
          <ErrorAlert error={save.error} />
          <Button type="submit" busy={save.isPending}>
            {t('inventory.advancedPages.saveUnits')}
          </Button>
        </form>
      ) : (
        <p>
          {t('inventory.advancedPages.baseUnit2', {
            baseUnit: u.baseUnit,
            value: u.purchaseUnit
              ? t('inventory.advancedPages.buyIn', {
                  unit: u.purchaseUnit.unit,
                  factor: u.purchaseUnit.factor,
                })
              : '',
            value2: u.salesUnit
              ? t('inventory.advancedPages.sellIn', {
                  unit: u.salesUnit.unit,
                  factor: u.salesUnit.factor,
                })
              : '',
          })}
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Landed cost
// ---------------------------------------------------------------------------

interface LandedCost {
  id: string;
  number: string;
  costDate: string;
  billNumber: string | null;
  description: string;
  amount: string;
  status: 'POSTED' | 'VOID';
  voidReason: string | null;
  version: number;
  lines: {
    itemId: string;
    name: string | null;
    allocated: string;
    toInventory: string;
    toCostOfGoodsSold: string;
  }[];
}

export function LandedCostsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canPost = usePermission(Permission.InventoryAdjustmentsCreate);
  const canVoid = usePermission(Permission.InventoryAdjustmentsVoid);
  const accounts = useAccounts(canPost);
  const costs = useQuery({
    queryKey: ['inventory-landed-costs', org],
    queryFn: () => api.get<LandedCost[]>('/inventory/landed-costs'),
  });
  const bills = useQuery({
    queryKey: ['inventory-landed-bills', org],
    enabled: canPost,
    queryFn: () =>
      api.get<{ items: { id: string; number: string | null; status: string }[] }>(
        '/purchases/bills?limit=100',
      ),
  });
  const [form, setForm] = useState({
    costDate: new Date().toISOString().slice(0, 10),
    billId: '',
    description: '',
    amount: '',
    basis: 'value',
    creditAccountId: '',
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['inventory-landed-costs', org] });
  const post = useApiMutation(() => api.post('/inventory/landed-costs', form));
  const voidCost = useApiMutation((c: LandedCost) =>
    sensitive(async () => {
      const reason = window.prompt(t('inventory.advancedPages.reasonForVoidingThisLanded')) ?? '';
      if (!reason.trim()) throw new Error(t('inventory.reasonRequired'));
      return api.post(`/inventory/landed-costs/${c.id}/void`, { version: c.version, reason });
    }),
  );
  const usable = (accounts.data ?? []).filter(
    (a) => a.status === 'ACTIVE' && a.isLeaf && !a.isControlAccount,
  );
  return (
    <>
      <PageHeader
        title={t('inventory.advancedPages.landedCost')}
        description={t('inventory.advancedPages.freightDutyOrHandlingSpread')}
      />
      {canPost ? (
        <Card title={t('inventory.advancedPages.addALandedCost')}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              post.mutate(undefined, {
                onSuccess: () => {
                  setForm({ ...form, description: '', amount: '' });
                  refresh();
                },
              });
            }}
          >
            <TextField
              label={t('inventory.advancedPages.date')}
              type="date"
              required
              value={form.costDate}
              onChange={(e) => setForm({ ...form, costDate: e.target.value })}
            />
            <div className="field">
              <label htmlFor="lc-bill">{t('inventory.advancedPages.bill')}</label>
              <select
                id="lc-bill"
                required
                value={form.billId}
                onChange={(e) => setForm({ ...form, billId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {(bills.data?.items ?? [])
                  .filter((b) => b.status === 'POSTED')
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.number}
                    </option>
                  ))}
              </select>
            </div>
            <TextField
              label={t('inventory.advancedPages.description')}
              required
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <TextField
              label={t('inventory.advancedPages.amountBaseCurrency')}
              required
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
            <div className="field">
              <label htmlFor="lc-basis">{t('inventory.advancedPages.spreadBy')}</label>
              <select
                id="lc-basis"
                value={form.basis}
                onChange={(e) => setForm({ ...form, basis: e.target.value })}
              >
                <option value="value">{t('inventory.advancedPages.valueOfEachItem')}</option>
                <option value="quantity">{t('inventory.advancedPages.quantityOfEachItem')}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="lc-account">
                {t('inventory.advancedPages.creditAccountForExampleFreight')}
              </label>
              <select
                id="lc-account"
                required
                value={form.creditAccountId}
                onChange={(e) => setForm({ ...form, creditAccountId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
            <ErrorAlert error={post.error} />
            <Button type="submit" busy={post.isPending}>
              {t('inventory.advancedPages.postLandedCost')}
            </Button>
          </form>
        </Card>
      ) : null}
      <Card title={t('inventory.advancedPages.landedCosts')}>
        {costs.isPending ? <Spinner /> : null}
        <ErrorAlert error={costs.error ?? voidCost.error} />
        {costs.data && costs.data.length === 0 ? (
          <p className="muted">{t('inventory.advancedPages.noLandedCostsYet')}</p>
        ) : null}
        {(costs.data ?? []).map((c) => (
          <div key={c.id}>
            <strong>{c.number}</strong>{' '}
            {t('inventory.advancedPages.bill2', {
              costDate: c.costDate,
              billNumber: c.billNumber,
              value: formatAmount(c.amount, 'MVR'),
            })}{' '}
            {c.status === 'VOID' ? (
              <em>{t('inventory.advancedPages.void', { voidReason: c.voidReason })}</em>
            ) : (
              t('inventory.advancedPages.posted')
            )}
            <ul className="list">
              {c.lines.map((l) => (
                <li key={l.itemId}>
                  {t('inventory.advancedPages.toStockToCostOf', {
                    name: l.name,
                    value: formatAmount(l.toInventory, 'MVR'),
                    value2: formatAmount(l.toCostOfGoodsSold, 'MVR'),
                  })}
                </li>
              ))}
            </ul>
            {canVoid && c.status === 'POSTED' ? (
              <Button variant="ghost" onClick={() => voidCost.mutate(c, { onSuccess: refresh })}>
                {t('inventory.advancedPages.void2')}
              </Button>
            ) : null}
          </div>
        ))}
      </Card>
    </>
  );
}
