import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { useT } from '../../i18n/i18n';

/**
 * Leave and salary advances (FP-25, migration 0073). The server owns every rule (balances,
 * overlaps, self-approval, instalment recovery through pay runs); these pages guide.
 */

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

interface LeaveType {
  id: string;
  code: string;
  name: string;
  daysPerYear: string;
  allowNegative: boolean;
  isActive: boolean;
}
interface LeaveRequest {
  id: string;
  employeeName: string | null;
  leaveTypeName: string | null;
  startDate: string;
  endDate: string;
  days: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  decisionNote: string | null;
  version: number;
}
interface Balances {
  balances: {
    leaveTypeId: string;
    name: string;
    entitlement: string;
    taken: string;
    pending: string;
    remaining: string;
  }[];
}
interface EmployeeOption {
  id: string;
  displayName: string;
}

export function LeavePage() {
  const translate = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const manage = usePermission(Permission.PayrollLeaveManage);
  const types = useQuery({
    queryKey: ['payroll-leave-types', org],
    queryFn: () => api.get<LeaveType[]>('/payroll/leave/types'),
  });
  const requests = useQuery({
    queryKey: ['payroll-leave-requests', org],
    queryFn: () => api.get<LeaveRequest[]>('/payroll/leave/requests'),
  });
  const balances = useQuery({
    queryKey: ['payroll-leave-balances', org],
    queryFn: () => api.get<Balances>('/payroll/leave/balances'),
    retry: false,
  });
  const [form, setForm] = useState({
    leaveTypeId: '',
    startDate: '',
    endDate: '',
    days: '',
    reason: '',
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['payroll-leave-requests', org] });
    void queryClient.invalidateQueries({ queryKey: ['payroll-leave-balances', org] });
  };
  const request = useApiMutation((v: typeof form) => api.post('/payroll/leave/requests', v));
  const act = useApiMutation(
    (v: { id: string; verb: 'approve' | 'reject' | 'cancel'; version: number; note?: string }) =>
      api.post(`/payroll/leave/requests/${v.id}/${v.verb}`, {
        version: v.version,
        ...(v.note ? { note: v.note } : {}),
      }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    request.mutate(form, {
      onSuccess: () => {
        setForm({ leaveTypeId: '', startDate: '', endDate: '', days: '', reason: '' });
        refresh();
      },
    });
  };
  const decide = (r: LeaveRequest, verb: 'approve' | 'reject' | 'cancel') => {
    let note: string | undefined;
    if (verb === 'reject') {
      note =
        window.prompt(translate('payroll.leaveAdvancePages.reasonForRejectingThisRequest')) ?? '';
      if (!note.trim()) return;
    }
    act.mutate(
      { id: r.id, verb, version: r.version, ...(note ? { note } : {}) },
      { onSuccess: refresh },
    );
  };
  return (
    <>
      <PageHeader
        title={translate('payroll.leaveAdvancePages.leave')}
        description={translate('payroll.leaveAdvancePages.requestLeaveAndFollowYour')}
      />
      {balances.data && balances.data.balances.length > 0 ? (
        <Card title={translate('payroll.leaveAdvancePages.myBalanceThisYear')}>
          <table className="table">
            <thead>
              <tr>
                <th>{translate('payroll.leaveAdvancePages.leaveType')}</th>
                <th className="num">{translate('payroll.leaveAdvancePages.entitlement')}</th>
                <th className="num">{translate('payroll.leaveAdvancePages.taken')}</th>
                <th className="num">{translate('payroll.leaveAdvancePages.pending')}</th>
                <th className="num">{translate('payroll.leaveAdvancePages.remaining')}</th>
              </tr>
            </thead>
            <tbody>
              {balances.data.balances.map((b) => (
                <tr key={b.leaveTypeId}>
                  <td>{b.name}</td>
                  <td className="num">{b.entitlement}</td>
                  <td className="num">{b.taken}</td>
                  <td className="num">{b.pending}</td>
                  <td className="num">{b.remaining}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <Card title={translate('payroll.leaveAdvancePages.requestLeave')}>
        <form className="form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="lv-type">{translate('payroll.leaveAdvancePages.leaveType')}</label>
            <select
              id="lv-type"
              required
              value={form.leaveTypeId}
              onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}
            >
              <option value="">{translate('common.choose')}</option>
              {(types.data ?? [])
                .filter((t) => t.isActive)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </div>
          <TextField
            label={translate('payroll.leaveAdvancePages.from')}
            type="date"
            required
            value={form.startDate}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })}
          />
          <TextField
            label={translate('payroll.leaveAdvancePages.to')}
            type="date"
            required
            value={form.endDate}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
          />
          <TextField
            label={translate('payroll.leaveAdvancePages.days')}
            required
            inputMode="decimal"
            value={form.days}
            onChange={(e) => setForm({ ...form, days: e.target.value })}
          />
          <TextField
            label={translate('payroll.leaveAdvancePages.reason')}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
          <ErrorAlert error={request.error} />
          <Button type="submit" busy={request.isPending}>
            {translate('payroll.leaveAdvancePages.submitRequest')}
          </Button>
        </form>
      </Card>
      <Card
        title={
          manage
            ? translate('payroll.leaveAdvancePages.allRequests')
            : translate('payroll.leaveAdvancePages.myRequests')
        }
      >
        {requests.isPending ? <Spinner /> : null}
        <ErrorAlert error={requests.error ?? act.error} />
        {requests.data && requests.data.length === 0 ? (
          <p className="muted">{translate('payroll.leaveAdvancePages.noLeaveRequests')}</p>
        ) : null}
        {requests.data && requests.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{translate('payroll.leaveAdvancePages.employee')}</th>
                <th>{translate('payroll.leaveAdvancePages.type')}</th>
                <th>{translate('payroll.leaveAdvancePages.dates')}</th>
                <th className="num">{translate('payroll.leaveAdvancePages.days')}</th>
                <th>{translate('payroll.leaveAdvancePages.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {requests.data.map((r) => (
                <tr key={r.id}>
                  <td>{r.employeeName}</td>
                  <td>{r.leaveTypeName}</td>
                  <td>
                    {translate('payroll.leaveAdvancePages.to2', {
                      startDate: r.startDate,
                      endDate: r.endDate,
                    })}
                  </td>
                  <td className="num">{r.days}</td>
                  <td>
                    {r.status}
                    {r.decisionNote ? <small className="muted"> — {r.decisionNote}</small> : null}
                  </td>
                  <td>
                    {manage && r.status === 'PENDING' ? (
                      <>
                        <Button variant="secondary" onClick={() => decide(r, 'approve')}>
                          {translate('payroll.leaveAdvancePages.approve')}
                        </Button>{' '}
                        <Button variant="secondary" onClick={() => decide(r, 'reject')}>
                          {translate('payroll.leaveAdvancePages.reject')}
                        </Button>{' '}
                      </>
                    ) : null}
                    {r.status === 'PENDING' || r.status === 'APPROVED' ? (
                      <Button variant="secondary" onClick={() => decide(r, 'cancel')}>
                        {translate('common.cancel')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
      {manage ? <LeaveTypesCard types={types.data ?? []} org={org} /> : null}
    </>
  );
}

function LeaveTypesCard({ types, org }: { types: LeaveType[]; org: string }) {
  const translate = useT();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ code: '', name: '', daysPerYear: '', allowNegative: false });
  const create = useApiMutation((v: typeof form) => api.post('/payroll/leave/types', v));
  return (
    <Card title={translate('payroll.leaveAdvancePages.leaveTypes')}>
      <table className="table">
        <tbody>
          {types.map((t) => (
            <tr key={t.id}>
              <td>{t.code}</td>
              <td>{t.name}</td>
              <td className="num">
                {translate('payroll.leaveAdvancePages.daysAYear', { daysPerYear: t.daysPerYear })}
              </td>
              <td>{t.isActive ? '' : translate('payroll.leaveAdvancePages.inactive')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(form, {
            onSuccess: () => {
              setForm({ code: '', name: '', daysPerYear: '', allowNegative: false });
              void queryClient.invalidateQueries({ queryKey: ['payroll-leave-types', org] });
            },
          });
        }}
      >
        <TextField
          label={translate('payroll.leaveAdvancePages.code')}
          required
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
        />
        <TextField
          label={translate('payroll.leaveAdvancePages.name')}
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <TextField
          label={translate('payroll.leaveAdvancePages.daysPerYear')}
          required
          inputMode="decimal"
          value={form.daysPerYear}
          onChange={(e) => setForm({ ...form, daysPerYear: e.target.value })}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={form.allowNegative}
            onChange={(e) => setForm({ ...form, allowNegative: e.target.checked })}
          />{' '}
          {translate('payroll.leaveAdvancePages.allowApprovalBeyondTheBalance')}
        </label>
        <ErrorAlert error={create.error} />
        <Button type="submit" busy={create.isPending}>
          {translate('payroll.leaveAdvancePages.addLeaveType')}
        </Button>
      </form>
    </Card>
  );
}

interface Advance {
  id: string;
  number: string;
  employeeId: string;
  grantedDate: string;
  principal: string;
  installment: string;
  status: 'ACTIVE' | 'REPAID' | 'CANCELLED';
  repaid: string;
  outstanding: string;
  version: number;
}

export function AdvancesPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const accounts = useAccounts(true);
  const employees = useQuery({
    queryKey: ['payroll-employees', org],
    queryFn: () => api.get<EmployeeOption[]>('/payroll/employees'),
  });
  const advances = useQuery({
    queryKey: ['payroll-advances', org],
    queryFn: () => api.get<Advance[]>('/payroll/advances'),
  });
  const [form, setForm] = useState({
    employeeId: '',
    grantedDate: '',
    principal: '',
    installment: '',
    bankAccountId: '',
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['payroll-advances', org] });
  const grant = useApiMutation((v: typeof form) => api.post('/payroll/advances', v));
  const cancel = useApiMutation((v: { id: string; version: number; reason: string }) =>
    api.post(`/payroll/advances/${v.id}/cancel`, { version: v.version, reason: v.reason }),
  );
  const names = new Map((employees.data ?? []).map((e) => [e.id, e.displayName]));
  const banks = (accounts.data ?? []).filter((a) => a.status === 'ACTIVE' && a.isBankOrCash);
  return (
    <>
      <PageHeader
        title={t('payroll.leaveAdvancePages.salaryAdvances')}
        description={t('payroll.leaveAdvancePages.anAdvanceIsPaidOut')}
      />
      <Card title={t('payroll.leaveAdvancePages.grantAnAdvance')}>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            grant.mutate(form, {
              onSuccess: () => {
                setForm({
                  employeeId: '',
                  grantedDate: '',
                  principal: '',
                  installment: '',
                  bankAccountId: '',
                });
                refresh();
              },
            });
          }}
        >
          <div className="field">
            <label htmlFor="adv-emp">{t('payroll.leaveAdvancePages.employee')}</label>
            <select
              id="adv-emp"
              required
              value={form.employeeId}
              onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
            >
              <option value="">{t('common.choose')}</option>
              {(employees.data ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.displayName}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('payroll.leaveAdvancePages.dateGranted')}
            type="date"
            required
            value={form.grantedDate}
            onChange={(e) => setForm({ ...form, grantedDate: e.target.value })}
          />
          <TextField
            label={t('payroll.leaveAdvancePages.amount')}
            required
            inputMode="decimal"
            value={form.principal}
            onChange={(e) => setForm({ ...form, principal: e.target.value })}
          />
          <TextField
            label={t('payroll.leaveAdvancePages.monthlyInstalment')}
            required
            inputMode="decimal"
            value={form.installment}
            onChange={(e) => setForm({ ...form, installment: e.target.value })}
          />
          <div className="field">
            <label htmlFor="adv-bank">{t('payroll.leaveAdvancePages.paidFrom')}</label>
            <select
              id="adv-bank"
              required
              value={form.bankAccountId}
              onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}
            >
              <option value="">{t('common.choose')}</option>
              {banks.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
          </div>
          <ErrorAlert error={grant.error} />
          <Button type="submit" busy={grant.isPending}>
            {t('payroll.leaveAdvancePages.grantAdvance')}
          </Button>
        </form>
      </Card>
      <Card title={t('payroll.leaveAdvancePages.advances')}>
        {advances.isPending ? <Spinner /> : null}
        <ErrorAlert error={advances.error ?? cancel.error} />
        {advances.data && advances.data.length === 0 ? (
          <p className="muted">{t('payroll.leaveAdvancePages.noAdvancesYet')}</p>
        ) : null}
        {advances.data && advances.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('payroll.leaveAdvancePages.number')}</th>
                <th>{t('payroll.leaveAdvancePages.employee')}</th>
                <th>{t('payroll.leaveAdvancePages.date')}</th>
                <th className="num">{t('payroll.leaveAdvancePages.amount')}</th>
                <th className="num">{t('payroll.leaveAdvancePages.repaid')}</th>
                <th className="num">{t('payroll.leaveAdvancePages.outstanding')}</th>
                <th>{t('payroll.leaveAdvancePages.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {advances.data.map((a) => (
                <tr key={a.id}>
                  <td>{a.number}</td>
                  <td>{names.get(a.employeeId) ?? ''}</td>
                  <td>{a.grantedDate}</td>
                  <td className="num">{formatAmount(a.principal, 'MVR')}</td>
                  <td className="num">{formatAmount(a.repaid, 'MVR')}</td>
                  <td className="num">{formatAmount(a.outstanding, 'MVR')}</td>
                  <td>{a.status}</td>
                  <td>
                    {a.status === 'ACTIVE' && Number(a.repaid) === 0 ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          const reason =
                            window.prompt(
                              t('payroll.leaveAdvancePages.reasonForCancellingThisAdvance'),
                            ) ?? '';
                          if (reason.trim())
                            cancel.mutate(
                              { id: a.id, version: a.version, reason },
                              { onSuccess: refresh },
                            );
                        }}
                      >
                        {t('common.cancel')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </>
  );
}
