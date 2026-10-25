import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { Permission } from '../src/permissions/permissions';
import { reply, stubHelpApi, type HelpStubOptions } from './help-stub';

/**
 * The assistant panel: opening, suggested prompts, the conversation, loading, errors and retry,
 * the rate-limit message, verified figures shown apart from guidance, plain-text rendering of
 * model output, clearing, and what is sent to the server (history and page, never raw content
 * the user did not type).
 */

async function open(options: HelpStubOptions = {}, path = '/sales/invoices') {
  const state = stubHelpApi({ permissions: Object.values(Permission), ...options });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Open the assistant' }));
  const dialog = await screen.findByRole('dialog', { name: 'Assistant' });
  return { state, user, dialog, router };
}

/** Holds back answers from the assistant endpoint until the returned function is called. */
function holdAssistant(): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/assistant/messages')) await gate;
    return original(input, init);
  }) as typeof fetch;
  return release;
}

const ask = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  await user.type(screen.getByRole('textbox', { name: 'Your question' }), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
};

const messages = (state: ReturnType<typeof stubHelpApi>) =>
  state.requests
    .filter((r) => r.path === '/assistant/messages')
    .map((r) => r.body as Record<string, unknown>);

describe('opening and the first view', () => {
  it('opens an accessible dialog with the question box focused and suggestions offered', async () => {
    const { dialog } = await open();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const box = within(dialog).getByRole('textbox', { name: 'Your question' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(
      await within(dialog).findByRole('button', { name: 'How do I create and issue an invoice?' }),
    ).toBeTruthy();
    expect(within(dialog).getByRole('log', { name: 'Conversation' })).toBeTruthy();
    // It says plainly what it can and cannot do.
    expect(within(dialog).getByText(/cannot post, change, pay or delete/)).toBeTruthy();
  });

  it('says that AI wording is off when the server runs the built-in help', async () => {
    const { dialog } = await open({ mode: 'documentation' });
    expect(await within(dialog).findByText('Built-in help')).toBeTruthy();
    expect(within(dialog).getByText(/AI wording is not enabled/)).toBeTruthy();
  });

  it('labels AI-assisted wording only when the server says it is live', async () => {
    const { dialog } = await open({ mode: 'ai' });
    expect(await within(dialog).findByText('AI-assisted wording')).toBeTruthy();
    expect(within(dialog).queryByText(/AI wording is not enabled/)).toBeNull();
  });

  it('closes with Escape and the Close button, returning focus to the opener', async () => {
    const { user } = await open();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const opener = screen.getByRole('button', { name: 'Open the assistant' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await user.click(opener);
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('asking', () => {
  it('sends the question with the current page and shows the answer', async () => {
    const { state, user, dialog } = await open();
    await ask(user, 'How do I issue an invoice?');
    expect(
      await within(dialog).findByText('Open Sales > Invoices and choose New invoice.'),
    ).toBeTruthy();
    expect(messages(state)).toEqual([
      { message: 'How do I issue an invoice?', history: [], path: '/sales/invoices' },
    ]);
    // The question box is emptied and the suggestions are gone.
    expect(
      (screen.getByRole('textbox', { name: 'Your question' }) as HTMLTextAreaElement).value,
    ).toBe('');
    expect(within(dialog).queryByText('Try asking')).toBeNull();
  });

  it('sends a suggested question when it is chosen', async () => {
    const { state, user, dialog } = await open();
    await user.click(await within(dialog).findByRole('button', { name: 'What can each role do?' }));
    await waitFor(() => expect(messages(state)).toHaveLength(1));
    expect(messages(state)[0]!.message).toBe('What can each role do?');
  });

  it('sends the earlier turns as history on the next question', async () => {
    const { state, user, dialog } = await open();
    await ask(user, 'First question');
    await within(dialog).findByText('Open Sales > Invoices and choose New invoice.');
    await ask(user, 'Second question');
    await waitFor(() => expect(messages(state)).toHaveLength(2));
    expect(messages(state)[1]!.history).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'Open Sales > Invoices and choose New invoice.' },
    ]);
  });

  it('can be sent with Ctrl+Enter, and ignores empty questions', async () => {
    const { state, user } = await open();
    const box = screen.getByRole('textbox', { name: 'Your question' });
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
    await user.type(box, '   ');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
    await user.type(box, 'hello{Control>}{Enter}{/Control}');
    await waitFor(() => expect(messages(state)).toHaveLength(1));
    expect(messages(state)[0]!.message).toBe('hello');
  });

  it('limits the question length and shows how much is left', async () => {
    await open();
    const box = screen.getByRole('textbox', { name: 'Your question' }) as HTMLTextAreaElement;
    expect(box.maxLength).toBe(2000);
    expect(screen.getByText(/0 of 2000 characters/)).toBeTruthy();
  });

  it('shows a loading state while waiting, and blocks a second send', async () => {
    const { user, dialog } = await open();
    const release = holdAssistant();
    await ask(user, 'Slow question');
    expect(
      await within(dialog).findByText('The assistant is working on your question…'),
    ).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'Another');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
    release();
    expect(
      await within(dialog).findByText('Open Sales > Invoices and choose New invoice.'),
    ).toBeTruthy();
    expect(within(dialog).queryByText('The assistant is working on your question…')).toBeNull();
  });

  it('renders model output as plain text, never as markup', async () => {
    const { user, dialog } = await open({
      assistant: () =>
        reply({ reply: '<img src=x onerror=alert(1)> **bold** <b>tag</b>', mode: 'ai' }),
    });
    await ask(user, 'anything');
    const text = await within(dialog).findByText(/onerror=alert/);
    expect(text.textContent).toBe('<img src=x onerror=alert(1)> **bold** <b>tag</b>');
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.querySelector('b')).toBeNull();
  });
});

describe('failures', () => {
  const failing = () =>
    new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });

  it('keeps the question, explains the failure and retries without duplicating it', async () => {
    const { state, user, dialog } = await open({
      assistant: ({ count }) => (count === 1 ? failing() : reply({ reply: 'Second try worked.' })),
    });
    await ask(user, 'Will this fail?');
    expect(await within(dialog).findByText(/could not answer/)).toBeTruthy();
    expect(within(dialog).getAllByText('Will this fail?')).toHaveLength(1);

    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByText('Second try worked.')).toBeTruthy();
    expect(within(dialog).getAllByText('Will this fail?')).toHaveLength(1);
    expect(within(dialog).queryByText(/could not answer/)).toBeNull();
    expect(messages(state)).toHaveLength(2);
    expect(messages(state)[1]!.history).toEqual([]);
  });

  it('tells the person when to try again after a rate limit', async () => {
    const { user, dialog } = await open({
      assistant: () =>
        new Response(
          JSON.stringify({
            error: { code: 'TOO_MANY_ATTEMPTS', message: 'Rate limit exceeded.', requestId: 'r' },
          }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '17' } },
        ),
    });
    await ask(user, 'Too fast');
    expect(await within(dialog).findByText(/Try again in 17 seconds/)).toBeTruthy();
  });

  it('says when a live model failed and the built-in help answered instead', async () => {
    const { user, dialog } = await open({
      mode: 'ai',
      assistant: () => reply({ degraded: true, mode: 'documentation' }),
    });
    await ask(user, 'Hello');
    expect(await within(dialog).findByText(/AI service could not answer just now/)).toBeTruthy();
  });
});

describe('verified figures', () => {
  it('shows figures apart from the guidance, with where they came from', async () => {
    const { user, dialog } = await open({
      assistant: () =>
        reply({
          reply: 'Figures from your books are below.',
          figures: [
            {
              id: 'receivables',
              title: 'Receivables (what customers owe)',
              rows: [
                { label: 'Not yet due', amount: '100.0000', display: '100.00', currency: 'MVR' },
                { label: 'Total', amount: '15000.0000', display: '15,000.00', currency: 'MVR' },
              ],
              period: 'as of 2026-10-25',
              source: 'Sales > Reports',
            },
          ],
        }),
    });
    await ask(user, 'How much do customers owe us?');
    const table = await within(dialog).findByRole('table');
    // The formatted amount is shown; the raw four-decimal form is not.
    expect(within(table).getByText('15,000.00 MVR')).toBeTruthy();
    expect(within(table).queryByText(/15000\.0000/)).toBeNull();
    expect(within(table).getByText(/From your books/)).toBeTruthy();
    expect(within(table).getByText(/Sales > Reports/)).toBeTruthy();
  });

  it('links the related tutorial and closes the panel when it is followed', async () => {
    const { user, dialog, router } = await open({
      assistant: () =>
        reply({
          sources: [
            {
              topicId: 'invoices',
              title: 'Invoices',
              route: '/sales/invoices',
              tutorialId: 'invoices',
            },
            {
              topicId: 'receipts',
              title: 'Receipts',
              route: '/sales/receipts',
              tutorialId: 'invoices',
            },
            { topicId: 'x', title: 'Unknown', route: null, tutorialId: 'not-in-catalogue' },
          ],
        }),
    });
    await ask(user, 'invoices');
    const links = await within(dialog).findAllByRole('link', {
      name: 'Tutorial: Creating and managing invoices',
    });
    // De-duplicated, and a tutorial the web does not know is not linked.
    expect(links).toHaveLength(1);
    await user.click(links[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/help/tutorials/invoices'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assistant' })).toBeNull());
  });
});

describe('the conversation', () => {
  it('survives closing and reopening, and Clear conversation empties it', async () => {
    const { user, dialog } = await open();
    await ask(user, 'Remember me');
    await within(dialog).findByText('Open Sales > Invoices and choose New invoice.');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Open the assistant' }));
    const again = await screen.findByRole('dialog', { name: 'Assistant' });
    expect(within(again).getByText('Remember me')).toBeTruthy();

    await user.click(within(again).getByRole('button', { name: 'Clear conversation' }));
    expect(within(again).queryByText('Remember me')).toBeNull();
    expect(within(again).getByText('No questions yet.')).toBeTruthy();
    expect(within(again).getByRole('button', { name: 'Clear conversation' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('drops a late answer to a question asked before the conversation was cleared', async () => {
    const { state, user, dialog } = await open({
      assistant: () => reply({ reply: 'Late answer.' }),
    });
    const release = holdAssistant();
    await ask(user, 'Slow question');
    await user.click(within(dialog).getByRole('button', { name: 'Clear conversation' }));
    release();
    await waitFor(() => expect(messages(state)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(dialog).queryByText('Late answer.')).toBeNull();
    expect(within(dialog).getByText('No questions yet.')).toBeTruthy();
  });
});

describe('from the Help centre', () => {
  it('opens the same panel', async () => {
    stubHelpApi({ permissions: Object.values(Permission) });
    const router = createMemoryRouter(routes, { initialEntries: ['/help'] });
    render(<App router={router} queryClient={createQueryClient()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ask the assistant' }));
    expect(await screen.findByRole('dialog', { name: 'Assistant' })).toBeTruthy();
  });
});
