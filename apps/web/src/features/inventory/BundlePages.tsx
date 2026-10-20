import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useT } from '../../i18n/i18n';

/**
 * Sales bundles (FP-29 A7): a catalog item that is not stock-tracked, sold as one line, whose
 * tracked components leave stock when the invoice is issued. The server enforces every rule.
 */

interface Bundle {
  bundleItemId: string;
  name: string;
  components: { itemId: string; name: string; quantity: string }[];
}
interface TrackedRow {
  itemId: string;
  name: string;
}
interface CatalogItem {
  id: string;
  name: string;
  itemType: string;
}

export function BundlesPage() {
  const t = useT();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.InventoryItemsManage);
  const bundles = useQuery({
    queryKey: ['inventory-bundles', org],
    queryFn: () => api.get<Bundle[]>('/inventory/bundles'),
  });
  const tracked = useQuery({
    queryKey: ['inventory-items', org],
    queryFn: () => api.get<{ items: TrackedRow[] }>('/inventory/items'),
    enabled: canManage,
  });
  const catalog = useQuery({
    queryKey: ['inventory-catalog', org],
    queryFn: () => api.get<{ items: CatalogItem[] }>('/sales/items?limit=200&status=active'),
    enabled: canManage,
  });
  const [bundleItemId, setBundleItemId] = useState('');
  const [rows, setRows] = useState<{ itemId: string; quantity: string }[]>([
    { itemId: '', quantity: '1' },
  ]);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['inventory-bundles', org] });
  const save = useApiMutation(() =>
    api.put(`/inventory/bundles/${bundleItemId}`, {
      components: rows
        .filter((r) => r.itemId)
        .map((r) => ({ itemId: r.itemId, quantity: r.quantity })),
    }),
  );
  const remove = useApiMutation((id: string) => api.delete(`/inventory/bundles/${id}`));
  const trackedIds = new Set((tracked.data?.items ?? []).map((t) => t.itemId));
  const candidates = (catalog.data?.items ?? []).filter(
    (i) => i.itemType === 'product' && !trackedIds.has(i.id),
  );
  const edit = (b: Bundle) => {
    setBundleItemId(b.bundleItemId);
    setRows(b.components.map((c) => ({ itemId: c.itemId, quantity: c.quantity })));
  };
  return (
    <>
      <PageHeader title={t('bundles.title')} description={t('bundles.description')} />
      <Card title={t('bundles.title')}>
        {bundles.isPending ? <Spinner /> : null}
        <ErrorAlert error={bundles.error ?? remove.error} />
        {bundles.data && bundles.data.length === 0 ? (
          <p className="muted">{t('bundles.none')}</p>
        ) : null}
        {(bundles.data ?? []).map((b) => (
          <div key={b.bundleItemId}>
            <strong>{b.name}</strong>
            <ul className="list">
              {b.components.map((c) => (
                <li key={c.itemId}>
                  {c.quantity} × {c.name}
                </li>
              ))}
            </ul>
            {canManage ? (
              <>
                <Button variant="secondary" onClick={() => edit(b)}>
                  {t('common.edit')}
                </Button>{' '}
                <Button
                  variant="ghost"
                  onClick={() => remove.mutate(b.bundleItemId, { onSuccess: refresh })}
                >
                  {t('common.remove')}
                </Button>
              </>
            ) : null}
          </div>
        ))}
      </Card>
      {canManage ? (
        <Card title={t('bundles.define')}>
          <Alert>{t('bundles.rules')}</Alert>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(undefined, {
                onSuccess: () => {
                  setBundleItemId('');
                  setRows([{ itemId: '', quantity: '1' }]);
                  refresh();
                },
              });
            }}
          >
            <div className="field">
              <label htmlFor="bundle-item">{t('bundles.item')}</label>
              <select
                id="bundle-item"
                required
                value={bundleItemId}
                onChange={(e) => setBundleItemId(e.target.value)}
              >
                <option value="">{t('common.choose')}</option>
                {candidates.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </div>
            {rows.map((r, i) => (
              <div className="filters" key={i}>
                <div className="field">
                  <label htmlFor={`bundle-comp-${i}`}>{t('bundles.component', { n: i + 1 })}</label>
                  <select
                    id={`bundle-comp-${i}`}
                    value={r.itemId}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))
                    }
                  >
                    <option value="">{t('common.choose')}</option>
                    {(tracked.data?.items ?? []).map((t) => (
                      <option key={t.itemId} value={t.itemId}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <TextField
                  label={t('bundles.quantity')}
                  inputMode="decimal"
                  value={r.quantity}
                  onChange={(e) =>
                    setRows(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))
                  }
                />
              </div>
            ))}
            <Button
              variant="ghost"
              onClick={() => setRows([...rows, { itemId: '', quantity: '1' }])}
            >
              {t('bundles.addComponent')}
            </Button>
            <ErrorAlert error={save.error} />
            <Button type="submit" busy={save.isPending}>
              {t('bundles.save')}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}
