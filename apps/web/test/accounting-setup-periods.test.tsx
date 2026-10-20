import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Accounting setup, fiscal years and periods. These pin the visible English of the three pages
 * (written before they moved to the message catalog, and kept as the regression guard after),
 * and the behaviour behind it: what is sent to the server and how its answers are shown.
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

const templates = [
  {
    key: 'maldives',
    name: 'Maldives',
    description: 'Starting chart for the Maldives',
    accountCount: 31,
  },
  { key: 'custom', name: 'Custom', description: 'Start empty', accountCount: 0 },
];
const notSetUp = { isSetUp: false, settings: null, templates };
const setUp = (locked: boolean) => ({
  isSetUp: true,
  settings: { baseCurrency: 'MVR', coaTemplateKey: 'maldives', baseCurrencyLocked: locked },
  templates,
});
const session = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
});

describe('accounting setup page', () => {
  it('offers the setup form with the currency, the templates and their account counts', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(['accounting.setup']),
      'GET /accounting/setup': ok(notSetUp),
      'POST /accounting/setup': () => ({ status: 200, body: { data: {} } }),
    });
    renderAt('/accounting/setup');
    expect(await screen.findByRole('heading', { name: 'Accounting setup' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Set up accounting' })).toBeTruthy();
    const currency = screen.getByLabelText('Base (functional) currency') as HTMLInputElement;
    expect(currency.value).toBe('MVR');
    expect(screen.getByText('3-letter ISO 4217 code')).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Chart of accounts template' });
    expect(group.textContent).toContain('Maldives — Starting chart for the Maldives (31 accounts)');
    expect(group.textContent).toContain('Custom — Start empty (0 accounts)');
    await user.click(screen.getByRole('radio', { name: /Custom/ }));
    await user.click(screen.getByRole('button', { name: 'Set up accounting' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/setup'));
      expect(post?.body).toEqual({ baseCurrency: 'MVR', templateKey: 'custom' });
    });
  });

  it('tells someone without the setup permission to ask an administrator', async () => {
    stubApi({ ...session(['accounting.accounts.view']), 'GET /accounting/setup': ok(notSetUp) });
    renderAt('/accounting/setup');
    expect(await screen.findByText('Ask an administrator to set up accounting.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up accounting' })).toBeNull();
  });

  it('shows the settings, the fixed base currency, and records an exchange rate', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(['accounting.setup']),
      'GET /accounting/setup': ok(setUp(true)),
      'GET /accounting/exchange-rates': ok([
        { id: 'r1', fromCurrency: 'USD', rateDate: '2026-03-01', rate: '15.42' },
      ]),
      'POST /accounting/exchange-rates': () => ({ status: 201, body: { data: {} } }),
    });
    renderAt('/accounting/setup');
    const settings = (await screen.findByRole('heading', { name: 'Settings' })).closest('section')!;
    expect(settings.textContent).toContain('Base currency: MVR (fixed: journals have been posted)');
    expect(settings.textContent).toContain('Chart of accounts template: maldives');
    expect(screen.getByRole('heading', { name: 'Exchange rates (1 unit = x MVR)' })).toBeTruthy();
    const row = (await screen.findByText('15.42')).closest('tr')!;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['2026-03-01', 'USD', '15.42']);
    await user.type(screen.getByLabelText('Date'), '2026-03-02');
    await user.type(screen.getByLabelText('Rate'), '15.5');
    await user.click(screen.getByRole('button', { name: 'Record rate' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toEqual({ fromCurrency: 'USD', rateDate: '2026-03-02', rate: '15.5' });
    });
  });

  it('says when no rates are recorded and the currency is not fixed yet', async () => {
    stubApi({
      ...session(['accounting.setup']),
      'GET /accounting/setup': ok(setUp(false)),
      'GET /accounting/exchange-rates': ok([]),
    });
    renderAt('/accounting/setup');
    expect(await screen.findByText('No rates recorded.')).toBeTruthy();
    const settings = screen.getByRole('heading', { name: 'Settings' }).closest('section')!;
    expect(settings.textContent).toContain('Base currency: MVR');
    expect(settings.textContent).not.toContain('fixed');
  });
});

const periods = [
  {
    id: 'p1',
    fiscalYearId: 'y1',
    number: 1,
    name: 'January 2026',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    status: 'CLOSED',
    reopenReason: null,
  },
  {
    id: 'p2',
    fiscalYearId: 'y1',
    number: 2,
    name: 'February 2026',
    startDate: '2026-02-01',
    endDate: '2026-02-28',
    status: 'OPEN',
    reopenReason: 'Late supplier invoice',
  },
];

describe('fiscal years page', () => {
  it('creates a year with monthly periods and summarizes each year', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(['accounting.periods.view', 'accounting.setup']),
      'GET /accounting/setup': ok(setUp(false)),
      'GET /accounting/fiscal-years': ok([
        { id: 'y1', name: 'FY2026', startDate: '2026-01-01', endDate: '2026-12-31', periods },
      ]),
      'POST /accounting/fiscal-years': () => ({ status: 201, body: { data: {} } }),
    });
    renderAt('/accounting/fiscal-years');
    expect(await screen.findByRole('heading', { name: 'Fiscal Years' })).toBeTruthy();
    expect(
      screen.getByText(
        'Each organization defines its own financial-year boundaries. Periods are monthly by default.',
      ),
    ).toBeTruthy();
    expect(await screen.findByText('2026-01-01 – 2026-12-31 · 2 periods (1 closed)')).toBeTruthy();
    await user.type(screen.getByLabelText('Name'), 'FY2027');
    await user.type(screen.getByLabelText('Start'), '2027-01-01');
    await user.type(screen.getByLabelText('End'), '2027-12-31');
    await user.click(screen.getByRole('button', { name: 'Create with monthly periods' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toEqual({
        name: 'FY2027',
        startDate: '2027-01-01',
        endDate: '2027-12-31',
      });
    });
  });

  it('says when there are no fiscal years, and hides the form without the setup permission', async () => {
    stubApi({
      ...session(['accounting.periods.view']),
      'GET /accounting/setup': ok(setUp(false)),
      'GET /accounting/fiscal-years': ok([]),
    });
    renderAt('/accounting/fiscal-years');
    expect(await screen.findByText('No fiscal years yet.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'New fiscal year' })).toBeNull();
  });
});

describe('accounting periods page', () => {
  it('lists periods with their status, the reopen reason, and the close and reopen actions', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session([
        'accounting.periods.view',
        'accounting.periods.close',
        'accounting.periods.reopen',
      ]),
      'GET /accounting/setup': ok(setUp(false)),
      'GET /accounting/periods': ok(periods),
      'POST /accounting/periods/p1/reopen': () => ({
        status: 200,
        body: { data: { status: 'PENDING_APPROVAL' } },
      }),
    });
    renderAt('/accounting/periods');
    expect(await screen.findByRole('heading', { name: 'Accounting Periods' })).toBeTruthy();
    expect(
      screen.getByText(
        'Closed periods accept no postings. Reopening needs a reason, password confirmation and any required approvals.',
      ),
    ).toBeTruthy();
    await screen.findByText('January 2026');
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Period',
      'Dates',
      'Status',
      '',
    ]);
    const january = screen.getByText('January 2026').closest('tr')!;
    expect(within(january).getByText('closed')).toBeTruthy();
    expect(within(january).getByText('2026-01-01 – 2026-01-31')).toBeTruthy();
    const february = screen.getByText('February 2026').closest('tr')!;
    expect(within(february).getByText('Reopened: Late supplier invoice')).toBeTruthy();
    expect(within(february).getByRole('button', { name: 'Close' })).toBeTruthy();
    await user.type(within(january).getByLabelText('Reason'), 'Audit adjustment');
    await user.click(within(january).getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText('Reopen request sent for approval.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ reason: 'Audit adjustment' });
  });
});
