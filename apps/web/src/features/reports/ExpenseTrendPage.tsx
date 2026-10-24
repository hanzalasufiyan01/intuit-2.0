import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useT } from '../../i18n/i18n';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { FilterBar } from '../../shared/ui/FilterBar';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { AccountingPage, useOrgKey } from '../accounting/shared';
import { ExportButton } from '../data-exchange/ExportButton';

interface ExpenseTrendReport {
  baseCurrency: string;
  months: { label: string; from: string; to: string }[];
  accounts: {
    accountId: string;
    code: string | null;
    name: string;
    section: string;
    amounts: string[];
    total: string;
  }[];
  totals: string[];
  total: string;
  note: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Expense trend (specification section 16; R-02): the expense accounts of the profit and loss,
 * month by month. Read-only; the server computes every figure from posted ledger activity.
 */
export function ExpenseTrendPage() {
  const t = useT();
  const org = useOrgKey();
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(today());
  const [applied, setApplied] = useState({ from, to });
  const query = useQuery({
    queryKey: ['report-expense-trend', org, applied],
    queryFn: () =>
      api.get<ExpenseTrendReport>(
        `/accounting/reports/expense-trend?from=${applied.from}&to=${applied.to}`,
      ),
  });
  const report = query.data;
  const money = (value: string) => formatAmount(value, report?.baseCurrency ?? 'MVR');
  return (
    <>
      <PageHeader title={t('trend.title')} description={t('trend.description')} />
      <AccountingPage>
        <Card>
          <FilterBar
            label={t('common.filters')}
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setApplied({ from, to });
            }}
          >
            <TextField
              label={t('trend.from')}
              type="date"
              value={from}
              required
              onChange={(event) => setFrom(event.target.value)}
            />
            <TextField
              label={t('trend.to')}
              type="date"
              value={to}
              required
              onChange={(event) => setTo(event.target.value)}
            />
            <Button type="submit">{t('trend.run')}</Button>
            <ExportButton domain="expense_trend" params={{ from: applied.from, to: applied.to }} />
          </FilterBar>
        </Card>
        {query.isPending ? <Spinner label={t('common.loading')} /> : null}
        <ErrorAlert error={query.error} />
        {report ? (
          <Card title={t('trend.cardTitle', { currency: report.baseCurrency })}>
            {report.accounts.length === 0 ? (
              <p className="muted">{t('trend.none')}</p>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('trend.account')}</th>
                      {report.months.map((m) => (
                        <th key={m.label} className="num">
                          {m.label}
                        </th>
                      ))}
                      <th className="num">{t('trend.total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.accounts.map((a) => (
                      <tr key={a.accountId}>
                        <td>{`${a.code ?? ''} ${a.name}`.trim()}</td>
                        {a.amounts.map((v, i) => (
                          <td key={report.months[i]?.label ?? i} className="num">
                            {money(v)}
                          </td>
                        ))}
                        <td className="num">{money(a.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th>{t('trend.total')}</th>
                      {report.totals.map((v, i) => (
                        <th key={report.months[i]?.label ?? i} className="num">
                          {money(v)}
                        </th>
                      ))}
                      <th className="num" data-testid="trend-total">
                        {money(report.total)}
                      </th>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            <Alert tone="info">{report.note}</Alert>
          </Card>
        ) : null}
      </AccountingPage>
    </>
  );
}
