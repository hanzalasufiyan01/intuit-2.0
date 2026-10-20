import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Expense claim pages. The server numbers, approves and posts; the pages list claims, show the
 * bill and the reimbursement state, and offer each action only to users who hold its permission.
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

const summary = {
  id: 'c1',
  status: 'APPROVED',
  number: 'EC-00001',
  employeePartyId: 'p1',
  employeeName: 'Aishath Ali',
  claimDate: '2026-03-20',
  currencyCode: 'MVR',
  total: '200.50',
  billId: null,
  version: 2,
};

const detail = {
  ...summary,
  memo: 'Site visit',
  cancelReason: null,
  voidReason: null,
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      expenseDate: '2026-03-18',
      description: 'Taxi',
      accountId: 'a1',
      amount: '200.50',
    },
  ],
  receiptCount: 0,
  bill: null,
  approval: null,
};

const VIEW = ['expense_claims.view'];
const WORK = [...VIEW, 'expense_claims.create', 'expense_claims.post', 'expense_claims.void'];

const common = (
  permissions: string[],
  extra: Record<string, Handler> = {},
): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /expense-claims': ok({ items: [summary], nextCursor: null }),
  'GET /expense-claims/c1': ok(detail),
  'GET /files': ok([]),
  'GET /accounting/accounts': ok([]),
  ...extra,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe('expense claim list', () => {
  it('lists claims, and offers New only to those who may create', async () => {
    stubApi(common(VIEW));
    renderAt('/claims');
    expect(await screen.findByRole('link', { name: 'EC-00001' })).toBeTruthy();
    expect(screen.getByText('Aishath Ali')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New claim' })).toBeNull();
  });

  it('shows the New link to a creator', async () => {
    stubApi(common(WORK));
    renderAt('/claims');
    expect(await screen.findByRole('link', { name: 'New claim' })).toBeTruthy();
  });
});

describe('expense claim detail', () => {
  it('lets a poster post an approved claim', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(WORK, { 'POST /expense-claims/c1/post': ok({ ...detail, status: 'POSTED' }) }),
    );
    renderAt('/claims/c1');
    await user.click(await screen.findByRole('button', { name: 'Post for reimbursement' }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/post'));
      expect(call?.body).toEqual({ version: 2 });
    });
  });

  it('hides posting from a viewer', async () => {
    stubApi(common(VIEW));
    renderAt('/claims/c1');
    expect(await screen.findByText('Taxi')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post for reimbursement' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel claim' })).toBeNull();
  });

  it('shows the bill and what is still to be reimbursed on a posted claim', async () => {
    stubApi(
      common(VIEW, {
        'GET /expense-claims/c1': ok({
          ...detail,
          status: 'POSTED',
          billId: 'b1',
          bill: {
            id: 'b1',
            number: 'BILL-00001',
            status: 'POSTED',
            total: '200.50',
            amountDue: '200.50',
            reimbursed: false,
          },
        }),
      }),
    );
    renderAt('/claims/c1');
    expect(await screen.findByRole('link', { name: 'BILL-00001' })).toBeTruthy();
    expect(screen.getByText(/still to reimburse/)).toBeTruthy();
  });
});

describe('expense policy at submission (R-04)', () => {
  const draftClaim = { ...detail, status: 'DRAFT', number: null, version: 2 };
  const policyError = (code: string, message: string) => () => ({
    status: 409,
    body: {
      error: {
        code,
        message,
        requestId: 'r',
        details: {
          issues: [{ path: 'policy', message: 'Claim cap: 200.5 is above the limit of 200.' }],
        },
      },
    },
  });

  it('asks for a reason on a warning and sends it with the second submit', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const calls = stubApi(
      common(WORK, {
        'GET /expense-claims/c1': ok(draftClaim),
        'POST /expense-claims/c1/submit': () => {
          attempts += 1;
          return attempts === 1
            ? policyError(
                'EXPENSE_POLICY_WARNING',
                'This expense claim breaks an expense policy. Confirm with a reason to submit it anyway.',
              )()
            : {
                status: 200,
                body: { data: { ...draftClaim, status: 'APPROVED', number: 'EC-1' } },
              };
        },
      }),
    );
    renderAt('/claims/c1');
    await user.click(await screen.findByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Expense policy')).toBeTruthy();
    expect(screen.getByText('Claim cap: 200.5 is above the limit of 200.')).toBeTruthy();
    // The button stays disabled until a reason is typed.
    const again = screen.getByRole('button', { name: 'Submit anyway' }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    await user.type(
      screen.getByLabelText('Reason to submit despite the policy'),
      'Director agreed',
    );
    await user.click(screen.getByRole('button', { name: 'Submit anyway' }));
    await waitFor(() => {
      const posts = calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/submit'));
      expect(posts).toHaveLength(2);
      expect(posts[0]?.body).toEqual({ version: 2 });
      expect(posts[1]?.body).toEqual({ version: 2, policyReason: 'Director agreed' });
    });
  });

  it('shows a hard block without any way to override it', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(WORK, {
        'GET /expense-claims/c1': ok(draftClaim),
        'POST /expense-claims/c1/submit': policyError(
          'EXPENSE_POLICY_BLOCKED',
          'This expense claim breaks an expense policy and cannot be submitted.',
        ),
      }),
    );
    renderAt('/claims/c1');
    await user.click(await screen.findByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Expense policy: this claim cannot be submitted')).toBeTruthy();
    expect(screen.getByText('Claim cap: 200.5 is above the limit of 200.')).toBeTruthy();
    expect(screen.queryByLabelText('Reason to submit despite the policy')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit anyway' })).toBeNull();
    expect(calls.filter((c) => c.url.pathname.endsWith('/submit'))).toHaveLength(1);
  });

  it('offers no Submit to a viewer, so the policy question never arises', async () => {
    stubApi(common(VIEW, { 'GET /expense-claims/c1': ok(draftClaim) }));
    renderAt('/claims/c1');
    expect(await screen.findByText('Taxi')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });
});
