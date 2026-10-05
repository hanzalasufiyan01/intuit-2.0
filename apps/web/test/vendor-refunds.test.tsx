import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Phase 4B-3: vendor refunds UI (bank/cash only; void re-authenticated; payment void blocked). */

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
  'vendor_credits.view',
  'vendors.view',
  'accounting.accounts.view',
  'accounting.journals.view',
];

const refund = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'RECORDED',
  number: 'VR-00001',
  vendorId: 'ven-1',
  vendorName: 'Island Supplies',
  sourceType: 'payment',
  sourceId: 'p1',
  sourceNumber: 'PAY-00002',
  refundDate: '2026-03-20',
  currencyCode: 'MVR',
  amount: '50.00',
  baseAmount: '50.0000',
  baseReleased: '50.0000',
  fxDifference: '0.0000',
  reference: null,
  version: 1,
  voidedAt: null,
  refundAccountId: 'acc-1120',
  refundAccountOverridden: false,
  exchangeRate: '1.0000000000',
  exchangeRateSource: 'base',
  tableRate: null,
  rateOverrideReason: null,
  memo: '',
  journalId: 'j9',
  voidReason: null,
  voidJournalId: null,
  baseCurrency: 'MVR',
  ...overrides,
});

const payment = {
  id: 'p1',
  status: 'RECORDED',
  number: 'PAY-00002',
  vendorId: 'ven-1',
  vendorName: 'Island Supplies',
  paymentDate: '2026-03-10',
  currencyCode: 'MVR',
  amount: '250.00',
  amountUnallocated: '100.00',
  baseAmount: '250.0000',
  baseUnallocated: '100.0000',
  reference: null,
  version: 3,
  recordedAt: '2026-03-10T00:00:00Z',
  voidedAt: null,
  paymentAccountId: 'acc-1120',
  defaultPaymentAccountId: 'acc-1120',
  paymentAccountOverridden: false,
  rateOverride: null,
  rateOverrideReason: null,
  exchangeRate: '1.0000000000',
  exchangeRateSource: 'base',
  tableRate: null,
  memo: '',
  journalId: 'j1',
  voidReason: null,
  voidJournalId: null,
  createdByUserId: 'u1',
  baseCurrency: 'MVR',
  plannedAllocations: [],
  allocations: [],
  approval: {
    required: false,
    requestId: null,
    requestStatus: null,
    facts: null,
    appliedSteps: [],
    readyToIssue: false,
    approvalOutdated: false,
  },
  warnings: [],
};

const account = (id: string, code: string, subtype: string, currencyCode = 'MVR') => ({
  id,
  code,
  name: `${code} account`,
  description: '',
  type: subtype === 'CREDIT_CARD' ? 'LIABILITY' : 'ASSET',
  parentId: 'parent',
  status: 'ACTIVE',
  isSystem: false,
  isLeaf: true,
  usedInPostedJournals: false,
  currencyCode,
  subtype,
  isMonetary: true,
  isControlAccount: false,
  isBankOrCash: subtype !== 'CREDIT_CARD',
});

const common = (permissions: string[]): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /approvals/requests': ok([]),
  'GET /accounting/setup': ok({ settings: { baseCurrency: 'MVR' } }),
  'GET /accounting/accounts': ok([
    account('acc-1110', '1110', 'CASH'),
    account('acc-1120', '1120', 'BANK'),
    account('acc-2140', '2140', 'CREDIT_CARD'),
  ]),
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('vendor refund list', () => {
  it('lists refunds; view-only users cannot record them', async () => {
    stubApi({
      ...common(['vendor_payments.view']),
      'GET /purchases/refunds': ok({ items: [refund()], nextCursor: null }),
    });
    renderAt('/purchases/refunds');
    expect(await screen.findByRole('link', { name: 'VR-00001' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Record refund' })).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Purchases' });
    expect(within(nav).getByRole('link', { name: 'Refunds' })).toBeTruthy();
  });
});

describe('recording a refund', () => {
  it('records from a payment into bank or cash only, with one Idempotency-Key', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /purchases/payments': ok({ items: [payment], nextCursor: null }),
      'GET /purchases/vendor-credits': ok({ items: [], nextCursor: null }),
      'POST /purchases/refunds': created(refund()),
      'GET /purchases/refunds/r1': ok(refund()),
    });
    renderAt('/purchases/refunds/new?sourceType=payment&sourceId=p1');
    const source = (await screen.findByLabelText('Refunded from')) as HTMLSelectElement;
    await waitFor(() => expect(source.value).toBe('payment:p1'));
    // The credit card is not offered as a refund destination (4B-3 amendment).
    const accountSelect = screen.getByLabelText('Received into') as HTMLSelectElement;
    const options = [...accountSelect.options].map((o) => o.value);
    expect(options).toEqual(['', 'acc-1110', 'acc-1120']);
    await user.type(screen.getByLabelText('Amount refunded (MVR)'), '50');
    await user.selectOptions(accountSelect, 'acc-1110');
    await user.click(screen.getByRole('button', { name: 'Record refund' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      sourceType: 'payment',
      sourceId: 'p1',
      refundDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      amount: '50',
      refundAccountId: 'acc-1110',
      rateOverride: null,
      rateOverrideReason: null,
      reference: null,
      memo: '',
    });
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByRole('heading', { name: 'Refund VR-00001' })).toBeTruthy();
  });
});

describe('refund detail and payment interaction', () => {
  it('voids a refund with a reason and links its source and journal', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /purchases/refunds/r1': ok(refund()),
      'POST /purchases/refunds/r1/void': ok(refund({ status: 'VOID', version: 2 })),
    });
    renderAt('/purchases/refunds/r1');
    expect(await screen.findByRole('link', { name: /PAY-00002/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View journal' }).getAttribute('href')).toBe(
      '/accounting/journals/j9',
    );
    await user.type(screen.getByLabelText('Void reason'), 'Entered twice');
    await user.click(screen.getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/void'))).toBe(true));
    expect(calls.find((c) => c.url.pathname.endsWith('/void'))!.body).toEqual({
      version: 1,
      reason: 'Entered twice',
    });
  });

  it('blocks the payment void while a refund is active and lists the refund', async () => {
    stubApi({
      ...common(ALL),
      'GET /purchases/payments/p1': ok(payment),
      'GET /purchases/payments/open-bills': ok([]),
      'GET /purchases/refunds': ok({ items: [refund()], nextCursor: null }),
    });
    renderAt('/purchases/payments/p1');
    expect(
      await screen.findByText(
        'This payment has active refunds. Void the refunds taken from this payment first.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Void reason')).toBeNull();
    expect(screen.getByRole('link', { name: 'VR-00001' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Refund prepayment' }).getAttribute('href')).toBe(
      '/purchases/refunds/new?sourceType=payment&sourceId=p1',
    );
  });

  it('offers the payment void once its refunds are void', async () => {
    stubApi({
      ...common(ALL),
      'GET /purchases/payments/p1': ok(payment),
      'GET /purchases/payments/open-bills': ok([]),
      'GET /purchases/refunds': ok({ items: [refund({ status: 'VOID' })], nextCursor: null }),
    });
    renderAt('/purchases/payments/p1');
    expect(await screen.findByLabelText('Void reason')).toBeTruthy();
    expect(screen.queryByText(/has active refunds/)).toBeNull();
  });
});
