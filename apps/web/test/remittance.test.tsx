import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { en } from '../src/i18n/messages.en';
import { makeSession } from './fake-api';

/**
 * Phase 4B-7: a payment's remittance advice panel (ADR 0004 P4-46; D4–D7, D13, D16). The server
 * decides; the panel follows its states (none, pending, ready, failed), offers generation and
 * email to users with vendor_payments.create, and keeps an existing PDF for a voided payment.
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
const accepted = (data: unknown) => () => ({ status: 202, body: { data } });

const VIEW = ['vendor_payments.view', 'vendors.view'];
const CREATE = [...VIEW, 'vendor_payments.create'];

const payment = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  status: 'RECORDED',
  number: 'PAY-00001',
  vendorId: 'ven-1',
  vendorName: 'Island Supplies',
  paymentDate: '2026-03-20',
  currencyCode: 'MVR',
  amount: '150.00',
  amountUnallocated: '0.00',
  baseAmount: '150.0000',
  baseUnallocated: '0.0000',
  reference: null,
  version: 2,
  recordedAt: '2026-03-20T00:00:00Z',
  voidedAt: null,
  paymentAccountId: 'acc-1120',
  defaultPaymentAccountId: 'acc-1120',
  paymentAccountOverridden: false,
  rateOverride: null,
  rateOverrideReason: null,
  exchangeRate: '1.0000000000',
  exchangeRateSource: 'base',
  tableRate: null,
  memo: '',
  journalId: 'j1',
  voidReason: null,
  voidJournalId: null,
  createdByUserId: 'u1',
  baseCurrency: 'MVR',
  plannedAllocations: [],
  allocations: [],
  approval: {
    required: false,
    requestId: null,
    requestStatus: null,
    facts: { transactionType: 'payment', baseAmount: '150.00', baseCurrency: 'MVR' },
    appliedSteps: [],
    readyToIssue: true,
    approvalOutdated: false,
  },
  warnings: [],
  ...overrides,
});

const vendor = {
  id: 'ven-1',
  displayName: 'Island Supplies',
  currencyCode: 'MVR',
  email: 'ap@island.test',
};

const common = (
  permissions: string[],
  extra: Record<string, Handler> = {},
): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /approvals/requests': ok([]),
  'GET /accounting/setup': ok({ settings: { baseCurrency: 'MVR' } }),
  'GET /accounting/accounts': ok([]),
  'GET /purchases/refunds': ok({ items: [], nextCursor: null }),
  'GET /vendors/ven-1': ok(vendor),
  'GET /purchases/payments/p1/remittance/emails': ok([]),
  ...extra,
});

const ready = {
  status: 'ready',
  fileId: 'f1',
  jobId: null,
  download: { url: '/api/v1/files/content?token=t' },
};

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('remittance advice panel', () => {
  it('generates on demand, shows it pending, then offers the download', async () => {
    const user = userEvent.setup();
    let phase: 'none' | 'pending' | 'ready' = 'none';
    const calls = stubApi(
      common(CREATE, {
        'GET /purchases/payments/p1': ok(payment()),
        'GET /purchases/payments/p1/remittance': () => ({
          status: 200,
          body: {
            data:
              phase === 'ready'
                ? ready
                : { status: phase, fileId: null, jobId: phase === 'none' ? null : 'j1' },
          },
        }),
        'POST /purchases/payments/p1/remittance': () => {
          phase = 'pending';
          return { status: 202, body: { data: { status: 'pending', jobId: 'j1' } } };
        },
      }),
    );
    renderAt('/purchases/payments/p1');
    expect(await screen.findByText(en['purchases.remittance.none'])).toBeTruthy();
    // Nothing is generated until it is asked for (D5).
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Generate remittance advice' }));
    expect(await screen.findByText(en['purchases.remittance.generating'])).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({});
    // The panel keeps checking while the job runs, then offers the PDF.
    phase = 'ready';
    const link = await screen.findByRole('link', { name: 'Download PDF' }, { timeout: 8000 });
    expect(link.getAttribute('href')).toBe('/api/v1/files/content?token=t');
    expect(screen.queryByRole('button', { name: 'Generate remittance advice' })).toBeNull();
  }, 15000);

  it('shows a failed generation and lets the user try again', async () => {
    const user = userEvent.setup();
    const calls = stubApi(
      common(CREATE, {
        'GET /purchases/payments/p1': ok(payment()),
        'GET /purchases/payments/p1/remittance': ok({
          status: 'failed',
          fileId: null,
          jobId: 'j1',
        }),
        'POST /purchases/payments/p1/remittance': accepted({ status: 'pending', jobId: 'j2' }),
      }),
    );
    renderAt('/purchases/payments/p1');
    expect(await screen.findByText(en['purchases.remittance.failed'])).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  });

  it('lets view-only users see and download an existing advice, without generate or email', async () => {
    stubApi(
      common(VIEW, {
        'GET /purchases/payments/p1': ok(payment()),
        'GET /purchases/payments/p1/remittance': ok(ready),
        'GET /purchases/payments/p1/remittance/emails': ok([
          {
            id: 'e1',
            recipient: 'ap@island.test',
            subject: 's',
            status: 'sent',
            requestedAt: '2026-03-21T00:00:00Z',
            sentAt: '2026-03-21T00:00:05Z',
          },
        ]),
      }),
    );
    renderAt('/purchases/payments/p1');
    expect(await screen.findByRole('link', { name: 'Download PDF' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate remittance advice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send email' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();
    // The history is readable.
    expect(await screen.findByText(/ap@island.test · Sent · 2026-03-21/)).toBeTruthy();
  });

  it('emails the vendor: prefilled address, one request per click, history, send again', async () => {
    const user = userEvent.setup();
    const history = [
      {
        id: 'e1',
        recipient: 'old@vendor.test',
        subject: 's',
        status: 'failed',
        requestedAt: '2026-03-21T00:00:00Z',
        sentAt: null,
      },
    ];
    const calls = stubApi(
      common(CREATE, {
        'GET /purchases/payments/p1': ok(payment()),
        'GET /purchases/payments/p1/remittance': ok(ready),
        'GET /purchases/payments/p1/remittance/emails': () => ({
          status: 200,
          body: { data: history },
        }),
        'POST /purchases/payments/p1/remittance/email': (_url, body) => {
          history.unshift({
            id: 'e2',
            recipient: (body as { to: string }).to,
            subject: 's',
            status: 'queued' as never,
            requestedAt: '2026-03-22T00:00:00Z',
            sentAt: null,
          });
          return { status: 202, body: { data: { id: 'e2', status: 'queued', jobId: 'j9' } } };
        },
      }),
    );
    renderAt('/purchases/payments/p1');
    // The vendor's email is offered (D16).
    const to = (await screen.findByLabelText('Send to')) as HTMLInputElement;
    await waitFor(() => expect(to.value).toBe('ap@island.test'));
    await user.type(screen.getByLabelText('Subject'), 'Paid');
    await user.type(screen.getByLabelText('Message'), 'By transfer.');
    await user.click(screen.getByRole('button', { name: 'Send email' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      to: 'ap@island.test',
      subject: 'Paid',
      message: 'By transfer.',
    });
    // The new request is listed (queued) and the form is cleared.
    expect(await screen.findByText(/ap@island.test · Queued · 2026-03-22/)).toBeTruthy();
    expect(screen.getByText(/old@vendor.test · Failed/)).toBeTruthy();
    // Send again: a failed request's address comes back into the form; sending is a new request.
    await user.click(screen.getAllByRole('button', { name: 'Send again' })[1]!);
    await waitFor(() =>
      expect((screen.getByLabelText('Send to') as HTMLInputElement).value).toBe('old@vendor.test'),
    );
    await user.click(screen.getByRole('button', { name: 'Send email' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST')[1]!.body).toEqual({ to: 'old@vendor.test' });
  });

  it('prevents a double click while a request is in flight (D13)', async () => {
    const user = userEvent.setup();
    let finish: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let posts = 0;
    stubApi(
      common(CREATE, {
        'GET /purchases/payments/p1': ok(payment()),
        'GET /purchases/payments/p1/remittance': ok(ready),
      }),
    );
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/remittance/email') && init?.method === 'POST') {
        posts += 1;
        await gate;
        return new Response(JSON.stringify({ data: { id: 'e1', status: 'queued', jobId: 'j' } }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return base(input, init);
    });
    renderAt('/purchases/payments/p1');
    const send = await screen.findByRole('button', { name: 'Send email' });
    await user.click(send);
    await user.click(send);
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(posts).toBe(1);
    finish!();
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  });

  it('keeps an existing advice for a voided payment but offers no new generation or email', async () => {
    stubApi(
      common(CREATE, {
        'GET /purchases/payments/p1': ok(
          payment({ status: 'VOID', voidedAt: '2026-03-22T00:00:00Z' }),
        ),
        'GET /purchases/payments/p1/remittance': ok(ready),
      }),
    );
    renderAt('/purchases/payments/p1');
    expect(await screen.findByRole('link', { name: 'Download PDF' })).toBeTruthy();
    expect(screen.getByText(en['purchases.remittance.voidKept'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate remittance advice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send email' })).toBeNull();
    expect(screen.queryByLabelText('Send to')).toBeNull();
  });

  it('says a voided payment with no advice gets none, and offers no controls', async () => {
    stubApi(
      common(CREATE, {
        'GET /purchases/payments/p1': ok(
          payment({ status: 'VOID', voidedAt: '2026-03-22T00:00:00Z' }),
        ),
        'GET /purchases/payments/p1/remittance': ok({ status: 'none', fileId: null, jobId: null }),
      }),
    );
    renderAt('/purchases/payments/p1');
    expect(await screen.findByText(en['purchases.remittance.voidNone'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate remittance advice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send email' })).toBeNull();
  });

  it('is not shown for a draft payment', async () => {
    stubApi(
      common(CREATE, {
        'GET /purchases/payments/p1': ok(payment({ status: 'DRAFT', number: null })),
      }),
    );
    renderAt('/purchases/payments/p1');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(en['purchases.remittance.title'])).toBeNull();
  });
});
