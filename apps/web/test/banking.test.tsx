import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Banking pages. The server decides; the pages list bank accounts and statement transactions, offer
 * Match / Categorize / Exclude only to users who hold the permission, and show the reconciliation
 * difference the server computes.
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

const account = {
  id: 'b1',
  accountId: 'a1',
  accountCode: '1120',
  accountName: 'Bank Accounts',
  name: 'Main account',
  currencyCode: 'MVR',
  status: 'ACTIVE',
  openingBalance: '1000.00',
  openingBalanceDate: '2026-03-01',
  bookBalance: '1100.00',
  unmatchedCount: 2,
  matchedCount: 5,
  excludedCount: 0,
  lastReconciledDate: null,
  lastReconciledBalance: null,
  version: 1,
};

const transaction = (id: string, status: string, amount: string, description: string) => ({
  id,
  bankingAccountId: 'b1',
  date: '2026-03-16',
  description,
  reference: null,
  amount,
  currencyCode: 'MVR',
  balance: null,
  status,
  excludedReason: null,
  match: null,
  suggestion: null,
});

const VIEW = ['banking.transactions.view'];
const WORK = [
  ...VIEW,
  'banking.transactions.match',
  'banking.transactions.categorize',
  'banking.transactions.import',
  'banking.reconcile',
];

const common = (
  permissions: string[],
  extra: Record<string, Handler> = {},
): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /banking/accounts': ok({ items: [account] }),
  'GET /banking/accounts/b1': ok(account),
  'GET /banking/accounts/b1/transactions': ok({
    items: [
      transaction('t1', 'UNMATCHED', '100.00', 'Customer deposit'),
      transaction('t2', 'UNMATCHED', '-45.50', 'Office supplies'),
    ],
    nextCursor: null,
  }),
  'GET /accounting/accounts': ok([]),
  ...extra,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe('bank accounts page', () => {
  it('lists the accounts with their book balance and what is left to match', async () => {
    stubApi(common(VIEW));
    renderAt('/banking');
    expect(await screen.findByRole('link', { name: 'Main account' })).toBeTruthy();
    expect(screen.getByText('1,100.00')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add bank account' })).toBeNull();
  });

  it('shows the add form only to those who may manage bank accounts', async () => {
    stubApi(common([...VIEW, 'banking.accounts.manage']));
    renderAt('/banking');
    expect(await screen.findByRole('button', { name: 'Add bank account' })).toBeTruthy();
  });
});

describe('bank account transactions', () => {
  it('offers Match, Categorize and Exclude to users who may, and nothing to a viewer', async () => {
    stubApi(common(WORK));
    renderAt('/banking/accounts/b1');
    expect(await screen.findByText('Customer deposit')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Match' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Categorize' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Exclude' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Auto-match' })).toBeTruthy();
  });

  it('hides the actions from a viewer', async () => {
    stubApi(common(VIEW));
    renderAt('/banking/accounts/b1');
    expect(await screen.findByText('Customer deposit')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Match' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Categorize' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Auto-match' })).toBeNull();
  });

  it('shows the posted entries with the same amount and matches the chosen one', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(WORK, {
        'GET /banking/transactions/t1/suggestions': ok({
          items: [
            {
              journalLineId: 'l1',
              journalId: 'j1',
              journalNumber: 7,
              date: '2026-03-15',
              description: 'Cash sale',
              reference: '',
              amount: '100.00',
              sourceModule: null,
              sourceType: null,
            },
          ],
        }),
        'POST /banking/transactions/t1/match': ok(
          transaction('t1', 'MATCHED', '100.00', 'Customer deposit'),
        ),
      }),
    );
    renderAt('/banking/accounts/b1');
    await screen.findByText('Customer deposit');
    await user.click(screen.getAllByRole('button', { name: 'Match' })[0]!);
    expect(await screen.findByText('Cash sale')).toBeTruthy();
    // Row 1's button, then the panel's button, then row 2's button.
    await user.click(screen.getAllByRole('button', { name: 'Match' })[1]!);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/transactions/t1/match'))
          ?.body,
      ).toEqual({ journalLineId: 'l1' }),
    );
  });
});

describe('reconciliation page', () => {
  it('shows the difference the server computes and only enables Finish when it balances', async () => {
    const user = userEvent.setup();
    const preview = (difference: string, canComplete: boolean) => ({
      statementDate: '2026-03-31',
      statementBalance: '850.00',
      openingBalance: '1000.00',
      openingFrom: null,
      clearedTotal: '-150.00',
      difference,
      bookBalance: '850.00',
      unmatchedCount: 0,
      canComplete,
      items: [],
    });
    let balanced = false;
    stubApi(
      common(WORK, {
        'GET /banking/accounts/b1/reconciliations': ok({ items: [] }),
        'POST /banking/accounts/b1/reconciliation/preview': () => ({
          status: 200,
          body: { data: balanced ? preview('0.00', true) : preview('-25.00', false) },
        }),
      }),
    );
    renderAt('/banking/accounts/b1/reconcile');
    const balance = await screen.findByLabelText(/Closing balance/);
    await user.type(balance, '850.00');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('-25.00')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Finish reconciliation' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    balanced = true;
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Finish reconciliation' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});
