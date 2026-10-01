import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { useT } from '../../i18n/i18n';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { TextField } from '../../shared/ui/TextField';
import { useOrgKey, useTaxCodes } from './shared';
import type { ApprovalState, DocumentLine } from './types';

/** Lines of a Sales document as the server calculated them. */
export function LinesTable({ lines, currency }: { lines: DocumentLine[]; currency: string }) {
  const t = useT();
  const taxCodes = useTaxCodes();
  const codeOf = (id: string | null) => taxCodes.data?.find((c) => c.id === id)?.code ?? '';
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('sales.field.description')}</th>
          <th className="num">{t('sales.field.quantity')}</th>
          <th className="num">{t('sales.field.unitPrice')}</th>
          <th className="num">{t('sales.field.discount')}</th>
          <th className="num">{t('sales.field.net')}</th>
          <th>{t('sales.field.taxCode')}</th>
          <th className="num">{t('sales.field.tax')}</th>
          <th className="num">{t('sales.field.lineTotal')}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => {
          const discount = formatAmount(
            String(Number(l.lineDiscount) + Number(l.documentDiscount)),
            currency,
          );
          return (
            <tr key={l.id}>
              <td>{l.description}</td>
              <td className="num">{l.quantity}</td>
              <td className="num">{formatAmount(l.unitPrice, currency)}</td>
              <td className="num">{Number(discount) === 0 ? '' : discount}</td>
              <td className="num">{formatAmount(l.netAmount, currency)}</td>
              <td>{l.taxCodeId ? `${codeOf(l.taxCodeId)} ${l.taxRate ?? ''}%` : '—'}</td>
              <td className="num">{formatAmount(l.taxAmount, currency)}</td>
              <td className="num">{formatAmount(l.total, currency)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function TotalsTable({
  currency,
  subtotal,
  discountTotal,
  taxTotal,
  total,
  open,
  openLabel,
}: {
  currency: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  open?: string | null | undefined;
  openLabel?: string;
}) {
  const t = useT();
  return (
    <table className="totals" aria-label={t('sales.totals.label')}>
      <tbody>
        <tr>
          <th>{t('sales.totals.subtotal')}</th>
          <td>{formatAmount(subtotal, currency)}</td>
        </tr>
        {Number(discountTotal) !== 0 ? (
          <tr>
            <th>{t('sales.totals.discount')}</th>
            <td>−{formatAmount(discountTotal, currency)}</td>
          </tr>
        ) : null}
        <tr>
          <th>{t('sales.totals.tax')}</th>
          <td>{formatAmount(taxTotal, currency)}</td>
        </tr>
        <tr className="totals__grand">
          <th>{t('sales.totals.totalIn', { currency })}</th>
          <td>{formatAmount(total, currency)}</td>
        </tr>
        {open !== undefined && open !== null ? (
          <tr>
            <th>{openLabel}</th>
            <td>{formatAmount(open, currency)}</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

/** D1: approval authorizes; issuing is a separate action. */
export function ApprovalPanel({ approval }: { approval: ApprovalState }) {
  const t = useT();
  if (!approval.required) return null;
  return (
    <Card title={t('sales.approval.title')}>
      {approval.requestStatus === null ? (
        <p>{t('sales.approval.needed')}</p>
      ) : (
        <p>
          {t('sales.approval.status', {
            status: t(`sales.approval.request.${approval.requestStatus}`),
          })}
        </p>
      )}
      {approval.appliedSteps.length ? (
        <ol className="steps">
          {approval.appliedSteps.map((s) => (
            <li key={s.order}>
              {t('sales.approval.step', { name: s.name, count: s.requiredApprovals })}
            </li>
          ))}
        </ol>
      ) : null}
      {approval.facts?.baseAmount ? (
        <p className="muted">
          {t('sales.approval.amount', {
            amount: formatAmount(approval.facts.baseAmount, approval.facts.baseCurrency ?? ''),
            currency: approval.facts.baseCurrency,
          })}
        </p>
      ) : null}
      {approval.approvalOutdated ? <Alert>{t('sales.approval.outdated')}</Alert> : null}
      {approval.readyToIssue && approval.requestStatus === 'approved' ? (
        <Alert tone="success">{t('sales.approval.ready')}</Alert>
      ) : null}
    </Card>
  );
}

type OutputPath = 'invoices' | 'credit-notes';

/** The issued PDF (rendered in the background) and emailing it to the customer (E4). */
export function OutputPanel({
  path,
  id,
  canSend,
}: {
  path: OutputPath;
  id: string;
  canSend: boolean;
}) {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const pdf = useQuery({
    queryKey: ['sales-pdf', org, path, id],
    queryFn: () =>
      api.get<{ status: 'ready' | 'pending'; fileId: string | null; download?: { url: string } }>(
        `/sales/${path}/${id}/pdf`,
      ),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : false),
  });
  const emails = useQuery({
    queryKey: ['sales-emails', org, path, id],
    queryFn: () =>
      api.get<{ id: string; recipient: string; status: string; requestedAt: string }[]>(
        `/sales/${path}/${id}/emails`,
      ),
  });
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const send = useApiMutation(() =>
    api.post(`/sales/${path}/${id}/email`, {
      ...(to.trim() ? { to: to.trim() } : {}),
      ...(message.trim() ? { message: message.trim() } : {}),
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send.mutate(undefined, {
      onSuccess: () => {
        setMessage('');
        void queryClient.invalidateQueries({ queryKey: ['sales-emails', org, path, id] });
      },
    });
  };
  return (
    <Card title={t('sales.output.title')}>
      {pdf.data?.status === 'ready' && pdf.data.download ? (
        <p>
          <a className="btn btn--primary" href={pdf.data.download.url}>
            {t('sales.output.downloadPdf')}
          </a>
        </p>
      ) : (
        <p className="muted">{t('sales.output.pdfPending')}</p>
      )}
      {canSend ? (
        <form className="form" onSubmit={submit}>
          <ErrorAlert error={send.error} />
          {send.isSuccess ? <Alert tone="success">{t('sales.output.emailQueued')}</Alert> : null}
          <TextField
            label={t('sales.output.to')}
            type="email"
            value={to}
            hint={t('sales.output.toHint')}
            onChange={(e) => setTo(e.target.value)}
          />
          <div className="field">
            <label htmlFor={`email-message-${id}`}>{t('sales.output.message')}</label>
            <textarea
              id={`email-message-${id}`}
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <p className="actions">
            <Button type="submit" variant="secondary" busy={send.isPending}>
              {t('sales.output.send')}
            </Button>
          </p>
        </form>
      ) : null}
      {emails.data?.length ? (
        <ul className="list">
          {emails.data.map((e) => (
            <li key={e.id}>
              {t('sales.output.emailLog', {
                to: e.recipient,
                status: t(`sales.output.emailStatus.${e.status as 'queued' | 'sent' | 'failed'}`),
                at: new Date(e.requestedAt).toLocaleString(),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
