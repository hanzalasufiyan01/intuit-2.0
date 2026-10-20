import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { useT, type MessageKey } from '../../i18n/i18n';

/**
 * Online payments (migration 0075). The server decides everything: a payment is recorded only
 * from a verified provider event confirmed with the provider, never from this browser. The
 * simulated provider is labelled everywhere so nobody mistakes it for real money.
 */

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

interface GatewaySettings {
  mode: 'disabled' | 'mock' | 'live';
  intentTtlMinutes: number;
  version: number;
  available: { mock: boolean; live: boolean };
}
interface Payment {
  id: string;
  invoiceId: string;
  amount: string;
  currencyCode: string;
  mode: 'mock' | 'live';
  status: string;
  failureCode: string | null;
  receiptId: string | null;
  createdAt: string;
}

const STATUS_TEXT: Record<string, MessageKey> = {
  CREATED: 'sales.paymentPages.status.CREATED',
  PENDING: 'sales.paymentPages.status.PENDING',
  SUCCEEDED: 'sales.paymentPages.status.SUCCEEDED',
  FAILED: 'sales.paymentPages.status.FAILED',
  CANCELLED: 'sales.paymentPages.status.CANCELLED',
  EXPIRED: 'sales.paymentPages.status.EXPIRED',
  REQUIRES_REVIEW: 'sales.paymentPages.status.REQUIRES_REVIEW',
};

export function OnlinePaymentsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canManage = usePermission(Permission.PaymentsSettingsManage);
  const canReconcile = usePermission(Permission.PaymentsReconcile);
  const canCancel = usePermission(Permission.PaymentsIntentsCreate);
  const settings = useQuery({
    queryKey: ['payment-settings', org],
    queryFn: () => api.get<GatewaySettings>('/payments/settings'),
  });
  const payments = useQuery({
    queryKey: ['payments', org],
    queryFn: () => api.get<Payment[]>('/payments/intents'),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['payments', org] });
    void queryClient.invalidateQueries({ queryKey: ['payment-settings', org] });
  };
  const save = useApiMutation((v: { mode: 'disabled' | 'mock'; version: number; ttl: number }) =>
    sensitive(() =>
      api.put('/payments/settings', {
        version: v.version,
        mode: v.mode,
        intentTtlMinutes: v.ttl,
      }),
    ),
  );
  const act = useApiMutation((v: { id: string; verb: 'reconcile' | 'cancel' }) =>
    api.post(`/payments/intents/${v.id}/${v.verb}`, {}),
  );
  const s = settings.data;
  return (
    <>
      <PageHeader
        title={t('sales.paymentPages.onlinePayments')}
        description={t('sales.paymentPages.letCustomersPayIssuedInvoices')}
      />
      <Card title={t('sales.paymentPages.gateway')}>
        {settings.isPending ? <Spinner /> : null}
        <ErrorAlert error={settings.error ?? save.error} />
        {s ? (
          <>
            <p>
              {t('sales.paymentPages.mode')}{' '}
              <strong>
                {s.mode === 'disabled'
                  ? t('sales.paymentPages.off')
                  : s.mode === 'mock'
                    ? t('sales.paymentPages.simulatedProviderNoRealMoney')
                    : t('sales.paymentPages.live')}
              </strong>
            </p>
            {!s.available.live ? (
              <Alert>{t('sales.paymentPages.noRealPaymentProviderIs')}</Alert>
            ) : null}
            {canManage ? (
              <p>
                {s.mode === 'mock' ? (
                  <Button
                    variant="secondary"
                    busy={save.isPending}
                    onClick={() =>
                      save.mutate(
                        { mode: 'disabled', version: s.version, ttl: s.intentTtlMinutes },
                        { onSuccess: refresh },
                      )
                    }
                  >
                    {t('sales.paymentPages.switchOff')}
                  </Button>
                ) : s.available.mock ? (
                  <Button
                    busy={save.isPending}
                    onClick={() =>
                      save.mutate(
                        { mode: 'mock', version: s.version, ttl: s.intentTtlMinutes },
                        { onSuccess: refresh },
                      )
                    }
                  >
                    {t('sales.paymentPages.switchOnTheSimulatedProvider')}
                  </Button>
                ) : null}
              </p>
            ) : null}
          </>
        ) : null}
      </Card>
      <Card title={t('sales.paymentPages.paymentAttempts')}>
        {payments.isPending ? <Spinner /> : null}
        <ErrorAlert error={payments.error ?? act.error} />
        {payments.data && payments.data.length === 0 ? (
          <p className="muted">{t('sales.paymentPages.noOnlinePaymentsYet')}</p>
        ) : null}
        {payments.data && payments.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('sales.paymentPages.date')}</th>
                <th>{t('sales.paymentPages.invoice')}</th>
                <th className="num">{t('sales.paymentPages.amount')}</th>
                <th>{t('sales.paymentPages.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payments.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  <td>
                    <Link to={`/sales/invoices/${p.invoiceId}`}>
                      {t('sales.paymentPages.openInvoice')}
                    </Link>
                    {p.mode === 'mock' ? (
                      <small className="muted"> {t('sales.paymentPages.simulated')}</small>
                    ) : null}
                  </td>
                  <td className="num">{formatAmount(p.amount, p.currencyCode)}</td>
                  <td>
                    {STATUS_TEXT[p.status] ? t(STATUS_TEXT[p.status]!) : p.status}
                    {p.failureCode ? <small className="muted"> — {p.failureCode}</small> : null}
                  </td>
                  <td>
                    {canReconcile &&
                    ['PENDING', 'REQUIRES_REVIEW', 'EXPIRED'].includes(p.status) ? (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          act.mutate({ id: p.id, verb: 'reconcile' }, { onSuccess: refresh })
                        }
                      >
                        {t('sales.paymentPages.checkWithProvider')}
                      </Button>
                    ) : null}{' '}
                    {canCancel && p.status === 'PENDING' ? (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          act.mutate({ id: p.id, verb: 'cancel' }, { onSuccess: refresh })
                        }
                      >
                        {t('common.cancel')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </>
  );
}

interface PublicPayment {
  payment: {
    id: string;
    status: string;
    amount: string;
    currencyCode: string;
    checkoutUrl: string | null;
  } | null;
}

/** The "Pay online" block of the public invoice page. */
export function PayOnlinePanel({
  token,
  currencyCode,
  amountDue,
}: {
  token: string;
  currencyCode: string;
  amountDue: string;
}) {
  const t = useT();
  const status = useQuery({
    queryKey: ['public-payment', token],
    queryFn: () => api.get<PublicPayment>(`/public/invoices/${token}/payment`),
    retry: false,
    refetchOnWindowFocus: true,
    // While a payment is waiting, ask again (the server re-checks with the provider).
    refetchInterval: (q) => (q.state.data?.payment?.status === 'PENDING' ? 5000 : false),
  });
  const queryClient = useQueryClient();
  const start = useApiMutation(() =>
    api.post<{ status: string; checkoutUrl: string | null }>(`/public/invoices/${token}/pay`, {}),
  );
  const payment = status.data?.payment ?? null;
  if (Number(amountDue) <= 0 && payment?.status !== 'SUCCEEDED') return null;
  if (payment?.status === 'SUCCEEDED')
    return <Alert>{t('sales.paymentPages.paymentReceivedThankYou')}</Alert>;
  if (payment?.status === 'PROCESSING') {
    return <Alert>{t('sales.paymentPages.yourPaymentIsBeingProcessed')}</Alert>;
  }
  return (
    <div>
      {payment?.status === 'FAILED' ? (
        <Alert>{t('sales.paymentPages.theLastPaymentAttemptDid')}</Alert>
      ) : null}
      <ErrorAlert error={start.error} />
      {payment?.status === 'PENDING' && payment.checkoutUrl ? (
        <p>
          {t('sales.paymentPages.aPaymentOfIsWaiting', {
            value: formatAmount(payment.amount, payment.currencyCode),
          })}{' '}
          <a href={`${payment.checkoutUrl}?return=${encodeURIComponent(`/p/invoice/${token}`)}`}>
            {t('sales.paymentPages.continueToPayment')}
          </a>
        </p>
      ) : (
        <Button
          busy={start.isPending}
          onClick={() =>
            start.mutate(undefined, {
              onSuccess: (p) => {
                void queryClient.invalidateQueries({ queryKey: ['public-payment', token] });
                if (p.checkoutUrl) {
                  window.location.assign(
                    `${p.checkoutUrl}?return=${encodeURIComponent(`/p/invoice/${token}`)}`,
                  );
                }
              },
            })
          }
        >
          {t('sales.paymentPages.payOnline', { value: formatAmount(amountDue, currencyCode) })}
        </Button>
      )}
    </div>
  );
}

/** The simulated provider's hosted checkout page. It never moves money. */
export function MockCheckoutPage() {
  const t = useT();
  const { ref = '' } = useParams();
  const [params] = useSearchParams();
  const back = params.get('return');
  const safeBack = back && /^\/p\/invoice\/[A-Za-z0-9_-]+$/.test(back) ? back : null;
  const [done, setDone] = useState<string | null>(null);
  const settle = useApiMutation((outcome: 'succeeded' | 'failed' | 'cancelled') =>
    api.post(`/public/mock-pay/${ref}/settle`, { outcome }).then(() => outcome),
  );
  return (
    <main className="container" style={{ maxWidth: 520, margin: '3rem auto', padding: '0 1rem' }}>
      <h1>{t('sales.paymentPages.simulatedPayment')}</h1>
      <Alert>{t('sales.paymentPages.thisIsATestPayment')}</Alert>
      <ErrorAlert error={settle.error} />
      {done ? (
        <p>
          {t('sales.paymentPages.simulatedResult')} <strong>{done}</strong>.{' '}
          {safeBack ? <Link to={safeBack}>{t('sales.paymentPages.backToTheInvoice')}</Link> : null}
        </p>
      ) : (
        <p>
          <Button
            busy={settle.isPending}
            onClick={() => settle.mutate('succeeded', { onSuccess: setDone })}
          >
            {t('sales.paymentPages.simulateSuccessfulPayment')}
          </Button>{' '}
          <Button
            variant="secondary"
            onClick={() => settle.mutate('failed', { onSuccess: setDone })}
          >
            {t('sales.paymentPages.simulateDeclinedPayment')}
          </Button>{' '}
          <Button
            variant="secondary"
            onClick={() => settle.mutate('cancelled', { onSuccess: setDone })}
          >
            {t('common.cancel')}
          </Button>
        </p>
      )}
    </main>
  );
}
