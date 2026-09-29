import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import type { PendingMfaSession, SessionState } from '../src/services/types';
import { makeSession } from './fake-api';

/** S7 UI: sign-in challenge, enforcement screen, enrollment, step-up, account and admin pages. */

type Result = { status: number; body?: unknown };
type Handler = (url: URL, body: unknown) => Result;

function stubApi(table: Record<string, Handler | Handler[]>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const cursors = new Map<string, number>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const path = url.pathname.replace(/^\/api\/v1/, '');
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      const entry = table[key];
      let handler: Handler | undefined;
      if (Array.isArray(entry)) {
        const i = cursors.get(key) ?? 0;
        cursors.set(key, i + 1);
        handler = entry[Math.min(i, entry.length - 1)];
      } else {
        handler = entry;
      }
      const result = handler
        ? handler(url, body)
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

afterEach(() => vi.unstubAllGlobals());

const ok =
  (data: unknown): Handler =>
  () => ({ status: 200, body: { data } });
const fail =
  (status: number, code: string, message = 'No'): Handler =>
  () => ({
    status,
    body: { error: { code, message, requestId: 'r' } },
  });

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

const pending: PendingMfaSession = {
  authentication: 'mfa_required',
  user: { email: 'owner@example.test', displayName: 'Aisha' },
  methods: ['totp', 'recovery_code'],
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  csrfToken: 'csrf-pending',
};

function withMfa(
  session: SessionState,
  mfa: Partial<SessionState['mfa']>,
  org?: Partial<NonNullable<SessionState['mfa']['activeOrganization']>>,
): SessionState {
  return {
    ...session,
    mfa: {
      ...session.mfa,
      ...mfa,
      activeOrganization: { ...session.mfa.activeOrganization!, ...org },
    },
  };
}

describe('sign-in with two-step verification', () => {
  it('continues to the code screen, sends the code and lands in the app', async () => {
    const user = userEvent.setup();
    // Like the server: the session read reflects the sign-in state (anonymous, pending, complete).
    let state: 'anonymous' | 'pending' | 'complete' = 'anonymous';
    const calls = stubApi({
      'GET /auth/session': (url, body) =>
        state === 'anonymous'
          ? fail(401, 'UNAUTHENTICATED')(url, body)
          : ok(state === 'pending' ? pending : makeSession())(url, body),
      'POST /auth/login': (url, body) => {
        state = 'pending';
        return ok(pending)(url, body);
      },
      'POST /auth/mfa/challenge': (url, body) => {
        if ((body as { code: string }).code === '111111') {
          return fail(400, 'INVALID_MFA_CODE', 'That code is not valid.')(url, body);
        }
        state = 'complete';
        return ok(makeSession())(url, body);
      },
    });
    const router = renderAt('/login');
    await user.type(await screen.findByLabelText('Email'), 'owner@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Two-step verification')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login/verify');
    const input = screen.getByLabelText('Code from your authenticator app');
    expect(input.getAttribute('autocomplete')).toBe('one-time-code');
    expect(input.getAttribute('inputmode')).toBe('numeric');

    await user.type(input, '111111');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('That code is not valid.')).toBeTruthy();

    await user.type(screen.getByLabelText('Code from your authenticator app'), '123456');
    await user.click(screen.getByRole('checkbox', { name: /Remember this browser/ }));
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls.filter((c) => c.path === '/auth/mfa/challenge').at(-1)!.body).toEqual({
      method: 'totp',
      code: '123456',
      rememberDevice: true,
    });
  });

  it('accepts a recovery code instead', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(pending),
      'POST /auth/mfa/challenge': ok(makeSession()),
    });
    renderAt('/login/verify');
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }));
    await user.type(screen.getByLabelText('Recovery code'), 'ABCD-EFGHJK-MNPQRS');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/auth/mfa/challenge')?.body).toEqual({
        method: 'recovery_code',
        code: 'ABCD-EFGHJK-MNPQRS',
        rememberDevice: false,
      }),
    );
  });

  it('sends a waiting sign-in to the code screen instead of the app', async () => {
    stubApi({ 'GET /auth/session': ok(pending) });
    const router = renderAt('/members');
    expect(await screen.findByText('Two-step verification')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login/verify');
  });
});

describe('enforcement screen and enrollment', () => {
  it('requires setup first, asks for the password, shows the QR code and recovery codes once', async () => {
    const user = userEvent.setup();
    const blocked = withMfa(
      makeSession(),
      { enrolled: false, method: null },
      { satisfied: false, reasons: ['owner'] },
    );
    const codes = Array.from({ length: 10 }, (_, i) => `AAA${i}-BBBBBB-CCCCCC`);
    const calls = stubApi({
      'GET /auth/session': [ok(blocked), ok(makeSession())],
      'POST /auth/mfa/totp/enroll': [
        fail(403, 'REAUTHENTICATION_REQUIRED', 'Please confirm your password to continue.'),
        ok({
          enrollmentId: 'e1',
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/x',
          qrCode: 'data:image/svg+xml;base64,PHN2Zy8+',
          issuer: 'Intuit 2.0',
          account: 'owner@example.test',
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }),
      ],
      'POST /auth/reauthenticate': ok(makeSession()),
      'POST /auth/mfa/totp/verify': ok({ recoveryCodes: codes, session: makeSession() }),
    });
    renderAt('/');
    expect(
      await screen.findByRole('heading', { name: 'Set up two-step verification' }),
    ).toBeTruthy();
    expect(screen.getByText(/because you own this organization/)).toBeTruthy();
    // The organization page itself is not shown.
    expect(screen.queryByText('Your access')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Set up two-step verification' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    await user.type(within(dialog).getByLabelText('Password'), 'correct horse battery staple');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    expect(
      (await screen.findByAltText('QR code for your authenticator app')).getAttribute('src'),
    ).toBe('data:image/svg+xml;base64,PHN2Zy8+');
    expect(screen.getByLabelText('Setup key').textContent).toContain('JBSW Y3DP EHPK 3PXP');
    await user.type(screen.getByLabelText('Enter the six-digit code from the app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('checkbox', { name: 'I have saved my recovery codes' }));
    await user.click(continueButton);
    expect(await screen.findByText('Your access')).toBeTruthy();
    expect(calls.find((c) => c.path === '/auth/mfa/totp/verify')?.body).toEqual({
      enrollmentId: 'e1',
      code: '123456',
    });
  });

  it('asks for a code in the session when remembered browsers are not accepted', async () => {
    const user = userEvent.setup();
    const blocked = withMfa(
      makeSession(),
      { method: 'trusted_device' },
      { satisfied: false, trustedDevicesAllowed: false },
    );
    const calls = stubApi({
      'GET /auth/session': ok(blocked),
      'POST /auth/mfa/step-up': ok(makeSession()),
    });
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Verify it’s you' })).toBeTruthy();
    await user.type(screen.getByLabelText('Code from your authenticator app'), '654321');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Your access')).toBeTruthy();
    expect(calls.find((c) => c.path === '/auth/mfa/step-up')?.body).toEqual({
      method: 'totp',
      code: '654321',
    });
  });

  it('warns when recovery codes run low', async () => {
    stubApi({ 'GET /auth/session': ok(withMfa(makeSession(), { recoveryCodesRemaining: 2 })) });
    renderAt('/');
    expect(await screen.findByText(/running low on recovery codes/)).toBeTruthy();
  });
});

describe('account security', () => {
  const status = {
    factors: [
      {
        id: 'f1',
        type: 'totp',
        label: 'Authenticator app',
        createdAt: '2026-09-01T00:00:00Z',
        activatedAt: '2026-09-01T00:00:00Z',
        lastUsedAt: null,
      },
    ],
    recoveryCodes: { remaining: 3, issuedAt: '2026-09-01T00:00:00Z' },
    requiredBy: [{ organizationId: 'org-a', name: 'Alpha Traders', reasons: ['owner'] }],
    canDisable: false,
  };

  it('regenerates recovery codes after a step-up code, and never offers "Turn off" when required', async () => {
    const user = userEvent.setup();
    const fresh = Array.from({ length: 10 }, (_, i) => `NEW${i}-BBBBBB-CCCCCC`);
    const calls = stubApi({
      'GET /auth/session': ok(makeSession()),
      'GET /auth/mfa': ok(status),
      'GET /auth/trusted-devices': ok([
        {
          id: 'd1',
          current: true,
          createdAt: '2026-09-01T00:00:00Z',
          lastUsedAt: '2026-09-02T00:00:00Z',
          expiresAt: '2026-10-01T00:00:00Z',
          ipAddress: null,
          userAgent: 'Firefox',
        },
      ]),
      'GET /auth/sessions': ok([]),
      'POST /auth/mfa/recovery-codes': [
        fail(403, 'MFA_STEP_UP_REQUIRED', 'Enter a verification code to confirm this change.'),
        ok({ recoveryCodes: fresh }),
      ],
      'POST /auth/mfa/step-up': ok(makeSession()),
      'DELETE /auth/trusted-devices/d1': () => ({ status: 204 }),
    });
    renderAt('/account/security');
    expect(await screen.findByText(/Required for you in Alpha Traders/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
    expect(screen.getByText(/running low on recovery codes/)).toBeTruthy();
    expect(await screen.findByText('This browser')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Generate new codes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enter a verification code' });
    await user.type(within(dialog).getByLabelText('Authenticator code'), '222333');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(within(list).getByText('NEW0-BBBBBB-CCCCCC')).toBeTruthy();
    expect(calls.filter((c) => c.path === '/auth/mfa/recovery-codes')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'DELETE' && c.path === '/auth/trusted-devices/d1'),
      ).toBe(true),
    );
  });
});

describe('organization security and members', () => {
  it('saves the MFA policy with its version and warns about members who must enroll', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession()),
      'GET /organizations/current/security': ok({
        requireMfaForAllMembers: false,
        allowTrustedDevices: true,
        version: 3,
        updatedAt: null,
        members: { total: 4, enrolled: 1, requiredNotEnrolled: 0 },
      }),
      'PUT /organizations/current/security': ok({
        requireMfaForAllMembers: true,
        allowTrustedDevices: false,
        version: 4,
        updatedAt: null,
      }),
    });
    renderAt('/settings/security');
    expect(
      await screen.findByText('1 of 4 active members use two-step verification.'),
    ).toBeTruthy();
    await user.click(
      screen.getByRole('checkbox', { name: /Require two-step verification for all members/ }),
    );
    expect(screen.getByText(/3 members have not set up two-step verification yet/)).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: /Allow remembered browsers/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        requireMfaForAllMembers: true,
        allowTrustedDevices: false,
        version: 3,
      }),
    );
  });

  it('offers MFA reset for other enrolled members only (not the Owner or oneself)', async () => {
    const user = userEvent.setup();
    const members = [
      {
        membershipId: 'm-owner',
        userId: 'u1',
        email: 'owner@example.test',
        displayName: 'Aisha',
        status: 'active',
        isOwner: true,
        roles: [],
        joinedAt: '2026-01-01T00:00:00Z',
        mfa: { enrolled: true, required: true },
      },
      {
        membershipId: 'm-b',
        userId: 'u2',
        email: 'b@example.test',
        displayName: 'Hassan',
        status: 'active',
        isOwner: false,
        roles: [],
        joinedAt: '2026-01-01T00:00:00Z',
        mfa: { enrolled: true, required: false },
      },
      {
        membershipId: 'm-c',
        userId: 'u3',
        email: 'c@example.test',
        displayName: 'Mariyam',
        status: 'active',
        isOwner: false,
        roles: [],
        joinedAt: '2026-01-01T00:00:00Z',
        mfa: { enrolled: false, required: true },
      },
    ];
    const calls = stubApi({
      'GET /auth/session': ok(makeSession()),
      'GET /organizations/current/members': ok(members),
      'GET /organizations/current/roles': ok([]),
      'GET /organizations/current/invitations': ok([]),
      'POST /organizations/current/members/m-b/mfa-reset': ok({ membershipId: 'm-b' }),
    });
    renderAt('/members');
    expect(await screen.findByText('Required, not set up')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Reset two-step verification' });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]!);
    expect(screen.getByText(/Hassan will be signed out everywhere/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/organizations/current/members/m-b/mfa-reset')).toBe(
        true,
      ),
    );
  });
});
