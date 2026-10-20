import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import baseline from './i18n-baseline.json';

/**
 * Localization ratchet (FP-30). Pages that still contain English literals are listed in
 * `i18n-baseline.json`. A page NOT on the list must use the message catalog (`useT`), so new
 * screens cannot add untranslatable text; as pages are converted they are removed from the list.
 */

const webRoot = join(__dirname, '..');
const root = join(webRoot, 'src');
const SKIP = new Set(['routes.tsx', 'App.tsx', 'main.tsx']);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : tsxFiles(path);
    return name.endsWith('.tsx') && !SKIP.has(name) ? [path] : [];
  });
}

const files = [...tsxFiles(join(root, 'features')), ...tsxFiles(join(root, 'app'))].map((p) =>
  relative(webRoot, p).split('\\').join('/'),
);

describe('catalog coverage ratchet', () => {
  it('requires the message catalog in every page that is not on the baseline list', () => {
    const listed = new Set(baseline as string[]);
    const offenders = files.filter(
      (f) => !listed.has(f) && !readFileSync(join(webRoot, f), 'utf8').includes('useT('),
    );
    expect(offenders, 'new pages must use useT(); do not add to the baseline').toEqual([]);
  });

  it('keeps the baseline list honest: every entry exists and still lacks the catalog', () => {
    for (const f of baseline as string[]) {
      expect(files, `${f} no longer exists`).toContain(f);
    }
    const converted = (baseline as string[]).filter((f) =>
      readFileSync(join(webRoot, f), 'utf8').includes('useT('),
    );
    expect(converted, 'remove converted pages from i18n-baseline.json').toEqual([]);
  });
});
