import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { installFakeApi, makeSession } from './fake-api';

/**
 * Regression guard for a race after sign-in and registration. The query cache tells its observers
 * about the new session one macrotask later, so a page that navigated from the mutation callback
 * could reach a protected page before the app had rendered the signed-in state; the protected
 * route then saw "signed out" and bounced to /login for a moment. The pages now leave the
 * redirect to the session-driven route guard. Every navigation after submitting must therefore
 * happen once the sign-in form is gone, and none may lead back to /login.
 */
function renderRecordingNavigations(path: string, formButton: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const navigations: { to: string; formStillShown: boolean }[] = [];
  const navigate = router.navigate.bind(router);
  router.navigate = ((to: unknown, options?: unknown) => {
    navigations.push({
      to: typeof to === 'string' ? to : String((to as { pathname?: string }).pathname),
      formStillShown: screen.queryByRole('button', { name: formButton }) !== null,
    });
    return navigate(to as never, options as never);
  }) as typeof router.navigate;
  render(<App router={router} queryClient={createQueryClient()} />);
  return { router, navigations };
}

describe('redirect after authentication', () => {
  it('signs in and continues to the requested page only once the signed-in state is shown', async () => {
    const user = userEvent.setup();
    installFakeApi({ session: null });
    const { router, navigations } = renderRecordingNavigations('/members', 'Sign in');

    await user.type(await screen.findByLabelText('Email'), 'owner@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    const before = navigations.length;
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Members' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/members');
    const after = navigations.slice(before);
    expect(after.map((n) => n.to)).toContain('/members');
    expect(after.filter((n) => n.to === '/login')).toEqual([]);
    expect(after.filter((n) => n.formStillShown)).toEqual([]);
  });

  it('registers and continues to the app only once the signed-in state is shown', async () => {
    const user = userEvent.setup();
    const { state } = installFakeApi({ session: null });
    const fake = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if ((init.method ?? 'GET') === 'POST' && String(input).endsWith('/auth/register')) {
          state.session = makeSession();
          return new Response(JSON.stringify({ data: state.session }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return fake(input, init);
      }),
    );
    const { router, navigations } = renderRecordingNavigations('/register', 'Create account');

    await user.type(await screen.findByLabelText('Your name'), 'Owner');
    await user.type(screen.getByLabelText('Email'), 'owner@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.type(screen.getByLabelText('Organization name'), 'Alpha Traders');
    const before = navigations.length;
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Alpha Traders' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
    const after = navigations.slice(before);
    expect(after.map((n) => n.to)).toContain('/');
    expect(after.filter((n) => n.to === '/login')).toEqual([]);
    expect(after.filter((n) => n.formStillShown)).toEqual([]);
  });
});
