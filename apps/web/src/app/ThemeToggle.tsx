import type { ReactNode } from 'react';
import { useT } from '../i18n/i18n';
import { THEME_CHOICES, useThemeChoice, type ThemeChoice } from '../shared/theme';

/** Small inline icons (no icon library); decorative, the buttons carry their text label. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const ICONS: Record<ThemeChoice, ReactNode> = {
  system: (
    <Icon>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </Icon>
  ),
  light: (
    <Icon>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Icon>
  ),
  dark: (
    <Icon>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </Icon>
  ),
};

/**
 * Theme control: System (follows the device), Light or Dark. The choice is remembered on this
 * device only and does not affect the session or any request.
 */
export function ThemeToggle() {
  const t = useT();
  const [choice, setChoice] = useThemeChoice();
  const labels: Record<ThemeChoice, string> = {
    system: t('shell.theme.system'),
    light: t('shell.theme.light'),
    dark: t('shell.theme.dark'),
  };
  return (
    <div className="theme-toggle" role="group" aria-label={t('shell.theme.label')}>
      {THEME_CHOICES.map((id) => (
        <button
          key={id}
          type="button"
          className="theme-toggle__button"
          aria-pressed={choice === id}
          title={labels[id]}
          onClick={() => setChoice(id)}
        >
          {ICONS[id]}
          <span className="sr-only">{labels[id]}</span>
        </button>
      ))}
    </div>
  );
}
