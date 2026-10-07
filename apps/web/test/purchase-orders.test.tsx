import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Purchase order pages. The server computes totals, numbers the order and runs approval and the
 * three-way match; the pages list orders, show what is received and billed, and offer each action
 * only to users who hold its permission.
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

const summary = {
  id: 'o1',
  status: 'APPROVED',
  number: 'PO-00001',
  vendorId: 'v1',
  vendorName: 'Island Wholesale',
  orderDate: '2026-03-10',
  expectedDate: '2026-03-20',
  currencyCode: 'MVR',
  total: '700.00',
  version: 2,
};

const detail = {
  ...summary,
  memo: '',
  closeReason: null,
  cancelReason: null,
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      itemId: 'i1',
      description: 'Coconut oil',
      quantity: '10',
      unitPrice: '20',
      total: '200.00',
      receivedQuantity: '4',
      billedQuantity: '0',
      remainingToReceive: '6',
      remainingToBill: '10',
    },
  ],
  bills: [],
  receipts: [],
  approval: null,
};

const VIEW = ['purchase_orders.view'];
const WORK = [
  ...VIEW,
  'purchase_orders.create',
  'purchase_orders.receive',
  'purchase_orders.close',
  'bills.create',
];

const common = (
  permissions: string[],
  extra: Record<string, Handler> = {},
): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /purchases/orders': ok({ items: [summary], nextCursor: null }),
  'GET /purchases/orders/o1': ok(detail),
  ...extra,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe('purchase order list', () => {
  it('lists orders, and offers New only to those who may create', async () => {
    stubApi(common(VIEW));
    renderAt('/purchases/orders');
    expect(await screen.findByRole('link', { name: 'PO-00001' })).toBeTruthy();
    expect(screen.getByText('Island Wholesale')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New purchase order' })).toBeNull();
  });

  it('shows the New link to a creator', async () => {
    stubApi(common(WORK));
    renderAt('/purchases/orders');
    expect(await screen.findByRole('link', { name: 'New purchase order' })).toBeTruthy();
  });
});

describe('purchase order detail', () => {
  it('shows ordered, received and billed quantities and lets a receiver record goods', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(WORK, {
        'POST /purchases/orders/o1/receipts': ok(detail),
      }),
    );
    renderAt('/purchases/orders/o1');
    expect(await screen.findByText('Coconut oil')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create bill from what was received' })).toBeTruthy();
    await user.type(screen.getByLabelText('Receive, line 1'), '3');
    await user.click(screen.getByRole('button', { name: 'Record goods received' }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/receipts'));
      expect(call?.body).toMatchObject({ lines: [{ orderLineId: 'l1', quantity: '3' }] });
    });
  });

  it('hides receiving, billing and closing from a viewer', async () => {
    stubApi(common(VIEW));
    renderAt('/purchases/orders/o1');
    expect(await screen.findByText('Coconut oil')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record goods received' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close order' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create bill from what was received' })).toBeNull();
  });

  it('shows a draft order with Submit', async () => {
    stubApi(
      common(WORK, {
        'GET /purchases/orders/o1': ok({ ...detail, status: 'DRAFT', number: null }),
      }),
    );
    renderAt('/purchases/orders/o1');
    expect(await screen.findByRole('button', { name: 'Submit' })).toBeTruthy();
  });
});

describe('three-way matching settings', () => {
  it('shows the mode and tolerances, read-only without the permission', async () => {
    stubApi(
      common(VIEW, {
        'GET /purchases/order-settings': ok({
          matchMode: 'block',
          quantityTolerancePct: '2.5',
          priceTolerancePct: '1',
          version: 1,
        }),
      }),
    );
    renderAt('/purchases/matching');
    const mode = (await screen.findByLabelText('When a bill does not match')) as HTMLSelectElement;
    expect(mode.value).toBe('block');
    expect(mode.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
