import { useCallback, useEffect, useState } from 'react';

/**
 * Colour theme preference. "system" follows prefers-color-scheme; "light" and "dark" are explicit
 * choices, kept on this device only (nothing is sent to the server). The choice is applied as a
 * `data-theme` attribute on the document root, which the stylesheet reads; with "system" the
 * attribute is absent. public/theme-init.js applies a saved choice before the first paint.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

/** Must match the key in public/theme-init.js. */
export const THEME_STORAGE_KEY = 'intuit2.theme';

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyThemeChoice(
  choice: ThemeChoice,
  root: HTMLElement = document.documentElement,
): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

function storeThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // The choice still applies for this page view; it just is not remembered.
  }
}

/** The current choice and a setter that applies it and remembers it on this device. */
export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);

  useEffect(() => {
    applyThemeChoice(choice);
  }, [choice]);

  // Another tab changed the choice: follow it.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setChoice(readThemeChoice());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const update = useCallback((next: ThemeChoice) => {
    storeThemeChoice(next);
    setChoice(next);
  }, []);

  return [choice, update];
}
