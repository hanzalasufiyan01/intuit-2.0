import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Payroll pages and the module switch (FP-25): the run workflow actions follow the run status and
 * the user's permissions, the national id is never shown in full, and a disabled module is not
 * offered.
 */

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
  'organization.update',
  'payroll.view',
  'payroll.employees.manage',
  'payroll.settings.manage',
  'payroll.runs.create',
  'payroll.runs.approve',
  'payroll.runs.post',
  'payroll.runs.pay',
  'payroll.runs.void',
  'accounting.accounts.view',
];

const session = (permissions: string[], payroll = true) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /organizations/current/modules': ok({
    modules: { payroll, projects: false, clinic: false },
  }),
  'GET /accounting/accounts': ok([
    {
      id: 'b1',
      code: '1120',
      name: 'Bank',
      type: 'ASSET',
      status: 'ACTIVE',
      isLeaf: true,
      isBankOrCash: true,
      subtype: 'BANK',
    },
  ]),
});

const slip = {
  id: 's1',
  employeeId: 'e1',
  employeeNumber: 'EMP-00001',
  employeeName: 'Aisha Mohamed',
  gross: '10500',
  deductions: '700',
  net: '9800',
  employerCost: '700',
  lines: [
    { lineNo: 1, kind: 'basic', code: 'BASIC', name: 'Basic salary', amount: '10000' },
    { lineNo: 2, kind: 'deduction', code: 'PENS', name: 'Employee pension', amount: '700' },
  ],
};
const run = (status: string) => ({
  id: 'r1',
  number: 'PAY-00001',
  periodStart: '2026-03-01',
  periodEnd: '2026-03-31',
  payDate: '2026-04-02',
  status,
  employeeCount: 1,
  grossTotal: '10500',
  deductionsTotal: '700',
  netTotal: '9800',
  employerCostTotal: '700',
  journalId: status === 'DRAFT' || status === 'APPROVED' ? null : 'j1',
  paymentJournalId: null,
  voidReason: null,
  version: 3,
  payslips: [slip],
});

describe('module switch', () => {
  it('lists the modules and switches payroll on with the change recorded', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(ALL, false),
      'PUT /organizations/current/modules/payroll': ok({
        modules: { payroll: true, projects: false, clinic: false },
      }),
    });
    renderAt('/settings/modules');
    await user.click((await screen.findAllByRole('button', { name: 'Switch on' }))[0]!); // payroll is listed first
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'PUT' && c.url.pathname.endsWith('/modules/payroll'))?.body,
      ).toEqual({ enabled: true }),
    );
    expect(screen.queryAllByText('Not available yet (design only).')).toHaveLength(0);
  });

  it('offers the Payroll menu only when the module is on', async () => {
    stubApi({ ...session(ALL, false) });
    renderAt('/');
    await screen.findByText('Intuit 2.0');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Payroll' })).toBeNull());
    vi.unstubAllGlobals();
    stubApi({ ...session(ALL, true) });
    renderAt('/');
    expect(await screen.findByRole('link', { name: 'Payroll' })).toBeTruthy();
  });
});

describe('pay run page', () => {
  it('offers approve for a draft and posts with the run version', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(ALL),
      'GET /payroll/runs/r1': ok(run('DRAFT')),
      'POST /payroll/runs/r1/approve': ok(run('APPROVED')),
    });
    renderAt('/payroll/runs/r1');
    expect(await screen.findByText('Aisha Mohamed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post to ledger' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/approve'))?.body,
      ).toEqual({ version: 3 }),
    );
  });

  it('asks for a bank account to pay a posted run and hides actions the user may not take', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(ALL),
      'GET /payroll/runs/r1': ok(run('POSTED')),
      'POST /payroll/runs/r1/pay': ok(run('PAID')),
    });
    renderAt('/payroll/runs/r1');
    await user.selectOptions(await screen.findByLabelText('Pay from'), 'b1');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/pay'))?.body,
      ).toMatchObject({ bankAccountId: 'b1', version: 3 }),
    );
  });

  it('shows a viewer the payslips but no workflow buttons', async () => {
    stubApi({ ...session(['payroll.view']), 'GET /payroll/runs/r1': ok(run('DRAFT')) });
    renderAt('/payroll/runs/r1');
    expect(await screen.findByText('Aisha Mohamed')).toBeTruthy();
    for (const name of ['Approve', 'Recalculate', 'Void', 'Post to ledger']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });
});

describe('employees page', () => {
  it('shows the masked national id and never the full value', async () => {
    stubApi({
      ...session(ALL),
      'GET /payroll/employees': ok([
        {
          id: 'e1',
          number: 'EMP-00001',
          displayName: 'Aisha Mohamed',
          email: null,
          nationalId: '••••456',
          linked: false,
          hireDate: '2025-01-01',
          terminationDate: null,
          status: 'active',
          basicSalary: '10000',
          components: [],
          version: 1,
        },
      ]),
      'GET /payroll/components': ok([]),
    });
    renderAt('/payroll/employees');
    expect(await screen.findByText('••••456')).toBeTruthy();
    expect(document.body.textContent).not.toContain('A123456');
  });
});

describe('my payslips', () => {
  it('shows an employee their own payslip without any payroll permission', async () => {
    stubApi({
      ...session([]),
      'GET /payroll/my-payslips': ok([
        {
          id: 's1',
          runNumber: 'PAY-00001',
          periodStart: '2026-03-01',
          periodEnd: '2026-03-31',
          payDate: '2026-04-02',
          runStatus: 'PAID',
          gross: '8500',
          deductions: '560',
          net: '7940',
          lines: [{ kind: 'basic', code: 'BASIC', name: 'Basic salary', amount: '8000' }],
        },
      ]),
    });
    renderAt('/payroll/my-payslips');
    expect(await screen.findByText('Net pay')).toBeTruthy();
    expect(screen.getByText('2026-03-01 to 2026-03-31')).toBeTruthy();
  });
});

describe('salary history and payslip announcements', () => {
  const employee = {
    id: 'e1',
    number: 'EMP-00001',
    displayName: 'Aisha Mohamed',
    email: 'aisha@example.test',
    nationalId: '••••456',
    linked: true,
    hireDate: '2025-01-01',
    terminationDate: null,
    status: 'active',
    basicSalary: '10000',
    components: [],
    version: 1,
  };

  it('shows the dated salary history of an employee', async () => {
    const user = userEvent.setup();
    stubApi({
      ...session(ALL),
      'GET /payroll/employees': ok([employee]),
      'GET /payroll/components': ok([]),
      'GET /payroll/employees/e1/salary-history': ok([
        { id: 'h2', effectiveFrom: '2026-04-01', basicSalary: '11000', reason: 'Promotion' },
        { id: 'h1', effectiveFrom: '2025-01-01', basicSalary: '10000', reason: '' },
      ]),
    });
    renderAt('/payroll/employees');
    await user.click(
      await screen.findByRole('button', { name: 'Salary history for Aisha Mohamed' }),
    );
    expect(await screen.findByText('Promotion')).toBeTruthy();
    expect(screen.getByText('2026-04-01')).toBeTruthy();
  });

  it('sends the effective date and reason only when the salary changes', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(ALL),
      'GET /payroll/employees': ok([employee]),
      'GET /payroll/components': ok([]),
      'PUT /payroll/employees/e1': ok({ ...employee, basicSalary: '11000' }),
    });
    renderAt('/payroll/employees');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText('Salary takes effect from')).toBeNull();
    const salary = screen.getByLabelText(/Basic monthly salary/);
    await user.clear(salary);
    await user.type(salary, '11000');
    await user.type(screen.getByLabelText('Salary takes effect from'), '2026-04-01');
    await user.type(screen.getByLabelText('Reason for the change'), 'Promotion');
    await user.click(screen.getByRole('button', { name: 'Save employee' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
        basicSalary: '11000',
        salaryEffectiveFrom: '2026-04-01',
        salaryReason: 'Promotion',
        version: 1,
      }),
    );
  });

  it('announces payslips of a posted run and reports who was skipped', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(ALL),
      'GET /payroll/runs/r1': ok(run('POSTED')),
      'POST /payroll/runs/r1/announce-payslips': ok({
        sent: 1,
        alreadySent: 0,
        skipped: [{ employee: 'Omar', reason: 'no e-mail address' }],
        failed: 0,
      }),
    });
    renderAt('/payroll/runs/r1');
    await user.click(await screen.findByRole('button', { name: 'Announce payslips' }));
    expect(await screen.findByText(/Announced to 1/)).toBeTruthy();
    expect(screen.getByText(/Omar: no e-mail address/)).toBeTruthy();
    expect(calls.some((c) => c.url.pathname.endsWith('/announce-payslips'))).toBe(true);
  });

  it('does not offer the announcement for a draft run or without the pay permission', async () => {
    stubApi({ ...session(ALL), 'GET /payroll/runs/r1': ok(run('DRAFT')) });
    renderAt('/payroll/runs/r1');
    await screen.findByText('Aisha Mohamed');
    expect(screen.queryByRole('button', { name: 'Announce payslips' })).toBeNull();
  });
});

describe('payroll register', () => {
  it('shows employee and component totals for the range', async () => {
    stubApi({
      ...session(ALL),
      'GET /payroll/reports/register': ok({
        runs: [
          {
            id: 'r1',
            number: 'PAY-00001',
            periodStart: '2026-03-01',
            periodEnd: '2026-03-31',
            status: 'POSTED',
          },
        ],
        employees: [
          {
            employeeId: 'e1',
            employeeNumber: 'EMP-00001',
            employeeName: 'Aisha Mohamed',
            gross: '10500',
            deductions: '700',
            net: '9800',
            employerCost: '700',
          },
        ],
        components: [{ code: 'PENS', name: 'Employee pension', kind: 'deduction', amount: '700' }],
        totals: { gross: '10500', deductions: '700', net: '9800', employerCost: '700' },
      }),
    });
    renderAt('/payroll/register');
    expect(await screen.findByText('Aisha Mohamed')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Filters' }).querySelectorAll('input')).toHaveLength(
      2,
    );
    expect(screen.getByText('PENS Employee pension')).toBeTruthy();
    expect(screen.getByText('Total')).toBeTruthy();
  });

  it('says so when no pay run ends in the range', async () => {
    stubApi({
      ...session(ALL),
      'GET /payroll/reports/register': ok({
        runs: [],
        employees: [],
        components: [],
        totals: { gross: '0', deductions: '0', net: '0', employerCost: '0' },
      }),
    });
    renderAt('/payroll/register');
    expect(await screen.findByText(/No posted or paid pay run ends in this range/)).toBeTruthy();
  });
});

describe('one-off amounts on a draft run', () => {
  it('adds an amount for an employee and shows it, only on a draft run', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(ALL),
      'GET /payroll/runs/r1': ok(run('DRAFT')),
      'GET /payroll/runs/r1/adjustments': ok([]),
      'GET /payroll/employees': ok([
        {
          id: 'e1',
          number: 'EMP-00001',
          displayName: 'Aisha Mohamed',
          status: 'active',
        },
      ]),
      'GET /payroll/components': ok([
        {
          id: 'c1',
          code: 'BONUS',
          name: 'Bonus',
          kind: 'earning',
          calculation: 'fixed',
          isActive: true,
        },
        {
          id: 'c2',
          code: 'PENS',
          name: 'Employee pension',
          kind: 'deduction',
          calculation: 'percent_of_basic',
          isActive: true,
        },
      ]),
      'POST /payroll/runs/r1/adjustments': () => ({ status: 201, body: { data: run('DRAFT') } }),
    });
    renderAt('/payroll/runs/r1');
    await screen.findByRole('option', { name: /Aisha Mohamed/ });
    await screen.findByRole('option', { name: /BONUS/ });
    await user.selectOptions(screen.getByLabelText('Employee'), 'e1');
    // Only fixed-amount components are offered.
    expect(screen.queryByRole('option', { name: /PENS/ })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Pay component'), 'c1');
    await user.type(screen.getByLabelText('Amount'), '300');
    await user.click(screen.getByRole('button', { name: 'Add amount' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/adjustments'))?.body,
      ).toEqual({ employeeId: 'e1', componentId: 'c1', amount: '300' }),
    );
  });

  it('does not offer amounts on a posted run', async () => {
    stubApi({ ...session(ALL), 'GET /payroll/runs/r1': ok(run('POSTED')) });
    renderAt('/payroll/runs/r1');
    await screen.findByText('Aisha Mohamed');
    expect(screen.queryByText(/One-off amounts/)).toBeNull();
  });
});
