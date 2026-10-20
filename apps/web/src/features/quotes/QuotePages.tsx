import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useCustomerOptions, useItemOptions, SalesNav } from '../sales/shared';
import { useT } from '../../i18n/i18n';

/**
 * Sales quotes and recurring invoice schedules (FP-28). Neither posts to the ledger: a quote
 * converts into, and a schedule generates, DRAFT invoices. The server enforces every rule.
 */

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface Line {
  itemId: string;
  description: string;
  quantity: string;
  unitPrice: string;
}
const blankLine = (): Line => ({ itemId: '', description: '', quantity: '1', unitPrice: '' });

function LinesEditor({ lines, onChange }: { lines: Line[]; onChange: (lines: Line[]) => void }) {
  const t = useT();
  const items = useItemOptions();
  const set = (i: number, patch: Partial<Line>) =>
    onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <fieldset>
      <legend>{t('quotes.quotePages.lines')}</legend>
      {lines.map((l, i) => (
        <div key={i} className="filters">
          <div className="field">
            <label htmlFor={`line-item-${i}`}>{t('quotes.quotePages.item')}</label>
            <select
              id={`line-item-${i}`}
              value={l.itemId}
              onChange={(e) => {
                const item = items.data?.items.find((x) => x.id === e.target.value);
                set(i, {
                  itemId: e.target.value,
                  ...(item && !l.unitPrice && item.unitPrice ? { unitPrice: item.unitPrice } : {}),
                });
              }}
            >
              <option value="">{t('quotes.quotePages.noItem')}</option>
              {(items.data?.items ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('quotes.quotePages.description')}
            value={l.description}
            onChange={(e) => set(i, { description: e.target.value })}
          />
          <TextField
            label={t('quotes.quotePages.quantity')}
            value={l.quantity}
            inputMode="decimal"
            onChange={(e) => set(i, { quantity: e.target.value })}
          />
          <TextField
            label={t('quotes.quotePages.unitPrice')}
            value={l.unitPrice}
            inputMode="decimal"
            onChange={(e) => set(i, { unitPrice: e.target.value })}
          />
          {lines.length > 1 ? (
            <Button variant="ghost" onClick={() => onChange(lines.filter((_, j) => j !== i))}>
              {t('common.remove')}
            </Button>
          ) : null}
        </div>
      ))}
      <Button variant="secondary" onClick={() => onChange([...lines, blankLine()])}>
        {t('quotes.quotePages.addLine')}
      </Button>
    </fieldset>
  );
}

const apiLines = (lines: Line[]) =>
  lines.map((l) => ({
    ...(l.itemId ? { itemId: l.itemId } : {}),
    ...(l.description.trim() ? { description: l.description.trim() } : {}),
    quantity: l.quantity.trim(),
    unitPrice: l.unitPrice.trim() || '0',
  }));

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

interface Quote {
  id: string;
  number: string;
  customerId: string;
  quoteDate: string;
  validUntil: string;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CONVERTED';
  reference: string | null;
  memo: string;
  netTotal: string;
  declineReason: string | null;
  invoiceId: string | null;
  version: number;
  lines: {
    lineNo: number;
    description: string;
    quantity: string;
    unitPrice: string;
    netAmount: string;
  }[];
}

export function QuotesPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canCreate = usePermission(Permission.QuotesCreate);
  const customers = useCustomerOptions();
  const list = useQuery({
    queryKey: ['quotes', org],
    queryFn: () => api.get<Quote[]>('/sales/quotes'),
  });
  const [form, setForm] = useState({
    customerId: '',
    quoteDate: today(),
    validUntil: addDays(today(), 30),
    reference: '',
    memo: '',
  });
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const create = useApiMutation(() =>
    api.post<Quote>(
      '/sales/quotes',
      {
        customerId: form.customerId,
        quoteDate: form.quoteDate,
        validUntil: form.validUntil,
        reference: form.reference.trim() || null,
        memo: form.memo.trim(),
        lines: apiLines(lines),
      },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const nameOf = (id: string) =>
    customers.data?.items.find((c) => c.id === id)?.displayName ?? id.slice(0, 8);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: (quote) => {
        void queryClient.invalidateQueries({ queryKey: ['quotes', org] });
        void navigate(`/sales/quotes/${quote.id}`);
      },
    });
  };
  return (
    <>
      <SalesNav />
      <PageHeader
        title={t('quotes.quotePages.quotes')}
        description={t('quotes.quotePages.offersToCustomersAQuote')}
      />
      <Card title={t('quotes.quotePages.quotes')}>
        {list.isPending ? <Spinner /> : null}
        <ErrorAlert error={list.error} />
        {list.data ? (
          list.data.length === 0 ? (
            <p className="muted">{t('quotes.quotePages.noQuotesYet')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('quotes.quotePages.number')}</th>
                  <th>{t('quotes.quotePages.customer')}</th>
                  <th>{t('quotes.quotePages.date')}</th>
                  <th>{t('quotes.quotePages.validUntil')}</th>
                  <th className="num">{t('quotes.quotePages.netTotal')}</th>
                  <th>{t('quotes.quotePages.status')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((q) => (
                  <tr key={q.id}>
                    <td>
                      <Link to={`/sales/quotes/${q.id}`}>{q.number}</Link>
                    </td>
                    <td>{nameOf(q.customerId)}</td>
                    <td>{q.quoteDate}</td>
                    <td>{q.validUntil}</td>
                    <td className="num">{formatAmount(q.netTotal, 'MVR')}</td>
                    <td>{q.status.toLowerCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </Card>
      {canCreate ? (
        <Card title={t('quotes.quotePages.newQuote')}>
          <form className="form" onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="quote-customer">{t('quotes.quotePages.customer')}</label>
              <select
                id="quote-customer"
                value={form.customerId}
                onChange={(e) => setForm({ ...form, customerId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {(customers.data?.items ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label={t('quotes.quotePages.quoteDate')}
              type="date"
              value={form.quoteDate}
              onChange={(e) => setForm({ ...form, quoteDate: e.target.value })}
            />
            <TextField
              label={t('quotes.quotePages.validUntil')}
              type="date"
              value={form.validUntil}
              onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
            />
            <TextField
              label={t('quotes.quotePages.reference')}
              value={form.reference}
              onChange={(e) => setForm({ ...form, reference: e.target.value })}
            />
            <TextField
              label={t('quotes.quotePages.notes')}
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
            />
            <LinesEditor lines={lines} onChange={setLines} />
            <ErrorAlert error={create.error} />
            <Button type="submit" busy={create.isPending} disabled={!form.customerId}>
              {t('quotes.quotePages.createQuote')}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}

export function QuoteDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canCreate = usePermission(Permission.QuotesCreate);
  const canConvert = usePermission(Permission.QuotesConvert);
  const quote = useQuery({
    queryKey: ['quote', org, id],
    queryFn: () => api.get<Quote>(`/sales/quotes/${id}`),
  });
  const act = useApiMutation((input: { action: string; body?: object }) =>
    api.post<unknown>(`/sales/quotes/${id}/${input.action}`, {
      version: quote.data?.version,
      ...input.body,
    }),
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['quote', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['quotes', org] });
  };
  const q = quote.data;
  const money = (v: string) => formatAmount(v, 'MVR');
  return (
    <>
      <SalesNav />
      <PageHeader
        title={
          q ? t('quotes.quotePages.quote', { number: q.number }) : t('quotes.quotePages.quote2')
        }
        description={
          q
            ? t('quotes.quotePages.validUntil2', {
                value: q.status.toLowerCase(),
                validUntil: q.validUntil,
              })
            : undefined
        }
      />
      {quote.isPending ? <Spinner /> : null}
      <ErrorAlert error={quote.error} />
      {q ? (
        <>
          <Card title={t('quotes.quotePages.lines')}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('quotes.quotePages.description')}</th>
                  <th className="num">{t('quotes.quotePages.quantity')}</th>
                  <th className="num">{t('quotes.quotePages.unitPrice')}</th>
                  <th className="num">{t('quotes.quotePages.net')}</th>
                </tr>
              </thead>
              <tbody>
                {q.lines.map((l) => (
                  <tr key={l.lineNo}>
                    <td>{l.description}</td>
                    <td className="num">{l.quantity}</td>
                    <td className="num">{money(l.unitPrice)}</td>
                    <td className="num">{money(l.netAmount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>{t('quotes.quotePages.netTotalTaxIsAdded')}</th>
                  <th className="num">{money(q.netTotal)}</th>
                </tr>
              </tfoot>
            </table>
            {q.declineReason ? (
              <Alert>{t('quotes.quotePages.declined', { declineReason: q.declineReason })}</Alert>
            ) : null}
            {q.invoiceId ? (
              <p>
                <Link to={`/sales/invoices/${q.invoiceId}`}>
                  {t('quotes.quotePages.invoiceCreatedFromThisQuote')}
                </Link>
              </p>
            ) : null}
            <div className="filters">
              {q.status === 'DRAFT' && canCreate ? (
                <Button onClick={() => act.mutate({ action: 'send' }, { onSuccess: refresh })}>
                  {t('quotes.quotePages.markAsSent')}
                </Button>
              ) : null}
              {q.status === 'SENT' && canCreate ? (
                <>
                  <Button onClick={() => act.mutate({ action: 'accept' }, { onSuccess: refresh })}>
                    {t('quotes.quotePages.customerAccepted')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const reason = window.prompt(t('quotes.quotePages.whyWasTheQuoteDeclined'));
                      if (reason?.trim()) {
                        act.mutate(
                          { action: 'decline', body: { reason: reason.trim() } },
                          { onSuccess: refresh },
                        );
                      }
                    }}
                  >
                    {t('quotes.quotePages.customerDeclined')}
                  </Button>
                </>
              ) : null}
              {q.status === 'ACCEPTED' && canConvert ? (
                <Button
                  onClick={() =>
                    act.mutate(
                      { action: 'convert' },
                      {
                        onSuccess: (result) => {
                          refresh();
                          const invoiceId = (result as { invoiceId?: string }).invoiceId;
                          if (invoiceId) void navigate(`/sales/invoices/${invoiceId}`);
                        },
                      },
                    )
                  }
                >
                  {t('quotes.quotePages.createDraftInvoice')}
                </Button>
              ) : null}
            </div>
            <ErrorAlert error={act.error} />
          </Card>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Recurring invoices
// ---------------------------------------------------------------------------

interface Schedule {
  id: string;
  name: string;
  customerId: string;
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  startDate: string;
  nextRunDate: string;
  endDate: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'ENDED';
  runCount: number;
  lastError: string | null;
  version: number;
}

export function RecurringInvoicesPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.RecurringInvoicesManage);
  const customers = useCustomerOptions();
  const list = useQuery({
    queryKey: ['recurring-invoices', org],
    queryFn: () => api.get<Schedule[]>('/sales/recurring-invoices'),
  });
  const [form, setForm] = useState({
    name: '',
    customerId: '',
    frequency: 'monthly',
    startDate: today(),
    endDate: '',
  });
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [notice, setNotice] = useState<string | null>(null);
  const create = useApiMutation(() =>
    api.post('/sales/recurring-invoices', {
      name: form.name.trim(),
      customerId: form.customerId,
      frequency: form.frequency,
      startDate: form.startDate,
      endDate: form.endDate || null,
      lines: apiLines(lines),
    }),
  );
  const act = useApiMutation((input: { schedule: Schedule; action: string }) =>
    api.post<{ invoiceId?: string }>(
      `/sales/recurring-invoices/${input.schedule.id}/${input.action}`,
      {
        version: input.schedule.version,
      },
    ),
  );
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['recurring-invoices', org] });
  const nameOf = (id: string) =>
    customers.data?.items.find((c) => c.id === id)?.displayName ?? id.slice(0, 8);
  return (
    <>
      <SalesNav />
      <PageHeader
        title={t('quotes.quotePages.recurringInvoices')}
        description={t('quotes.quotePages.schedulesThatCreateDraftInvoices')}
      />
      {notice ? <Alert>{notice}</Alert> : null}
      <Card title={t('quotes.quotePages.schedules')}>
        {list.isPending ? <Spinner /> : null}
        <ErrorAlert error={list.error} />
        {list.data ? (
          list.data.length === 0 ? (
            <p className="muted">{t('quotes.quotePages.noSchedulesYet')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('quotes.quotePages.name')}</th>
                  <th>{t('quotes.quotePages.customer')}</th>
                  <th>{t('quotes.quotePages.every')}</th>
                  <th>{t('quotes.quotePages.nextDraft')}</th>
                  <th className="num">{t('quotes.quotePages.created')}</th>
                  <th>{t('quotes.quotePages.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.name}
                      {s.lastError ? <small className="muted"> — {s.lastError}</small> : null}
                    </td>
                    <td>{nameOf(s.customerId)}</td>
                    <td>{s.frequency}</td>
                    <td>{s.status === 'ENDED' ? '—' : s.nextRunDate}</td>
                    <td className="num">{s.runCount}</td>
                    <td>{s.status.toLowerCase()}</td>
                    <td>
                      {canManage && s.status !== 'ENDED' ? (
                        <>
                          {s.status === 'ACTIVE' ? (
                            <Button
                              variant="ghost"
                              onClick={() =>
                                act.mutate({ schedule: s, action: 'pause' }, { onSuccess: refresh })
                              }
                            >
                              {t('quotes.quotePages.pause')}
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              onClick={() =>
                                act.mutate(
                                  { schedule: s, action: 'resume' },
                                  { onSuccess: refresh },
                                )
                              }
                            >
                              {t('quotes.quotePages.resume')}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            onClick={() =>
                              act.mutate(
                                { schedule: s, action: 'run-now' },
                                {
                                  onSuccess: () => {
                                    setNotice(
                                      t('quotes.quotePages.recurringRunNotice', { name: s.name }),
                                    );
                                    refresh();
                                  },
                                },
                              )
                            }
                          >
                            {t('quotes.quotePages.createNextDraftNow')}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              act.mutate({ schedule: s, action: 'end' }, { onSuccess: refresh })
                            }
                          >
                            {t('quotes.quotePages.end')}
                          </Button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
        <ErrorAlert error={act.error} />
      </Card>
      {canManage ? (
        <Card title={t('quotes.quotePages.newSchedule')}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined, {
                onSuccess: () => {
                  setForm({ ...form, name: '' });
                  setLines([blankLine()]);
                  refresh();
                },
              });
            }}
            noValidate
          >
            <TextField
              label={t('quotes.quotePages.name')}
              value={form.name}
              required
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <div className="field">
              <label htmlFor="rec-customer">{t('quotes.quotePages.customer')}</label>
              <select
                id="rec-customer"
                value={form.customerId}
                onChange={(e) => setForm({ ...form, customerId: e.target.value })}
              >
                <option value="">{t('common.choose')}</option>
                {(customers.data?.items ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="rec-frequency">{t('quotes.quotePages.repeats')}</label>
              <select
                id="rec-frequency"
                value={form.frequency}
                onChange={(e) => setForm({ ...form, frequency: e.target.value })}
              >
                <option value="weekly">{t('quotes.quotePages.weekly')}</option>
                <option value="monthly">{t('quotes.quotePages.monthly')}</option>
                <option value="quarterly">{t('quotes.quotePages.quarterly')}</option>
                <option value="yearly">{t('quotes.quotePages.yearly')}</option>
              </select>
            </div>
            <TextField
              label={t('quotes.quotePages.firstInvoiceDate')}
              type="date"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
            <TextField
              label={t('quotes.quotePages.lastInvoiceDateOptional')}
              type="date"
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            />
            <LinesEditor lines={lines} onChange={setLines} />
            <ErrorAlert error={create.error} />
            <Button
              type="submit"
              busy={create.isPending}
              disabled={!form.name.trim() || !form.customerId}
            >
              {t('quotes.quotePages.createSchedule')}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}
