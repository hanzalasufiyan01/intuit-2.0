import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Delivery notes on a sales order and the stock reservations page (migration 0091). */

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

const order = {
  id: 'o1',
  number: 'SO-00001',
  status: 'CONFIRMED',
  version: 2,
  customerId: 'c1',
  customerName: 'Resort',
  orderDate: '2026-03-01',
  expectedDate: null,
  reference: null,
  memo: '',
  netTotal: '1250',
  cancelReason: null,
  lines: [
    {
      lineNo: 1,
      itemId: 'i1',
      description: 'Coconut oil',
      quantity: '10',
      invoiced: '0',
      remaining: '10',
      unitPrice: '100',
      netAmount: '1000',
      taxCodeId: null,
    },
  ],
};

describe('delivery panel on a sales order', () => {
  it('creates a delivery note for the quantities typed and offers deliver and void by status', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({
          permissions: ['sales_orders.view', 'sales_orders.create', 'sales_orders.invoice'],
        }),
      ),
      'GET /sales/orders/o1': ok(order),
      'GET /sales/orders/o1/fulfilment': ok({
        lines: [
          {
            lineNo: 1,
            description: 'Coconut oil',
            ordered: '10',
            delivered: '4',
            invoiced: '0',
            remaining: '6',
          },
        ],
      }),
      'GET /sales/delivery-notes': ok([
        {
          id: 'n1',
          number: 'DLV-00001',
          deliveryDate: '2026-03-02',
          status: 'DELIVERED',
          version: 2,
          voidReason: null,
        },
        {
          id: 'n2',
          number: 'DLV-00002',
          deliveryDate: '2026-03-03',
          status: 'DRAFT',
          version: 1,
          voidReason: null,
        },
      ]),
      'POST /sales/delivery-notes': () => ({ status: 201, body: { data: {} } }),
      'POST /sales/delivery-notes/n2/deliver': ok({}),
    });
    renderAt('/sales/orders/o1');
    await user.type(await screen.findByLabelText('Quantity to deliver, line 1'), '3');
    await user.click(screen.getByRole('button', { name: 'Create delivery note' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/sales/delivery-notes'))
          ?.body,
      ).toMatchObject({ orderId: 'o1', lines: [{ orderLineNo: 1, quantity: '3' }] }),
    );
    // A delivered note can be voided, a draft delivered or deleted.
    expect(screen.getByRole('button', { name: 'Void DLV-00001' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark DLV-00001 delivered' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Mark DLV-00002 delivered' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.pathname.endsWith('/n2/deliver'))).toBe(true),
    );
  });

  it('shows a viewer the fulfilment but no controls', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['sales_orders.view'] })),
      'GET /sales/orders/o1': ok(order),
      'GET /sales/orders/o1/fulfilment': ok({
        lines: [
          {
            lineNo: 1,
            description: 'Coconut oil',
            ordered: '10',
            delivered: '0',
            invoiced: '0',
            remaining: '10',
          },
        ],
      }),
      'GET /sales/delivery-notes': ok([]),
    });
    renderAt('/sales/orders/o1');
    expect(await screen.findByText('No delivery notes yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create delivery note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reserve stock for this order' })).toBeNull();
  });
});

describe('stock reservations page', () => {
  it('shows availability, lists active reservations and creates one', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['inventory.view', 'inventory.adjustments.create'] }),
      ),
      'GET /inventory/items': ok({ items: [{ itemId: 'i1', name: 'Coconut oil 1L' }] }),
      'GET /inventory/reservations': ok([
        {
          id: 'r1',
          itemId: 'i1',
          quantity: '5',
          source: 'manual',
          note: 'Walk-in',
          expiresOn: null,
          status: 'ACTIVE',
        },
      ]),
      'GET /inventory/items/i1/availability': ok({
        onHand: '20',
        reserved: '5',
        available: '15',
        note: '',
      }),
      'POST /inventory/reservations': () => ({ status: 201, body: { data: {} } }),
    });
    renderAt('/inventory/reservations');
    expect(await screen.findByText('Walk-in')).toBeTruthy();
    await screen.findAllByRole('option', { name: 'Coconut oil 1L' });
    await user.selectOptions(screen.getAllByLabelText('Item')[0]!, 'i1');
    expect(await screen.findByText('15')).toBeTruthy();
    await user.selectOptions(screen.getAllByLabelText('Item')[1]!, 'i1');
    await user.type(screen.getByLabelText('Quantity'), '2');
    await user.click(screen.getByRole('button', { name: 'Reserve' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/inventory/reservations'))
          ?.body,
      ).toEqual({ itemId: 'i1', quantity: '2' }),
    );
  });
});
