import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';
import { expectConfirmFlow } from './confirm-flow';

/** Clinic pages (FP-27, ADR 0013): permissions shape what is shown; ids are masked; no clinical fields. */

type Handler = (url: URL, body: unknown) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const key = `${method} ${url.pathname.replace(/^\/api\/v1/, '')}`;
      const result = table[key]
        ? table[key](url, body)
        : {
            status: 404,
            body: { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } },
          };
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

const ok = (data: unknown) => () => ({ status: 200, body: { data } });

const fail = (status: number, code: string, message: string) => () => ({
  status,
  body: { error: { code, message, requestId: 'r' } },
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

const ALL = [
  'clinic.patients.view',
  'clinic.patients.manage',
  'clinic.appointments.manage',
  'clinic.billing.create',
  'clinic.reports.view',
  'customers.view',
];

const common = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /customers': ok({ items: [], nextCursor: null }),
  'GET /clinic/practitioners': ok([
    { id: 'pr1', displayName: 'Dr. Hassan', specialty: '', isActive: true, version: 1 },
  ]),
  'GET /clinic/services': ok([
    {
      id: 'sv1',
      name: 'General consultation',
      price: '300',
      durationMinutes: 30,
      isActive: true,
      version: 1,
    },
  ]),
});

const patient = {
  id: 'p1',
  number: 'PAT-00001',
  displayName: 'Aisha Mohamed',
  dateOfBirth: '1990-04-02',
  sex: 'female',
  phone: '7771234',
  email: null,
  nationalId: '••••567',
  billingCustomerId: null,
  status: 'ACTIVE',
  version: 2,
};
const appointment = (status: string, extra: object = {}) => ({
  id: 'a1',
  number: 'APT-00001',
  patientId: 'p1',
  practitionerId: 'pr1',
  serviceId: 'sv1',
  startsAt: '2026-03-10T09:00:00.000Z',
  endsAt: '2026-03-10T09:30:00.000Z',
  status,
  price: '300',
  invoiceId: null,
  version: 3,
  ...extra,
});

describe('appointments page', () => {
  it('offers the next step for each status and creates a draft invoice after completion', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /clinic/patients': ok([patient]),
      'GET /clinic/appointments': ok([appointment('COMPLETED')]),
      'POST /clinic/appointments/a1/bill': ok({
        appointment: appointment('COMPLETED'),
        invoiceId: 'i1',
      }),
    });
    renderAt('/clinic');
    expect(await screen.findByText('Aisha Mohamed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create draft invoice' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/bill'))?.body,
      ).toEqual({ version: 3 }),
    );
  });

  it('shows reception staff the appointment number instead of the patient name', async () => {
    stubApi({
      ...common(['clinic.appointments.manage']),
      'GET /clinic/appointments': ok([appointment('BOOKED')]),
    });
    renderAt('/clinic');
    expect(await screen.findByText('APT-00001')).toBeTruthy();
    expect(screen.queryByText('Aisha Mohamed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create draft invoice' })).toBeNull();
  });

  it('books with an ISO time and no clinical field on the form', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /clinic/patients': ok([patient]),
      'GET /clinic/appointments': ok([]),
      'POST /clinic/appointments': ok(appointment('BOOKED')),
    });
    renderAt('/clinic');
    await screen.findByRole('option', { name: /Aisha Mohamed/ });
    await user.selectOptions(await screen.findByLabelText('Patient'), 'p1');
    await user.selectOptions(screen.getByLabelText('Practitioner'), 'pr1');
    await user.selectOptions(screen.getByLabelText('Service'), 'sv1');
    expect(screen.getByLabelText(/Administrative note/)).toBeTruthy();
    expect(screen.queryByLabelText(/diagnosis|clinical notes|prescription/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => {
      const body = calls.find(
        (c) => c.method === 'POST' && c.url.pathname.endsWith('/clinic/appointments'),
      )?.body as { startsAt: string; patientId: string };
      expect(body.patientId).toBe('p1');
      expect(body.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    });
  });
});

describe('patients', () => {
  it('lists masked ids and hides creation from view-only users', async () => {
    stubApi({
      ...common(['clinic.patients.view']),
      'GET /clinic/patients': ok([patient]),
    });
    renderAt('/clinic/patients');
    expect(await screen.findByText('••••567')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add patient' })).toBeNull();
    expect(document.body.textContent).not.toContain('A1234567');
  });

  it('anonymizes only after confirmation in a dialog', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /clinic/patients/p1': ok(patient),
      'POST /clinic/patients/p1/anonymize': ok({ ...patient, status: 'ANONYMIZED' }),
    });
    renderAt('/clinic/patients/p1');
    await screen.findByRole('button', { name: 'Anonymize patient' });
    await expectConfirmFlow({
      user,
      trigger: () => screen.getByRole('button', { name: 'Anonymize patient' }),
      title: 'Anonymize this patient?',
      message: /Anonymizing removes this person’s name/,
      confirmName: 'Anonymize patient',
      requestSent: () => calls.some((c) => c.url.pathname.endsWith('/anonymize')),
    });
    expect(calls.find((c) => c.url.pathname.endsWith('/anonymize'))!.body).toEqual({
      version: patient.version,
    });
  });

  it('cancelling the anonymize dialog sends nothing and leaves the patient as it was', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /clinic/patients/p1': ok(patient),
      'POST /clinic/patients/p1/anonymize': ok({ ...patient, status: 'ANONYMIZED' }),
    });
    renderAt('/clinic/patients/p1');
    const trigger = await screen.findByRole('button', { name: 'Anonymize patient' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(screen.getByText('Active')).toBeTruthy(); // the patient is still active
    expect(screen.queryByText(/cancelled|anonymi[sz]ed/i)).toBeNull(); // no outcome message
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole('button', { name: 'Anonymize patient' })).toBeTruthy(); // can retry
  });

  it('confirming sends exactly one request, and a server error is shown with the dialog closed', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /clinic/patients/p1': ok(patient),
      'POST /clinic/patients/p1/anonymize': fail(
        409,
        'VERSION_CONFLICT',
        'Changed by someone else.',
      ),
    });
    renderAt('/clinic/patients/p1');
    await user.click(await screen.findByRole('button', { name: 'Anonymize patient' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Anonymize patient' }),
    );
    expect(await screen.findByText(/Changed by someone else/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Anonymize patient' })).toBeTruthy();
  });

  it('cancelling the password prompt that follows rejects the action and sends it only once', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /clinic/patients/p1': ok(patient),
      'POST /clinic/patients/p1/anonymize': fail(
        403,
        'REAUTHENTICATION_REQUIRED',
        'Please confirm your password to continue.',
      ),
    });
    renderAt('/clinic/patients/p1');
    const trigger = await screen.findByRole('button', { name: 'Anonymize patient' });
    await user.click(trigger);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Anonymize patient' }),
    );
    await screen.findByRole('dialog', { name: 'Confirm your password' });
    await user.keyboard('{Escape}'); // Escape here is the same as Cancel
    expect(await screen.findByText('Password confirmation cancelled.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1); // never retried
    expect(document.activeElement).toBe(trigger);
  });

  it('cannot be anonymized twice while the first request is still running', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = stubApi({
      ...common(ALL),
      'GET /clinic/patients/p1': ok(patient),
      'POST /clinic/patients/p1/anonymize': ok({ ...patient, status: 'ANONYMIZED' }),
    });
    // Hold the anonymize request open and count every attempt that reaches the network.
    const network = globalThis.fetch;
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (init.method === 'POST' && String(input).endsWith('/anonymize')) {
          attempts += 1;
          await gate;
        }
        return network(input, init);
      }),
    );
    renderAt('/clinic/patients/p1');
    const trigger = await screen.findByRole('button', { name: 'Anonymize patient' });
    await user.click(trigger);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Anonymize patient' }),
    );
    await waitFor(() => expect(attempts).toBe(1));
    expect(screen.queryByRole('dialog')).toBeNull();

    // While it runs the page's button reports itself unavailable and ignores clicks, so the dialog
    // cannot be opened and confirmed again. It stays focusable so focus can return to it.
    const waiting = screen.getByRole('button', { name: 'Anonymize patient' });
    expect(waiting.getAttribute('aria-disabled')).toBe('true');
    await user.click(waiting);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(attempts).toBe(1);

    release();
    await waitFor(() =>
      expect(calls.some((c) => c.url.pathname.endsWith('/anonymize'))).toBe(true),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Anonymize patient' }).getAttribute('aria-disabled'),
      ).toBeNull(),
    );
    expect(attempts).toBe(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('does not offer anonymize without clinic.patients.manage', async () => {
    stubApi({
      ...common(['clinic.patients.view']),
      'GET /clinic/patients/p1': ok(patient),
    });
    renderAt('/clinic/patients/p1');
    await screen.findByText(/Status/);
    expect(screen.queryByRole('button', { name: 'Anonymize patient' })).toBeNull();
  });
});

describe('reports', () => {
  it('shows counts, the no-show rate and unbilled work', async () => {
    stubApi({
      ...common(ALL),
      'GET /clinic/reports': ok({
        totals: {
          booked: 0,
          checkedIn: 0,
          completed: 2,
          cancelled: 0,
          noShow: 1,
          noShowRate: '33.3',
        },
        byService: [
          {
            serviceId: 'sv1',
            serviceName: 'General consultation',
            completed: 2,
            billed: 1,
            value: '600',
            billedValue: '300',
          },
        ],
        unbilledCompleted: 1,
      }),
    });
    renderAt('/clinic/reports');
    expect(await screen.findByText('33.3%')).toBeTruthy();
    expect(screen.getByText(/1 completed appointments have no invoice yet/)).toBeTruthy();
  });
});

describe('consent and retention', () => {
  it('records consent with the organization wording and offers a withdrawal', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /clinic/patients/p1': ok(patient),
      'GET /clinic/patients/p1/consents': ok({
        current: [
          {
            purpose: 'Reminders',
            status: 'granted',
            effectiveDate: '2026-03-01',
            wording: 'Version 1',
          },
        ],
        history: [],
      }),
      'POST /clinic/patients/p1/consents': () => ({
        status: 201,
        body: { data: { current: [], history: [] } },
      }),
    });
    renderAt('/clinic/patients/p1');
    expect(await screen.findByText('Reminders')).toBeTruthy();
    const record = screen.getByRole('button', { name: 'Record consent' }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    await user.type(screen.getByLabelText('Purpose'), 'Data sharing');
    await user.type(screen.getByLabelText(/Consent wording/), 'Our own wording');
    await user.click(record);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/consents'))?.body,
      ).toEqual({ purpose: 'Data sharing', wording: 'Our own wording', action: 'granted' }),
    );
    await user.click(screen.getByRole('button', { name: 'Withdraw consent for Reminders' }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/consents')).at(-1)
          ?.body,
      ).toEqual({ purpose: 'Reminders', action: 'withdrawn' }),
    );
  });

  it('shows a view-only user the consent status but no way to change it', async () => {
    stubApi({
      ...common(['clinic.patients.view']),
      'GET /clinic/patients/p1': ok(patient),
      'GET /clinic/patients/p1/consents': ok({ current: [], history: [] }),
    });
    renderAt('/clinic/patients/p1');
    expect(await screen.findByText('No consent is on file.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record consent' })).toBeNull();
  });

  it('saves the retention period the organization enters and lists patients past it', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /clinic/settings': ok({ retentionYears: null, version: 0 }),
      'GET /clinic/retention-review': ok({ retentionYears: null, cutoff: null, items: [] }),
      'PUT /clinic/settings': ok({ retentionYears: 7, version: 1 }),
    });
    renderAt('/clinic/privacy');
    expect(await screen.findByText(/No retention period is set/)).toBeTruthy();
    await user.type(screen.getByLabelText('Keep patient records for (years)'), '7');
    await user.click(screen.getByRole('button', { name: 'Save retention period' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        retentionYears: 7,
        version: 0,
      }),
    );
  });
});
