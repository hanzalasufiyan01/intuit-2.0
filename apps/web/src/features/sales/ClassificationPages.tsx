import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { Permission, useAnyPermission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { CATALOG_MANAGE_PERMISSIONS } from './SalesSection';
import { SalesNav, useOrgKey } from './shared';
import { useT, type MessageKey } from '../../i18n/i18n';

/**
 * Customer groups, custom fields on customers, item categories and barcodes (migration 0088,
 * master specification sections 10, 16 and 18). The server enforces every rule; these screens only
 * collect input and show what is stored.
 */

interface Named {
  id: string;
  name: string;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  members: number;
}
interface FieldDefinition {
  id: string;
  key: string;
  label: string;
  fieldType: 'text' | 'number' | 'date' | 'boolean' | 'list';
  options: string[] | null;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  value?: string | number | boolean | null;
}

const FIELD_TYPE_LABEL: Record<FieldDefinition['fieldType'], MessageKey> = {
  text: 'sales.classificationPages.fieldTypeLabel.text',
  number: 'sales.classificationPages.fieldTypeLabel.number',
  date: 'sales.classificationPages.fieldTypeLabel.date',
  boolean: 'sales.classificationPages.fieldTypeLabel.boolean',
  list: 'sales.classificationPages.fieldTypeLabel.list',
};

function NamedListCard({
  title,
  path,
  queryKey,
  canManage,
  singular,
}: {
  title: string;
  path: string;
  queryKey: string;
  canManage: boolean;
  singular: string;
}) {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: [queryKey, org],
    queryFn: () => api.get<Named[]>(path),
  });
  const [name, setName] = useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [queryKey, org] });
  const create = useApiMutation(() => api.post(path, { name: name.trim() }));
  const toggle = useApiMutation((row: Named) =>
    api.patch(`${path}/${row.id}`, {
      version: row.version,
      status: row.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE',
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: () => {
        setName('');
        refresh();
      },
    });
  };
  return (
    <Card title={title}>
      {list.isPending ? <Spinner /> : null}
      <ErrorAlert error={list.error ?? toggle.error} />
      {list.data && list.data.length === 0 ? (
        <p className="muted">{t('sales.classificationPages.noneYet')}</p>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>{t('sales.classificationPages.name')}</th>
              <th className="num">{t('sales.classificationPages.inUse')}</th>
              <th>{t('sales.classificationPages.status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td className="num">{row.members}</td>
                <td>
                  {row.status === 'ACTIVE'
                    ? t('sales.classificationPages.active')
                    : t('sales.classificationPages.archived')}
                </td>
                <td>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      aria-label={t(
                        row.status === 'ACTIVE'
                          ? 'sales.classificationPages.archiveNamed'
                          : 'sales.classificationPages.restoreNamed',
                        { name: row.name },
                      )}
                      onClick={() => toggle.mutate(row, { onSuccess: refresh })}
                    >
                      {row.status === 'ACTIVE' ? t('common.archive') : t('common.restore')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canManage ? (
        <form className="form form--inline" onSubmit={submit} noValidate>
          <TextField
            label={t('sales.classificationPages.newName', { singular })}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <ErrorAlert error={create.error} />
          <Button type="submit" busy={create.isPending} disabled={!name.trim()}>
            {t('sales.classificationPages.add', { singular })}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function FieldDefinitionsCard({ canManage }: { canManage: boolean }) {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const defs = useQuery({
    queryKey: ['custom-fields', org],
    queryFn: () => api.get<FieldDefinition[]>('/custom-fields'),
  });
  const blank = { key: '', label: '', fieldType: 'text', options: '' };
  const [form, setForm] = useState(blank);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['custom-fields', org] });
  const create = useApiMutation(() =>
    api.post('/custom-fields', {
      key: form.key.trim(),
      label: form.label.trim(),
      fieldType: form.fieldType,
      ...(form.fieldType === 'list'
        ? {
            options: form.options
              .split(/[\n,]/)
              .map((o) => o.trim())
              .filter(Boolean),
          }
        : {}),
    }),
  );
  const toggle = useApiMutation((d: FieldDefinition) =>
    api.patch(`/custom-fields/${d.id}`, {
      version: d.version,
      status: d.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE',
    }),
  );
  return (
    <Card title={t('sales.classificationPages.customerCustomFields')}>
      <ErrorAlert error={defs.error ?? toggle.error} />
      {defs.data && defs.data.length === 0 ? (
        <p className="muted">{t('sales.classificationPages.noCustomFieldsYet')}</p>
      ) : null}
      {defs.data && defs.data.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>{t('sales.classificationPages.label')}</th>
              <th>{t('sales.classificationPages.key')}</th>
              <th>{t('sales.classificationPages.type')}</th>
              <th>{t('sales.classificationPages.status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {defs.data.map((d) => (
              <tr key={d.id}>
                <td>{d.label}</td>
                <td>{d.key}</td>
                <td>
                  {t(FIELD_TYPE_LABEL[d.fieldType])}
                  {d.options ? ` (${d.options.join(', ')})` : ''}
                </td>
                <td>
                  {d.status === 'ACTIVE'
                    ? t('sales.classificationPages.active')
                    : t('sales.classificationPages.archived')}
                </td>
                <td>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      aria-label={t('sales.classificationPages.field', {
                        value: d.status === 'ACTIVE' ? 'Archive' : 'Restore',
                        label: d.label,
                      })}
                      onClick={() => toggle.mutate(d, { onSuccess: refresh })}
                    >
                      {d.status === 'ACTIVE' ? t('common.archive') : t('common.restore')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canManage ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined, {
              onSuccess: () => {
                setForm(blank);
                refresh();
              },
            });
          }}
          noValidate
        >
          <TextField
            label={t('sales.classificationPages.fieldLabel')}
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
          <TextField
            label={t('sales.classificationPages.fieldKey')}
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase() })}
          />
          <small className="field__hint">
            {t('sales.classificationPages.lowerCaseLettersDigitsAnd')}
          </small>
          <div className="field">
            <label htmlFor="field-type">{t('sales.classificationPages.fieldType')}</label>
            <select
              id="field-type"
              value={form.fieldType}
              onChange={(e) => setForm({ ...form, fieldType: e.target.value })}
            >
              {Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {t(label)}
                </option>
              ))}
            </select>
          </div>
          {form.fieldType === 'list' ? (
            <TextField
              label={t('sales.classificationPages.choicesCommaOrLineSeparated')}
              value={form.options}
              onChange={(e) => setForm({ ...form, options: e.target.value })}
            />
          ) : null}
          <ErrorAlert error={create.error} />
          <Button type="submit" busy={create.isPending} disabled={!form.key || !form.label.trim()}>
            {t('sales.classificationPages.addField')}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

export function ClassificationPage() {
  const t = useT();
  const canCustomers = usePermission(Permission.CustomersUpdate);
  const canItems = useAnyPermission(CATALOG_MANAGE_PERMISSIONS);
  const canViewCustomers = usePermission(Permission.CustomersView);
  const canViewItems = useAnyPermission([
    Permission.InvoicesView,
    Permission.BillsView,
    ...CATALOG_MANAGE_PERMISSIONS,
  ]);
  return (
    <>
      <PageHeader
        title={t('sales.classificationPages.groupsFieldsAndCategories')}
        description={t('sales.classificationPages.groupCustomersAddYourOwn')}
      />
      <SalesNav />
      {canViewCustomers ? (
        <NamedListCard
          title={t('sales.classificationPages.customerGroups')}
          path="/customer-groups"
          queryKey="customer-groups"
          canManage={canCustomers}
          singular={t('sales.classificationPages.noun.group')}
        />
      ) : null}
      {canViewCustomers ? <FieldDefinitionsCard canManage={canCustomers} /> : null}
      {canViewItems ? (
        <NamedListCard
          title={t('sales.classificationPages.variantGroups')}
          path="/variant-groups"
          queryKey="variant-groups"
          canManage={canItems}
          singular={t('sales.classificationPages.noun.variantGroup')}
        />
      ) : null}
      {canViewItems ? (
        <NamedListCard
          title={t('sales.classificationPages.itemCategories')}
          path="/item-categories"
          queryKey="item-categories"
          canManage={canItems}
          singular={t('sales.classificationPages.noun.category')}
        />
      ) : null}
    </>
  );
}

/** Group and custom fields of one customer, shown on the customer's page. */
export function CustomerClassificationCards({ customerId }: { customerId: string }) {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canUpdate = usePermission(Permission.CustomersUpdate);
  const group = useQuery({
    queryKey: ['customer-group', org, customerId],
    queryFn: () =>
      api.get<{ groupId: string | null; name: string | null }>(`/customers/${customerId}/group`),
  });
  const groups = useQuery({
    queryKey: ['customer-groups', org],
    queryFn: () => api.get<Named[]>('/customer-groups'),
  });
  const fields = useQuery({
    queryKey: ['customer-fields', org, customerId],
    queryFn: () => api.get<FieldDefinition[]>(`/customers/${customerId}/custom-fields`),
  });
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const setGroup = useApiMutation((groupId: string | null) =>
    api.put(`/customers/${customerId}/group`, { groupId }),
  );
  const saveFields = useApiMutation((values: Record<string, string | number | boolean | null>) =>
    api.put(`/customers/${customerId}/custom-fields`, { values }),
  );
  const shown = (d: FieldDefinition) =>
    draft[d.key] ?? (d.value === null || d.value === undefined ? '' : d.value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const values: Record<string, string | number | boolean | null> = {};
    for (const d of fields.data ?? []) {
      if (!(d.key in draft)) continue;
      const raw = draft[d.key]!;
      if (raw === '') values[d.key] = null;
      else if (d.fieldType === 'number') values[d.key] = Number(raw);
      else values[d.key] = raw;
    }
    if (Object.keys(values).length === 0) return;
    saveFields.mutate(values, {
      onSuccess: () => {
        setDraft({});
        void queryClient.invalidateQueries({ queryKey: ['customer-fields', org, customerId] });
      },
    });
  };
  return (
    <>
      <Card title={t('sales.classificationPages.group')}>
        <ErrorAlert error={group.error ?? setGroup.error} />
        <div className="field">
          <label htmlFor="customer-group">{t('sales.classificationPages.customerGroup')}</label>
          <select
            id="customer-group"
            value={group.data?.groupId ?? ''}
            disabled={!canUpdate}
            onChange={(e) =>
              setGroup.mutate(e.target.value || null, {
                onSuccess: () =>
                  void queryClient.invalidateQueries({
                    queryKey: ['customer-group', org, customerId],
                  }),
              })
            }
          >
            <option value="">{t('sales.classificationPages.noGroup')}</option>
            {(groups.data ?? [])
              .filter((g) => g.status === 'ACTIVE' || g.id === group.data?.groupId)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
        </div>
      </Card>
      {fields.data && fields.data.length > 0 ? (
        <Card title={t('sales.classificationPages.customFields')}>
          <form className="form" onSubmit={submit} noValidate>
            {fields.data.map((d) =>
              d.fieldType === 'boolean' ? (
                <div className="field" key={d.id}>
                  <label htmlFor={`cf-${d.key}`}>{d.label}</label>
                  <select
                    id={`cf-${d.key}`}
                    disabled={!canUpdate || d.status === 'ARCHIVED'}
                    value={String(shown(d))}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        [d.key]: e.target.value === '' ? '' : e.target.value === 'true',
                      })
                    }
                  >
                    <option value="">{t('sales.classificationPages.notSet')}</option>
                    <option value="true">{t('sales.classificationPages.yes')}</option>
                    <option value="false">{t('sales.classificationPages.no')}</option>
                  </select>
                </div>
              ) : d.fieldType === 'list' ? (
                <div className="field" key={d.id}>
                  <label htmlFor={`cf-${d.key}`}>{d.label}</label>
                  <select
                    id={`cf-${d.key}`}
                    disabled={!canUpdate || d.status === 'ARCHIVED'}
                    value={String(shown(d))}
                    onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })}
                  >
                    <option value="">{t('sales.classificationPages.notSet')}</option>
                    {(d.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <TextField
                  key={d.id}
                  label={d.label}
                  type={d.fieldType === 'date' ? 'date' : 'text'}
                  inputMode={d.fieldType === 'number' ? 'decimal' : undefined}
                  disabled={!canUpdate || d.status === 'ARCHIVED'}
                  value={String(shown(d))}
                  onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })}
                />
              ),
            )}
            <ErrorAlert error={saveFields.error} />
            {canUpdate ? (
              <Button type="submit" busy={saveFields.isPending}>
                {t('sales.classificationPages.saveCustomFields')}
              </Button>
            ) : null}
          </form>
        </Card>
      ) : null}
    </>
  );
}

/** Bins (named locations) of the warehouses, shown on the Warehouses page. Labels, not stock. */
export function BinsCard() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.InventorySettingsManage);
  const bins = useQuery({
    queryKey: ['inventory-bins', org],
    queryFn: () =>
      api.get<
        {
          id: string;
          warehouseId: string;
          code: string;
          name: string;
          status: string;
          version: number;
        }[]
      >('/inventory/bins'),
  });
  const warehouses = useQuery({
    queryKey: ['inventory-warehouses', org],
    queryFn: () => api.get<{ id: string; code: string; name: string }[]>('/inventory/warehouses'),
  });
  const [form, setForm] = useState({ warehouseId: '', code: '', name: '' });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['inventory-bins', org] });
  const create = useApiMutation(() =>
    api.post('/inventory/bins', {
      warehouseId: form.warehouseId,
      code: form.code.trim(),
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
    }),
  );
  const toggle = useApiMutation((b: { id: string; status: string; version: number }) =>
    api.patch(`/inventory/bins/${b.id}`, {
      version: b.version,
      status: b.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE',
    }),
  );
  const warehouseName = (id: string) =>
    warehouses.data?.find((w) => w.id === id)?.name ?? id.slice(0, 8);
  return (
    <Card title={t('sales.classificationPages.binsNamedLocationsInsideA')}>
      <p className="muted">{t('sales.classificationPages.aBinIsALabel')}</p>
      <ErrorAlert error={bins.error ?? toggle.error} />
      {bins.data && bins.data.length === 0 ? (
        <p className="muted">{t('sales.classificationPages.noBinsYet')}</p>
      ) : null}
      {bins.data && bins.data.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>{t('sales.classificationPages.warehouse')}</th>
              <th>{t('sales.classificationPages.code')}</th>
              <th>{t('sales.classificationPages.name')}</th>
              <th>{t('sales.classificationPages.status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {bins.data.map((b) => (
              <tr key={b.id}>
                <td>{warehouseName(b.warehouseId)}</td>
                <td>{b.code}</td>
                <td>{b.name || '—'}</td>
                <td>
                  {b.status === 'ACTIVE'
                    ? t('sales.classificationPages.active')
                    : t('sales.classificationPages.archived')}
                </td>
                <td>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      aria-label={t('sales.classificationPages.bin', {
                        value: b.status === 'ACTIVE' ? 'Archive' : 'Restore',
                        code: b.code,
                      })}
                      onClick={() => toggle.mutate(b, { onSuccess: refresh })}
                    >
                      {b.status === 'ACTIVE' ? t('common.archive') : t('common.restore')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canManage ? (
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined, {
              onSuccess: () => {
                setForm({ warehouseId: form.warehouseId, code: '', name: '' });
                refresh();
              },
            });
          }}
          noValidate
        >
          <div className="field">
            <label htmlFor="bin-warehouse">{t('sales.classificationPages.binWarehouse')}</label>
            <select
              id="bin-warehouse"
              value={form.warehouseId}
              onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}
            >
              <option value="">{t('common.choose')}</option>
              {(warehouses.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('sales.classificationPages.binCode')}
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
          <TextField
            label={t('sales.classificationPages.binNameOptional')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <ErrorAlert error={create.error} />
          <Button
            type="submit"
            busy={create.isPending}
            disabled={!form.warehouseId || !form.code.trim()}
          >
            {t('sales.classificationPages.addBin')}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

/** Category and barcodes of one item, shown beside the item editor. */
export function ItemClassificationCard({ itemId }: { itemId: string }) {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = useAnyPermission(CATALOG_MANAGE_PERMISSIONS);
  const info = useQuery({
    queryKey: ['item-classification', org, itemId],
    queryFn: () =>
      api.get<{ categoryId: string | null; categoryName: string | null; barcodes: string[] }>(
        `/sales/items/${itemId}/classification`,
      ),
  });
  const categories = useQuery({
    queryKey: ['item-categories', org],
    queryFn: () => api.get<Named[]>('/item-categories'),
  });
  const [codes, setCodes] = useState<string | null>(null);
  const variantInfo = useQuery({
    queryKey: ['item-variant', org, itemId],
    queryFn: () =>
      api.get<{
        groupId: string | null;
        groupName: string | null;
        attributes: Record<string, string> | null;
      }>(`/sales/items/${itemId}/variant`),
  });
  const variantGroupList = useQuery({
    queryKey: ['variant-groups', org],
    queryFn: () => api.get<Named[]>('/variant-groups'),
  });
  const [variantGroup, setVariantGroup] = useState<string | null>(null);
  const [attributeText, setAttributeText] = useState<string | null>(null);
  const shownGroup = variantGroup ?? variantInfo.data?.groupId ?? '';
  const shownAttributes =
    attributeText ??
    Object.entries(variantInfo.data?.attributes ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
  const saveVariant = useApiMutation(() =>
    api.put(`/sales/items/${itemId}/variant`, {
      groupId: shownGroup || null,
      ...(shownGroup
        ? {
            attributes: Object.fromEntries(
              shownAttributes
                .split(',')
                .map((pair) => pair.split('=').map((x) => x.trim()))
                .filter((kv) => kv.length === 2 && kv[0] && kv[1]) as [string, string][],
            ),
          }
        : {}),
    }),
  );
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['item-classification', org, itemId] });
  const setCategory = useApiMutation((categoryId: string | null) =>
    api.put(`/sales/items/${itemId}/category`, { categoryId }),
  );
  const saveCodes = useApiMutation((barcodes: string[]) =>
    api.put(`/sales/items/${itemId}/barcodes`, { barcodes }),
  );
  const text = codes ?? (info.data?.barcodes ?? []).join('\n');
  return (
    <Card title={t('sales.classificationPages.categoryAndBarcodes')}>
      <ErrorAlert error={info.error ?? setCategory.error ?? saveCodes.error ?? saveVariant.error} />
      <div className="field">
        <label htmlFor="item-category">{t('sales.classificationPages.itemCategory')}</label>
        <select
          id="item-category"
          value={info.data?.categoryId ?? ''}
          disabled={!canManage}
          onChange={(e) => setCategory.mutate(e.target.value || null, { onSuccess: refresh })}
        >
          <option value="">{t('sales.classificationPages.noCategory')}</option>
          {(categories.data ?? [])
            .filter((c) => c.status === 'ACTIVE' || c.id === info.data?.categoryId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="item-barcodes">{t('sales.classificationPages.barcodesOnePerLine')}</label>
        <textarea
          id="item-barcodes"
          rows={3}
          disabled={!canManage}
          value={text}
          onChange={(e) => setCodes(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="item-variant-group">{t('sales.classificationPages.variantGroup')}</label>
        <select
          id="item-variant-group"
          value={shownGroup}
          disabled={!canManage}
          onChange={(e) => setVariantGroup(e.target.value)}
        >
          <option value="">{t('sales.classificationPages.notAVariant')}</option>
          {(variantGroupList.data ?? [])
            .filter((g) => g.status === 'ACTIVE' || g.id === variantInfo.data?.groupId)
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </select>
      </div>
      {shownGroup ? (
        <TextField
          label={t('sales.classificationPages.variantAttributesNameValueComma')}
          value={shownAttributes}
          disabled={!canManage}
          onChange={(e) => setAttributeText(e.target.value)}
        />
      ) : null}
      {canManage ? (
        <Button
          variant="secondary"
          busy={saveVariant.isPending}
          onClick={() =>
            saveVariant.mutate(undefined, {
              onSuccess: () => {
                setVariantGroup(null);
                setAttributeText(null);
                void queryClient.invalidateQueries({ queryKey: ['item-variant', org, itemId] });
                void queryClient.invalidateQueries({ queryKey: ['variant-groups', org] });
              },
            })
          }
        >
          {t('sales.classificationPages.saveVariant')}
        </Button>
      ) : null}
      {canManage ? (
        <Button
          busy={saveCodes.isPending}
          onClick={() =>
            saveCodes.mutate(
              text
                .split(/\n/)
                .map((c) => c.trim())
                .filter(Boolean),
              {
                onSuccess: () => {
                  setCodes(null);
                  refresh();
                },
              },
            )
          }
        >
          {t('sales.classificationPages.saveBarcodes')}
        </Button>
      ) : null}
    </Card>
  );
}
