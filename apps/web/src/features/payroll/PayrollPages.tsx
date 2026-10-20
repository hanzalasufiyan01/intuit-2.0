import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { AdjustmentsCard } from './AdjustmentsCard';
import { useT, type MessageKey } from '../../i18n/i18n';

/**
 * Payroll v1 (FP-25): pay runs with payslips, employees, pay components and settings. The server
 * calculates every figure and enforces the workflow (draft, approved, posted, paid); these pages
 * guide. Statutory rates are not built in: the organization configures them as components.
 */

export const PAYROLL_VIEW_PERMISSIONS = [Permission.PayrollView] as const;

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

/** The optional modules of the organization (migration 0065). */
export function useModules() {
  const org = useOrgKey();
  const canRead = usePermission(Permission.OrganizationRead);
  return useQuery({
    queryKey: ['organization-modules', org],
    enabled: canRead,
    queryFn: () =>
      api.get<{ modules: { payroll: boolean; projects: boolean; clinic: boolean } }>(
        '/organizations/current/modules',
      ),
  });
}

export function PayrollSection() {
  const t = useT();
  return (
    <>
      <nav className="subnav" aria-label={t('payroll.payrollPages.payroll')}>
        <NavLink to="/payroll/my-payslips">{t('payroll.payrollPages.myPayslips')}</NavLink>
        <NavLink to="/payroll/leave">{t('payroll.payrollPages.leave')}</NavLink>
        <Can permission={Permission.PayrollView}>
          <NavLink to="/payroll" end>
            {t('payroll.payrollPages.payRuns')}
          </NavLink>
          <NavLink to="/payroll/employees">{t('payroll.payrollPages.employees')}</NavLink>
          <NavLink to="/payroll/advances">{t('payroll.payrollPages.advances')}</NavLink>
          <NavLink to="/payroll/register">{t('payroll.payrollPages.register')}</NavLink>
          <NavLink to="/payroll/components">{t('payroll.payrollPages.payComponents')}</NavLink>
          <NavLink to="/payroll/settings">{t('payroll.payrollPages.settings')}</NavLink>
        </Can>
      </nav>
      <Outlet />
    </>
  );
}

// ---------------------------------------------------------------------------
// Module switches
// ---------------------------------------------------------------------------

export function ModulesPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canChange = usePermission(Permission.OrganizationUpdate);
  const modules = useModules();
  const set = useApiMutation((input: { key: string; enabled: boolean }) =>
    sensitive(() =>
      api.put(`/organizations/current/modules/${input.key}`, { enabled: input.enabled }),
    ),
  );
  const rows: {
    key: 'payroll' | 'projects' | 'clinic';
    label: string;
    description: string;
    available: boolean;
  }[] = [
    {
      key: 'payroll',
      label: t('payroll.modules.payroll.label'),
      description: t('payroll.modules.payroll.description'),
      available: true,
    },
    {
      key: 'projects',
      label: t('payroll.modules.projects.label'),
      description: t('payroll.modules.projects.description'),
      available: true,
    },
    {
      key: 'clinic',
      label: t('payroll.modules.clinic.label'),
      description: t('payroll.modules.clinic.description'),
      available: true,
    },
  ];
  return (
    <>
      <PageHeader
        title={t('payroll.payrollPages.modules')}
        description={t('payroll.payrollPages.optionalPartsOfTheProduct')}
      />
      <Card>
        {modules.isPending ? <Spinner /> : null}
        <ErrorAlert error={modules.error} />
        {modules.data ? (
          <table className="table">
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <strong>{r.label}</strong>
                    <br />
                    <small className="muted">{r.description}</small>
                  </td>
                  <td>
                    {modules.data.modules[r.key]
                      ? t('payroll.payrollPages.on')
                      : t('payroll.payrollPages.off')}
                  </td>
                  <td>
                    {canChange && r.available ? (
                      <Button
                        variant="secondary"
                        busy={set.isPending}
                        onClick={() =>
                          set.mutate(
                            { key: r.key, enabled: !modules.data.modules[r.key] },
                            {
                              onSuccess: () =>
                                void queryClient.invalidateQueries({
                                  queryKey: ['organization-modules', org],
                                }),
                            },
                          )
                        }
                      >
                        {modules.data.modules[r.key]
                          ? t('payroll.payrollPages.switchOff')
                          : t('payroll.payrollPages.switchOn')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <ErrorAlert error={set.error} />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pay runs
// ---------------------------------------------------------------------------

interface Run {
  id: string;
  number: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: 'DRAFT' | 'APPROVED' | 'POSTED' | 'PAID' | 'VOID';
  employeeCount: number;
  grossTotal: string;
  deductionsTotal: string;
  netTotal: string;
  employerCostTotal: string;
  journalId: string | null;
  paymentJournalId: string | null;
  voidReason: string | null;
  version: number;
}
interface Payslip {
  id: string;
  employeeNumber: string;
  employeeName: string;
  gross: string;
  deductions: string;
  net: string;
  employerCost: string;
  lines: { lineNo: number; kind: string; code: string; name: string; amount: string }[];
}
interface RunDetail extends Run {
  payslips: Payslip[];
}

const STATUS_LABEL: Record<Run['status'], MessageKey> = {
  DRAFT: 'payroll.payrollPages.runStatus.DRAFT',
  APPROVED: 'payroll.payrollPages.runStatus.APPROVED',
  POSTED: 'payroll.payrollPages.runStatus.POSTED',
  PAID: 'payroll.payrollPages.runStatus.PAID',
  VOID: 'payroll.payrollPages.runStatus.VOID',
};

export function PayRunsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canCreate = usePermission(Permission.PayrollRunsCreate);
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ['payroll-runs', org],
    queryFn: () => api.get<Run[]>('/payroll/runs'),
  });
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));
  const monthEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const [form, setForm] = useState({
    periodStart: iso(monthStart),
    periodEnd: iso(monthEnd),
    payDate: iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))),
  });
  const create = useApiMutation(() =>
    api.post<RunDetail>('/payroll/runs', form, { idempotencyKey: crypto.randomUUID() }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: (run) => {
        void queryClient.invalidateQueries({ queryKey: ['payroll-runs', org] });
        void navigate(`/payroll/runs/${run.id}`);
      },
    });
  };
  return (
    <>
      <PageHeader
        title={t('payroll.payrollPages.payRuns')}
        description={t('payroll.payrollPages.calculatePayForAPeriod')}
      />
      {canCreate ? (
        <Card title={t('payroll.payrollPages.newPayRun')}>
          <form className="filters" onSubmit={submit}>
            <TextField
              label={t('payroll.payrollPages.periodStart')}
              type="date"
              value={form.periodStart}
              onChange={(e) => setForm({ ...form, periodStart: e.target.value })}
            />
            <TextField
              label={t('payroll.payrollPages.periodEnd')}
              type="date"
              value={form.periodEnd}
              onChange={(e) => setForm({ ...form, periodEnd: e.target.value })}
            />
            <TextField
              label={t('payroll.payrollPages.payDate')}
              type="date"
              value={form.payDate}
              onChange={(e) => setForm({ ...form, payDate: e.target.value })}
            />
            <Button type="submit" busy={create.isPending}>
              {t('payroll.payrollPages.calculatePayRun')}
            </Button>
          </form>
          <ErrorAlert error={create.error} />
        </Card>
      ) : null}
      <Card title={t('payroll.payrollPages.runs')}>
        {list.isPending ? <Spinner /> : null}
        <ErrorAlert error={list.error} />
        {list.data ? (
          list.data.length === 0 ? (
            <p className="muted">{t('payroll.payrollPages.noPayRunsYet')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('payroll.payrollPages.number')}</th>
                  <th>{t('payroll.payrollPages.period')}</th>
                  <th className="num">{t('payroll.payrollPages.employees')}</th>
                  <th className="num">{t('payroll.payrollPages.gross')}</th>
                  <th className="num">{t('payroll.payrollPages.net')}</th>
                  <th>{t('payroll.payrollPages.status')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/payroll/runs/${r.id}`}>{r.number}</Link>
                    </td>
                    <td>
                      {t('payroll.payrollPages.to', {
                        periodStart: r.periodStart,
                        periodEnd: r.periodEnd,
                      })}
                    </td>
                    <td className="num">{r.employeeCount}</td>
                    <td className="num">{formatAmount(r.grossTotal, 'MVR')}</td>
                    <td className="num">{formatAmount(r.netTotal, 'MVR')}</td>
                    <td>{t(STATUS_LABEL[r.status])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </Card>
    </>
  );
}

export function PayRunDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canCreate = usePermission(Permission.PayrollRunsCreate);
  const canApprove = usePermission(Permission.PayrollRunsApprove);
  const canPost = usePermission(Permission.PayrollRunsPost);
  const canPay = usePermission(Permission.PayrollRunsPay);
  const canVoid = usePermission(Permission.PayrollRunsVoid);
  const accounts = useAccounts(canPay);
  const run = useQuery({
    queryKey: ['payroll-run', org, id],
    queryFn: () => api.get<RunDetail>(`/payroll/runs/${id}`),
  });
  const [bankId, setBankId] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['payroll-run', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['payroll-runs', org] });
  };
  const act = useApiMutation(
    (input: { action: 'recalculate' | 'approve' | 'post' | 'pay' | 'void'; body: object }) =>
      input.action === 'recalculate'
        ? api.post(`/payroll/runs/${id}/recalculate`, input.body)
        : sensitive(() => api.post(`/payroll/runs/${id}/${input.action}`, input.body)),
  );
  const announce = useApiMutation(() =>
    api.post<{
      sent: number;
      alreadySent: number;
      skipped: { employee: string; reason: string }[];
      failed: number;
    }>(`/payroll/runs/${id}/announce-payslips`, {}),
  );
  const r = run.data;
  const money = (v: string) => formatAmount(v, 'MVR');
  const go = (action: 'recalculate' | 'approve' | 'post' | 'pay' | 'void', extra: object = {}) => {
    if (!r) return;
    act.mutate({ action, body: { version: r.version, ...extra } }, { onSuccess: refresh });
  };
  const bankAccounts = (accounts.data ?? []).filter((a) => a.isBankOrCash && a.status === 'ACTIVE');
  return (
    <>
      <PageHeader
        title={
          r
            ? t('payroll.payrollPages.payRun', { number: r.number })
            : t('payroll.payrollPages.payRun2')
        }
        description={
          r
            ? t('payroll.payrollPages.toPaid', {
                periodStart: r.periodStart,
                periodEnd: r.periodEnd,
                payDate: r.payDate,
              })
            : undefined
        }
      />
      {run.isPending ? <Spinner /> : null}
      <ErrorAlert error={run.error} />
      {r ? (
        <>
          <Card title={t('payroll.payrollPages.status2', { value: t(STATUS_LABEL[r.status]) })}>
            <table className="table">
              <tbody>
                <tr>
                  <td>{t('payroll.payrollPages.employees')}</td>
                  <td className="num">{r.employeeCount}</td>
                </tr>
                <tr>
                  <td>{t('payroll.payrollPages.grossPay')}</td>
                  <td className="num">{money(r.grossTotal)}</td>
                </tr>
                <tr>
                  <td>{t('payroll.payrollPages.deductions')}</td>
                  <td className="num">{money(r.deductionsTotal)}</td>
                </tr>
                <tr>
                  <th>{t('payroll.payrollPages.netPay')}</th>
                  <th className="num">{money(r.netTotal)}</th>
                </tr>
                <tr>
                  <td>{t('payroll.payrollPages.employerContributions')}</td>
                  <td className="num">{money(r.employerCostTotal)}</td>
                </tr>
              </tbody>
            </table>
            {r.journalId ? (
              <p>
                <Link to={`/accounting/journals/${r.journalId}`}>
                  {t('payroll.payrollPages.postingJournal')}
                </Link>
                {r.paymentJournalId ? (
                  <>
                    {' · '}
                    <Link to={`/accounting/journals/${r.paymentJournalId}`}>
                      {t('payroll.payrollPages.paymentJournal')}
                    </Link>
                  </>
                ) : null}
              </p>
            ) : null}
            {r.voidReason ? (
              <Alert>{t('payroll.payrollPages.voided', { voidReason: r.voidReason })}</Alert>
            ) : null}
            <div className="filters">
              {r.status === 'DRAFT' && canCreate ? (
                <Button variant="secondary" onClick={() => go('recalculate')}>
                  {t('payroll.payrollPages.recalculate')}
                </Button>
              ) : null}
              {r.status === 'DRAFT' && canApprove ? (
                <Button onClick={() => go('approve')}>{t('payroll.payrollPages.approve')}</Button>
              ) : null}
              {r.status === 'APPROVED' && canPost ? (
                <Button onClick={() => go('post')}>{t('payroll.payrollPages.postToLedger')}</Button>
              ) : null}
              {['DRAFT', 'APPROVED', 'POSTED'].includes(r.status) && canVoid ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    const reason = window.prompt(t('payroll.payrollPages.whyIsThisPayRun'));
                    if (reason?.trim()) go('void', { reason: reason.trim() });
                  }}
                >
                  {t('payroll.payrollPages.void')}
                </Button>
              ) : null}
            </div>
            {['POSTED', 'PAID'].includes(r.status) && canPay ? (
              <div>
                <Button
                  variant="secondary"
                  busy={announce.isPending}
                  onClick={() => announce.mutate()}
                >
                  {t('payroll.payrollPages.announcePayslips')}
                </Button>
                <small className="field__hint">
                  {t('payroll.payrollPages.tellsEmployeesWithALinked')}
                </small>
                {announce.data ? (
                  <Alert tone="info">
                    {t('payroll.payrollPages.announcedToAlreadyToldSkipped', {
                      sent: announce.data.sent,
                      alreadySent: announce.data.alreadySent,
                      count: announce.data.skipped.length,
                      value: announce.data.skipped.length
                        ? ` (${announce.data.skipped.map((x) => `${x.employee}: ${x.reason}`).join('; ')})`
                        : '',
                      failed: announce.data.failed,
                    })}
                  </Alert>
                ) : null}
                <ErrorAlert error={announce.error} />
              </div>
            ) : null}
            {r.status === 'POSTED' && canPay ? (
              <form
                className="filters"
                onSubmit={(e) => {
                  e.preventDefault();
                  go('pay', { bankAccountId: bankId, paymentDate });
                }}
              >
                <div className="field">
                  <label htmlFor="pay-bank">{t('payroll.payrollPages.payFrom')}</label>
                  <select
                    id="pay-bank"
                    value={bankId}
                    required
                    onChange={(e) => setBankId(e.target.value)}
                  >
                    <option value="">{t('payroll.payrollPages.chooseABankOrCash')}</option>
                    {bankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <TextField
                  label={t('payroll.payrollPages.paymentDate')}
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                />
                <Button type="submit" disabled={!bankId}>
                  {t('payroll.payrollPages.recordPayment')}
                </Button>
              </form>
            ) : null}
            <ErrorAlert error={act.error} />
          </Card>
          {r.status === 'DRAFT' && canCreate ? (
            <AdjustmentsCard runId={r.id} onChanged={refresh} />
          ) : null}
          <Card title={t('payroll.payrollPages.payslips')}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('payroll.payrollPages.employee')}</th>
                  <th className="num">{t('payroll.payrollPages.gross')}</th>
                  <th className="num">{t('payroll.payrollPages.deductions')}</th>
                  <th className="num">{t('payroll.payrollPages.net')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {r.payslips.map((p) => (
                  <PayslipRows
                    key={p.id}
                    slip={p}
                    expanded={open === p.id}
                    onToggle={() => setOpen(open === p.id ? null : p.id)}
                    money={money}
                  />
                ))}
              </tbody>
            </table>
          </Card>
        </>
      ) : null}
    </>
  );
}

function PayslipRows({
  slip,
  expanded,
  onToggle,
  money,
}: {
  slip: Payslip;
  expanded: boolean;
  onToggle: () => void;
  money: (v: string) => string;
}) {
  const t = useT();
  return (
    <>
      <tr>
        <td>
          {slip.employeeName} <small className="muted">{slip.employeeNumber}</small>
        </td>
        <td className="num">{money(slip.gross)}</td>
        <td className="num">{money(slip.deductions)}</td>
        <td className="num">{money(slip.net)}</td>
        <td>
          <Button variant="ghost" onClick={onToggle}>
            {expanded ? t('payroll.payrollPages.hide') : t('payroll.payrollPages.lines')}
          </Button>{' '}
          <a href={`/api/v1/payroll/payslips/${slip.id}/pdf`} download>
            PDF
          </a>
        </td>
      </tr>
      {expanded
        ? slip.lines.map((l) => (
            <tr key={l.lineNo}>
              <td colSpan={3}>
                <small>
                  {l.name} ({l.kind.replace('_', ' ')})
                </small>
              </td>
              <td className="num">
                <small>{money(l.amount)}</small>
              </td>
              <td />
            </tr>
          ))
        : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

interface Component {
  id: string;
  code: string;
  name: string;
  kind: 'earning' | 'deduction' | 'employer_contribution';
  calculation: 'fixed' | 'percent_of_basic' | 'percent_of_gross';
  defaultValue: string;
  expenseAccountId: string | null;
  liabilityAccountId: string | null;
  isActive: boolean;
  version: number;
}
interface Employee {
  id: string;
  number: string;
  displayName: string;
  email: string | null;
  nationalId: string | null;
  linked: boolean;
  hireDate: string;
  terminationDate: string | null;
  status: 'active' | 'terminated';
  basicSalary: string;
  components: { componentId: string; value: string | null }[];
  version: number;
}

const KIND_LABEL: Record<'earning' | 'deduction' | 'employer_contribution', MessageKey> = {
  earning: 'payroll.payrollPages.componentKind.earning',
  deduction: 'payroll.payrollPages.componentKind.deduction',
  employer_contribution: 'payroll.payrollPages.componentKind.employer_contribution',
};
const CALC_LABEL: Record<'fixed' | 'percent_of_basic' | 'percent_of_gross', MessageKey> = {
  fixed: 'payroll.payrollPages.calculation.fixed',
  percent_of_basic: 'payroll.payrollPages.calculation.percent_of_basic',
  percent_of_gross: 'payroll.payrollPages.calculation.percent_of_gross',
};

function SalaryHistoryCard({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const t = useT();
  const history = useQuery({
    queryKey: ['payroll-salary-history', employee.id],
    queryFn: () =>
      api.get<{ id: string; effectiveFrom: string; basicSalary: string; reason: string }[]>(
        `/payroll/employees/${employee.id}/salary-history`,
      ),
  });
  return (
    <Card title={t('payroll.payrollPages.salaryHistory', { displayName: employee.displayName })}>
      {history.isPending ? <Spinner /> : null}
      <ErrorAlert error={history.error} />
      {history.data ? (
        <table className="table">
          <thead>
            <tr>
              <th>{t('payroll.payrollPages.effectiveFrom')}</th>
              <th className="num">{t('payroll.payrollPages.basicSalary')}</th>
              <th>{t('payroll.payrollPages.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {history.data.map((h) => (
              <tr key={h.id}>
                <td>{h.effectiveFrom}</td>
                <td className="num">{formatAmount(h.basicSalary, 'MVR')}</td>
                <td>{h.reason || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <Button variant="ghost" onClick={onClose}>
        {t('payroll.payrollPages.close')}
      </Button>
    </Card>
  );
}

export function EmployeesPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.PayrollEmployeesManage);
  const employees = useQuery({
    queryKey: ['payroll-employees', org],
    queryFn: () => api.get<Employee[]>('/payroll/employees'),
  });
  const components = useQuery({
    queryKey: ['payroll-components', org],
    queryFn: () => api.get<Component[]>('/payroll/components'),
  });
  const blank = {
    displayName: '',
    email: '',
    nationalId: '',
    hireDate: new Date().toISOString().slice(0, 10),
    terminationDate: '',
    basicSalary: '',
    bankAccountRef: '',
    salaryEffectiveFrom: '',
    salaryReason: '',
  };
  const [form, setForm] = useState(blank);
  const [historyOf, setHistoryOf] = useState<Employee | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Employee | null>(null);
  const body = () => ({
    displayName: form.displayName.trim(),
    email: form.email.trim() || null,
    ...(form.nationalId.trim() ? { nationalId: form.nationalId.trim() } : {}),
    hireDate: form.hireDate,
    terminationDate: form.terminationDate || null,
    basicSalary: form.basicSalary.trim(),
    bankAccountRef: form.bankAccountRef.trim() || null,
    ...(editing && form.salaryEffectiveFrom
      ? { salaryEffectiveFrom: form.salaryEffectiveFrom }
      : {}),
    ...(editing && form.salaryReason.trim() ? { salaryReason: form.salaryReason.trim() } : {}),
    components: Object.entries(chosen).map(([componentId, value]) => ({
      componentId,
      value: value.trim() ? value.trim() : null,
    })),
  });
  const save = useApiMutation(() =>
    editing
      ? api.put(`/payroll/employees/${editing.id}`, { ...body(), version: editing.version })
      : api.post('/payroll/employees', body()),
  );
  const edit = (e: Employee) => {
    setEditing(e);
    setForm({
      displayName: e.displayName,
      email: e.email ?? '',
      nationalId: '',
      hireDate: e.hireDate,
      terminationDate: e.terminationDate ?? '',
      basicSalary: e.basicSalary,
      bankAccountRef: '',
      salaryEffectiveFrom: '',
      salaryReason: '',
    });
    setChosen(Object.fromEntries(e.components.map((c) => [c.componentId, c.value ?? ''])));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined, {
      onSuccess: () => {
        setEditing(null);
        setForm(blank);
        setChosen({});
        void queryClient.invalidateQueries({ queryKey: ['payroll-employees', org] });
      },
    });
  };
  const nameOf = (id: string) => components.data?.find((c) => c.id === id)?.code ?? id;
  return (
    <>
      <PageHeader
        title={t('payroll.payrollPages.employees')}
        description={t('payroll.payrollPages.peopleWhoArePaidThrough')}
      />
      <Card title={t('payroll.payrollPages.employees')}>
        {employees.isPending ? <Spinner /> : null}
        <ErrorAlert error={employees.error} />
        {employees.data ? (
          employees.data.length === 0 ? (
            <p className="muted">{t('payroll.payrollPages.noEmployeesYet')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('payroll.payrollPages.number')}</th>
                  <th>{t('payroll.payrollPages.name')}</th>
                  <th>{t('payroll.payrollPages.nationalId')}</th>
                  <th>{t('payroll.payrollPages.hired')}</th>
                  <th className="num">{t('payroll.payrollPages.basicSalary')}</th>
                  <th>{t('payroll.payrollPages.components')}</th>
                  <th>{t('payroll.payrollPages.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {employees.data.map((e) => (
                  <tr key={e.id}>
                    <td>{e.number}</td>
                    <td>
                      {e.displayName}
                      {e.linked ? (
                        <small className="muted"> {t('payroll.payrollPages.linkedLogin')}</small>
                      ) : null}
                    </td>
                    <td>{e.nationalId ?? '—'}</td>
                    <td>{e.hireDate}</td>
                    <td className="num">{formatAmount(e.basicSalary, 'MVR')}</td>
                    <td>{e.components.map((c) => nameOf(c.componentId)).join(', ') || '—'}</td>
                    <td>{e.status}</td>
                    <td>
                      <Button
                        variant="ghost"
                        aria-label={t('payroll.payrollPages.salaryHistoryFor', {
                          displayName: e.displayName,
                        })}
                        onClick={() => setHistoryOf(e)}
                      >
                        {t('payroll.payrollPages.salaryHistory2')}
                      </Button>
                      {canManage ? (
                        <Button variant="ghost" onClick={() => edit(e)}>
                          {t('common.edit')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </Card>
      {historyOf ? (
        <SalaryHistoryCard employee={historyOf} onClose={() => setHistoryOf(null)} />
      ) : null}
      {canManage ? (
        <Card
          title={
            editing
              ? t('payroll.payrollPages.edit', { number: editing.number })
              : t('payroll.payrollPages.newEmployee')
          }
        >
          <form className="form" onSubmit={submit} noValidate>
            <TextField
              label={t('payroll.payrollPages.name')}
              value={form.displayName}
              required
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <TextField
              label={t('payroll.payrollPages.email')}
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <TextField
              label={
                editing
                  ? t('payroll.payrollPages.nationalIdLeaveEmptyTo')
                  : t('payroll.payrollPages.nationalId')
              }
              value={form.nationalId}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, nationalId: e.target.value })}
            />
            <TextField
              label={t('payroll.payrollPages.hireDate')}
              type="date"
              value={form.hireDate}
              onChange={(e) => setForm({ ...form, hireDate: e.target.value })}
            />
            <TextField
              label={t('payroll.payrollPages.lastDayOfEmployment')}
              type="date"
              value={form.terminationDate}
              onChange={(e) => setForm({ ...form, terminationDate: e.target.value })}
            />
            <TextField
              label={t('payroll.payrollPages.basicMonthlySalary')}
              value={form.basicSalary}
              required
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, basicSalary: e.target.value })}
            />
            {editing && form.basicSalary.trim() !== editing.basicSalary ? (
              <>
                <TextField
                  label={t('payroll.payrollPages.salaryTakesEffectFrom')}
                  type="date"
                  value={form.salaryEffectiveFrom}
                  onChange={(e) => setForm({ ...form, salaryEffectiveFrom: e.target.value })}
                />
                <small className="field__hint">
                  {t('payroll.payrollPages.leaveTheDateEmptyTo')}
                </small>
                <TextField
                  label={t('payroll.payrollPages.reasonForTheChange')}
                  value={form.salaryReason}
                  onChange={(e) => setForm({ ...form, salaryReason: e.target.value })}
                />
              </>
            ) : null}
            <fieldset>
              <legend>{t('payroll.payrollPages.payComponentsLeaveTheValue')}</legend>
              {(components.data ?? [])
                .filter((c) => c.isActive)
                .map((c) => (
                  <div key={c.id} className="filters">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={c.id in chosen}
                        onChange={(e) => {
                          const next = { ...chosen };
                          if (e.target.checked) next[c.id] = '';
                          else delete next[c.id];
                          setChosen(next);
                        }}
                      />{' '}
                      {c.name}{' '}
                      <small className="muted">
                        {t('payroll.payrollPages.default', {
                          value: t(KIND_LABEL[c.kind]),
                          defaultValue: c.defaultValue,
                        })}
                      </small>
                    </label>
                    {c.id in chosen ? (
                      <TextField
                        label={t('payroll.payrollPages.value', { code: c.code })}
                        value={chosen[c.id] ?? ''}
                        inputMode="decimal"
                        onChange={(e) => setChosen({ ...chosen, [c.id]: e.target.value })}
                      />
                    ) : null}
                  </div>
                ))}
            </fieldset>
            <ErrorAlert error={save.error} />
            <Button
              type="submit"
              busy={save.isPending}
              disabled={!form.displayName.trim() || !form.basicSalary.trim()}
            >
              {editing
                ? t('payroll.payrollPages.saveEmployee')
                : t('payroll.payrollPages.addEmployee')}
            </Button>
            {editing ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(null);
                  setForm(blank);
                  setChosen({});
                }}
              >
                {t('common.cancel')}
              </Button>
            ) : null}
          </form>
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Pay components
// ---------------------------------------------------------------------------

export function ComponentsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.PayrollSettingsManage);
  const accounts = useAccounts(canManage);
  const list = useQuery({
    queryKey: ['payroll-components', org],
    queryFn: () => api.get<Component[]>('/payroll/components'),
  });
  const blank = {
    code: '',
    name: '',
    kind: 'earning',
    calculation: 'fixed',
    defaultValue: '0',
    expenseAccountId: '',
    liabilityAccountId: '',
  };
  const [form, setForm] = useState(blank);
  const create = useApiMutation(() =>
    api.post('/payroll/components', {
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      kind: form.kind,
      calculation: form.calculation,
      defaultValue: form.defaultValue.trim(),
      ...(form.kind !== 'deduction' ? { expenseAccountId: form.expenseAccountId || null } : {}),
      ...(form.kind !== 'earning' ? { liabilityAccountId: form.liabilityAccountId || null } : {}),
    }),
  );
  const toggle = useApiMutation((c: Component) =>
    api.put(`/payroll/components/${c.id}`, {
      version: c.version,
      isActive: !c.isActive,
      name: c.name,
      calculation: c.calculation,
      defaultValue: c.defaultValue,
      expenseAccountId: c.expenseAccountId,
      liabilityAccountId: c.liabilityAccountId,
    }),
  );
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['payroll-components', org] });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: () => {
        setForm(blank);
        refresh();
      },
    });
  };
  const options = (subtypes: readonly string[]) =>
    (accounts.data ?? []).filter(
      (a) =>
        a.status === 'ACTIVE' && a.isLeaf && a.subtype !== null && subtypes.includes(a.subtype),
    );
  const expenseOptions = options(['OPERATING_EXPENSE', 'COST_OF_SALES', 'OTHER_EXPENSE']);
  const liabilityOptions = options(['OTHER_CURRENT_LIABILITY', 'LONG_TERM_LIABILITY']);
  return (
    <>
      <PageHeader
        title={t('payroll.payrollPages.payComponents')}
        description={t('payroll.payrollPages.allowancesDeductionsAndEmployerContributions')}
      />
      <Card title={t('payroll.payrollPages.components')}>
        {list.isPending ? <Spinner /> : null}
        <ErrorAlert error={list.error} />
        {list.data ? (
          list.data.length === 0 ? (
            <p className="muted">{t('payroll.payrollPages.noComponentsYet')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('payroll.payrollPages.code')}</th>
                  <th>{t('payroll.payrollPages.name')}</th>
                  <th>{t('payroll.payrollPages.kind')}</th>
                  <th>{t('payroll.payrollPages.calculation')}</th>
                  <th className="num">{t('payroll.payrollPages.default2')}</th>
                  <th>{t('payroll.payrollPages.active')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.map((c) => (
                  <tr key={c.id}>
                    <td>{c.code}</td>
                    <td>{c.name}</td>
                    <td>{t(KIND_LABEL[c.kind])}</td>
                    <td>{t(CALC_LABEL[c.calculation])}</td>
                    <td className="num">{c.defaultValue}</td>
                    <td>
                      {c.isActive ? t('payroll.payrollPages.yes') : t('payroll.payrollPages.no')}
                    </td>
                    <td>
                      {canManage ? (
                        <Button
                          variant="ghost"
                          onClick={() => toggle.mutate(c, { onSuccess: refresh })}
                        >
                          {c.isActive
                            ? t('payroll.payrollPages.deactivate')
                            : t('payroll.payrollPages.activate')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
        <ErrorAlert error={toggle.error} />
      </Card>
      {canManage ? (
        <Card title={t('payroll.payrollPages.newComponent')}>
          <form className="form" onSubmit={submit} noValidate>
            <TextField
              label={t('payroll.payrollPages.codeCapitals')}
              value={form.code}
              required
              maxLength={20}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
            <TextField
              label={t('payroll.payrollPages.name')}
              value={form.name}
              required
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <div className="field">
              <label htmlFor="pc-kind">{t('payroll.payrollPages.kind')}</label>
              <select
                id="pc-kind"
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value })}
              >
                <option value="earning">{t('payroll.payrollPages.earning')}</option>
                <option value="deduction">{t('payroll.payrollPages.deduction')}</option>
                <option value="employer_contribution">
                  {t('payroll.payrollPages.employerContribution')}
                </option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="pc-calc">{t('payroll.payrollPages.calculation')}</label>
              <select
                id="pc-calc"
                value={form.calculation}
                onChange={(e) => setForm({ ...form, calculation: e.target.value })}
              >
                <option value="fixed">{t('payroll.payrollPages.fixedAmount')}</option>
                <option value="percent_of_basic">
                  {t('payroll.payrollPages.percentOfBasicSalary')}
                </option>
                {form.kind !== 'earning' ? (
                  <option value="percent_of_gross">
                    {t('payroll.payrollPages.percentOfGrossPay')}
                  </option>
                ) : null}
              </select>
            </div>
            <TextField
              label={t('payroll.payrollPages.defaultValueAmountOrPercent')}
              value={form.defaultValue}
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, defaultValue: e.target.value })}
            />
            {form.kind !== 'deduction' ? (
              <div className="field">
                <label htmlFor="pc-exp">{t('payroll.payrollPages.expenseAccount')}</label>
                <select
                  id="pc-exp"
                  value={form.expenseAccountId}
                  onChange={(e) => setForm({ ...form, expenseAccountId: e.target.value })}
                >
                  <option value="">{t('common.choose')}</option>
                  {expenseOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {form.kind !== 'earning' ? (
              <div className="field">
                <label htmlFor="pc-lia">{t('payroll.payrollPages.liabilityAccount')}</label>
                <select
                  id="pc-lia"
                  value={form.liabilityAccountId}
                  onChange={(e) => setForm({ ...form, liabilityAccountId: e.target.value })}
                >
                  <option value="">{t('common.choose')}</option>
                  {liabilityOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <ErrorAlert error={create.error} />
            <Button
              type="submit"
              busy={create.isPending}
              disabled={!form.code.trim() || !form.name.trim()}
            >
              {t('payroll.payrollPages.addComponent')}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings and my payslips
// ---------------------------------------------------------------------------

interface Settings {
  basicSalaryExpenseAccountId: string | null;
  netPayPayableAccountId: string | null;
  advancesAccountId: string | null;
  proration: 'calendar_days' | 'none';
  requireSeparateApprover: boolean;
  version: number;
}

export function PayrollSettingsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canManage = usePermission(Permission.PayrollSettingsManage);
  const accounts = useAccounts(true);
  const settings = useQuery({
    queryKey: ['payroll-settings', org],
    queryFn: () => api.get<Settings>('/payroll/settings'),
  });
  const [draft, setDraft] = useState<Settings | null>(null);
  const current = draft ?? settings.data ?? null;
  const save = useApiMutation((value: Settings) =>
    sensitive(() => api.put('/payroll/settings', value)),
  );
  const options = (subtypes: readonly string[]) =>
    (accounts.data ?? []).filter(
      (a) =>
        a.status === 'ACTIVE' && a.isLeaf && a.subtype !== null && subtypes.includes(a.subtype),
    );
  return (
    <>
      <PageHeader
        title={t('payroll.payrollPages.payrollSettings')}
        description={t('payroll.payrollPages.theAccountsPayrollPostsTo')}
      />
      <Card>
        {settings.isPending ? <Spinner /> : null}
        <ErrorAlert error={settings.error} />
        {current ? (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(current, {
                onSuccess: () => {
                  setDraft(null);
                  void queryClient.invalidateQueries({ queryKey: ['payroll-settings', org] });
                },
              });
            }}
          >
            <div className="field">
              <label htmlFor="ps-basic">
                {t('payroll.payrollPages.basicSalaryExpenseAccount')}
              </label>
              <select
                id="ps-basic"
                disabled={!canManage}
                value={current.basicSalaryExpenseAccountId ?? ''}
                onChange={(e) =>
                  setDraft({ ...current, basicSalaryExpenseAccountId: e.target.value || null })
                }
              >
                <option value="">{t('common.choose')}</option>
                {options(['OPERATING_EXPENSE', 'COST_OF_SALES', 'OTHER_EXPENSE']).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ps-net">{t('payroll.payrollPages.netPayPayableAccount')}</label>
              <select
                id="ps-net"
                disabled={!canManage}
                value={current.netPayPayableAccountId ?? ''}
                onChange={(e) =>
                  setDraft({ ...current, netPayPayableAccountId: e.target.value || null })
                }
              >
                <option value="">{t('common.choose')}</option>
                {options(['OTHER_CURRENT_LIABILITY', 'LONG_TERM_LIABILITY']).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ps-adv">{t('payroll.payrollPages.employeeAdvancesAccount')}</label>
              <select
                id="ps-adv"
                disabled={!canManage}
                value={current.advancesAccountId ?? ''}
                onChange={(e) =>
                  setDraft({ ...current, advancesAccountId: e.target.value || null })
                }
              >
                <option value="">{t('payroll.payrollPages.noneAdvancesDisabled')}</option>
                {options(['OTHER_CURRENT_ASSET']).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ps-pro">{t('payroll.payrollPages.partMonthPay')}</label>
              <select
                id="ps-pro"
                disabled={!canManage}
                value={current.proration}
                onChange={(e) =>
                  setDraft({ ...current, proration: e.target.value as Settings['proration'] })
                }
              >
                <option value="calendar_days">
                  {t('payroll.payrollPages.prorateByCalendarDays')}
                </option>
                <option value="none">{t('payroll.payrollPages.payInFull')}</option>
              </select>
            </div>
            <label className="check">
              <input
                type="checkbox"
                disabled={!canManage}
                checked={current.requireSeparateApprover}
                onChange={(e) =>
                  setDraft({ ...current, requireSeparateApprover: e.target.checked })
                }
              />{' '}
              {t('payroll.payrollPages.thePersonWhoPreparesA')}
            </label>
            <ErrorAlert error={save.error} />
            {canManage ? (
              <Button type="submit" busy={save.isPending}>
                {t('payroll.payrollPages.saveSettings')}
              </Button>
            ) : null}
          </form>
        ) : null}
      </Card>
    </>
  );
}

interface MyPayslip {
  id: string;
  runNumber: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  runStatus: string;
  gross: string;
  deductions: string;
  net: string;
  lines: { kind: string; code: string; name: string; amount: string }[];
}

export function MyPayslipsPage() {
  const t = useT();
  const org = useOrgKey();
  const slips = useQuery({
    queryKey: ['payroll-my-payslips', org],
    queryFn: () => api.get<MyPayslip[]>('/payroll/my-payslips'),
  });
  return (
    <>
      <PageHeader
        title={t('payroll.payrollPages.myPayslips')}
        description={t('payroll.payrollPages.yourOwnPayslipsFromPosted')}
      />
      {slips.isPending ? <Spinner /> : null}
      <ErrorAlert error={slips.error} />
      {slips.data && slips.data.length === 0 ? (
        <Card>
          <p className="muted">{t('payroll.payrollPages.noPayslipsYet')}</p>
        </Card>
      ) : null}
      {(slips.data ?? []).map((s) => (
        <Card
          key={s.id}
          title={t('payroll.payrollPages.to', {
            periodStart: s.periodStart,
            periodEnd: s.periodEnd,
          })}
        >
          <table className="table">
            <tbody>
              {s.lines.map((l, i) => (
                <tr key={`${l.code}-${i}`}>
                  <td>{l.name}</td>
                  <td className="num">
                    {l.kind === 'deduction' ? '−' : ''}
                    {formatAmount(l.amount, 'MVR')}
                  </td>
                </tr>
              ))}
              <tr>
                <th>{t('payroll.payrollPages.netPay')}</th>
                <th className="num">{formatAmount(s.net, 'MVR')}</th>
              </tr>
            </tbody>
          </table>
          <small className="muted">
            {t('payroll.payrollPages.runPaid', { runNumber: s.runNumber, payDate: s.payDate })}{' '}
            <a href={`/api/v1/payroll/my-payslips/${s.id}/pdf`} download>
              {t('payroll.payrollPages.downloadPdf')}
            </a>
          </small>
        </Card>
      ))}
    </>
  );
}
