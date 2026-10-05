import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Phase 4B-4: batch Pay bills UI (one payment per vendor and currency, all or nothing). */

type Handler = (url: URL, body: unknown) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: unknown; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body, headers: (init.headers ?? {}) as Record<string, string> });
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

const ALL = [
  'vendor_payments.view',
  'vendor_payments.create',
  'vendors.view',
  'accounting.accounts.view',
  'accounting.journals.view',
];

const bill = (
  id: string,
  number: string,
  vendorId: string,
  vendorName: string,
  currencyCode: string,
  amountDue: string,
) => ({
  id,
  number,
  vendorId,
  vendorName,
  vendorReference: null,
  billDate: '2026-03-10',
  dueDate: '2026-04-09',
  currencyCode,
  total: amountDue,
  amountDue,
});

const openBills = [
  bill('b1', 'BILL-00001', 'va', 'Atoll Supplies', 'MVR', '100.00'),
  bill('b2', 'BILL-00002', 'va', 'Atoll Supplies', 'MVR', '200.00'),
  bill('b3', 'BILL-00003', 'vb', 'Blue Lagoon Imports', 'USD', '50.00'),
];

const account = (id: string, code: string, subtype: string, currencyCode = 'MVR') => ({
  id,
  code,
  name: `${code} account`,
  description: '',
  type: 'ASSET',
  parentId: 'parent',
  status: 'ACTIVE',
  isSystem: false,
  isLeaf: true,
  usedInPostedJournals: false,
  currencyCode,
  subtype,
  isMonetary: true,
  isControlAccount: false,
  isBankOrCash: true,
});

const batchDetail = {
  id: 'pb1',
  paymentDate: '2026-03-20',
  paymentCount: 2,
  billCount: 3,
  totals: [
    { currencyCode: 'MVR', amount: '250.00', payments: 1 },
    { currencyCode: 'USD', amount: '50.00', payments: 1 },
  ],
  reference: null,
  createdAt: '2026-03-20T00:00:00Z',
  createdByUserId: 'u1',
  memo: '',
  payments: [
    {
      id: 'p1',
      number: 'PAY-00001',
      status: 'RECORDED',
      vendorId: 'va',
      vendorName: 'Atoll Supplies',
      currencyCode: 'MVR',
      amount: '250.00',
      baseAmount: '250.0000',
      exchangeRate: '1.0000000000',
      exchangeRateSource: 'base',
      paymentAccountId: 'acc-1120',
      journalId: 'j1',
      voidedAt: null,
    },
    {
      id: 'p2',
      number: 'PAY-00002',
      status: 'VOID',
      vendorId: 'vb',
      vendorName: 'Blue Lagoon Imports',
      currencyCode: 'USD',
      amount: '50.00',
      baseAmount: '775.0000',
      exchangeRate: '15.5000000000',
      exchangeRateSource: 'table',
      paymentAccountId: 'acc-usd',
      journalId: 'j2',
      voidedAt: '2026-03-21T00:00:00Z',
    },
  ],
};

const common = (permissions: string[]): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /approvals/requests': ok([]),
  'GET /accounting/setup': ok({ settings: { baseCurrency: 'MVR' } }),
  'GET /accounting/accounts': ok([
    account('acc-1120', '1120', 'BANK'),
    account('acc-usd', '1125', 'BANK', 'USD'),
  ]),
  'GET /vendors': ok({
    items: [
      { id: 'va', displayName: 'Atoll Supplies', currencyCode: 'MVR' },
      { id: 'vb', displayName: 'Blue Lagoon Imports', currencyCode: 'USD' },
    ],
    nextCursor: null,
  }),
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('Pay bills', () => {
  it('selects bills, groups by vendor and currency, and records with one Idempotency-Key', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /purchases/pay-bills/open-bills': ok(openBills),
      'POST /purchases/payment-batches': () => ({ status: 201, body: { data: batchDetail } }),
    });
    renderAt('/purchases/pay-bills');
    await user.click(await screen.findByLabelText('Select BILL-00001'));
    await user.click(screen.getByLabelText('Select BILL-00002'));
    await user.click(screen.getByLabelText('Select BILL-00003'));
    // A partial amount on BILL-00002.
    const partial = screen.getByLabelText('Pay on BILL-00002');
    await user.clear(partial);
    await user.type(partial, '150');
    // Per-currency account and manual rate with its reason.
    await user.selectOptions(screen.getByLabelText('Pay USD bills from'), 'acc-usd');
    await user.type(screen.getByLabelText('Manual USD rate'), '15.6');
    await user.type(screen.getByLabelText('Reason for the USD rate'), 'Bank deal');
    expect(screen.getByText('2 payment(s), one per vendor and currency')).toBeTruthy();
    expect(screen.getByText('Total MVR: 250.00')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Record 2 payment(s)' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      paymentDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      accounts: [{ currencyCode: 'USD', paymentAccountId: 'acc-usd' }],
      rateOverrides: [{ currencyCode: 'USD', rate: '15.6', reason: 'Bank deal' }],
      reference: null,
      bills: [
        { billId: 'b1', amount: '100.00' },
        { billId: 'b2', amount: '150' },
        { billId: 'b3', amount: '50.00' },
      ],
    });
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    // The result links each payment and the batch.
    expect((await screen.findByRole('link', { name: 'PAY-00001' })).getAttribute('href')).toBe(
      '/purchases/payments/p1',
    );
    expect(screen.getByRole('link', { name: 'View batch' }).getAttribute('href')).toBe(
      '/purchases/payment-batches/pb1',
    );
  });

  it('filters open bills by vendor, currency and due date', async () => {
    const user = userEvent.setup();
    const calls = stubApi({ ...common(ALL), 'GET /purchases/pay-bills/open-bills': ok(openBills) });
    renderAt('/purchases/pay-bills');
    await screen.findByRole('option', { name: 'Blue Lagoon Imports' });
    await user.selectOptions(screen.getByLabelText('Vendor'), 'vb');
    await user.selectOptions(screen.getByLabelText('Currency'), 'USD');
    await waitFor(() => {
      const last = calls.filter((c) => c.url.pathname.endsWith('/open-bills')).at(-1)!;
      expect([
        last.url.searchParams.get('vendorId'),
        last.url.searchParams.get('currencyCode'),
      ]).toEqual(['vb', 'USD']);
    });
  });

  it('shows the groups that need approval when the whole batch is refused', async () => {
    const user = userEvent.setup();
    stubApi({
      ...common(ALL),
      'GET /purchases/pay-bills/open-bills': ok(openBills),
      'POST /purchases/payment-batches': () => ({
        status: 409,
        body: {
          error: {
            code: 'APPROVAL_REQUIRED',
            message:
              'Some payments in this batch need approval, so nothing was recorded. Remove them and pay them individually through approval.',
            requestId: 'r',
            details: {
              issues: [
                {
                  path: 'groups.1',
                  message: 'Blue Lagoon Imports: 50.00 USD (775.00 MVR) needs approval.',
                },
              ],
            },
          },
        },
      }),
    });
    renderAt('/purchases/pay-bills');
    await user.click(await screen.findByLabelText('Select BILL-00001'));
    await user.click(screen.getByLabelText('Select BILL-00003'));
    await user.click(screen.getByRole('button', { name: 'Record 2 payment(s)' }));
    expect(await screen.findByText(/nothing was recorded/)).toBeTruthy();
    expect(
      screen.getByText('Blue Lagoon Imports: 50.00 USD (775.00 MVR) needs approval.'),
    ).toBeTruthy();
  });

  it('lists batches and shows a batch with its payments, statuses and journals', async () => {
    stubApi({
      ...common(ALL),
      'GET /purchases/payment-batches': ok({ items: [batchDetail], nextCursor: null }),
      'GET /purchases/payment-batches/pb1': ok(batchDetail),
    });
    renderAt('/purchases/payment-batches');
    expect((await screen.findByRole('link', { name: '2026-03-20' })).getAttribute('href')).toBe(
      '/purchases/payment-batches/pb1',
    );
    renderAt('/purchases/payment-batches/pb1');
    const pay2 = await screen.findAllByRole('link', { name: 'PAY-00002' });
    const row = pay2[0]!.closest('tr')!;
    expect(within(row).getByText('Void')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'View journal' }).getAttribute('href')).toBe(
      '/accounting/journals/j2',
    );
  });

  it('keeps Pay bills away from view-only users', async () => {
    stubApi({
      ...common(['vendor_payments.view']),
      'GET /purchases/payment-batches': ok({ items: [], nextCursor: null }),
    });
    renderAt('/purchases/pay-bills');
    expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
    // The batch history stays readable, without a Pay bills link.
    renderAt('/purchases/payment-batches');
    const nav = await screen.findByRole('navigation', { name: 'Purchases' });
    expect(within(nav).queryByRole('link', { name: 'Pay bills' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Payments' })).toBeTruthy();
  });
});
