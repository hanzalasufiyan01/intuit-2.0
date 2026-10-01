import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { useT } from '../../i18n/i18n';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { ExportButton } from '../data-exchange/ExportButton';
import { orNull, SalesNav, StatusBadge, useOrgKey, useTaxCodes } from './shared';
import type { Item, Page } from './types';

interface ItemForm {
  sku: string;
  name: string;
  itemType: 'service' | 'product';
  description: string;
  unitPrice: string;
  revenueAccountId: string;
  taxCodeId: string;
}

const blank: ItemForm = {
  sku: '',
  name: '',
  itemType: 'service',
  description: '',
  unitPrice: '',
  revenueAccountId: '',
  taxCodeId: '',
};

/** The items catalog (D4, Decision 31, D8): view with invoices.view, change with sales.items.manage. */
export function ItemsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.SalesItemsManage);
  const canAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canManage && canAccounts);
  const taxCodes = useTaxCodes();
  const [status, setStatus] = useState('active');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const list = useQuery({
    queryKey: ['items', org, status, applied],
    queryFn: () => {
      const params = new URLSearchParams({ status, limit: '200' });
      if (applied.trim()) params.set('search', applied.trim());
      return api.get<Page<Item>>(`/sales/items?${params.toString()}`);
    },
  });
  const [editing, setEditing] = useState<Item | null>(null);
  const [form, setForm] = useState<ItemForm>(blank);
  const body = () => ({
    sku: orNull(form.sku),
    name: form.name.trim(),
    itemType: form.itemType,
    description: form.description.trim(),
    unitPrice: orNull(form.unitPrice),
    revenueAccountId: form.revenueAccountId || null,
    taxCodeId: form.taxCodeId || null,
  });
  const save = useApiMutation(() =>
    editing
      ? api.patch<Item>(`/sales/items/${editing.id}`, { version: editing.version, ...body() })
      : api.post<Item>('/sales/items', body()),
  );
  const toggle = useApiMutation((item: Item) =>
    api.post<Item>(`/sales/items/${item.id}/${item.status === 'ACTIVE' ? 'archive' : 'restore'}`, {
      version: item.version,
    }),
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['items', org] });
    void queryClient.invalidateQueries({ queryKey: ['item-options', org] });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined, {
      onSuccess: () => {
        setEditing(null);
        setForm(blank);
        refresh();
      },
    });
  };
  const issue = (path: string) =>
    save.error instanceof ApiError ? save.error.fieldError(path) : undefined;
  const revenueAccounts = (accounts.data ?? []).filter(
    (a) => a.type === 'REVENUE' && a.status === 'ACTIVE' && a.isLeaf !== false,
  );
  const codeOf = (id: string | null) => taxCodes.data?.find((c) => c.id === id)?.code ?? '';

  return (
    <>
      <PageHeader title={t('sales.items.title')} description={t('sales.items.description')} />
      <SalesNav />
      <p className="actions">
        <ExportButton domain="sales_items" label={t('sales.items.export')} />
      </p>
      {canManage ? (
        <Card
          title={
            editing ? t('sales.items.editTitle', { name: editing.name }) : t('sales.items.new')
          }
        >
          <form className="form" onSubmit={submit}>
            <ErrorAlert error={save.error} />
            <div className="form-grid">
              <TextField
                label={t('sales.field.name')}
                value={form.name}
                required
                error={issue('name')}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <TextField
                label={t('sales.field.sku')}
                value={form.sku}
                error={issue('sku')}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
              />
              <div className="field">
                <label htmlFor="item-type">{t('sales.field.itemType')}</label>
                <select
                  id="item-type"
                  value={form.itemType}
                  onChange={(e) =>
                    setForm({ ...form, itemType: e.target.value as ItemForm['itemType'] })
                  }
                >
                  <option value="service">{t('sales.items.service')}</option>
                  <option value="product">{t('sales.items.product')}</option>
                </select>
              </div>
              <TextField
                label={t('sales.field.unitPrice')}
                inputMode="decimal"
                value={form.unitPrice}
                hint={t('sales.items.priceHint')}
                error={issue('unitPrice')}
                onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
              />
              {canAccounts ? (
                <div className="field">
                  <label htmlFor="item-revenue">{t('sales.field.revenueAccount')}</label>
                  <select
                    id="item-revenue"
                    value={form.revenueAccountId}
                    onChange={(e) => setForm({ ...form, revenueAccountId: e.target.value })}
                  >
                    <option value="">{t('sales.items.defaultRevenue')}</option>
                    {revenueAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="field">
                <label htmlFor="item-tax">{t('sales.field.taxCode')}</label>
                <select
                  id="item-tax"
                  value={form.taxCodeId}
                  onChange={(e) => setForm({ ...form, taxCodeId: e.target.value })}
                >
                  <option value="">{t('sales.editor.noTax')}</option>
                  {(taxCodes.data ?? [])
                    .filter((c) => c.status === 'ACTIVE')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <TextField
              label={t('sales.field.description')}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <p className="actions">
              <Button type="submit" busy={save.isPending}>
                {editing ? t('common.save') : t('sales.items.create')}
              </Button>
              {editing ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(null);
                    setForm(blank);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              ) : null}
            </p>
          </form>
        </Card>
      ) : null}
      <Card>
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
          <div className="field">
            <label htmlFor="item-status">{t('sales.field.status')}</label>
            <select id="item-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">{t('sales.status.active')}</option>
              <option value="archived">{t('sales.status.archived')}</option>
              <option value="all">{t('common.all')}</option>
            </select>
          </div>
          <Button type="submit">{t('common.search')}</Button>
        </form>
        <ErrorAlert error={toggle.error} />
        {list.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">{t('sales.items.none')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('sales.field.name')}</th>
                <th>{t('sales.field.sku')}</th>
                <th>{t('sales.field.itemType')}</th>
                <th className="num">{t('sales.field.unitPrice')}</th>
                <th>{t('sales.field.taxCode')}</th>
                <th>{t('sales.field.status')}</th>
                {canManage ? (
                  <th>
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>{item.sku}</td>
                  <td>{t(`sales.items.${item.itemType}`)}</td>
                  <td className="num">{item.unitPrice ?? ''}</td>
                  <td>{codeOf(item.taxCodeId)}</td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  {canManage ? (
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setEditing(item);
                          setForm({
                            sku: item.sku ?? '',
                            name: item.name,
                            itemType: item.itemType,
                            description: item.description,
                            unitPrice: item.unitPrice ?? '',
                            revenueAccountId: item.revenueAccountId ?? '',
                            taxCodeId: item.taxCodeId ?? '',
                          });
                        }}
                      >
                        {t('common.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        busy={toggle.isPending}
                        onClick={() => toggle.mutate(item, { onSuccess: refresh })}
                      >
                        {item.status === 'ACTIVE' ? t('common.archive') : t('common.restore')}
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
