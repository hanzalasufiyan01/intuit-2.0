import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import type { OpeningBatchDetail } from '../src/features/accounting/types';
import { makeSession } from './fake-api';

/** S8 UI: opening balances grid, preview, workflow (approval, re-auth), reversal, read-only. */

type Result = { status: number; body?: unknown };
type Handler = (url: URL, body: unknown) => Result;

function stubApi(table: Record<string, Handler | Handler[]>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const cursors = new Map<string, number>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const path = url.pathname.replace(/^\/api\/v1/, '');
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      const entry = table[key];
      let handler: Handler | undefined;
      if (Array.isArray(entry)) {
        const i = cursors.get(key) ?? 0;
        cursors.set(key, i + 1);
        handler = entry[Math.min(i, entry.length - 1)];
      } else handler = entry;
      const result = handler
        ? handler(url, body)
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

afterEach(() => vi.unstubAllGlobals());

const ok =
  (data: unknown): Handler =>
  () => ({ status: 200, body: { data } });
const fail =
  (status: number, code: string, message: string, issues?: unknown[]): Handler =>
  () => ({
    status,
    body: { error: { code, message, requestId: 'r', ...(issues ? { details: { issues } } : {}) } },
  });

const WRITER = [
  'accounting.setup',
  'accounting.journals.view',
  'accounting.accounts.view',
  'accounting.dimensions.view',
];
const READER = ['accounting.journals.view'];

const acct = (id: string, code: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  code,
  name,
  description: '',
  type: 'ASSET',
  parentId: null,
  status: 'ACTIVE',
  isSystem: false,
  isLeaf: true,
  usedInPostedJournals: false,
  currencyCode: 'MVR',
  subtype: 'CASH',
  isMonetary: true,
  isControlAccount: false,
  isBankOrCash: true,
  ...extra,
});
const accounts = [
  acct('a1100', '1100', 'Cash and Bank', { isLeaf: false }),
  acct('a1110', '1110', 'Cash on Hand'),
  acct('a1125', '1125', 'Bank USD', { currencyCode: 'USD', subtype: 'BANK' }),
  acct('a1130', '1130', 'Accounts Receivable', { subtype: 'ACCOUNTS_RECEIVABLE' }),
  acct('a3100', '3100', "Owner's Capital", { type: 'EQUITY', subtype: 'EQUITY' }),
  acct('a3900', '3900', 'Opening Balance Equity', { type: 'EQUITY', subtype: 'EQUITY' }),
  acct('a4100', '4100', 'Sales', { type: 'REVENUE', subtype: 'OPERATING_REVENUE' }),
  acct('a1190', '1190', 'Old suspense', { subtype: null, isMonetary: false, isBankOrCash: false }),
];

function batch(overrides: Partial<OpeningBatchDetail> = {}): OpeningBatchDetail {
  return {
    id: 'b1',
    status: 'DRAFT',
    conversionDate: '2026-04-01',
    openingDate: '2026-03-31',
    version: 3,
    notes: '',
    approvalRequestId: null,
    createdAt: '2026-09-29T08:00:00Z',
    updatedAt: '2026-09-29T08:00:00Z',
    submittedAt: null,
    postedAt: null,
    reversedAt: null,
    reversalReason: null,
    baseCurrency: 'MVR',
    lines: [
      {
        id: 'l1',
        lineNumber: 1,
        accountId: 'a1110',
        accountCode: '1110',
        accountName: 'Cash on Hand',
        currency: 'MVR',
        description: '',
        debit: '500',
        credit: null,
        baseAmount: null,
        dimensions: [],
      },
    ],
    totals: [
      {
        currency: 'MVR',
        lines: 1,
        debit: '500',
        credit: '0',
        openingBalanceEquity: { side: 'credit', amount: '500' },
      },
    ],
    approval: {
      required: false,
      requestId: null,
      requestStatus: null,
      steps: [],
      facts: { transactionType: 'opening_balance', baseAmount: '500', baseCurrency: 'MVR' },
      appliedSteps: [],
      readyToPost: true,
    },
    journals: [],
    ...overrides,
  };
}

function baseApi(permissions: string[], detail: OpeningBatchDetail | Handler[] = batch()) {
  return {
    'GET /auth/session': ok(makeSession({ permissions })),
    'GET /accounting/setup': ok({ isSetUp: true }),
    'GET /accounting/accounts': ok(accounts),
    'GET /accounting/dimensions': ok([]),
    'GET /accounting/designations': ok([
      {
        designation: 'OPENING_BALANCE_EQUITY',
        accountId: 'a3900',
        allowedTypes: ['EQUITY'],
        updatedAt: null,
      },
    ]),
    'GET /accounting/opening-balances': ok({
      conversionDate: '2026-04-01',
      openingDate: '2026-03-31',
      batches: [batch()],
    }),
    'GET /accounting/opening-balances/b1': Array.isArray(detail) ? detail : ok(detail),
    'GET /files': ok([]),
  } satisfies Record<string, Handler | Handler[]>;
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('opening balances grid', () => {
  it('lists eligible accounts per currency, totals them with the OBE result and saves filled lines', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...baseApi(WRITER),
      'PUT /accounting/opening-balances/b1/lines': [
        fail(400, 'VALIDATION_FAILED', 'Some opening balances need attention.', [
          { path: 'lines.1.accountId', message: 'Check this account.' },
        ]),
        ok(batch({ version: 4 })),
      ],
    });
    renderAt('/accounting/opening-balances');
    const grid = await screen.findByRole('table', { name: 'MVR opening balances' });
    expect(within(grid).getByText(/1110 Cash on Hand/)).toBeTruthy();
    // Receivable, OBE, parent and (by default) income accounts are not offered.
    expect(within(grid).queryByText(/1130/)).toBeNull();
    expect(within(grid).queryByText(/3900/)).toBeNull();
    expect(within(grid).queryByText(/1100 Cash and Bank/)).toBeNull();
    expect(within(grid).queryByText(/4100/)).toBeNull();
    // S10: no step applies to this batch, so it can be posted directly.
    expect(screen.getByTestId('approval-requirement').textContent).toMatch(
      /No approval is required to post these balances.*Opening balances · 500.00 MVR/,
    );
    // S8-07 final ruling: unclassified accounts are not offered, and the page says why.
    expect(within(grid).queryByText(/1190/)).toBeNull();
    expect(screen.getByRole('note').textContent).toMatch(/1 account has no subtype/);
    expect(screen.getByText(/Opening Balance Equity \(MVR\):/).textContent).toMatch(/500.*credit/);

    await user.type(screen.getByLabelText('Credit 3100'), '200');
    expect(screen.getByText(/Opening Balance Equity \(MVR\):/).textContent).toMatch(/300.*credit/);
    await user.click(screen.getByRole('checkbox', { name: /Show income and expense accounts/ }));
    expect(within(grid).getByText(/4100 Sales/)).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'USD' }));
    const usd = screen.getByRole('table', { name: 'USD opening balances' });
    expect(within(usd).getByText('Base amount (MVR)')).toBeTruthy();
    await user.type(screen.getByLabelText('Debit 1125'), '100');
    await user.type(screen.getByLabelText('Base amount 1125'), '1542');

    await user.click(screen.getByRole('button', { name: 'Save balances' }));
    expect(await screen.findByText('Check this account.')).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({
      version: 3,
      lines: [
        {
          accountId: 'a1110',
          description: '',
          debit: '500',
          credit: null,
          baseAmount: null,
          dimensions: [],
        },
        {
          accountId: 'a1125',
          description: '',
          debit: '100',
          credit: null,
          baseAmount: '1542',
          dimensions: [],
        },
        {
          accountId: 'a3100',
          description: '',
          debit: null,
          credit: '200',
          baseAmount: null,
          dimensions: [],
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Save balances' }));
    expect(await screen.findByText('Opening balances saved.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Import from CSV' }).getAttribute('href')).toBe(
      '/imports?domain=opening_balances',
    );
    expect(document.querySelector('.table-scroll table')).toBeTruthy();
  });

  it('previews the per-currency journals and explains blocking errors', async () => {
    const user = userEvent.setup();
    stubApi({
      ...baseApi(WRITER),
      'POST /accounting/opening-balances/b1/preview': [
        ok({
          batchId: 'b1',
          version: 3,
          openingDate: '2026-03-31',
          baseCurrency: 'MVR',
          errors: [
            { path: 'openingDate', message: 'No fiscal year covers the opening date 2025-12-31.' },
          ],
          warnings: [],
          approval: batch().approval,
          journals: [],
        }),
        ok({
          batchId: 'b1',
          version: 3,
          openingDate: '2026-03-31',
          baseCurrency: 'MVR',
          errors: [],
          warnings: [{ path: 'posting', message: 'Posting fixes the base currency.' }],
          approval: batch().approval,
          journals: [
            {
              currency: 'USD',
              rate: '15.42',
              rateSource: 'table',
              accountLines: 1,
              totals: { debit: '100', credit: '100', baseDebit: null, baseCredit: null },
              openingBalanceEquity: { side: 'credit', amount: '100', baseAmount: null },
              lines: [
                {
                  accountId: 'a1125',
                  accountCode: '1125',
                  accountName: 'Bank USD',
                  description: '',
                  debit: '100',
                  credit: null,
                  baseDebit: null,
                  baseCredit: null,
                },
                {
                  accountId: 'a3900',
                  accountCode: '3900',
                  accountName: 'Opening Balance Equity',
                  description: '',
                  debit: null,
                  credit: '100',
                  baseDebit: null,
                  baseCredit: null,
                },
              ],
            },
          ],
        }),
      ],
    });
    renderAt('/accounting/opening-balances');
    await user.click(await screen.findByRole('button', { name: 'Preview journals' }));
    expect(await screen.findByText(/No fiscal year covers/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Preview journals' }));
    expect(await screen.findByText(/USD journal — rate 15.42 from the rate table/)).toBeTruthy();
    expect(screen.getByText('Posting fixes the base currency.')).toBeTruthy();
    expect(screen.getByText('The opening balances are ready.')).toBeTruthy();
  });
});

describe('opening balances workflow', () => {
  it('posts after re-authentication and links the journals', async () => {
    const user = userEvent.setup();
    const posted = batch({
      status: 'POSTED',
      version: 4,
      postedAt: '2026-09-29T09:00:00Z',
      approval: { ...batch().approval, readyToPost: false },
      journals: [
        {
          id: 'j1',
          journalNumber: 7,
          currency: 'MVR',
          status: 'POSTED',
          entryDate: '2026-03-31',
          totalDebit: '500.0000',
          totalBaseDebit: '500.0000',
          exchangeRate: '1',
          exchangeRateSource: 'base',
        },
      ],
    });
    const calls = stubApi({
      ...baseApi(WRITER, [ok(batch()), ok(posted)]),
      'POST /accounting/opening-balances/b1/post': [
        fail(403, 'REAUTHENTICATION_REQUIRED', 'Please confirm your password to continue.'),
        ok(posted),
      ],
      'POST /auth/reauthenticate': ok(makeSession({ permissions: WRITER })),
    });
    renderAt('/accounting/opening-balances');
    await user.click(await screen.findByRole('button', { name: 'Post opening balances' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    await user.type(within(dialog).getByLabelText('Password'), 'correct horse battery staple');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('link', { name: 'Journal #7 (MVR)' })).toBeTruthy();
    expect(calls.filter((c) => c.path === '/accounting/opening-balances/b1/post')).toHaveLength(2);
    expect(calls.find((c) => c.path === '/accounting/opening-balances/b1/post')!.body).toEqual({
      version: 3,
    });
    // Posted: read-only lines, a reversal form that needs a reason.
    expect(screen.queryByRole('button', { name: 'Save balances' })).toBeNull();
    const reverse = screen.getByRole('button', { name: 'Reverse opening batch' });
    expect(reverse).toHaveProperty('disabled', true);
  });

  it('submits for approval when a policy applies and shows the approval status', async () => {
    const user = userEvent.setup();
    const pending = batch({
      status: 'PENDING_APPROVAL',
      version: 4,
      approvalRequestId: 'r1',
      approval: {
        required: true,
        requestId: 'r1',
        requestStatus: 'pending',
        steps: [{ name: 'Admin review', requiredApprovals: 1, approvals: 0, satisfied: false }],
        facts: { transactionType: 'opening_balance', baseAmount: '500', baseCurrency: 'MVR' },
        appliedSteps: [],
        readyToPost: false,
      },
    });
    const calls = stubApi({
      ...baseApi(WRITER, [
        ok(
          batch({
            approval: {
              required: true,
              requestId: null,
              requestStatus: null,
              steps: [],
              facts: { transactionType: 'opening_balance', baseAmount: '500', baseCurrency: 'MVR' },
              appliedSteps: [],
              readyToPost: false,
            },
          }),
        ),
        ok(pending),
      ]),
      'POST /accounting/opening-balances/b1/submit': ok(pending),
    });
    renderAt('/accounting/opening-balances');
    expect(screen.queryByRole('button', { name: 'Post opening balances' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Submit for approval' }));
    expect(await screen.findByText('Admin review: 0/1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/submit'))!.body).toEqual({ version: 3 });
  });
});

describe('read-only access', () => {
  it('shows balances without any write action to journal viewers', async () => {
    stubApi(baseApi(READER));
    renderAt('/accounting/opening-balances');
    expect(await screen.findByText('Cash on Hand', { exact: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save balances' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Post opening balances' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save date' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preview journals' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Import from CSV' })).toBeNull();
    expect(screen.queryByLabelText('Debit 1110')).toBeNull();
    await waitFor(() => expect(screen.getByText(/Opening Balance Equity 500/)).toBeTruthy());
  });
});
