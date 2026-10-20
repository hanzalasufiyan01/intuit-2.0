import { render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Purchase suggestions (R-03): read-only; the server computes every quantity. */

type Handler = (url: URL, body: unknown) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const calls: { method: string; url: URL }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      calls.push({ method, url });
      const key = `${method} ${url.pathname.replace(/^\/api\/v1/, '')}`;
      const result = table[key]
        ? table[key](url, undefined)
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
  items: [
    {
      itemId: 'i1',
      sku: 'OIL-1',
      name: 'Coconut oil',
      baseUnit: 'bottle',
      onHand: '4',
      reserved: '1',
      onOrder: '3',
      available: '6',
      reorderPoint: '10',
      suggestedQuantity: '4',
    },
    {
      itemId: 'i2',
      sku: null,
      name: 'Palm sugar',
      baseUnit: 'kg',
      onHand: '0',
      reserved: '0',
      onOrder: '0',
      available: '0',
      reorderPoint: '8',
      suggestedQuantity: '8',
    },
  ],
  note: 'A suggestion only: nothing is ordered, received or posted.',
};

const session = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

const BUYER = ['inventory.view', 'purchase_orders.view', 'purchase_orders.create'];

describe('purchase suggestions page', () => {
  it('lists each item with its quantities and the suggested quantity in its base unit', async () => {
    stubApi({
      ...session(BUYER),
      'GET /inventory/reports/purchase-suggestions': ok(report),
    });
    renderAt('/inventory/purchase-suggestions');
    const row = (await screen.findByText('OIL-1 · Coconut oil')).closest('tr')!;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['OIL-1 · Coconut oil', '4', '1', '3', '6', '10', '4 bottle']);
    expect(screen.getByText('Palm sugar')).toBeTruthy();
    expect(
      screen.getByText('A suggestion only: nothing is ordered, received or posted.'),
    ).toBeTruthy();
  });

  it('only links to a new purchase order, and creates nothing itself', async () => {
    const calls = stubApi({
      ...session(BUYER),
      'GET /inventory/reports/purchase-suggestions': ok(report),
    });
    renderAt('/inventory/purchase-suggestions');
    const link = await screen.findByRole('link', { name: 'Create a purchase order' });
    expect(link.getAttribute('href')).toBe('/purchases/orders/new');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('hides the order link from someone who may not create purchase orders', async () => {
    stubApi({
      ...session(['inventory.view', 'purchase_orders.view']),
      'GET /inventory/reports/purchase-suggestions': ok(report),
    });
    renderAt('/inventory/purchase-suggestions');
    await screen.findByText('OIL-1 · Coconut oil');
    expect(screen.queryByRole('link', { name: 'Create a purchase order' })).toBeNull();
  });

  it('says so when no item is below its reorder point', async () => {
    stubApi({
      ...session(BUYER),
      'GET /inventory/reports/purchase-suggestions': ok({ ...report, items: [] }),
    });
    renderAt('/inventory/purchase-suggestions');
    expect(await screen.findByText('No item is below its reorder point.')).toBeTruthy();
  });

  it('explains the missing permission instead of asking the server', async () => {
    const calls = stubApi({ ...session(['inventory.view']) });
    renderAt('/inventory/purchase-suggestions');
    expect(await screen.findByText(/permission to view purchase orders/i)).toBeTruthy();
    await waitFor(() =>
      expect(calls.some((c) => c.url.pathname.endsWith('/auth/session'))).toBe(true),
    );
    expect(calls.some((c) => c.url.pathname.endsWith('/purchase-suggestions'))).toBe(false);
  });

  it('shows a server error instead of a table', async () => {
    stubApi({
      ...session(BUYER),
      'GET /inventory/reports/purchase-suggestions': () => ({
        status: 403,
        body: {
          error: {
            code: 'PERMISSION_DENIED',
            message: 'You do not have permission.',
            requestId: 'r',
          },
        },
      }),
    });
    renderAt('/inventory/purchase-suggestions');
    expect(await screen.findByText('You do not have permission.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
