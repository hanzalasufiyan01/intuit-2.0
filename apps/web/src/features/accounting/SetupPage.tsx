import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { COMMON_CURRENCIES } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { AccountingNav, useAccountingSetup, useOrgKey } from './shared';

function CurrencyInput({
  value,
  onChange,
  label,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  error?: string | undefined;
}) {
  return (
    <>
      <TextField
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        list="currency-options"
        maxLength={3}
        error={error}
        hint="3-letter ISO 4217 code"
      />
      <datalist id="currency-options">
        {COMMON_CURRENCIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </>
  );
}

function ExchangeRates({ baseCurrency }: { baseCurrency: string }) {
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const rates = useQuery({
    queryKey: ['accounting-rates', org],
    queryFn: () =>
      api.get<{ id: string; fromCurrency: string; rateDate: string; rate: string }[]>(
        '/accounting/exchange-rates',
      ),
  });
  const [form, setForm] = useState({ fromCurrency: 'USD', rateDate: '', rate: '' });
  const record = useApiMutation((input: typeof form) =>
    api.post('/accounting/exchange-rates', input),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    record.mutate(form, {
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['accounting-rates', org] }),
    });
  };
  return (
    <Card title={`Exchange rates (1 unit = x ${baseCurrency})`}>
      <form className="form form--inline" onSubmit={submit} noValidate>
        <CurrencyInput
          label="Currency"
          value={form.fromCurrency}
          onChange={(v) => setForm({ ...form, fromCurrency: v })}
          error={record.error?.fieldError('fromCurrency')}
        />
        <TextField
          label="Date"
          type="date"
          value={form.rateDate}
          onChange={(e) => setForm({ ...form, rateDate: e.target.value })}
          error={record.error?.fieldError('rateDate')}
        />
        <TextField
          label="Rate"
          inputMode="decimal"
          value={form.rate}
          onChange={(e) => setForm({ ...form, rate: e.target.value })}
          error={record.error?.fieldError('rate')}
        />
        <Button type="submit" busy={record.isPending}>
          Record rate
        </Button>
      </form>
      <ErrorAlert error={record.error?.issues.length ? null : record.error} />
      {rates.data?.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Currency</th>
              <th>Rate</th>
            </tr>
          </thead>
          <tbody>
            {rates.data.map((r) => (
              <tr key={r.id}>
                <td>{r.rateDate}</td>
                <td>{r.fromCurrency}</td>
                <td>{r.rate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No rates recorded.</p>
      )}
    </Card>
  );
}

export function SetupPage() {
  const setup = useAccountingSetup();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const [baseCurrency, setBaseCurrency] = useState('MVR');
  const [templateKey, setTemplateKey] = useState('maldives');
  const mutation = useApiMutation((input: { baseCurrency: string; templateKey: string }) =>
    sensitive(() => api.post('/accounting/setup', input)),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate(
      { baseCurrency, templateKey },
      { onSuccess: () => void queryClient.invalidateQueries() },
    );
  };

  return (
    <>
      <PageHeader title="Accounting setup" />
      <AccountingNav />
      {setup.isPending ? (
        <Spinner label="Loading setup" />
      ) : setup.isError ? (
        <ErrorAlert error={setup.error} />
      ) : setup.data.isSetUp ? (
        <>
          <Card title="Settings">
            <p>
              Base currency: <strong>{setup.data.settings?.baseCurrency}</strong>
              {setup.data.settings?.baseCurrencyLocked ? ' (fixed: journals have been posted)' : ''}
            </p>
            <p className="muted">
              Chart of accounts template: {setup.data.settings?.coaTemplateKey}
            </p>
          </Card>
          <Can permission={Permission.AccountingSetup}>
            <ExchangeRates baseCurrency={setup.data.settings?.baseCurrency ?? ''} />
          </Can>
        </>
      ) : (
        <Can
          permission={Permission.AccountingSetup}
          fallback={<Alert>Ask an administrator to set up accounting.</Alert>}
        >
          <Card title="Set up accounting">
            <form className="form" onSubmit={submit} noValidate>
              <CurrencyInput
                label="Base (functional) currency"
                value={baseCurrency}
                onChange={setBaseCurrency}
                error={mutation.error?.fieldError('baseCurrency')}
              />
              <fieldset className="field">
                <legend>Chart of accounts template</legend>
                {setup.data.templates.map((t) => (
                  <label key={t.key} className="radio">
                    <input
                      type="radio"
                      name="template"
                      value={t.key}
                      checked={templateKey === t.key}
                      onChange={() => setTemplateKey(t.key)}
                    />{' '}
                    {t.name}{' '}
                    <span className="muted">
                      — {t.description} ({t.accountCount} accounts)
                    </span>
                  </label>
                ))}
              </fieldset>
              <ErrorAlert error={mutation.error?.issues.length ? null : mutation.error} />
              <Button type="submit" busy={mutation.isPending}>
                Set up accounting
              </Button>
            </form>
          </Card>
        </Can>
      )}
    </>
  );
}
