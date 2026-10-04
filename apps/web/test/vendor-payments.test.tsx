import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { ApprovalPanel } from '../src/features/sales/DocumentParts';
import { makeSession } from './fake-api';

/** Phase 4B-2: vendor payments, prepayments and credit application UI (server decides amounts). */

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
const created = (data: unknown) => () => ({ status: 201, body: { data } });

const ALL = [
  'vendor_payments.view',
  'vendor_payments.create',
  'vendor_payments.void',
  'vendor_payments.approve',
  'vendors.view',
  'bills.view',
  'accounting.journals.view',
];

const approval = {
  required: false,
  requestId: null,
  requestStatus: null,
  facts: { transactionType: 'payment', baseAmount: '150.00', baseCurrency: 'MVR' },
  appliedSteps: [],
  readyToIssue: true,
  approvalOutdated: false,
};

const payment = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  status: 'DRAFT',
  number: null,
  vendorId: 'ven-1',
  vendorName: 'Island Supplies',
  paymentDate: '2026-03-20',
  currencyCode: 'MVR',
  amount: '150.00',
  amountUnallocated: null,
  baseAmount: null,
  baseUnallocated: null,
  reference: null,
  version: 1,
  recordedAt: null,
  voidedAt: null,
  paymentAccountId: null,
  defaultPaymentAccountId: 'acc-1120',
  paymentAccountOverridden: null,
  rateOverride: null,
  rateOverrideReason: null,
  exchangeRate: '1.0000000000',
  exchangeRateSource: 'base',
  tableRate: null,
  memo: '',
  journalId: null,
  voidReason: null,
  voidJournalId: null,
  createdByUserId: 'u1',
  baseCurrency: 'MVR',
  plannedAllocations: [
    {
      billId: 'b1',
      billNumber: 'BILL-00001',
      billDate: '2026-03-10',
      billStatus: 'POSTED',
      billAmountDue: '100.00',
      amount: '100.00',
    },
  ],
  allocations: [],
  approval,
  warnings: [],
  ...overrides,
});

const recorded = (overrides: Record<string, unknown> = {}) =>
  payment({
    status: 'RECORDED',
    number: 'PAY-00001',
    version: 2,
    amountUnallocated: '50.00',
    baseAmount: '150.0000',
    baseUnallocated: '50.0000',
    paymentAccountId: 'acc-1120',
    paymentAccountOverridden: false,
    journalId: 'j1',
    allocations: [
      {
        id: 'a1',
        billId: 'b1',
        billNumber: 'BILL-00001',
        sourceType: 'payment',
        sourceId: 'p1',
        sourceNumber: 'PAY-00001',
        mode: 'payment',
        applicationId: null,
        allocationDate: '2026-03-20',
        currencyCode: 'MVR',
        amount: '100.00',
        baseRelieved: '100.0000',
        sourceBase: '100.0000',
        fxDifference: '0.0000',
        reversesAllocationId: null,
        journalId: 'j1',
      },
    ],
    ...overrides,
  });

const openBills = [
  {
    id: 'b2',
    number: 'BILL-00002',
    vendorReference: 'INV-2',
    billDate: '2026-03-11',
    dueDate: '2026-04-10',
    currencyCode: 'MVR',
    total: '80.00',
    amountDue: '80.00',
  },
];

const common = (permissions: string[]): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /approvals/requests': ok([]),
  'GET /accounting/setup': ok({ settings: { baseCurrency: 'MVR' } }),
  'GET /accounting/accounts': ok([]),
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('vendor payment list', () => {
  it('lists payments with the prepayment balance; view-only users cannot create', async () => {
    stubApi({
      ...common(['vendor_payments.view']),
      'GET /purchases/payments': ok({ items: [recorded()], nextCursor: null }),
    });
    renderAt('/purchases/payments');
    expect(await screen.findByRole('link', { name: 'PAY-00001' })).toBeTruthy();
    expect(screen.getByText('50.00')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New payment' })).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Purchases' });
    expect(within(nav).getByRole('link', { name: 'Payments' })).toBeTruthy();
  });
});

describe('vendor payment editor', () => {
  it('plans payments against open bills only, with one Idempotency-Key', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /vendors': ok({
        items: [{ id: 'ven-1', displayName: 'Island Supplies', currencyCode: 'MVR' }],
        nextCursor: null,
      }),
      'GET /purchases/payments/open-bills': ok(openBills),
      'POST /purchases/payments': created(payment()),
      'GET /purchases/payments/p1': ok(payment()),
    });
    renderAt('/purchases/payments/new');
    await user.selectOptions(await screen.findByLabelText('Vendor'), 'ven-1');
    await user.type(screen.getByLabelText('Amount paid'), '150');
    await user.type(await screen.findByLabelText('Pay on BILL-00002'), '80');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      vendorId: 'ven-1',
      paymentDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      amount: '150',
      paymentAccountId: null,
      rateOverride: null,
      rateOverrideReason: null,
      reference: null,
      memo: '',
      allocations: [{ billId: 'b2', amount: '80' }],
    });
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const query = calls.find((c) => c.url.pathname.endsWith('/open-bills'))!.url.searchParams;
    expect([query.get('vendorId'), query.get('currencyCode')]).toEqual(['ven-1', 'MVR']);
    expect(await screen.findByRole('heading', { name: 'Draft payment' })).toBeTruthy();
  });
});

describe('vendor payment detail', () => {
  it('records without re-authentication and shows the settlement with journal links', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /purchases/payments/p1': ok(payment()),
      'POST /purchases/payments/p1/record': ok(recorded()),
      'GET /purchases/payments/open-bills': ok(openBills),
    });
    renderAt('/purchases/payments/p1');
    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    expect(await screen.findByRole('heading', { name: 'Payment PAY-00001' })).toBeTruthy();
    const record = calls.find((c) => c.url.pathname.endsWith('/record'))!;
    expect(record.body).toEqual({ version: 1 });
    expect(record.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.some((c) => c.url.pathname.endsWith('/auth/reauthenticate'))).toBe(false);
    expect(screen.getAllByRole('link', { name: 'View journal' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'BILL-00001' })).toBeTruthy();
  });

  it('applies the prepayment balance to an open bill', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /purchases/payments/p1': ok(recorded()),
      'GET /purchases/payments/open-bills': ok(openBills),
      'POST /purchases/credit-applications': created({
        applicationId: 'app-1',
        amountApplied: '50.00',
      }),
    });
    renderAt('/purchases/payments/p1');
    await user.type(await screen.findByLabelText('Apply to BILL-00002'), '50');
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.pathname.endsWith('/credit-applications'))).toBe(true),
    );
    expect(calls.find((c) => c.url.pathname.endsWith('/credit-applications'))!.body).toMatchObject({
      sourceType: 'payment',
      sourceId: 'p1',
      allocations: [{ billId: 'b2', amount: '50' }],
    });
    expect(await screen.findByText('Applied 50.00 MVR.')).toBeTruthy();
  });

  it('voids a recorded payment with a reason; view-only users see no actions', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /purchases/payments/p1': ok(recorded()),
      'GET /purchases/payments/open-bills': ok(openBills),
      'POST /purchases/payments/p1/void': ok(recorded({ status: 'VOID' })),
    });
    renderAt('/purchases/payments/p1');
    await user.type(await screen.findByLabelText('Void reason'), 'Wrong vendor');
    await user.click(screen.getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/void'))).toBe(true));
    expect(calls.find((c) => c.url.pathname.endsWith('/void'))!.body).toEqual({
      version: 2,
      reason: 'Wrong vendor',
    });
  });

  it('shows no lifecycle actions to view-only users', async () => {
    stubApi({
      ...common(['vendor_payments.view']),
      'GET /purchases/payments/p1': ok(recorded()),
    });
    renderAt('/purchases/payments/p1');
    expect(await screen.findByRole('heading', { name: 'Payment PAY-00001' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply credit' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'View journal' })).toBeNull();
  });
});

describe('approval wording (context-aware ready message)', () => {
  const approved = {
    ...approval,
    required: true,
    requestId: 'r1',
    requestStatus: 'approved' as const,
    readyToIssue: true,
  };

  it('keeps the Sales wording by default and names the Purchases action when given', () => {
    const { unmount } = render(<ApprovalPanel approval={approved} />);
    expect(screen.getByText('Approved. The document can be issued.')).toBeTruthy();
    unmount();
    render(<ApprovalPanel approval={approved} readyMessage="purchases.approval.readyRecord" />);
    expect(screen.getByText('Approved. The payment can be recorded.')).toBeTruthy();
    expect(screen.queryByText(/can be issued/)).toBeNull();
  });

  it('tells the user an approved payment can be recorded', async () => {
    stubApi({
      ...common(ALL),
      'GET /purchases/payments/p1': ok(payment({ status: 'PENDING_APPROVAL', approval: approved })),
    });
    renderAt('/purchases/payments/p1');
    expect(await screen.findByText('Approved. The payment can be recorded.')).toBeTruthy();
    expect(screen.queryByText(/can be issued/)).toBeNull();
  });
});
