import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useT } from '../../i18n/i18n';

/**
 * Customer statement links (customer portal v1, migration 0076). There are no customer accounts:
 * whoever holds the link sees one customer's open invoices and recent receipts and may start a
 * payment. The server decides what is paid; the public page only asks.
 */

interface StatementLink {
  id: string;
  status: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  viewCount: number;
}

/** Create, copy once and revoke the statement link of one customer (staff side). */
export function StatementLinksPanel({ customerId }: { customerId: string }) {
  const t = useT();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canManage = usePermission(Permission.InvoiceLinksManage);
  const [shown, setShown] = useState<string | null>(null);
  const [days, setDays] = useState('30');
  const links = useQuery({
    queryKey: ['statement-links', org, customerId],
    enabled: canManage,
    queryFn: () => api.get<StatementLink[]>(`/customers/${customerId}/statement-links`),
  });
  const create = useApiMutation(() =>
    sensitive(() =>
      api.post<StatementLink & { url: string }>(`/customers/${customerId}/statement-links`, {
        expiresInDays: Number(days) || 30,
      }),
    ),
  );
  const revoke = useApiMutation((l: StatementLink) =>
    sensitive(() => api.post(`/customers/statement-links/${l.id}/revoke`, {})),
  );
  if (!canManage) return null;
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['statement-links', org, customerId] });
  return (
    <Card title={t('sales.statementPages.customerStatementLink')}>
      <p className="muted">{t('sales.statementPages.aLinkLetsAnyoneWho')}</p>
      {shown ? (
        <>
          <Alert>{t('sales.statementPages.copyThisLinkNowIt')}</Alert>
          <input
            aria-label={t('sales.statementPages.statementLink')}
            readOnly
            value={shown}
            style={{ width: '100%' }}
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button variant="ghost" onClick={() => setShown(null)}>
            {t('sales.statementPages.iHaveCopiedIt')}
          </Button>
        </>
      ) : null}
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined, {
            onSuccess: (l) => {
              setShown(l.url);
              refresh();
            },
          });
        }}
      >
        <TextField
          label={t('sales.statementPages.validForDays')}
          value={days}
          inputMode="numeric"
          onChange={(e) => setDays(e.target.value)}
        />
        <Button type="submit" busy={create.isPending}>
          {t('sales.statementPages.createStatementLink')}
        </Button>
      </form>
      <ErrorAlert error={create.error ?? revoke.error} />
      {links.data && links.data.length > 0 ? (
        <table className="table">
          <tbody>
            {links.data.map((l) => (
              <tr key={l.id}>
                <td>{l.status}</td>
                <td>{new Date(l.expiresAt).toLocaleDateString()}</td>
                <td className="num">
                  {t('sales.statementPages.views', { viewCount: l.viewCount })}
                </td>
                <td>
                  {l.status === 'active' ? (
                    <Button
                      variant="ghost"
                      onClick={() => revoke.mutate(l, { onSuccess: refresh })}
                    >
                      {t('sales.statementPages.revoke')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Card>
  );
}

interface PublicStatement {
  organizationName: string;
  customerName: string;
  asOf: string;
  balances: { currencyCode: string; amount: string }[];
  invoices: {
    id: string;
    number: string;
    kind: string;
    dueDate: string;
    currencyCode: string;
    openAmount: string;
    payment: { status: string; checkoutUrl: string | null } | null;
  }[];
  receipts: {
    number: string;
    receiptDate: string;
    currencyCode: string;
    amount: string;
    reference: string | null;
  }[];
}

/** The signed-out customer statement. */
export function PublicStatementPage() {
  const t = useT();
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const statement = useQuery({
    queryKey: ['public-statement', token],
    queryFn: () => api.get<PublicStatement>(`/public/statements/${token}`),
    retry: false,
    refetchOnWindowFocus: true,
  });
  const pay = useApiMutation((invoiceId: string) =>
    api.post<{ checkoutUrl: string | null }>(
      `/public/statements/${token}/invoices/${invoiceId}/pay`,
      {},
    ),
  );
  const back = encodeURIComponent(`/p/statement/${token}`);
  const s = statement.data;
  return (
    <main className="container" style={{ maxWidth: 820, margin: '2rem auto', padding: '0 1rem' }}>
      {statement.isPending ? <Spinner /> : null}
      {statement.isError ? <Alert>{t('sales.statementPages.thisLinkIsNotValid')}</Alert> : null}
      {s ? (
        <>
          <h1>{s.organizationName}</h1>
          <h2>{t('sales.statementPages.statementFor', { customerName: s.customerName })}</h2>
          <p className="muted">{t('sales.statementPages.asOf', { asOf: s.asOf })}</p>
          {s.balances.length === 0 ? (
            <Alert>{t('sales.statementPages.nothingIsDueThankYou')}</Alert>
          ) : (
            <p>
              {t('sales.statementPages.balanceDue', {
                value: s.balances.map((b) => formatAmount(b.amount, b.currencyCode)).join(' and '),
              })}
            </p>
          )}
          <ErrorAlert error={pay.error} />
          {s.invoices.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('sales.statementPages.invoice')}</th>
                  <th>{t('sales.statementPages.due')}</th>
                  <th className="num">{t('sales.statementPages.openAmount')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.invoices.map((i) => (
                  <tr key={i.id}>
                    <td>{i.number}</td>
                    <td>{i.dueDate}</td>
                    <td className="num">{formatAmount(i.openAmount, i.currencyCode)}</td>
                    <td>
                      {i.payment?.status === 'PROCESSING' ? (
                        t('sales.statementPages.paymentProcessing')
                      ) : i.payment?.status === 'PENDING' && i.payment.checkoutUrl ? (
                        <a href={`${i.payment.checkoutUrl}?return=${back}`}>
                          {t('sales.statementPages.continuePayment')}
                        </a>
                      ) : (
                        <Button
                          variant="secondary"
                          busy={pay.isPending}
                          onClick={() =>
                            pay.mutate(i.id, {
                              onSuccess: (p) => {
                                void queryClient.invalidateQueries({
                                  queryKey: ['public-statement', token],
                                });
                                if (p.checkoutUrl) {
                                  window.location.assign(`${p.checkoutUrl}?return=${back}`);
                                }
                              },
                            })
                          }
                        >
                          {t('sales.statementPages.payOnline')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {s.receipts.length > 0 ? (
            <>
              <h3>{t('sales.statementPages.recentPaymentsReceived')}</h3>
              <table className="table">
                <tbody>
                  {s.receipts.map((r) => (
                    <tr key={r.number}>
                      <td>{r.receiptDate}</td>
                      <td>{r.reference ?? r.number}</td>
                      <td className="num">{formatAmount(r.amount, r.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
