import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Online payments (migration 0075): the staff page, the public pay button and the simulated checkout. */

type Handler = () => { status: number; body?: unknown };
function stubApi(table: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v1/, '');
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = table[`${method} ${path}`]?.() ?? {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } },
      };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}
const ok = (data: unknown) => () => ({ status: 200, body: { data } });
const unauthenticated = () => ({
  status: 401,
  body: { error: { code: 'UNAUTHENTICATED', message: 'no', requestId: 'r' } },
});
function renderAt(path: string) {
  render(
    <App
      router={createMemoryRouter(routes, { initialEntries: [path] })}
      queryClient={createQueryClient()}
    />,
  );
}

const payment = (status: string) => ({
  id: 'p1',
  invoiceId: 'i1',
  amount: '500',
  currencyCode: 'MVR',
  mode: 'mock',
  status,
  failureCode: null,
  receiptId: null,
  createdAt: '2026-03-01T10:00:00.000Z',
});
const staff = (permissions: string[], mode = 'mock') => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /payments/settings': ok({
    mode,
    intentTtlMinutes: 60,
    version: 1,
    available: { mock: true, live: false },
  }),
  'GET /payments/intents': ok([payment('PENDING'), payment('REQUIRES_REVIEW')]),
});
const ALL = [
  'organization.read',
  'payments.view',
  'payments.intents.create',
  'payments.reconcile',
  'payments.settings.manage',
];

describe('online payments page', () => {
  it('states that no real provider exists and offers recovery actions by status', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...staff(ALL),
      'POST /payments/intents/p1/reconcile': ok({}),
    });
    renderAt('/sales/online-payments');
    expect(await screen.findByText(/No real payment provider is configured/)).toBeTruthy();
    expect(screen.getByText(/Simulated provider \(no real money\)/)).toBeTruthy();
    expect(await screen.findByText('Waiting for payment')).toBeTruthy();
    expect(screen.getByText('Needs review')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'Check with provider' })[0]!);
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/payments/intents/p1/reconcile')).toBe(true),
    );
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1); // pending only
  });

  it('hides the switch and actions without permission', async () => {
    stubApi(staff(['organization.read', 'payments.view']));
    renderAt('/sales/online-payments');
    await screen.findByText('Waiting for payment');
    expect(screen.queryByRole('button', { name: 'Switch off' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check with provider' })).toBeNull();
  });
});

describe('public invoice payment', () => {
  const invoice = {
    organizationName: 'Atoll Trading',
    number: 'INV-00001',
    status: 'ISSUED',
    voided: false,
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-31',
    currencyCode: 'MVR',
    customerName: 'Sun Island Resort',
    taxTotal: '0',
    total: '750',
    amountDue: '750',
    lines: [],
  };
  const anon = {
    'GET /auth/session': unauthenticated,
    'GET /public/invoices/good': ok(invoice),
  };
  const state = (status: string) =>
    ok({
      payment: { id: 'p', status, amount: '750', currencyCode: 'MVR', checkoutUrl: null },
    });

  it('offers online payment while nothing was paid', async () => {
    stubApi({ ...anon, 'GET /public/invoices/good/payment': ok({ payment: null }) });
    renderAt('/p/invoice/good');
    expect(await screen.findByRole('button', { name: /Pay .* online/ })).toBeTruthy();
  });

  it('shows a paid state only when the server says so', async () => {
    stubApi({ ...anon, 'GET /public/invoices/good/payment': state('SUCCEEDED') });
    renderAt('/p/invoice/good');
    expect(await screen.findByText('Payment received. Thank you.')).toBeTruthy();
  });

  it('shows a processing notice for a payment under review without revealing why', async () => {
    stubApi({ ...anon, 'GET /public/invoices/good/payment': state('PROCESSING') });
    renderAt('/p/invoice/good');
    expect(await screen.findByText(/being processed/)).toBeTruthy();
  });
});

describe('simulated checkout', () => {
  it('is clearly labelled and sends the chosen outcome', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': unauthenticated,
      'POST /public/mock-pay/mock_ch_abc/settle': ok({ simulated: true, outcome: 'applied' }),
    });
    renderAt('/mock-pay/mock_ch_abc?return=%2Fp%2Finvoice%2Ftok123');
    expect(await screen.findByText(/No card is charged and no money moves/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Simulate successful payment' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ outcome: 'succeeded' }),
    );
    expect(await screen.findByRole('link', { name: 'Back to the invoice' })).toBeTruthy();
  });

  it('ignores a return address that is not an invoice link', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /auth/session': unauthenticated,
      'POST /public/mock-pay/mock_ch_abc/settle': ok({}),
    });
    renderAt('/mock-pay/mock_ch_abc?return=https%3A%2F%2Fevil.example');
    await user.click(await screen.findByRole('button', { name: 'Simulate declined payment' }));
    await screen.findByText(/Simulated result/);
    expect(screen.queryByRole('link', { name: 'Back to the invoice' })).toBeNull();
  });
});
