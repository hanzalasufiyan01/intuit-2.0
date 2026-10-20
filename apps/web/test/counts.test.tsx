import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Stock counts (FP-29 A5) and project tasks (FP-26). */

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

describe('stock counts', () => {
  it('saves counted quantities and posts the differences', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({
          permissions: [
            'inventory.view',
            'inventory.counts.manage',
            'inventory.adjustments.create',
          ],
        }),
      ),
      'GET /inventory/counts/c1': ok(count('DRAFT')),
      'PUT /inventory/counts/c1/lines': ok(count('DRAFT')),
      'POST /inventory/counts/c1/post': ok(count('POSTED', { adjustmentId: 'a1' })),
    });
    renderAt('/inventory/counts/c1');
    await user.type(await screen.findByLabelText('Counted quantity for Coconut oil 1L'), '8');
    await user.click(screen.getByRole('button', { name: 'Save counted quantities' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'PUT' && c.url.pathname.endsWith('/lines'))?.body,
      ).toEqual({ lines: [{ itemId: 'i1', countedQuantity: '8' }] }),
    );
    await user.click(await screen.findByRole('button', { name: 'Post differences' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/post'))?.body,
      ).toEqual({ version: 2 }),
    );
  });

  it('shows a posted count read-only and hides posting without adjustments.create', async () => {
    stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['inventory.view', 'inventory.counts.manage'] }),
      ),
      'GET /inventory/counts/c1': ok(count('DRAFT')),
    });
    renderAt('/inventory/counts/c1');
    expect(await screen.findByRole('button', { name: 'Save counted quantities' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post differences' })).toBeNull();
  });

  it('lists counts and offers to start one', async () => {
    stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['inventory.view', 'inventory.counts.manage'] }),
      ),
      'GET /inventory/counts': ok([count('POSTED')]),
    });
    renderAt('/inventory/counts');
    expect(await screen.findByRole('link', { name: 'CNT-00001' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start count of all tracked items' })).toBeTruthy();
  });
});
