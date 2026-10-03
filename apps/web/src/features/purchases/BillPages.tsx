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
  type BillDetail,
  type BillStatus,
  type BillSummary,
  type VendorSummary,
} from './types';

/**
 * Bills (Phase 4A-5; ADR 0004 P4-15 to P4-22): list with the approval queue, the draft editor,
 * and the detail with submit, withdraw, Post (separate from approval), duplicate confirmation,
 * void and evidence. Every amount is computed by the server; the UI only sends inputs and is
 * permission-aware (the server decides).
 */

const BILL_POST_ACTION = 'purchases.bill.post';

function useBill(id: string) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['bill', org, id],
    queryFn: () => api.get<BillDetail>(`/purchases/bills/${id}`),
  });
}

// ---------------------------------------------------------------------------
// List and approval queue
// ---------------------------------------------------------------------------

export function BillsPage() {
  const t = useT();
  const org = useOrgKey();
  const canCreate = usePermission(Permission.BillsCreate);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState({ status: '', search: '' });
  const list = useQuery({
    queryKey: ['bills', org, applied],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (applied.status) params.set('status', applied.status);
      if (applied.search.trim()) params.set('search', applied.search.trim());
      return api.get<Page<BillSummary>>(`/purchases/bills?${params.toString()}`);
    },
  });
  return (
    <>
      <PageHeader
        title={t('purchases.bills.title')}
        description={t('purchases.bills.description')}
      />
      <PurchasesNav />
      {canCreate ? (
        <p className="actions">
          <Link className="btn" to="/purchases/bills/new">
            {t('purchases.bills.new')}
          </Link>
        </p>
      ) : null}
      <BillApprovalQueue />
      <Card>
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ status, search });
          }}
        >
          <TextField
            label={t('common.search')}
            hint={t('purchases.bills.searchHint')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="field">
            <label htmlFor="bill-status">{t('purchases.field.status')}</label>
            <select id="bill-status" value={status} onChange={(e) => setStatus(e.target.value)}>
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
          <p className="muted">{t('purchases.bills.none')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('purchases.bills.number')}</th>
                <th>{t('purchases.bills.vendor')}</th>
                <th>{t('purchases.field.vendorReference')}</th>
                <th>{t('purchases.field.billDate')}</th>
                <th>{t('purchases.field.dueDate')}</th>
                <th className="num">{t('purchases.field.total')}</th>
                <th>{t('purchases.field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link to={`/purchases/bills/${b.id}`}>
                      {b.number ?? t('purchases.bills.draft')}
                    </Link>
                  </td>
                  <td>{b.vendorName}</td>
                  <td>{b.vendorReference}</td>
                  <td>{b.billDate}</td>
                  <td>{b.dueDate}</td>
                  <td className="num">
                    {formatAmount(b.total, b.currencyCode)} {b.currencyCode}
                  </td>
                  <td>
                    <BillStatusBadge status={b.status} />
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

function BillStatusBadge({ status }: { status: BillStatus }) {
  const t = useT();
  return status === 'POSTED' ? (
    <span className="badge badge--posted">{t('purchases.status.posted')}</span>
  ) : (
    <StatusBadge status={status} />
  );
}

/** Bills awaiting approval that the user may decide (the shared approval routes). */
function BillApprovalQueue() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canApprove = usePermission(Permission.BillsApprove);
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
    void queryClient.invalidateQueries({ queryKey: ['bills', org] });
  };
  const bills = (requests.data ?? []).filter((r) => r.actionKey === BILL_POST_ACTION);
  if (!canApprove || bills.length === 0) return null;
  return (
    <Card title={t('purchases.bills.approvalQueue')}>
      <ErrorAlert error={decide.error} />
      <table className="table">
        <thead>
          <tr>
            <th>{t('purchases.bills.bill')}</th>
            <th>{t('purchases.bills.amount')}</th>
            <th>{t('purchases.bills.progress')}</th>
            <th>
              <span className="sr-only">{t('common.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {bills.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/purchases/bills/${r.subjectId}`}>{t('purchases.bills.open')}</Link>
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
  /** '' = the default applies (P4-12). */
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

function BillEditor({
  existing,
  saving,
  error,
  onSave,
}: {
  existing: BillDetail | null;
  saving: boolean;
  error: unknown;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const org = useOrgKey();
  const canPost = usePermission(Permission.BillsPost);
  const canAccounts = usePermission(Permission.AccountsView);
  const canDimensions = usePermission(Permission.DimensionsView);
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

  const [vendorId, setVendorId] = useState(existing?.vendorId ?? '');
  const [billDate, setBillDate] = useState(
    existing?.billDate ?? new Date().toISOString().slice(0, 10),
  );
  const [dueDate, setDueDate] = useState(
    existing && existing.paymentTermsDays === null ? existing.dueDate : '',
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
      vendorId,
      billDate,
      dueDate: dueDate || null,
      vendorReference: orNull(vendorReference),
      ...(currencyCode ? { currencyCode } : {}),
      rateOverride: orNull(rateOverride),
      rateOverrideReason: orNull(rateOverrideReason),
      ...(taxTreatment ? { taxTreatment } : {}),
      memo: memo.trim(),
      dimensionValueIds: Object.values(dims).filter(Boolean),
      lines: lines.map((l) => ({
        ...(l.itemId ? { itemId: l.itemId } : {}),
        ...(l.description.trim() ? { description: l.description.trim() } : {}),
        ...(l.accountId ? { accountId: l.accountId } : {}),
        quantity: l.quantity,
        ...(l.unitPrice.trim() ? { unitPrice: l.unitPrice.trim() } : {}),
        // '' sends nothing: the item, vendor or Purchases default applies.
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
      <Card title={t('purchases.bills.details')}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="bill-vendor">{t('purchases.bills.vendor')}</label>
            <select
              id="bill-vendor"
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
            {issue('vendorId') ? <small className="field__error">{issue('vendorId')}</small> : null}
          </div>
          <TextField
            label={t('purchases.field.vendorReference')}
            hint={t('purchases.bills.referenceHint')}
            value={vendorReference}
            error={issue('vendorReference')}
            onChange={(e) => setVendorReference(e.target.value)}
          />
          <TextField
            label={t('purchases.field.billDate')}
            type="date"
            value={billDate}
            required
            error={issue('billDate')}
            onChange={(e) => setBillDate(e.target.value)}
          />
          <TextField
            label={t('purchases.field.dueDate')}
            type="date"
            value={dueDate}
            hint={t('purchases.bills.dueHint')}
            error={issue('dueDate')}
            onChange={(e) => setDueDate(e.target.value)}
          />
          <div className="field">
            <label htmlFor="bill-currency">{t('purchases.field.currency')}</label>
            <select
              id="bill-currency"
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
          </div>
          <div className="field">
            <label htmlFor="bill-treatment">{t('sales.field.taxTreatment')}</label>
            <select
              id="bill-treatment"
              value={taxTreatment}
              onChange={(e) => setTaxTreatment(e.target.value as BillDetail['taxTreatment'])}
            >
              <option value="">{t('purchases.bills.defaultTreatment')}</option>
              <option value="exclusive">{t('sales.treatment.exclusive')}</option>
              <option value="inclusive">{t('sales.treatment.inclusive')}</option>
              <option value="no_tax">{t('sales.treatment.no_tax')}</option>
            </select>
          </div>
          {foreign && canPost ? (
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
          {types.map((type) => (
            <div className="field" key={type.id}>
              <label htmlFor={`bill-dim-${type.id}`}>{type.name}</label>
              <select
                id={`bill-dim-${type.id}`}
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

export function NewBillPage() {
  const t = useT();
  const navigate = useNavigate();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const create = useApiMutation((body: Record<string, unknown>) =>
    api.post<BillDetail>('/purchases/bills', body),
  );
  return (
    <>
      <PageHeader title={t('purchases.bills.new')} />
      <PurchasesNav />
      <BillEditor
        existing={null}
        saving={create.isPending}
        error={create.error}
        onSave={(body) =>
          create.mutate(body, {
            onSuccess: (bill) => {
              queryClient.setQueryData(['bill', org, bill.id], bill);
              void queryClient.invalidateQueries({ queryKey: ['bills', org] });
              void navigate(`/purchases/bills/${bill.id}`);
            },
          })
        }
      />
    </>
  );
}

export function EditBillPage() {
  const t = useT();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const bill = useBill(id);
  const save = useApiMutation((body: Record<string, unknown>) =>
    api.put<BillDetail>(`/purchases/bills/${id}`, { ...body, version: bill.data!.version }),
  );
  if (bill.isPending) return <Spinner label={t('common.loading')} />;
  if (bill.isError) return <ErrorAlert error={bill.error} />;
  return (
    <>
      <PageHeader title={t('purchases.bills.editTitle')} />
      <PurchasesNav />
      {bill.data.status !== 'DRAFT' ? (
        <Alert tone="info">{t('purchases.bills.notEditable')}</Alert>
      ) : (
        <BillEditor
          existing={bill.data}
          saving={save.isPending}
          error={save.error}
          onSave={(body) =>
            save.mutate(body, {
              onSuccess: (saved) => {
                queryClient.setQueryData(['bill', org, id], saved);
                void queryClient.invalidateQueries({ queryKey: ['bills', org] });
                void navigate(`/purchases/bills/${id}`);
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

export function BillDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const bill = useBill(id);
  const can = {
    edit: usePermission(Permission.BillsEditDraft),
    remove: usePermission(Permission.BillsDeleteDraft),
    submit: usePermission(Permission.BillsCreate),
    post: usePermission(Permission.BillsPost),
    void: usePermission(Permission.BillsVoid),
    attach: usePermission(Permission.BillsCreate),
  };
  const [voidReason, setVoidReason] = useState('');
  const [duplicateReason, setDuplicateReason] = useState('');
  const refresh = (data?: BillDetail) => {
    if (data) queryClient.setQueryData(['bill', org, id], data);
    void queryClient.invalidateQueries({ queryKey: ['bills', org] });
  };
  const action = useApiMutation((name: 'submit' | 'withdraw') =>
    api.post<BillDetail>(`/purchases/bills/${id}/${name}`, { version: bill.data!.version }),
  );
  const postBill = useApiMutation((reason: string | null) =>
    api.post<BillDetail>(`/purchases/bills/${id}/post`, {
      version: bill.data!.version,
      ...(reason ? { duplicateReason: reason } : {}),
    }),
  );
  const voidBill = useApiMutation(() =>
    sensitive(() =>
      api.post<BillDetail>(`/purchases/bills/${id}/void`, {
        version: bill.data!.version,
        reason: voidReason.trim(),
      }),
    ),
  );
  const remove = useApiMutation(() =>
    api.delete(`/purchases/bills/${id}?version=${bill.data!.version}`),
  );

  if (bill.isPending) return <Spinner label={t('common.loading')} />;
  if (bill.isError) return <ErrorAlert error={bill.error} />;
  const b = bill.data;
  const c = b.currencyCode;
  const duplicate =
    postBill.error instanceof ApiError && postBill.error.code === 'DUPLICATE_VENDOR_REFERENCE';
  const conflict =
    [action.error, postBill.error, voidBill.error, remove.error].find(
      (e) => e instanceof ApiError && e.code === 'VERSION_CONFLICT',
    ) !== undefined;
  const open = b.status === 'DRAFT' || b.status === 'PENDING_APPROVAL';
  const unpaid = b.status === 'POSTED' && b.amountDue === b.total;
  return (
    <>
      <PageHeader
        title={
          b.number
            ? t('purchases.bills.titleNumber', { number: b.number })
            : t('purchases.bills.draftTitle')
        }
        description={b.vendorName ?? undefined}
      />
      <PurchasesNav />
      <ErrorAlert
        error={
          action.error ?? (duplicate ? null : postBill.error) ?? voidBill.error ?? remove.error
        }
      />
      {conflict ? (
        <Alert tone="info">
          {t('purchases.bills.conflict')}{' '}
          <Button variant="ghost" onClick={() => void bill.refetch()}>
            {t('purchases.bills.reload')}
          </Button>
        </Alert>
      ) : null}
      {b.warnings.map((w) => (
        <Alert key={`${w.code}-${w.message}`} tone="info">
          {w.message}
        </Alert>
      ))}
      <Card title={t('purchases.bills.summary')} actions={<BillStatusBadge status={b.status} />}>
        <dl className="facts">
          <dt>{t('purchases.bills.vendor')}</dt>
          <dd>
            <Link to={`/purchases/vendors/${b.vendorId}`}>{b.vendorName}</Link>
          </dd>
          <dt>{t('purchases.field.vendorReference')}</dt>
          <dd>{b.vendorReference ?? t('purchases.bills.noReference')}</dd>
          <dt>{t('purchases.field.billDate')}</dt>
          <dd>{b.billDate}</dd>
          <dt>{t('purchases.field.dueDate')}</dt>
          <dd>{b.dueDate}</dd>
          <dt>{t('purchases.field.currency')}</dt>
          <dd>{c}</dd>
          {b.exchangeRate && c !== b.baseCurrency ? (
            <>
              <dt>{t('purchases.bills.rate')}</dt>
              <dd>
                {Number(b.exchangeRate)} ({b.exchangeRateSource})
                {b.tableRate && b.exchangeRateSource === 'manual'
                  ? ` · ${t('purchases.bills.tableRate', { rate: String(Number(b.tableRate)) })}`
                  : ''}
              </dd>
            </>
          ) : null}
          {b.rateOverride ? (
            <>
              <dt>{t('purchases.bills.rateOverride')}</dt>
              <dd>
                {Number(b.rateOverride)} — {b.rateOverrideReason}
              </dd>
            </>
          ) : null}
          {b.duplicateConfirmedReason ? (
            <>
              <dt>{t('purchases.bills.duplicateReason')}</dt>
              <dd>{b.duplicateConfirmedReason}</dd>
            </>
          ) : null}
          {b.voidReason ? (
            <>
              <dt>{t('purchases.bills.voidReason')}</dt>
              <dd>{b.voidReason}</dd>
            </>
          ) : null}
        </dl>
        <TotalsTable
          currency={c}
          subtotal={b.subtotal}
          discountTotal={b.discountTotal}
          taxTotal={b.taxTotal}
          total={b.total}
          open={b.amountDue}
          openLabel={t('purchases.field.amountDue')}
        />
        <p className="muted">
          {t('purchases.bills.recoverableTotal', {
            amount: formatAmount(b.recoverableTaxTotal, c),
            currency: c,
          })}
        </p>
        <div className="actions">
          {b.status === 'DRAFT' && can.edit ? (
            <Link className="btn btn--secondary" to={`/purchases/bills/${id}/edit`}>
              {t('common.edit')}
            </Link>
          ) : null}
          {b.status === 'DRAFT' && can.submit && b.approval.required && !b.approval.readyToIssue ? (
            <Button
              variant="secondary"
              busy={action.isPending}
              onClick={() => action.mutate('submit', { onSuccess: refresh })}
            >
              {t('purchases.bills.submit')}
            </Button>
          ) : null}
          {b.status === 'PENDING_APPROVAL' && can.submit ? (
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
              disabled={!b.approval.readyToIssue}
              busy={postBill.isPending}
              onClick={() => postBill.mutate(null, { onSuccess: refresh })}
            >
              {t('purchases.bills.post')}
            </Button>
          ) : null}
          {b.status === 'DRAFT' && can.remove ? (
            <Button
              variant="ghost"
              busy={remove.isPending}
              onClick={() => {
                if (window.confirm(t('purchases.bills.confirmDelete'))) {
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      refresh();
                      void navigate('/purchases/bills');
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

      {duplicate ? (
        <Card title={t('purchases.bills.duplicateTitle')}>
          <Alert>{(postBill.error as ApiError).message}</Alert>
          <form
            className="form form--inline"
            onSubmit={(e) => {
              e.preventDefault();
              postBill.mutate(duplicateReason.trim(), {
                onSuccess: (data) => {
                  setDuplicateReason('');
                  refresh(data);
                },
              });
            }}
          >
            <TextField
              label={t('purchases.bills.duplicateReason')}
              value={duplicateReason}
              required
              onChange={(e) => setDuplicateReason(e.target.value)}
            />
            <Button type="submit" busy={postBill.isPending}>
              {t('purchases.bills.postAnyway')}
            </Button>
          </form>
        </Card>
      ) : null}

      <ApprovalPanel approval={b.approval} />

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
            {b.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className="num">{l.quantity}</td>
                <td className="num">{l.unitPrice}</td>
                <td className="num">{formatAmount(l.netAmount, c)}</td>
                <td className="num">
                  {formatAmount(l.taxAmount, c)}
                  {l.taxRate ? ` (${l.taxRate}%)` : ''}
                </td>
                <td>
                  {l.taxCodeId
                    ? l.taxRecoverable
                      ? t('purchases.recoverable.yes')
                      : t('purchases.recoverable.no')
                    : ''}
                </td>
                <td className="num">{formatAmount(l.total, c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {b.memo ? <p className="memo">{b.memo}</p> : null}
      </Card>

      {b.status === 'POSTED' && can.void ? (
        <Card title={t('purchases.bills.voidTitle')}>
          {unpaid ? (
            <form
              className="form form--inline"
              onSubmit={(e) => {
                e.preventDefault();
                voidBill.mutate(undefined, { onSuccess: refresh });
              }}
            >
              <TextField
                label={t('purchases.bills.voidReason')}
                value={voidReason}
                required
                onChange={(e) => setVoidReason(e.target.value)}
              />
              <Button type="submit" variant="secondary" busy={voidBill.isPending}>
                {t('purchases.bills.void')}
              </Button>
            </form>
          ) : (
            <p className="muted">{t('purchases.bills.voidBlocked')}</p>
          )}
        </Card>
      ) : null}

      <AttachmentsCard
        linkType="bill"
        linkId={id}
        canChange={can.attach}
        canRemove={can.attach && b.status === 'DRAFT'}
        removeNote={t('purchases.bills.attachmentsLocked')}
      />
    </>
  );
}
