import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useT } from '../../i18n/i18n';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';

/**
 * One-off amounts of a DRAFT pay run: bonus, commission, overtime pay (migration 0089, master
 * specification section 17). Payroll staff type the amount; the system applies no rate or
 * statutory rule. Adding or removing one recalculates the run.
 */

interface Adjustment {
  id: string;
  employeeNumber: string | null;
  employeeName: string | null;
  componentCode: string | null;
  componentName: string | null;
  kind: string | null;
  amount: string;
  note: string;
}
interface EmployeeOption {
  id: string;
  number: string;
  displayName: string;
  status: string;
}
interface ComponentOption {
  id: string;
  code: string;
  name: string;
  kind: string;
  calculation: string;
  isActive: boolean;
}

export function AdjustmentsCard({ runId, onChanged }: { runId: string; onChanged: () => void }) {
  const t = useT();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['payroll-adjustments', org, runId],
    queryFn: () => api.get<Adjustment[]>(`/payroll/runs/${runId}/adjustments`),
    refetchOnWindowFocus: false,
  });
  const employees = useQuery({
    queryKey: ['payroll-employees', org],
    queryFn: () => api.get<EmployeeOption[]>('/payroll/employees'),
  });
  const components = useQuery({
    queryKey: ['payroll-components', org],
    queryFn: () => api.get<ComponentOption[]>('/payroll/components'),
  });
  const blank = { employeeId: '', componentId: '', amount: '', note: '' };
  const [form, setForm] = useState(blank);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['payroll-adjustments', org, runId] });
    onChanged();
  };
  const add = useApiMutation(() =>
    api.post(`/payroll/runs/${runId}/adjustments`, {
      employeeId: form.employeeId,
      componentId: form.componentId,
      amount: form.amount.trim(),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    }),
  );
  const remove = useApiMutation((id: string) =>
    api.delete(`/payroll/runs/${runId}/adjustments/${id}`),
  );
  const usable = (components.data ?? []).filter(
    (c) =>
      c.isActive && c.calculation === 'fixed' && (c.kind === 'earning' || c.kind === 'deduction'),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate(undefined, {
      onSuccess: () => {
        setForm(blank);
        refresh();
      },
    });
  };
  return (
    <Card title={t('payroll.adjust.title')}>
      <p className="muted">{t('payroll.adjust.intro')}</p>
      {list.isPending ? <Spinner /> : null}
      <ErrorAlert error={list.error ?? remove.error} />
      {list.data && list.data.length === 0 ? (
        <p className="muted">{t('payroll.adjust.none')}</p>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>{t('payroll.adjust.employee')}</th>
              <th>{t('payroll.adjust.component')}</th>
              <th className="num">{t('payroll.adjust.amount')}</th>
              <th>{t('payroll.adjust.note')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.employeeNumber} {a.employeeName}
                </td>
                <td>
                  {a.componentCode} {a.componentName}
                  {a.kind === 'deduction' ? ` (${t('payroll.adjust.deduction')})` : ''}
                </td>
                <td className="num">{formatAmount(a.amount, 'MVR')}</td>
                <td>{a.note || '—'}</td>
                <td>
                  <Button
                    variant="ghost"
                    aria-label={t('payroll.adjust.removeFor', {
                      code: a.componentCode,
                      name: a.employeeName,
                    })}
                    busy={remove.isPending}
                    onClick={() => remove.mutate(a.id, { onSuccess: refresh })}
                  >
                    {t('common.remove')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="adj-employee">{t('payroll.adjust.employee')}</label>
          <select
            id="adj-employee"
            value={form.employeeId}
            onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
          >
            <option value="">{t('common.choose')}</option>
            {(employees.data ?? [])
              .filter((e) => e.status === 'active')
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.number} {e.displayName}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="adj-component">{t('payroll.adjust.payComponent')}</label>
          <select
            id="adj-component"
            value={form.componentId}
            onChange={(e) => setForm({ ...form, componentId: e.target.value })}
          >
            <option value="">{t('common.choose')}</option>
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} {c.name}
              </option>
            ))}
          </select>
          <small className="field__hint">{t('payroll.adjust.componentHint')}</small>
        </div>
        <TextField
          label={t('payroll.adjust.amount')}
          inputMode="decimal"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
        />
        <TextField
          label={t('payroll.adjust.noteLabel')}
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
        <ErrorAlert error={add.error} />
        <Button
          type="submit"
          busy={add.isPending}
          disabled={!form.employeeId || !form.componentId || !form.amount.trim()}
        >
          {t('payroll.adjust.add')}
        </Button>
      </form>
    </Card>
  );
}
