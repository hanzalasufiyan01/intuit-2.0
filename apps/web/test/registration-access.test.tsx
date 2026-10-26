import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/**
 * Registration access (REGISTRATION_MODE): the screens follow the server's policy (open, code or
 * closed), send the access code only in code mode, and fall back to the open screen when the
 * policy cannot be read (the server still enforces it). No access code is stored or shown.
 */

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(options: { mode?: string; policyFails?: boolean; registerStatus?: number } = {}) {
  const requests: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api\/v1/, '');
      const method = init.method ?? 'GET';
      const body = init.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      requests.push({ method, path, body });
      if (path === '/auth/session') {
        return json(401, {
          error: { code: 'UNAUTHENTICATED', message: 'No session.', requestId: 'r' },
        });
      }
      if (path === '/auth/registration-policy') {
        return options.policyFails
          ? json(500, { error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } })
          : json(200, { data: { mode: options.mode ?? 'open' } });
      }
      if (path === '/auth/register' && method === 'POST') {
        return options.registerStatus && options.registerStatus >= 400
          ? json(options.registerStatus, {
              error: {
                code: 'FORBIDDEN',
                message: 'A valid access code is required to register.',
                requestId: 'r',
              },
            })
          : json(201, { data: makeSession() });
      }
      return json(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } });
    }),
  );
  return requests;
}

function open(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return userEvent.setup();
}

async function fillAccount(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Your name'), 'Owner');
  await user.type(screen.getByLabelText('Email'), 'owner@example.test');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
  await user.type(screen.getByLabelText('Organization name'), 'Alpha Traders');
}

const registerCalls = (requests: Recorded[]) =>
  requests.filter((r) => r.path === '/auth/register' && r.method === 'POST');

afterEach(() => vi.unstubAllGlobals());

describe('open registration (the default)', () => {
  it('shows the usual form with no access code field, and sends no code', async () => {
    const requests = stubApi({ mode: 'open' });
    const user = open('/register');
    await fillAccount(user);
    expect(screen.queryByLabelText('Access code')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(registerCalls(requests)).toHaveLength(1));
    expect(registerCalls(requests)[0]!.body).toEqual({
      displayName: 'Owner',
      email: 'owner@example.test',
      password: 'correct horse battery staple',
      organizationName: 'Alpha Traders',
    });
  });

  it('offers "Create an account" on the sign-in page', async () => {
    stubApi({ mode: 'open' });
    open('/login');
    expect(await screen.findByRole('link', { name: 'Create an account' })).toBeTruthy();
  });

  it('behaves as open when the policy cannot be read (the server still enforces it)', async () => {
    stubApi({ policyFails: true });
    open('/register');
    expect(await screen.findByLabelText('Your name')).toBeTruthy();
    expect(screen.queryByLabelText('Access code')).toBeNull();
  });
});

describe('code mode', () => {
  it('asks for an access code and sends it with the registration', async () => {
    const requests = stubApi({ mode: 'code' });
    const user = open('/register');
    const field = await screen.findByLabelText('Access code');
    // The code is hidden while typed, and the browser is told not to remember it.
    expect(field.getAttribute('type')).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
    await fillAccount(user);
    await user.type(field, 'review-access-code-1');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(registerCalls(requests)).toHaveLength(1));
    expect(registerCalls(requests)[0]!.body).toMatchObject({
      organizationName: 'Alpha Traders',
      accessCode: 'review-access-code-1',
    });
  });

  it('shows the server refusal for a wrong code and keeps the form', async () => {
    stubApi({ mode: 'code', registerStatus: 403 });
    const user = open('/register');
    await user.type(await screen.findByLabelText('Access code'), 'wrong-code-000');
    await fillAccount(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/valid access code is required/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
  });

  it('keeps "Create an account" on the sign-in page', async () => {
    stubApi({ mode: 'code' });
    open('/login');
    expect(await screen.findByRole('link', { name: 'Create an account' })).toBeTruthy();
  });
});

describe('closed mode', () => {
  it('replaces the form with a clear message and offers sign-in', async () => {
    const requests = stubApi({ mode: 'closed' });
    open('/register');
    expect(await screen.findByRole('heading', { name: 'Registration is closed' })).toBeTruthy();
    expect(screen.getByText(/invited/)).toBeTruthy();
    expect(screen.queryByLabelText('Your name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    expect(registerCalls(requests)).toHaveLength(0);
  });

  it('hides "Create an account" on the sign-in page, and keeps the rest', async () => {
    stubApi({ mode: 'closed' });
    open('/login');
    expect(await screen.findByRole('link', { name: 'Forgot your password?' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Create an account' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});
