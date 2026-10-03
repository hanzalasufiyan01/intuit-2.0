import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { useT } from '../../i18n/i18n';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { useOrgKey, useTaxCodes } from '../sales/shared';
import { PurchasesNav } from './PurchasesSection';
import {
  PURCHASE_ACCOUNT_SUBTYPES,
  PURCHASE_DOCUMENT_TYPES,
  type PurchaseDocumentType,
  type PurchasesSettings,
} from './types';

type NumberingForm = Record<
  PurchaseDocumentType,
  { prefix: string; minDigits: string; nextNumber: string }
>;

interface SettingsForm {
  apAccountId: string;
  defaultExpenseAccountId: string;
  defaultPaymentAccountId: string;
  defaultTaxCodeId: string;
  defaultTaxTreatment: PurchasesSettings['defaultTaxTreatment'];
  defaultPaymentTermsDays: string;
  numbering: NumberingForm;
}

function toForm(s: PurchasesSettings): SettingsForm {
  return {
    apAccountId: s.apAccountId ?? s.suggestedApAccountId ?? '',
    defaultExpenseAccountId: s.defaultExpenseAccountId ?? '',
    defaultPaymentAccountId: s.defaultPaymentAccountId ?? '',
    defaultTaxCodeId: s.defaultTaxCodeId ?? '',
    defaultTaxTreatment: s.defaultTaxTreatment,
    defaultPaymentTermsDays: String(s.defaultPaymentTermsDays),
    numbering: Object.fromEntries(
      PURCHASE_DOCUMENT_TYPES.map((d) => [
        d,
        {
          prefix: s.numbering[d].prefix,
          minDigits: String(s.numbering[d].minDigits),
          nextNumber: String(s.numbering[d].nextNumber),
        },
      ]),
    ) as NumberingForm,
  };
}

/**
 * Purchases settings and numbering (Phase 4A-4; ADR 0004 P4-07, P4-08, P4-51): the AP control
 * account, defaults and numbering. Reading and changing need purchases.settings.manage; saving
 * asks for the password again (P4-42). UX only: the server validates and authorizes everything.
 */
export function PurchasesSettingsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canManage = usePermission(Permission.PurchasesSettingsManage);
  const settings = useQuery({
    queryKey: ['purchases-settings', org],
    queryFn: () => api.get<PurchasesSettings>('/purchases/settings'),
  });
  const accounts = useAccounts(usePermission(Permission.AccountsView));
  const taxCodes = useTaxCodes();
  const [form, setForm] = useState<SettingsForm | null>(null);
  const s = settings.data;
  if (s && form === null) setForm(toForm(s));
  const save = useApiMutation(() =>
    sensitive(() =>
      api.put<PurchasesSettings>('/purchases/settings', {
        version: s!.version,
        apAccountId: form!.apAccountId || null,
        defaultExpenseAccountId: form!.defaultExpenseAccountId || null,
        defaultPaymentAccountId: form!.defaultPaymentAccountId || null,
        defaultTaxCodeId: form!.defaultTaxCodeId || null,
        defaultTaxTreatment: form!.defaultTaxTreatment,
        defaultPaymentTermsDays: Number(form!.defaultPaymentTermsDays),
        numbering: Object.fromEntries(
          PURCHASE_DOCUMENT_TYPES.map((d) => [
            d,
            {
              prefix: form!.numbering[d].prefix,
              minDigits: Number(form!.numbering[d].minDigits),
              nextNumber: Number(form!.numbering[d].nextNumber),
            },
          ]),
        ),
      }),
    ),
  );
  if (settings.isError) {
    return (
      <>
        <PageHeader title={t('purchases.settings.title')} />
        <PurchasesNav />
        <ErrorAlert error={settings.error} />
      </>
    );
  }
  if (settings.isPending || !form) return <Spinner label={t('common.loading')} />;

  const all = accounts.data ?? [];
  const usable = (a: (typeof all)[number]) => a.status === 'ACTIVE' && a.isLeaf !== false;
  // Display filters only; the server applies the full rules (base currency, ownership, history).
  const apOptions = all.filter(
    (a) =>
      usable(a) && a.subtype === 'ACCOUNTS_PAYABLE' && (a.controlSubledger ?? null) !== 'sales',
  );
  const expenseOptions = all.filter(
    (a) =>
      usable(a) &&
      !a.isControlAccount &&
      a.subtype !== null &&
      (PURCHASE_ACCOUNT_SUBTYPES as readonly string[]).includes(a.subtype),
  );
  const paymentOptions = all.filter(
    (a) =>
      usable(a) &&
      !a.isControlAccount &&
      (a.subtype === 'BANK' || a.subtype === 'CASH' || a.subtype === 'CREDIT_CARD'),
  );
  const issue = (path: string) =>
    save.error instanceof ApiError ? save.error.fieldError(path) : undefined;
  const accountSelect = (
    field: 'apAccountId' | 'defaultExpenseAccountId' | 'defaultPaymentAccountId',
    label: string,
    options: typeof all,
    disabled = false,
  ) => {
    const value = form[field];
    return (
      <div className="field">
        <label htmlFor={`purchases-${field}`}>{label}</label>
        <select
          id={`purchases-${field}`}
          value={value}
          disabled={!canManage || disabled}
          onChange={(e) => setForm({ ...form, [field]: e.target.value })}
        >
          <option value="">{t('common.none')}</option>
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name} ({a.currencyCode})
            </option>
          ))}
          {value && !options.some((a) => a.id === value) ? (
            <option value={value}>{all.find((a) => a.id === value)?.name ?? value}</option>
          ) : null}
        </select>
        {issue(field) ? <small className="field__error">{issue(field)}</small> : null}
      </div>
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined, {
      onSuccess: (saved) => {
        queryClient.setQueryData(['purchases-settings', org], saved);
        setForm(null);
      },
    });
  };
  return (
    <>
      <PageHeader
        title={t('purchases.settings.title')}
        description={t('purchases.settings.description')}
      />
      <PurchasesNav />
      {!settings.data.configured ? (
        <Alert tone="info">{t('purchases.settings.notConfigured')}</Alert>
      ) : null}
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={save.error} />
        {save.isSuccess ? <Alert tone="success">{t('common.saved')}</Alert> : null}
        <Card title={t('purchases.settings.accounts')}>
          <div className="form-grid">
            {accountSelect(
              'apAccountId',
              t('purchases.field.apAccount'),
              apOptions,
              settings.data.apLocked,
            )}
            {accountSelect(
              'defaultExpenseAccountId',
              t('purchases.field.defaultExpenseAccount'),
              expenseOptions,
            )}
            {accountSelect(
              'defaultPaymentAccountId',
              t('purchases.field.defaultPaymentAccount'),
              paymentOptions,
            )}
          </div>
          <p className="muted">
            {settings.data.apLocked
              ? t('purchases.settings.apLocked')
              : t('purchases.settings.apNote')}
          </p>
        </Card>
        <Card title={t('purchases.settings.defaults')}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="purchases-tax-code">{t('purchases.field.defaultTaxCode')}</label>
              <select
                id="purchases-tax-code"
                value={form.defaultTaxCodeId}
                disabled={!canManage}
                onChange={(e) => setForm({ ...form, defaultTaxCodeId: e.target.value })}
              >
                <option value="">{t('common.none')}</option>
                {(taxCodes.data ?? [])
                  .filter((c) => c.status === 'ACTIVE' || c.id === form.defaultTaxCodeId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {c.name}
                    </option>
                  ))}
              </select>
              {issue('defaultTaxCodeId') ? (
                <small className="field__error">{issue('defaultTaxCodeId')}</small>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="purchases-treatment">{t('sales.field.taxTreatment')}</label>
              <select
                id="purchases-treatment"
                value={form.defaultTaxTreatment}
                disabled={!canManage}
                onChange={(e) =>
                  setForm({
                    ...form,
                    defaultTaxTreatment: e.target.value as SettingsForm['defaultTaxTreatment'],
                  })
                }
              >
                <option value="exclusive">{t('sales.treatment.exclusive')}</option>
                <option value="inclusive">{t('sales.treatment.inclusive')}</option>
                <option value="no_tax">{t('sales.treatment.no_tax')}</option>
              </select>
            </div>
            <TextField
              label={t('purchases.field.paymentTerms')}
              inputMode="numeric"
              value={form.defaultPaymentTermsDays}
              disabled={!canManage}
              error={issue('defaultPaymentTermsDays')}
              onChange={(e) => setForm({ ...form, defaultPaymentTermsDays: e.target.value })}
            />
          </div>
        </Card>
        <Card title={t('purchases.settings.numbering')}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('sales.settings.document')}</th>
                <th>{t('sales.settings.prefix')}</th>
                <th>{t('sales.settings.digits')}</th>
                <th>{t('sales.settings.next')}</th>
                <th>{t('sales.settings.preview')}</th>
              </tr>
            </thead>
            <tbody>
              {PURCHASE_DOCUMENT_TYPES.map((d) => {
                const row = form.numbering[d];
                const doc = t(`purchases.settings.doc.${d}`);
                const set = (patch: Partial<typeof row>) =>
                  setForm({ ...form, numbering: { ...form.numbering, [d]: { ...row, ...patch } } });
                const preview = `${row.prefix}${String(row.nextNumber).padStart(Number(row.minDigits) || 1, '0')}`;
                return (
                  <tr key={d}>
                    <td>{doc}</td>
                    <td>
                      <input
                        aria-label={t('sales.settings.prefixFor', { doc })}
                        value={row.prefix}
                        disabled={!canManage}
                        onChange={(e) => set({ prefix: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={t('sales.settings.digitsFor', { doc })}
                        className="num"
                        inputMode="numeric"
                        value={row.minDigits}
                        disabled={!canManage}
                        onChange={(e) => set({ minDigits: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={t('sales.settings.nextFor', { doc })}
                        className="num"
                        inputMode="numeric"
                        value={row.nextNumber}
                        disabled={!canManage}
                        onChange={(e) => set({ nextNumber: e.target.value })}
                      />
                      {issue(`numbering.${d}.nextNumber`) ? (
                        <small className="field__error">{issue(`numbering.${d}.nextNumber`)}</small>
                      ) : null}
                    </td>
                    <td>{preview}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted">{t('purchases.settings.numberingNote')}</p>
        </Card>
        {canManage ? (
          <p className="actions">
            <Button type="submit" busy={save.isPending}>
              {t('purchases.settings.save')}
            </Button>
          </p>
        ) : null}
      </form>
    </>
  );
}
