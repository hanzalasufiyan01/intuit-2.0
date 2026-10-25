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
import { MappedStatusBadge, type StatusEntry } from '../../shared/ui/StatusBadge';
import { Card, PageHeader } from '../../shared/ui/Card';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useCustomerOptions } from '../sales/shared';
import { ConsentCard } from './ClinicPrivacyPages';
import { useT } from '../../i18n/i18n';

/**
 * Clinic extension (FP-27, ADR 0013): appointments, patients, services and practitioners, and
 * reports. Administrative and billing data only: there is no field for clinical content. Opening a
 * patient record is audited by the server; national ids are only ever shown masked.
 */

export const CLINIC_PERMISSIONS = [
  Permission.ClinicPatientsView,
  Permission.ClinicAppointmentsManage,
  Permission.ClinicReportsView,
] as const;

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

interface PatientRow {
  id: string;
  number: string;
  displayName: string;
  dateOfBirth: string | null;
  sex: string | null;
  phone: string | null;
  email: string | null;
  nationalId: string | null;
  billingCustomerId: string | null;
  status: 'ACTIVE' | 'ANONYMIZED';
  version: number;
}
interface ServiceRow {
  id: string;
  name: string;
  price: string;
  durationMinutes: number;
  isActive: boolean;
  version: number;
}
interface PractitionerRow {
  id: string;
  displayName: string;
  specialty: string;
  isActive: boolean;
  version: number;
}
interface AppointmentRow {
  id: string;
  number: string;
  patientId: string;
  practitionerId: string;
  serviceId: string;
  startsAt: string;
  endsAt: string;
  status: 'BOOKED' | 'CHECKED_IN' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  price: string;
  invoiceId: string | null;
  version: number;
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function ClinicSection() {
  const t = useT();
  return (
    <>
      <nav className="subnav" aria-label={t('clinic.clinicPages.clinic')}>
        <Can permission={Permission.ClinicAppointmentsManage}>
          <NavLink to="/clinic" end>
            {t('clinic.clinicPages.appointments')}
          </NavLink>
          <NavLink to="/clinic/setup">{t('clinic.clinicPages.servicesAndPractitioners')}</NavLink>
        </Can>
        <Can permission={Permission.ClinicPatientsView}>
          <NavLink to="/clinic/patients">{t('clinic.clinicPages.patients')}</NavLink>
        </Can>
        <Can permission={Permission.ClinicPatientsManage}>
          <NavLink to="/clinic/privacy">{t('clinic.clinicPages.privacyAndRetention')}</NavLink>
        </Can>
        <Can permission={Permission.ClinicReportsView}>
          <NavLink to="/clinic/reports">{t('clinic.clinicPages.reports')}</NavLink>
        </Can>
      </nav>
      <Outlet />
    </>
  );
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export function AppointmentsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canBill = usePermission(Permission.ClinicBillingCreate);
  const canSeePatients = usePermission(Permission.ClinicPatientsView);
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const from = `${day}T00:00:00Z`;
  const to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const list = useQuery({
    queryKey: ['clinic-appointments', org, day],
    queryFn: () =>
      api.get<AppointmentRow[]>(
        `/clinic/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
  });
  const patients = useQuery({
    queryKey: ['clinic-patients', org, 'options'],
    enabled: canSeePatients,
    queryFn: () => api.get<PatientRow[]>('/clinic/patients?limit=200'),
  });
  const practitioners = useQuery({
    queryKey: ['clinic-practitioners', org],
    queryFn: () => api.get<PractitionerRow[]>('/clinic/practitioners'),
  });
  const services = useQuery({
    queryKey: ['clinic-services', org],
    queryFn: () => api.get<ServiceRow[]>('/clinic/services'),
  });
  const [form, setForm] = useState({
    patientId: '',
    practitionerId: '',
    serviceId: '',
    startsAt: `${day}T09:00`,
    note: '',
  });
  const book = useApiMutation(() =>
    api.post('/clinic/appointments', {
      patientId: form.patientId,
      practitionerId: form.practitionerId,
      serviceId: form.serviceId,
      startsAt: new Date(form.startsAt).toISOString(),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    }),
  );
  const act = useApiMutation((input: { a: AppointmentRow; action: string; body?: object }) =>
    api.post(`/clinic/appointments/${input.a.id}/${input.action}`, {
      version: input.a.version,
      ...input.body,
    }),
  );
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['clinic-appointments', org] });
  const patientName = (id: string) =>
    patients.data?.find((p) => p.id === id)?.displayName ?? id.slice(0, 8);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    book.mutate(undefined, { onSuccess: refresh });
  };
  return (
    <>
      <PageHeader
        title={t('clinic.clinicPages.appointments')}
        description={t('clinic.clinicPages.bookAndRunTheDay')}
      />
      <Card>
        <div className="filters">
          <TextField
            label={t('clinic.clinicPages.day')}
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </div>
        {list.isPending ? <Spinner /> : null}
        <ErrorAlert error={list.error} />
        {list.data ? (
          list.data.length === 0 ? (
            <p className="muted">{t('clinic.clinicPages.noAppointmentsOnThisDay')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('clinic.clinicPages.time')}</th>
                  <th>{t('clinic.clinicPages.patient')}</th>
                  <th>{t('clinic.clinicPages.practitioner')}</th>
                  <th>{t('clinic.clinicPages.service')}</th>
                  <th>{t('clinic.clinicPages.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {time(a.startsAt)}–{time(a.endsAt)}
                    </td>
                    <td>{canSeePatients ? patientName(a.patientId) : a.number}</td>
                    <td>
                      {practitioners.data?.find((p) => p.id === a.practitionerId)?.displayName ??
                        '—'}
                    </td>
                    <td>{services.data?.find((s) => s.id === a.serviceId)?.name ?? '—'}</td>
                    <td>
                      <AppointmentStatusBadge status={a.status} />
                    </td>
                    <td>
                      {a.status === 'BOOKED' ? (
                        <>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              act.mutate({ a, action: 'check-in' }, { onSuccess: refresh })
                            }
                          >
                            {t('clinic.clinicPages.checkIn')}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              act.mutate({ a, action: 'no-show' }, { onSuccess: refresh })
                            }
                          >
                            {t('clinic.clinicPages.noShow')}
                          </Button>
                        </>
                      ) : null}
                      {a.status === 'CHECKED_IN' ? (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            act.mutate({ a, action: 'complete' }, { onSuccess: refresh })
                          }
                        >
                          {t('clinic.clinicPages.complete')}
                        </Button>
                      ) : null}
                      {['BOOKED', 'CHECKED_IN'].includes(a.status) ? (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            const reason = window.prompt(
                              t('clinic.clinicPages.whyIsThisAppointmentCancelled'),
                            );
                            if (reason?.trim()) {
                              act.mutate(
                                { a, action: 'cancel', body: { reason: reason.trim() } },
                                { onSuccess: refresh },
                              );
                            }
                          }}
                        >
                          {t('common.cancel')}
                        </Button>
                      ) : null}
                      {a.status === 'COMPLETED' && !a.invoiceId && canBill ? (
                        <Button
                          variant="ghost"
                          onClick={() => act.mutate({ a, action: 'bill' }, { onSuccess: refresh })}
                        >
                          {t('clinic.clinicPages.createDraftInvoice')}
                        </Button>
                      ) : null}
                      {a.invoiceId ? (
                        <Link to={`/sales/invoices/${a.invoiceId}`}>
                          {t('clinic.clinicPages.invoice')}
                        </Link>
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
      <Card title={t('clinic.clinicPages.bookAnAppointment')}>
        <form className="form" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="apt-patient">{t('clinic.clinicPages.patient')}</label>
            <select
              id="apt-patient"
              value={form.patientId}
              onChange={(e) => setForm({ ...form, patientId: e.target.value })}
            >
              <option value="">{t('common.choose')}</option>
              {(patients.data ?? [])
                .filter((p) => p.status === 'ACTIVE')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.number} {p.displayName}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="apt-practitioner">{t('clinic.clinicPages.practitioner')}</label>
            <select
              id="apt-practitioner"
              value={form.practitionerId}
              onChange={(e) => setForm({ ...form, practitionerId: e.target.value })}
            >
              <option value="">{t('common.choose')}</option>
              {(practitioners.data ?? [])
                .filter((p) => p.isActive)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="apt-service">{t('clinic.clinicPages.service')}</label>
            <select
              id="apt-service"
              value={form.serviceId}
              onChange={(e) => setForm({ ...form, serviceId: e.target.value })}
            >
              <option value="">{t('common.choose')}</option>
              {(services.data ?? [])
                .filter((s) => s.isActive)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {t('clinic.clinicPages.min', {
                      name: s.name,
                      durationMinutes: s.durationMinutes,
                    })}
                  </option>
                ))}
            </select>
          </div>
          <TextField
            label={t('clinic.clinicPages.start')}
            type="datetime-local"
            value={form.startsAt}
            onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
          />
          <TextField
            label={t('clinic.clinicPages.administrativeNoteNoClinicalDetails')}
            value={form.note}
            maxLength={500}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <ErrorAlert error={book.error} />
          <Button
            type="submit"
            busy={book.isPending}
            disabled={!form.patientId || !form.practitionerId || !form.serviceId}
          >
            {t('clinic.clinicPages.book')}
          </Button>
        </form>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export function PatientsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canManage = usePermission(Permission.ClinicPatientsManage);
  const customers = useCustomerOptions(canManage);
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const list = useQuery({
    queryKey: ['clinic-patients', org, applied],
    queryFn: () =>
      api.get<PatientRow[]>(
        `/clinic/patients?limit=100${applied ? `&search=${encodeURIComponent(applied)}` : ''}`,
      ),
  });
  const [form, setForm] = useState({
    displayName: '',
    dateOfBirth: '',
    phone: '',
    email: '',
    nationalId: '',
    billingCustomerId: '',
  });
  const create = useApiMutation(() =>
    api.post<PatientRow>('/clinic/patients', {
      displayName: form.displayName.trim(),
      dateOfBirth: form.dateOfBirth || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      nationalId: form.nationalId.trim() || null,
      billingCustomerId: form.billingCustomerId || null,
    }),
  );
  return (
    <>
      <PageHeader
        title={t('clinic.clinicPages.patients')}
        description={t('clinic.clinicPages.administrativeRecordsOnlyOpeningA')}
      />
      <Card>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(search.trim());
          }}
        >
          <TextField
            label={t('clinic.clinicPages.searchByNameOrNumber')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button type="submit">{t('common.search')}</Button>
        </form>
        {list.isPending ? <Spinner /> : null}
        <ErrorAlert error={list.error} />
        {list.data ? (
          list.data.length === 0 ? (
            <p className="muted">{t('clinic.clinicPages.noPatientsFound')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('clinic.clinicPages.number')}</th>
                  <th>{t('clinic.clinicPages.name')}</th>
                  <th>{t('clinic.clinicPages.nationalId')}</th>
                  <th>{t('clinic.clinicPages.status')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/clinic/patients/${p.id}`}>{p.number}</Link>
                    </td>
                    <td>{p.displayName}</td>
                    <td>{p.nationalId ?? '—'}</td>
                    <td>
                      <PatientStatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </Card>
      {canManage ? (
        <Card title={t('clinic.clinicPages.newPatient')}>
          <form
            className="form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined, {
                onSuccess: (p) => {
                  void queryClient.invalidateQueries({ queryKey: ['clinic-patients', org] });
                  void navigate(`/clinic/patients/${p.id}`);
                },
              });
            }}
          >
            <TextField
              label={t('clinic.clinicPages.name')}
              value={form.displayName}
              required
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <TextField
              label={t('clinic.clinicPages.dateOfBirth')}
              type="date"
              value={form.dateOfBirth}
              onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
            />
            <TextField
              label={t('clinic.clinicPages.phone')}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
            <TextField
              label={t('clinic.clinicPages.email')}
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <TextField
              label={t('clinic.clinicPages.nationalId')}
              value={form.nationalId}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, nationalId: e.target.value })}
            />
            <div className="field">
              <label htmlFor="pat-customer">{t('clinic.clinicPages.billingCustomer')}</label>
              <select
                id="pat-customer"
                value={form.billingCustomerId}
                onChange={(e) => setForm({ ...form, billingCustomerId: e.target.value })}
              >
                <option value="">{t('clinic.clinicPages.chooseWhenBilling')}</option>
                {(customers.data?.items ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </div>
            <ErrorAlert error={create.error} />
            <Button type="submit" busy={create.isPending} disabled={!form.displayName.trim()}>
              {t('clinic.clinicPages.addPatient')}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}

export function PatientDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canManage = usePermission(Permission.ClinicPatientsManage);
  const patient = useQuery({
    queryKey: ['clinic-patient', org, id],
    queryFn: () => api.get<PatientRow>(`/clinic/patients/${id}`),
    // Each open is logged on the server, so do not refetch on focus.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const [confirmingAnonymize, setConfirmingAnonymize] = useState(false);
  const anonymize = useApiMutation((p: PatientRow) =>
    sensitive(() => api.post(`/clinic/patients/${p.id}/anonymize`, { version: p.version })),
  );
  const p = patient.data;
  return (
    <>
      <PageHeader title={p ? `${p.number} ${p.displayName}` : t('clinic.clinicPages.patient')} />
      {patient.isPending ? <Spinner /> : null}
      <ErrorAlert error={patient.error} />
      {p ? (
        <Card>
          <table className="table">
            <tbody>
              <tr>
                <td>{t('clinic.clinicPages.status')}</td>
                <td>
                  <PatientStatusBadge status={p.status} />
                </td>
              </tr>
              <tr>
                <td>{t('clinic.clinicPages.dateOfBirth')}</td>
                <td>{p.dateOfBirth ?? '—'}</td>
              </tr>
              <tr>
                <td>{t('clinic.clinicPages.phone')}</td>
                <td>{p.phone ?? '—'}</td>
              </tr>
              <tr>
                <td>{t('clinic.clinicPages.email')}</td>
                <td>{p.email ?? '—'}</td>
              </tr>
              <tr>
                <td>{t('clinic.clinicPages.nationalId')}</td>
                <td>{p.nationalId ?? '—'}</td>
              </tr>
            </tbody>
          </table>
          {canManage && p.status === 'ACTIVE' ? (
            <>
              {/* While the request runs (including a password prompt) the button ignores clicks but
                  stays focusable: a disabled opener could not take focus back when that prompt is
                  cancelled, so aria-disabled and a guard are used instead of the busy prop. */}
              <Button
                variant="ghost"
                aria-disabled={anonymize.isPending || undefined}
                onClick={() => {
                  if (!anonymize.isPending) setConfirmingAnonymize(true);
                }}
              >
                {t('clinic.clinicPages.anonymizePatient')}
              </Button>
              <ConfirmDialog
                open={confirmingAnonymize}
                title={t('confirm.anonymizePatient.title')}
                message={t('clinic.clinicPages.anonymizingRemovesThisPersonS')}
                confirmLabel={t('clinic.clinicPages.anonymizePatient')}
                destructive
                onCancel={() => setConfirmingAnonymize(false)}
                onConfirm={() => {
                  setConfirmingAnonymize(false);
                  anonymize.mutate(p, {
                    onSuccess: () =>
                      void queryClient.invalidateQueries({ queryKey: ['clinic-patient', org, id] }),
                  });
                }}
              />
            </>
          ) : null}
          <ErrorAlert error={anonymize.error} />
        </Card>
      ) : null}
      {p ? <ConsentCard patientId={p.id} active={p.status === 'ACTIVE'} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Services and practitioners
// ---------------------------------------------------------------------------

export function ClinicSetupPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.ClinicPatientsManage);
  const services = useQuery({
    queryKey: ['clinic-services', org],
    queryFn: () => api.get<ServiceRow[]>('/clinic/services'),
  });
  const practitioners = useQuery({
    queryKey: ['clinic-practitioners', org],
    queryFn: () => api.get<PractitionerRow[]>('/clinic/practitioners'),
  });
  const [svc, setSvc] = useState({ name: '', price: '', durationMinutes: '30' });
  const [prac, setPrac] = useState({ displayName: '', specialty: '' });
  const addService = useApiMutation(() =>
    api.post('/clinic/services', {
      name: svc.name.trim(),
      price: svc.price.trim() || '0',
      durationMinutes: Number(svc.durationMinutes),
    }),
  );
  const addPractitioner = useApiMutation(() =>
    api.post('/clinic/practitioners', {
      displayName: prac.displayName.trim(),
      ...(prac.specialty.trim() ? { specialty: prac.specialty.trim() } : {}),
    }),
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['clinic-services', org] });
    void queryClient.invalidateQueries({ queryKey: ['clinic-practitioners', org] });
  };
  return (
    <>
      <PageHeader title={t('clinic.clinicPages.servicesAndPractitioners')} />
      <Card title={t('clinic.clinicPages.services')}>
        {services.isPending ? <Spinner /> : null}
        <ErrorAlert error={services.error} />
        {services.data ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('clinic.clinicPages.name')}</th>
                <th className="num">{t('clinic.clinicPages.price')}</th>
                <th className="num">{t('clinic.clinicPages.minutes')}</th>
                <th>{t('clinic.clinicPages.active')}</th>
              </tr>
            </thead>
            <tbody>
              {services.data.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="num">{formatAmount(s.price, 'MVR')}</td>
                  <td className="num">{s.durationMinutes}</td>
                  <td>{s.isActive ? t('clinic.clinicPages.yes') : t('clinic.clinicPages.no')}</td>
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
              addService.mutate(undefined, {
                onSuccess: () => {
                  setSvc({ name: '', price: '', durationMinutes: '30' });
                  refresh();
                },
              });
            }}
          >
            <TextField
              label={t('clinic.clinicPages.serviceName')}
              value={svc.name}
              onChange={(e) => setSvc({ ...svc, name: e.target.value })}
            />
            <TextField
              label={t('clinic.clinicPages.price')}
              value={svc.price}
              inputMode="decimal"
              onChange={(e) => setSvc({ ...svc, price: e.target.value })}
            />
            <TextField
              label={t('clinic.clinicPages.minutes')}
              value={svc.durationMinutes}
              inputMode="numeric"
              onChange={(e) => setSvc({ ...svc, durationMinutes: e.target.value })}
            />
            <Button type="submit" busy={addService.isPending} disabled={!svc.name.trim()}>
              {t('clinic.clinicPages.addService')}
            </Button>
          </form>
        ) : null}
        <ErrorAlert error={addService.error} />
      </Card>
      <Card title={t('clinic.clinicPages.practitioners')}>
        {practitioners.data ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('clinic.clinicPages.name')}</th>
                <th>{t('clinic.clinicPages.specialty')}</th>
                <th>{t('clinic.clinicPages.active')}</th>
              </tr>
            </thead>
            <tbody>
              {practitioners.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.displayName}</td>
                  <td>{p.specialty || '—'}</td>
                  <td>{p.isActive ? t('clinic.clinicPages.yes') : t('clinic.clinicPages.no')}</td>
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
              addPractitioner.mutate(undefined, {
                onSuccess: () => {
                  setPrac({ displayName: '', specialty: '' });
                  refresh();
                },
              });
            }}
          >
            <TextField
              label={t('clinic.clinicPages.name')}
              value={prac.displayName}
              onChange={(e) => setPrac({ ...prac, displayName: e.target.value })}
            />
            <TextField
              label={t('clinic.clinicPages.specialty')}
              value={prac.specialty}
              onChange={(e) => setPrac({ ...prac, specialty: e.target.value })}
            />
            <Button
              type="submit"
              busy={addPractitioner.isPending}
              disabled={!prac.displayName.trim()}
            >
              {t('clinic.clinicPages.addPractitioner')}
            </Button>
          </form>
        ) : null}
        <ErrorAlert error={addPractitioner.error} />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

interface ClinicReport {
  totals: {
    booked: number;
    checkedIn: number;
    completed: number;
    cancelled: number;
    noShow: number;
    noShowRate: string | null;
  };
  byService: {
    serviceId: string;
    serviceName: string | null;
    completed: number;
    billed: number;
    value: string;
    billedValue: string;
  }[];
  unbilledCompleted: number;
}

export function ClinicReportsPage() {
  const t = useT();
  const org = useOrgKey();
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [applied, setApplied] = useState({ from, to });
  const report = useQuery({
    queryKey: ['clinic-report', org, applied],
    queryFn: () => api.get<ClinicReport>(`/clinic/reports?from=${applied.from}&to=${applied.to}`),
  });
  const r = report.data;
  return (
    <>
      <PageHeader
        title={t('clinic.clinicPages.clinicReports')}
        description={t('clinic.clinicPages.countsAndAmountsOnlyNo')}
      />
      <Card>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ from, to });
          }}
        >
          <TextField
            label={t('clinic.clinicPages.from')}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField
            label={t('clinic.clinicPages.to')}
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <Button type="submit">{t('clinic.clinicPages.runReport')}</Button>
        </form>
      </Card>
      {report.isPending ? <Spinner /> : null}
      <ErrorAlert error={report.error} />
      {r ? (
        <>
          <Card title={t('clinic.clinicPages.appointments')}>
            <table className="table">
              <tbody>
                <tr>
                  <td>{t('clinic.clinicPages.completed')}</td>
                  <td className="num">{r.totals.completed}</td>
                </tr>
                <tr>
                  <td>{t('clinic.clinicPages.cancelled')}</td>
                  <td className="num">{r.totals.cancelled}</td>
                </tr>
                <tr>
                  <td>{t('clinic.clinicPages.noShow')}</td>
                  <td className="num">{r.totals.noShow}</td>
                </tr>
                <tr>
                  <td>{t('clinic.clinicPages.noShowRate')}</td>
                  <td className="num">
                    {r.totals.noShowRate === null ? '—' : `${r.totals.noShowRate}%`}
                  </td>
                </tr>
                <tr>
                  <td>{t('clinic.clinicPages.completedButNotBilled')}</td>
                  <td className="num">{r.unbilledCompleted}</td>
                </tr>
              </tbody>
            </table>
            {r.unbilledCompleted > 0 ? (
              <Alert>
                {t('clinic.clinicPages.completedAppointmentsHaveNoInvoice', {
                  unbilledCompleted: r.unbilledCompleted,
                })}
              </Alert>
            ) : null}
          </Card>
          <Card title={t('clinic.clinicPages.byService')}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('clinic.clinicPages.service')}</th>
                  <th className="num">{t('clinic.clinicPages.completed')}</th>
                  <th className="num">{t('clinic.clinicPages.billed')}</th>
                  <th className="num">{t('clinic.clinicPages.value')}</th>
                  <th className="num">{t('clinic.clinicPages.billedValue')}</th>
                </tr>
              </thead>
              <tbody>
                {r.byService.map((s) => (
                  <tr key={s.serviceId}>
                    <td>{s.serviceName ?? '—'}</td>
                    <td className="num">{s.completed}</td>
                    <td className="num">{s.billed}</td>
                    <td className="num">{formatAmount(s.value, 'MVR')}</td>
                    <td className="num">{formatAmount(s.billedValue, 'MVR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      ) : null}
    </>
  );
}

/** Appointment statuses: booked is info, checked in is waiting (warning), completed is success, cancelled and no-show are danger. */
const APPOINTMENT_STATUS = {
  BOOKED: { key: 'clinic.clinicPages.appointmentStatus.BOOKED', tone: 'info' },
  CHECKED_IN: { key: 'clinic.clinicPages.appointmentStatus.CHECKED_IN', tone: 'warning' },
  COMPLETED: { key: 'clinic.clinicPages.appointmentStatus.COMPLETED', tone: 'success' },
  CANCELLED: { key: 'clinic.clinicPages.appointmentStatus.CANCELLED', tone: 'danger' },
  NO_SHOW: { key: 'clinic.clinicPages.appointmentStatus.NO_SHOW', tone: 'danger' },
} satisfies Record<'BOOKED' | 'CHECKED_IN' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW', StatusEntry>;

export function AppointmentStatusBadge({ status }: { status: string }) {
  return <MappedStatusBadge map={APPOINTMENT_STATUS} status={status} />;
}

/** Patient statuses: active is success, anonymized is neutral (out of use). */
const PATIENT_STATUS = {
  ACTIVE: { key: 'clinic.clinicPages.patientStatus.ACTIVE', tone: 'success' },
  ANONYMIZED: { key: 'clinic.clinicPages.patientStatus.ANONYMIZED', tone: 'neutral' },
} satisfies Record<'ACTIVE' | 'ANONYMIZED', StatusEntry>;

export function PatientStatusBadge({ status }: { status: string }) {
  return <MappedStatusBadge map={PATIENT_STATUS} status={status} />;
}
