import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { useT } from '../../i18n/i18n';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { ExportButton } from '../data-exchange/ExportButton';
import { AttachmentsCard } from '../files/AttachmentsCard';
import { DocumentEditor } from './DocumentEditor';
import { ApprovalPanel, LinesTable, OutputPanel, TotalsTable } from './DocumentParts';
import { issueHint, SalesNav, StatusBadge, useOrgKey } from './shared';
import type { InvoiceDetail, InvoiceSummary, Page } from './types';

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function InvoicesPage() {
  const t = useT();
  const org = useOrgKey();
  const [filters, setFilters] = useState({ search: '', status: '', open: false });
  const [applied, setApplied] = useState(filters);
  const list = useInfiniteQuery({
    queryKey: ['invoices', org, applied],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (applied.search.trim()) params.set('search', applied.search.trim());
      if (applied.status) params.set('status', applied.status);
      if (applied.open) params.set('open', 'true');
      if (pageParam) params.set('after', pageParam);
      return api.get<Page<InvoiceSummary>>(`/sales/invoices?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader title={t('sales.invoices.title')} description={t('sales.invoices.description')} />
      <SalesNav />
      <p className="actions">
        <ExportButton domain="invoices" label={t('sales.invoices.export')} />
      </p>
      <Card
        actions={
          <Can permission={Permission.InvoicesCreate}>
            <Link className="btn btn--primary" to="/sales/invoices/new">
              {t('sales.invoices.new')}
            </Link>
          </Can>
        }
      >
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(filters);
          }}
        >
          <TextField
            label={t('common.search')}
            value={filters.search}
            placeholder={t('sales.invoices.searchHint')}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <div className="field">
            <label htmlFor="invoice-status">{t('sales.field.status')}</label>
            <select
              id="invoice-status"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">{t('common.all')}</option>
              <option value="DRAFT">{t('sales.status.draft')}</option>
              <option value="PENDING_APPROVAL">{t('sales.status.pendingApproval')}</option>
              <option value="ISSUED">{t('sales.status.issued')}</option>
              <option value="VOID">{t('sales.status.void')}</option>
            </select>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={filters.open}
              onChange={(e) => setFilters({ ...filters, open: e.target.checked })}
            />
            {t('sales.invoices.openOnly')}
          </label>
          <Button type="submit">{t('common.search')}</Button>
        </form>
      </Card>
      <Card>
        {list.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : items.length === 0 ? (
          <p className="muted">{t('sales.invoices.none')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('sales.field.number')}</th>
                <th>{t('sales.field.customer')}</th>
                <th>{t('sales.field.invoiceDate')}</th>
                <th>{t('sales.field.dueDate')}</th>
                <th className="num">{t('sales.field.total')}</th>
                <th className="num">{t('sales.field.amountDue')}</th>
                <th>{t('sales.field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link to={`/sales/invoices/${i.id}`}>
                      {i.number ?? t('sales.invoices.draftNumber')}
                    </Link>
                    {i.kind === 'opening' ? (
                      <span className="badge">{t('sales.invoices.opening')}</span>
                    ) : null}
                  </td>
                  <td>{i.customerName}</td>
                  <td>{i.invoiceDate}</td>
                  <td>{i.dueDate}</td>
                  <td className="num">
                    {formatAmount(i.total, i.currencyCode)} {i.currencyCode}
                  </td>
                  <td className="num">
                    {i.amountDue === null ? '' : formatAmount(i.amountDue, i.currencyCode)}
                  </td>
                  <td>
                    <StatusBadge status={i.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {list.hasNextPage ? (
          <Button
            variant="secondary"
            busy={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('common.loadMore')}
          </Button>
        ) : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export function NewInvoicePage() {
  const t = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const create = useApiMutation((body: Record<string, unknown>) =>
    api.post<InvoiceDetail>('/sales/invoices', body),
  );
  return (
    <>
      <PageHeader title={t('sales.invoices.new')} />
      <SalesNav />
      <DocumentEditor
        kind="invoice"
        existing={null}
        presetCustomerId={params.get('customerId') ?? undefined}
        saving={create.isPending}
        error={create.error}
        onSave={(body) =>
          create.mutate(body, {
            onSuccess: (invoice) => void navigate(`/sales/invoices/${invoice.id}`),
          })
        }
      />
    </>
  );
}

function useInvoice(id: string) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['invoice', org, id],
    queryFn: () => api.get<InvoiceDetail>(`/sales/invoices/${id}`),
  });
}

export function EditInvoicePage() {
  const t = useT();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const invoice = useInvoice(id);
  const save = useApiMutation((body: Record<string, unknown>) =>
    api.put<InvoiceDetail>(`/sales/invoices/${id}`, { ...body, version: invoice.data!.version }),
  );
  if (invoice.isPending) return <Spinner label={t('common.loading')} />;
  if (invoice.isError) return <ErrorAlert error={invoice.error} />;
  return (
    <>
      <PageHeader title={t('sales.invoices.edit')} />
      <SalesNav />
      <DocumentEditor
        kind="invoice"
        existing={invoice.data}
        saving={save.isPending}
        error={save.error}
        onSave={(body) =>
          save.mutate(body, {
            onSuccess: (saved) => {
              queryClient.setQueryData(['invoice', org, id], saved);
              void navigate(`/sales/invoices/${id}`);
            },
          })
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail and lifecycle (D1: approve, then Issue; D8: void)
// ---------------------------------------------------------------------------

export function InvoiceDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const invoice = useInvoice(id);
  const can = {
    edit: usePermission(Permission.InvoicesEditDraft),
    remove: usePermission(Permission.InvoicesDeleteDraft),
    submit: usePermission(Permission.InvoicesCreate),
    issue: usePermission(Permission.InvoicesIssue),
    void: usePermission(Permission.InvoicesVoid),
    receipt: usePermission(Permission.ReceiptsCreate),
    credit: usePermission(Permission.CreditNotesCreate),
    attach: usePermission(Permission.InvoicesCreate),
  };
  const [voidReason, setVoidReason] = useState('');
  const refresh = (data?: InvoiceDetail) => {
    if (data) queryClient.setQueryData(['invoice', org, id], data);
    void queryClient.invalidateQueries({ queryKey: ['invoices', org] });
  };
  const action = useApiMutation((name: 'submit' | 'withdraw' | 'issue') =>
    api.post<InvoiceDetail>(`/sales/invoices/${id}/${name}`, { version: invoice.data!.version }),
  );
  const voidInvoice = useApiMutation(() =>
    sensitive(() =>
      api.post<InvoiceDetail>(`/sales/invoices/${id}/void`, {
        version: invoice.data!.version,
        reason: voidReason.trim(),
      }),
    ),
  );
  const remove = useApiMutation(() =>
    api.delete(`/sales/invoices/${id}?version=${invoice.data!.version}`),
  );

  if (invoice.isPending) return <Spinner label={t('common.loading')} />;
  if (invoice.isError) return <ErrorAlert error={invoice.error} />;
  const inv = invoice.data;
  const c = inv.currencyCode;
  const actionError = action.error ?? voidInvoice.error ?? remove.error;
  const hint = actionError instanceof ApiError ? issueHint(actionError.code) : null;
  const unpaid = inv.status === 'ISSUED' && inv.amountDue === inv.total;
  return (
    <>
      <PageHeader
        title={
          inv.number
            ? t('sales.invoices.titleNumber', { number: inv.number })
            : t('sales.invoices.draftTitle')
        }
        description={inv.customerName ?? undefined}
      />
      <SalesNav />
      <ErrorAlert error={actionError} />
      {hint ? <Alert tone="info">{t(hint)}</Alert> : null}
      {inv.warnings.map((w) => (
        <Alert key={w.code} tone="info">
          {w.message}
        </Alert>
      ))}
      <Card title={t('sales.invoices.summary')} actions={<StatusBadge status={inv.status} />}>
        <dl className="facts">
          <dt>{t('sales.field.customer')}</dt>
          <dd>{inv.customerName}</dd>
          <dt>{t('sales.field.invoiceDate')}</dt>
          <dd>{inv.invoiceDate}</dd>
          <dt>{t('sales.field.dueDate')}</dt>
          <dd>{inv.dueDate}</dd>
          <dt>{t('sales.field.currency')}</dt>
          <dd>{c}</dd>
          {inv.exchangeRate && c !== inv.baseCurrency ? (
            <>
              <dt>{t('sales.field.exchangeRate')}</dt>
              <dd>{Number(inv.exchangeRate)}</dd>
            </>
          ) : null}
          {inv.reference ? (
            <>
              <dt>{t('sales.field.reference')}</dt>
              <dd>{inv.reference}</dd>
            </>
          ) : null}
          {inv.kind === 'opening' ? (
            <>
              <dt>{t('sales.field.kind')}</dt>
              <dd>{t('sales.invoices.opening')}</dd>
            </>
          ) : null}
          {inv.voidReason ? (
            <>
              <dt>{t('sales.field.voidReason')}</dt>
              <dd>{inv.voidReason}</dd>
            </>
          ) : null}
        </dl>
        <TotalsTable
          currency={c}
          subtotal={inv.subtotal}
          discountTotal={inv.discountTotal}
          taxTotal={inv.taxTotal}
          total={inv.total}
          open={inv.amountDue}
          openLabel={t('sales.field.amountDue')}
        />
        <div className="actions">
          {inv.status === 'DRAFT' && can.edit ? (
            <Link className="btn btn--secondary" to={`/sales/invoices/${id}/edit`}>
              {t('common.edit')}
            </Link>
          ) : null}
          {inv.status === 'DRAFT' &&
          can.submit &&
          inv.approval.required &&
          !inv.approval.readyToIssue ? (
            <Button
              variant="secondary"
              busy={action.isPending}
              onClick={() => action.mutate('submit', { onSuccess: refresh })}
            >
              {t('sales.action.submit')}
            </Button>
          ) : null}
          {inv.status === 'PENDING_APPROVAL' && can.submit ? (
            <Button
              variant="secondary"
              busy={action.isPending}
              onClick={() => action.mutate('withdraw', { onSuccess: refresh })}
            >
              {t('sales.action.withdraw')}
            </Button>
          ) : null}
          {(inv.status === 'DRAFT' || inv.status === 'PENDING_APPROVAL') && can.issue ? (
            <Button
              disabled={!inv.approval.readyToIssue}
              busy={action.isPending}
              onClick={() => action.mutate('issue', { onSuccess: refresh })}
            >
              {t('sales.action.issue')}
            </Button>
          ) : null}
          {inv.status === 'DRAFT' && can.remove ? (
            <Button
              variant="ghost"
              busy={remove.isPending}
              onClick={() => {
                if (window.confirm(t('sales.invoices.confirmDelete'))) {
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      refresh();
                      void navigate('/sales/invoices');
                    },
                  });
                }
              }}
            >
              {t('common.delete')}
            </Button>
          ) : null}
          {inv.status === 'ISSUED' && Number(inv.amountDue) > 0 && can.receipt ? (
            <Link
              className="btn btn--secondary"
              to={`/sales/receipts/new?customerId=${inv.customerId}&invoiceId=${id}`}
            >
              {t('sales.action.recordPayment')}
            </Link>
          ) : null}
          {inv.status === 'ISSUED' && can.credit ? (
            <Link
              className="btn btn--secondary"
              to={`/sales/credit-notes/new?customerId=${inv.customerId}&invoiceId=${id}`}
            >
              {t('sales.action.credit')}
            </Link>
          ) : null}
        </div>
      </Card>

      <ApprovalPanel approval={inv.approval} />

      <Card title={t('sales.editor.lines')}>
        <LinesTable lines={inv.lines} currency={c} />
        {inv.memo ? <p className="memo">{inv.memo}</p> : null}
      </Card>

      {inv.allocations.length ? (
        <Card title={t('sales.invoices.payments')}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('sales.field.date')}</th>
                <th>{t('sales.field.source')}</th>
                <th className="num">{t('sales.field.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {inv.allocations.map((a) => (
                <tr key={a.id}>
                  <td>{a.allocationDate}</td>
                  <td>
                    {a.receiptId ? (
                      <Link to={`/sales/receipts/${a.receiptId}`}>
                        {t('sales.invoices.paymentReceipt')}
                      </Link>
                    ) : (
                      <Link to={`/sales/credit-notes/${a.creditNoteId}`}>
                        {t('sales.invoices.paymentCredit')}
                      </Link>
                    )}
                    {a.reversesAllocationId ? ` · ${t('sales.invoices.reversed')}` : ''}
                  </td>
                  <td className="num">{formatAmount(a.amount, c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {inv.status === 'ISSUED' || inv.status === 'VOID' ? (
        <OutputPanel path="invoices" id={id} canSend={inv.status === 'ISSUED' && can.issue} />
      ) : null}

      {inv.status === 'ISSUED' && can.void ? (
        <Card title={t('sales.invoices.voidTitle')}>
          {unpaid ? (
            <form
              className="form form--inline"
              onSubmit={(e) => {
                e.preventDefault();
                voidInvoice.mutate(undefined, { onSuccess: refresh });
              }}
            >
              <TextField
                label={t('sales.field.voidReason')}
                value={voidReason}
                required
                onChange={(e) => setVoidReason(e.target.value)}
              />
              <Button type="submit" variant="secondary" busy={voidInvoice.isPending}>
                {t('sales.action.void')}
              </Button>
            </form>
          ) : (
            <p className="muted">{t('sales.invoices.voidBlocked')}</p>
          )}
        </Card>
      ) : null}

      <AttachmentsCard
        linkType="invoice"
        linkId={id}
        canChange={can.attach}
        canRemove={can.attach && inv.status === 'DRAFT'}
        removeNote={t('sales.attachments.lockedNote')}
      />
    </>
  );
}
