import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Expense trend (R-02): the expense accounts month by month; the server computes every figure. */

type Handler = (url: URL, body: unknown) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const calls: { method: string; url: URL }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url });
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

const report = {
  report: 'expense_trend',
  baseCurrency: 'MVR',
  from: '2026-01-01',
  to: '2026-03-31',
  months: [
    { label: '2026-01', from: '2026-01-01', to: '2026-01-31' },
    { label: '2026-02', from: '2026-02-01', to: '2026-02-28' },
    { label: '2026-03', from: '2026-03-01', to: '2026-03-31' },
  ],
  accounts: [
    {
      accountId: 'a1',
      code: '5300',
      name: 'Rent',
      section: 'operating_expenses',
      amounts: ['0.00', '30.00', '0.00'],
      total: '30.00',
    },
    {
      accountId: 'a2',
      code: '5400',
      name: 'Utilities',
      section: 'operating_expenses',
      amounts: ['100.00', '50.00', '15.00'],
      total: '165.00',
    },
  ],
  totals: ['100.00', '80.00', '15.00'],
  total: '195.00',
  note: 'Each month is the ordinary profit and loss for that month, expense sections only, from posted ledger activity.',
};

const base = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /accounting/setup': ok({ isSetUp: true, baseCurrency: 'MVR', templates: [] }),
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe('expense trend page', () => {
  it('shows each expense account per month with the totals from the server', async () => {
    const calls = stubApi({
      ...base(['accounting.reports.view']),
      'GET /accounting/reports/expense-trend': ok(report),
    });
    renderAt('/accounting/reports/expense-trend');
    expect(await screen.findByText('5400 Utilities')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '2026-02' })).toBeTruthy();
    const rent = screen.getByRole('row', { name: /5300 Rent/ });
    expect(
      within(rent)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['5300 Rent', '0.00', '30.00', '0.00', '30.00']);
    expect(screen.getByTestId('trend-total').textContent).toBe('195.00');
    expect(calls.find((c) => c.url.pathname.endsWith('/expense-trend'))?.url.search).toMatch(
      /^\?from=\d{4}-01-01&to=\d{4}-\d{2}-\d{2}$/,
    );
  });

  it('asks for the range typed in the form', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...base(['accounting.reports.view']),
      'GET /accounting/reports/expense-trend': ok(report),
    });
    renderAt('/accounting/reports/expense-trend');
    await screen.findByText('5400 Utilities');
    expect(screen.getByRole('search', { name: 'Filters' })).toBeTruthy();
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2025-07-01');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2025-09-30');
    await user.click(screen.getByRole('button', { name: 'Run report' }));
    await waitFor(() => {
      const last = calls.filter((c) => c.url.pathname.endsWith('/expense-trend')).at(-1);
      expect(last?.url.search).toBe('?from=2025-07-01&to=2025-09-30');
    });
  });

  it('says so when no expenses were posted', async () => {
    stubApi({
      ...base(['accounting.reports.view']),
      'GET /accounting/reports/expense-trend': ok({
        ...report,
        accounts: [],
        totals: ['0.00', '0.00', '0.00'],
        total: '0.00',
      }),
    });
    renderAt('/accounting/reports/expense-trend');
    expect(await screen.findByText('No expenses were posted in this period.')).toBeTruthy();
  });

  it('shows the server error instead of a table', async () => {
    stubApi({
      ...base(['accounting.reports.view']),
      'GET /accounting/reports/expense-trend': () => ({
        status: 409,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The end date must not be before the start.',
            requestId: 'r',
          },
        },
      }),
    });
    renderAt('/accounting/reports/expense-trend');
    expect(await screen.findByText('The end date must not be before the start.')).toBeTruthy();
    expect(screen.queryByTestId('trend-total')).toBeNull();
  });

  it('is not offered to someone without the reports permission', async () => {
    const calls = stubApi({ ...base(['customers.view']) });
    renderAt('/accounting/reports/expense-trend');
    await waitFor(() =>
      expect(calls.some((c) => c.url.pathname.endsWith('/auth/session'))).toBe(true),
    );
    expect(screen.queryByRole('columnheader', { name: '2026-01' })).toBeNull();
    expect(calls.some((c) => c.url.pathname.endsWith('/expense-trend'))).toBe(false);
  });
});

describe('expense trend export button', () => {
  it('exports exactly the range shown on the page', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const calls = stubApi({
      ...base(['accounting.reports.view']),
      'GET /accounting/reports/expense-trend': ok(report),
      'POST /exports': (_url, body) => {
        bodies.push(body);
        return {
          status: 202,
          body: {
            data: {
              export: { id: 'x1', status: 'queued', domain: 'expense_trend' },
              jobId: 'j1',
            },
          },
        };
      },
      'GET /exports/x1': ok({ id: 'x1', status: 'queued', domain: 'expense_trend' }),
    });
    renderAt('/accounting/reports/expense-trend');
    await screen.findByText('5400 Utilities');
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-03-31');
    await user.click(screen.getByRole('button', { name: 'Run report' }));
    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(bodies[0]).toEqual({
      domain: 'expense_trend',
      params: { from: '2026-01-01', to: '2026-03-31' },
      format: 'csv',
    });
  });
});
