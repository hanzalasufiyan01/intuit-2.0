import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Phase 4B-1: the vendor credit / debit note UI (permission-aware; amounts from the server). */

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
const created = (data: unknown) => () => ({ status: 201, body: { data } });

const ALL = [
  'vendor_credits.view',
  'vendor_credits.create',
  'vendor_credits.post',
  'vendor_credits.void',
  'vendor_credits.approve',
  'vendors.view',
  'bills.view',
];

const approval = {
  required: false,
  requestId: null,
  requestStatus: null,
  facts: { transactionType: 'debit_note', baseAmount: '40.00', baseCurrency: 'MVR' },
  appliedSteps: [],
  readyToIssue: true,
  approvalOutdated: false,
};

const credit = (overrides: Record<string, unknown> = {}) => ({
  id: 'vc-1',
  origin: 'debit_note',
  status: 'DRAFT',
  number: null,
  vendorId: 'ven-1',
  vendorName: 'Island Supplies',
  billId: null,
  billNumber: null,
  vendorReference: null,
  creditDate: '2026-03-12',
  currencyCode: 'MVR',
  subtotal: '40.00',
  discountTotal: '0.00',
  taxTotal: '0.00',
  recoverableTaxTotal: '0.00',
  total: '40.00',
  amountUnapplied: null,
  baseTotal: null,
  baseUnapplied: null,
  version: 2,
  postedAt: null,
  voidedAt: null,
  exchangeRate: null,
  exchangeRateSource: null,
  tableRate: null,
  rateOverride: null,
  rateOverrideReason: null,
  taxTreatment: 'exclusive',
  discount: null,
  memo: '',
  dimensionValueIds: [],
  journalId: null,
  pdfFileId: null,
  voidReason: null,
  voidJournalId: null,
  createdByUserId: 'u1',
  baseCurrency: 'MVR',
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      itemId: null,
      description: 'Short delivery',
      accountId: 'acc-5400',
      quantity: '1',
      unitPrice: '40',
      discount: null,
      amount: '40.00',
      netAmount: '40.00',
      taxCodeId: null,
      taxRate: null,
      taxAmount: '0.00',
      taxRecoverable: false,
      taxRecoverableOverride: null,
      recoverableTax: '0.00',
      nonRecoverableTax: '0.00',
      inputTaxAccountId: null,
      total: '40.00',
      dimensionValueIds: [],
    },
  ],
  approval,
  warnings: [],
  ...overrides,
});

const common = (permissions: string[]): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /tax/codes': ok([]),
  'GET /approvals/requests': ok([]),
  'GET /files': ok([]),
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('vendor credit list', () => {
  it('lists credits with their type; view-only users cannot create', async () => {
    stubApi({
      ...common(['vendor_credits.view']),
      'GET /purchases/vendor-credits': ok({
        items: [credit({ status: 'POSTED', number: 'DN-00001', amountUnapplied: '40.00' })],
        nextCursor: null,
      }),
    });
    renderAt('/purchases');
    expect(await screen.findByRole('link', { name: 'DN-00001' })).toBeTruthy();
    expect(screen.getAllByText('Debit note').length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'New vendor credit' })).toBeNull();
    const sub = screen.getByRole('navigation', { name: 'Purchases' });
    expect(within(sub).getByRole('link', { name: 'Vendor credits' })).toBeTruthy();
  });
});

describe('vendor credit editor', () => {
  it('creates a debit note with the origin; amounts come from the server', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /vendors': ok({
        items: [{ id: 'ven-1', displayName: 'Island Supplies', currencyCode: 'MVR' }],
        nextCursor: null,
      }),
      'GET /sales/items': ok({ items: [], nextCursor: null }),
      'GET /purchases/bills': ok({ items: [], nextCursor: null }),
      'GET /accounting/setup': ok({ settings: { baseCurrency: 'MVR' } }),
      'POST /purchases/vendor-credits': created(credit()),
      'GET /purchases/vendor-credits/vc-1': ok(credit()),
    });
    renderAt('/purchases/vendor-credits/new');
    await user.selectOptions(await screen.findByLabelText('Type'), 'debit_note');
    // Debit notes carry our own number: no supplier reference field.
    expect(screen.queryByLabelText('Supplier credit-note number')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Vendor'), 'ven-1');
    await user.type(screen.getByLabelText('Line 1 description'), 'Short delivery');
    await user.type(screen.getByLabelText('Line 1 unit price'), '40');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      origin: 'debit_note',
      vendorId: 'ven-1',
      billId: null,
      vendorReference: null,
      lines: [{ description: 'Short delivery', quantity: '1', unitPrice: '40' }],
    });
    expect(await screen.findByRole('heading', { name: 'Draft Debit note' })).toBeTruthy();
  });
});

describe('vendor credit detail', () => {
  it('posts with the version and shows the debit-note PDF and email panel', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL),
      'GET /purchases/vendor-credits/vc-1': ok(credit()),
      'POST /purchases/vendor-credits/vc-1/post': ok(
        credit({ status: 'POSTED', number: 'DN-00001', amountUnapplied: '40.00', version: 3 }),
      ),
      'GET /purchases/vendor-credits/vc-1/pdf': ok({
        status: 'ready',
        download: { url: '/api/v1/files/content?token=t' },
      }),
      'GET /purchases/vendor-credits/vc-1/emails': ok([]),
      'POST /purchases/vendor-credits/vc-1/email': () => ({
        status: 202,
        body: { data: { id: 'e1', status: 'queued' } },
      }),
    });
    renderAt('/purchases/vendor-credits/vc-1');
    await user.click(await screen.findByRole('button', { name: 'Post' }));
    expect(await screen.findByRole('heading', { name: 'Debit note DN-00001' })).toBeTruthy();
    expect(calls.find((c) => c.url.pathname.endsWith('/post'))!.body).toEqual({ version: 2 });
    expect(await screen.findByRole('link', { name: 'Download PDF' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Email debit note' }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/email'))).toBe(true));
  });

  it('keeps checking while the debit-note PDF is being prepared', async () => {
    let pdfCalls = 0;
    stubApi({
      ...common(ALL),
      'GET /purchases/vendor-credits/vc-1': ok(
        credit({ status: 'POSTED', number: 'DN-00001', amountUnapplied: '40.00' }),
      ),
      'GET /purchases/vendor-credits/vc-1/pdf': () => {
        pdfCalls += 1;
        return {
          status: 200,
          body: {
            data:
              pdfCalls === 1
                ? { status: 'pending' }
                : { status: 'ready', download: { url: '/api/v1/files/content?token=t' } },
          },
        };
      },
      'GET /purchases/vendor-credits/vc-1/emails': ok([]),
    });
    renderAt('/purchases/vendor-credits/vc-1');
    expect(await screen.findByText('The PDF is being prepared.')).toBeTruthy();
    expect(
      await screen.findByRole('link', { name: 'Download PDF' }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(pdfCalls).toBeGreaterThanOrEqual(2);
  }, 10000);

  it('voids an unapplied credit with a reason; view-only users see no actions', async () => {
    const user = userEvent.setup();
    const postedCredit = credit({
      origin: 'supplier_credit_note',
      vendorReference: 'CN-7',
      status: 'POSTED',
      number: 'VC-00001',
      amountUnapplied: '40.00',
    });
    const calls = stubApi({
      ...common(ALL),
      'GET /purchases/vendor-credits/vc-1': ok(postedCredit),
      'POST /purchases/vendor-credits/vc-1/void': ok({ ...postedCredit, status: 'VOID' }),
    });
    renderAt('/purchases/vendor-credits/vc-1');
    await user.type(await screen.findByLabelText('Void reason'), 'Entered twice');
    await user.click(screen.getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/void'))).toBe(true));
    expect(calls.find((c) => c.url.pathname.endsWith('/void'))!.body).toEqual({
      version: 2,
      reason: 'Entered twice',
    });
  });

  it('shows no lifecycle actions to view-only users', async () => {
    stubApi({
      ...common(['vendor_credits.view']),
      'GET /purchases/vendor-credits/vc-1': ok(credit()),
    });
    renderAt('/purchases/vendor-credits/vc-1');
    expect(await screen.findByRole('heading', { name: 'Draft Debit note' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });
});
