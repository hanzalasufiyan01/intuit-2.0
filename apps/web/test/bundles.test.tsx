import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** The bundles page (FP-29 A7). */

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

const base = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /inventory/bundles': ok([
    {
      bundleItemId: 'b1',
      name: 'Gift basket',
      components: [
        { itemId: 'a', name: 'Coconut oil 1L', quantity: '2' },
        { itemId: 's', name: 'Sea salt 1kg', quantity: '1' },
      ],
    },
  ]),
  'GET /inventory/items': ok({
    items: [
      { itemId: 'a', name: 'Coconut oil 1L' },
      { itemId: 's', name: 'Sea salt 1kg' },
    ],
  }),
  'GET /sales/items': ok({
    items: [
      { id: 'a', name: 'Coconut oil 1L', itemType: 'product' },
      { id: 'b1', name: 'Gift basket', itemType: 'product' },
    ],
  }),
});

describe('bundles page', () => {
  it('lists bundles and sends the component list when saved', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...base(['organization.read', 'inventory.view', 'inventory.items.manage']),
      'PUT /inventory/bundles/b1': ok({}),
    });
    renderAt('/inventory/bundles');
    expect(await screen.findByText('Gift basket', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText(/2 × Coconut oil 1L/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save bundle' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        components: [
          { itemId: 'a', quantity: '2' },
          { itemId: 's', quantity: '1' },
        ],
      }),
    );
  });

  it('is read-only without the manage permission', async () => {
    stubApi(base(['organization.read', 'inventory.view']));
    renderAt('/inventory/bundles');
    await screen.findByText('Gift basket', { selector: 'strong' });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText('Define a bundle')).toBeNull();
  });
});
