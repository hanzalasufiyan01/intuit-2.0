import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Projects pages (FP-26): time logging, approvals, billing and what each permission shows. */

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

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

const ALL = [
  'organization.read',
  'projects.view',
  'projects.manage',
  'projects.time.log',
  'projects.time.approve',
  'projects.bill',
];

const session = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /organizations/current/modules': ok({
    modules: { payroll: false, projects: true, clinic: false },
  }),
});

const entry = (status: string, extra: object = {}) => ({
  id: 't1',
  projectId: 'p1',
  userId: 'u1',
  displayName: 'Aisha',
  workDate: '2026-03-10',
  hours: '4',
  description: 'On-site review',
  billable: true,
  status,
  rejectReason: null,
  version: 2,
  ...extra,
});

const project = {
  id: 'p1',
  number: 'PRJ-00001',
  name: 'Resort audit',
  description: '',
  customerId: 'c1',
  status: 'ACTIVE',
  billingMethod: 'time_and_materials',
  defaultBillRate: '100',
  budgetHours: null,
  budgetAmount: null,
  startDate: null,
  endDate: null,
  version: 1,
  members: [{ userId: 'u1', displayName: 'Aisha', billRate: '150', costRate: '60' }],
};

describe('my time', () => {
  it('logs time and submits a draft, and shows a rejection reason', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(['projects.time.log']),
      'GET /projects/time/entries': ok([
        entry('DRAFT'),
        entry('REJECTED', { id: 't2', rejectReason: 'Wrong day' }),
      ]),
      'POST /projects/time/entries': ok(entry('DRAFT')),
      'POST /projects/time/entries/t1/submit': ok(entry('SUBMITTED')),
    });
    renderAt('/projects/time');
    expect(await screen.findByText(/rejected: Wrong day/)).toBeTruthy();
    await user.type(screen.getByLabelText('Project id'), 'p1');
    await user.type(screen.getByLabelText('Hours'), '2');
    await user.type(screen.getByLabelText('What was done'), 'Workshop');
    await user.click(screen.getByRole('button', { name: 'Add entry' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/time/entries'))?.body,
      ).toMatchObject({ projectId: 'p1', hours: '2', description: 'Workshop' }),
    );
    const submits = screen.getAllByRole('button', { name: 'Submit' });
    await user.click(submits[0]!);
    await waitFor(() =>
      expect(calls.some((c) => c.url.pathname.endsWith('/t1/submit'))).toBe(true),
    );
  });
});

describe('time approvals', () => {
  it('approves submitted time with its version', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(ALL),
      'GET /projects/time/entries': ok([entry('SUBMITTED')]),
      'POST /projects/time/entries/t1/approve': ok(entry('APPROVED')),
    });
    renderAt('/projects/approvals');
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/approve'))?.body,
      ).toEqual({ version: 2 }),
    );
  });

  it('shows a viewer the queue without decision buttons', async () => {
    stubApi({
      ...session(['projects.view']),
      'GET /projects/time/entries': ok([entry('SUBMITTED')]),
    });
    renderAt('/projects/approvals');
    expect(await screen.findByText('On-site review')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

describe('project page', () => {
  it('shows hours and the ledger result, and bills approved time', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(ALL),
      'GET /projects/p1': ok(project),
      'GET /projects/summary': ok({
        baseCurrency: 'MVR',
        projects: [
          {
            id: 'p1',
            number: 'PRJ-00001',
            name: 'Resort audit',
            hours: {
              draft: '0.00',
              submitted: '1.00',
              approved: '10.00',
              billed: '9.00',
              total: '19.00',
            },
            unbilledBillableAmount: '300.00',
            billedAmount: '1200.00',
            timeCost: '520.00',
            budgetHours: null,
            ledger: { revenue: '1200.00', cost: '100.00', profit: '1100.00' },
          },
        ],
      }),
      'POST /projects/p1/bill': ok({
        invoiceId: 'i1',
        entries: 3,
        hours: '9.00',
        amount: '1200.00',
      }),
    });
    renderAt('/projects/p1');
    expect(await screen.findByText('Profit')).toBeTruthy();
    expect(screen.getByText('1,100.00')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create draft invoice' }));
    expect(await screen.findByText(/Draft invoice created: 9.00 hours/)).toBeTruthy();
    expect(calls.find((c) => c.url.pathname.endsWith('/bill'))?.body).toMatchObject({
      upTo: expect.any(String),
    });
  });

  it('hides billing from someone without projects.bill', async () => {
    stubApi({
      ...session(['projects.view']),
      'GET /projects/p1': ok(project),
      'GET /projects/summary': ok({ baseCurrency: 'MVR', projects: [] }),
    });
    renderAt('/projects/p1');
    expect(await screen.findByText('Aisha')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create draft invoice' })).toBeNull();
  });
});
