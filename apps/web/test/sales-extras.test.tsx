import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { ShareLinksPanel } from '../src/features/sales/ExtraPages';
import { makeSession } from './fake-api';

/** Sales orders, payment reminders, invoice share links and the public invoice view (FP-28). */

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

const common = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /customers': ok({
    items: [{ id: 'c1', displayName: 'Sun Island Resort' }],
    nextCursor: null,
  }),
  'GET /sales/items': ok({ items: [], nextCursor: null }),
});

const order = (status: string) => ({
  id: 'o1',
  number: 'SO-00001',
  customerId: 'c1',
  orderDate: '2026-03-01',
  status,
  reference: null,
  netTotal: '1250',
  cancelReason: null,
  version: 2,
  lines: [
    {
      lineNo: 1,
      description: 'Consulting',
      quantity: '10',
      unitPrice: '100',
      netAmount: '1000',
      invoiced: '4',
      remaining: '6',
    },
  ],
});

describe('sales order page', () => {
  it('invoices the chosen quantities, and offers nothing to a viewer', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(['sales_orders.view', 'sales_orders.invoice', 'sales_orders.create']),
      'GET /sales/orders/o1': ok(order('PARTIALLY_INVOICED')),
      'POST /sales/orders/o1/invoice': ok({ invoiceId: 'i1' }),
    });
    renderAt('/sales/orders/o1');
    await user.type(await screen.findByLabelText('Quantity to invoice, line 1'), '3');
    await user.click(screen.getByRole('button', { name: 'Create draft invoice' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/invoice'))?.body,
      ).toEqual({ version: 2, lines: [{ lineNo: 1, quantity: '3' }] }),
    );
  });

  it('hides actions from a viewer', async () => {
    stubApi({ ...common(['sales_orders.view']), 'GET /sales/orders/o1': ok(order('CONFIRMED')) });
    renderAt('/sales/orders/o1');
    expect(await screen.findByText('Consulting')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create draft invoice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
  });
});

describe('reminders page', () => {
  const overdue = {
    invoiceId: 'i1',
    number: 'INV-00001',
    customerName: 'Sun Island Resort',
    hasEmail: true,
    currencyCode: 'MVR',
    dueDate: '2026-02-01',
    daysOverdue: 20,
    openAmount: '500',
    remindersSent: 0,
    lastReminderAt: null,
  };

  it('sends a reminder for an overdue invoice and confirms where it went', async () => {
    const user = userEvent.setup();
    stubApi({
      ...common(['payment_reminders.view', 'payment_reminders.send']),
      'GET /sales/reminders/overdue': ok([overdue]),
      'GET /sales/reminders/settings': ok({
        autoEnabled: false,
        firstAfterDays: 3,
        repeatEveryDays: 7,
        maxReminders: 3,
        version: 0,
      }),
      'POST /sales/reminders/invoices/i1/send': ok({ sentTo: 'ap@sunisland.test' }),
    });
    renderAt('/sales/reminders');
    await user.click(await screen.findByRole('button', { name: 'Send reminder' }));
    expect(await screen.findByText(/sent to ap@sunisland.test/)).toBeTruthy();
  });

  it('does not offer sending without an address or without the permission', async () => {
    stubApi({
      ...common(['payment_reminders.view']),
      'GET /sales/reminders/overdue': ok([{ ...overdue, hasEmail: false }]),
      'GET /sales/reminders/settings': ok({
        autoEnabled: false,
        firstAfterDays: 3,
        repeatEveryDays: 7,
        maxReminders: 3,
        version: 0,
      }),
    });
    renderAt('/sales/reminders');
    expect(await screen.findByText(/no e-mail/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send reminder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('public invoice page', () => {
  it('shows one invoice without any sign-in and says so plainly for a bad link', async () => {
    stubApi({
      'GET /auth/session': () => ({
        status: 401,
        body: { error: { code: 'UNAUTHENTICATED', message: 'no', requestId: 'r' } },
      }),
      'GET /public/invoices/good': ok({
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
        lines: [
          {
            description: 'Support',
            quantity: '1',
            unitPrice: '750',
            netAmount: '750',
            total: '750',
          },
        ],
      }),
    });
    renderAt('/p/invoice/good');
    expect(await screen.findByText('Invoice INV-00001')).toBeTruthy();
    expect(screen.getByText('Support')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
  });

  it('tells the visitor an unknown link is not valid', async () => {
    stubApi({
      'GET /auth/session': () => ({
        status: 401,
        body: { error: { code: 'UNAUTHENTICATED', message: 'no', requestId: 'r' } },
      }),
    });
    renderAt('/p/invoice/nope');
    expect(await screen.findByText(/This link is not valid/)).toBeTruthy();
  });
});

describe('share links panel', () => {
  it('shows the new link once and clears it when dismissed', async () => {
    const user = userEvent.setup();
    stubApi({
      ...common(['invoices.view', 'invoice_links.manage']),
      'GET /sales/invoices/i1/share-links': ok([]),
      'POST /sales/invoices/i1/share-links': () => ({
        status: 201,
        body: {
          data: {
            id: 'l1',
            status: 'active',
            expiresAt: '2026-04-01T00:00:00.000Z',
            viewCount: 0,
            lastViewedAt: null,
            url: 'https://app.test/p/invoice/SECRETTOKEN',
            token: 'SECRETTOKEN',
          },
        },
      }),
    });
    const router = createMemoryRouter(
      [{ path: '/', element: <ShareLinksPanel invoiceId="i1" /> }],
      {
        initialEntries: ['/'],
      },
    );
    render(<App router={router} queryClient={createQueryClient()} />);
    await user.click(await screen.findByRole('button', { name: 'Create link' }));
    const field = await screen.findByLabelText('Share link');
    expect((field as HTMLInputElement).value).toContain('SECRETTOKEN');
    await user.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByDisplayValue(/SECRETTOKEN/)).toBeNull();
  });

  it('shows nothing to someone without invoice_links.manage', async () => {
    stubApi({ ...common(['invoices.view']) });
    const router = createMemoryRouter(
      [{ path: '/', element: <ShareLinksPanel invoiceId="i1" /> }],
      {
        initialEntries: ['/'],
      },
    );
    render(<App router={router} queryClient={createQueryClient()} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Create link' })).toBeNull());
  });
});
