import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

/**
 * The shared check for a destructive action that asks for confirmation in an in-app dialog:
 * cancelling by button, by Escape and (for ConfirmDialog) by clicking outside sends nothing and
 * returns focus to the trigger; only the confirm button sends the request.
 */
export async function expectConfirmFlow({
  user,
  trigger,
  title,
  message,
  confirmName,
  requestSent,
}: {
  user: UserEvent;
  /** Finds the button that opens the dialog; called again after each dismissal. */
  trigger: () => HTMLElement;
  title: string;
  message: string | RegExp;
  confirmName: string;
  requestSent: () => boolean;
}) {
  const open = async () => {
    await user.click(trigger());
    const dialog = await screen.findByRole('dialog', { name: title });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByText(message)).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    // Focus starts on the safe choice.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    return dialog;
  };
  const closed = async () => {
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requestSent()).toBe(false);
  };

  // Cancel button.
  await open();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await closed();
  await waitFor(() => expect(document.activeElement).toBe(trigger()));

  // Escape never confirms.
  await open();
  await user.keyboard('{Escape}');
  await closed();
  await waitFor(() => expect(document.activeElement).toBe(trigger()));

  // Clicking outside never confirms.
  const dialog = await open();
  await user.pointer({ keys: '[MouseLeft]', target: dialog.parentElement! });
  await closed();

  // Confirm sends the request.
  const confirm = await open();
  await user.click(within(confirm).getByRole('button', { name: confirmName }));
  await waitFor(() => expect(requestSent()).toBe(true));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}
