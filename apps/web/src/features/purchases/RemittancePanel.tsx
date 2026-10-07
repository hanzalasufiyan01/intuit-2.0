import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { useT } from '../../i18n/i18n';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { TextField } from '../../shared/ui/TextField';
import { useOrgKey } from '../sales/shared';
import type { PaymentStatus, RemittanceEmail, RemittanceStatus, VendorSummary } from './types';

/**
 * A payment's remittance advice: generate on demand, download, email (Phase 4B-7; ADR 0004 P4-46;
 * decisions D4–D7, D13, D16). View and download need `vendor_payments.view` (the page already
 * does); generating and emailing need `vendor_payments.create`. A voided payment keeps an existing
 * advice but offers no new generation or email. The server decides; the controls follow it.
 */
export function RemittancePanel({
  paymentId,
  vendorId,
  status,
}: {
  paymentId: string;
  vendorId: string;
  status: PaymentStatus;
}) {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canCreate = usePermission(Permission.VendorPaymentsCreate);
  const canVendors = usePermission(Permission.VendorsView);
  const recorded = status === 'RECORDED';
  const base = `/purchases/payments/${paymentId}/remittance`;

  const advice = useQuery({
    queryKey: ['remittance', org, paymentId],
    queryFn: () => api.get<RemittanceStatus>(base),
    // The PDF is produced by a job: re-check while it is pending.
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : false),
  });
  const emails = useQuery({
    queryKey: ['remittance-emails', org, paymentId],
    queryFn: () => api.get<RemittanceEmail[]>(`${base}/emails`),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((e) => e.status === 'queued') ? 3000 : false,
  });
  // D16: the vendor's email is offered when the viewer may read it; a vendor without one is typed.
  const vendor = useQuery({
    queryKey: ['vendor-email', org, vendorId],
    queryFn: () => api.get<VendorSummary>(`/vendors/${vendorId}`),
    enabled: canVendors,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['remittance', org, paymentId] });
    void queryClient.invalidateQueries({ queryKey: ['remittance-emails', org, paymentId] });
  };
  const generate = useApiMutation(() => api.post<{ status: string }>(base, {}));

  const [to, setTo] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const messageId = useId();
  const recipient = to ?? vendor.data?.email ?? '';
  const send = useApiMutation(() =>
    api.post(`${base}/email`, {
      ...(recipient.trim() ? { to: recipient.trim() } : {}),
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      ...(message.trim() ? { message: message.trim() } : {}),
    }),
  );

  const state = advice.data?.status ?? 'none';
  return (
    <Card title={t('purchases.remittance.title')}>
      <p className="muted">{t('purchases.remittance.contents')}</p>
      <ErrorAlert error={advice.error} />
      {state === 'ready' && advice.data?.download ? (
        <p>
          <a className="btn btn--secondary" href={advice.data.download.url}>
            {t('purchases.remittance.download')}
          </a>
        </p>
      ) : null}
      {state === 'pending' ? <p className="muted">{t('purchases.remittance.generating')}</p> : null}
      {state === 'failed' ? <Alert>{t('purchases.remittance.failed')}</Alert> : null}
      {state === 'none' && !recorded ? (
        <p className="muted">{t('purchases.remittance.voidNone')}</p>
      ) : null}
      {state === 'none' && recorded ? (
        <p className="muted">{t('purchases.remittance.none')}</p>
      ) : null}
      {recorded && canCreate && (state === 'none' || state === 'failed') ? (
        <>
          <ErrorAlert error={generate.error} />
          <Button
            variant="secondary"
            busy={generate.isPending}
            onClick={() => generate.mutate(undefined, { onSuccess: refresh })}
          >
            {state === 'failed'
              ? t('purchases.remittance.retry')
              : t('purchases.remittance.generate')}
          </Button>
        </>
      ) : null}
      {!recorded && state === 'ready' ? (
        <p className="muted">{t('purchases.remittance.voidKept')}</p>
      ) : null}

      {recorded && canCreate ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate(undefined, {
              onSuccess: () => {
                setTo(null);
                setSubject('');
                setMessage('');
                refresh();
              },
            });
          }}
        >
          <h3>{t('purchases.remittance.emailTitle')}</h3>
          <ErrorAlert error={send.error} />
          <TextField
            label={t('purchases.remittance.emailTo')}
            hint={t('purchases.remittance.emailHint')}
            type="email"
            value={recipient}
            onChange={(e) => setTo(e.target.value)}
          />
          <TextField
            label={t('purchases.remittance.subject')}
            maxLength={200}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          <div className="field">
            <label htmlFor={messageId}>{t('purchases.remittance.message')}</label>
            <textarea
              id={messageId}
              rows={3}
              maxLength={4000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          {/* The button is busy while a request is in flight: no accidental double-click. */}
          <Button type="submit" variant="secondary" busy={send.isPending}>
            {t('purchases.remittance.send')}
          </Button>
        </form>
      ) : null}

      <h3>{t('purchases.remittance.history')}</h3>
      {(emails.data ?? []).length === 0 ? (
        <p className="muted">{t('purchases.remittance.noEmails')}</p>
      ) : (
        <ul>
          {emails.data!.map((e) => (
            <li key={e.id}>
              {e.recipient} · {t(`purchases.remittance.email.${e.status}`)} ·{' '}
              {e.requestedAt.slice(0, 10)}
              {recorded && canCreate ? (
                <>
                  {' '}
                  <button type="button" className="link-button" onClick={() => setTo(e.recipient)}>
                    {t('purchases.remittance.sendAgain')}
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
