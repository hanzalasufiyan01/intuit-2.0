import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { dv } from './messages.dv';
import { en } from './messages.en';

/**
 * In-house, typed message catalog (Phase 3B D13; Decision 50) and locale infrastructure
 * (FP-30). Every string that goes through `t()` is a typed key; English is complete and is the
 * fallback for any key a locale does not translate yet. A locale has a text direction and a
 * review status: only an APPROVED locale is offered to users, so a draft or half-translated
 * catalog is never shown by accident. This file ships NO Dhivehi text: translations must come
 * from a qualified translator (see docs/design/localization.md).
 */

export type MessageKey = keyof typeof en;
export type Catalog = Record<MessageKey, string>;
export type MessageParams = Record<string, string | number | null | undefined>;

export interface LocaleDefinition {
  /** BCP 47 tag used for `lang` and Intl formatting. */
  tag: string;
  /** Name in its own language, shown in the selector. */
  nativeName: string;
  dir: 'ltr' | 'rtl';
  /** 'approved' once a qualified reviewer has signed the catalog off; only then is it offered. */
  status: 'approved' | 'draft';
  messages: Partial<Catalog>;
}

export const LOCALES: Record<string, LocaleDefinition> = {
  en: { tag: 'en', nativeName: 'English', dir: 'ltr', status: 'approved', messages: en },
  // Dhivehi (Thaana) is right-to-left. The catalog is empty on purpose; see messages.dv.ts.
  dv: { tag: 'dv', nativeName: 'ދިވެހި', dir: 'rtl', status: 'draft', messages: dv },
};

export const DEFAULT_LOCALE = 'en';

/** The locales a user may choose: approved ones only. */
export function availableLocales(): { id: string; nativeName: string }[] {
  return Object.entries(LOCALES)
    .filter(([, l]) => l.status === 'approved')
    .map(([id, l]) => ({ id, nativeName: l.nativeName }));
}

/** Share of the English keys a locale translates (for the translation workflow). */
export function catalogCoverage(locale: string): { translated: number; total: number } {
  const messages = LOCALES[locale]?.messages ?? {};
  const keys = Object.keys(en);
  return {
    total: keys.length,
    translated: keys.filter((k) => (messages as Record<string, string>)[k]).length,
  };
}

/** Formats a message, replacing `{name}` placeholders; falls back to English per key. */
export function translate(locale: string, key: MessageKey, params?: MessageParams): string {
  const template = (LOCALES[locale]?.messages[key] as string | undefined) || en[key];
  return params
    ? template.replace(/\{(\w+)\}/g, (match: string, name: string) => {
        const value = params[name];
        return value === undefined || value === null ? match : String(value);
      })
    : template;
}

const STORAGE_KEY = 'intuit2.locale';

function readStoredLocale(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && LOCALES[stored]?.status === 'approved') return stored;
  } catch {
    // Storage can be unavailable (private window, blocked site data).
  }
  return DEFAULT_LOCALE;
}

interface LocaleState {
  locale: string;
  setLocale: (locale: string) => void;
}

const LocaleContext = createContext<LocaleState>({ locale: DEFAULT_LOCALE, setLocale: () => {} });

/**
 * Application-wide locale choice. Only an approved locale can be chosen; the choice is remembered
 * in this browser only (a per-viewer convenience, never shared state).
 */
export function AppLocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(readStoredLocale);
  const setLocale = useCallback((next: string) => {
    if (LOCALES[next]?.status !== 'approved') return;
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not remembered; still applied for this visit.
    }
  }, []);
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleState {
  return useContext(LocaleContext);
}

/**
 * Sets the language and text direction for a subtree. Without a `locale` it uses the
 * application-wide choice. Styles use logical CSS properties so they mirror correctly.
 */
export function LocaleProvider({ locale, children }: { locale?: string; children: ReactNode }) {
  const inherited = useContext(LocaleContext);
  const id = locale && LOCALES[locale] ? locale : inherited.locale;
  const definition = LOCALES[id] ?? LOCALES[DEFAULT_LOCALE]!;
  const value = useMemo(() => ({ locale: id, setLocale: inherited.setLocale }), [id, inherited]);
  return (
    <LocaleContext.Provider value={value}>
      <div dir={definition.dir} lang={definition.tag}>
        {children}
      </div>
    </LocaleContext.Provider>
  );
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

export function useT(): Translate {
  const { locale } = useContext(LocaleContext);
  return useCallback((key, params) => translate(locale, key, params), [locale]);
}

/** Intl formatting in the chosen locale (dates and plain numbers; money has its own rules). */
export function useFormatters() {
  const { locale } = useContext(LocaleContext);
  const tag = LOCALES[locale]?.tag ?? DEFAULT_LOCALE;
  return useMemo(
    () => ({
      date: (iso: string) =>
        new Intl.DateTimeFormat(tag, { dateStyle: 'medium' }).format(new Date(iso)),
      dateTime: (iso: string) =>
        new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(iso),
        ),
      number: (n: number) => new Intl.NumberFormat(tag).format(n),
    }),
    [tag],
  );
}
