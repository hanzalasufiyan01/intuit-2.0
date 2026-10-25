import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ReauthProvider, useSensitiveAction } from '../src/auth/reauth';
import { api } from '../src/services/api-client';
import { ConfirmDialog } from '../src/shared/ui/ConfirmDialog';
import { Dialog } from '../src/shared/ui/Dialog';

/** UI phase 3, batch D: Dialog, ConfirmDialog and the re-authentication dialog built on them. */

function Host({ dismissOnBackdrop = false }: { dismissOnBackdrop?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <main>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <button type="button">Background action</button>
      </main>
      {open ? (
        <Dialog
          title="Edit note"
          description="Changes are saved when you press Save."
          dismissOnBackdrop={dismissOnBackdrop}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button">Save</button>
              <button type="button" onClick={() => setOpen(false)}>
                Close
              </button>
            </>
          }
        >
          <input aria-label="Note" />
        </Dialog>
      ) : null}
    </>
  );
}

describe('Dialog semantics', () => {
  it('is a modal dialog named by its title and described by its description', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit note' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).toBe(
      screen.getByText('Changes are saved when you press Save.').id,
    );
    expect(dialog.parentElement!.parentElement).toBe(document.body); // portalled out of the page
  });

  it('makes the rest of the page inert and locks scrolling while open, then undoes both', async () => {
    const user = userEvent.setup();
    const { container } = render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(container.hasAttribute('inert')).toBe(true);
    expect(document.body.hasAttribute('data-dialog-open')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(container.hasAttribute('inert')).toBe(false);
    expect(document.body.hasAttribute('data-dialog-open')).toBe(false);
    expect(screen.getByRole('button', { name: 'Background action' })).toBeTruthy();
  });

  it('only undoes the inert state it set itself', async () => {
    const user = userEvent.setup();
    const other = document.createElement('div');
    other.setAttribute('inert', '');
    document.body.appendChild(other);
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(other.hasAttribute('inert')).toBe(true); // it was inert before, and still is
    other.remove();
  });
});

describe('Dialog focus', () => {
  it('moves focus to the first control, keeps Tab inside, and returns it to the opener', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog');
    const note = within(dialog).getByLabelText('Note');
    expect(document.activeElement).toBe(note);
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Save' }));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
    await user.tab(); // wraps from the last control to the first
    expect(document.activeElement).toBe(note);
    await user.tab({ shift: true }); // and back from the first to the last
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
    for (let i = 0; i < 6; i += 1) await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
  });

  it('falls back to the main region when the opener has been removed', async () => {
    const user = userEvent.setup();
    function Removable() {
      const [open, setOpen] = useState(false);
      const [gone, setGone] = useState(false);
      return (
        <>
          <main>
            {gone ? null : (
              <button type="button" onClick={() => setOpen(true)}>
                Delete row
              </button>
            )}
          </main>
          {open ? (
            <Dialog
              title="Deleted"
              onClose={() => {
                setGone(true);
                setOpen(false);
              }}
            >
              <button type="button" onClick={() => (setGone(true), setOpen(false))}>
                OK
              </button>
            </Dialog>
          ) : null}
        </>
      );
    }
    render(<Removable />);
    await user.click(screen.getByRole('button', { name: 'Delete row' }));
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('button', { name: 'Delete row' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('cleans up when it is unmounted by its parent', async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    unmount();
    expect(document.body.hasAttribute('data-dialog-open')).toBe(false);
    expect(container.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('Dialog dismissal', () => {
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores a click on the backdrop unless dismissOnBackdrop is set', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.pointer({
      keys: '[MouseLeft]',
      target: screen.getByRole('dialog').parentElement!,
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    unmount();

    render(<Host dismissOnBackdrop />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('dialog')); // a click inside never dismisses
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.pointer({
      keys: '[MouseLeft]',
      target: screen.getByRole('dialog').parentElement!,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lets only the topmost of two stacked dialogs react to Escape', async () => {
    const user = userEvent.setup();
    function Stack() {
      const [inner, setInner] = useState(false);
      const [outer, setOuter] = useState(true);
      return outer ? (
        <Dialog title="Outer" onClose={() => setOuter(false)}>
          <button type="button" onClick={() => setInner(true)}>
            Open inner
          </button>
          {inner ? (
            <Dialog title="Inner" onClose={() => setInner(false)}>
              <button type="button">Inner action</button>
            </Dialog>
          ) : null}
        </Dialog>
      ) : null;
    }
    render(<Stack />);
    await user.click(screen.getByRole('button', { name: 'Open inner' }));
    expect(screen.getByRole('dialog', { name: 'Inner' })).toBeTruthy();
    const outerBackdrop = screen.getByRole('dialog', { name: 'Outer' }).parentElement!;
    expect(outerBackdrop.hasAttribute('inert')).toBe(true); // the inner dialog blocks it
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeTruthy();
    // The outer dialog is usable again, focus is back on its opener, and the page stays locked.
    expect(outerBackdrop.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open inner' }));
    expect(document.body.hasAttribute('data-dialog-open')).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.hasAttribute('data-dialog-open')).toBe(false);
  });
});

describe('ConfirmDialog', () => {
  const renderConfirm = (props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete this draft?"
        message="Delete this draft bill?"
        confirmLabel="Delete"
        destructive
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      />,
    );
    return { onConfirm, onCancel };
  };

  it('renders nothing while closed', () => {
    renderConfirm({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is named and described, starts on Cancel, and styles a destructive confirm as danger', () => {
    renderConfirm();
    const dialog = screen.getByRole('dialog', { name: 'Delete this draft?' });
    expect(within(dialog).getByText('Delete this draft bill?')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(
      within(dialog).getByRole('button', { name: 'Delete' }).classList.contains('btn--danger'),
    ).toBe(true);
  });

  it('uses the primary style and translated default labels for a non-destructive confirm', () => {
    render(
      <ConfirmDialog
        open
        title="Send reminder?"
        message="A reminder email will be sent."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm.classList.contains('btn--primary')).toBe(true);
  });

  it('confirms only through the confirm button', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderConfirm();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels with the Cancel button, Escape, or a click outside, and never confirms', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderConfirm();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    await user.pointer({ keys: '[MouseLeft]', target: screen.getByRole('dialog').parentElement! });
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not activate the confirm button with Enter while focus is on Cancel', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderConfirm();
    await user.keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('while busy: both buttons are disabled, the confirm shows progress, nothing can be repeated', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderConfirm({ busy: true });
    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(confirm);
    await user.keyboard('{Escape}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled(); // cannot be dismissed half-way
  });
});

// --- re-authentication -----------------------------------------------------------------------------

function mockReauthApi(handlers: {
  action: () => { status: number; body?: unknown };
  reauth?: () => { status: number; body?: unknown };
}) {
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api\/v1/, '');
      calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const result = path === '/auth/reauthenticate' ? handlers.reauth!() : handlers.action();
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

const needsPassword = {
  status: 403,
  body: {
    error: {
      code: 'REAUTHENTICATION_REQUIRED',
      message: 'Please confirm your password to continue.',
      requestId: 'r',
    },
  },
};

function ReauthHarness() {
  const sensitive = useSensitiveAction();
  const [result, setResult] = useState('idle');
  return (
    <main>
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

function renderReauth() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReauthProvider>
        <ReauthHarness />
      </ReauthProvider>
    </QueryClientProvider>,
  );
}

describe('re-authentication dialog', () => {
  it('asks for the password in a named modal dialog with the field focused', async () => {
    const user = userEvent.setup();
    mockReauthApi({ action: () => needsPassword });
    renderReauth();
    await user.click(screen.getByRole('button', { name: 'Run sensitive action' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(
      within(dialog).getByText('This is a sensitive action. Confirm your password to continue.'),
    ).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Password'));
  });

  it('confirms the password, then retries the action once and resolves it', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const calls = mockReauthApi({
      action: () => (attempts++ === 0 ? needsPassword : { status: 200, body: { data: {} } }),
      reauth: () => ({ status: 204 }),
    });
    renderReauth();
    const opener = screen.getByRole('button', { name: 'Run sensitive action' });
    await user.click(opener);
    await user.type(await screen.findByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByText('done')).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.map((c) => c.path)).toEqual([
      '/sensitive/thing',
      '/auth/reauthenticate',
      '/sensitive/thing',
    ]);
    expect(calls[1]!.body).toEqual({ password: 'correct horse' });
    expect(document.activeElement).toBe(opener);
  });

  it('keeps the dialog open and shows the error when the password is wrong', async () => {
    const user = userEvent.setup();
    mockReauthApi({
      action: () => needsPassword,
      reauth: () => ({
        status: 401,
        body: {
          error: { code: 'INVALID_CREDENTIALS', message: 'Wrong password.', requestId: 'r' },
        },
      }),
    });
    renderReauth();
    await user.click(screen.getByRole('button', { name: 'Run sensitive action' }));
    await user.type(await screen.findByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Wrong password/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Confirm your password' })).toBeTruthy();
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });

  it('rejects the action when cancelled with the button or Escape, and not on a backdrop click', async () => {
    const user = userEvent.setup();
    mockReauthApi({ action: () => needsPassword });
    renderReauth();
    await user.click(screen.getByRole('button', { name: 'Run sensitive action' }));
    const dialog = await screen.findByRole('dialog');
    await user.pointer({ keys: '[MouseLeft]', target: dialog.parentElement! });
    expect(screen.getByRole('dialog')).toBeTruthy(); // typed secrets are not lost to a stray click
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByText('rejected: Password confirmation cancelled.')).toBeTruthy(),
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Run sensitive action' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('rejected: Password confirmation cancelled.')).toBeTruthy();
  });

  it('asks for a verification code and can switch to a recovery code', async () => {
    const user = userEvent.setup();
    mockReauthApi({
      action: () => ({
        status: 403,
        body: {
          error: { code: 'MFA_STEP_UP_REQUIRED', message: 'Enter a code.', requestId: 'r' },
        },
      }),
    });
    renderReauth();
    await user.click(screen.getByRole('button', { name: 'Run sensitive action' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enter a verification code' });
    expect(within(dialog).getByLabelText('Authenticator code')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Use a recovery code instead' }));
    expect(within(dialog).getByLabelText('Recovery code')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Use your authenticator app' }));
    expect(within(dialog).getByLabelText('Authenticator code')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByText('rejected: Verification cancelled.')).toBeTruthy());
  });
});

describe('re-authentication over an open, busy ConfirmDialog', () => {
  function Stacked() {
    const sensitive = useSensitiveAction();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState('idle');
    return (
      <main>
        <button type="button" onClick={() => setOpen(true)}>
          Delete
        </button>
        <p>{result}</p>
        <ConfirmDialog
          open={open}
          busy={busy}
          destructive
          title="Delete this draft?"
          message="Delete it for good?"
          confirmLabel="Delete it"
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            setBusy(true);
            void sensitive(() => api.post('/sensitive/thing', {}))
              .then(
                () => setResult('done'),
                (e: Error) => setResult(`rejected: ${e.message}`),
              )
              .finally(() => {
                setBusy(false);
                setOpen(false);
              });
          }}
        />
      </main>
    );
  }
  const renderStacked = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ReauthProvider>
          <Stacked />
        </ReauthProvider>
      </QueryClientProvider>,
    );

  it('stacks the password prompt above the confirmation; cancelling rejects the action and returns to it', async () => {
    const user = userEvent.setup();
    const calls = mockReauthApi({ action: () => needsPassword });
    renderStacked();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete it' }));
    const prompt = await screen.findByRole('dialog', { name: 'Confirm your password' });
    const confirm = screen.getByRole('dialog', { name: 'Delete this draft?' });
    // The confirmation is busy and blocked; the prompt is on top and owns focus.
    expect(confirm.parentElement!.hasAttribute('inert')).toBe(true);
    expect(
      within(confirm).getByRole('button', { name: 'Delete it' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(prompt.contains(document.activeElement)).toBe(true);
    // Escape reaches only the prompt: it cancels, the action is rejected, and nothing is retried.
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.getByText('rejected: Password confirmation cancelled.')).toBeTruthy(),
    );
    expect(screen.queryByRole('dialog', { name: 'Confirm your password' })).toBeNull();
    expect(calls.filter((c) => c.path === '/sensitive/thing')).toHaveLength(1);
    // The confirmation finished with the action: the page is usable and focus is on the opener.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }));
    expect(document.body.hasAttribute('data-dialog-open')).toBe(false);
    expect(document.getElementById('root')?.hasAttribute('inert') ?? false).toBe(false);
  });

  it('keeps focus inside the still-open, busy confirmation when the prompt closes first', async () => {
    const user = userEvent.setup();
    let requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), 'http://localhost').pathname;
        if (path.endsWith('/auth/reauthenticate')) return new Response(null, { status: 204 });
        requests += 1;
        // The first attempt needs a password; the retry never finishes, so the confirmation
        // stays busy (its buttons disabled) after the prompt has closed.
        if (requests === 1) {
          return new Response(JSON.stringify(needsPassword.body), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Promise<Response>(() => {});
      }),
    );
    // Same harness, but the confirmation outlives the action so its state can be inspected.
    function Held() {
      const sensitive = useSensitiveAction();
      const [busy, setBusy] = useState(false);
      return (
        <main>
          <ConfirmDialog
            open
            busy={busy}
            title="Hold on"
            message="Held open."
            onCancel={() => {}}
            onConfirm={() => {
              setBusy(true);
              void sensitive(() => api.post('/sensitive/thing', {})).finally(() => setBusy(false));
            }}
          />
        </main>
      );
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ReauthProvider>
          <Held />
        </ReauthProvider>
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await user.type(await screen.findByLabelText('Password'), 'pw');
    await user.click(
      within(screen.getByRole('dialog', { name: 'Confirm your password' })).getByRole('button', {
        name: 'Confirm',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Confirm your password' })).toBeNull(),
    );
    const held = screen.getByRole('dialog', { name: 'Hold on' });
    await waitFor(() => expect(held.parentElement!.hasAttribute('inert')).toBe(false));
    // The opener (the now-disabled Confirm button) cannot take focus back: it stays in the dialog.
    expect(held.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLButtonElement).disabled).toBeFalsy();
    expect(document.body.hasAttribute('data-dialog-open')).toBe(true);
  });
});

describe('overlapping dialogs closing in either order', () => {
  interface Controls {
    closeA: () => void;
    closeB: () => void;
  }

  /** Set by the harness on every render so a test can close either dialog from outside. */
  const controls: { current: Controls | null } = { current: null };

  /** Two sibling modal dialogs; B is opened from inside A. Either can be closed from outside. */
  function TwoDialogs() {
    const [a, setA] = useState(false);
    const [b, setB] = useState(false);
    useEffect(() => {
      controls.current = { closeA: () => setA(false), closeB: () => setB(false) };
    });
    return (
      <>
        <main>
          <button type="button" onClick={() => setA(true)}>
            Open A
          </button>
        </main>
        {a ? (
          <Dialog title="A" onClose={() => setA(false)}>
            <button type="button" onClick={() => setB(true)}>
              Open B
            </button>
          </Dialog>
        ) : null}
        {b ? (
          <Dialog title="B" onClose={() => setB(false)}>
            <button type="button">B first</button>
            <input aria-label="B field" />
          </Dialog>
        ) : null}
      </>
    );
  }

  async function openBoth() {
    const user = userEvent.setup();
    controls.current = null;
    const { container } = render(<TwoDialogs />);
    await user.click(screen.getByRole('button', { name: 'Open A' }));
    await user.click(screen.getByRole('button', { name: 'Open B' }));
    const backdropA = screen.getByRole('dialog', { name: 'A' }).parentElement!;
    const backdropB = screen.getByRole('dialog', { name: 'B' }).parentElement!;
    return { user, controls, container, backdropA, backdropB };
  }

  it('closing the top dialog first re-opens the one below and keeps the page locked', async () => {
    const { controls, container, backdropA, backdropB } = await openBoth();
    expect(container.hasAttribute('inert')).toBe(true);
    expect(backdropA.hasAttribute('inert')).toBe(true);
    expect(backdropB.hasAttribute('inert')).toBe(false);
    act(() => controls.current!.closeB());
    expect(backdropA.hasAttribute('inert')).toBe(false);
    expect(container.hasAttribute('inert')).toBe(true);
    expect(document.body.hasAttribute('data-dialog-open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open B' }));
    act(() => controls.current!.closeA());
    expect(container.hasAttribute('inert')).toBe(false);
    expect(document.body.hasAttribute('data-dialog-open')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closing the lower dialog first keeps the page inert and focus in the dialog still open', async () => {
    const { user, controls, container, backdropB } = await openBoth();
    await user.click(screen.getByLabelText('B field'));
    act(() => controls.current!.closeA());
    expect(screen.queryByRole('dialog', { name: 'A' })).toBeNull();
    // B is still open: the page behind it must stay locked and B must stay usable.
    expect(container.hasAttribute('inert')).toBe(true);
    expect(backdropB.hasAttribute('inert')).toBe(false);
    expect(document.body.hasAttribute('data-dialog-open')).toBe(true);
    // Focus is not pulled out of B (for example back to A's opener behind it).
    expect(document.activeElement).toBe(screen.getByLabelText('B field'));
    await user.tab();
    expect(screen.getByRole('dialog', { name: 'B' }).contains(document.activeElement)).toBe(true);
    act(() => controls.current!.closeB());
    expect(container.hasAttribute('inert')).toBe(false);
    expect(document.body.hasAttribute('data-dialog-open')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never un-inerts something that was inert before, whichever dialog closes first', async () => {
    const other = document.createElement('div');
    other.setAttribute('inert', '');
    document.body.appendChild(other);
    const { controls } = await openBoth();
    act(() => controls.current!.closeA());
    expect(other.hasAttribute('inert')).toBe(true);
    act(() => controls.current!.closeB());
    expect(other.hasAttribute('inert')).toBe(true);
    other.remove();
  });
});
