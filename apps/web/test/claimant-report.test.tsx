import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Expense claims by claimant, and the payslip PDF link on My payslips. */

function stubApi(table: Record<string, () => { status: number; body?: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const key = `${init.method ?? 'GET'} ${url.pathname.replace(/^\/api\/v1/, '')}`;
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

describe('claims by claimant', () => {
  it('lists claimants with their totals', async () => {
    stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['organization.read', 'expense_claims.view'] }),
      ),
      'GET /expense-claims/reports/by-claimant': ok({
        baseCurrency: 'MVR',
        claimants: [
          {
            partyId: 'p1',
            displayName: 'Aishath Ali',
            claims: 2,
            pending: '0',
            approved: '100.5',
            posted: '0',
            total: '100.5',
          },
        ],
        totals: { claims: 2, total: '100.5' },
      }),
    });
    renderAt('/claims/by-claimant');
    expect(await screen.findByText('Aishath Ali')).toBeTruthy();
    expect(screen.getByText('Expense claims by claimant')).toBeTruthy();
  });
});

describe('my payslips', () => {
  it('offers the PDF of each payslip', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['organization.read'] })),
      'GET /organizations/current/modules': ok({
        modules: { payroll: true, projects: false, clinic: false },
      }),
      'GET /payroll/my-payslips': ok([
        {
          id: 's1',
          runNumber: 'PAY-00001',
          periodStart: '2026-03-01',
          periodEnd: '2026-03-31',
          payDate: '2026-03-31',
          runStatus: 'POSTED',
          gross: '8000',
          deductions: '0',
          net: '8000',
          lines: [{ kind: 'basic', code: 'BASIC', name: 'Basic salary', amount: '8000' }],
        },
      ]),
    });
    renderAt('/payroll/my-payslips');
    const link = await screen.findByRole('link', { name: 'Download PDF' });
    expect(link.getAttribute('href')).toBe('/api/v1/payroll/my-payslips/s1/pdf');
  });
});
