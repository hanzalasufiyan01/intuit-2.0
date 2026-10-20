import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Legal entity groups page (FP-24, migration 0085): side by side, never summed. */

type Handler = (url: URL, init: RequestInit) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const key = `${init.method ?? 'GET'} ${url.pathname.replace(/^\/api\/v1/, '')}`;
      calls.push({ key, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const result = table[key]
        ? table[key](url, init)
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

describe('entity groups page', () => {
  it('shows each organization in its own currency with a note that nothing is consolidated', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['organization.read'] })),
      'GET /organizations': ok([
        { id: 'o1', name: 'Resort', active: true },
        { id: 'o2', name: 'Shop', active: false },
        { id: 'o3', name: 'Spare', active: false },
      ]),
      'GET /organization-groups': ok([
        {
          id: 'g1',
          name: 'Holding',
          organizations: [
            { organizationId: 'o1', name: 'Resort', isOwner: true },
            { organizationId: 'o2', name: 'Shop', isOwner: true },
          ],
        },
      ]),
      'GET /organization-groups/g1/overview': () => ({
        status: 200,
        body: {
          data: {
            from: '2026-01-01',
            to: '2026-12-31',
            note: 'Each organization is shown in its own base currency. Nothing is added together.',
            organizations: [
              {
                organizationId: 'o1',
                name: 'Resort',
                status: 'ok',
                baseCurrency: 'MVR',
                grossProfit: '100.00',
                netProfit: '80.00',
              },
              { organizationId: 'o2', name: 'Shop', status: 'no_access' },
            ],
          },
        },
      }),
    });
    renderAt('/settings/groups');
    await user.click(await screen.findByRole('button', { name: 'Show side by side' }));
    expect(await screen.findByText('You cannot view reports in this organization.')).toBeTruthy();
    expect(screen.getByText(/Nothing is added together/)).toBeTruthy();
    expect(screen.queryByText(/Total/i)).toBeNull();
    // Only organizations not yet in a group are offered.
    const select = screen.getByLabelText('Add an organization you own') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['Choose…', 'Spare']);
    await waitFor(() => expect(calls.some((c) => c.key.includes('/overview'))).toBe(true));
  });

  it('creates a group', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['organization.read'] })),
      'GET /organizations': ok([]),
      'GET /organization-groups': ok([]),
      'POST /organization-groups': () => ({
        status: 201,
        body: { data: { id: 'g2', name: 'New', organizations: [] } },
      }),
    });
    renderAt('/settings/groups');
    await user.type(await screen.findByLabelText('Group name'), 'New');
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'POST /organization-groups')?.body).toEqual({
        name: 'New',
      }),
    );
  });
});
