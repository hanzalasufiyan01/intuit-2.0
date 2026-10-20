import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Leave and salary advances pages (FP-25): the requests the pages send and who sees what. */

type Handler = () => { status: number; body?: unknown };
function stubApi(table: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v1/, '');
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = table[`${method} ${path}`]?.() ?? {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } },
      };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}
const ok = (data: unknown) => () => ({ status: 200, body: { data } });
function renderAt(path: string) {
  render(
    <App
      router={createMemoryRouter(routes, { initialEntries: [path] })}
      queryClient={createQueryClient()}
    />,
  );
}
const base = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /organizations/current/modules': ok({
    modules: { payroll: true, projects: false, clinic: false },
  }),
  'GET /payroll/leave/types': ok([
    {
      id: 't1',
      code: 'ANNUAL',
      name: 'Annual leave',
      daysPerYear: '10',
      allowNegative: false,
      isActive: true,
    },
  ]),
  'GET /payroll/leave/balances': ok({
    balances: [
      {
        leaveTypeId: 't1',
        name: 'Annual leave',
        entitlement: '10',
        taken: '2',
        pending: '1',
        remaining: '8',
      },
    ],
  }),
  'GET /payroll/leave/requests': ok([
    {
      id: 'q1',
      employeeName: 'Ahmed Ali',
      leaveTypeName: 'Annual leave',
      startDate: '2026-03-02',
      endDate: '2026-03-03',
      days: '2',
      reason: '',
      status: 'PENDING',
      decisionNote: null,
      version: 1,
    },
  ]),
});

describe('leave page', () => {
  it('shows the balance and lets an employee request leave without manager actions', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...base(['organization.read']),
      'POST /payroll/leave/requests': ok({ id: 'q2' }),
    });
    renderAt('/payroll/leave');
    expect(await screen.findByText('My balance this year')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    await user.selectOptions(await screen.findByLabelText('Leave type'), 't1');
    await user.type(screen.getByLabelText('From'), '2026-04-01');
    await user.type(screen.getByLabelText('To'), '2026-04-02');
    await user.type(screen.getByLabelText('Days'), '2');
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
        leaveTypeId: 't1',
        days: '2',
      }),
    );
  });

  it('offers approval to a manager', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...base(['organization.read', 'payroll.leave.manage']),
      'POST /payroll/leave/requests/q1/approve': ok({}),
    });
    renderAt('/payroll/leave');
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/q1/approve'))).toBe(true));
  });
});

describe('advances page', () => {
  it('is closed without the advances permission and lists advances with it', async () => {
    stubApi({ ...base(['organization.read']) });
    renderAt('/payroll/advances');
    await waitFor(() => expect(screen.queryByText('Grant an advance')).toBeNull());
    vi.unstubAllGlobals();
    stubApi({
      ...base(['organization.read', 'payroll.advances.manage', 'accounting.accounts.view']),
      'GET /payroll/employees': ok([{ id: 'e1', displayName: 'Ahmed Ali' }]),
      'GET /accounting/accounts': ok([]),
      'GET /payroll/advances': ok([
        {
          id: 'a1',
          number: 'ADV-00001',
          employeeId: 'e1',
          grantedDate: '2026-02-10',
          principal: '3000',
          installment: '1000',
          status: 'ACTIVE',
          repaid: '0',
          outstanding: '3000',
          version: 1,
        },
      ]),
    });
    renderAt('/payroll/advances');
    expect(await screen.findByText('ADV-00001')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});
