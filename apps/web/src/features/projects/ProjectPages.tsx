import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import type { Member } from '../../services/types';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { MappedStatusBadge, statusText, type StatusEntry } from '../../shared/ui/StatusBadge';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useT } from '../../i18n/i18n';

/**
 * Projects, time and billing (FP-26). The server enforces the workflow and computes every figure;
 * these pages guide. A project's revenue and cost are the ledger lines tagged with its PROJECT
 * dimension value, shown in the summary for people who may view accounting reports.
 */

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

interface ProjectRow {
  id: string;
  number: string;
  name: string;
  customerId: string | null;
  status: string;
  billingMethod: 'fixed' | 'time_and_materials' | 'non_billable';
  defaultBillRate: string;
  budgetHours: string | null;
  version: number;
}
interface ProjectDetail extends ProjectRow {
  description: string;
  startDate: string | null;
  endDate: string | null;
  budgetAmount: string | null;
  members: {
    userId: string;
    displayName: string | null;
    billRate: string | null;
    costRate: string;
  }[];
}
interface Summary {
  baseCurrency: string;
  projects: {
    id: string;
    number: string;
    name: string;
    hours: { draft: string; submitted: string; approved: string; billed: string; total: string };
    unbilledBillableAmount: string;
    billedAmount: string;
    timeCost: string;
    budgetHours: string | null;
    ledger: { revenue: string; cost: string; profit: string } | null;
  }[];
}
interface TaskRow {
  id: string;
  name: string;
  status: 'OPEN' | 'DONE';
  budgetHours: string | null;
  hours: string;
  overBudget: boolean;
  version: number;
}
interface TimeRow {
  id: string;
  projectId: string;
  taskId?: string | null;
  userId: string;
  displayName: string | null;
  workDate: string;
  hours: string;
  description: string;
  billable: boolean;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'BILLED';
  rejectReason: string | null;
  version: number;
}

const today = () => new Date().toISOString().slice(0, 10);

export function ProjectsSection() {
  const t = useT();
  return (
    <>
      <nav className="subnav" aria-label={t('projects.projectPages.projects')}>
        <NavLink to="/projects/time">{t('projects.projectPages.myTime')}</NavLink>
        <Can permission={Permission.ProjectsView}>
          <NavLink to="/projects" end>
            {t('projects.projectPages.projects')}
          </NavLink>
          <NavLink to="/projects/approvals">{t('projects.projectPages.timeApprovals')}</NavLink>
          <NavLink to="/projects/summary">{t('projects.projectPages.summary')}</NavLink>
        </Can>
      </nav>
      <Outlet />
    </>
  );
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function ProjectsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.ProjectsManage);
  const list = useQuery({
    queryKey: ['projects', org],
    queryFn: () => api.get<ProjectRow[]>('/projects'),
  });
  const members = useQuery({
    queryKey: ['members', org],
    enabled: canManage,
    queryFn: () => api.get<Member[]>('/organizations/current/members'),
  });
  const [form, setForm] = useState({
    name: '',
    billingMethod: 'time_and_materials',
    defaultBillRate: '0',
    customerId: '',
  });
  const [chosen, setChosen] = useState<Record<string, { billRate: string; costRate: string }>>({});
  const create = useApiMutation(() =>
    api.post('/projects', {
      name: form.name.trim(),
      billingMethod: form.billingMethod,
      defaultBillRate: form.defaultBillRate.trim() || '0',
      customerId: form.customerId.trim() || null,
      members: Object.entries(chosen).map(([userId, v]) => ({
        userId,
        billRate: v.billRate.trim() || null,
        costRate: v.costRate.trim() || '0',
      })),
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: () => {
        setForm({
          name: '',
          billingMethod: 'time_and_materials',
          defaultBillRate: '0',
          customerId: '',
        });
        setChosen({});
        void queryClient.invalidateQueries({ queryKey: ['projects', org] });
      },
    });
  };
  return (
    <>
      <PageHeader
        title={t('projects.projectPages.projects')}
        description={t('projects.projectPages.aProjectCollectsTimeRevenue')}
      />
      <Card title={t('projects.projectPages.projects')}>
        {list.isPending ? <Spinner /> : null}
        <ErrorAlert error={list.error} />
        {list.data ? (
          list.data.length === 0 ? (
            <p className="muted">{t('projects.projectPages.noProjectsYet')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('projects.projectPages.number')}</th>
                  <th>{t('projects.projectPages.name')}</th>
                  <th>{t('projects.projectPages.billing')}</th>
                  <th className="num">{t('projects.projectPages.defaultRate')}</th>
                  <th>{t('projects.projectPages.status')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/projects/${p.id}`}>{p.number}</Link>
                    </td>
                    <td>{p.name}</td>
                    <td>{p.billingMethod.replace(/_/g, ' ')}</td>
                    <td className="num">{formatAmount(p.defaultBillRate, 'MVR')}</td>
                    <td>
                      <ProjectStatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </Card>
      {canManage ? (
        <Card title={t('projects.projectPages.newProject')}>
          <form className="form" onSubmit={submit} noValidate>
            <TextField
              label={t('projects.projectPages.name')}
              value={form.name}
              required
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <TextField
              label={t('projects.projectPages.customerIdNeededToBill')}
              value={form.customerId}
              onChange={(e) => setForm({ ...form, customerId: e.target.value })}
            />
            <div className="field">
              <label htmlFor="prj-method">{t('projects.projectPages.billing')}</label>
              <select
                id="prj-method"
                value={form.billingMethod}
                onChange={(e) => setForm({ ...form, billingMethod: e.target.value })}
              >
                <option value="time_and_materials">
                  {t('projects.projectPages.timeAndMaterials')}
                </option>
                <option value="fixed">{t('projects.projectPages.fixedPrice')}</option>
                <option value="non_billable">{t('projects.projectPages.notBillable')}</option>
              </select>
            </div>
            <TextField
              label={t('projects.projectPages.defaultBillRatePerHour')}
              value={form.defaultBillRate}
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, defaultBillRate: e.target.value })}
            />
            <fieldset>
              <legend>{t('projects.projectPages.members')}</legend>
              {(members.data ?? [])
                .filter((m) => m.status === 'active')
                .map((m) => (
                  <div key={m.userId} className="filters">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={m.userId in chosen}
                        onChange={(e) => {
                          const next = { ...chosen };
                          if (e.target.checked) next[m.userId] = { billRate: '', costRate: '0' };
                          else delete next[m.userId];
                          setChosen(next);
                        }}
                      />{' '}
                      {m.displayName ?? m.email}
                    </label>
                    {m.userId in chosen ? (
                      <>
                        <TextField
                          label={t('projects.projectPages.billRate')}
                          value={chosen[m.userId]!.billRate}
                          inputMode="decimal"
                          onChange={(e) =>
                            setChosen({
                              ...chosen,
                              [m.userId]: { ...chosen[m.userId]!, billRate: e.target.value },
                            })
                          }
                        />
                        <TextField
                          label={t('projects.projectPages.costRate')}
                          value={chosen[m.userId]!.costRate}
                          inputMode="decimal"
                          onChange={(e) =>
                            setChosen({
                              ...chosen,
                              [m.userId]: { ...chosen[m.userId]!, costRate: e.target.value },
                            })
                          }
                        />
                      </>
                    ) : null}
                  </div>
                ))}
            </fieldset>
            <ErrorAlert error={create.error} />
            <Button type="submit" busy={create.isPending} disabled={!form.name.trim()}>
              {t('projects.projectPages.createProject')}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}

export function ProjectDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canBill = usePermission(Permission.ProjectsBill);
  const project = useQuery({
    queryKey: ['project', org, id],
    queryFn: () => api.get<ProjectDetail>(`/projects/${id}`),
  });
  const summary = useQuery({
    queryKey: ['project-summary', org, id],
    queryFn: () => api.get<Summary>(`/projects/summary?projectId=${id}`),
  });
  const [upTo, setUpTo] = useState(today());
  const [notice, setNotice] = useState<string | null>(null);
  const bill = useApiMutation(() =>
    api.post<{ invoiceId: string; entries: number; hours: string; amount: string }>(
      `/projects/${id}/bill`,
      { invoiceDate: today(), upTo },
    ),
  );
  const release = useApiMutation(() =>
    api.post<{ released: number }>(`/projects/${id}/release-time`, {}),
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['project-summary', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['project-time', org] });
  };
  const p = project.data;
  const s = summary.data?.projects[0];
  const money = (v: string) => formatAmount(v, summary.data?.baseCurrency ?? 'MVR');
  return (
    <>
      <PageHeader
        title={p ? `${p.number} ${p.name}` : t('projects.projectPages.project')}
        description={
          p
            ? `${p.billingMethod.replace(/_/g, ' ')} · ${statusText(t, PROJECT_STATUS, p.status)}`
            : undefined
        }
      />
      {project.isPending ? <Spinner /> : null}
      <ErrorAlert error={project.error} />
      {p ? (
        <Card title={t('projects.projectPages.members')}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('projects.projectPages.name')}</th>
                <th className="num">{t('projects.projectPages.billRate')}</th>
                <th className="num">{t('projects.projectPages.costRate')}</th>
              </tr>
            </thead>
            <tbody>
              {p.members.map((m) => (
                <tr key={m.userId}>
                  <td>{m.displayName ?? m.userId}</td>
                  <td className="num">{formatAmount(m.billRate ?? p.defaultBillRate, 'MVR')}</td>
                  <td className="num">{formatAmount(m.costRate, 'MVR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {s ? (
        <Card title={t('projects.projectPages.hoursAndMoney')}>
          <table className="table">
            <tbody>
              <tr>
                <td>{t('projects.projectPages.hoursDraftSubmittedApprovedBilled')}</td>
                <td className="num">
                  {s.hours.draft} / {s.hours.submitted} / {s.hours.approved} / {s.hours.billed}
                </td>
              </tr>
              <tr>
                <td>{t('projects.projectPages.approvedBillableNotYetBilled')}</td>
                <td className="num">{money(s.unbilledBillableAmount)}</td>
              </tr>
              <tr>
                <td>{t('projects.projectPages.billed')}</td>
                <td className="num">{money(s.billedAmount)}</td>
              </tr>
              <tr>
                <td>{t('projects.projectPages.costOfTime')}</td>
                <td className="num">{money(s.timeCost)}</td>
              </tr>
              {s.ledger ? (
                <>
                  <tr>
                    <td>{t('projects.projectPages.revenueOnTheBooks')}</td>
                    <td className="num">{money(s.ledger.revenue)}</td>
                  </tr>
                  <tr>
                    <td>{t('projects.projectPages.costOnTheBooks')}</td>
                    <td className="num">{money(s.ledger.cost)}</td>
                  </tr>
                  <tr>
                    <th>{t('projects.projectPages.profit')}</th>
                    <th className="num">{money(s.ledger.profit)}</th>
                  </tr>
                </>
              ) : null}
            </tbody>
          </table>
        </Card>
      ) : null}
      <TasksCard projectId={id} />
      {canBill ? (
        <Card title={t('projects.projectPages.billApprovedTime')}>
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              bill.mutate(undefined, {
                onSuccess: (r) => {
                  setNotice(
                    t('projects.projectPages.billedNotice', { hours: r.hours, amount: r.amount }),
                  );
                  refresh();
                },
              });
            }}
          >
            <TextField
              label={t('projects.projectPages.timeUpTo')}
              type="date"
              value={upTo}
              onChange={(e) => setUpTo(e.target.value)}
            />
            <Button type="submit" busy={bill.isPending}>
              {t('projects.projectPages.createDraftInvoice')}
            </Button>
            <Button
              variant="ghost"
              busy={release.isPending}
              onClick={() =>
                release.mutate(undefined, {
                  onSuccess: (r) => {
                    setNotice(t('projects.projectPages.releasedNotice', { count: r.released }));
                    refresh();
                  },
                })
              }
            >
              {t('projects.projectPages.releaseTimeOfDeletedInvoices')}
            </Button>
          </form>
          {notice ? <Alert>{notice}</Alert> : null}
          <ErrorAlert error={bill.error ?? release.error} />
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function MyTimePage() {
  const translate = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canLog = usePermission(Permission.ProjectsTimeLog);
  const projects = useQuery({
    queryKey: ['projects', org],
    enabled: usePermission(Permission.ProjectsView),
    queryFn: () => api.get<ProjectRow[]>('/projects'),
  });
  const time = useQuery({
    queryKey: ['project-time', org, 'mine'],
    queryFn: () => api.get<TimeRow[]>('/projects/time/entries'),
  });
  const [form, setForm] = useState({
    projectId: '',
    taskId: '',
    workDate: today(),
    hours: '',
    description: '',
  });
  const tasks = useQuery({
    queryKey: ['project-tasks', org, form.projectId],
    enabled: /^[0-9a-f-]{36}$/.test(form.projectId),
    queryFn: () => api.get<TaskRow[]>(`/projects/${form.projectId}/tasks`),
  });
  const log = useApiMutation(() =>
    api.post('/projects/time/entries', {
      projectId: form.projectId,
      ...(form.taskId ? { taskId: form.taskId } : {}),
      workDate: form.workDate,
      hours: form.hours,
      description: form.description,
    }),
  );
  const submit = useApiMutation((e: TimeRow) =>
    api.post(`/projects/time/entries/${e.id}/submit`, { version: e.version }),
  );
  const remove = useApiMutation((e: TimeRow) => api.delete(`/projects/time/entries/${e.id}`));
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['project-time', org] });
  return (
    <>
      <PageHeader
        title={translate('projects.projectPages.myTime')}
        description={translate('projects.projectPages.logYourHoursThenSubmit')}
      />
      {canLog ? (
        <Card title={translate('projects.projectPages.logTime')}>
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              log.mutate(undefined, {
                onSuccess: () => {
                  setForm({ ...form, hours: '', description: '' });
                  refresh();
                },
              });
            }}
          >
            <TextField
              label={translate('projects.projectPages.projectId')}
              value={form.projectId}
              list="my-projects"
              onChange={(e) => setForm({ ...form, projectId: e.target.value })}
            />
            <datalist id="my-projects">
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} {p.name}
                </option>
              ))}
            </datalist>
            <div className="field">
              <label htmlFor="time-task">{translate('projects.projectPages.taskOptional')}</label>
              <select
                id="time-task"
                value={form.taskId}
                onChange={(e) => setForm({ ...form, taskId: e.target.value })}
              >
                <option value="">{translate('projects.projectPages.noTask')}</option>
                {(tasks.data ?? [])
                  .filter((t) => t.status === 'OPEN')
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </div>
            <TextField
              label={translate('projects.projectPages.date')}
              type="date"
              value={form.workDate}
              onChange={(e) => setForm({ ...form, workDate: e.target.value })}
            />
            <TextField
              label={translate('projects.projectPages.hours')}
              value={form.hours}
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, hours: e.target.value })}
            />
            <TextField
              label={translate('projects.projectPages.whatWasDone')}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <Button
              type="submit"
              busy={log.isPending}
              disabled={!form.projectId || !form.hours || !form.description}
            >
              {translate('projects.projectPages.addEntry')}
            </Button>
          </form>
          <ErrorAlert error={log.error} />
        </Card>
      ) : null}
      <Card title={translate('projects.projectPages.entries')}>
        {time.isPending ? <Spinner /> : null}
        <ErrorAlert error={time.error} />
        {time.data ? (
          time.data.length === 0 ? (
            <p className="muted">{translate('projects.projectPages.noTimeLoggedYet')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{translate('projects.projectPages.date')}</th>
                  <th className="num">{translate('projects.projectPages.hours')}</th>
                  <th>{translate('projects.projectPages.description')}</th>
                  <th>{translate('projects.projectPages.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {time.data.map((e) => (
                  <tr key={e.id}>
                    <td>{e.workDate}</td>
                    <td className="num">{e.hours}</td>
                    <td>
                      {e.description}
                      {e.rejectReason ? (
                        <small className="muted">
                          {' '}
                          {translate('projects.projectPages.rejected', {
                            rejectReason: e.rejectReason,
                          })}
                        </small>
                      ) : null}
                    </td>
                    <td>
                      <TimeStatusBadge status={e.status} />
                    </td>
                    <td>
                      {['DRAFT', 'REJECTED'].includes(e.status) && canLog ? (
                        <>
                          <Button
                            variant="ghost"
                            onClick={() => submit.mutate(e, { onSuccess: refresh })}
                          >
                            {translate('projects.projectPages.submit')}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => remove.mutate(e, { onSuccess: refresh })}
                          >
                            {translate('common.delete')}
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
        <ErrorAlert error={submit.error ?? remove.error} />
      </Card>
    </>
  );
}

export function TimeApprovalsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canApprove = usePermission(Permission.ProjectsTimeApprove);
  const time = useQuery({
    queryKey: ['project-time', org, 'submitted'],
    queryFn: () => api.get<TimeRow[]>('/projects/time/entries?status=SUBMITTED'),
  });
  const approve = useApiMutation((e: TimeRow) =>
    api.post(`/projects/time/entries/${e.id}/approve`, { version: e.version }),
  );
  const reject = useApiMutation((e: TimeRow) => {
    const reason = window.prompt(t('projects.projectPages.whyIsThisTimeRejected'));
    if (!reason?.trim()) return Promise.resolve(null);
    return api.post(`/projects/time/entries/${e.id}/reject`, {
      version: e.version,
      reason: reason.trim(),
    });
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['project-time', org] });
  return (
    <>
      <PageHeader
        title={t('projects.projectPages.timeApprovals')}
        description={t('projects.projectPages.submittedTimeWaitingForA')}
      />
      <Card>
        {time.isPending ? <Spinner /> : null}
        <ErrorAlert error={time.error} />
        {time.data ? (
          time.data.length === 0 ? (
            <p className="muted">{t('projects.projectPages.nothingWaiting')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('projects.projectPages.person')}</th>
                  <th>{t('projects.projectPages.date')}</th>
                  <th className="num">{t('projects.projectPages.hours')}</th>
                  <th>{t('projects.projectPages.description')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {time.data.map((e) => (
                  <tr key={e.id}>
                    <td>{e.displayName ?? e.userId}</td>
                    <td>{e.workDate}</td>
                    <td className="num">{e.hours}</td>
                    <td>{e.description}</td>
                    <td>
                      {canApprove ? (
                        <>
                          <Button
                            variant="ghost"
                            onClick={() => approve.mutate(e, { onSuccess: refresh })}
                          >
                            {t('projects.projectPages.approve')}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => reject.mutate(e, { onSuccess: refresh })}
                          >
                            {t('projects.projectPages.reject')}
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
        <ErrorAlert error={approve.error ?? reject.error} />
      </Card>
    </>
  );
}

export function ProjectSummaryPage() {
  const t = useT();
  const org = useOrgKey();
  const summary = useQuery({
    queryKey: ['project-summary', org, 'all'],
    queryFn: () => api.get<Summary>('/projects/summary'),
  });
  const money = (v: string) => formatAmount(v, summary.data?.baseCurrency ?? 'MVR');
  return (
    <>
      <PageHeader
        title={t('projects.projectPages.projectSummary')}
        description={t('projects.projectPages.hoursBillingAndWhereYou')}
      />
      <Card>
        {summary.isPending ? <Spinner /> : null}
        <ErrorAlert error={summary.error} />
        {summary.data ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('projects.projectPages.project')}</th>
                <th className="num">{t('projects.projectPages.approvedH')}</th>
                <th className="num">{t('projects.projectPages.billedH')}</th>
                <th className="num">{t('projects.projectPages.unbilled')}</th>
                <th className="num">{t('projects.projectPages.timeCost')}</th>
                <th className="num">{t('projects.projectPages.revenue')}</th>
                <th className="num">{t('projects.projectPages.profit')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.data.projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/projects/${p.id}`}>
                      {p.number} {p.name}
                    </Link>
                  </td>
                  <td className="num">{p.hours.approved}</td>
                  <td className="num">{p.hours.billed}</td>
                  <td className="num">{money(p.unbilledBillableAmount)}</td>
                  <td className="num">{money(p.timeCost)}</td>
                  <td className="num">{p.ledger ? money(p.ledger.revenue) : '—'}</td>
                  <td className="num">{p.ledger ? money(p.ledger.profit) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </>
  );
}

/** Tasks of one project with their hour budgets; over-budget tasks are flagged (advisory). */
function TasksCard({ projectId }: { projectId: string }) {
  const translate = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.ProjectsManage);
  const tasks = useQuery({
    queryKey: ['project-tasks', org, projectId],
    queryFn: () => api.get<TaskRow[]>(`/projects/${projectId}/tasks`),
  });
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const add = useApiMutation(() =>
    api.post(`/projects/${projectId}/tasks`, {
      name: name.trim(),
      budgetHours: budget.trim() || null,
    }),
  );
  const toggle = useApiMutation((t: TaskRow) =>
    api.put(`/projects/tasks/${t.id}`, {
      version: t.version,
      name: t.name,
      status: t.status === 'OPEN' ? 'DONE' : 'OPEN',
      budgetHours: t.budgetHours,
    }),
  );
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['project-tasks', org, projectId] });
  return (
    <Card title={translate('projects.projectPages.tasks')}>
      {tasks.isPending ? <Spinner /> : null}
      <ErrorAlert error={tasks.error} />
      {tasks.data && tasks.data.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>{translate('projects.projectPages.task')}</th>
              <th className="num">{translate('projects.projectPages.hours')}</th>
              <th className="num">{translate('projects.projectPages.budget')}</th>
              <th>{translate('projects.projectPages.status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tasks.data.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="num">{t.hours}</td>
                <td className="num">{t.budgetHours ?? '—'}</td>
                <td>
                  <TaskStatusBadge status={t.status} />
                  {t.overBudget ? translate('projects.projectPages.overBudget') : ''}
                </td>
                <td>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      onClick={() => toggle.mutate(t, { onSuccess: refresh })}
                    >
                      {t.status === 'OPEN'
                        ? translate('projects.projectPages.markDone')
                        : translate('projects.projectPages.reopen')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canManage ? (
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined, {
              onSuccess: () => {
                setName('');
                setBudget('');
                refresh();
              },
            });
          }}
        >
          <TextField
            label={translate('projects.projectPages.taskName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label={translate('projects.projectPages.budgetHours')}
            value={budget}
            inputMode="decimal"
            onChange={(e) => setBudget(e.target.value)}
          />
          <Button type="submit" busy={add.isPending} disabled={!name.trim()}>
            {translate('projects.projectPages.addTask')}
          </Button>
        </form>
      ) : null}
      <ErrorAlert error={add.error ?? toggle.error} />
    </Card>
  );
}

/** Project statuses: active and completed are success, planned is info, on hold needs a look, cancelled is danger. */
const PROJECT_STATUS = {
  PLANNED: { key: 'projects.projectPages.projectStatus.PLANNED', tone: 'info' },
  ACTIVE: { key: 'projects.projectPages.projectStatus.ACTIVE', tone: 'success' },
  ON_HOLD: { key: 'projects.projectPages.projectStatus.ON_HOLD', tone: 'warning' },
  COMPLETED: { key: 'projects.projectPages.projectStatus.COMPLETED', tone: 'success' },
  CANCELLED: { key: 'projects.projectPages.projectStatus.CANCELLED', tone: 'danger' },
} satisfies Record<'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED', StatusEntry>;

export function ProjectStatusBadge({ status }: { status: string }) {
  return <MappedStatusBadge map={PROJECT_STATUS} status={status} />;
}

/** Task statuses: open is in progress (info), done is success. */
const TASK_STATUS = {
  OPEN: { key: 'projects.projectPages.taskStatus.OPEN', tone: 'info' },
  DONE: { key: 'projects.projectPages.taskStatus.DONE', tone: 'success' },
} satisfies Record<'OPEN' | 'DONE', StatusEntry>;

export function TaskStatusBadge({ status }: { status: string }) {
  return <MappedStatusBadge map={TASK_STATUS} status={status} />;
}

/** Time-entry statuses: submitted waits for approval (warning), approved and billed are success, rejected is danger. */
const TIME_STATUS = {
  DRAFT: { key: 'projects.projectPages.timeStatus.DRAFT', tone: 'neutral' },
  SUBMITTED: { key: 'projects.projectPages.timeStatus.SUBMITTED', tone: 'warning' },
  APPROVED: { key: 'projects.projectPages.timeStatus.APPROVED', tone: 'success' },
  REJECTED: { key: 'projects.projectPages.timeStatus.REJECTED', tone: 'danger' },
  BILLED: { key: 'projects.projectPages.timeStatus.BILLED', tone: 'success' },
} satisfies Record<'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'BILLED', StatusEntry>;

export function TimeStatusBadge({ status }: { status: string }) {
  return <MappedStatusBadge map={TIME_STATUS} status={status} />;
}
