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
    approvalFacts: { transactionType: 'manual', baseAmount: '100', baseCurrency: 'MVR' },
    approvalSteps: [],
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
          approvalFacts: { transactionType: 'manual', baseAmount: '100', baseCurrency: 'MVR' },
          approvalSteps: [],
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

describe('account classification and system accounts (Phase 3A)', () => {
  const classified = [
    {
      ...accounts[0],
      currencyCode: 'MVR',
      subtype: 'CASH',
      isMonetary: true,
      isControlAccount: false,
      isBankOrCash: true,
    },
    {
      ...accounts[1],
      currencyCode: 'MVR',
      subtype: null,
      isMonetary: false,
      isControlAccount: false,
      isBankOrCash: false,
    },
    {
      id: 'a-re',
      code: '3200',
      name: 'Retained Earnings',
      type: 'EQUITY',
      parentId: null,
      status: 'ACTIVE',
      isSystem: true,
      isLeaf: true,
      usedInPostedJournals: false,
      description: '',
      currencyCode: 'MVR',
      subtype: 'EQUITY',
      isMonetary: false,
      isControlAccount: false,
      isBankOrCash: false,
    },
  ];
  const designations = [
    {
      designation: 'RETAINED_EARNINGS',
      accountId: null,
      allowedTypes: ['EQUITY'],
      updatedAt: null,
    },
    {
      designation: 'ROUNDING_DIFFERENCE',
      accountId: null,
      allowedTypes: ['REVENUE', 'EXPENSE'],
      updatedAt: null,
    },
  ];

  it('shows classification and currency, and sends subtype and currency on create', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: [...ALL_ACCOUNTING, 'accounting.accounts.create'] }),
      ),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok(classified),
      'POST /accounting/accounts': () => ({ status: 201, body: { data: classified[0] } }),
    });
    renderAt('/accounting/accounts');
    expect(await screen.findByText('Cash · monetary')).toBeTruthy();
    expect(screen.getByText('Unclassified', { selector: 'td' })).toBeTruthy();

    await user.type(screen.getByLabelText('Code'), '2520');
    await user.type(screen.getByLabelText('Name'), 'USD loan');
    await user.selectOptions(screen.getByLabelText('Type'), 'LIABILITY');
    await user.selectOptions(screen.getByLabelText('Subtype'), 'LONG_TERM_LIABILITY');
    await user.click(screen.getByLabelText(/Monetary/));
    await user.type(screen.getByLabelText('Currency'), 'usd');
    await user.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.path === '/accounting/accounts'),
      ).toBeTruthy(),
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      code: '2520',
      type: 'LIABILITY',
      subtype: 'LONG_TERM_LIABILITY',
      isMonetary: true,
      currencyCode: 'USD',
    });
  });

  it('offers the explicit monetary choice on other asset subtypes (S9 amendment)', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: [...ALL_ACCOUNTING, 'accounting.accounts.create'] }),
      ),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok(classified),
    });
    renderAt('/accounting/accounts');
    await screen.findByText('Cash · monetary');
    await user.selectOptions(screen.getByLabelText('Type'), 'ASSET');
    for (const subtype of ['OTHER_CURRENT_ASSET', 'OTHER_ASSET']) {
      await user.selectOptions(screen.getByLabelText('Subtype'), subtype);
      const monetary = screen.getByLabelText(/Monetary/) as HTMLInputElement;
      expect(monetary.checked).toBe(false);
    }
    await user.selectOptions(screen.getByLabelText('Subtype'), 'FIXED_ASSET');
    expect(screen.queryByLabelText(/Monetary/)).toBeNull();
  });

  it('lets accounting.setup holders designate eligible accounts only', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ALL_ACCOUNTING })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok(classified),
      'GET /accounting/designations': ok(designations),
      'PUT /accounting/designations': ok(designations),
    });
    renderAt('/accounting/designations');
    const select = await screen.findByLabelText('Retained Earnings');
    const options = within(select as HTMLElement)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Not designated', '3200 Retained Earnings']);
    await user.selectOptions(select, 'a-re');
    await user.click(screen.getByRole('button', { name: 'Save designations' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ RETAINED_EARNINGS: 'a-re' }),
    );
  });

  it('shows designations read-only without accounting.setup', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: VIEW_ONLY })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok(classified),
      'GET /accounting/designations': ok(designations),
    });
    renderAt('/accounting/designations');
    expect(await screen.findByRole('heading', { level: 1, name: 'System Accounts' })).toBeTruthy();
    expect((await screen.findAllByText('Not designated')).length).toBe(2);
    expect(screen.queryByRole('combobox', { name: 'Retained Earnings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save designations' })).toBeNull();
  });
});

describe('dimensions (Phase 3A S2)', () => {
  const revenueAccount = {
    ...accounts[1],
    currencyCode: 'MVR',
    subtype: 'OPERATING_REVENUE',
    isMonetary: false,
    isControlAccount: false,
    isBankOrCash: false,
  };
  const cashAccount = {
    ...accounts[0],
    currencyCode: 'MVR',
    subtype: 'CASH',
    isMonetary: true,
    isControlAccount: false,
    isBankOrCash: true,
  };
  const department = {
    id: 't-dept',
    code: 'DEPT',
    name: 'Department',
    description: '',
    isRequired: true,
    scope: { accountTypes: ['REVENUE'], accountSubtypes: [] },
    status: 'ACTIVE',
    values: [
      {
        id: 'v-sales',
        dimensionTypeId: 't-dept',
        code: 'SALES',
        name: 'Sales',
        status: 'ACTIVE',
        archivedAt: null,
      },
      {
        id: 'v-old',
        dimensionTypeId: 't-dept',
        code: 'OLD',
        name: 'Old',
        status: 'ARCHIVED',
        archivedAt: '2026-01-01T00:00:00Z',
      },
    ],
  };
  const WITH_DIMENSIONS = [...ALL_ACCOUNTING, 'accounting.dimensions.view'];
  const validationError = (message: string, issues: { path: string; message: string }[]) => ({
    status: 400,
    body: { error: { code: 'VALIDATION_FAILED', message, requestId: 'r', details: { issues } } },
  });

  it('lets dimension managers create a required type with an account scope', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: [...WITH_DIMENSIONS, 'accounting.dimensions.manage'] }),
      ),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/dimensions': ok([]),
      'POST /accounting/dimensions': () => ({ status: 201, body: { data: department } }),
    });
    renderAt('/accounting/dimensions');
    await user.type(await screen.findByLabelText('Code'), 'DEPT');
    await user.type(screen.getByLabelText('Name'), 'Department');
    await user.click(screen.getByLabelText('Required'));
    await user.click(screen.getByLabelText('REVENUE'));
    await user.click(screen.getByLabelText('Operating Expense'));
    await user.click(screen.getByRole('button', { name: 'Add dimension' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      code: 'DEPT',
      name: 'Department',
      description: '',
      isRequired: true,
      scope: { accountTypes: ['REVENUE'], accountSubtypes: ['OPERATING_EXPENSE'] },
    });
  });

  it('shows dimensions read-only without accounting.dimensions.manage', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: WITH_DIMENSIONS })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/dimensions': ok([department]),
    });
    renderAt('/accounting/dimensions');
    expect(await screen.findByText('Required for REVENUE')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add dimension' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add value' })).toBeNull();
  });

  it('offers line-level dimension selects, marks in-scope requirements and never auto-assigns', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: WITH_DIMENSIONS })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok([cashAccount, revenueAccount]),
      'GET /accounting/dimensions': ok([department]),
      'POST /accounting/journals': () =>
        validationError('The request is invalid.', [
          { path: 'lines.1.dimensions', message: 'Sales is archived and cannot be assigned.' },
        ]),
    });
    renderAt('/accounting/journals/new');
    const line2Dept = await screen.findByLabelText('Line 2 Department');
    // No header-level dimension control exists (Decision 85).
    expect(screen.queryByLabelText('Department')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Line 1 account'), 'a-cash');
    await user.selectOptions(screen.getByLabelText('Line 2 account'), 'a-sales');
    const optionTexts = (label: string) =>
      within(screen.getByLabelText(label))
        .getAllByRole('option')
        .map((o) => o.textContent);
    // Archived values are not offered for new assignments; the requirement is shown only
    // for the in-scope (revenue) line.
    expect(optionTexts('Line 2 Department')).toEqual([
      'Department (required): none',
      'Department: Sales',
    ]);
    expect(optionTexts('Line 1 Department')[0]).toBe('Department: none');

    await user.type(screen.getByLabelText('Line 1 debit'), '10');
    await user.type(screen.getByLabelText('Line 2 credit'), '10');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeTruthy());
    const first = calls.find((c) => c.method === 'POST')?.body as {
      lines: { dimensions: unknown[] }[];
    };
    expect(first.lines.map((l) => l.dimensions)).toEqual([[], []]);
    expect(first).not.toHaveProperty('dimensions');

    await user.selectOptions(line2Dept, 'v-sales');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    const second = calls.filter((c) => c.method === 'POST')[1]!.body as {
      lines: { dimensions: unknown[] }[];
    };
    expect(second.lines[1]!.dimensions).toEqual([
      { dimensionTypeId: 't-dept', dimensionValueId: 'v-sales' },
    ]);
    expect(await screen.findByText('Sales is archived and cannot be assigned.')).toBeTruthy();
  });

  it('shows line dimensions and missing required dimensions with their line', async () => {
    const user = userEvent.setup();
    const base = draftJournal();
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: WITH_DIMENSIONS })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok([cashAccount, revenueAccount]),
      'GET /accounting/dimensions': ok([department]),
      'GET /accounting/journals/j1': ok(
        draftJournal({
          lines: [
            { ...base.lines[0], dimensions: [] },
            {
              ...base.lines[1],
              dimensions: [
                {
                  dimensionTypeId: 't-dept',
                  dimensionValueId: 'v-sales',
                  typeCode: 'DEPT',
                  typeName: 'Department',
                  valueCode: 'SALES',
                  valueName: 'Sales',
                },
              ],
            },
          ],
        }),
      ),
      'POST /accounting/journals/j1/submit': () =>
        validationError('Required dimensions are missing.', [
          { path: 'lines.0.dimensions', message: 'Project is required for this account.' },
        ]),
    });
    renderAt('/accounting/journals/j1');
    expect(await screen.findByText('Department: Sales')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(/Line 1: Project is required for this account\./)).toBeTruthy();
  });

  it('labels dimension-filtered ledger results as tagged activity only', async () => {
    const user = userEvent.setup();
    const ledgerUrls: string[] = [];
    const filtered = () => (ledgerUrls.at(-1) ?? '').includes('dimensionValueIds=');
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: WITH_DIMENSIONS })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok([cashAccount, revenueAccount]),
      'GET /accounting/dimensions': ok([department]),
      'GET /accounting/ledger': () =>
        ok({
          baseCurrency: 'MVR',
          openingBalance: null,
          totals: { baseDebit: '0', baseCredit: '0' },
          truncated: false,
          rows: [],
          taggedActivityOnly: filtered(),
          dimensionFilter: filtered()
            ? [{ dimensionTypeId: 't-dept', typeName: 'Department', valueName: 'Sales' }]
            : [],
        })(),
    });
    const stubbed = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/accounting/ledger')) ledgerUrls.push(String(input));
      return stubbed(input, init);
    });
    renderAt('/accounting/ledger');
    await user.selectOptions(await screen.findByLabelText('Department'), 'v-sales');
    expect(await screen.findByText(/Tagged activity only/)).toBeTruthy();
    expect(ledgerUrls.at(-1)).toContain('dimensionValueIds=v-sales');
  });
});

describe('dimension view permission in the journal editor (Decision 91)', () => {
  it('omits dimension fields for users without accounting.dimensions.view', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ALL_ACCOUNTING })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok(accounts),
      // The server omits dimension details for this user.
      'GET /accounting/journals/j1': ok(draftJournal()),
      'PATCH /accounting/journals/j1': () => ({ status: 200, body: { data: draftJournal() } }),
    });
    renderAt('/accounting/journals/j1');
    await user.click(await screen.findByRole('button', { name: 'Edit draft' }));
    expect(screen.queryByLabelText('Line 1 Department')).toBeNull();
    expect(calls.some((c) => c.path === '/accounting/dimensions')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeTruthy());
    const body = calls.find((c) => c.method === 'PATCH')!.body as { lines: object[] };
    // Omitted (not []), so the server keeps any existing assignments.
    for (const l of body.lines) expect(l).not.toHaveProperty('dimensions');
  });
});
