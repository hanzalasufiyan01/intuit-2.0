import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Phase 4B-9: the direct-expense pages (ADR 0004 P4-44). The server decides; the pages follow the
 * document state (draft, pending, posted) and show each action only to users who hold its
 * permission.
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

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: 'e1',
  status: 'DRAFT',
  number: null,
  vendorId: 'ven-1',
  vendorName: 'Island Supplies',
  vendorReference: 'RCPT-9',
  expenseDate: '2026-03-10',
  currencyCode: 'MVR',
  paymentAccountId: null,
  subtotal: '100.00',
  discountTotal: '0.00',
  taxTotal: '0.00',
  recoverableTaxTotal: '0.00',
  total: '100.00',
  baseTotal: null,
  version: 1,
  postedAt: null,
  voidedAt: null,
  ...overrides,
});

const detail = (overrides: Record<string, unknown> = {}) => ({
  ...summary(),
  defaultPaymentAccountId: 'acc-1120',
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
  voidReason: null,
  voidJournalId: null,
  createdByUserId: 'u1',
  baseCurrency: 'MVR',
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      itemId: null,
      description: 'Taxi fare',
      accountId: 'acc-5400',
      quantity: '2',
      unitPrice: '50',
      discount: null,
      amount: '100.00',
      netAmount: '100.00',
      taxCodeId: null,
      taxRate: null,
      taxAmount: '0.00',
      taxRecoverable: false,
      taxRecoverableOverride: null,
      recoverableTax: '0.00',
      nonRecoverableTax: '0.00',
      inputTaxAccountId: null,
      total: '100.00',
      dimensionValueIds: [],
    },
  ],
  approval: {
    required: false,
    requestId: null,
    requestStatus: null,
    facts: { transactionType: 'expense', baseAmount: '100.00', baseCurrency: 'MVR' },
    appliedSteps: [],
    readyToIssue: true,
    approvalOutdated: false,
  },
  warnings: [],
  ...overrides,
});

const VIEW = ['expenses.view', 'vendors.view'];
const CREATE = [...VIEW, 'expenses.create'];
const VOID = [...VIEW, 'expenses.void'];

const common = (
  permissions: string[],
  extra: Record<string, Handler> = {},
): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /approvals/requests': ok([]),
  'GET /accounting/setup': ok({ settings: { baseCurrency: 'MVR' } }),
  'GET /accounting/accounts': ok([]),
  'GET /files': ok([]),
  ...extra,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('expenses list', () => {
  it('lists expenses and offers New expense only to those who can create', async () => {
    stubApi(
      common(VIEW, {
        'GET /purchases/expenses': ok({
          items: [summary(), summary({ id: 'e2', number: 'EXP-00001', status: 'POSTED' })],
          nextCursor: null,
        }),
      }),
    );
    renderAt('/purchases/expenses');
    expect(await screen.findByRole('link', { name: 'EXP-00001' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Draft' }).getAttribute('href')).toBe(
      '/purchases/expenses/e1',
    );
    expect(screen.queryByRole('link', { name: 'New expense' })).toBeNull();
  });

  it('shows the New expense link to a user with expenses.create', async () => {
    stubApi(common(CREATE, { 'GET /purchases/expenses': ok({ items: [], nextCursor: null }) }));
    renderAt('/purchases/expenses');
    expect(await screen.findByRole('link', { name: 'New expense' })).toBeTruthy();
    expect(await screen.findByText('No expenses match.')).toBeTruthy();
  });
});

const posted = detail({
  status: 'POSTED',
  number: 'EXP-00001',
  paymentAccountId: 'acc-1120',
  baseTotal: '100.0000',
  journalId: 'j1',
});

describe('expense detail', () => {
  it('posts a draft that needs no approval, sending its version', async () => {
    const user = userEvent.setup();
    let state: 'draft' | 'posted' = 'draft';
    const calls = stubApi(
      common(CREATE, {
        'GET /purchases/expenses/e1': () => ({
          status: 200,
          body: {
            data:
              state === 'draft'
                ? detail()
                : detail({
                    status: 'POSTED',
                    number: 'EXP-00001',
                    version: 2,
                    paymentAccountId: 'acc-1120',
                    baseTotal: '100.0000',
                  }),
          },
        }),
        'POST /purchases/expenses/e1/post': () => {
          state = 'posted';
          return { status: 200, body: { data: detail({ status: 'POSTED', number: 'EXP-00001' }) } };
        },
      }),
    );
    renderAt('/purchases/expenses/e1');
    await user.click(await screen.findByRole('button', { name: 'Post expense' }));
    await waitFor(() => expect(screen.getByText(/Expense EXP-00001/)).toBeTruthy());
    const posted = calls.find((c) => c.method === 'POST')!;
    expect(posted.url.pathname.endsWith('/purchases/expenses/e1/post')).toBe(true);
    expect(posted.body).toEqual({ version: 1 });
  });

  it('asks for a reason when the supplier reference is already used, then posts with it', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const calls = stubApi(
      common(CREATE, {
        'GET /purchases/expenses/e1': ok(
          detail({
            warnings: [
              {
                code: 'DUPLICATE_VENDOR_REFERENCE',
                message:
                  'Another expense or bill from this vendor has the same supplier reference.',
              },
            ],
          }),
        ),
        'POST /purchases/expenses/e1/post': () => {
          attempts += 1;
          return attempts === 1
            ? {
                status: 409,
                body: {
                  error: {
                    code: 'DUPLICATE_VENDOR_REFERENCE',
                    message:
                      'Another expense from this vendor already uses supplier reference R-1.',
                    requestId: 'r',
                  },
                },
              }
            : { status: 200, body: { data: detail({ status: 'POSTED', number: 'EXP-00002' }) } };
        },
      }),
    );
    renderAt('/purchases/expenses/e1');
    await user.click(await screen.findByRole('button', { name: 'Post expense' }));
    expect(await screen.findByText('Possible duplicate')).toBeTruthy();
    await user.type(
      screen.getByLabelText('Reason to post a duplicate supplier invoice number'),
      'Second receipt',
    );
    await user.click(screen.getByRole('button', { name: /Post anyway/i }));
    await waitFor(() => {
      const posts = calls.filter((c) => c.method === 'POST');
      expect(posts.at(-1)?.body).toEqual({ version: 1, duplicateReason: 'Second receipt' });
    });
  });

  it('disables posting until a required approval is ready, and offers submit', async () => {
    stubApi(
      common(CREATE, {
        'GET /purchases/expenses/e1': ok(
          detail({
            approval: {
              required: true,
              requestId: null,
              requestStatus: null,
              facts: { transactionType: 'expense', baseAmount: '900.00', baseCurrency: 'MVR' },
              appliedSteps: [{ order: 1, name: 'Finance manager', requiredApprovals: 1 }],
              readyToIssue: false,
              approvalOutdated: false,
            },
          }),
        ),
      }),
    );
    renderAt('/purchases/expenses/e1');
    const post = await screen.findByRole('button', { name: 'Post expense' });
    expect((post as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Submit for approval' })).toBeTruthy();
  });

  it('shows the void form to a user with expenses.void', async () => {
    stubApi(common(VOID, { 'GET /purchases/expenses/e1': ok(posted) }));
    renderAt('/purchases/expenses/e1');
    expect(await screen.findByRole('button', { name: 'Void expense' })).toBeTruthy();
  });

  it('shows a viewer a posted expense without void, edit or post actions', async () => {
    stubApi(common(VIEW, { 'GET /purchases/expenses/e1': ok(posted) }));
    renderAt('/purchases/expenses/e1');
    await waitFor(() => expect(screen.getAllByText(/Expense EXP-00001/).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Void expense' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Post expense' })).toBeNull();
  });
});
