import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { useT } from '../../i18n/i18n';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { COMMON_CURRENCIES, formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts, useAccountingSetup, useDimensions } from '../accounting/shared';
import type { ApprovalRequestSummary } from '../accounting/types';
import { AttachmentsCard } from '../files/AttachmentsCard';
import { ApprovalPanel, TotalsTable } from '../sales/DocumentParts';
import { orNull, StatusBadge, useOrgKey, useTaxCodes } from '../sales/shared';
import type { Item, Page } from '../sales/types';
import { PurchasesNav } from './PurchasesSection';
import {
  PURCHASE_ACCOUNT_SUBTYPES,
  type BillSummary,
  type VendorCreditDetail,
  type VendorCreditOrigin,
  type VendorCreditStatus,
  type VendorCreditSummary,
  type VendorSummary,
} from './types';

/**
 * Vendor credits and debit notes (Phase 4B-1; ADR 0004 P4-23, P4-24, P4-37, P4-46): one document
 * with an origin. The list carries the approval queue; the editor sends inputs only (amounts come
 * from the server); the detail posts (re-authenticated), voids, and for debit notes offers the PDF
 * and email. Permission-aware; the server decides.
 */

const POST_ACTION = 'purchases.vendor_credit.post';

function useCredit(id: string) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['vendor-credit', org, id],
    queryFn: () => api.get<VendorCreditDetail>(`/purchases/vendor-credits/${id}`),
  });
}

function CreditStatusBadge({ status }: { status: VendorCreditStatus }) {
  const t = useT();
  return status === 'POSTED' ? (
    <span className="badge badge--posted">{t('purchases.status.posted')}</span>
  ) : (
    <StatusBadge status={status} />
  );
}

// ---------------------------------------------------------------------------
// List and approval queue
// ---------------------------------------------------------------------------

export function VendorCreditsPage() {
  const t = useT();
  const org = useOrgKey();
  const canCreate = usePermission(Permission.VendorCreditsCreate);
  const [filters, setFilters] = useState({ status: '', origin: '', search: '' });
  const [applied, setApplied] = useState(filters);
  const list = useQuery({
    queryKey: ['vendor-credits', org, applied],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (applied.status) params.set('status', applied.status);
      if (applied.origin) params.set('origin', applied.origin);
      if (applied.search.trim()) params.set('search', applied.search.trim());
      return api.get<Page<VendorCreditSummary>>(`/purchases/vendor-credits?${params.toString()}`);
    },
  });
  return (
    <>
      <PageHeader
        title={t('purchases.credits.title')}
        description={t('purchases.credits.description')}
      />
      <PurchasesNav />
      {canCreate ? (
        <p className="actions">
          <Link className="btn" to="/purchases/vendor-credits/new">
            {t('purchases.credits.new')}
          </Link>
        </p>
      ) : null}
      <CreditApprovalQueue />
      <Card>
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(filters);
          }}
        >
          <TextField
            label={t('common.search')}
            hint={t('purchases.credits.searchHint')}
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <div className="field">
            <label htmlFor="credit-origin">{t('purchases.credits.origin')}</label>
            <select
              id="credit-origin"
              value={filters.origin}
              onChange={(e) => setFilters({ ...filters, origin: e.target.value })}
            >
              <option value="">{t('common.all')}</option>
              <option value="supplier_credit_note">
                {t('purchases.credits.supplierCreditNote')}
              </option>
              <option value="debit_note">{t('purchases.credits.debitNote')}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="credit-status">{t('purchases.field.status')}</label>
            <select
              id="credit-status"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">{t('common.all')}</option>
              <option value="DRAFT">{t('sales.status.draft')}</option>
              <option value="PENDING_APPROVAL">{t('sales.status.pendingApproval')}</option>
              <option value="POSTED">{t('purchases.status.posted')}</option>
              <option value="VOID">{t('sales.status.void')}</option>
            </select>
          </div>
          <Button type="submit">{t('common.search')}</Button>
        </form>
        {list.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">{t('purchases.credits.none')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('purchases.bills.number')}</th>
                <th>{t('purchases.credits.origin')}</th>
                <th>{t('purchases.bills.vendor')}</th>
                <th>{t('purchases.credits.date')}</th>
                <th className="num">{t('purchases.field.total')}</th>
                <th className="num">{t('purchases.credits.unapplied')}</th>
                <th>{t('purchases.field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/purchases/vendor-credits/${c.id}`}>
                      {c.number ?? t('purchases.bills.draft')}
                    </Link>
                  </td>
                  <td>{t(ORIGIN_LABEL[c.origin])}</td>
                  <td>{c.vendorName}</td>
                  <td>{c.creditDate}</td>
                  <td className="num">
                    {formatAmount(c.total, c.currencyCode)} {c.currencyCode}
                  </td>
                  <td className="num">
                    {c.amountUnapplied ? formatAmount(c.amountUnapplied, c.currencyCode) : ''}
                  </td>
                  <td>
                    <CreditStatusBadge status={c.status} />
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

const ORIGIN_LABEL = {
  supplier_credit_note: 'purchases.credits.supplierCreditNote',
  debit_note: 'purchases.credits.debitNote',
} as const;

/** Credits awaiting approval that the user may decide (the shared approval routes). */
function CreditApprovalQueue() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canApprove = usePermission(Permission.VendorCreditsApprove);
  const requests = useQuery({
    queryKey: ['approval-requests', org],
    queryFn: () => api.get<ApprovalRequestSummary[]>('/approvals/requests'),
    enabled: canApprove,
  });
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const decide = useApiMutation(
    (input: { id: string; decision: 'approve' | 'reject'; comment?: string }) =>
      sensitive(() =>
        api.post(`/approvals/requests/${input.id}/${input.decision}`, {
          ...(input.comment ? { comment: input.comment } : {}),
        }),
      ),
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['approval-requests', org] });
    void queryClient.invalidateQueries({ queryKey: ['vendor-credits', org] });
  };
  const credits = (requests.data ?? []).filter((r) => r.actionKey === POST_ACTION);
  if (!canApprove || credits.length === 0) return null;
  return (
    <Card title={t('purchases.credits.approvalQueue')}>
      <ErrorAlert error={decide.error} />
      <table className="table">
        <thead>
          <tr>
            <th>{t('purchases.credits.credit')}</th>
            <th>{t('purchases.bills.amount')}</th>
            <th>{t('purchases.bills.progress')}</th>
            <th>
              <span className="sr-only">{t('common.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {credits.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/purchases/vendor-credits/${r.subjectId}`}>
                  {t('purchases.credits.open')}
                </Link>
              </td>
              <td>
                {r.facts?.baseAmount
                  ? `${formatAmount(r.facts.baseAmount, r.facts.baseCurrency ?? '')} ${r.facts.baseCurrency}`
                  : ''}
              </td>
              <td>
                {r.progress
                  .map((s) => `${s.name}: ${s.approvals}/${s.requiredApprovals}`)
                  .join(', ')}
              </td>
              <td>
                {r.canDecide ? (
                  rejecting === r.id ? (
                    <form
                      className="form form--inline"
                      onSubmit={(e) => {
                        e.preventDefault();
                        decide.mutate(
                          { id: r.id, decision: 'reject', comment: comment.trim() },
                          {
                            onSuccess: () => {
                              setRejecting(null);
                              setComment('');
                              refresh();
                            },
                          },
                        );
                      }}
                    >
                      <TextField
                        label={t('purchases.bills.rejectReason')}
                        value={comment}
                        required
                        onChange={(e) => setComment(e.target.value)}
                      />
                      <Button type="submit" variant="secondary" busy={decide.isPending}>
                        {t('purchases.bills.reject')}
                      </Button>
                    </form>
                  ) : (
                    <>
                      <Button
                        busy={decide.isPending}
                        onClick={() =>
                          decide.mutate({ id: r.id, decision: 'approve' }, { onSuccess: refresh })
                        }
                      >
                        {t('purchases.bills.approve')}
                      </Button>
                      <Button variant="ghost" onClick={() => setRejecting(r.id)}>
                        {t('purchases.bills.reject')}
                      </Button>
                    </>
                  )
                ) : (
                  <span className="muted">{t('purchases.bills.notApprover')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

interface LineDraft {
  key: number;
  itemId: string;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxCodeId: string;
  taxRecoverable: '' | 'true' | 'false';
}

let nextKey = 1;
const emptyLine = (): LineDraft => ({
  key: nextKey++,
  itemId: '',
  description: '',
  accountId: '',
  quantity: '1',
  unitPrice: '',
  taxCodeId: '',
  taxRecoverable: '',
});

function CreditEditor({
  existing,
  saving,
  error,
  onSave,
}: {
  existing: VendorCreditDetail | null;
  saving: boolean;
  error: unknown;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const org = useOrgKey();
  const canPost = usePermission(Permission.VendorCreditsPost);
  const canAccounts = usePermission(Permission.AccountsView);
  const canDimensions = usePermission(Permission.DimensionsView);
  const canBills = usePermission(Permission.BillsView);
  const vendors = useQuery({
    queryKey: ['vendor-options', org],
    queryFn: () => api.get<Page<VendorSummary>>('/vendors?limit=200&status=active'),
  });
  const items = useQuery({
    queryKey: ['item-options', org],
    queryFn: () => api.get<Page<Item>>('/sales/items?limit=200&status=active'),
    retry: false,
  });
  const taxCodes = useTaxCodes();
  const accounts = useAccounts(canAccounts);
  const dimensions = useDimensions(canDimensions);
  const setup = useAccountingSetup();

  const [origin, setOrigin] = useState<VendorCreditOrigin>(
    existing?.origin ?? 'supplier_credit_note',
  );
  const [vendorId, setVendorId] = useState(existing?.vendorId ?? '');
  const [billId, setBillId] = useState(existing?.billId ?? '');
  const [creditDate, setCreditDate] = useState(
    existing?.creditDate ?? new Date().toISOString().slice(0, 10),
  );
  const [vendorReference, setVendorReference] = useState(existing?.vendorReference ?? '');
  const [currencyCode, setCurrencyCode] = useState(existing?.currencyCode ?? '');
  const [rateOverride, setRateOverride] = useState(existing?.rateOverride ?? '');
  const [rateOverrideReason, setRateOverrideReason] = useState(existing?.rateOverrideReason ?? '');
  const [taxTreatment, setTaxTreatment] = useState(existing?.taxTreatment ?? '');
  const [memo, setMemo] = useState(existing?.memo ?? '');
  const [dims, setDims] = useState<Record<string, string>>({});
  const [dimsLoaded, setDimsLoaded] = useState(false);
  const [lines, setLines] = useState<LineDraft[]>(
    existing?.lines.map((l) => ({
      key: nextKey++,
      itemId: l.itemId ?? '',
      description: l.description,
      accountId: l.accountId ?? '',
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxCodeId: l.taxCodeId ?? '',
      taxRecoverable:
        l.taxRecoverableOverride === null ? '' : l.taxRecoverableOverride ? 'true' : 'false',
    })) ?? [emptyLine()],
  );
  // Posted bills of the chosen vendor, for the optional reference (not applied).
  const bills = useQuery({
    queryKey: ['vendor-bills', org, vendorId],
    queryFn: () =>
      api.get<Page<BillSummary>>(`/purchases/bills?status=POSTED&vendorId=${vendorId}&limit=200`),
    enabled: canBills && vendorId !== '',
  });
  const types = (dimensions.data ?? []).filter((d) => d.status === 'ACTIVE');
  if (!dimsLoaded && dimensions.data && existing) {
    const picked: Record<string, string> = {};
    for (const type of dimensions.data) {
      const value = type.values.find((v) => existing.dimensionValueIds.includes(v.id));
      if (value) picked[type.id] = value.id;
    }
    setDims(picked);
    setDimsLoaded(true);
  }

  const vendor = vendors.data?.items.find((v) => v.id === vendorId);
  const currency = currencyCode || vendor?.currencyCode || '';
  const baseCurrency = existing?.baseCurrency ?? setup.data?.settings?.baseCurrency ?? null;
  const foreign = currency !== '' && baseCurrency !== null && currency !== baseCurrency;
  const issue = (path: string) => (error instanceof ApiError ? error.fieldError(path) : undefined);
  const update = (key: number, patch: Partial<LineDraft>) =>
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const purchaseAccounts = (accounts.data ?? []).filter(
    (a) =>
      a.status === 'ACTIVE' &&
      a.isLeaf !== false &&
      !a.isControlAccount &&
      a.subtype !== null &&
      (PURCHASE_ACCOUNT_SUBTYPES as readonly string[]).includes(a.subtype),
  );
  const purchasedItems = (items.data?.items ?? []).filter((i) => i.isPurchased);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      ...(existing ? {} : { origin }),
      vendorId,
      creditDate,
      billId: billId || null,
      vendorReference: origin === 'debit_note' ? null : orNull(vendorReference),
      ...(currencyCode ? { currencyCode } : {}),
      rateOverride: billId ? null : orNull(rateOverride),
      rateOverrideReason: billId ? null : orNull(rateOverrideReason),
      ...(taxTreatment ? { taxTreatment } : {}),
      memo: memo.trim(),
      dimensionValueIds: Object.values(dims).filter(Boolean),
      lines: lines.map((l) => ({
        ...(l.itemId ? { itemId: l.itemId } : {}),
        ...(l.description.trim() ? { description: l.description.trim() } : {}),
        ...(l.accountId ? { accountId: l.accountId } : {}),
        quantity: l.quantity,
        ...(l.unitPrice.trim() ? { unitPrice: l.unitPrice.trim() } : {}),
        ...(l.taxCodeId === 'none'
          ? { taxCodeId: null }
          : l.taxCodeId
            ? { taxCodeId: l.taxCodeId }
            : {}),
        taxRecoverable: l.taxRecoverable === '' ? null : l.taxRecoverable === 'true',
      })),
    });
  };

  if (vendors.isPending) return <Spinner label={t('common.loading')} />;
  return (
    <form className="form" onSubmit={submit}>
      <ErrorAlert error={error} />
      <Card title={t('purchases.credits.details')}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="credit-type">{t('purchases.credits.origin')}</label>
            <select
              id="credit-type"
              value={origin}
              disabled={existing !== null}
              onChange={(e) => setOrigin(e.target.value as VendorCreditOrigin)}
            >
              <option value="supplier_credit_note">
                {t('purchases.credits.supplierCreditNote')}
              </option>
              <option value="debit_note">{t('purchases.credits.debitNote')}</option>
            </select>
            <small className="field__hint">{t('purchases.credits.originHint')}</small>
          </div>
          <div className="field">
            <label htmlFor="credit-vendor">{t('purchases.bills.vendor')}</label>
            <select
              id="credit-vendor"
              value={vendorId}
              required
              onChange={(e) => {
                setVendorId(e.target.value);
                setBillId('');
              }}
            >
              <option value="">{t('common.choose')}</option>
              {(vendors.data?.items ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </select>
            {issue('vendorId') ? <small className="field__error">{issue('vendorId')}</small> : null}
          </div>
          {canBills ? (
            <div className="field">
              <label htmlFor="credit-bill">{t('purchases.credits.bill')}</label>
              <select id="credit-bill" value={billId} onChange={(e) => setBillId(e.target.value)}>
                <option value="">{t('common.none')}</option>
                {(bills.data?.items ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.number} · {b.vendorReference} · {formatAmount(b.total, b.currencyCode)}{' '}
                    {b.currencyCode}
                  </option>
                ))}
                {billId && !(bills.data?.items ?? []).some((b) => b.id === billId) ? (
                  <option value={billId}>{existing?.billNumber ?? billId}</option>
                ) : null}
              </select>
              <small className="field__hint">{t('purchases.credits.billHint')}</small>
              {issue('billId') ? <small className="field__error">{issue('billId')}</small> : null}
            </div>
          ) : null}
          {origin === 'supplier_credit_note' ? (
            <TextField
              label={t('purchases.credits.supplierReference')}
              hint={t('purchases.credits.referenceHint')}
              value={vendorReference}
              error={issue('vendorReference')}
              onChange={(e) => setVendorReference(e.target.value)}
            />
          ) : null}
          <TextField
            label={t('purchases.credits.date')}
            type="date"
            value={creditDate}
            required
            error={issue('creditDate')}
            onChange={(e) => setCreditDate(e.target.value)}
          />
          <div className="field">
            <label htmlFor="credit-currency">{t('purchases.field.currency')}</label>
            <select
              id="credit-currency"
              value={currencyCode}
              onChange={(e) => setCurrencyCode(e.target.value)}
            >
              <option value="">
                {t('purchases.bills.vendorCurrency', { currency: vendor?.currencyCode ?? '' })}
              </option>
              {COMMON_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {issue('currencyCode') ? (
              <small className="field__error">{issue('currencyCode')}</small>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="credit-treatment">{t('sales.field.taxTreatment')}</label>
            <select
              id="credit-treatment"
              value={taxTreatment}
              onChange={(e) =>
                setTaxTreatment(e.target.value as VendorCreditDetail['taxTreatment'])
              }
            >
              <option value="">{t('purchases.bills.defaultTreatment')}</option>
              <option value="exclusive">{t('sales.treatment.exclusive')}</option>
              <option value="inclusive">{t('sales.treatment.inclusive')}</option>
              <option value="no_tax">{t('sales.treatment.no_tax')}</option>
            </select>
          </div>
          {foreign && canPost && !billId ? (
            <>
              <TextField
                label={t('purchases.bills.rateOverride')}
                inputMode="decimal"
                hint={t('purchases.bills.rateHint')}
                value={rateOverride}
                error={issue('rateOverride')}
                onChange={(e) => setRateOverride(e.target.value)}
              />
              <TextField
                label={t('purchases.bills.rateReason')}
                value={rateOverrideReason}
                error={issue('rateOverrideReason')}
                onChange={(e) => setRateOverrideReason(e.target.value)}
              />
            </>
          ) : null}
          {foreign && billId ? (
            <p className="muted">{t('purchases.credits.billRateNote')}</p>
          ) : null}
          {types.map((type) => (
            <div className="field" key={type.id}>
              <label htmlFor={`credit-dim-${type.id}`}>{type.name}</label>
              <select
                id={`credit-dim-${type.id}`}
                value={dims[type.id] ?? ''}
                onChange={(e) => setDims({ ...dims, [type.id]: e.target.value })}
              >
                <option value="">{t('common.none')}</option>
                {type.values
                  .filter((v) => v.status === 'ACTIVE' || v.id === dims[type.id])
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.code} · {v.name}
                    </option>
                  ))}
              </select>
            </div>
          ))}
        </div>
        {issue('dimensionValueIds') ? (
          <small className="field__error">{issue('dimensionValueIds')}</small>
        ) : null}
      </Card>
      <Card title={t('purchases.bills.lines')}>
        <table className="table table--editor">
          <thead>
            <tr>
              <th>{t('purchases.bills.item')}</th>
              <th>{t('purchases.field.description')}</th>
              {canAccounts ? <th>{t('purchases.bills.account')}</th> : null}
              <th className="num">{t('purchases.bills.quantity')}</th>
              <th className="num">{t('purchases.bills.unitPrice')}</th>
              <th>{t('purchases.bills.taxCode')}</th>
              <th>{t('purchases.bills.recoverable')}</th>
              <th>
                <span className="sr-only">{t('common.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const n = index + 1;
              const lineIssue = (field: string) => issue(`lines.${index}.${field}`);
              return (
                <tr key={line.key}>
                  <td>
                    <select
                      aria-label={t('purchases.bills.lineItem', { n })}
                      value={line.itemId}
                      onChange={(e) => update(line.key, { itemId: e.target.value })}
                    >
                      <option value="">{t('purchases.bills.noItem')}</option>
                      {purchasedItems
                        .filter((i) => i.status === 'ACTIVE' || i.id === line.itemId)
                        .map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.sku ? `${i.sku} · ${i.name}` : i.name}
                          </option>
                        ))}
                    </select>
                    {lineIssue('itemId') ? (
                      <small className="field__error">{lineIssue('itemId')}</small>
                    ) : null}
                  </td>
                  <td>
                    <input
                      aria-label={t('purchases.bills.lineDescription', { n })}
                      value={line.description}
                      onChange={(e) => update(line.key, { description: e.target.value })}
                    />
                    {lineIssue('description') ? (
                      <small className="field__error">{lineIssue('description')}</small>
                    ) : null}
                  </td>
                  {canAccounts ? (
                    <td>
                      <select
                        aria-label={t('purchases.bills.lineAccount', { n })}
                        value={line.accountId}
                        onChange={(e) => update(line.key, { accountId: e.target.value })}
                      >
                        <option value="">{t('purchases.bills.defaultAccount')}</option>
                        {purchaseAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} {a.name}
                          </option>
                        ))}
                        {line.accountId &&
                        !purchaseAccounts.some((a) => a.id === line.accountId) ? (
                          <option value={line.accountId}>{line.accountId}</option>
                        ) : null}
                      </select>
                      {lineIssue('accountId') ? (
                        <small className="field__error">{lineIssue('accountId')}</small>
                      ) : null}
                    </td>
                  ) : null}
                  <td>
                    <input
                      aria-label={t('purchases.bills.lineQuantity', { n })}
                      className="num"
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => update(line.key, { quantity: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={t('purchases.bills.linePrice', { n })}
                      className="num"
                      inputMode="decimal"
                      value={line.unitPrice}
                      onChange={(e) => update(line.key, { unitPrice: e.target.value })}
                    />
                    {lineIssue('unitPrice') ? (
                      <small className="field__error">{lineIssue('unitPrice')}</small>
                    ) : null}
                  </td>
                  <td>
                    <select
                      aria-label={t('purchases.bills.lineTax', { n })}
                      value={line.taxCodeId}
                      onChange={(e) => update(line.key, { taxCodeId: e.target.value })}
                    >
                      <option value="">{t('purchases.bills.defaultTax')}</option>
                      <option value="none">{t('sales.editor.noTax')}</option>
                      {(taxCodes.data ?? [])
                        .filter((c) => c.status === 'ACTIVE' || c.id === line.taxCodeId)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code}
                          </option>
                        ))}
                    </select>
                    {lineIssue('taxCodeId') ? (
                      <small className="field__error">{lineIssue('taxCodeId')}</small>
                    ) : null}
                  </td>
                  <td>
                    <select
                      aria-label={t('purchases.bills.lineRecoverable', { n })}
                      value={line.taxRecoverable}
                      onChange={(e) =>
                        update(line.key, {
                          taxRecoverable: e.target.value as LineDraft['taxRecoverable'],
                        })
                      }
                    >
                      <option value="">{t('purchases.bills.recoverableDefault')}</option>
                      <option value="true">{t('purchases.recoverable.yes')}</option>
                      <option value="false">{t('purchases.recoverable.no')}</option>
                    </select>
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      disabled={lines.length === 1}
                      onClick={() => setLines((all) => all.filter((l) => l.key !== line.key))}
                    >
                      {t('common.remove')}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="actions">
          <Button
            variant="secondary"
            disabled={lines.length >= 200}
            onClick={() => setLines((all) => [...all, emptyLine()])}
          >
            {t('purchases.bills.addLine')}
          </Button>
        </p>
        <TextField
          label={t('purchases.field.memo')}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
        <p className="muted">{t('purchases.bills.computedNote')}</p>
      </Card>
      <p className="actions">
        <Button type="submit" busy={saving}>
          {t('purchases.bills.saveDraft')}
        </Button>
      </p>
    </form>
  );
}

export function NewVendorCreditPage() {
  const t = useT();
  const navigate = useNavigate();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const create = useApiMutation((body: Record<string, unknown>) =>
    api.post<VendorCreditDetail>('/purchases/vendor-credits', body),
  );
  return (
    <>
      <PageHeader title={t('purchases.credits.new')} />
      <PurchasesNav />
      <CreditEditor
        existing={null}
        saving={create.isPending}
        error={create.error}
        onSave={(body) =>
          create.mutate(body, {
            onSuccess: (doc) => {
              queryClient.setQueryData(['vendor-credit', org, doc.id], doc);
              void queryClient.invalidateQueries({ queryKey: ['vendor-credits', org] });
              void navigate(`/purchases/vendor-credits/${doc.id}`);
            },
          })
        }
      />
    </>
  );
}

export function EditVendorCreditPage() {
  const t = useT();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const doc = useCredit(id);
  const save = useApiMutation((body: Record<string, unknown>) =>
    api.put<VendorCreditDetail>(`/purchases/vendor-credits/${id}`, {
      ...body,
      version: doc.data!.version,
    }),
  );
  if (doc.isPending) return <Spinner label={t('common.loading')} />;
  if (doc.isError) return <ErrorAlert error={doc.error} />;
  return (
    <>
      <PageHeader title={t('purchases.credits.editTitle')} />
      <PurchasesNav />
      {doc.data.status !== 'DRAFT' ? (
        <Alert tone="info">{t('purchases.credits.notEditable')}</Alert>
      ) : (
        <CreditEditor
          existing={doc.data}
          saving={save.isPending}
          error={save.error}
          onSave={(body) =>
            save.mutate(body, {
              onSuccess: (saved) => {
                queryClient.setQueryData(['vendor-credit', org, id], saved);
                void queryClient.invalidateQueries({ queryKey: ['vendor-credits', org] });
                void navigate(`/purchases/vendor-credits/${id}`);
              },
            })
          }
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail and lifecycle
// ---------------------------------------------------------------------------

/** A debit note's PDF and email (P4-46). */
function DebitNoteOutput({ id, canSend }: { id: string; canSend: boolean }) {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const pdf = useQuery({
    queryKey: ['vendor-credit-pdf', org, id],
    queryFn: () =>
      api.get<{ status: 'ready' | 'pending'; download?: { url: string } }>(
        `/purchases/vendor-credits/${id}/pdf`,
      ),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : false),
  });
  const emails = useQuery({
    queryKey: ['vendor-credit-emails', org, id],
    queryFn: () =>
      api.get<{ id: string; recipient: string; status: string; requestedAt: string }[]>(
        `/purchases/vendor-credits/${id}/emails`,
      ),
  });
  const [to, setTo] = useState('');
  const send = useApiMutation(() =>
    api.post(`/purchases/vendor-credits/${id}/email`, to.trim() ? { to: to.trim() } : {}),
  );
  return (
    <Card title={t('purchases.credits.output')}>
      {pdf.data?.status === 'ready' && pdf.data.download ? (
        <p>
          <a className="btn btn--secondary" href={pdf.data.download.url}>
            {t('purchases.credits.downloadPdf')}
          </a>
        </p>
      ) : (
        <p className="muted">{t('purchases.credits.pdfPending')}</p>
      )}
      {canSend ? (
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate(undefined, {
              onSuccess: () => {
                setTo('');
                void queryClient.invalidateQueries({
                  queryKey: ['vendor-credit-emails', org, id],
                });
              },
            });
          }}
        >
          <ErrorAlert error={send.error} />
          <TextField
            label={t('purchases.credits.emailTo')}
            hint={t('purchases.credits.emailHint')}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <Button type="submit" variant="secondary" busy={send.isPending}>
            {t('purchases.credits.sendEmail')}
          </Button>
        </form>
      ) : null}
      {(emails.data ?? []).length ? (
        <ul>
          {emails.data!.map((e) => (
            <li key={e.id}>
              {e.recipient} · {e.status} · {e.requestedAt.slice(0, 10)}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function VendorCreditDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const doc = useCredit(id);
  const can = {
    edit: usePermission(Permission.VendorCreditsCreate),
    post: usePermission(Permission.VendorCreditsPost),
    void: usePermission(Permission.VendorCreditsVoid),
  };
  const [voidReason, setVoidReason] = useState('');
  const refresh = (data?: VendorCreditDetail) => {
    if (data) queryClient.setQueryData(['vendor-credit', org, id], data);
    void queryClient.invalidateQueries({ queryKey: ['vendor-credits', org] });
  };
  const action = useApiMutation((name: 'submit' | 'withdraw') =>
    api.post<VendorCreditDetail>(`/purchases/vendor-credits/${id}/${name}`, {
      version: doc.data!.version,
    }),
  );
  // P4-42: posting a vendor credit asks for the password again.
  const postCredit = useApiMutation(() =>
    sensitive(() =>
      api.post<VendorCreditDetail>(`/purchases/vendor-credits/${id}/post`, {
        version: doc.data!.version,
      }),
    ),
  );
  const voidCredit = useApiMutation(() =>
    sensitive(() =>
      api.post<VendorCreditDetail>(`/purchases/vendor-credits/${id}/void`, {
        version: doc.data!.version,
        reason: voidReason.trim(),
      }),
    ),
  );
  const remove = useApiMutation(() =>
    api.delete(`/purchases/vendor-credits/${id}?version=${doc.data!.version}`),
  );

  if (doc.isPending) return <Spinner label={t('common.loading')} />;
  if (doc.isError) return <ErrorAlert error={doc.error} />;
  const c = doc.data;
  const cur = c.currencyCode;
  const conflict =
    [action.error, postCredit.error, voidCredit.error, remove.error].find(
      (e) => e instanceof ApiError && e.code === 'VERSION_CONFLICT',
    ) !== undefined;
  const open = c.status === 'DRAFT' || c.status === 'PENDING_APPROVAL';
  const unapplied = c.status === 'POSTED' && c.amountUnapplied === c.total;
  return (
    <>
      <PageHeader
        title={
          c.number
            ? `${t(ORIGIN_LABEL[c.origin])} ${c.number}`
            : t('purchases.credits.draftTitle', { origin: t(ORIGIN_LABEL[c.origin]) })
        }
        description={c.vendorName ?? undefined}
      />
      <PurchasesNav />
      <ErrorAlert error={action.error ?? postCredit.error ?? voidCredit.error ?? remove.error} />
      {conflict ? (
        <Alert tone="info">
          {t('purchases.bills.conflict')}{' '}
          <Button variant="ghost" onClick={() => void doc.refetch()}>
            {t('purchases.bills.reload')}
          </Button>
        </Alert>
      ) : null}
      {c.warnings.map((w) => (
        <Alert key={`${w.code}-${w.message}`} tone="info">
          {w.message}
        </Alert>
      ))}
      <Card title={t('purchases.bills.summary')} actions={<CreditStatusBadge status={c.status} />}>
        <dl className="facts">
          <dt>{t('purchases.credits.origin')}</dt>
          <dd>{t(ORIGIN_LABEL[c.origin])}</dd>
          <dt>{t('purchases.bills.vendor')}</dt>
          <dd>
            <Link to={`/purchases/vendors/${c.vendorId}`}>{c.vendorName}</Link>
          </dd>
          {c.billId ? (
            <>
              <dt>{t('purchases.credits.bill')}</dt>
              <dd>
                <Link to={`/purchases/bills/${c.billId}`}>{c.billNumber ?? c.billId}</Link>
              </dd>
            </>
          ) : null}
          {c.origin === 'supplier_credit_note' ? (
            <>
              <dt>{t('purchases.credits.supplierReference')}</dt>
              <dd>{c.vendorReference ?? t('purchases.bills.noReference')}</dd>
            </>
          ) : null}
          <dt>{t('purchases.credits.date')}</dt>
          <dd>{c.creditDate}</dd>
          <dt>{t('purchases.field.currency')}</dt>
          <dd>{cur}</dd>
          {c.exchangeRate && cur !== c.baseCurrency ? (
            <>
              <dt>{t('purchases.bills.rate')}</dt>
              <dd>
                {Number(c.exchangeRate)} ({c.exchangeRateSource})
                {c.tableRate && c.exchangeRateSource !== 'table'
                  ? ` · ${t('purchases.bills.tableRate', { rate: String(Number(c.tableRate)) })}`
                  : ''}
              </dd>
            </>
          ) : null}
          {c.rateOverride ? (
            <>
              <dt>{t('purchases.bills.rateOverride')}</dt>
              <dd>
                {Number(c.rateOverride)} — {c.rateOverrideReason}
              </dd>
            </>
          ) : null}
          {c.voidReason ? (
            <>
              <dt>{t('purchases.bills.voidReason')}</dt>
              <dd>{c.voidReason}</dd>
            </>
          ) : null}
        </dl>
        <TotalsTable
          currency={cur}
          subtotal={c.subtotal}
          discountTotal={c.discountTotal}
          taxTotal={c.taxTotal}
          total={c.total}
          open={c.amountUnapplied}
          openLabel={t('purchases.credits.unapplied')}
        />
        <div className="actions">
          {c.status === 'DRAFT' && can.edit ? (
            <Link className="btn btn--secondary" to={`/purchases/vendor-credits/${id}/edit`}>
              {t('common.edit')}
            </Link>
          ) : null}
          {c.status === 'DRAFT' && can.edit && c.approval.required && !c.approval.readyToIssue ? (
            <Button
              variant="secondary"
              busy={action.isPending}
              onClick={() => action.mutate('submit', { onSuccess: refresh })}
            >
              {t('purchases.bills.submit')}
            </Button>
          ) : null}
          {c.status === 'PENDING_APPROVAL' && can.edit ? (
            <Button
              variant="secondary"
              busy={action.isPending}
              onClick={() => action.mutate('withdraw', { onSuccess: refresh })}
            >
              {t('purchases.bills.withdraw')}
            </Button>
          ) : null}
          {open && can.post ? (
            <Button
              disabled={!c.approval.readyToIssue}
              busy={postCredit.isPending}
              onClick={() => postCredit.mutate(undefined, { onSuccess: refresh })}
            >
              {t('purchases.bills.post')}
            </Button>
          ) : null}
          {c.status === 'DRAFT' && can.edit ? (
            <Button
              variant="ghost"
              busy={remove.isPending}
              onClick={() => {
                if (window.confirm(t('purchases.credits.confirmDelete'))) {
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      refresh();
                      void navigate('/purchases/vendor-credits');
                    },
                  });
                }
              }}
            >
              {t('common.delete')}
            </Button>
          ) : null}
        </div>
      </Card>

      <ApprovalPanel approval={c.approval} />

      <Card title={t('purchases.bills.lines')}>
        <table className="table">
          <thead>
            <tr>
              <th>{t('purchases.field.description')}</th>
              <th className="num">{t('purchases.bills.quantity')}</th>
              <th className="num">{t('purchases.bills.unitPrice')}</th>
              <th className="num">{t('purchases.bills.net')}</th>
              <th className="num">{t('purchases.bills.tax')}</th>
              <th>{t('purchases.bills.recoverable')}</th>
              <th className="num">{t('purchases.field.total')}</th>
            </tr>
          </thead>
          <tbody>
            {c.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className="num">{l.quantity}</td>
                <td className="num">{l.unitPrice}</td>
                <td className="num">{formatAmount(l.netAmount, cur)}</td>
                <td className="num">
                  {formatAmount(l.taxAmount, cur)}
                  {l.taxRate ? ` (${l.taxRate}%)` : ''}
                </td>
                <td>
                  {l.taxCodeId
                    ? l.taxRecoverable
                      ? t('purchases.recoverable.yes')
                      : t('purchases.recoverable.no')
                    : ''}
                </td>
                <td className="num">{formatAmount(l.total, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {c.memo ? <p className="memo">{c.memo}</p> : null}
      </Card>

      {c.origin === 'debit_note' && (c.status === 'POSTED' || c.status === 'VOID') ? (
        <DebitNoteOutput id={id} canSend={c.status === 'POSTED' && can.post} />
      ) : null}

      {c.status === 'POSTED' && can.void ? (
        <Card title={t('purchases.credits.voidTitle')}>
          {unapplied ? (
            <form
              className="form form--inline"
              onSubmit={(e) => {
                e.preventDefault();
                voidCredit.mutate(undefined, { onSuccess: refresh });
              }}
            >
              <TextField
                label={t('purchases.bills.voidReason')}
                value={voidReason}
                required
                onChange={(e) => setVoidReason(e.target.value)}
              />
              <Button type="submit" variant="secondary" busy={voidCredit.isPending}>
                {t('purchases.bills.void')}
              </Button>
            </form>
          ) : (
            <p className="muted">{t('purchases.credits.voidBlocked')}</p>
          )}
        </Card>
      ) : null}

      <AttachmentsCard
        linkType="vendor_credit"
        linkId={id}
        canChange={can.edit}
        canRemove={can.edit && c.status === 'DRAFT'}
        removeNote={t('purchases.credits.attachmentsLocked')}
      />
    </>
  );
}
