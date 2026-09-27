import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { editorTotals } from '../src/features/accounting/JournalEditor';
import { makeSession } from './fake-api';

type Handler = (body: unknown) => { status: number; body?: unknown };

/** Minimal route-table fetch stub for UI behavior tests. */
function stubApi(routesTable: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] =
    [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = String(input)
        .replace(/^\/api\/v1/, '')
        .split('?')[0]!;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body, headers: (init.headers ?? {}) as Record<string, string> });
      const handler = routesTable[`${method} ${path}`];
      const result = handler
        ? handler(body)
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

const VIEW_ONLY = [
  'organization.read',
  'members.read',
  'accounting.accounts.view',
  'accounting.journals.view',
  'accounting.periods.view',
  'accounting.ledger.view',
];
const ALL_ACCOUNTING = [
  ...VIEW_ONLY,
  'accounting.setup',
  'accounting.journals.create',
  'accounting.journals.edit_draft',
  'accounting.journals.submit',
  'accounting.journals.approve',
  'accounting.journals.post',
  'accounting.journals.reverse',
];

const setupState = {
  isSetUp: true,
  settings: { baseCurrency: 'MVR', coaTemplateKey: 'maldives', baseCurrencyLocked: false },
  templates: [],
};
const accounts = [
  {
    id: 'a-cash',
    code: '1110',
    name: 'Cash on Hand',
    type: 'ASSET',
    parentId: null,
    status: 'ACTIVE',
    isSystem: true,
    isLeaf: true,
    usedInPostedJournals: false,
    description: '',
  },
  {
    id: 'a-sales',
    code: '4100',
    name: 'Sales Revenue',
    type: 'REVENUE',
    parentId: null,
    status: 'ACTIVE',
    isSystem: true,
    isLeaf: true,
    usedInPostedJournals: false,
    description: '',
  },
];

function draftJournal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    number: null,
    status: 'DRAFT',
    source: 'manual',
    entryDate: '2026-03-15',
    description: 'Cash sale',
    reference: '',
    currency: 'MVR',
    exchangeRate: null,
    exchangeRateSource: null,
    baseCurrency: null,
    totalDebit: null,
    totalBaseDebit: null,
    createdByUserId: 'someone-else',
    submittedByUserId: null,
    createdAt: '2026-03-15T00:00:00Z',
    postedAt: null,
    lines: [
      {
        lineNumber: 1,
        accountId: 'a-cash',
        description: '',
        debit: '100.0000',
        credit: null,
        baseDebit: null,
        baseCredit: null,
        roundingAdjustment: '0',
      },
      {
        lineNumber: 2,
        accountId: 'a-sales',
        description: '',
        debit: null,
        credit: '100.0000',
        baseDebit: null,
        baseCredit: null,
        roundingAdjustment: '0',
      },
    ],
    approval: null,
    approvalRequiredForPosting: false,
    reversedByJournalId: null,
    reversesJournalId: null,
    reversalReason: null,
    ...overrides,
  };
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('accounting UI permissions', () => {
  it('shows view-only users the accounting area without active actions', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: VIEW_ONLY })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/journals': ok([]),
      'GET /accounting/accounts': ok(accounts),
      'GET /accounting/journals/j1': ok(draftJournal()),
    });
    renderAt('/accounting/journals');
    expect(await screen.findByRole('heading', { level: 1, name: 'Journals' })).toBeTruthy();
    const subnav = screen.getByRole('navigation', { name: 'Accounting' });
    expect(within(subnav).getByText('General Ledger')).toBeTruthy();
    expect(within(subnav).queryByText('Setup')).toBeNull();
    expect(screen.queryByText('New journal')).toBeNull();
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByText('Accounting'),
    ).toBeTruthy();
  });

  it('offers workflow actions only when the user may perform them', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: VIEW_ONLY })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok(accounts),
      'GET /accounting/journals/j1': ok(draftJournal()),
    });
    renderAt('/accounting/journals/j1');
    expect(await screen.findByText('1110 Cash on Hand')).toBeTruthy();
    for (const label of ['Submit', 'Post', 'Edit draft', 'Reverse…']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('hides approval controls for the preparer of a pending journal', async () => {
    const session = makeSession({ permissions: ALL_ACCOUNTING });
    stubApi({
      'GET /auth/session': ok(session),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok(accounts),
      'GET /accounting/journals/j1': ok(
        draftJournal({
          status: 'PENDING_APPROVAL',
          createdByUserId: session.user.id,
          approval: {
            requestId: 'r1',
            status: 'pending',
            satisfied: false,
            steps: [],
            decisions: [],
          },
          approvalRequiredForPosting: true,
        }),
      ),
    });
    renderAt('/accounting/journals/j1');
    expect(await screen.findByText(/cannot approve it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Post' })).toBeNull();
  });
});

describe('sensitive actions', () => {
  it('asks for the password when re-authentication is required, then retries', async () => {
    const user = userEvent.setup();
    let reauthenticated = false;
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ALL_ACCOUNTING })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok(accounts),
      'GET /accounting/journals/j1': ok(draftJournal()),
      'POST /auth/reauthenticate': () => {
        reauthenticated = true;
        return ok(makeSession({ permissions: ALL_ACCOUNTING }))();
      },
      'POST /accounting/journals/j1/post': () =>
        reauthenticated
          ? { status: 200, body: { data: draftJournal({ status: 'POSTED', number: 7 }) } }
          : {
              status: 403,
              body: {
                error: {
                  code: 'REAUTHENTICATION_REQUIRED',
                  message: 'Confirm password',
                  requestId: 'r',
                },
              },
            },
    });
    renderAt('/accounting/journals/j1');
    await user.click(await screen.findByRole('button', { name: 'Post' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    await user.type(within(dialog).getByLabelText('Password'), 'my passphrase 123');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/accounting/journals/j1/post')).toHaveLength(2),
    );
    expect(calls.find((c) => c.path === '/auth/reauthenticate')?.body).toEqual({
      password: 'my passphrase 123',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('journal editor totals', () => {
  it('computes exact decimal totals and the balanced state', () => {
    const lines = [
      { accountId: 'a', description: '', debit: '0.1', credit: '' },
      { accountId: 'a', description: '', debit: '0.2', credit: '' },
      { accountId: 'b', description: '', debit: '', credit: '0.3' },
    ];
    const totals = editorTotals(lines);
    expect(totals.debit.toFixed()).toBe('0.3');
    expect(totals.balanced).toBe(true);
    expect(
      editorTotals([{ accountId: 'a', description: '', debit: '1', credit: '' }]).balanced,
    ).toBe(false);
    expect(
      editorTotals([{ accountId: 'a', description: '', debit: 'abc', credit: '' }]).debit.toFixed(),
    ).toBe('0');
  });

  it('shows the running balance state while editing', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ALL_ACCOUNTING })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok(accounts),
    });
    renderAt('/accounting/journals/new');
    await user.type(await screen.findByLabelText('Line 1 debit'), '10.10');
    expect(screen.getByText('Not balanced')).toBeTruthy();
    await user.type(screen.getByLabelText('Line 2 credit'), '10.1');
    expect(screen.getByTestId('total-debit').textContent).toBe('10.1');
    expect(screen.getByText('Balanced')).toBeTruthy();
  });
});
