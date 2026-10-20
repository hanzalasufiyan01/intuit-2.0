import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { AccountingPage, useOrgKey } from '../accounting/shared';
import { useT } from '../../i18n/i18n';

/**
 * Statement of Cash Flows (indirect method) and Statement of Changes in Equity (master context
 * section 16, ADR 0012). Both are read-only views of the posted ledger; the server computes every
 * amount and the integrity result, which is shown, never hidden.
 */

interface Warning {
  code: string;
  message: string;
}
interface Integrity {
  status: 'BALANCED' | 'OUT_OF_BALANCE' | 'NOT_APPLICABLE';
  checks: { name: string; status: string; difference: string }[];
}
interface CashFlowColumn {
  key: string;
  label: string;
  netIncome: string;
  sections: {
    key: string;
    label: string;
    total: string;
    groups: {
      key: string;
      label: string;
      total: string;
      lines: { accountId: string; code: string; name: string; amount: string }[];
    }[];
  }[];
  cash: { opening: string; netChange: string; closing: string };
  warnings: Warning[];
  integrity: Integrity;
}
interface CashFlowReport {
  baseCurrency: string;
  columns: CashFlowColumn[];
}
interface EquityReport {
  baseCurrency: string;
  from: string;
  to: string;
  columns: {
    key: string;
    label: string;
    opening: string;
    profit: string;
    otherMovements: string;
    closing: string;
  }[];
  totals: { opening: string; profit: string; otherMovements: string; closing: string };
  warnings: Warning[];
  integrity: Integrity;
}

function useRange() {
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [applied, setApplied] = useState({ from, to });
  return {
    from,
    to,
    setFrom,
    setTo,
    applied,
    apply: (event: FormEvent) => {
      event.preventDefault();
      setApplied({ from, to });
    },
  };
}

function RangeForm({ range }: { range: ReturnType<typeof useRange> }) {
  const t = useT();
  return (
    <Card>
      <form className="filters" onSubmit={range.apply}>
        <TextField
          label={t('reports.statementPages.from')}
          type="date"
          value={range.from}
          onChange={(e) => range.setFrom(e.target.value)}
        />
        <TextField
          label={t('reports.statementPages.to')}
          type="date"
          value={range.to}
          onChange={(e) => range.setTo(e.target.value)}
        />
        <Button type="submit">{t('reports.statementPages.runReport')}</Button>
      </form>
    </Card>
  );
}

function IntegrityNote({ integrity }: { integrity: Integrity }) {
  const t = useT();
  if (integrity.status === 'BALANCED') {
    return <p className="muted">{t('reports.statementPages.integrityCheckTheStatementAgrees')}</p>;
  }
  if (integrity.status === 'NOT_APPLICABLE') {
    return <p className="muted">{t('reports.statementPages.integrityCheckNotApplicableTo')}</p>;
  }
  return (
    <Alert>
      {t('reports.statementPages.integrityCheckFailed', {
        value: integrity.checks
          .filter((c) => c.status === 'FAIL')
          .map((c) => `${c.name} (difference ${c.difference})`)
          .join('; '),
      })}
    </Alert>
  );
}

export function CashFlowPage() {
  const t = useT();
  const org = useOrgKey();
  const range = useRange();
  const query = useQuery({
    queryKey: ['report-cash-flow', org, range.applied],
    queryFn: () =>
      api.get<CashFlowReport>(
        `/accounting/reports/cash-flow?from=${range.applied.from}&to=${range.applied.to}`,
      ),
  });
  const report = query.data;
  const column = report?.columns[0];
  const money = (value: string) => formatAmount(value, report?.baseCurrency ?? 'MVR');
  return (
    <>
      <PageHeader
        title={t('reports.statementPages.cashFlow')}
        description={t('reports.statementPages.statementOfCashFlowsIndirect')}
      />
      <AccountingPage>
        <RangeForm range={range} />
        {query.isPending ? <Spinner /> : null}
        <ErrorAlert error={query.error} />
        {report && column ? (
          <Card title={column.label}>
            {column.warnings.map((w) => (
              <Alert key={w.code}>{w.message}</Alert>
            ))}
            <table className="table">
              <tbody>
                {column.sections.map((section) => (
                  <SectionRows
                    key={section.key}
                    section={section}
                    netIncome={section.key === 'operating' ? column.netIncome : null}
                    money={money}
                  />
                ))}
                <tr>
                  <th>{t('reports.statementPages.netChangeInCash')}</th>
                  <td className="num">{money(column.cash.netChange)}</td>
                </tr>
                <tr>
                  <td>{t('reports.statementPages.openingCash')}</td>
                  <td className="num">{money(column.cash.opening)}</td>
                </tr>
                <tr>
                  <th>{t('reports.statementPages.closingCash')}</th>
                  <td className="num">{money(column.cash.closing)}</td>
                </tr>
              </tbody>
            </table>
            <IntegrityNote integrity={column.integrity} />
          </Card>
        ) : null}
      </AccountingPage>
    </>
  );
}

function SectionRows({
  section,
  netIncome,
  money,
}: {
  section: CashFlowColumn['sections'][number];
  netIncome: string | null;
  money: (value: string) => string;
}) {
  const t = useT();
  return (
    <>
      <tr>
        <th colSpan={2}>{section.label}</th>
      </tr>
      {netIncome !== null ? (
        <tr>
          <td>{t('reports.statementPages.netProfit')}</td>
          <td className="num">{money(netIncome)}</td>
        </tr>
      ) : null}
      {section.groups.map((group) => (
        <tr key={group.key}>
          <td>{group.label}</td>
          <td className="num">{money(group.total)}</td>
        </tr>
      ))}
      <tr>
        <th>{t('reports.statementPages.netCashFromActivities', { key: section.key })}</th>
        <td className="num">{money(section.total)}</td>
      </tr>
    </>
  );
}

export function ChangesInEquityPage() {
  const t = useT();
  const org = useOrgKey();
  const range = useRange();
  const query = useQuery({
    queryKey: ['report-changes-in-equity', org, range.applied],
    queryFn: () =>
      api.get<EquityReport>(
        `/accounting/reports/changes-in-equity?from=${range.applied.from}&to=${range.applied.to}`,
      ),
  });
  const report = query.data;
  const money = (value: string) => formatAmount(value, report?.baseCurrency ?? 'MVR');
  return (
    <>
      <PageHeader
        title={t('reports.statementPages.changesInEquity')}
        description={t('reports.statementPages.statementOfChangesInEquity')}
      />
      <AccountingPage>
        <RangeForm range={range} />
        {query.isPending ? <Spinner /> : null}
        <ErrorAlert error={query.error} />
        {report ? (
          <Card title={`${report.from} – ${report.to}`}>
            {report.warnings.map((w) => (
              <Alert key={w.code}>{w.message}</Alert>
            ))}
            <table className="table">
              <thead>
                <tr>
                  <th />
                  {report.columns.map((c) => (
                    <th key={c.key} className="num">
                      {c.label}
                    </th>
                  ))}
                  <th className="num">{t('reports.statementPages.total')}</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    [t('reports.statementPages.equityOpening'), 'opening'],
                    [t('reports.statementPages.equityProfit'), 'profit'],
                    [t('reports.statementPages.equityOther'), 'otherMovements'],
                    [t('reports.statementPages.equityClosing'), 'closing'],
                  ] as const
                ).map(([label, field]) => (
                  <tr key={field}>
                    <th>{label}</th>
                    {report.columns.map((c) => (
                      <td key={c.key} className="num">
                        {money(c[field])}
                      </td>
                    ))}
                    <td className="num">{money(report.totals[field])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <IntegrityNote integrity={report.integrity} />
          </Card>
        ) : null}
      </AccountingPage>
    </>
  );
}
