import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** Phase 3A S10: conditional approval policies, requirement display and the approval queue. */

type Handler = (body: unknown) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = String(input)
        .replace(/^\/api\/v1/, '')
        .split('?')[0]!;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const handler = table[`${method} ${path}`];
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

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

afterEach(() => vi.unstubAllGlobals());

const actions = [
  {
    actionKey: 'accounting.journal.post',
    label: 'Approve journals before posting',
    approverPermission: 'accounting.journals.approve',
    conditions: { amount: true, transactionTypes: ['manual', 'imported', 'accounting_event'] },
  },
  {
    actionKey: 'accounting.opening_balance.post',
    label: 'Approve opening balances before posting',
    approverPermission: 'accounting.journals.approve',
    conditions: { amount: true, transactionTypes: ['opening_balance'] },
  },
  {
    actionKey: 'accounting.period.reopen',
    label: 'Reopen a closed accounting period',
    approverPermission: 'accounting.periods.reopen',
    conditions: { amount: false, transactionTypes: ['period_reopen'] },
  },
];
const roles = [{ id: 'role-admin', name: 'Administrator' }];

describe('approval policy editor (S10)', () => {
  it('edits amount bands and transaction types and sends only known fields', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['approvals.manage', 'roles.read', 'members.read'] }),
      ),
      'GET /approvals/policies': ok({
        actions,
        baseCurrency: 'MVR',
        policies: [
          {
            actionKey: 'accounting.journal.post',
            steps: [
              {
                name: 'Supervisor',
                requiredApprovals: 1,
                roleIds: ['role-admin'],
                membershipIds: [],
                conditions: {
                  minBaseAmount: '10000',
                  maxBaseAmount: null,
                  transactionTypes: null,
                  thresholdCurrency: 'MVR',
                },
              },
            ],
          },
        ],
      }),
      'GET /organizations/current/roles': ok(roles),
      'GET /organizations/current/members': ok([]),
      'PUT /approvals/policies/accounting.journal.post': ok({ steps: [] }),
    });
    renderAt('/settings/approvals');
    const journals = (await screen.findByText('Approve journals before posting')).closest(
      'section, .card, div',
    ) as HTMLElement;
    expect(screen.getByTestId('step-summary-accounting.journal.post-1').textContent).toMatch(
      /Applies to: amount of 10,000.00 MVR or more/,
    );
    expect(within(journals).getAllByText(/no step applies to needs no approval/)).toBeTruthy();

    await user.click(within(journals).getByRole('button', { name: 'Add step' }));
    const upTo = within(journals).getAllByLabelText(/Up to, not including \(MVR\)/)[1]!;
    await user.type(upTo, '500');
    await user.click(within(journals).getAllByLabelText('Imported journals')[1]!);
    expect(screen.getByTestId('step-summary-accounting.journal.post-2').textContent).toMatch(
      /amount under 500.00 MVR; Imported journals/,
    );
    await user.click(within(journals).getAllByRole('checkbox', { name: /Administrator/ })[1]!);
    await user.click(within(journals).getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      steps: [
        {
          name: 'Supervisor',
          requiredApprovals: 1,
          roleIds: ['role-admin'],
          membershipIds: [],
          conditions: { minBaseAmount: '10000', maxBaseAmount: null, transactionTypes: null },
        },
        {
          name: 'Step 2',
          requiredApprovals: 1,
          roleIds: ['role-admin'],
          membershipIds: [],
          conditions: { minBaseAmount: null, maxBaseAmount: '500', transactionTypes: ['imported'] },
        },
      ],
    });
  });

  it('offers only the conditions an action supports, and flags stale threshold currencies', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['approvals.manage', 'roles.read', 'members.read'] }),
      ),
      'GET /approvals/policies': ok({
        actions,
        baseCurrency: 'USD',
        policies: [
          {
            actionKey: 'accounting.opening_balance.post',
            steps: [
              {
                name: 'Large',
                requiredApprovals: 1,
                roleIds: ['role-admin'],
                membershipIds: [],
                conditions: {
                  minBaseAmount: '40000',
                  maxBaseAmount: null,
                  transactionTypes: null,
                  thresholdCurrency: 'MVR',
                },
              },
            ],
          },
        ],
      }),
      'GET /organizations/current/roles': ok(roles),
      'GET /organizations/current/members': ok([]),
    });
    renderAt('/settings/approvals');
    await screen.findByText('Approve opening balances before posting');
    expect(
      screen.getByText(/amounts were set in MVR, but the base currency is now USD/),
    ).toBeTruthy();
    // Opening balances: an amount band, but no transaction-type choice (a single type).
    expect(screen.queryByText('Opening balances')).toBeNull();
    // Period reopening: no amount and a single type, so no condition fields at all.
    const reopen = screen
      .getByText('Reopen a closed accounting period')
      .closest('.card, section, div')!;
    await user.click(within(reopen as HTMLElement).getByRole('button', { name: 'Add step' }));
    expect(within(reopen as HTMLElement).queryByLabelText(/Amount from/)).toBeNull();
  });
});

const setupState = {
  isSetUp: true,
  settings: { baseCurrency: 'MVR', coaTemplateKey: 'maldives', baseCurrencyLocked: false },
  templates: [],
};
function journal(overrides: Record<string, unknown>) {
  return {
    id: 'j1',
    number: null,
    status: 'DRAFT',
    source: 'manual',
    entryDate: '2026-03-15',
    periodId: null,
    description: 'Cash sale',
    reference: '',
    currency: 'MVR',
    exchangeRate: null,
    exchangeRateSource: null,
    baseCurrency: null,
    totalDebit: '20000.0000',
    totalCredit: '20000.0000',
    totalBaseDebit: null,
    totalBaseCredit: null,
    approvalRequestId: null,
    createdByUserId: 'someone-else',
    submittedByUserId: null,
    createdAt: '2026-09-29T08:00:00Z',
    postedAt: null,
    lines: [],
    approval: null,
    approvalFacts: { transactionType: 'manual', baseAmount: '20000', baseCurrency: 'MVR' },
    approvalSteps: [],
    approvalRequiredForPosting: false,
    reversedByJournalId: null,
    reversesJournalId: null,
    reversalReason: null,
    ...overrides,
  };
}
const POSTER = [
  'organization.read',
  'accounting.accounts.view',
  'accounting.journals.view',
  'accounting.journals.submit',
  'accounting.journals.post',
  'accounting.journals.approve',
];

describe('approval requirement on journals (S10-06)', () => {
  it('explains when approval is required and which steps apply', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: POSTER })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok([]),
      'GET /accounting/journals/j1': ok(
        journal({
          approvalRequiredForPosting: true,
          approvalSteps: [
            {
              order: 1,
              name: 'Supervisor',
              requiredApprovals: 1,
              conditions: {
                minBaseAmount: '10000',
                maxBaseAmount: null,
                transactionTypes: null,
                thresholdCurrency: 'MVR',
              },
            },
          ],
        }),
      ),
    });
    renderAt('/accounting/journals/j1');
    const box = await screen.findByTestId('approval-requirement');
    expect(box.textContent).toMatch(/Approval is required before posting/);
    expect(box.textContent).toMatch(/Manual journals · 20,000.00 MVR/);
    expect(box.textContent).toMatch(/Step 1 — Supervisor/);
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post' })).toBeNull();
  });

  it('offers direct posting when no step applies (Decision 77)', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: POSTER })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok([]),
      'GET /accounting/journals/j1': ok(journal({})),
    });
    renderAt('/accounting/journals/j1');
    const box = await screen.findByTestId('approval-requirement');
    expect(box.textContent).toMatch(/No approval is required to post this journal/);
    expect(screen.getByRole('button', { name: 'Post' })).toBeTruthy();
  });

  it('withholds posting of a pending journal a policy now covers', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: POSTER })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok([]),
      'GET /accounting/journals/j1': ok(
        journal({ status: 'PENDING_APPROVAL', approvalRequiredForPosting: true }),
      ),
    });
    renderAt('/accounting/journals/j1');
    await screen.findByTestId('approval-requirement');
    expect(screen.queryByRole('button', { name: 'Post' })).toBeNull();
  });
});

describe('approval queue (S10)', () => {
  it('shows each request’s facts and the steps that apply', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: POSTER })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/journals': ok([]),
      'GET /approvals/requests': ok([
        {
          id: 'r1',
          actionKey: 'accounting.journal.post',
          subjectType: 'accounting_journal',
          subjectId: 'j1',
          reason: null,
          requestedByUserId: 'someone-else',
          createdAt: '2026-09-29T08:00:00Z',
          canDecide: true,
          progress: [{ order: 2, name: 'Director', requiredApprovals: 1, approvals: 0 }],
          facts: { transactionType: 'imported', baseAmount: '60000', baseCurrency: 'MVR' },
          appliedSteps: [
            {
              order: 2,
              name: 'Director',
              requiredApprovals: 1,
              conditions: {
                minBaseAmount: '50000',
                maxBaseAmount: null,
                transactionTypes: null,
                thresholdCurrency: 'MVR',
              },
            },
          ],
        },
        {
          id: 'r2',
          actionKey: 'accounting.period.reopen',
          subjectType: 'accounting_period',
          subjectId: 'p1',
          reason: 'Late invoice',
          requestedByUserId: 'someone-else',
          createdAt: '2026-09-29T08:00:00Z',
          canDecide: false,
          progress: [{ order: 1, name: 'Controller', requiredApprovals: 1, approvals: 0 }],
          facts: { transactionType: 'period_reopen', baseAmount: null, baseCurrency: 'MVR' },
          appliedSteps: [
            {
              order: 1,
              name: 'Controller',
              requiredApprovals: 1,
              conditions: {
                minBaseAmount: null,
                maxBaseAmount: null,
                transactionTypes: ['period_reopen'],
                thresholdCurrency: null,
              },
            },
          ],
        },
      ]),
    });
    renderAt('/accounting/journals/approvals');
    const card = (await screen.findByText('Why these journals need approval')).closest(
      '.card, section',
    ) as HTMLElement;
    expect(within(card).getByText('Imported journals · 60,000.00 MVR')).toBeTruthy();
    expect(within(card).getByText(/Step 2 — Director/)).toBeTruthy();
    expect(within(card).getByText(/amount of 50,000.00 MVR or more/)).toBeTruthy();
    const others = screen
      .getByText('Other approval requests')
      .closest('.card, section') as HTMLElement;
    expect(within(others).getByText('Period reopening')).toBeTruthy();
    expect(within(others).getByText(/Applies to: Period reopening/)).toBeTruthy();
  });
});
