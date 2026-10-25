import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Stock counts and ownership transfer: the visible English of both pages (written before they
 * moved to the message catalog, kept as the regression guard after), plus the values these pages
 * send to the server. The default reasons 'Declined' and 'Withdrawn' are stored data, so they must
 * stay fixed whatever language the screen is in.
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

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

afterEach(() => {
  vi.restoreAllMocks();
});

const count = (status: string, extra: object = {}) => ({
  id: 'c1',
  number: 'CNT-00001',
  countDate: '2026-03-31',
  status,
  memo: '',
  adjustmentId: null,
  cancelReason: null,
  version: 2,
  lines: [
    {
      itemId: 'i1',
      name: 'Coconut oil 1L',
      sku: null,
      expectedQuantity: '10',
      countedQuantity: null,
      difference: null,
    },
  ],
  ...extra,
});

const COUNTS = ['inventory.view', 'inventory.counts.manage', 'inventory.adjustments.create'];

describe('stock counts text', () => {
  it('shows the list page wording, the columns and the lowercased status', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: COUNTS })),
      'GET /inventory/counts': ok([count('POSTED')]),
    });
    renderAt('/inventory/counts');
    expect(await screen.findByRole('heading', { name: 'Stock counts' })).toBeTruthy();
    expect(
      screen.getByText(
        'Count what is on the shelves; the differences become one stock adjustment.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Start a count' })).toBeTruthy();
    expect(screen.getByLabelText('Count date')).toBeTruthy();
    expect(screen.getByLabelText('Note')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Counts' })).toBeTruthy();
    const row = (await screen.findByRole('link', { name: 'CNT-00001' })).closest('tr')!;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['CNT-00001', '2026-03-31', '1', 'Posted']);
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Number',
      'Date',
      'Items',
      'Status',
    ]);
  });

  it('says when there are no counts', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: COUNTS })),
      'GET /inventory/counts': ok([]),
    });
    renderAt('/inventory/counts');
    expect(await screen.findByText('No counts yet.')).toBeTruthy();
  });

  it('shows a draft count, warns inline before posting unsaved figures, and asks why it is cancelled', async () => {
    const user = userEvent.setup();
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Wrong shelf');
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: COUNTS })),
      'GET /inventory/counts/c1': ok(count('DRAFT')),
      'POST /inventory/counts/c1/cancel': () => ({ status: 200, body: { data: {} } }),
    });
    renderAt('/inventory/counts/c1');
    expect(await screen.findByRole('heading', { name: 'Count CNT-00001' })).toBeTruthy();
    expect(screen.getByText('2026-03-31 · Draft')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Item',
      'Expected',
      'Counted',
      'Difference',
    ]);
    expect(screen.queryByText('Save the counted quantities first.')).toBeNull();
    await user.type(screen.getByLabelText('Counted quantity for Coconut oil 1L'), '8');
    await user.click(screen.getByRole('button', { name: 'Post differences' }));
    // The warning is an inline alert, not a browser dialog, and nothing is posted.
    expect(screen.getByRole('alert').textContent).toBe('Save the counted quantities first.');
    expect(alert).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    // Changing a figure clears the warning again.
    await user.type(screen.getByLabelText('Counted quantity for Coconut oil 1L'), '5');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Post differences' }));
    expect(screen.getByRole('alert').textContent).toBe('Save the counted quantities first.');
    await user.click(screen.getByRole('button', { name: 'Cancel count' }));
    expect(prompt).toHaveBeenCalledWith('Why is this count cancelled?');
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toEqual({ version: 2, reason: 'Wrong shelf' });
    });
  });

  it('shows the cancel reason and the link to the posted adjustment', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: COUNTS })),
      'GET /inventory/counts/c1': ok(
        count('POSTED', { adjustmentId: 'a1', cancelReason: 'Recounted later' }),
      ),
    });
    renderAt('/inventory/counts/c1');
    expect(await screen.findByText('Cancelled: Recounted later')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'stock adjustment' });
    expect(link.getAttribute('href')).toBe('/inventory/adjustments');
    expect(link.closest('p')?.textContent).toBe('Posted as a stock adjustment.');
  });
});

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
const OWNERSHIP = ['organization.read', 'members.read', 'roles.read'];

describe('ownership page text', () => {
  it('shows the page wording, the form hints and placeholders, and the empty history', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: OWNERSHIP })),
      'GET /organizations/current/ownership-transfers': ok({ items: [] }),
      'GET /organizations/current/members': ok([]),
      'GET /organizations/current/roles': ok([]),
    });
    renderAt('/settings/ownership');
    expect(await screen.findByRole('heading', { name: 'Ownership' })).toBeTruthy();
    expect(
      screen.getByText(
        'Transfer ownership of this organization. Nothing changes until the new owner accepts.',
      ),
    ).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Offer ownership' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Choose a member…' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Choose a role…' })).toBeTruthy();
    expect(screen.getByText('The new owner must already use two-step verification.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Transfers' })).toBeTruthy();
    expect(await screen.findByText('No ownership transfers.')).toBeTruthy();
  });

  it('explains the missing permission to start a transfer', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: OWNERSHIP })),
      'GET /organizations/current/ownership-transfers': ok({ items: [] }),
      'GET /organizations/current/members': () => ({
        status: 403,
        body: { error: { code: 'PERMISSION_DENIED', message: 'No.', requestId: 'r' } },
      }),
      'GET /organizations/current/roles': ok([]),
    });
    renderAt('/settings/ownership');
    expect(
      await screen.findByText('You need permission to view members and roles to start a transfer.'),
    ).toBeTruthy();
  });

  it('lists an open transfer and sends the fixed default reasons when none is typed', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: OWNERSHIP })),
      'GET /organizations/current/ownership-transfers': ok({ items: [transfer()] }),
      'POST /organizations/current/ownership-transfers/t1/decline': () => ({
        status: 200,
        body: { data: {} },
      }),
      'POST /organizations/current/ownership-transfers/t1/cancel': () => ({
        status: 200,
        body: { data: {} },
      }),
    });
    renderAt('/settings/ownership');
    expect(
      await screen.findByText('An ownership transfer is open. Cancel it to start a different one.'),
    ).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'From',
      'To',
      'Previous owner becomes',
      'Status',
      'Date',
      '',
    ]);
    const reason = screen.getByLabelText('Reason') as HTMLInputElement;
    expect(reason.placeholder).toBe('Reason');
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    await user.click(screen.getByRole('button', { name: 'Cancel transfer' }));
    await waitFor(() => {
      const posts = calls.filter((c) => c.method === 'POST');
      expect(posts.map((p) => [p.url.pathname.split('/').pop(), p.body])).toEqual([
        ['decline', { reason: 'Declined' }],
        ['cancel', { reason: 'Withdrawn' }],
      ]);
    });
  });
});
