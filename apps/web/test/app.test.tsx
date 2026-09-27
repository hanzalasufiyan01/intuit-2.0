import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { api, ApiError, setCsrfToken } from '../src/services/api-client';
import { installFakeApi, makeSession } from './fake-api';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = createQueryClient();
  render(<App router={router} queryClient={queryClient} />);
  return { router };
}

describe('routing and protected routes', () => {
  it('redirects signed-out visitors from protected pages to the login page', async () => {
    installFakeApi({ session: null });
    const { router } = renderAt('/members');
    expect(await screen.findByRole('heading', { name: 'Sign in to Intuit 2.0' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('shows the app shell for an authenticated user', async () => {
    installFakeApi({ session: makeSession() });
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Alpha Traders' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });

  it('keeps signed-in users away from the login page', async () => {
    installFakeApi({ session: makeSession() });
    const { router } = renderAt('/login');
    await screen.findByRole('heading', { name: 'Alpha Traders' });
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('authentication state', () => {
  it('signs in, returns to the requested page, and signs out', async () => {
    const user = userEvent.setup();
    const { requests } = installFakeApi({ session: null });
    const { router } = renderAt('/members');

    await user.type(await screen.findByLabelText('Email'), 'owner@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Members' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/members');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in to Intuit 2.0' });
    const logout = requests.find((r) => r.url.endsWith('/auth/logout'));
    expect(logout?.headers['x-csrf-token']).toBe('csrf-token-for-s1');
  });

  it('shows the server error for invalid credentials', async () => {
    const user = userEvent.setup();
    installFakeApi({ session: null });
    renderAt('/login');
    await user.type(await screen.findByLabelText('Email'), 'owner@example.test');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/The email or password is incorrect/)).toBeTruthy();
  });
});

describe('permission-aware UI', () => {
  it('hides navigation and blocks pages the user lacks permission for', async () => {
    installFakeApi({
      session: makeSession({ permissions: ['organization.read', 'members.read'] }),
    });
    renderAt('/audit');
    expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByText('Members')).toBeTruthy();
    expect(within(nav).queryByText('Audit log')).toBeNull();
    expect(within(nav).queryByText('Roles')).toBeNull();
  });

  it('shows the invite form only with members.invite', async () => {
    installFakeApi({
      session: makeSession({ permissions: ['organization.read', 'members.read'] }),
    });
    renderAt('/members');
    await screen.findByText('Owner of Alpha Traders');
    expect(screen.queryByRole('button', { name: 'Send invitation' })).toBeNull();
  });
});

describe('organization context', () => {
  it('switches organizations through the server and reloads organization data', async () => {
    const user = userEvent.setup();
    const { requests } = installFakeApi({ session: makeSession() });
    renderAt('/members');
    expect(await screen.findByText('Owner of Alpha Traders')).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Organization'), 'org-b');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Beta Resorts' })).toBeTruthy());
    const switchRequest = requests.find((r) => r.url.endsWith('/auth/session/organization'));
    expect(switchRequest?.method).toBe('PUT');
    expect(switchRequest?.body).toEqual({ organizationId: 'org-b' });
    expect(switchRequest?.headers['x-csrf-token']).toBe('csrf-token-for-s1');

    await user.click(screen.getByRole('link', { name: 'Members' }));
    expect(await screen.findByText('Owner of Beta Resorts')).toBeTruthy();
    expect(screen.queryByText('Owner of Alpha Traders')).toBeNull();
  });
});

describe('API client', () => {
  it('sends JSON with the CSRF token on writes and maps the error envelope', async () => {
    const { requests } = installFakeApi({ session: null });
    setCsrfToken('abc');
    const error = await api
      .post('/auth/login', { email: 'a@example.test', password: 'nope' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
      requestId: 'req-test',
    });
    expect(requests[0]?.headers['x-csrf-token']).toBe('abc');
    expect(requests[0]?.headers['content-type']).toBe('application/json');

    await api.get('/auth/session').catch(() => undefined);
    expect(requests[1]?.headers['x-csrf-token']).toBeUndefined();
    setCsrfToken(null);
  });
});
