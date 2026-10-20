import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Management reports (FP-22): sales trend, inventory reports and the tax liability summary. */

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

const session = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /accounting/accounts': ok([]),
});

describe('sales trend page', () => {
  it('shows net sales by period and passes the granularity', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(['sales.reports.view']),
      'GET /sales/reports/sales-trend': ok({
        baseCurrency: 'MVR',
        granularity: 'month',
        periods: [
          {
            periodStart: '2026-03-01',
            invoices: 2,
            creditNotes: 1,
            netSales: '180.00',
            tax: '0.00',
          },
        ],
        totals: { netSales: '180.00', tax: '0.00', total: '180.00' },
      }),
    });
    renderAt('/sales/trend');
    expect(await screen.findByText('2026-03-01')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Group by'), 'week');
    await user.click(screen.getByRole('button', { name: 'Run report' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.search.includes('granularity=week'))).toBe(true),
    );
  });
});

describe('inventory reports page', () => {
  it('shows low stock, then the slow-moving and profitability views', async () => {
    const user = userEvent.setup();
    stubApi({
      ...session(['inventory.view', 'sales.reports.view']),
      'GET /inventory/reports/low-stock': ok({
        items: [
          {
            itemId: 'i1',
            sku: null,
            name: 'Coconut oil 1L',
            quantity: '4',
            reorderPoint: '10',
            shortfall: '6',
          },
        ],
      }),
      'GET /inventory/reports/slow-moving': ok({
        asOf: '2026-03-31',
        baseCurrency: 'MVR',
        note: 'Activity age',
        items: [
          {
            itemId: 'i1',
            name: 'Coconut oil 1L',
            quantity: '18',
            value: '180.00',
            lastSale: '2026-02-15',
            lastReceipt: '2026-01-02',
            daysSinceLastSale: 44,
            bucket: 'days31to60',
          },
        ],
        totals: {},
      }),
      'GET /inventory/reports/cogs-profitability': ok({
        baseCurrency: 'MVR',
        note: 'Sales minus cost',
        items: [
          {
            itemId: 'i1',
            name: 'Coconut oil 1L',
            quantitySold: '3',
            netSales: '180.00',
            cogs: '30.00',
            grossMargin: '150.00',
            marginPercent: '83.33',
          },
        ],
        totals: {
          netSales: '180.00',
          cogs: '30.00',
          grossMargin: '150.00',
          marginPercent: '83.33',
        },
      }),
    });
    renderAt('/inventory/reports');
    expect(await screen.findByText('Shortfall')).toBeTruthy();
    expect(screen.getByText('Coconut oil 1L')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Slow-moving stock' }));
    expect(await screen.findByText('31–60 days')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'COGS and profitability' }));
    expect(await screen.findAllByText('83.33')).toBeTruthy();
  });
});

describe('tax liability page', () => {
  it('shows output tax, input tax and the net by code with the review-only note', async () => {
    stubApi({
      ...session(['sales.reports.view']),
      'GET /accounting/reports/tax-liability': ok({
        baseCurrency: 'MVR',
        note: 'Review summary only; not a tax return.',
        codes: [
          {
            taxCodeId: 't1',
            code: 'GST',
            rate: '8',
            outputTax: '9.60',
            recoverableInputTax: '8.00',
            netPayable: '1.60',
          },
        ],
        totals: { outputTax: '9.60', recoverableInputTax: '8.00', netPayable: '1.60' },
      }),
    });
    renderAt('/accounting/reports/tax-liability');
    expect(await screen.findByText(/Review summary only/)).toBeTruthy();
    expect(screen.getByText('GST')).toBeTruthy();
  });
});

describe('profit and loss by dimension', () => {
  it('lists each value, the unassigned remainder and the total for the chosen dimension', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(['accounting.reports.view', 'accounting.dimensions.view']),
      'GET /accounting/dimensions': ok([{ id: 't1', code: 'BRANCH', name: 'Branch' }]),
      'GET /accounting/reports/profit-and-loss-by-dimension': ok({
        dimensionType: { id: 't1', code: 'BRANCH', name: 'Branch' },
        baseCurrency: 'MVR',
        values: [
          {
            dimensionValueId: 'v1',
            code: 'NORTH',
            name: 'North',
            revenue: '150',
            costOfGoodsSold: '0',
            operatingExpenses: '0',
            grossProfit: '150',
            netProfit: '150',
          },
        ],
        unassigned: {
          revenue: '20',
          costOfGoodsSold: '0',
          operatingExpenses: '0',
          grossProfit: '20',
          netProfit: '20',
        },
        total: {
          revenue: '170',
          costOfGoodsSold: '0',
          operatingExpenses: '0',
          grossProfit: '170',
          netProfit: '170',
        },
        note: 'Each column is the ordinary profit and loss filtered on that value.',
      }),
    });
    renderAt('/accounting/reports/profit-and-loss-by-dimension');
    await screen.findByRole('option', { name: 'Branch' });
    await user.selectOptions(screen.getByLabelText('Dimension'), 't1');
    expect(await screen.findByText('NORTH North')).toBeTruthy();
    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(calls.some((c) => c.url.searchParams.get('dimensionTypeId') === 't1')).toBe(true);
  });

  it('is not available without the dimension permission', async () => {
    stubApi({ ...session(['accounting.reports.view']) });
    renderAt('/accounting/reports/profit-and-loss-by-dimension');
    await waitFor(() => expect(screen.queryByText('Profit & Loss by dimension')).toBeNull());
  });
});

describe('sales by dimension', () => {
  it('shows invoices, credit notes and net sales per value, with unassigned', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(['sales.reports.view', 'accounting.dimensions.view']),
      'GET /accounting/dimensions': ok([{ id: 't1', code: 'BRANCH', name: 'Branch' }]),
      'GET /sales/reports/sales-by-dimension': ok({
        dimensionType: { id: 't1', code: 'BRANCH', name: 'Branch' },
        baseCurrency: 'MVR',
        values: [
          {
            dimensionValueId: 'v1',
            code: 'NORTH',
            name: 'North',
            invoices: 2,
            creditNotes: 0,
            netSales: '110',
            tax: '8.8',
            total: '118.8',
          },
          {
            dimensionValueId: null,
            code: null,
            name: null,
            invoices: 1,
            creditNotes: 0,
            netSales: '40',
            tax: '0',
            total: '40',
          },
        ],
        totals: { netSales: '150', tax: '8.8' },
      }),
    });
    renderAt('/accounting/reports/sales-by-dimension');
    await screen.findByRole('option', { name: 'Branch' });
    await user.selectOptions(screen.getByLabelText('Dimension'), 't1');
    expect(await screen.findByText('NORTH North')).toBeTruthy();
    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(calls.some((c) => c.url.searchParams.get('dimensionTypeId') === 't1')).toBe(true);
  });
});
