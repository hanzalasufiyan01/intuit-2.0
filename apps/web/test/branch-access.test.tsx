import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Branch access page (FP-24, migration 0084): who is limited to which branches. */

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
const member = (membershipId: string, name: string, extra = {}) => ({
  membershipId,
  userId: `u-${membershipId}`,
  email: `${name.toLowerCase()}@example.test`,
  displayName: name,
  status: 'active',
  isOwner: false,
  roles: [],
  joinedAt: '2026-01-01T00:00:00Z',
  ...extra,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

const DIMENSIONS = [
  {
    id: 't1',
    code: 'BRANCH',
    name: 'Branch',
    status: 'ACTIVE',
    values: [
      { id: 'v-n', code: 'NORTH', name: 'North', status: 'ACTIVE' },
      { id: 'v-s', code: 'SOUTH', name: 'South', status: 'ACTIVE' },
      { id: 'v-x', code: 'OLD', name: 'Closed', status: 'ARCHIVED' },
    ],
  },
];

describe('branch access page', () => {
  it('shows scopes, saves a member’s branches and protects owners and the actor', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['organization.read', 'members.read', 'members.manage'] }),
      ),
      'GET /organizations/current/members': ok([
        member('m-o', 'Fatima', { isOwner: true }),
        member('m-clerk', 'Omar'),
      ]),
      'GET /organizations/current/branch-scopes': ok([]),
      'GET /accounting/dimensions': ok(DIMENSIONS),
      'PUT /organizations/current/members/m-clerk/branch-scope': () => ({
        status: 200,
        body: { data: { membershipId: 'm-clerk', restricted: true, branches: [] } },
      }),
    });
    renderAt('/settings/branch-access');
    const row = (await screen.findByText('Omar')).closest('tr')!;
    expect(within(row).getByText('All branches')).toBeTruthy();
    expect(within(screen.getByText('Fatima').closest('tr')!).getByText('Owner')).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Edit branches for Omar' }));
    // Archived values are not offered.
    expect(screen.queryByLabelText(/Closed/)).toBeNull();
    await user.click(screen.getByLabelText('Branch: North'));
    await user.click(screen.getByRole('button', { name: 'Save branches' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.key === 'PUT /organizations/current/members/m-clerk/branch-scope')
          ?.body,
      ).toEqual({ dimensionValueIds: ['v-n'] }),
    );
  });

  it('is hidden without members.read', async () => {
    stubApi({ 'GET /auth/session': ok(makeSession({ permissions: ['organization.read'] })) });
    renderAt('/settings/branch-access');
    await waitFor(() => expect(screen.queryByText('Branch access')).toBeNull());
  });
});
