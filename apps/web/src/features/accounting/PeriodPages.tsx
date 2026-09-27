import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { AccountingPage, StatusBadge, useOrgKey } from './shared';
import type { FiscalYear, Period } from './types';

export function FiscalYearsPage() {
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const years = useQuery({
    queryKey: ['accounting-fiscal-years', org],
    queryFn: () => api.get<FiscalYear[]>('/accounting/fiscal-years'),
  });
  const [form, setForm] = useState({ name: '', startDate: '', endDate: '' });
  const create = useApiMutation((input: typeof form) =>
    api.post('/accounting/fiscal-years', input),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(form, {
      onSuccess: () => {
        setForm({ name: '', startDate: '', endDate: '' });
        void queryClient.invalidateQueries();
      },
    });
  };

  return (
    <>
      <PageHeader
        title="Fiscal Years"
        description="Each organization defines its own financial-year boundaries. Periods are monthly by default."
      />
      <AccountingPage>
        <Can permission={Permission.AccountingSetup}>
          <Card title="New fiscal year">
            <form className="form form--inline" onSubmit={submit} noValidate>
              <TextField
                label="Name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                error={create.error?.fieldError('name')}
              />
              <TextField
                label="Start"
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                error={create.error?.fieldError('startDate')}
              />
              <TextField
                label="End"
                type="date"
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                error={create.error?.fieldError('endDate')}
              />
              <Button type="submit" busy={create.isPending}>
                Create with monthly periods
              </Button>
            </form>
            <ErrorAlert error={create.error?.issues.length ? null : create.error} />
          </Card>
        </Can>
        {years.isPending ? (
          <Spinner label="Loading fiscal years" />
        ) : years.isError ? (
          <ErrorAlert error={years.error} />
        ) : years.data.length === 0 ? (
          <Alert tone="info">No fiscal years yet.</Alert>
        ) : (
          years.data.map((y) => (
            <Card key={y.id} title={y.name}>
              <p className="muted">
                {y.startDate} – {y.endDate} · {y.periods?.length ?? 0} periods (
                {y.periods?.filter((p) => p.status === 'CLOSED').length ?? 0} closed)
              </p>
            </Card>
          ))
        )}
      </AccountingPage>
    </>
  );
}

function PeriodRow({ period }: { period: Period }) {
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canClose = usePermission(Permission.PeriodsClose);
  const canReopen = usePermission(Permission.PeriodsReopen);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const close = useApiMutation(() =>
    sensitive(() => api.post(`/accounting/periods/${period.id}/close`)),
  );
  const reopen = useApiMutation(() =>
    sensitive(() =>
      api.post<{ status: string }>(`/accounting/periods/${period.id}/reopen`, { reason }),
    ),
  );
  const done = () => void queryClient.invalidateQueries();

  return (
    <tr>
      <td>{period.name}</td>
      <td>
        {period.startDate} – {period.endDate}
      </td>
      <td>
        <StatusBadge status={period.status} />
        {period.reopenReason ? <div className="muted">Reopened: {period.reopenReason}</div> : null}
      </td>
      <td className="actions">
        {period.status === 'OPEN' && canClose ? (
          <Button
            variant="secondary"
            busy={close.isPending}
            onClick={() => close.mutate(undefined, { onSuccess: done })}
          >
            Close
          </Button>
        ) : null}
        {period.status === 'CLOSED' && canReopen ? (
          <form
            className="form form--inline"
            onSubmit={(e) => {
              e.preventDefault();
              reopen.mutate(undefined, {
                onSuccess: (result) => {
                  setMessage(
                    result.status === 'PENDING_APPROVAL'
                      ? 'Reopen request sent for approval.'
                      : null,
                  );
                  done();
                },
              });
            }}
          >
            <TextField
              label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              error={reopen.error?.fieldError('reason')}
            />
            <Button type="submit" busy={reopen.isPending}>
              Reopen
            </Button>
          </form>
        ) : null}
        {message ? <Alert tone="info">{message}</Alert> : null}
        <ErrorAlert
          error={
            (close.error ?? reopen.error)?.issues.length ? null : (close.error ?? reopen.error)
          }
        />
      </td>
    </tr>
  );
}

export function PeriodsPage() {
  const org = useOrgKey();
  const periods = useQuery({
    queryKey: ['accounting-periods', org],
    queryFn: () => api.get<Period[]>('/accounting/periods'),
  });
  return (
    <>
      <PageHeader
        title="Accounting Periods"
        description="Closed periods accept no postings. Reopening needs a reason, password confirmation and any required approvals."
      />
      <AccountingPage>
        <Card>
          {periods.isPending ? (
            <Spinner label="Loading periods" />
          ) : periods.isError ? (
            <ErrorAlert error={periods.error} />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Dates</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {periods.data.map((p) => (
                  <PeriodRow key={p.id} period={p} />
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </AccountingPage>
    </>
  );
}
