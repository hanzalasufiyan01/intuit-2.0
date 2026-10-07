import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Phase 4B-10: the revaluation pages (ADR 0004 P4-52). The server decides; the pages preview the
 * calculation, offer Post or Submit for approval as the preview says, and show each action only to
 * users who hold its permission.
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

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'PENDING_APPROVAL',
  method: 'REVERSING',
  revaluationDate: '2026-03-31',
  reversalDate: '2026-04-01',
  baseCurrency: 'MVR',
  version: 2,
  netAdjustment: '80',
  totalGain: '80',
  totalLoss: '0',
  lineCount: 1,
  createdAt: '2026-03-31T00:00:00Z',
  postedAt: null,
  reversedAt: null,
  reversalReason: null,
  approvalRequestId: 'req1',
  journalCount: 0,
  lines: [],
  journals: [],
  approval: {
    required: true,
    requestId: 'req1',
    requestStatus: 'pending',
    readyToIssue: false,
    approvalOutdated: false,
    appliedSteps: [],
  },
  ...overrides,
});

const preview = (approvalRequired: boolean) => ({
  approvalRequired,
  revaluationDate: '2026-03-31',
  reversalDate: '2026-04-01',
  errors: [],
  warnings: [],
  lines: [
    {
      lineNumber: 1,
      exposureKind: 'ACCOUNT',
      accountCode: '1125',
      currency: 'USD',
      foreignBalance: '1000',
      carryingBase: '15420',
      rate: '15.5',
      revaluedBase: '15500',
      adjustment: '80',
    },
  ],
  totals: { gain: '80', loss: '0', net: '80' },
});

const VIEW = ['accounting.journals.view'];
const POST = [...VIEW, 'accounting.journals.post'];
const CANCEL = [...VIEW, 'accounting.journals.reverse'];

const common = (
  permissions: string[],
  extra: Record<string, Handler> = {},
): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /accounting/setup': ok({ isSetUp: true, settings: { baseCurrency: 'MVR' } }),
  'GET /accounting/revaluations': ok([]),
  'GET /approvals/requests': ok([]),
  ...extra,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe('revaluation page', () => {
  it('previews and offers Post when no approval applies', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(POST, {
        'POST /accounting/revaluations/preview': ok(preview(false)),
        'POST /accounting/revaluations': () => ({
          status: 201,
          body: { data: run({ id: 'r9', status: 'POSTED' }) },
        }),
        'GET /accounting/revaluations/r9': ok(
          run({ id: 'r9', status: 'POSTED', approval: undefined }),
        ),
      }),
    );
    renderAt('/accounting/revaluations');
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('1125')).toBeTruthy();
    expect(screen.getByText(/Gain 80 · Loss 0 · Net 80/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Post revaluation' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url.pathname.endsWith('/accounting/revaluations'),
        ),
      ).toBe(true),
    );
    const posted = calls.find(
      (c) => c.method === 'POST' && c.url.pathname.endsWith('/accounting/revaluations'),
    )!;
    expect(posted.body).toEqual({ revaluationDate: expect.any(String) });
  });

  it('offers Submit for approval when the preview says approval applies', async () => {
    const user = userEvent.setup();
    stubApi(common(POST, { 'POST /accounting/revaluations/preview': ok(preview(true)) }));
    renderAt('/accounting/revaluations');
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('button', { name: 'Submit for approval' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post revaluation' })).toBeNull();
  });

  it('lets a viewer preview but not post or submit', async () => {
    const user = userEvent.setup();
    stubApi(common(VIEW, { 'POST /accounting/revaluations/preview': ok(preview(false)) }));
    renderAt('/accounting/revaluations');
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('1125')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post revaluation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
  });
});

describe('revaluation detail', () => {
  it('disables posting until approved, and shows the approver decision buttons', async () => {
    stubApi(
      common([...POST, 'accounting.journals.approve'], {
        'GET /accounting/revaluations/r1': ok(run()),
        'GET /approvals/requests': ok([
          {
            id: 'req1',
            actionKey: 'accounting.revaluation.post',
            subjectId: 'r1',
            canDecide: true,
            progress: [],
            facts: null,
          },
        ]),
      }),
    );
    renderAt('/accounting/revaluations/r1');
    const post = await screen.findByRole('button', { name: 'Post revaluation' });
    expect((post as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeTruthy();
  });

  it('offers cancellation of a posted run only to users who may reverse', async () => {
    stubApi(
      common(CANCEL, {
        'GET /accounting/revaluations/r1': ok(
          run({ status: 'POSTED', approval: undefined, postedAt: '2026-03-31T00:00:00Z' }),
        ),
      }),
    );
    renderAt('/accounting/revaluations/r1');
    expect(await screen.findByRole('button', { name: 'Cancel revaluation' })).toBeTruthy();
  });
});
