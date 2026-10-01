import { useQueryClient } from '@tanstack/react-query';
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
import { SalesNav, StatusBadge, useOrgKey, useSalesSettings, useTaxCodes } from './shared';
import type { DocumentTypeKey, SalesSettings, TaxCode, TaxTreatment } from './types';

const DOC_TYPES: DocumentTypeKey[] = ['invoice', 'credit_note', 'receipt'];

/** Sales settings and numbering (D3, D7): changes need sales.settings.manage and re-authentication. */
export function SalesSettingsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canManage = usePermission(Permission.SalesSettingsManage);
  const settings = useSalesSettings();
  const accounts = useAccounts(usePermission(Permission.AccountsView));
  const taxCodes = useTaxCodes();
  const [form, setForm] = useState<null | {
    arAccountId: string;
    defaultRevenueAccountId: string;
    defaultDepositAccountId: string;
    defaultTaxCodeId: string;
    defaultTaxTreatment: TaxTreatment;
    defaultPaymentTermsDays: string;
    numbering: Record<DocumentTypeKey, { prefix: string; minDigits: string; nextNumber: string }>;
  }>(null);
  const s = settings.data;
  if (s && form === null) {
    setForm({
      arAccountId: s.arAccountId ?? s.suggestedArAccountId ?? '',
      defaultRevenueAccountId: s.defaultRevenueAccountId ?? '',
      defaultDepositAccountId: s.defaultDepositAccountId ?? '',
      defaultTaxCodeId: s.defaultTaxCodeId ?? '',
      defaultTaxTreatment: s.defaultTaxTreatment,
      defaultPaymentTermsDays: String(s.defaultPaymentTermsDays),
      numbering: Object.fromEntries(
        DOC_TYPES.map((d) => [
          d,
          {
            prefix: s.numbering[d].prefix,
            minDigits: String(s.numbering[d].minDigits),
            nextNumber: String(s.numbering[d].nextNumber),
          },
        ]),
      ) as Record<DocumentTypeKey, { prefix: string; minDigits: string; nextNumber: string }>,
    });
  }
  const save = useApiMutation(() =>
    sensitive(() =>
      api.put<SalesSettings>('/sales/settings', {
        version: s!.version,
        arAccountId: form!.arAccountId || null,
        defaultRevenueAccountId: form!.defaultRevenueAccountId || null,
        defaultDepositAccountId: form!.defaultDepositAccountId || null,
        defaultTaxCodeId: form!.defaultTaxCodeId || null,
        defaultTaxTreatment: form!.defaultTaxTreatment,
        defaultPaymentTermsDays: Number(form!.defaultPaymentTermsDays),
        numbering: Object.fromEntries(
          DOC_TYPES.map((d) => [
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
  if (settings.isError) return <ErrorAlert error={settings.error} />;
  if (settings.isPending || !form) return <Spinner label={t('common.loading')} />;
  const all = accounts.data ?? [];
  const leaf = (a: (typeof all)[number]) => a.status === 'ACTIVE' && a.isLeaf !== false;
  const arOptions = all.filter((a) => leaf(a) && a.subtype === 'ACCOUNTS_RECEIVABLE');
  const revenueOptions = all.filter((a) => leaf(a) && a.type === 'REVENUE');
  const depositOptions = all.filter(
    (a) => leaf(a) && (a.subtype === 'BANK' || a.subtype === 'CASH'),
  );
  const issue = (path: string) =>
    save.error instanceof ApiError ? save.error.fieldError(path) : undefined;
  const accountSelect = (
    id: string,
    label: string,
    value: string,
    options: typeof all,
    onChange: (v: string) => void,
    disabled = false,
  ) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={!canManage || disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('common.none')}</option>
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} {a.name} ({a.currencyCode})
          </option>
        ))}
        {value && !options.some((a) => a.id === value) ? (
          <option value={value}>{value}</option>
        ) : null}
      </select>
      {issue(id.replace('settings-', '')) ? (
        <small className="field__error">{issue(id.replace('settings-', ''))}</small>
      ) : null}
    </div>
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined, {
      onSuccess: (saved) => {
        queryClient.setQueryData(['sales-settings', org], saved);
        setForm(null);
      },
    });
  };
  return (
    <>
      <PageHeader title={t('sales.settings.title')} description={t('sales.settings.description')} />
      <SalesNav />
      {!settings.data.configured ? (
        <Alert tone="info">{t('sales.settings.notConfigured')}</Alert>
      ) : null}
      {!canManage ? <Alert tone="info">{t('sales.settings.readOnly')}</Alert> : null}
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={save.error} />
        {save.isSuccess ? <Alert tone="success">{t('common.saved')}</Alert> : null}
        <Card title={t('sales.settings.accounts')}>
          <div className="form-grid">
            {accountSelect(
              'settings-arAccountId',
              t('sales.field.arAccount'),
              form.arAccountId,
              arOptions,
              (v) => setForm({ ...form, arAccountId: v }),
              settings.data.arLocked,
            )}
            {accountSelect(
              'settings-defaultRevenueAccountId',
              t('sales.field.revenueAccount'),
              form.defaultRevenueAccountId,
              revenueOptions,
              (v) => setForm({ ...form, defaultRevenueAccountId: v }),
            )}
            {accountSelect(
              'settings-defaultDepositAccountId',
              t('sales.field.depositAccount'),
              form.defaultDepositAccountId,
              depositOptions,
              (v) => setForm({ ...form, defaultDepositAccountId: v }),
            )}
          </div>
          <p className="muted">
            {settings.data.arLocked ? t('sales.settings.arLocked') : t('sales.settings.arNote')}
          </p>
        </Card>
        <Card title={t('sales.settings.defaults')}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="settings-tax-code">{t('sales.field.defaultTaxCode')}</label>
              <select
                id="settings-tax-code"
                value={form.defaultTaxCodeId}
                disabled={!canManage}
                onChange={(e) => setForm({ ...form, defaultTaxCodeId: e.target.value })}
              >
                <option value="">{t('common.none')}</option>
                {(taxCodes.data ?? [])
                  .filter((c) => c.status === 'ACTIVE')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {c.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="settings-treatment">{t('sales.field.taxTreatment')}</label>
              <select
                id="settings-treatment"
                value={form.defaultTaxTreatment}
                disabled={!canManage}
                onChange={(e) =>
                  setForm({ ...form, defaultTaxTreatment: e.target.value as TaxTreatment })
                }
              >
                <option value="exclusive">{t('sales.treatment.exclusive')}</option>
                <option value="inclusive">{t('sales.treatment.inclusive')}</option>
                <option value="no_tax">{t('sales.treatment.no_tax')}</option>
              </select>
            </div>
            <TextField
              label={t('sales.field.paymentTerms')}
              inputMode="numeric"
              value={form.defaultPaymentTermsDays}
              disabled={!canManage}
              error={issue('defaultPaymentTermsDays')}
              onChange={(e) => setForm({ ...form, defaultPaymentTermsDays: e.target.value })}
            />
          </div>
        </Card>
        <Card title={t('sales.settings.numbering')}>
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
              {DOC_TYPES.map((d) => {
                const row = form.numbering[d];
                const set = (patch: Partial<typeof row>) =>
                  setForm({ ...form, numbering: { ...form.numbering, [d]: { ...row, ...patch } } });
                const preview = `${row.prefix}${String(row.nextNumber).padStart(Number(row.minDigits) || 1, '0')}`;
                return (
                  <tr key={d}>
                    <td>{t(`sales.settings.doc.${d}`)}</td>
                    <td>
                      <input
                        aria-label={t('sales.settings.prefixFor', {
                          doc: t(`sales.settings.doc.${d}`),
                        })}
                        value={row.prefix}
                        disabled={!canManage}
                        onChange={(e) => set({ prefix: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={t('sales.settings.digitsFor', {
                          doc: t(`sales.settings.doc.${d}`),
                        })}
                        className="num"
                        inputMode="numeric"
                        value={row.minDigits}
                        disabled={!canManage}
                        onChange={(e) => set({ minDigits: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={t('sales.settings.nextFor', {
                          doc: t(`sales.settings.doc.${d}`),
                        })}
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
          <p className="muted">{t('sales.settings.numberingNote')}</p>
        </Card>
        {canManage ? (
          <p className="actions">
            <Button type="submit" busy={save.isPending}>
              {t('sales.settings.save')}
            </Button>
          </p>
        ) : null}
      </form>
    </>
  );
}

/** Tax codes and their dated rate versions (Decisions 15, 31, 60): tax.codes.manage with re-auth. */
export function TaxCodesPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canManage = usePermission(Permission.TaxCodesManage);
  const canAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canManage && canAccounts);
  const codes = useTaxCodes();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['tax-codes', org] });
  const [form, setForm] = useState({
    code: '',
    name: '',
    taxAccountId: '',
    rate: '',
    effectiveFrom: '',
  });
  const create = useApiMutation(() =>
    sensitive(() => api.post<TaxCode>('/tax/codes', { ...form, description: '' })),
  );
  const [rateFor, setRateFor] = useState<string | null>(null);
  const [rate, setRate] = useState({ rate: '', effectiveFrom: '' });
  const addRate = useApiMutation((code: TaxCode) =>
    sensitive(() => api.post<TaxCode>(`/tax/codes/${code.id}/rates`, rate)),
  );
  const toggle = useApiMutation((code: TaxCode) =>
    sensitive(() =>
      api.post<TaxCode>(
        `/tax/codes/${code.id}/${code.status === 'ACTIVE' ? 'archive' : 'restore'}`,
        { version: code.version },
      ),
    ),
  );
  const removeRate = useApiMutation((input: { code: TaxCode; rateId: string }) =>
    sensitive(() => api.delete<TaxCode>(`/tax/codes/${input.code.id}/rates/${input.rateId}`)),
  );
  const liabilities = (accounts.data ?? []).filter(
    (a) => a.type === 'LIABILITY' && a.status === 'ACTIVE' && a.isLeaf !== false,
  );
  return (
    <>
      <PageHeader title={t('sales.tax.title')} description={t('sales.tax.description')} />
      <SalesNav />
      <ErrorAlert error={addRate.error ?? toggle.error ?? removeRate.error} />
      {codes.isPending ? (
        <Spinner label={t('common.loading')} />
      ) : codes.isError ? (
        <ErrorAlert error={codes.error} />
      ) : (
        codes.data.map((code) => (
          <Card
            key={code.id}
            title={`${code.code} · ${code.name}`}
            actions={<StatusBadge status={code.status} />}
          >
            <table className="table">
              <thead>
                <tr>
                  <th>{t('sales.tax.effectiveFrom')}</th>
                  <th className="num">{t('sales.tax.rate')}</th>
                  <th>{t('sales.tax.note')}</th>
                  {canManage ? (
                    <th>
                      <span className="sr-only">{t('common.actions')}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {code.rates.map((r) => (
                  <tr key={r.id}>
                    <td>{r.effectiveFrom}</td>
                    <td className="num">{Number(r.rate)}%</td>
                    <td>
                      {r.verificationNote ? (
                        <span className="badge badge--warning">{t('sales.tax.verify')}</span>
                      ) : null}
                    </td>
                    {canManage ? (
                      <td>
                        <Button
                          variant="ghost"
                          disabled={code.rates.length === 1}
                          onClick={() =>
                            removeRate.mutate({ code, rateId: r.id }, { onSuccess: refresh })
                          }
                        >
                          {t('common.remove')}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
            {canManage ? (
              <div className="actions">
                {rateFor === code.id ? (
                  <form
                    className="form form--inline"
                    onSubmit={(e) => {
                      e.preventDefault();
                      addRate.mutate(code, {
                        onSuccess: () => {
                          setRateFor(null);
                          setRate({ rate: '', effectiveFrom: '' });
                          refresh();
                        },
                      });
                    }}
                  >
                    <TextField
                      label={t('sales.tax.rate')}
                      inputMode="decimal"
                      value={rate.rate}
                      required
                      onChange={(e) => setRate({ ...rate, rate: e.target.value })}
                    />
                    <TextField
                      label={t('sales.tax.effectiveFrom')}
                      type="date"
                      value={rate.effectiveFrom}
                      required
                      onChange={(e) => setRate({ ...rate, effectiveFrom: e.target.value })}
                    />
                    <Button type="submit" busy={addRate.isPending}>
                      {t('sales.tax.addRate')}
                    </Button>
                  </form>
                ) : (
                  <Button variant="secondary" onClick={() => setRateFor(code.id)}>
                    {t('sales.tax.newRate')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  busy={toggle.isPending}
                  onClick={() => toggle.mutate(code, { onSuccess: refresh })}
                >
                  {code.status === 'ACTIVE' ? t('common.archive') : t('common.restore')}
                </Button>
              </div>
            ) : null}
          </Card>
        ))
      )}
      {codes.data?.some((c) => c.rates.some((r) => r.verificationNote)) ? (
        <Alert tone="info">{t('sales.tax.verifyNote')}</Alert>
      ) : null}
      {canManage ? (
        <Card title={t('sales.tax.new')}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined, {
                onSuccess: () => {
                  setForm({ code: '', name: '', taxAccountId: '', rate: '', effectiveFrom: '' });
                  refresh();
                },
              });
            }}
          >
            <ErrorAlert error={create.error} />
            <div className="form-grid">
              <TextField
                label={t('sales.tax.code')}
                value={form.code}
                required
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              />
              <TextField
                label={t('sales.field.name')}
                value={form.name}
                required
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <div className="field">
                <label htmlFor="tax-account">{t('sales.tax.account')}</label>
                <select
                  id="tax-account"
                  value={form.taxAccountId}
                  required
                  onChange={(e) => setForm({ ...form, taxAccountId: e.target.value })}
                >
                  <option value="">{t('common.choose')}</option>
                  {liabilities.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <TextField
                label={t('sales.tax.rate')}
                inputMode="decimal"
                value={form.rate}
                required
                onChange={(e) => setForm({ ...form, rate: e.target.value })}
              />
              <TextField
                label={t('sales.tax.effectiveFrom')}
                type="date"
                value={form.effectiveFrom}
                required
                onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
              />
            </div>
            <p className="actions">
              <Button type="submit" busy={create.isPending}>
                {t('sales.tax.create')}
              </Button>
            </p>
          </form>
        </Card>
      ) : null}
    </>
  );
}
