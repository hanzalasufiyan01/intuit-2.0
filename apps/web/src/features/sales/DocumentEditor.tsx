import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useT } from '../../i18n/i18n';
import { api, ApiError } from '../../services/api-client';
import { COMMON_CURRENCIES } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import {
  orNull,
  useCustomerOptions,
  useItemOptions,
  useSalesSettings,
  useTaxCodes,
} from './shared';
import type {
  CreditNoteDetail,
  DiscountType,
  InvoiceDetail,
  InvoiceSummary,
  Page,
  TaxTreatment,
} from './types';

/**
 * The draft editor shared by invoices and credit notes (Decisions 32–35, 46). It sends the
 * inputs only; every amount is calculated by the server and shown on the document after saving.
 */

interface LineDraft {
  key: number;
  itemId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxCodeId: string;
}

let nextKey = 1;
const emptyLine = (): LineDraft => ({
  key: nextKey++,
  itemId: '',
  description: '',
  quantity: '1',
  unitPrice: '',
  discountPercent: '',
  taxCodeId: '',
});

export type EditorKind = 'invoice' | 'credit_note';

export function DocumentEditor({
  kind,
  existing,
  presetCustomerId,
  presetInvoiceId,
  saving,
  error,
  onSave,
}: {
  kind: EditorKind;
  existing: InvoiceDetail | CreditNoteDetail | null;
  presetCustomerId?: string | undefined;
  presetInvoiceId?: string | undefined;
  saving: boolean;
  error: unknown;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const settings = useSalesSettings();
  const customers = useCustomerOptions();
  const items = useItemOptions();
  const taxCodes = useTaxCodes();
  const invoiceExisting = kind === 'invoice' ? (existing as InvoiceDetail | null) : null;
  const creditExisting = kind === 'credit_note' ? (existing as CreditNoteDetail | null) : null;

  const [customerId, setCustomerId] = useState(existing?.customerId ?? presetCustomerId ?? '');
  const [date, setDate] = useState(
    invoiceExisting?.invoiceDate ??
      creditExisting?.creditDate ??
      new Date().toISOString().slice(0, 10),
  );
  const [dueDate, setDueDate] = useState(
    invoiceExisting && invoiceExisting.paymentTermsDays === null ? invoiceExisting.dueDate : '',
  );
  const [invoiceId, setInvoiceId] = useState(creditExisting?.invoiceId ?? presetInvoiceId ?? '');
  const [currencyCode, setCurrencyCode] = useState(existing?.currencyCode ?? '');
  const [taxTreatment, setTaxTreatment] = useState<TaxTreatment | ''>(existing?.taxTreatment ?? '');
  const [discountType, setDiscountType] = useState<DiscountType | ''>(
    existing?.discount?.type ?? '',
  );
  const [discountValue, setDiscountValue] = useState(existing?.discount?.value ?? '');
  const [reference, setReference] = useState(existing?.reference ?? '');
  const [memo, setMemo] = useState(existing?.memo ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    existing?.lines.map((l) => ({
      key: nextKey++,
      itemId: l.itemId ?? '',
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPercent: l.discount?.type === 'percent' ? l.discount.value : '',
      taxCodeId: l.taxCodeId ?? '',
    })) ?? [emptyLine()],
  );

  // A credit note may credit one of the customer's issued invoices (§M).
  const invoiceOptions = useQuery({
    queryKey: ['credit-invoice-options', customerId],
    queryFn: () =>
      api.get<Page<InvoiceSummary>>(
        `/sales/invoices?customerId=${customerId}&status=ISSUED&limit=200`,
      ),
    enabled: kind === 'credit_note' && customerId !== '',
  });

  const customer = customers.data?.items.find((c) => c.id === customerId);
  const issue = (path: string) => (error instanceof ApiError ? error.fieldError(path) : undefined);
  const update = (key: number, patch: Partial<LineDraft>) =>
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const pickItem = (key: number, itemId: string) => {
    const item = items.data?.items.find((i) => i.id === itemId);
    update(key, {
      itemId,
      ...(item
        ? {
            description: item.name,
            unitPrice: item.unitPrice ?? '',
            taxCodeId: item.taxCodeId ?? '',
          }
        : {}),
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body: Record<string, unknown> = {
      customerId,
      ...(kind === 'invoice' ? { invoiceDate: date } : { creditDate: date }),
      ...(currencyCode ? { currencyCode } : {}),
      ...(taxTreatment ? { taxTreatment } : {}),
      discount:
        discountType && discountValue.trim()
          ? { type: discountType, value: discountValue.trim() }
          : null,
      reference: orNull(reference),
      memo: memo.trim(),
      lines: lines.map((l) => ({
        ...(l.itemId ? { itemId: l.itemId } : {}),
        description: l.description.trim(),
        quantity: l.quantity.trim(),
        unitPrice: l.unitPrice.trim(),
        discount: l.discountPercent.trim()
          ? { type: 'percent', value: l.discountPercent.trim() }
          : null,
        taxCodeId: l.taxCodeId || null,
      })),
    };
    if (kind === 'invoice') body.dueDate = dueDate || null;
    if (kind === 'credit_note') body.invoiceId = invoiceId || null;
    onSave(body);
  };

  if (settings.isPending || customers.isPending) return <Spinner label={t('common.loading')} />;
  const activeCodes = (taxCodes.data ?? []).filter((c) => c.status === 'ACTIVE');

  return (
    <form className="form" onSubmit={submit}>
      <ErrorAlert error={error} />
      <Card title={t('sales.editor.details')}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="doc-customer">{t('sales.field.customer')}</label>
            <select
              id="doc-customer"
              value={customerId}
              required
              aria-invalid={issue('customerId') ? true : undefined}
              onChange={(e) => {
                setCustomerId(e.target.value);
                setInvoiceId('');
              }}
            >
              <option value="">{t('common.choose')}</option>
              {customers.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
            {issue('customerId') ? (
              <small className="field__error">{issue('customerId')}</small>
            ) : null}
          </div>
          <TextField
            label={kind === 'invoice' ? t('sales.field.invoiceDate') : t('sales.field.creditDate')}
            type="date"
            value={date}
            required
            error={issue(kind === 'invoice' ? 'invoiceDate' : 'creditDate')}
            onChange={(e) => setDate(e.target.value)}
          />
          {kind === 'invoice' ? (
            <TextField
              label={t('sales.field.dueDate')}
              type="date"
              value={dueDate}
              hint={t('sales.editor.dueDateHint')}
              error={issue('dueDate')}
              onChange={(e) => setDueDate(e.target.value)}
            />
          ) : (
            <div className="field">
              <label htmlFor="doc-invoice">{t('sales.field.creditedInvoice')}</label>
              <select
                id="doc-invoice"
                value={invoiceId}
                onChange={(e) => setInvoiceId(e.target.value)}
              >
                <option value="">{t('sales.editor.standaloneCredit')}</option>
                {invoiceOptions.data?.items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.number} · {i.total} {i.currencyCode}
                  </option>
                ))}
              </select>
              {issue('invoiceId') ? (
                <small className="field__error">{issue('invoiceId')}</small>
              ) : null}
            </div>
          )}
          <div className="field">
            <label htmlFor="doc-currency">{t('sales.field.currency')}</label>
            <select
              id="doc-currency"
              value={currencyCode}
              onChange={(e) => setCurrencyCode(e.target.value)}
            >
              <option value="">
                {t('sales.editor.customerCurrency', { currency: customer?.currencyCode ?? '—' })}
              </option>
              {COMMON_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="doc-treatment">{t('sales.field.taxTreatment')}</label>
            <select
              id="doc-treatment"
              value={taxTreatment}
              onChange={(e) => setTaxTreatment(e.target.value as TaxTreatment | '')}
            >
              <option value="">
                {t('sales.editor.defaultTreatment', {
                  treatment: t(
                    `sales.treatment.${settings.data?.defaultTaxTreatment ?? 'exclusive'}`,
                  ),
                })}
              </option>
              <option value="exclusive">{t('sales.treatment.exclusive')}</option>
              <option value="inclusive">{t('sales.treatment.inclusive')}</option>
              <option value="no_tax">{t('sales.treatment.no_tax')}</option>
            </select>
          </div>
          <TextField
            label={t('sales.field.reference')}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      </Card>

      <Card title={t('sales.editor.lines')}>
        <table className="table table--lines">
          <thead>
            <tr>
              <th>{t('sales.field.item')}</th>
              <th>{t('sales.field.description')}</th>
              <th className="num">{t('sales.field.quantity')}</th>
              <th className="num">{t('sales.field.unitPrice')}</th>
              <th className="num">{t('sales.field.discountPercent')}</th>
              <th>{t('sales.field.taxCode')}</th>
              <th>
                <span className="sr-only">{t('common.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.key}>
                <td>
                  <select
                    aria-label={t('sales.editor.lineItem', { n: index + 1 })}
                    value={line.itemId}
                    onChange={(e) => pickItem(line.key, e.target.value)}
                  >
                    <option value="">{t('sales.editor.noItem')}</option>
                    {items.data?.items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.sku ? `${i.sku} · ${i.name}` : i.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={t('sales.editor.lineDescription', { n: index + 1 })}
                    value={line.description}
                    aria-invalid={issue(`lines.${index}.description`) ? true : undefined}
                    onChange={(e) => update(line.key, { description: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="num"
                    inputMode="decimal"
                    aria-label={t('sales.editor.lineQuantity', { n: index + 1 })}
                    value={line.quantity}
                    onChange={(e) => update(line.key, { quantity: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="num"
                    inputMode="decimal"
                    aria-label={t('sales.editor.linePrice', { n: index + 1 })}
                    value={line.unitPrice}
                    aria-invalid={issue(`lines.${index}.unitPrice`) ? true : undefined}
                    onChange={(e) => update(line.key, { unitPrice: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="num"
                    inputMode="decimal"
                    aria-label={t('sales.editor.lineDiscount', { n: index + 1 })}
                    value={line.discountPercent}
                    onChange={(e) => update(line.key, { discountPercent: e.target.value })}
                  />
                </td>
                <td>
                  <select
                    aria-label={t('sales.editor.lineTax', { n: index + 1 })}
                    value={line.taxCodeId}
                    onChange={(e) => update(line.key, { taxCodeId: e.target.value })}
                  >
                    <option value="">{t('sales.editor.noTax')}</option>
                    {activeCodes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={lines.length === 1}
                    onClick={() => setLines((all) => all.filter((l) => l.key !== line.key))}
                  >
                    {t('common.remove')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {error instanceof ApiError
          ? error.issues
              .filter((i) => i.path.startsWith('lines'))
              .map((i) => (
                <p key={`${i.path}-${i.message}`} className="field__error">
                  {t('sales.editor.lineIssue', {
                    path: i.path.replace(/^lines\.(\d+)/, (_m, n: string) => String(Number(n) + 1)),
                    message: i.message,
                  })}
                </p>
              ))
          : null}
        <p className="actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setLines((all) => [...all, emptyLine()])}
          >
            {t('sales.editor.addLine')}
          </Button>
        </p>
      </Card>

      <Card title={t('sales.editor.discountAndNotes')}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="doc-discount-type">{t('sales.field.documentDiscount')}</label>
            <select
              id="doc-discount-type"
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value as DiscountType | '')}
            >
              <option value="">{t('sales.editor.noDiscount')}</option>
              <option value="percent">{t('sales.discount.percent')}</option>
              <option value="amount">{t('sales.discount.amount')}</option>
            </select>
          </div>
          {discountType ? (
            <TextField
              label={t('sales.field.discountValue')}
              inputMode="decimal"
              value={discountValue}
              error={issue('discount')}
              onChange={(e) => setDiscountValue(e.target.value)}
            />
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="doc-memo">{t('sales.field.memo')}</label>
          <textarea id="doc-memo" rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
        <p className="muted">{t('sales.editor.totalsNote')}</p>
      </Card>
      <p className="actions">
        <Button type="submit" busy={saving}>
          {t('sales.editor.saveDraft')}
        </Button>
      </p>
    </form>
  );
}
