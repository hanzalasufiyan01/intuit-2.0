import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Quotes and recurring invoices (FP-28): actions follow the status and the user's permissions. */

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

const ALL = [
  'quotes.view',
  'quotes.create',
  'quotes.convert',
  'recurring_invoices.view',
  'recurring_invoices.manage',
  'customers.view',
];

const common = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /customers': ok({
    items: [{ id: 'c1', displayName: 'Sun Island Resort' }],
    nextCursor: null,
  }),
  'GET /sales/items': ok({ items: [], nextCursor: null }),
});

const quote = (status: string, extra: object = {}) => ({
  id: 'q1',
  number: 'QUO-00001',
  customerId: 'c1',
  quoteDate: '2026-03-01',
  validUntil: '2026-03-31',
  status,
  reference: null,
  memo: '',
  netTotal: '1250.5',
  declineReason: null,
  invoiceId: null,
  version: 3,
  lines: [
    { lineNo: 1, description: 'Support', quantity: '2', unitPrice: '500', netAmount: '1000' },
  ],
  ...extra,
});

describe('quote page', () => {
  it('offers each step of the lifecycle only in its status', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /sales/quotes/q1': ok(quote('SENT')),
      'POST /sales/quotes/q1/accept': ok(quote('ACCEPTED')),
    });
    renderAt('/sales/quotes/q1');
    expect(await screen.findByText('Customer accepted')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark as sent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create draft invoice' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Customer accepted' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/accept'))?.body,
      ).toEqual({ version: 3 }),
    );
  });

  it('converts an accepted quote into a draft invoice', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /sales/quotes/q1': ok(quote('ACCEPTED')),
      'POST /sales/quotes/q1/convert': ok({ quote: quote('CONVERTED'), invoiceId: 'i1' }),
    });
    renderAt('/sales/quotes/q1');
    await user.click(await screen.findByRole('button', { name: 'Create draft invoice' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.pathname.endsWith('/convert'))).toBe(
        true,
      ),
    );
  });

  it('shows a viewer the quote without any action', async () => {
    stubApi({ ...common(['quotes.view']), 'GET /sales/quotes/q1': ok(quote('ACCEPTED')) });
    renderAt('/sales/quotes/q1');
    expect(await screen.findByText('Support')).toBeTruthy();
    for (const name of ['Create draft invoice', 'Mark as sent', 'Customer accepted']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });
});

describe('quotes list', () => {
  it('lists quotes with the customer name and creates one', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /sales/quotes': ok([quote('DRAFT')]),
      'POST /sales/quotes': ok(quote('DRAFT')),
    });
    renderAt('/sales/quotes');
    expect(await screen.findByRole('link', { name: 'QUO-00001' })).toBeTruthy();
    expect(screen.getAllByText('Sun Island Resort').length).toBeGreaterThan(0);
    await user.selectOptions(await screen.findByLabelText('Customer'), 'c1');
    await user.type(screen.getByLabelText('Description'), 'Support');
    await user.type(screen.getByLabelText('Unit price'), '500');
    await user.click(screen.getByRole('button', { name: 'Create quote' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/sales/quotes'))?.body,
      ).toMatchObject({
        customerId: 'c1',
        lines: [{ description: 'Support', quantity: '1', unitPrice: '500' }],
      }),
    );
  });
});

describe('recurring invoices', () => {
  const schedule = {
    id: 's1',
    name: 'Monthly support',
    customerId: 'c1',
    frequency: 'monthly',
    startDate: '2026-01-31',
    nextRunDate: '2026-02-28',
    endDate: null,
    status: 'ACTIVE',
    runCount: 1,
    lastError: null,
    version: 4,
  };

  it('pauses a schedule and creates the next draft on request', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /sales/recurring-invoices': ok([schedule]),
      'POST /sales/recurring-invoices/s1/pause': ok({ ...schedule, status: 'PAUSED' }),
      'POST /sales/recurring-invoices/s1/run-now': ok({ invoiceId: 'i1', schedule }),
    });
    renderAt('/sales/recurring');
    expect(await screen.findByText('Monthly support')).toBeTruthy();
    expect(screen.getByText('2026-02-28')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create next draft now' }));
    expect(await screen.findByText(/A draft invoice was created/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/pause'))?.body,
      ).toEqual({ version: 4 }),
    );
  });

  it('shows the reason a schedule was paused and hides management from viewers', async () => {
    stubApi({
      ...common(['recurring_invoices.view', 'customers.view']),
      'GET /sales/recurring-invoices': ok([
        { ...schedule, status: 'PAUSED', lastError: 'You do not have permission.' },
      ]),
    });
    renderAt('/sales/recurring');
    expect(await screen.findByText(/You do not have permission/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create schedule' })).toBeNull();
  });
});
