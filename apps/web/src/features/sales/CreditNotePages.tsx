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
import { AttachmentsCard } from '../files/AttachmentsCard';
import { DocumentEditor } from './DocumentEditor';
import { ApprovalPanel, LinesTable, OutputPanel, TotalsTable } from './DocumentParts';
import { issueHint, SalesNav, StatusBadge, useOrgKey } from './shared';
import type { CreditNoteDetail, CreditNoteSummary, Page } from './types';

export function CreditNotesPage() {
  const t = useT();
  const org = useOrgKey();
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const list = useInfiniteQuery({
    queryKey: ['credit-notes', org, applied],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (applied.trim()) params.set('search', applied.trim());
      if (pageParam) params.set('after', pageParam);
      return api.get<Page<CreditNoteSummary>>(`/sales/credit-notes?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader
        title={t('sales.creditNotes.title')}
        description={t('sales.creditNotes.description')}
      />
      <SalesNav />
      <Card
        actions={
          <Can permission={Permission.CreditNotesCreate}>
            <Link className="btn btn--primary" to="/sales/credit-notes/new">
              {t('sales.creditNotes.new')}
            </Link>
          </Can>
        }
      >
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(search);
          }}
        >
          <TextField
            label={t('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button type="submit">{t('common.search')}</Button>
        </form>
      </Card>
      <Card>
        {list.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : items.length === 0 ? (
          <p className="muted">{t('sales.creditNotes.none')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('sales.field.number')}</th>
                <th>{t('sales.field.customer')}</th>
                <th>{t('sales.field.creditDate')}</th>
                <th className="num">{t('sales.field.total')}</th>
                <th className="num">{t('sales.field.unapplied')}</th>
                <th>{t('sales.field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((n) => (
                <tr key={n.id}>
                  <td>
                    <Link to={`/sales/credit-notes/${n.id}`}>
                      {n.number ?? t('sales.invoices.draftNumber')}
                    </Link>
                  </td>
                  <td>{n.customerName}</td>
                  <td>{n.creditDate}</td>
                  <td className="num">
                    {formatAmount(n.total, n.currencyCode)} {n.currencyCode}
                  </td>
                  <td className="num">
                    {n.amountUnapplied === null
                      ? ''
                      : formatAmount(n.amountUnapplied, n.currencyCode)}
                  </td>
                  <td>
                    <StatusBadge status={n.status} />
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

export function NewCreditNotePage() {
  const t = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const create = useApiMutation((body: Record<string, unknown>) =>
    api.post<CreditNoteDetail>('/sales/credit-notes', body),
  );
  return (
    <>
      <PageHeader title={t('sales.creditNotes.new')} />
      <SalesNav />
      <DocumentEditor
        kind="credit_note"
        existing={null}
        presetCustomerId={params.get('customerId') ?? undefined}
        presetInvoiceId={params.get('invoiceId') ?? undefined}
        saving={create.isPending}
        error={create.error}
        onSave={(body) =>
          create.mutate(body, {
            onSuccess: (note) => void navigate(`/sales/credit-notes/${note.id}`),
          })
        }
      />
    </>
  );
}

function useCreditNote(id: string) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['credit-note', org, id],
    queryFn: () => api.get<CreditNoteDetail>(`/sales/credit-notes/${id}`),
  });
}

export function EditCreditNotePage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const note = useCreditNote(id);
  const save = useApiMutation((body: Record<string, unknown>) =>
    api.put<CreditNoteDetail>(`/sales/credit-notes/${id}`, {
      ...body,
      version: note.data!.version,
    }),
  );
  if (note.isPending) return <Spinner label={t('common.loading')} />;
  if (note.isError) return <ErrorAlert error={note.error} />;
  return (
    <>
      <PageHeader title={t('sales.creditNotes.edit')} />
      <SalesNav />
      <DocumentEditor
        kind="credit_note"
        existing={note.data}
        saving={save.isPending}
        error={save.error}
        onSave={(body) =>
          save.mutate(body, {
            onSuccess: (saved) => {
              queryClient.setQueryData(['credit-note', org, id], saved);
              void navigate(`/sales/credit-notes/${id}`);
            },
          })
        }
      />
    </>
  );
}

export function CreditNoteDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const note = useCreditNote(id);
  const can = {
    edit: usePermission(Permission.CreditNotesCreate),
    issue: usePermission(Permission.CreditNotesIssue),
    apply: usePermission(Permission.ReceiptsCreate),
  };
  const refresh = (data?: CreditNoteDetail) => {
    if (data) queryClient.setQueryData(['credit-note', org, id], data);
    void queryClient.invalidateQueries({ queryKey: ['credit-notes', org] });
  };
  const action = useApiMutation((name: 'submit' | 'withdraw') =>
    api.post<CreditNoteDetail>(`/sales/credit-notes/${id}/${name}`, {
      version: note.data!.version,
    }),
  );
  // Decision 41: issuing a credit note needs a recent password confirmation.
  const issue = useApiMutation(() =>
    sensitive(() =>
      api.post<CreditNoteDetail>(`/sales/credit-notes/${id}/issue`, {
        version: note.data!.version,
      }),
    ),
  );
  const remove = useApiMutation(() =>
    api.delete(`/sales/credit-notes/${id}?version=${note.data!.version}`),
  );
  const [confirming, setConfirming] = useState(false);

  if (note.isPending) return <Spinner label={t('common.loading')} />;
  if (note.isError) return <ErrorAlert error={note.error} />;
  const n = note.data;
  const c = n.currencyCode;
  const error = action.error ?? issue.error ?? remove.error;
  const hint = error instanceof ApiError ? issueHint(error.code) : null;
  return (
    <>
      <PageHeader
        title={
          n.number
            ? t('sales.creditNotes.titleNumber', { number: n.number })
            : t('sales.creditNotes.draftTitle')
        }
        description={n.customerName ?? undefined}
      />
      <SalesNav />
      <ErrorAlert error={error} />
      {hint ? <Alert tone="info">{t(hint)}</Alert> : null}
      <Card title={t('sales.invoices.summary')} actions={<StatusBadge status={n.status} />}>
        <dl className="facts">
          <dt>{t('sales.field.customer')}</dt>
          <dd>{n.customerName}</dd>
          <dt>{t('sales.field.creditDate')}</dt>
          <dd>{n.creditDate}</dd>
          <dt>{t('sales.field.creditedInvoice')}</dt>
          <dd>
            {n.invoiceId ? (
              <Link to={`/sales/invoices/${n.invoiceId}`}>
                {t('sales.creditNotes.viewInvoice')}
              </Link>
            ) : (
              t('sales.editor.standaloneCredit')
            )}
          </dd>
          <dt>{t('sales.field.currency')}</dt>
          <dd>{c}</dd>
        </dl>
        <TotalsTable
          currency={c}
          subtotal={n.subtotal}
          discountTotal={n.discountTotal}
          taxTotal={n.taxTotal}
          total={n.total}
          open={n.amountUnapplied}
          openLabel={t('sales.field.unapplied')}
        />
        <div className="actions">
          {n.status === 'DRAFT' && can.edit ? (
            <Link className="btn btn--secondary" to={`/sales/credit-notes/${id}/edit`}>
              {t('common.edit')}
            </Link>
          ) : null}
          {n.status === 'DRAFT' && can.edit && n.approval.required && !n.approval.readyToIssue ? (
            <Button
              variant="secondary"
              busy={action.isPending}
              onClick={() => action.mutate('submit', { onSuccess: refresh })}
            >
              {t('sales.action.submit')}
            </Button>
          ) : null}
          {n.status === 'PENDING_APPROVAL' && can.edit ? (
            <Button
              variant="secondary"
              busy={action.isPending}
              onClick={() => action.mutate('withdraw', { onSuccess: refresh })}
            >
              {t('sales.action.withdraw')}
            </Button>
          ) : null}
          {n.status !== 'ISSUED' && can.issue ? (
            confirming ? (
              <>
                <span>{t('sales.creditNotes.confirmIssue')}</span>
                <Button
                  busy={issue.isPending}
                  onClick={() => issue.mutate(undefined, { onSuccess: refresh })}
                >
                  {t('sales.action.issueConfirm')}
                </Button>
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  {t('common.cancel')}
                </Button>
              </>
            ) : (
              <Button disabled={!n.approval.readyToIssue} onClick={() => setConfirming(true)}>
                {t('sales.action.issue')}
              </Button>
            )
          ) : null}
          {n.status === 'DRAFT' && can.edit ? (
            <Button
              variant="ghost"
              busy={remove.isPending}
              onClick={() => {
                if (window.confirm(t('sales.creditNotes.confirmDelete'))) {
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      refresh();
                      void navigate('/sales/credit-notes');
                    },
                  });
                }
              }}
            >
              {t('common.delete')}
            </Button>
          ) : null}
          {n.status === 'ISSUED' && Number(n.amountUnapplied) > 0 && can.apply ? (
            <Link
              className="btn btn--secondary"
              to={`/sales/customer-credit/apply?sourceType=credit_note&sourceId=${id}`}
            >
              {t('sales.action.applyCredit')}
            </Link>
          ) : null}
        </div>
      </Card>
      <ApprovalPanel approval={n.approval} />
      <Card title={t('sales.editor.lines')}>
        <LinesTable lines={n.lines} currency={c} />
        {n.memo ? <p className="memo">{n.memo}</p> : null}
      </Card>
      {n.allocations.length ? (
        <Card title={t('sales.creditNotes.applied')}>
          <ul className="list">
            {n.allocations.map((a) => (
              <li key={a.id}>
                <Link to={`/sales/invoices/${a.invoiceId}`}>{a.allocationDate}</Link> ·{' '}
                {formatAmount(a.amount, c)} {c}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {n.status === 'ISSUED' ? (
        <OutputPanel path="credit-notes" id={id} canSend={can.issue} />
      ) : null}
      <AttachmentsCard
        linkType="credit_note"
        linkId={id}
        canChange={can.edit}
        canRemove={can.edit && n.status === 'DRAFT'}
        removeNote={t('sales.attachments.lockedNote')}
      />
    </>
  );
}
