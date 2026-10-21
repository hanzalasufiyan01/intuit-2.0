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
  depreciationMethod: 'straight_line',
  decliningRate: null,
  doubleDecliningRate: null,
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

describe('depreciation method (R-11)', () => {
  const category = {
    id: 'c1',
    name: 'Equipment',
    costAccountId: 'x1',
    accumulatedAccountId: 'x2',
    expenseAccountId: 'x3',
    defaultLifeMonths: 60,
    status: 'ACTIVE',
    version: 1,
  };
  const bank = {
    id: 'b1',
    code: '1010',
    name: 'Bank',
    type: 'ASSET',
    status: 'ACTIVE',
    isLeaf: true,
    isControlAccount: false,
  };
  const withTerms = (extra: Record<string, Handler> = {}) =>
    common([...WORK, 'accounting.accounts.view'], {
      'GET /fixed-assets/categories': ok({ items: [category] }),
      'GET /accounting/accounts': ok([bank]),
      'POST /fixed-assets/assets': () => ({ status: 201, body: { data: asset } }),
      ...extra,
    });

  async function fillTerms(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText('Name'), 'Generator');
    await user.selectOptions(screen.getByLabelText('Category'), 'c1');
    await user.type(screen.getByLabelText('Cost'), '1000.00');
    await user.type(screen.getByLabelText('Life in months'), '60');
    await user.selectOptions(screen.getByLabelText('Paid from'), 'b1');
  }

  it('registers straight line without sending a method or a rate', async () => {
    const user = userEvent.setup();
    const calls = stubApi(withTerms());
    renderAt('/assets');
    await fillTerms(user);
    expect(screen.queryByLabelText('Annual rate (%)')).toBeNull();
    expect(screen.queryByText('Checking the schedule…')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Register asset' }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/assets'));
      expect(call?.body).toMatchObject({ cost: '1000.00', lifeMonths: 60 });
      // Straight line asks for no schedule check.
      expect(calls.some((c) => c.url.pathname.endsWith('/schedule-preview'))).toBe(false);
      expect(call?.body).not.toHaveProperty('depreciationMethod');
      expect(call?.body).not.toHaveProperty('decliningRate');
    });
  });

  it('checks the schedule by itself for declining balance, keeps it current, and still registers', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      withTerms({
        'POST /fixed-assets/assets/schedule-preview': (_url, body) => {
          const rate = (body as { decliningRate: string }).decliningRate;
          return {
            status: 200,
            body: {
              data: {
                depreciationMethod: 'declining_balance',
                lifeMonths: 60,
                warnings: rate === '20' ? ['STRAIGHT_LINE_EQUIVALENT'] : [],
                schedule: [
                  {
                    monthEnd: rate === '20' ? '2026-10-31' : '2026-11-30',
                    amount: '16.67',
                    accumulated: '16.67',
                    bookValue: '983.33',
                  },
                ],
              },
            },
          };
        },
      }),
    );
    const previews = () => calls.filter((c) => c.url.pathname.endsWith('/schedule-preview'));
    renderAt('/assets');
    await fillTerms(user);
    await user.selectOptions(screen.getByLabelText('Depreciation method'), 'declining_balance');
    // No rate yet: nothing to check.
    expect(previews()).toHaveLength(0);
    await user.type(screen.getByLabelText('Annual rate (%)'), '20');
    expect(await screen.findByText(/the same as straight line/)).toBeTruthy();
    expect(screen.getByText('2026-10-31')).toBeTruthy();
    // One request for the settled terms, not one per keystroke.
    expect(previews()).toHaveLength(1);
    expect(previews()[0]!.body).toMatchObject({
      depreciationMethod: 'declining_balance',
      decliningRate: '20',
    });
    expect(previews()[0]!.body).not.toHaveProperty('name');
    // Changing a term hides the old result at once, then checks again.
    await user.clear(screen.getByLabelText('Annual rate (%)'));
    await user.type(screen.getByLabelText('Annual rate (%)'), '35');
    expect(screen.queryByText(/the same as straight line/)).toBeNull();
    expect(screen.queryByText('2026-10-31')).toBeNull();
    expect(await screen.findByText('2026-11-30')).toBeTruthy();
    expect(previews().at(-1)!.body).toMatchObject({ decliningRate: '35' });
    // The warning informs; registering needs no confirmation.
    await user.click(screen.getByRole('button', { name: 'Register asset' }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/assets'));
      expect(call?.body).toMatchObject({
        name: 'Generator',
        depreciationMethod: 'declining_balance',
        decliningRate: '35',
      });
    });
  });

  it('sends double-declining balance without a rate, even when the check fails', async () => {
    const user = userEvent.setup();
    // No preview handler: the check fails (404), which must not block registering.
    const calls = stubApi(withTerms());
    renderAt('/assets');
    await fillTerms(user);
    await user.selectOptions(
      screen.getByLabelText('Depreciation method'),
      'double_declining_balance',
    );
    expect(screen.queryByLabelText('Annual rate (%)')).toBeNull();
    expect(await screen.findByText('Not found')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Register asset' }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/assets'));
      expect(call?.body).toMatchObject({ depreciationMethod: 'double_declining_balance' });
      expect(call?.body).not.toHaveProperty('decliningRate');
    });
  });

  it('shows a rate error from the server on the rate field', async () => {
    const user = userEvent.setup();
    stubApi(
      withTerms({
        'POST /fixed-assets/assets/schedule-preview': () => ({
          status: 422,
          body: {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid',
              requestId: 'r',
              details: {
                issues: [{ path: 'decliningRate', message: 'Enter a rate greater than 0.' }],
              },
            },
          },
        }),
      }),
    );
    renderAt('/assets');
    await fillTerms(user);
    await user.selectOptions(screen.getByLabelText('Depreciation method'), 'declining_balance');
    await user.type(screen.getByLabelText('Annual rate (%)'), '0');
    expect(await screen.findByText('Enter a rate greater than 0.')).toBeTruthy();
    expect(screen.queryByText('Checking the schedule…')).toBeNull();
  });

  it('shows the method on the asset page', async () => {
    stubApi(
      common(VIEW, {
        'GET /fixed-assets/assets/a1': ok({
          ...asset,
          depreciationMethod: 'double_declining_balance',
          doubleDecliningRate: '40.0000',
          schedule: [],
          disposals: [],
        }),
      }),
    );
    renderAt('/assets/a1');
    expect(await screen.findByText('Double-declining balance (40.0000% a year)')).toBeTruthy();
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
