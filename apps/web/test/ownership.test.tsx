import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Ownership transfer page (ADR 0012): offers, acceptance and the list of transfers. */

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
const person = (membershipId: string, name: string) => ({
  membershipId,
  email: `${name.toLowerCase()}@example.test`,
  displayName: name,
});
const transfer = (extra = {}) => ({
  id: 't1',
  status: 'verified',
  from: person('m-x', 'Fatima'),
  to: person('m-a', 'Aisha'),
  replacementRole: { id: 'r-admin', name: 'Administrator' },
  initiatedAt: '2026-10-17T08:00:00Z',
  completedAt: null,
  cancelReason: null,
  expiresAt: '2026-10-20T08:00:00Z',
  ...extra,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

const PERMISSIONS = ['organization.read', 'members.read', 'roles.read'];

describe('ownership page', () => {
  it('lets the person who was offered ownership accept it', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: PERMISSIONS })),
      'GET /organizations/current/ownership-transfers': ok({ items: [transfer()] }),
      'GET /organizations/current/members': ok([]),
      'GET /organizations/current/roles': ok([]),
      'POST /organizations/current/ownership-transfers/t1/accept': ok(
        transfer({ status: 'completed' }),
      ),
    });
    renderAt('/settings/ownership');
    expect(await screen.findByText('Administrator')).toBeTruthy();
    expect(screen.getByText('verified')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Accept ownership' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.key === 'POST /organizations/current/ownership-transfers/t1/accept'),
      ).toBe(true),
    );
  });

  it('offers the Owner a form that names the new owner and the role kept, and keeps the history', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: PERMISSIONS })),
      'GET /organizations/current/ownership-transfers': ok({
        items: [
          transfer({
            id: 't0',
            status: 'cancelled',
            cancelReason: 'Changed my mind',
            to: person('m-b', 'Omar'),
          }),
        ],
      }),
      'GET /organizations/current/members': ok([
        {
          membershipId: 'm-b',
          userId: 'u2',
          email: 'omar@example.test',
          displayName: 'Omar',
          status: 'active',
          isOwner: false,
          roles: [],
          joinedAt: '2026-01-01T00:00:00Z',
        },
      ]),
      'GET /organizations/current/roles': ok([
        { id: 'r-admin', name: 'Administrator', isOwner: false },
        { id: 'r-own', name: 'Owner', isOwner: true },
      ]),
      'POST /organizations/current/ownership-transfers': () => ({
        status: 201,
        body: { data: transfer({ id: 't2', to: person('m-b', 'Omar') }) },
      }),
    });
    renderAt('/settings/ownership');
    expect(await screen.findByText('cancelled (Changed my mind)')).toBeTruthy();
    const offer = screen.getByRole('button', { name: 'Offer ownership' }) as HTMLButtonElement;
    expect(offer.disabled).toBe(true);
    await user.selectOptions(await screen.findByLabelText('New owner'), 'm-b');
    // The Owner role is not offered as the role the previous owner keeps.
    expect(screen.queryByRole('option', { name: 'Owner' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Your role afterwards'), 'r-admin');
    await user.click(offer);
    await waitFor(() => {
      const post = calls.find((c) => c.key === 'POST /organizations/current/ownership-transfers');
      expect(post?.body).toEqual({ toMembershipId: 'm-b', replacementRoleId: 'r-admin' });
    });
  });
});
