import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { useSensitiveAction } from '../src/auth/reauth';
import { LOCALES, useLocale } from '../src/i18n/i18n';
import { api } from '../src/services/api-client';
import { makeSession } from './fake-api';

/**
 * The re-authentication dialog renders its text through useT(), so it must sit inside the locale
 * provider: the real App composition is used here to prove it follows the user's chosen language.
 * A throw-away approved locale ("xx") stands in for a future language; it is removed after each test.
 */

const XX = {
  'reauth.password.title': 'XX confirm password',
  'reauth.password.body': 'XX sensitive action body',
  'reauth.field.password': 'XX password field',
  'reauth.code.title': 'XX enter code',
  'reauth.code.body': 'XX security change body',
  'reauth.field.authenticatorCode': 'XX authenticator code',
  'reauth.cancelled.password': 'XX password cancelled',
  'reauth.cancelled.code': 'XX code cancelled',
  'common.confirm': 'XX confirm',
  'common.cancel': 'XX cancel',
} as const;

function Harness() {
  const sensitive = useSensitiveAction();
  const { setLocale } = useLocale();
  const [result, setResult] = useState('idle');
  return (
    <main>
      <button type="button" onClick={() => setLocale('xx')}>
        Switch to xx
      </button>
      <button
        type="button"
        onClick={() =>
          void sensitive(() => api.post('/sensitive/thing', {})).then(
            () => setResult('done'),
            (e: Error) => setResult(`rejected: ${e.message}`),
          )
        }
      >
        Run sensitive action
      </button>
      <p>{result}</p>
    </main>
  );
}

/** The first call to the sensitive endpoint asks for `code`; later calls succeed. */
function stubApi(code: 'REAUTHENTICATION_REQUIRED' | 'MFA_STEP_UP_REQUIRED') {
  let sensitiveCalls = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api\/v1/, '');
      const key = `${init.method ?? 'GET'} ${path}`;
      if (key === 'GET /auth/session') return json(200, { data: makeSession({ permissions: [] }) });
      if (key === 'POST /sensitive/thing') {
        sensitiveCalls += 1;
        return sensitiveCalls === 1
          ? json(403, { error: { code, message: 'Needs confirmation.', requestId: 'r' } })
          : json(200, { data: {} });
      }
      if (key === 'POST /auth/reauthenticate' || key === 'POST /auth/mfa/step-up') {
        return json(200, { data: makeSession({ permissions: [] }) });
      }
      return json(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } });
    }),
  );
}

function renderApp() {
  const router = createMemoryRouter([{ path: '/', element: <Harness /> }], {
    initialEntries: ['/'],
  });
  render(<App router={router} queryClient={createQueryClient()} />);
}

beforeEach(() => {
  LOCALES.xx = {
    tag: 'xx',
    nativeName: 'Test language',
    dir: 'ltr',
    status: 'approved',
    messages: XX,
  };
  window.localStorage.removeItem('intuit2.locale');
});

afterEach(() => {
  delete LOCALES.xx;
  window.localStorage.removeItem('intuit2.locale');
  vi.unstubAllGlobals();
});

describe('re-authentication dialog and the active locale', () => {
  it('asks for the password in the language the user chose', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('intuit2.locale', 'xx');
    stubApi('REAUTHENTICATION_REQUIRED');
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Run sensitive action' }));
    const dialog = await screen.findByRole('dialog', { name: 'XX confirm password' });
    expect(within(dialog).getByText('XX sensitive action body')).toBeTruthy();
    expect(within(dialog).getByLabelText('XX password field')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'XX confirm' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'XX cancel' })).toBeTruthy();
    // Nothing of the English wording is left over.
    expect(screen.queryByText('Confirm your password')).toBeNull();
  });

  it('asks for the verification code in the chosen language, and a cancel reports in it', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('intuit2.locale', 'xx');
    stubApi('MFA_STEP_UP_REQUIRED');
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Run sensitive action' }));
    const dialog = await screen.findByRole('dialog', { name: 'XX enter code' });
    expect(within(dialog).getByLabelText('XX authenticator code')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'XX cancel' }));
    expect(await screen.findByText('rejected: XX code cancelled')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports a cancelled password prompt in the chosen language', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('intuit2.locale', 'xx');
    stubApi('REAUTHENTICATION_REQUIRED');
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Run sensitive action' }));
    await screen.findByRole('dialog', { name: 'XX confirm password' });
    await user.keyboard('{Escape}');
    expect(await screen.findByText('rejected: XX password cancelled')).toBeTruthy();
  });

  it('follows a language change made while the app is running', async () => {
    const user = userEvent.setup();
    stubApi('REAUTHENTICATION_REQUIRED');
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Switch to xx' }));
    await user.click(screen.getByRole('button', { name: 'Run sensitive action' }));
    expect(await screen.findByRole('dialog', { name: 'XX confirm password' })).toBeTruthy();
  });

  it('keeps the English wording and the whole flow when no other language is chosen', async () => {
    const user = userEvent.setup();
    stubApi('REAUTHENTICATION_REQUIRED');
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Run sensitive action' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    expect(
      within(dialog).getByText('This is a sensitive action. Confirm your password to continue.'),
    ).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Password'), 'correct horse');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByText('done')).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the English cancel message when no other language is chosen', async () => {
    const user = userEvent.setup();
    stubApi('REAUTHENTICATION_REQUIRED');
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Run sensitive action' }));
    await screen.findByRole('dialog', { name: 'Confirm your password' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('rejected: Password confirmation cancelled.')).toBeTruthy();
  });
});
