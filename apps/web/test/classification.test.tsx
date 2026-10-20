import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Customer groups, custom fields, item categories and barcodes (migration 0088). */

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

const base = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /sales/settings': ok({}),
  'GET /tax/codes': ok([]),
});

describe('groups, fields and categories page', () => {
  it('lists the three lists, adds a customer group and a field, and archives', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...base(['customers.view', 'customers.update', 'catalog.items.manage']),
      'GET /customer-groups': ok([
        { id: 'g1', name: 'Resorts', status: 'ACTIVE', version: 1, members: 3 },
      ]),
      'GET /custom-fields': ok([
        {
          id: 'f1',
          key: 'tier',
          label: 'Tier',
          fieldType: 'list',
          options: ['Gold', 'Silver'],
          status: 'ACTIVE',
          version: 1,
        },
      ]),
      'GET /item-categories': ok([]),
      'POST /customer-groups': ok({}),
      'POST /custom-fields': ok({}),
    });
    renderAt('/sales/classification');
    expect(await screen.findByText('Resorts')).toBeTruthy();
    expect(screen.getByText(/List of choices \(Gold, Silver\)/)).toBeTruthy();
    await user.type(screen.getByLabelText('New group name'), 'Retail');
    await user.click(screen.getByRole('button', { name: 'Add group' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/customer-groups'))?.body,
      ).toEqual({ name: 'Retail' }),
    );
    await user.type(screen.getByLabelText('Field label'), 'Visits');
    await user.type(screen.getByLabelText('Field key'), 'visits');
    await user.selectOptions(screen.getByLabelText('Field type'), 'number');
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/custom-fields'))?.body,
      ).toEqual({ key: 'visits', label: 'Visits', fieldType: 'number' }),
    );
  });

  it('shows a viewer the lists but no forms', async () => {
    stubApi({
      ...base(['customers.view']),
      'GET /customer-groups': ok([]),
      'GET /custom-fields': ok([]),
    });
    renderAt('/sales/classification');
    expect(await screen.findByText('Customer groups')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add group' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add field' })).toBeNull();
    expect(screen.queryByText('Item categories')).toBeNull();
  });
});
