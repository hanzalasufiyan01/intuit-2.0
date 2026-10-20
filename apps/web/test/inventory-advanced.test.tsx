import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Warehouses, transfers, expiry report, landed cost and units of measure (FP-29, ADR 0014). */

function stubApi(table: Record<string, () => { status: number; body?: unknown }>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v1/, '');
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = table[`${method} ${path}`]?.() ?? {
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
function renderAt(path: string) {
  render(
    <App
      router={createMemoryRouter(routes, { initialEntries: [path] })}
      queryClient={createQueryClient()}
    />,
  );
}

const ALL = [
  'organization.read',
  'inventory.view',
  'inventory.items.manage',
  'inventory.settings.manage',
  'inventory.adjustments.create',
  'inventory.adjustments.void',
  'accounting.accounts.view',
];
const warehouses = [
  {
    id: 'w1',
    code: 'MAIN',
    name: 'Main warehouse',
    isDefault: true,
    status: 'ACTIVE',
    version: 1,
    itemsInStock: 3,
  },
  {
    id: 'w2',
    code: 'ANNEX',
    name: 'Annex',
    isDefault: false,
    status: 'ACTIVE',
    version: 1,
    itemsInStock: 0,
  },
];
const base = (permissions = ALL) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /inventory/warehouses': ok(warehouses),
  'GET /inventory/items': ok({ items: [{ itemId: 'i1', name: 'Coconut oil 1L' }] }),
  'GET /accounting/accounts': ok([]),
});

describe('warehouses and transfers', () => {
  it('lists warehouses, protects the default and sends a new warehouse', async () => {
    const user = userEvent.setup();
    const calls = stubApi({ ...base(), 'POST /inventory/warehouses': ok({}) });
    renderAt('/inventory/warehouses');
    expect(await screen.findByText('Main warehouse')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Archive' })).toHaveLength(1); // not on the default
    await user.type(screen.getByLabelText('Code'), 'COLD');
    await user.type(screen.getByLabelText('Name'), 'Cold room');
    await user.click(screen.getByRole('button', { name: 'Add warehouse' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        code: 'COLD',
        name: 'Cold room',
      }),
    );
  });

  it('posts a transfer between two warehouses', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...base(),
      'GET /inventory/transfers': ok([]),
      'POST /inventory/transfers': ok({}),
    });
    renderAt('/inventory/transfers');
    await screen.findAllByRole('option', { name: 'MAIN Main warehouse' });
    await user.selectOptions(await screen.findByLabelText('From'), 'w1');
    await user.selectOptions(screen.getByLabelText('To'), 'w2');
    await user.selectOptions(screen.getByLabelText('Item 1'), 'i1');
    await user.type(screen.getByLabelText('Quantity'), '5');
    await user.click(screen.getByRole('button', { name: 'Post transfer' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
        fromWarehouseId: 'w1',
        toWarehouseId: 'w2',
        lines: [{ itemId: 'i1', quantity: '5' }],
      }),
    );
  });

  it('hides the transfer form from someone who cannot adjust stock', async () => {
    stubApi({
      ...base(['organization.read', 'inventory.view']),
      'GET /inventory/transfers': ok([]),
    });
    renderAt('/inventory/transfers');
    await screen.findByText('No transfers yet.');
    expect(screen.queryByText('New transfer')).toBeNull();
  });
});

describe('expiry, landed cost and units', () => {
  it('shows lots that expire soon and marks expired ones', async () => {
    stubApi({
      ...base(),
      'GET /inventory/lots/expiring': ok({
        asOf: '2026-03-01',
        through: '2026-03-31',
        lots: [
          {
            lotId: 'l1',
            itemId: 'i1',
            itemName: 'Coconut oil 1L',
            code: 'OLD',
            expiryDate: '2026-02-20',
            daysToExpiry: -9,
            expired: true,
            warehouseName: 'Main warehouse',
            quantity: '2',
          },
          {
            lotId: 'l2',
            itemId: 'i1',
            itemName: 'Coconut oil 1L',
            code: 'SOON',
            expiryDate: '2026-03-15',
            daysToExpiry: 14,
            expired: false,
            warehouseName: 'Main warehouse',
            quantity: '4',
          },
        ],
      }),
    });
    renderAt('/inventory/lots');
    expect(await screen.findByText('OLD')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getByText('in 14 days')).toBeTruthy();
  });

  it('shows how a landed cost was split and offers the void', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...base(),
      'GET /purchases/bills': ok({ items: [] }),
      'GET /inventory/landed-costs': ok([
        {
          id: 'lc1',
          number: 'LC-00001',
          costDate: '2026-03-01',
          billNumber: 'BILL-00001',
          description: 'Freight',
          amount: '30',
          status: 'POSTED',
          voidReason: null,
          version: 1,
          lines: [
            {
              itemId: 'i1',
              name: 'Coconut oil 1L',
              allocated: '30',
              toInventory: '18',
              toCostOfGoodsSold: '12',
            },
          ],
        },
      ]),
      'POST /inventory/landed-costs/lc1/void': ok({}),
    });
    vi.spyOn(window, 'prompt').mockReturnValue('Wrong bill');
    renderAt('/inventory/landed-costs');
    expect(await screen.findByText(/to stock/)).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Void' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/lc1/void'))).toBe(true),
    );
  });

  it('saves the units of an item', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...base(),
      'GET /inventory/items/i1': ok({
        itemId: 'i1',
        name: 'Coconut oil 1L',
        quantity: '10',
        averageCost: '12',
        value: '120',
        trackingMode: 'none',
        version: 1,
      }),
      'GET /inventory/items/i1/movements': ok({ items: [], nextCursor: null }),
      'GET /inventory/items/i1/units': ok({
        baseUnit: 'bottle',
        purchaseUnit: null,
        salesUnit: null,
        version: 1,
      }),
      'PUT /inventory/items/i1/units': ok({}),
    });
    renderAt('/inventory/items/i1');
    await user.type(await screen.findByLabelText('Purchase unit'), 'carton');
    await user.type(screen.getByLabelText('Base units per purchase unit'), '24');
    await user.click(screen.getByRole('button', { name: 'Save units' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        version: 1,
        baseUnit: 'bottle',
        purchaseUnit: { unit: 'carton', factor: '24' },
        salesUnit: null,
      }),
    );
  });
});

describe('view-only inventory users', () => {
  const VIEW = ['organization.read', 'inventory.view'];

  it('cannot add, archive or change the default warehouse', async () => {
    stubApi({ ...base(VIEW) });
    renderAt('/inventory/warehouses');
    expect(await screen.findByText('Annex')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add warehouse/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive|Make default|Restore/ })).toBeNull();
  });

  it('sees landed costs but cannot post or void one', async () => {
    stubApi({
      ...base(VIEW),
      'GET /inventory/landed-costs': ok([
        {
          id: 'lc1',
          number: 'LC-00001',
          costDate: '2026-03-01',
          billNumber: 'BILL-00001',
          description: 'Freight',
          amount: '30',
          status: 'POSTED',
          voidReason: null,
          version: 1,
          lines: [],
        },
      ]),
    });
    renderAt('/inventory/landed-costs');
    expect(await screen.findByText('LC-00001')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
    expect(screen.queryByText('Add a landed cost')).toBeNull();
  });

  it('cannot change the units of an item', async () => {
    stubApi({
      ...base(VIEW),
      'GET /inventory/items/i1': ok({
        itemId: 'i1',
        name: 'Coconut oil 1L',
        quantity: '10',
        averageCost: '12',
        value: '120',
        trackingMode: 'none',
        version: 1,
      }),
      'GET /inventory/items/i1/movements': ok({ items: [], nextCursor: null }),
      'GET /inventory/items/i1/units': ok({
        baseUnit: 'bottle',
        purchaseUnit: null,
        salesUnit: null,
        version: 1,
      }),
    });
    renderAt('/inventory/items/i1');
    await screen.findByText('Coconut oil 1L');
    expect(screen.queryByLabelText('Purchase unit')).toBeNull();
  });

  it('is turned away from stock counts without the counts permission', async () => {
    stubApi({ ...base(VIEW) });
    renderAt('/inventory/counts');
    await waitFor(() => expect(screen.queryByText('Stock counts')).toBeNull());
  });
});
