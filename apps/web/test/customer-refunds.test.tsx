import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Customer refund pages. The server numbers, converts and posts; the pages list refunds, record
 * one from an open receipt, and offer each action only to users who hold its permission.
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

const summary = {
  id: 'f1',
  status: 'RECORDED',
  number: 'RF-00001',
  customerId: 'c1',
  customerName: 'Lagoon Traders',
  sourceType: 'receipt',
  sourceId: 'r1',
  refundDate: '2026-03-20',
  currencyCode: 'MVR',
  amount: '50.00',
  baseAmount: '50.0000',
  reference: null,
  version: 1,
};

const detail = {
  ...summary,
  sourceNumber: 'RCT-00001',
  refundAccountId: 'a1',
  refundAccountOverridden: false,
  exchangeRate: '1.0000000000',
  exchangeRateSource: 'base',
  tableRate: null,
  rateOverrideReason: null,
  baseReleased: '50.0000',
  fxDifference: '0.0000',
  memo: '',
  journalId: 'j1',
  voidReason: null,
  voidJournalId: null,
  baseCurrency: 'MVR',
};

const receipt = {
  id: 'r1',
  status: 'RECORDED',
  number: 'RCT-00001',
  customerId: 'c1',
  customerName: 'Lagoon Traders',
  currencyCode: 'MVR',
  amountUnallocated: '100.00',
};

const VIEW = ['receipts.view'];
const WORK = [...VIEW, 'receipts.create', 'receipts.void'];

const common = (
  permissions: string[],
  extra: Record<string, Handler> = {},
): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /sales/refunds': ok({ items: [summary], nextCursor: null }),
  'GET /sales/refunds/f1': ok(detail),
  'GET /sales/receipts': ok({ items: [receipt], nextCursor: null }),
  'GET /accounting/setup': ok({ settings: { baseCurrency: 'MVR' } }),
  'GET /accounting/accounts': ok([]),
  ...extra,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe('customer refund list', () => {
  it('lists refunds, and offers New only to those who may create', async () => {
    stubApi(common(VIEW));
    renderAt('/sales/refunds');
    expect(await screen.findByRole('link', { name: 'RF-00001' })).toBeTruthy();
    expect(screen.getByText('Lagoon Traders')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New refund' })).toBeNull();
  });

  it('shows the New link to a creator', async () => {
    stubApi(common(WORK));
    renderAt('/sales/refunds');
    expect(await screen.findByRole('link', { name: 'New refund' })).toBeTruthy();
  });
});

describe('record customer refund', () => {
  it('records a refund from an open receipt with an idempotency key', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(WORK, {
        'POST /sales/refunds': () => ({ status: 201, body: { data: detail } }),
      }),
    );
    renderAt('/sales/refunds/new?sourceType=receipt&sourceId=r1');
    await user.type(await screen.findByLabelText(/Amount/), '50');
    await user.click(screen.getByRole('button', { name: 'Record refund' }));
    await waitFor(() => {
      const call = calls.find(
        (c) => c.method === 'POST' && c.url.pathname.endsWith('/sales/refunds'),
      );
      expect(call?.body).toMatchObject({
        sourceType: 'receipt',
        sourceId: 'r1',
        amount: '50',
        refundAccountId: null,
      });
    });
  });
});

describe('customer refund detail', () => {
  it('lets a voider void a recorded refund', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(WORK, {
        'POST /sales/refunds/f1/void': ok({ ...detail, status: 'VOID', voidReason: 'Twice' }),
      }),
    );
    renderAt('/sales/refunds/f1');
    await user.type(await screen.findByLabelText('Void reason'), 'Twice');
    await user.click(screen.getByRole('button', { name: 'Void' }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/void'));
      expect(call?.body).toEqual({ version: 1, reason: 'Twice' });
    });
  });

  it('hides voiding from a viewer', async () => {
    stubApi(common(VIEW));
    renderAt('/sales/refunds/f1');
    expect(await screen.findByText('Summary')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
  });
});
