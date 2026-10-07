import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Phase 4B-8: the Purchases search page (ADR 0004 4B-8; Sales search D15). The server returns only
 * the sections the user may view; the page shows what it gets and never asks for more.
 */

function stubApi(table: Record<string, (url: URL) => unknown>) {
  const calls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push(url);
      const key = `GET ${url.pathname.replace(/^\/api\/v1/, '')}`;
      const handler = table[key];
      return new Response(
        JSON.stringify(
          handler
            ? { data: handler(url) }
            : { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } },
        ),
        { status: handler ? 200 : 404, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return calls;
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe('purchases search', () => {
  it('searches and shows vendors and documents with links', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': () => makeSession({ permissions: ['bills.view', 'vendors.view'] }),
      'GET /purchases/search': () => ({
        q: 'reef',
        vendors: [
          {
            id: 'v1',
            displayName: 'Reef Hardware',
            reference: 'VN-1',
            email: null,
            currencyCode: 'MVR',
          },
        ],
        bills: [
          {
            id: 'b1',
            number: 'BILL-00001',
            vendorReference: 'REEF-7788',
            status: 'POSTED',
            billDate: '2026-03-10',
            vendorName: 'Reef Hardware',
            currencyCode: 'MVR',
            total: '100.00',
            amountDue: '100.00',
          },
        ],
      }),
    });
    renderAt('/purchases/search');
    await user.type(await screen.findByLabelText('Search'), 'reef');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect((await screen.findByRole('link', { name: 'Reef Hardware' })).getAttribute('href')).toBe(
      '/purchases/vendors/v1',
    );
    expect(screen.getByRole('link', { name: 'BILL-00001' }).getAttribute('href')).toBe(
      '/purchases/bills/b1',
    );
    await waitFor(() => {
      const search = calls.find((u) => u.pathname.endsWith('/purchases/search'))!;
      expect(search.searchParams.get('q')).toBe('reef');
      expect(search.searchParams.get('limit')).toBe('10');
    });
  });

  it('does not search for one character and says when nothing matches', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': () => makeSession({ permissions: ['vendors.view'] }),
      'GET /purchases/search': () => ({ q: 'zz', vendors: [] }),
    });
    renderAt('/purchases/search');
    await user.type(await screen.findByLabelText('Search'), 'z');
    expect((screen.getByRole('button', { name: 'Search' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.type(screen.getByLabelText('Search'), 'z');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Nothing matches/)).toBeTruthy();
    expect(calls.filter((u) => u.pathname.endsWith('/purchases/search'))).toHaveLength(1);
  });

  it('is not offered to a user who can view no Purchases records', async () => {
    stubApi({ 'GET /auth/session': () => makeSession({ permissions: ['invoices.view'] }) });
    renderAt('/purchases/search');
    await waitFor(() => expect(screen.queryByLabelText('Search')).toBeNull());
  });
});
