import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Phase 4A-5: the Bills workflow UI (permission-aware; every amount comes from the server). */

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

const ALL_BILLS = [
  'bills.view',
  'bills.create',
  'bills.edit_draft',
  'bills.delete_draft',
  'bills.post',
  'bills.void',
  'bills.approve',
  'vendors.view',
];

const vendor = {
  id: 'ven-1',
  partyId: 'party-1',
  kind: 'organization',
  displayName: 'Island Supplies',
  currencyCode: 'MVR',
  status: 'ACTIVE',
  version: 1,
};

const approval = {
  required: false,
  requestId: null,
  requestStatus: null,
  facts: { transactionType: 'standard', baseAmount: '100.00', baseCurrency: 'MVR' },
  appliedSteps: [],
  readyToIssue: true,
  approvalOutdated: false,
};

const bill = (overrides: Record<string, unknown> = {}) => ({
  id: 'bill-1',
  kind: 'standard',
  status: 'DRAFT',
  number: null,
  vendorId: 'ven-1',
  vendorName: 'Island Supplies',
  vendorReference: 'INV-778',
  billDate: '2026-03-10',
  dueDate: '2026-04-09',
  currencyCode: 'MVR',
  subtotal: '100.00',
  discountTotal: '0.00',
  taxTotal: '8.00',
  recoverableTaxTotal: '8.00',
  total: '108.00',
  amountDue: null,
  baseTotal: null,
  baseDue: null,
  version: 3,
  postedAt: null,
  voidedAt: null,
  paymentTermsDays: 30,
  exchangeRate: null,
  exchangeRateSource: null,
  tableRate: null,
  rateOverride: null,
  rateOverrideReason: null,
  taxTreatment: 'exclusive',
  discount: null,
  memo: '',
  dimensionValueIds: [],
  duplicateConfirmedReason: null,
  journalId: null,
  voidReason: null,
  voidJournalId: null,
  createdByUserId: 'u1',
  baseCurrency: 'MVR',
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      itemId: null,
      description: 'Paper',
      accountId: 'acc-5400',
      quantity: '1',
      unitPrice: '100',
      discount: null,
      amount: '100.00',
      netAmount: '100.00',
      taxCodeId: 'tax-gst',
      taxRate: '8',
      taxAmount: '8.00',
      taxRecoverable: true,
      taxRecoverableOverride: null,
      recoverableTax: '8.00',
      nonRecoverableTax: '0.00',
      inputTaxAccountId: null,
      total: '108.00',
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

describe('bills list', () => {
  it('opens Bills from Purchases and lists bills; view-only users cannot create', async () => {
    stubApi({
      ...common(['bills.view']),
      'GET /purchases/bills': ok({
        items: [bill({ status: 'POSTED', number: 'BILL-00001' })],
        nextCursor: null,
      }),
    });
    renderAt('/purchases');
    expect(await screen.findByRole('link', { name: 'BILL-00001' })).toBeTruthy();
    expect(screen.getByText('Posted', { selector: '.badge' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New bill' })).toBeNull();
    const sub = screen.getByRole('navigation', { name: 'Purchases' });
    expect(within(sub).getByRole('link', { name: 'Bills' })).toBeTruthy();
  });

  it('shows the approval queue and needs a reason to reject', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL_BILLS),
      'GET /purchases/bills': ok({ items: [], nextCursor: null }),
      'GET /approvals/requests': ok([
        {
          id: 'req-1',
          actionKey: 'purchases.bill.post',
          subjectType: 'purchases_bill',
          subjectId: 'bill-1',
          reason: null,
          createdAt: '2026-03-10T00:00:00Z',
          canDecide: true,
          progress: [{ order: 1, name: 'Manager', requiredApprovals: 1, approvals: 0 }],
          facts: { transactionType: 'standard', baseAmount: '800.00', baseCurrency: 'MVR' },
          appliedSteps: [],
        },
      ]),
      'POST /approvals/requests/req-1/reject': ok({}),
    });
    renderAt('/purchases/bills');
    expect(await screen.findByText('Bills awaiting your approval')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.type(screen.getByLabelText('Reason for rejecting'), 'Wrong vendor');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.pathname.endsWith('/req-1/reject'))).toBe(true),
    );
    expect(calls.find((c) => c.url.pathname.endsWith('/req-1/reject'))!.body).toEqual({
      comment: 'Wrong vendor',
    });
  });

  it('blocks the new-bill page without bills.create', async () => {
    stubApi(common(['bills.view']));
    renderAt('/purchases/bills/new');
    expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
  });
});

describe('bill editor', () => {
  it('creates a draft with the line inputs; amounts come from the server', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(ALL_BILLS),
      'GET /vendors': ok({ items: [vendor], nextCursor: null }),
      'GET /sales/items': ok({ items: [], nextCursor: null }),
      'GET /accounting/setup': ok({ settings: { baseCurrency: 'MVR' } }),
      'POST /purchases/bills': created(bill()),
      'GET /purchases/bills/bill-1': ok(bill()),
    });
    renderAt('/purchases/bills/new');
    await user.selectOptions(await screen.findByLabelText('Vendor'), 'ven-1');
    await user.type(screen.getByLabelText('Supplier invoice number'), 'INV-778');
    await user.type(screen.getByLabelText('Line 1 description'), 'Paper');
    await user.type(screen.getByLabelText('Line 1 unit price'), '100');
    await user.selectOptions(screen.getByLabelText('Line 1 tax recoverable'), 'false');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      vendorId: 'ven-1',
      vendorReference: 'INV-778',
      dueDate: null,
      rateOverride: null,
      lines: [{ description: 'Paper', quantity: '1', unitPrice: '100', taxRecoverable: false }],
    });
    expect(await screen.findByRole('heading', { name: 'Draft bill' })).toBeTruthy();
  });
});

describe('bill detail', () => {
  it('confirms a duplicate supplier reference with a reason before posting', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const calls = stubApi({
      ...common(ALL_BILLS),
      'GET /purchases/bills/bill-1': ok(bill()),
      'POST /purchases/bills/bill-1/post': (_url, body) => {
        attempts += 1;
        if (!(body as { duplicateReason?: string }).duplicateReason) {
          return {
            status: 409,
            body: {
              error: {
                code: 'DUPLICATE_VENDOR_REFERENCE',
                message: 'Another bill from this vendor already uses supplier reference INV-778.',
                requestId: 'r',
              },
            },
          };
        }
        return ok(
          bill({
            status: 'POSTED',
            number: 'BILL-00002',
            amountDue: '108.00',
            duplicateConfirmedReason: 'Second delivery',
          }),
        )();
      },
    });
    renderAt('/purchases/bills/bill-1');
    await user.click(await screen.findByRole('button', { name: 'Post' }));
    expect(await screen.findByText(/already uses supplier reference INV-778/)).toBeTruthy();
    await user.type(
      screen.getByLabelText('Reason to post a duplicate supplier invoice number'),
      'Second delivery',
    );
    await user.click(screen.getByRole('button', { name: 'Post anyway' }));
    expect(await screen.findByRole('heading', { name: 'Bill BILL-00002' })).toBeTruthy();
    expect(attempts).toBe(2);
    expect(calls.filter((c) => c.url.pathname.endsWith('/post')).at(-1)!.body).toEqual({
      version: 3,
      duplicateReason: 'Second delivery',
    });
  });

  it('submits when approval is needed and disables Post until approved', async () => {
    const user = userEvent.setup();
    const pending = bill({
      approval: { ...approval, required: true, readyToIssue: false },
    });
    const calls = stubApi({
      ...common(ALL_BILLS),
      'GET /purchases/bills/bill-1': ok(pending),
      'POST /purchases/bills/bill-1/submit': ok(
        bill({
          status: 'PENDING_APPROVAL',
          version: 4,
          approval: { ...approval, required: true, readyToIssue: false, requestStatus: 'pending' },
        }),
      ),
    });
    renderAt('/purchases/bills/bill-1');
    const postButton = await screen.findByRole('button', { name: 'Post' });
    expect(postButton).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/submit'))).toBe(true));
    expect(await screen.findByRole('button', { name: 'Withdraw' })).toBeTruthy();
  });

  it('voids an unpaid posted bill with a reason; view-only users see no actions', async () => {
    const user = userEvent.setup();
    const postedBill = bill({ status: 'POSTED', number: 'BILL-00001', amountDue: '108.00' });
    const calls = stubApi({
      ...common(ALL_BILLS),
      'GET /purchases/bills/bill-1': ok(postedBill),
      'POST /purchases/bills/bill-1/void': ok({
        ...postedBill,
        status: 'VOID',
        voidReason: 'Entered twice',
      }),
    });
    renderAt('/purchases/bills/bill-1');
    await user.type(await screen.findByLabelText('Void reason'), 'Entered twice');
    await user.click(screen.getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/void'))).toBe(true));
    expect(calls.find((c) => c.url.pathname.endsWith('/void'))!.body).toEqual({
      version: 3,
      reason: 'Entered twice',
    });
  });

  it('shows no lifecycle actions to view-only users', async () => {
    stubApi({ ...common(['bills.view']), 'GET /purchases/bills/bill-1': ok(bill()) });
    renderAt('/purchases/bills/bill-1');
    expect(await screen.findByRole('heading', { name: 'Draft bill' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
