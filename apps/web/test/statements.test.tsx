import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';

/** The customer statement page (customer portal v1, migration 0076). */

function stubApi(table: Record<string, () => { status: number; body?: unknown }>) {
  const calls: { method: string; path: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v1/, '');
      calls.push({ method, path });
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

const statement = (payment: unknown = null) => ({
  organizationName: 'Atoll Trading',
  customerName: 'Sun Island Resort',
  asOf: '2026-03-10',
  balances: [{ currencyCode: 'MVR', amount: '650' }],
  invoices: [
    {
      id: 'i1',
      number: 'INV-00001',
      kind: 'invoice',
      dueDate: '2026-03-01',
      currencyCode: 'MVR',
      openAmount: '650',
      payment,
    },
  ],
  receipts: [
    {
      number: 'RCT-00001',
      receiptDate: '2026-03-05',
      currencyCode: 'MVR',
      amount: '100',
      reference: 'CHQ-77',
    },
  ],
});

describe('public statement', () => {
  it('shows the balance, invoices and receipts, and starts a payment on request', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': unauthenticated,
      'GET /public/statements/tok': ok(statement()),
      'POST /public/statements/tok/invoices/i1/pay': ok({ checkoutUrl: null }),
    });
    renderAt('/p/statement/tok');
    expect(await screen.findByText('Statement for Sun Island Resort')).toBeTruthy();
    expect(screen.getByText('INV-00001')).toBeTruthy();
    expect(screen.getByText('CHQ-77')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Pay online' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/i1/pay'))).toBe(true),
    );
  });

  it('shows processing instead of a pay button while a payment is under review', async () => {
    stubApi({
      'GET /auth/session': unauthenticated,
      'GET /public/statements/tok': ok(statement({ status: 'PROCESSING', checkoutUrl: null })),
    });
    renderAt('/p/statement/tok');
    expect(await screen.findByText('Payment processing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pay online' })).toBeNull();
  });

  it('says nothing is due for a settled customer and rejects an invalid link', async () => {
    stubApi({
      'GET /auth/session': unauthenticated,
      'GET /public/statements/tok': ok({
        ...statement(),
        balances: [],
        invoices: [],
        receipts: [],
      }),
    });
    renderAt('/p/statement/tok');
    expect(await screen.findByText('Nothing is due. Thank you.')).toBeTruthy();
    vi.unstubAllGlobals();
    stubApi({ 'GET /auth/session': unauthenticated });
    renderAt('/p/statement/nope');
    expect(await screen.findByText(/This link is not valid/)).toBeTruthy();
  });
});
