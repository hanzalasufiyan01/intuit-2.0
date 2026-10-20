import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Inventory pages. The server computes costs and balances and enforces the negative-stock policy;
 * the pages list tracked stock, show the ledger and the valuation, and offer changes only to
 * users who hold the permission.
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

const tracked = {
  itemId: 'i1',
  sku: 'OIL-1',
  name: 'Coconut oil 1L',
  inventoryAccountId: 'a1',
  cogsAccountId: 'a2',
  reorderPoint: '10',
  quantity: '6',
  averageCost: '12.0000',
  value: '72.0000',
  belowReorderPoint: true,
  version: 1,
};

const VIEW = ['inventory.view'];
const WORK = [
  ...VIEW,
  'inventory.items.manage',
  'inventory.adjustments.create',
  'inventory.adjustments.void',
];

const common = (
  permissions: string[],
  extra: Record<string, Handler> = {},
): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /inventory/items': ok({ items: [tracked] }),
  'GET /accounting/accounts': ok([]),
  'GET /sales/items': ok({ items: [], nextCursor: null }),
  ...extra,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe('stock page', () => {
  it('lists tracked items with quantity, average cost and value, and flags a reorder', async () => {
    stubApi(common(VIEW));
    renderAt('/inventory');
    expect(await screen.findByRole('link', { name: 'Coconut oil 1L' })).toBeTruthy();
    expect(screen.getByText('72.00')).toBeTruthy();
    expect(screen.getByText('Reorder')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Track in stock' })).toBeNull();
  });

  it('offers tracking only to users who may manage items', async () => {
    stubApi(common(WORK));
    renderAt('/inventory');
    expect(await screen.findByRole('button', { name: 'Track in stock' })).toBeTruthy();
  });
});

describe('stock ledger page', () => {
  it('shows each movement with the stock after it', async () => {
    stubApi(
      common(VIEW, {
        'GET /inventory/items/i1': ok(tracked),
        'GET /inventory/items/i1/movements': ok({
          items: [
            {
              id: 'm1',
              date: '2026-03-15',
              kind: 'sale',
              quantity: '-4',
              value: '-48.0000',
              quantityAfter: '6',
              valueAfter: '72.0000',
              sourceType: 'invoice',
              journalId: 'j1',
            },
          ],
          nextCursor: null,
        }),
      }),
    );
    renderAt('/inventory/items/i1');
    expect(await screen.findByText('Sold (invoice)')).toBeTruthy();
    expect(screen.getByText('-4')).toBeTruthy();
  });
});

describe('adjustments page', () => {
  it('posts an adjustment with an idempotency key and shows the reason', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(WORK, {
        'GET /inventory/adjustments': ok({ items: [] }),
        'POST /inventory/adjustments': ok({
          id: 'ad1',
          number: 'ADJ-00001',
          status: 'POSTED',
          lines: [],
        }),
      }),
    );
    renderAt('/inventory/adjustments');
    await user.type(await screen.findByLabelText('Reason'), 'Opening count');
    await user.selectOptions(screen.getByLabelText('Item'), 'i1');
    await user.type(screen.getByLabelText(/Quantity change/), '10');
    await user.type(screen.getByLabelText(/Unit cost/), '12');
    await user.click(screen.getByRole('button', { name: 'Post adjustment' }));
    await waitFor(() => {
      const call = calls.find(
        (c) => c.method === 'POST' && c.url.pathname.endsWith('/inventory/adjustments'),
      );
      expect(call?.body).toMatchObject({
        reason: 'Opening count',
        lines: [{ itemId: 'i1', quantityChange: '10', unitCost: '12' }],
      });
    });
  });

  it('hides the form from a viewer', async () => {
    stubApi(common(VIEW, { 'GET /inventory/adjustments': ok({ items: [] }) }));
    renderAt('/inventory/adjustments');
    expect(await screen.findByText('No adjustments yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post adjustment' })).toBeNull();
  });
});

describe('returns page', () => {
  it('posts a customer return against an issued credit note', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(WORK, {
        'GET /inventory/returns/returnable/c1': ok({
          creditNoteId: 'c1',
          number: 'CN-00001',
          items: [{ itemId: 'i1', credited: '3', returned: '0', remaining: '3' }],
        }),
        'GET /inventory/returns': ok({ items: [] }),
        'GET /sales/credit-notes': ok({
          items: [
            { id: 'c1', number: 'CN-00001', status: 'ISSUED' },
            { id: 'c2', number: 'CN-00002', status: 'DRAFT' },
          ],
        }),
        'POST /inventory/returns': ok({
          id: 'r1',
          number: 'RET-00001',
          status: 'POSTED',
          lines: [],
        }),
      }),
    );
    renderAt('/inventory/returns');
    await user.type(await screen.findByLabelText('Reason'), 'Customer sent it back');
    expect(screen.queryByRole('option', { name: 'CN-00002' })).toBeNull();
    await user.selectOptions(await screen.findByLabelText('Credit note'), 'c1');
    await user.selectOptions(await screen.findByLabelText('Item'), 'i1');
    await user.type(screen.getByLabelText('Quantity returned'), '2');
    await user.click(screen.getByRole('button', { name: 'Post return' }));
    await waitFor(() => {
      const call = calls.find(
        (c) => c.method === 'POST' && c.url.pathname.endsWith('/inventory/returns'),
      );
      expect(call?.body).toMatchObject({
        creditNoteId: 'c1',
        reason: 'Customer sent it back',
        lines: [{ itemId: 'i1', quantity: '2' }],
      });
    });
  });

  it('hides the form from a viewer', async () => {
    stubApi(common(VIEW, { 'GET /inventory/returns': ok({ items: [] }) }));
    renderAt('/inventory/returns');
    expect(await screen.findByText('No returns yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post return' })).toBeNull();
  });
});

describe('valuation page', () => {
  it('shows the stock value against the ledger and explains a difference', async () => {
    stubApi(
      common(VIEW, {
        'GET /inventory/valuation': ok({
          items: [tracked],
          totalValue: '72.0000',
          accounts: [
            { accountId: 'a1', stockValue: '72.0000', glBalance: '97.0000', difference: '25.0000' },
          ],
        }),
      }),
    );
    renderAt('/inventory/valuation');
    expect(await screen.findByText('Against the general ledger')).toBeTruthy();
    expect(screen.getByText('25.00')).toBeTruthy();
    expect(screen.getByText(/manual journal/)).toBeTruthy();
  });
});
