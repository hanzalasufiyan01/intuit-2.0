import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useT } from '../../i18n/i18n';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { useOrgKey } from '../accounting/shared';

interface Suggestion {
  itemId: string;
  sku: string | null;
  name: string;
  baseUnit: string;
  onHand: string;
  reserved: string;
  onOrder: string;
  available: string;
  reorderPoint: string;
  suggestedQuantity: string;
}

/**
 * Purchase suggestions from reorder points (specification section 18; R-03). Read-only: nothing is
 * ordered, received or posted. A person decides what to buy and creates the purchase order.
 */
export function PurchaseSuggestionsPage() {
  const t = useT();
  const org = useOrgKey();
  const canOrders = usePermission(Permission.PurchaseOrdersView);
  const canCreate = usePermission(Permission.PurchaseOrdersCreate);
  const query = useQuery({
    queryKey: ['report-purchase-suggestions', org],
    enabled: canOrders,
    queryFn: () =>
      api.get<{ items: Suggestion[]; note: string }>('/inventory/reports/purchase-suggestions'),
  });
  return (
    <>
      <PageHeader title={t('suggest.title')} description={t('suggest.description')} />
      {!canOrders ? <Alert tone="info">{t('suggest.needsOrders')}</Alert> : null}
      {canOrders && query.isPending ? <Spinner label={t('common.loading')} /> : null}
      <ErrorAlert error={query.error} />
      {query.data ? (
        <Card>
          {query.data.items.length === 0 ? (
            <p className="muted">{t('suggest.none')}</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('suggest.item')}</th>
                    <th className="num">{t('suggest.onHand')}</th>
                    <th className="num">{t('suggest.reserved')}</th>
                    <th className="num">{t('suggest.onOrder')}</th>
                    <th className="num">{t('suggest.available')}</th>
                    <th className="num">{t('suggest.reorderPoint')}</th>
                    <th className="num">{t('suggest.suggested')}</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((i) => (
                    <tr key={i.itemId}>
                      <td>
                        <Link to={`/inventory/items/${i.itemId}`}>
                          {i.sku ? `${i.sku} · ${i.name}` : i.name}
                        </Link>
                      </td>
                      <td className="num">{i.onHand}</td>
                      <td className="num">{i.reserved}</td>
                      <td className="num">{i.onOrder}</td>
                      <td className="num">{i.available}</td>
                      <td className="num">{i.reorderPoint}</td>
                      <td className="num">
                        <strong>{i.suggestedQuantity}</strong> {i.baseUnit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Alert tone="info">{query.data.note}</Alert>
          {canCreate ? (
            <p>
              <Link to="/purchases/orders/new">{t('suggest.newOrder')}</Link>
            </p>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
