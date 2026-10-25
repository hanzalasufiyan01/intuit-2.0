import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { ThemeToggle } from '../src/app/ThemeToggle';
import { applyThemeChoice, readThemeChoice, THEME_STORAGE_KEY } from '../src/shared/theme';
import { installFakeApi, makeSession } from './fake-api';

/**
 * Colour theme (UI phase 1): System, Light or Dark, remembered on this device only. The choice is
 * a `data-theme` attribute on the document root; with System the attribute is absent and the
 * stylesheet follows prefers-color-scheme.
 */

const root = document.documentElement;

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  root.removeAttribute('data-theme');
});

describe('theme choice', () => {
  it('defaults to System and reads only valid stored choices', () => {
    expect(readThemeChoice()).toBe('system');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readThemeChoice()).toBe('dark');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(readThemeChoice()).toBe('light');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readThemeChoice()).toBe('system');
  });

  it('falls back to System when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(readThemeChoice()).toBe('system');
  });

  it('sets the data-theme attribute for an explicit choice and removes it for System', () => {
    applyThemeChoice('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    applyThemeChoice('light');
    expect(root.getAttribute('data-theme')).toBe('light');
    applyThemeChoice('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});

describe('theme toggle', () => {
  const pressed = (name: string) =>
    screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true';

  it('offers System, Light and Dark as a labelled group, with System selected by default', () => {
    render(<ThemeToggle />);
    const group = screen.getByRole('group', { name: 'Theme' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['System', 'Light', 'Dark']);
    expect(pressed('System')).toBe(true);
    expect(pressed('Dark')).toBe(false);
  });

  it('applies and remembers an explicit choice, and System clears it', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(pressed('Dark')).toBe(true);
    expect(pressed('System')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    await user.click(screen.getByRole('button', { name: 'System' }));
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(pressed('System')).toBe(true);
  });

  it('starts from the remembered choice', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(<ThemeToggle />);
    expect(pressed('Dark')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('still applies a choice when it cannot be remembered', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    render(<ThemeToggle />);
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(pressed('Dark')).toBe(true);
  });

  it('follows a change made in another tab', () => {
    render(<ThemeToggle />);
    expect(pressed('System')).toBe(true);
    act(() => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));
    });
    expect(pressed('Dark')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});

describe('theme-init.js (applied before the first paint)', () => {
  const script = readFileSync(join(__dirname, '../public/theme-init.js'), 'utf8');
  const run = () => (0, eval)(script);

  it('reads the same storage key as the app', () => {
    expect(script).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  it('applies a stored Light or Dark choice and ignores anything else', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    run();
    expect(root.getAttribute('data-theme')).toBe('dark');

    root.removeAttribute('data-theme');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    run();
    expect(root.getAttribute('data-theme')).toBe('light');

    root.removeAttribute('data-theme');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    run();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('does nothing when there is no stored choice, and never throws when storage is blocked', () => {
    run();
    expect(root.hasAttribute('data-theme')).toBe(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(run).not.toThrow();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});

describe('application shell', () => {
  function renderShell() {
    installFakeApi({ session: makeSession() });
    const router = createMemoryRouter(routes, { initialEntries: ['/'] });
    render(<App router={router} queryClient={createQueryClient()} />);
  }

  it('adds the theme control without changing the navigation, sign-out or organization selector', async () => {
    renderShell();
    await screen.findByRole('heading', { name: 'Alpha Traders' });

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Members' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();

    const switcher = screen.getByLabelText('Organization');
    expect(switcher.tagName).toBe('SELECT');
    expect(switcher.id).toBe('organization-switcher');

    const toggle = screen.getByRole('group', { name: 'Theme' });
    expect(toggle.closest('header.topbar')).not.toBeNull();
  });

  it('keeps hiding navigation the user has no permission for', async () => {
    renderShell();
    await screen.findByRole('heading', { name: 'Alpha Traders' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: 'Sales' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Payroll' })).toBeNull();
  });
});
