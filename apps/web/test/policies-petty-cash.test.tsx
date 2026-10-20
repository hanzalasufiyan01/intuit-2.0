import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Expense policies and petty cash pages (migrations 0092 and 0093). */

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

const accounts = [
  {
    id: 'a1',
    code: '1110',
    name: 'Cash',
    type: 'ASSET',
    subtype: 'CASH',
    status: 'ACTIVE',
    isLeaf: true,
  },
  {
    id: 'a2',
    code: '5400',
    name: 'Office costs',
    type: 'EXPENSE',
    subtype: 'OPERATING_EXPENSE',
    status: 'ACTIVE',
    isLeaf: true,
  },
];

describe('expense policies page', () => {
  it('lists policies and adds a limit with the action chosen', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({
          permissions: ['expenses.view', 'purchases.settings.manage', 'accounting.accounts.view'],
        }),
      ),
      'GET /accounting/accounts': ok(accounts),
      'GET /purchases/expense-policies': ok([
        {
          id: 'p1',
          name: 'Large expense',
          ruleType: 'max_amount',
          amount: '100',
          accountId: null,
          action: 'warn',
          status: 'ACTIVE',
          version: 1,
        },
      ]),
      'POST /purchases/expense-policies': () => ({ status: 201, body: { data: {} } }),
    });
    renderAt('/purchases/expense-policies');
    expect(await screen.findByText('Large expense')).toBeTruthy();
    await user.type(screen.getByLabelText('Name'), 'Hard cap');
    await user.type(screen.getByLabelText('Amount'), '500');
    await user.selectOptions(screen.getByLabelText('When broken'), 'block');
    await user.click(screen.getByRole('button', { name: 'Add policy' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/expense-policies'))
          ?.body,
      ).toEqual({ name: 'Hard cap', ruleType: 'max_amount', amount: '500', action: 'block' }),
    );
  });

  it('shows a viewer the policies but no form', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['expenses.view'] })),
      'GET /purchases/expense-policies': ok([]),
    });
    renderAt('/purchases/expense-policies');
    expect(await screen.findByText('No expense policies yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add policy' })).toBeNull();
  });
});

describe('petty cash page', () => {
  it('shows funds and counts, and records a count of the cash counted', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({
          permissions: [
            'banking.transactions.view',
            'banking.reconcile',
            'banking.accounts.manage',
            'accounting.accounts.view',
          ],
        }),
      ),
      'GET /accounting/accounts': ok(accounts),
      'GET /petty-cash/funds': ok([
        {
          id: 'f1',
          name: 'Front desk',
          accountId: 'a1',
          custodianName: 'Aisha',
          floatAmount: '1000',
          bookBalance: '950',
          status: 'ACTIVE',
          version: 1,
        },
      ]),
      'GET /petty-cash/counts': ok([]),
      'GET /petty-cash/settings': ok({ overShortAccountId: null, version: 0 }),
      'POST /petty-cash/funds/f1/counts': () => ({ status: 201, body: { data: {} } }),
    });
    renderAt('/banking/petty-cash');
    expect((await screen.findAllByText('Front desk')).length).toBeGreaterThan(0);
    await screen.findByRole('option', { name: 'Front desk' });
    await user.selectOptions(screen.getByLabelText('Fund'), 'f1');
    await user.type(screen.getByLabelText('Cash counted'), '940');
    await user.click(screen.getByRole('button', { name: 'Record count' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/f1/counts'))?.body,
      ).toMatchObject({
        countedAmount: '940',
      }),
    );
  });

  it('hides the count form without the reconcile permission', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['banking.transactions.view'] })),
      'GET /petty-cash/funds': ok([]),
      'GET /petty-cash/counts': ok([]),
      'GET /petty-cash/settings': ok({ overShortAccountId: null, version: 0 }),
    });
    renderAt('/banking/petty-cash');
    expect(await screen.findByText('No petty cash funds yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record count' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add fund' })).toBeNull();
  });
});
