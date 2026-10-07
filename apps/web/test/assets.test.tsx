import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Fixed asset pages. The server computes depreciation and every posting; the pages list the
 * register, the schedule and the runs, and offer each action only to users who hold its permission.
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

const asset = {
  id: 'a1',
  number: 'FA-00001',
  name: 'Dive compressor',
  description: '',
  categoryId: 'c1',
  categoryName: 'Equipment',
  acquisitionDate: '2026-01-15',
  inServiceDate: '2026-01-15',
  cost: '12000.00',
  salvageValue: '0.00',
  lifeMonths: 12,
  accumulatedDepreciation: '3000.00',
  bookValue: '9000.00',
  status: 'ACTIVE',
  location: '',
  custodian: '',
  serialNumber: '',
  version: 2,
};

const VIEW = ['fixed_assets.view'];
const WORK = [
  ...VIEW,
  'fixed_assets.manage',
  'fixed_assets.depreciate',
  'fixed_assets.dispose',
  'fixed_assets.void',
];

const common = (
  permissions: string[],
  extra: Record<string, Handler> = {},
): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /fixed-assets/assets': ok({ items: [asset], nextCursor: null }),
  'GET /fixed-assets/categories': ok({ items: [] }),
  'GET /accounting/accounts': ok([]),
  ...extra,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe('asset register', () => {
  it('lists assets with cost, accumulated depreciation and book value', async () => {
    stubApi(common(VIEW));
    renderAt('/assets');
    expect(await screen.findByRole('link', { name: 'FA-00001' })).toBeTruthy();
    expect(screen.getByText('9,000.00')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Register asset' })).toBeNull();
  });

  it('offers registration to those who may manage assets', async () => {
    stubApi(common(WORK));
    renderAt('/assets');
    expect(await screen.findByRole('button', { name: 'Register asset' })).toBeTruthy();
  });
});

describe('asset page', () => {
  const detail = {
    ...asset,
    schedule: [
      {
        monthEnd: '2026-01-31',
        amount: '1000.00',
        accumulated: '1000.00',
        bookValue: '11000.00',
        booked: true,
      },
      {
        monthEnd: '2026-02-28',
        amount: '1000.00',
        accumulated: '2000.00',
        bookValue: '10000.00',
        booked: false,
      },
    ],
    disposals: [],
  };

  it('shows the schedule and offers disposal only to those who may dispose', async () => {
    stubApi(common(VIEW, { 'GET /fixed-assets/assets/a1': ok(detail) }));
    renderAt('/assets/a1');
    expect(await screen.findByText('2026-01-31')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dispose…' })).toBeNull();
  });

  it('posts a disposal with the proceeds and an idempotency key', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(WORK, {
        'GET /fixed-assets/assets/a1': ok(detail),
        'POST /fixed-assets/assets/a1/dispose': ok({ id: 'd1' }),
      }),
    );
    renderAt('/assets/a1');
    await user.click(await screen.findByRole('button', { name: 'Dispose…' }));
    await user.type(screen.getByLabelText('Proceeds'), '5000');
    await user.click(screen.getByRole('button', { name: 'Post disposal' }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/dispose'));
      expect(call?.body).toMatchObject({ version: 2, proceeds: '5000' });
    });
  });
});

describe('depreciation page', () => {
  it('previews what is owing and posts it only when it can run', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(WORK, {
        'GET /fixed-assets/depreciation/runs': ok({ items: [] }),
        'GET /fixed-assets/depreciation/preview': ok({
          monthEnd: '2026-03-31',
          latestRunMonthEnd: null,
          canRun: true,
          total: '3000.00',
          lines: [
            {
              assetId: 'a1',
              number: 'FA-00001',
              name: 'Dive compressor',
              categoryName: 'Equipment',
              amount: '3000.00',
              accumulatedAfter: '3000.00',
              bookValueAfter: '9000.00',
            },
          ],
        }),
        'POST /fixed-assets/depreciation/runs': ok({ id: 'r1', number: 'DEP-00001' }),
      }),
    );
    renderAt('/assets/depreciation');
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('FA-00001 Dive compressor')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Post depreciation' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.pathname.endsWith('/depreciation/runs')),
      ).toBe(true),
    );
  });

  it('hides posting from a viewer', async () => {
    stubApi(
      common(VIEW, {
        'GET /fixed-assets/depreciation/runs': ok({ items: [] }),
        'GET /fixed-assets/depreciation/preview': ok({
          monthEnd: '2026-03-31',
          latestRunMonthEnd: null,
          canRun: true,
          total: '0.00',
          lines: [],
        }),
      }),
    );
    const user = userEvent.setup();
    renderAt('/assets/depreciation');
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/Nothing is owing/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post depreciation' })).toBeNull();
  });
});
