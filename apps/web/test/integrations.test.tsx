import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * API integrations, tokens and webhook endpoints (ADR 0011). A token or signing secret is shown
 * once and leaves the page when dismissed; viewers get no controls; delivery history, health and
 * redelivery are shown.
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

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

const session = (permissions: string[]) => ({
  'GET /auth/session': ok(makeSession({ permissions })),
});

const integration = {
  id: 'int1',
  name: 'Accounting sync',
  description: null,
  status: 'active',
  scopes: ['customers:read'],
  responsible: { membershipId: 'm1', displayName: 'Aisha' },
  version: 1,
  disabledAt: null,
  revokedAt: null,
  revokeReason: null,
};
const endpoint = {
  id: 'ep1',
  name: 'ERP hook',
  url: 'https://hooks.example.com/in',
  integrationId: 'int1',
  status: 'active',
  payloadMode: 'thin',
  eventTypes: ['customer.created'],
  consecutiveFailures: 3,
  lastSuccessAt: null,
  lastFailureAt: '2026-03-01T10:00:00.000Z',
  disabledReason: null,
  pingVerifiedAt: null,
  secretOverlapUntil: null,
  version: 2,
};
const delivery = {
  id: 'd1',
  endpointId: 'ep1',
  eventId: 'e1',
  eventType: 'customer.created',
  resource: { type: 'customer', id: 'c1' },
  status: 'dead',
  attemptsMade: 6,
  redeliveryCount: 0,
  lastStatusCode: 500,
  lastErrorClass: null,
  createdAt: '2026-03-01T09:00:00.000Z',
  finishedAt: '2026-03-01T10:00:00.000Z',
};

describe('integrations page', () => {
  it('shows a new token once and clears it when dismissed', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(['api_tokens.view', 'api_tokens.manage']),
      'GET /api-integrations': ok([integration]),
      'GET /api-integrations/scopes': ok([
        { scope: 'customers:read', description: 'Read customers', write: false },
      ]),
      'GET /api-integrations/int1/tokens': ok([]),
      'POST /api-integrations/int1/tokens': () => ({
        status: 201,
        body: {
          data: {
            id: 't1',
            name: 'Prod',
            prefix: 'itk_abc',
            status: 'active',
            createdAt: '2026-03-01T00:00:00.000Z',
            expiresAt: '2026-06-01T00:00:00.000Z',
            lastUsedAt: null,
            revokeReason: null,
            token: 'itk_abc.SECRETVALUE',
          },
        },
      }),
    });
    renderAt('/settings/integrations');
    await user.click(await screen.findByRole('button', { name: 'Tokens' }));
    await user.type(await screen.findByLabelText('Token name'), 'Prod');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const shown = await screen.findByLabelText('New token for Accounting sync');
    expect((shown as HTMLInputElement).value).toBe('itk_abc.SECRETVALUE');
    expect(
      calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/tokens'))?.body,
    ).toMatchObject({ name: 'Prod', expiresInDays: 90 });
    await user.click(screen.getByRole('button', { name: 'I have stored it' }));
    expect(screen.queryByDisplayValue('itk_abc.SECRETVALUE')).toBeNull();
    expect(document.body.textContent).not.toContain('SECRETVALUE');
  });

  it('gives a viewer no controls', async () => {
    stubApi({
      ...session(['api_tokens.view']),
      'GET /api-integrations': ok([integration]),
      'GET /api-integrations/scopes': ok([]),
    });
    renderAt('/settings/integrations');
    expect(await screen.findByText('Accounting sync')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create integration' })).toBeNull();
  });
});

describe('webhooks page', () => {
  it('shows endpoint health and delivery history, and redelivers a failed delivery', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...session(['webhooks.view', 'webhooks.manage', 'api_tokens.view']),
      'GET /webhooks/endpoints': ok([endpoint]),
      'GET /webhooks/event-types': ok([{ type: 'customer.created', subscribable: true }]),
      'GET /api-integrations': ok([integration]),
      'GET /webhooks/deliveries': ok([delivery]),
      'POST /webhooks/deliveries/d1/redeliver': ok({ ...delivery, status: 'pending' }),
    });
    renderAt('/settings/webhooks');
    expect(await screen.findByText(/Failing \(3 in a row\)/)).toBeTruthy();
    const row = (await screen.findByText('500')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Redeliver' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.pathname.endsWith('/d1/redeliver')),
      ).toBe(true),
    );
  });

  it('shows a rotated signing secret once', async () => {
    const user = userEvent.setup();
    stubApi({
      ...session(['webhooks.view', 'webhooks.manage']),
      'GET /webhooks/endpoints': ok([endpoint]),
      'GET /webhooks/event-types': ok([]),
      'GET /api-integrations': () => ({
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'no', requestId: 'r' } },
      }),
      'GET /webhooks/deliveries': ok([]),
      'POST /webhooks/endpoints/ep1/rotate-secret': ok({ ...endpoint, secret: 'whsec_NEWSECRET' }),
    });
    renderAt('/settings/webhooks');
    await user.click(await screen.findByRole('button', { name: 'Rotate secret' }));
    const field = await screen.findByLabelText('New signing secret for ERP hook');
    expect((field as HTMLInputElement).value).toBe('whsec_NEWSECRET');
    await user.click(screen.getByRole('button', { name: 'I have stored it' }));
    expect(screen.queryByDisplayValue('whsec_NEWSECRET')).toBeNull();
  });

  it('hides management controls from a viewer', async () => {
    stubApi({
      ...session(['webhooks.view']),
      'GET /webhooks/endpoints': ok([endpoint]),
      'GET /webhooks/event-types': ok([]),
      'GET /webhooks/deliveries': ok([delivery]),
    });
    renderAt('/settings/webhooks');
    expect((await screen.findAllByText('ERP hook')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Rotate secret' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Redeliver' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create endpoint' })).toBeNull();
  });
});
