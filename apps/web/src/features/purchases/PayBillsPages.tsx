import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Decimal } from 'decimal.js';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useT } from '../../i18n/i18n';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { COMMON_CURRENCIES, formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts, useAccountingSetup } from '../accounting/shared';
import { StatusBadge, useOrgKey } from '../sales/shared';
import type { Page } from '../sales/types';
import { PurchasesNav } from './PurchasesSection';
import type { PayableBill, PaymentBatchDetail, PaymentBatchSummary, VendorSummary } from './types';

/**
 * Batch "Pay bills" (Phase 4B-4; ADR 0004 P4-32, P4-50): choose open bills across vendors, review
 * one payment per vendor and currency, and record them all at once (all or nothing). Amounts are
 * inputs only; every rate, base and realized FX comes from the server. Approval stays per payment:
 * a batch with any payment that needs approval is refused as a whole.
 */

/** P4-26: bank, cash and credit-card accounts for payments (the server checks currencies too). */
const PAYMENT_SUBTYPES = ['BANK', 'CASH', 'CREDIT_CARD'];

interface Selected {
  bill: PayableBill;
  amount: string;
}

const sum = (values: readonly string[]) =>
  values.reduce((s, v) => {
    try {
      return v.trim() ? s.plus(new Decimal(v)) : s;
    } catch {
      return s;
    }
  }, new Decimal(0));

export function PayBillsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canAccounts);
  const setup = useAccountingSetup();
  const baseCurrency = setup.data?.settings?.baseCurrency ?? null;
  const vendors = useQuery({
    queryKey: ['vendor-options', org],
    queryFn: () => api.get<Page<VendorSummary>>('/vendors?limit=200&status=active'),
  });
  const [filters, setFilters] = useState({ vendorId: '', currencyCode: '', dueBefore: '' });
  const bills = useQuery({
    queryKey: ['payable-bills', org, filters],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '500' });
      if (filters.vendorId) params.set('vendorId', filters.vendorId);
      if (filters.currencyCode) params.set('currencyCode', filters.currencyCode);
      if (filters.dueBefore) params.set('dueBefore', filters.dueBefore);
      return api.get<PayableBill[]>(`/purchases/pay-bills/open-bills?${params.toString()}`);
    },
  });
  const [selected, setSelected] = useState<Record<string, Selected>>({});
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [accountByCurrency, setAccountByCurrency] = useState<Record<string, string>>({});
  const [rateByCurrency, setRateByCurrency] = useState<
    Record<string, { rate: string; reason: string }>
  >({});
  const [reference, setReference] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const record = useApiMutation((body: Record<string, unknown>) =>
    api.post<PaymentBatchDetail>('/purchases/payment-batches', body, { idempotencyKey }),
  );

  const chosen = Object.values(selected);
  const currencies = [...new Set(chosen.map((s) => s.bill.currencyCode))].sort();
  // One payment per vendor and currency (P4-32).
  const groups = [
    ...chosen
      .reduce((map, s) => {
        const key = `${s.bill.vendorId}|${s.bill.currencyCode}`;
        const group = map.get(key) ?? {
          key,
          vendorName: s.bill.vendorName ?? s.bill.vendorId,
          currencyCode: s.bill.currencyCode,
          amounts: [] as string[],
        };
        group.amounts.push(s.amount);
        return map.set(key, group);
      }, new Map<string, { key: string; vendorName: string; currencyCode: string; amounts: string[] }>())
      .values(),
  ];
  const toggle = (bill: PayableBill) =>
    setSelected((all) => {
      const next = { ...all };
      if (next[bill.id]) delete next[bill.id];
      else next[bill.id] = { bill, amount: bill.amountDue };
      return next;
    });
  const accountsFor = (currency: string) =>
    (accounts.data ?? []).filter(
      (a) =>
        a.status === 'ACTIVE' &&
        a.isLeaf &&
        !a.isControlAccount &&
        a.subtype !== null &&
        PAYMENT_SUBTYPES.includes(a.subtype) &&
        (a.currencyCode === currency || a.currencyCode === baseCurrency),
    );
  const billNumber = (path: string) => {
    const match = /^bills\.(\d+)/.exec(path);
    return match ? chosen[Number(match[1])]?.bill.number : undefined;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    record.mutate(
      {
        paymentDate,
        accounts: currencies
          .filter((c) => accountByCurrency[c])
          .map((c) => ({ currencyCode: c, paymentAccountId: accountByCurrency[c] })),
        rateOverrides: currencies
          .filter((c) => c !== baseCurrency && rateByCurrency[c]?.rate.trim())
          .map((c) => ({
            currencyCode: c,
            rate: rateByCurrency[c]!.rate.trim(),
            reason: rateByCurrency[c]!.reason.trim(),
          })),
        reference: reference.trim() || null,
        bills: chosen.map((s) => ({ billId: s.bill.id, amount: s.amount.trim() })),
      },
      {
        onSuccess: () => {
          setSelected({});
          setIdempotencyKey(crypto.randomUUID());
          void queryClient.invalidateQueries({ queryKey: ['payable-bills', org] });
          void queryClient.invalidateQueries({ queryKey: ['vendor-payments', org] });
          void queryClient.invalidateQueries({ queryKey: ['payment-batches', org] });
        },
      },
    );
  };

  const problems = record.error instanceof ApiError ? record.error.issues : [];
  return (
    <>
      <PageHeader
        title={t('purchases.payBills.title')}
        description={t('purchases.payBills.description')}
      />
      <PurchasesNav />
      <p className="actions">
        <Link to="/purchases/payment-batches">{t('purchases.payBills.history')}</Link>
      </p>
      {record.isSuccess ? (
        <Alert tone="success">
          {t('purchases.payBills.recorded', { count: String(record.data.payments.length) })}{' '}
          {record.data.payments.map((p) => (
            <span key={p.id}>
              <Link to={`/purchases/payments/${p.id}`}>{p.number}</Link>{' '}
            </span>
          ))}
          <Link to={`/purchases/payment-batches/${record.data.id}`}>
            {t('purchases.payBills.viewBatch')}
          </Link>
        </Alert>
      ) : null}
      <Card title={t('purchases.payBills.openBills')}>
        <div className="form form--inline">
          <div className="field">
            <label htmlFor="pay-vendor">{t('purchases.bills.vendor')}</label>
            <select
              id="pay-vendor"
              value={filters.vendorId}
              onChange={(e) => setFilters({ ...filters, vendorId: e.target.value })}
            >
              <option value="">{t('common.all')}</option>
              {(vendors.data?.items ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pay-currency">{t('purchases.field.currency')}</label>
            <select
              id="pay-currency"
              value={filters.currencyCode}
              onChange={(e) => setFilters({ ...filters, currencyCode: e.target.value })}
            >
              <option value="">{t('common.all')}</option>
              {COMMON_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('purchases.payBills.dueBefore')}
            type="date"
            value={filters.dueBefore}
            onChange={(e) => setFilters({ ...filters, dueBefore: e.target.value })}
          />
        </div>
        {bills.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : bills.isError ? (
          <ErrorAlert error={bills.error} />
        ) : bills.data.length === 0 ? (
          <p className="muted">{t('purchases.payBills.none')}</p>
        ) : (
          <table className="table table--editor">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">{t('purchases.payBills.select')}</span>
                </th>
                <th>{t('purchases.bills.number')}</th>
                <th>{t('purchases.bills.vendor')}</th>
                <th>{t('purchases.payBills.dueDate')}</th>
                <th className="num">{t('purchases.payments.due')}</th>
                <th className="num">{t('purchases.payments.pay')}</th>
              </tr>
            </thead>
            <tbody>
              {bills.data.map((b) => (
                <tr key={b.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t('purchases.payBills.selectBill', { number: b.number })}
                      checked={Boolean(selected[b.id])}
                      onChange={() => toggle(b)}
                    />
                  </td>
                  <td>
                    <Link to={`/purchases/bills/${b.id}`}>{b.number}</Link>
                  </td>
                  <td>{b.vendorName}</td>
                  <td>{b.dueDate}</td>
                  <td className="num">
                    {formatAmount(b.amountDue, b.currencyCode)} {b.currencyCode}
                  </td>
                  <td className="num">
                    {selected[b.id] ? (
                      <input
                        aria-label={t('purchases.payments.payBill', { number: b.number })}
                        inputMode="decimal"
                        value={selected[b.id]!.amount}
                        onChange={(e) =>
                          setSelected((all) => ({
                            ...all,
                            [b.id]: { bill: b, amount: e.target.value },
                          }))
                        }
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {chosen.length ? (
        <form className="form" onSubmit={submit}>
          <Card title={t('purchases.payBills.review')}>
            <ErrorAlert error={record.error} />
            {problems.length ? (
              <ul className="issues">
                {problems.map((p) => (
                  <li key={`${p.path}-${p.message}`}>
                    {billNumber(p.path) ? `${billNumber(p.path)}: ` : ''}
                    {p.message}
                  </li>
                ))}
              </ul>
            ) : null}
            <TextField
              label={t('purchases.payments.date')}
              type="date"
              value={paymentDate}
              required
              onChange={(e) => setPaymentDate(e.target.value)}
            />
            {currencies.map((c) => (
              <div className="form-grid" key={c}>
                <div className="field">
                  <label htmlFor={`pay-account-${c}`}>
                    {t('purchases.payBills.accountFor', { currency: c })}
                  </label>
                  <select
                    id={`pay-account-${c}`}
                    value={accountByCurrency[c] ?? ''}
                    onChange={(e) =>
                      setAccountByCurrency({ ...accountByCurrency, [c]: e.target.value })
                    }
                  >
                    <option value="">{t('purchases.payments.accountDefault')}</option>
                    {accountsFor(c).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name} ({a.currencyCode})
                      </option>
                    ))}
                  </select>
                </div>
                {baseCurrency && c !== baseCurrency ? (
                  <>
                    <TextField
                      label={t('purchases.payBills.rateFor', { currency: c })}
                      inputMode="decimal"
                      hint={t('purchases.bills.rateHint')}
                      value={rateByCurrency[c]?.rate ?? ''}
                      onChange={(e) =>
                        setRateByCurrency({
                          ...rateByCurrency,
                          [c]: { rate: e.target.value, reason: rateByCurrency[c]?.reason ?? '' },
                        })
                      }
                    />
                    <TextField
                      label={t('purchases.payBills.reasonFor', { currency: c })}
                      value={rateByCurrency[c]?.reason ?? ''}
                      onChange={(e) =>
                        setRateByCurrency({
                          ...rateByCurrency,
                          [c]: { rate: rateByCurrency[c]?.rate ?? '', reason: e.target.value },
                        })
                      }
                    />
                  </>
                ) : null}
              </div>
            ))}
            <TextField
              label={t('purchases.payments.reference')}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
            <table className="table">
              <caption>
                {t('purchases.payBills.paymentsCaption', { count: String(groups.length) })}
              </caption>
              <thead>
                <tr>
                  <th>{t('purchases.bills.vendor')}</th>
                  <th>{t('purchases.field.currency')}</th>
                  <th className="num">{t('purchases.payBills.bills')}</th>
                  <th className="num">{t('purchases.payments.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key}>
                    <td>{g.vendorName}</td>
                    <td>{g.currencyCode}</td>
                    <td className="num">{g.amounts.length}</td>
                    <td className="num">
                      {formatAmount(sum(g.amounts).toFixed(), g.currencyCode)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {currencies.map((c) => (
              <p key={c} className="muted">
                {t('purchases.payBills.totalFor', {
                  currency: c,
                  amount: formatAmount(
                    sum(
                      chosen.filter((s) => s.bill.currencyCode === c).map((s) => s.amount),
                    ).toFixed(),
                    c,
                  ),
                })}
              </p>
            ))}
            <p className="actions">
              <Button type="submit" busy={record.isPending}>
                {t('purchases.payBills.record', { count: String(groups.length) })}
              </Button>
            </p>
          </Card>
        </form>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Batch history and detail
// ---------------------------------------------------------------------------

export function PaymentBatchesPage() {
  const t = useT();
  const org = useOrgKey();
  const list = useQuery({
    queryKey: ['payment-batches', org],
    queryFn: () => api.get<Page<PaymentBatchSummary>>('/purchases/payment-batches?limit=100'),
  });
  return (
    <>
      <PageHeader title={t('purchases.payBills.historyTitle')} />
      <PurchasesNav />
      <Card>
        {list.isPending ? (
          <Spinner label={t('common.loading')} />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">{t('purchases.payBills.noBatches')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('purchases.payments.date')}</th>
                <th className="num">{t('purchases.payBills.payments')}</th>
                <th className="num">{t('purchases.payBills.bills')}</th>
                <th>{t('purchases.payBills.totals')}</th>
                <th>{t('purchases.payments.reference')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link to={`/purchases/payment-batches/${b.id}`}>{b.paymentDate}</Link>
                  </td>
                  <td className="num">{b.paymentCount}</td>
                  <td className="num">{b.billCount}</td>
                  <td>
                    {b.totals
                      .map((x) => `${formatAmount(x.amount, x.currencyCode)} ${x.currencyCode}`)
                      .join(' · ')}
                  </td>
                  <td>{b.reference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

export function PaymentBatchDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const canJournals = usePermission(Permission.JournalsView);
  const batch = useQuery({
    queryKey: ['payment-batch', org, id],
    queryFn: () => api.get<PaymentBatchDetail>(`/purchases/payment-batches/${id}`),
  });
  if (batch.isPending) return <Spinner label={t('common.loading')} />;
  if (batch.isError) return <ErrorAlert error={batch.error} />;
  const b = batch.data;
  return (
    <>
      <PageHeader title={t('purchases.payBills.batchTitle', { date: b.paymentDate })} />
      <PurchasesNav />
      <Card title={t('purchases.bills.summary')}>
        <dl className="facts">
          <dt>{t('purchases.payments.date')}</dt>
          <dd>{b.paymentDate}</dd>
          <dt>{t('purchases.payBills.payments')}</dt>
          <dd>{b.paymentCount}</dd>
          <dt>{t('purchases.payBills.bills')}</dt>
          <dd>{b.billCount}</dd>
          <dt>{t('purchases.payBills.totals')}</dt>
          <dd>
            {b.totals
              .map((x) => `${formatAmount(x.amount, x.currencyCode)} ${x.currencyCode}`)
              .join(' · ')}
          </dd>
          {b.reference ? (
            <>
              <dt>{t('purchases.payments.reference')}</dt>
              <dd>{b.reference}</dd>
            </>
          ) : null}
        </dl>
      </Card>
      <Card title={t('purchases.payBills.payments')}>
        <table className="table">
          <thead>
            <tr>
              <th>{t('purchases.bills.number')}</th>
              <th>{t('purchases.bills.vendor')}</th>
              <th className="num">{t('purchases.payments.amount')}</th>
              <th>{t('purchases.field.status')}</th>
              {canJournals ? (
                <th>
                  <span className="sr-only">{t('purchases.payments.journal')}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {b.payments.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/purchases/payments/${p.id}`}>{p.number}</Link>
                </td>
                <td>{p.vendorName}</td>
                <td className="num">
                  {formatAmount(p.amount, p.currencyCode)} {p.currencyCode}
                </td>
                <td>
                  {p.status === 'RECORDED' ? (
                    <span className="badge badge--posted">{t('purchases.status.recorded')}</span>
                  ) : (
                    <StatusBadge status={p.status} />
                  )}
                </td>
                {canJournals ? (
                  <td>
                    {p.journalId ? (
                      <Link to={`/accounting/journals/${p.journalId}`}>
                        {t('purchases.payments.journal')}
                      </Link>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
