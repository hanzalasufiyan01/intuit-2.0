import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { en } from './messages.en';

/**
 * In-house, typed message catalog (Phase 3B D13; Decision 50). Every new Sales string goes
 * through `t()`; a missing key is a compile error. Later locales (e.g. Dhivehi, right-to-left)
 * add a catalog of the same shape and a text direction; Sales styles use logical CSS properties
 * so they mirror correctly. English is the only locale shipped in Phase 3B.
 */

export type MessageKey = keyof typeof en;
export type Catalog = Record<MessageKey, string>;
export type MessageParams = Record<string, string | number | null | undefined>;

interface Locale {
  messages: Catalog;
  dir: 'ltr' | 'rtl';
}

const LOCALES: Record<string, Locale> = {
  en: { messages: en, dir: 'ltr' },
};

/** Formats a message, replacing `{name}` placeholders. */
export function translate(locale: string, key: MessageKey, params?: MessageParams): string {
  const catalog = (LOCALES[locale] ?? LOCALES.en!).messages;
  const template = catalog[key] ?? en[key];
  return params
    ? template.replace(/\{(\w+)\}/g, (match: string, name: string) => {
        const value = params[name];
        return value === undefined || value === null ? match : String(value);
      })
    : template;
}

const LocaleContext = createContext('en');

export function LocaleProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const dir = (LOCALES[locale] ?? LOCALES.en!).dir;
  return (
    <LocaleContext.Provider value={locale}>
      <div dir={dir} lang={locale}>
        {children}
      </div>
    </LocaleContext.Provider>
  );
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

export function useT(): Translate {
  const locale = useContext(LocaleContext);
  return useCallback((key, params) => translate(locale, key, params), [locale]);
}
