import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  availableLocales,
  catalogCoverage,
  LOCALES,
  LocaleProvider,
  translate,
  useT,
} from '../src/i18n/i18n';
import { en } from '../src/i18n/messages.en';

/** Locale infrastructure (FP-30): fallback, direction, review status, catalog integrity. */

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('locale catalogs', () => {
  it('only contains keys that exist in English, with the same placeholders', () => {
    for (const [id, locale] of Object.entries(LOCALES)) {
      for (const [key, text] of Object.entries(locale.messages)) {
        const english = (en as Record<string, string>)[key];
        expect(english, `${id}:${key} is not an English key`).toBeDefined();
        if (text) expect(placeholders(text), `${id}:${key}`).toEqual(placeholders(english!));
      }
    }
  });

  it('offers only approved locales; Dhivehi stays a draft with no shipped translation', () => {
    expect(availableLocales().map((l) => l.id)).toEqual(['en']);
    expect(LOCALES.dv!.status).toBe('draft');
    expect(LOCALES.dv!.dir).toBe('rtl');
    expect(catalogCoverage('dv').translated).toBe(0);
    expect(catalogCoverage('en').translated).toBe(catalogCoverage('en').total);
  });

  it('falls back to English for an untranslated key and fills placeholders', () => {
    expect(translate('dv', 'common.save')).toBe(en['common.save']);
    expect(translate('xx', 'common.save')).toBe(en['common.save']);
    const withParam = Object.entries(en).find(([, v]) => /\{\w+\}/.test(v));
    if (withParam) {
      const name = /\{(\w+)\}/.exec(withParam[1])![1]!;
      expect(translate('en', withParam[0] as keyof typeof en, { [name]: 'X' })).toContain('X');
    }
  });

  it('sets language and text direction for the subtree', () => {
    function Probe() {
      const t = useT();
      return <p>{t('common.save')}</p>;
    }
    const { container } = render(
      <LocaleProvider locale="dv">
        <Probe />
      </LocaleProvider>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('dir')).toBe('rtl');
    expect(wrapper.getAttribute('lang')).toBe('dv');
    // Untranslated: the English text is shown rather than a blank.
    expect(screen.getByText(en['common.save'])).toBeTruthy();
  });
});
