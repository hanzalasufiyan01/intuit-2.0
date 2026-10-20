import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useT } from '../../i18n/i18n';

/**
 * Payroll register: per-employee and per-component totals of posted and paid pay runs in a date
 * range. Facts from frozen payslips only; no statutory figure is derived. Opening it is audited.
 */

interface Register {
  runs: { id: string; number: string; periodStart: string; periodEnd: string; status: string }[];
  employees: {
    employeeId: string;
    employeeNumber: string;
    employeeName: string;
    gross: string;
    deductions: string;
    net: string;
    employerCost: string;
  }[];
  components: { code: string; name: string; kind: string; amount: string }[];
  totals: { gross: string; deductions: string; net: string; employerCost: string };
}

const KINDS = ['basic', 'earning', 'deduction', 'employer_contribution'] as const;

export function PayrollRegisterPage() {
  const t = useT();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const year = new Date().getFullYear();
  const [range, setRange] = useState({ from: `${year}-01-01`, to: `${year}-12-31` });
  const valid = range.from !== '' && range.to !== '' && range.from <= range.to;
  const report = useQuery({
    queryKey: ['payroll-register', org, range.from, range.to],
    enabled: valid,
    queryFn: () => api.get<Register>(`/payroll/reports/register?from=${range.from}&to=${range.to}`),
    // Each open is audited on the server.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const money = (v: string) => formatAmount(v, 'MVR');
  const r = report.data;
  return (
    <>
      <PageHeader
        title={t('payrollRegister.title')}
        description={t('payrollRegister.description')}
      />
      <Card>
        <div className="filters">
          <TextField
            label={t('payrollRegister.from')}
            type="date"
            value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
          <TextField
            label={t('payrollRegister.to')}
            type="date"
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </div>
      </Card>
      {report.isPending && valid ? <Spinner /> : null}
      <ErrorAlert error={report.error} />
      {r ? (
        r.runs.length === 0 ? (
          <p className="muted">{t('payrollRegister.none')}</p>
        ) : (
          <>
            <Card
              title={t(
                r.runs.length === 1
                  ? 'payrollRegister.employeesOne'
                  : 'payrollRegister.employeesMany',
                {
                  count: r.runs.length,
                },
              )}
            >
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('payrollRegister.number')}</th>
                    <th>{t('payrollRegister.name')}</th>
                    <th className="num">{t('payrollRegister.gross')}</th>
                    <th className="num">{t('payrollRegister.deductions')}</th>
                    <th className="num">{t('payrollRegister.net')}</th>
                    <th className="num">{t('payrollRegister.employerCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.employees.map((e) => (
                    <tr key={e.employeeId}>
                      <td>{e.employeeNumber}</td>
                      <td>{e.employeeName}</td>
                      <td className="num">{money(e.gross)}</td>
                      <td className="num">{money(e.deductions)}</td>
                      <td className="num">{money(e.net)}</td>
                      <td className="num">{money(e.employerCost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={2}>{t('payrollRegister.total')}</th>
                    <th className="num">{money(r.totals.gross)}</th>
                    <th className="num">{money(r.totals.deductions)}</th>
                    <th className="num">{money(r.totals.net)}</th>
                    <th className="num">{money(r.totals.employerCost)}</th>
                  </tr>
                </tfoot>
              </table>
            </Card>
            <Card title={t('payrollRegister.byComponent')}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('payrollRegister.component')}</th>
                    <th>{t('payrollRegister.kind')}</th>
                    <th className="num">{t('payrollRegister.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.components.map((c) => (
                    <tr key={`${c.kind}-${c.code}`}>
                      <td>
                        {c.code} {c.name}
                      </td>
                      <td>
                        {(KINDS as readonly string[]).includes(c.kind)
                          ? t(`payrollRegister.kind.${c.kind as (typeof KINDS)[number]}`)
                          : c.kind}
                      </td>
                      <td className="num">{money(c.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        )
      ) : null}
    </>
  );
}
