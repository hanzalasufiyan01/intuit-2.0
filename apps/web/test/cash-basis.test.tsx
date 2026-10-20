import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** The cash-basis profit and loss page (FP-22). */

function stubApi(table: Record<string, () => { status: number; body?: unknown }>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const key = `${init.method ?? 'GET'} ${url.pathname.replace(/^\/api\/v1/, '')}`;
      calls.push(key + url.search);
      const r = table[key]?.() ?? {
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

describe('cash-basis profit and loss page', () => {
  it('states the method and shows the net profit from the server', async () => {
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['organization.read', 'accounting.reports.view'] }),
      ),
      'GET /accounting/reports/profit-and-loss-cash-basis': ok({
        report: 'profit_and_loss_cash_basis',
        basis: 'cash',
        baseCurrency: 'MVR',
        method: 'Sales and purchase documents are recognised in proportion to what was settled.',
        columns: [
          {
            key: 'current',
            label: '2026-01-01 – 2026-03-31',
            from: '2026-01-01',
            to: '2026-03-31',
          },
        ],
        sections: [],
        summary: { grossProfit: ['400.00'], operatingProfit: ['400.00'], netProfit: ['400.00'] },
        integrity: { status: 'ok', checks: [] },
        warnings: [],
      }),
    });
    const router = createMemoryRouter(routes, {
      initialEntries: ['/accounting/reports/profit-and-loss-cash-basis'],
    });
    render(<App router={router} queryClient={createQueryClient()} />);
    expect(await screen.findByText(/recognised in proportion to what was settled/)).toBeTruthy();
    expect(await screen.findByText(/Net Profit/)).toBeTruthy();
    await waitFor(() =>
      expect(calls.some((c) => c.includes('profit-and-loss-cash-basis?from='))).toBe(true),
    );
  });

  it('is closed without the report permission', async () => {
    stubApi({ 'GET /auth/session': ok(makeSession({ permissions: ['organization.read'] })) });
    const router = createMemoryRouter(routes, {
      initialEntries: ['/accounting/reports/profit-and-loss-cash-basis'],
    });
    render(<App router={router} queryClient={createQueryClient()} />);
    await waitFor(() => expect(screen.queryByText('Profit & Loss (cash basis)')).toBeNull());
  });
});
