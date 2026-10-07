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
import { ExportButton } from '../data-exchange/ExportButton';
import { PurchasesNav } from './PurchasesSection';
import {
  PURCHASE_ACCOUNT_SUBTYPES,
  type ExpenseDetail,
  type ExpenseStatus,
  type ExpenseSummary,
  type VendorSummary,
} from './types';

/**
 * Direct expenses (Phase 4B-9; ADR 0004 P4-37, P4-44): list with the approval queue, the draft
 * editor, and the detail with submit, withdraw, post (separate from approval), void and the
 * receipt. Every amount is computed by the server; the UI only sends inputs and is
 * permission-aware (the server decides).
 */

const EXPENSE_POST_ACTION = 'purchases.expense.post';

function useExpense(id: string) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['expense', org, id],
    queryFn: () => api.get<ExpenseDetail>(`/purchases/expenses/${id}`),
  });
}

function ExpenseStatusBadge({ status }: { status: ExpenseStatus }) {
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

export function ExpensesPage() {
  const t = useT();
  const org = useOrgKey();
  const canCreate = usePermission(Permission.ExpensesCreate);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState({ status: '', search: '' });
  const list = useQuery({
    queryKey: ['expenses', org, applied],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (applied.status) params.set('status', applied.status);
      if (applied.search.trim()) params.set('search', applied.search.trim());
      return api.get<Page<ExpenseSummary>>(`/purchases/expenses?${params.toString()}`);
    },
  });
  return (
    <>
      <PageHeader
        title={t('purchases.expenses.title')}
        description={t('purchases.expenses.description')}
      />
      <PurchasesNav />
      <p className="actions">
        <ExportButton domain="expenses" label={t('purchases.expenses.export')} />
      </p>
      {canCreate ? (
        <p className="actions">
          <Link className="btn" to="/purchases/expenses/new">
            {t('purchases.expenses.new')}
          </Link>
        </p>
      ) : null}
      <ExpenseApprovalQueue />
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
            hint={t('purchases.expenses.searchHint')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="field">
            <label htmlFor="expense-status">{t('purchases.field.status')}</label>
            <select id="expense-status" value={status} onChange={(e) => setStatus(e.target.value)}>
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
          <p className="muted">{t('purchases.expenses.none')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('purchases.expenses.number')}</th>
                <th>{t('purchases.expenses.payee')}</th>
                <th>{t('purchases.field.vendorReference')}</th>
                <th>{t('purchases.expenses.date')}</th>
                <th className="num">{t('purchases.field.total')}</th>
                <th>{t('purchases.field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/purchases/expenses/${e.id}`}>
                      {e.number ?? t('purchases.expenses.draft')}
                    </Link>
                  </td>
                  <td>{e.vendorName}</td>
                  <td>{e.vendorReference}</td>
                  <td>{e.expenseDate}</td>
                  <td className="num">
                    {formatAmount(e.total, e.currencyCode)} {e.currencyCode}
                  </td>
                  <td>
                    <ExpenseStatusBadge status={e.status} />
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

/** Expenses awaiting approval that the user may decide (the shared approval routes). */
function ExpenseApprovalQueue() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canApprove = usePermission(Permission.ExpensesApprove);
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
    void queryClient.invalidateQueries({ queryKey: ['expenses', org] });
  };
  const pending = (requests.data ?? []).filter((r) => r.actionKey === EXPENSE_POST_ACTION);
  if (!canApprove || pending.length === 0) return null;
  return (
    <Card title={t('purchases.expenses.approvalQueue')}>
      <ErrorAlert error={decide.error} />
      <table className="table">
        <thead>
          <tr>
            <th>{t('purchases.expenses.expense')}</th>
            <th>{t('purchases.expenses.amount')}</th>
            <th>{t('purchases.bills.progress')}</th>
            <th>
              <span className="sr-only">{t('common.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {pending.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/purchases/expenses/${r.subjectId}`}>
                  {t('purchases.expenses.open')}
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
                        label={t('purchases.expenses.rejectReason')}
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

function ExpenseEditor({
  existing,
  saving,
  error,
  onSave,
}: {
  existing: ExpenseDetail | null;
  saving: boolean;
  error: unknown;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const org = useOrgKey();
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
  const [expenseDate, setExpenseDate] = useState(
    existing?.expenseDate ?? new Date().toISOString().slice(0, 10),
  );
  const [vendorReference, setVendorReference] = useState(existing?.vendorReference ?? '');
  const [currencyCode, setCurrencyCode] = useState(existing?.currencyCode ?? '');
  const [paymentAccountId, setPaymentAccountId] = useState(existing?.paymentAccountId ?? '');
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
  const paymentAccounts = (accounts.data ?? []).filter(
    (a) =>
      a.status === 'ACTIVE' &&
      a.isLeaf !== false &&
      !a.isControlAccount &&
      (a.isBankOrCash || a.subtype === 'CREDIT_CARD'),
  );
  const purchasedItems = (items.data?.items ?? []).filter((i) => i.isPurchased);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      vendorId,
      expenseDate,
      vendorReference: orNull(vendorReference),
      ...(currencyCode ? { currencyCode } : {}),
      paymentAccountId: paymentAccountId || null,
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
      <Card title={t('purchases.expenses.details')}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="expense-vendor">{t('purchases.expenses.payee')}</label>
            <select
              id="expense-vendor"
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
            hint={t('purchases.expenses.referenceHint')}
            value={vendorReference}
            error={issue('vendorReference')}
            onChange={(e) => setVendorReference(e.target.value)}
          />
          <TextField
            label={t('purchases.expenses.date')}
            type="date"
            value={expenseDate}
            required
            error={issue('expenseDate')}
            onChange={(e) => setExpenseDate(e.target.value)}
          />
          <div className="field">
            <label htmlFor="expense-account">{t('purchases.expenses.paidFrom')}</label>
            <select
              id="expense-account"
              value={paymentAccountId}
              onChange={(e) => setPaymentAccountId(e.target.value)}
            >
              <option value="">{t('purchases.expenses.defaultAccount')}</option>
              {paymentAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
            {issue('paymentAccountId') ? (
              <small className="field__error">{issue('paymentAccountId')}</small>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="expense-currency">{t('purchases.field.currency')}</label>
            <select
              id="expense-currency"
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
            <label htmlFor="expense-treatment">{t('sales.field.taxTreatment')}</label>
            <select
              id="expense-treatment"
              value={taxTreatment}
              onChange={(e) => setTaxTreatment(e.target.value as ExpenseDetail['taxTreatment'])}
            >
              <option value="">{t('purchases.bills.defaultTreatment')}</option>
              <option value="exclusive">{t('sales.treatment.exclusive')}</option>
              <option value="inclusive">{t('sales.treatment.inclusive')}</option>
              <option value="no_tax">{t('sales.treatment.no_tax')}</option>
            </select>
          </div>
          {foreign ? (
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
              <label htmlFor={`expense-dim-${type.id}`}>{type.name}</label>
              <select
                id={`expense-dim-${type.id}`}
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

export function NewExpensePage() {
  const t = useT();
  const navigate = useNavigate();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const create = useApiMutation((body: Record<string, unknown>) =>
    api.post<ExpenseDetail>('/purchases/expenses', body),
  );
  return (
    <>
      <PageHeader title={t('purchases.expenses.new')} />
      <PurchasesNav />
      <ExpenseEditor
        existing={null}
        saving={create.isPending}
        error={create.error}
        onSave={(body) =>
          create.mutate(body, {
            onSuccess: (expense) => {
              queryClient.setQueryData(['expense', org, expense.id], expense);
              void queryClient.invalidateQueries({ queryKey: ['expenses', org] });
              void navigate(`/purchases/expenses/${expense.id}`);
            },
          })
        }
      />
    </>
  );
}

export function EditExpensePage() {
  const t = useT();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const expense = useExpense(id);
  const save = useApiMutation((body: Record<string, unknown>) =>
    api.put<ExpenseDetail>(`/purchases/expenses/${id}`, {
      ...body,
      version: expense.data!.version,
    }),
  );
  if (expense.isPending) return <Spinner label={t('common.loading')} />;
  if (expense.isError) return <ErrorAlert error={expense.error} />;
  return (
    <>
      <PageHeader title={t('purchases.expenses.editTitle')} />
      <PurchasesNav />
      {expense.data.status !== 'DRAFT' ? (
        <Alert tone="info">{t('purchases.expenses.notEditable')}</Alert>
      ) : (
        <ExpenseEditor
          existing={expense.data}
          saving={save.isPending}
          error={save.error}
          onSave={(body) =>
            save.mutate(body, {
              onSuccess: (saved) => {
                queryClient.setQueryData(['expense', org, id], saved);
                void queryClient.invalidateQueries({ queryKey: ['expenses', org] });
                void navigate(`/purchases/expenses/${id}`);
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

export function ExpenseDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const expense = useExpense(id);
  const accounts = useAccounts(usePermission(Permission.AccountsView));
  const can = {
    create: usePermission(Permission.ExpensesCreate),
    void: usePermission(Permission.ExpensesVoid),
    journals: usePermission(Permission.JournalsView),
  };
  const [voidReason, setVoidReason] = useState('');
  const refresh = (data?: ExpenseDetail) => {
    if (data) queryClient.setQueryData(['expense', org, id], data);
    void queryClient.invalidateQueries({ queryKey: ['expenses', org] });
  };
  const action = useApiMutation((name: 'submit' | 'withdraw' | 'post') =>
    api.post<ExpenseDetail>(`/purchases/expenses/${id}/${name}`, {
      version: expense.data!.version,
    }),
  );
  const voidExpense = useApiMutation(() =>
    sensitive(() =>
      api.post<ExpenseDetail>(`/purchases/expenses/${id}/void`, {
        version: expense.data!.version,
        reason: voidReason.trim(),
      }),
    ),
  );
  const remove = useApiMutation(() =>
    api.delete(`/purchases/expenses/${id}?version=${expense.data!.version}`),
  );

  if (expense.isPending) return <Spinner label={t('common.loading')} />;
  if (expense.isError) return <ErrorAlert error={expense.error} />;
  const e = expense.data;
  const c = e.currencyCode;
  const paidFrom = e.paymentAccountId ?? e.defaultPaymentAccountId;
  const account = (accounts.data ?? []).find((a) => a.id === paidFrom);
  const conflict =
    [action.error, voidExpense.error, remove.error].find(
      (x) => x instanceof ApiError && x.code === 'VERSION_CONFLICT',
    ) !== undefined;
  const open = e.status === 'DRAFT' || e.status === 'PENDING_APPROVAL';
  return (
    <>
      <PageHeader
        title={
          e.number
            ? t('purchases.expenses.titleNumber', { number: e.number })
            : t('purchases.expenses.draftTitle')
        }
        description={e.vendorName ?? undefined}
      />
      <PurchasesNav />
      <ErrorAlert error={action.error ?? voidExpense.error ?? remove.error} />
      {conflict ? (
        <Alert tone="info">
          {t('purchases.expenses.conflict')}{' '}
          <Button variant="ghost" onClick={() => void expense.refetch()}>
            {t('purchases.bills.reload')}
          </Button>
        </Alert>
      ) : null}
      {e.warnings.map((w) => (
        <Alert key={`${w.code}-${w.message}`} tone="info">
          {w.message}
        </Alert>
      ))}
      <Card
        title={t('purchases.expenses.summary')}
        actions={<ExpenseStatusBadge status={e.status} />}
      >
        <dl className="facts">
          <dt>{t('purchases.expenses.payee')}</dt>
          <dd>
            <Link to={`/purchases/vendors/${e.vendorId}`}>{e.vendorName}</Link>
          </dd>
          <dt>{t('purchases.field.vendorReference')}</dt>
          <dd>{e.vendorReference ?? t('purchases.bills.noReference')}</dd>
          <dt>{t('purchases.expenses.date')}</dt>
          <dd>{e.expenseDate}</dd>
          <dt>{t('purchases.expenses.paidFrom')}</dt>
          <dd>
            {account ? `${account.code} ${account.name}` : (paidFrom ?? t('common.none'))}
            {e.paymentAccountId === null && paidFrom ? ` (${t('purchases.expenses.default')})` : ''}
          </dd>
          <dt>{t('purchases.field.currency')}</dt>
          <dd>{c}</dd>
          {e.exchangeRate && c !== e.baseCurrency ? (
            <>
              <dt>{t('purchases.bills.rate')}</dt>
              <dd>
                {Number(e.exchangeRate)} ({e.exchangeRateSource})
              </dd>
            </>
          ) : null}
          {e.rateOverride ? (
            <>
              <dt>{t('purchases.bills.rateOverride')}</dt>
              <dd>
                {Number(e.rateOverride)} — {e.rateOverrideReason}
              </dd>
            </>
          ) : null}
          {e.voidReason ? (
            <>
              <dt>{t('purchases.bills.voidReason')}</dt>
              <dd>{e.voidReason}</dd>
            </>
          ) : null}
          {e.journalId && can.journals ? (
            <>
              <dt>{t('purchases.payments.journalLabel')}</dt>
              <dd>
                <Link to={`/accounting/journals/${e.journalId}`}>
                  {t('purchases.payments.journal')}
                </Link>
              </dd>
            </>
          ) : null}
        </dl>
        <TotalsTable
          currency={c}
          subtotal={e.subtotal}
          discountTotal={e.discountTotal}
          taxTotal={e.taxTotal}
          total={e.total}
        />
        <p className="muted">
          {t('purchases.bills.recoverableTotal', {
            amount: formatAmount(e.recoverableTaxTotal, c),
            currency: c,
          })}
        </p>
        <div className="actions">
          {e.status === 'DRAFT' && can.create ? (
            <Link className="btn btn--secondary" to={`/purchases/expenses/${id}/edit`}>
              {t('common.edit')}
            </Link>
          ) : null}
          {e.status === 'DRAFT' && can.create && e.approval.required && !e.approval.readyToIssue ? (
            <Button
              variant="secondary"
              busy={action.isPending}
              onClick={() => action.mutate('submit', { onSuccess: refresh })}
            >
              {t('purchases.bills.submit')}
            </Button>
          ) : null}
          {e.status === 'PENDING_APPROVAL' && can.create ? (
            <Button
              variant="secondary"
              busy={action.isPending}
              onClick={() => action.mutate('withdraw', { onSuccess: refresh })}
            >
              {t('purchases.bills.withdraw')}
            </Button>
          ) : null}
          {open && can.create ? (
            <Button
              disabled={!e.approval.readyToIssue}
              busy={action.isPending}
              onClick={() => action.mutate('post', { onSuccess: refresh })}
            >
              {t('purchases.expenses.post')}
            </Button>
          ) : null}
          {e.status === 'DRAFT' && can.create ? (
            <Button
              variant="ghost"
              busy={remove.isPending}
              onClick={() => {
                if (window.confirm(t('purchases.expenses.confirmDelete'))) {
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      refresh();
                      void navigate('/purchases/expenses');
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

      <ApprovalPanel approval={e.approval} readyMessage="purchases.approval.readyPost" />

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
            {e.lines.map((l) => (
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
        {e.memo ? <p className="memo">{e.memo}</p> : null}
      </Card>

      {e.status === 'POSTED' && can.void ? (
        <Card title={t('purchases.expenses.voidTitle')}>
          <form
            className="form form--inline"
            onSubmit={(ev) => {
              ev.preventDefault();
              voidExpense.mutate(undefined, { onSuccess: refresh });
            }}
          >
            <TextField
              label={t('purchases.bills.voidReason')}
              value={voidReason}
              required
              onChange={(ev) => setVoidReason(ev.target.value)}
            />
            <Button type="submit" variant="secondary" busy={voidExpense.isPending}>
              {t('purchases.expenses.void')}
            </Button>
          </form>
        </Card>
      ) : null}

      <AttachmentsCard
        linkType="expense"
        linkId={id}
        canChange={can.create}
        canRemove={can.create && e.status === 'DRAFT'}
        removeNote={t('purchases.expenses.attachmentsLocked')}
      />
    </>
  );
}
