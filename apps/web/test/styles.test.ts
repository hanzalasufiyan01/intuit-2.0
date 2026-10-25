import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPACT_QUERY } from '../src/app/navigation';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusBadge as AccountingStatusBadge } from '../src/features/accounting/shared';
import { Badge, type BadgeTone } from '../src/shared/ui/Badge';
import { MappedStatusBadge } from '../src/shared/ui/StatusBadge';

/**
 * The design foundation in src/shared/ui/styles.css (UI phase 1). jsdom does not compute CSS, so
 * these tests read the stylesheet itself: token consistency between the dark blocks, WCAG AA
 * contrast of the colour pairs in both themes, and that classes the pages use are defined.
 */

const webRoot = join(__dirname, '..');
const css = readFileSync(join(webRoot, 'src/shared/ui/styles.css'), 'utf8');

function properties(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[match[1]!] = match[2]!.replace(/\s+/g, ' ').trim();
  }
  return out;
}

const light = properties(/:root\s*\{([^}]*)\}/.exec(css)![1]!);
const darkExplicit = properties(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(css)![1]!);
const darkSystem = properties(
  /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/.exec(
    css,
  )![1]!,
);
const dark = { ...light, ...darkExplicit };

// --- colour helpers (WCAG 2.x relative luminance) -------------------------------------------

type Rgb = [number, number, number];

function parseColour(value: string, over: Rgb = [255, 255, 255]): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const fn = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)%)?\s*\)$/.exec(value);
  if (!fn) throw new Error(`Unsupported colour: ${value}`);
  const alpha = fn[4] === undefined ? 1 : Number(fn[4]) / 100;
  const channels = [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return channels.map((c, i) => Math.round(alpha * c + (1 - alpha) * over[i]!)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// --- tokens ---------------------------------------------------------------------------------

describe('design tokens', () => {
  it('keeps the dark tokens identical for the explicit and the system (media query) blocks', () => {
    const explicit = Object.fromEntries(
      Object.entries(darkExplicit).filter(([name]) => name.startsWith('--')),
    );
    expect(Object.keys(darkSystem).length).toBeGreaterThan(30);
    expect(darkSystem).toEqual(explicit);
  });

  it('defines every token the dark theme overrides in the light set too', () => {
    for (const name of Object.keys(darkExplicit)) expect(light[name], name).toBeDefined();
  });

  it('keeps the existing variable names and defines the previously missing warning colour', () => {
    for (const name of [
      '--color-bg',
      '--color-surface',
      '--color-border',
      '--color-text',
      '--color-muted',
      '--color-primary',
      '--color-primary-contrast',
      '--color-danger',
      '--color-danger-bg',
      '--color-info-bg',
      '--color-success-bg',
      '--radius',
      '--space',
      '--color-warning',
      '--color-warning-bg',
    ]) {
      expect(light[name], `light ${name}`).toBeDefined();
    }
    expect(dark['--color-warning']).not.toBe(light['--color-warning']);
  });

  it('declares the colour scheme for native controls in every theme', () => {
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light dark;/);
    expect(css).toMatch(/:root\[data-theme='light'\]\s*\{\s*color-scheme:\s*light;/);
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*\{\s*color-scheme:\s*dark;/);
  });
});

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('WCAG AA contrast, %s theme', (_name, t) => {
  const surface = parseColour(t['--color-surface']!);
  const bg = parseColour(t['--color-bg']!);
  const subtle = parseColour(t['--color-surface-subtle']!, surface);
  const colour = (token: string, over: Rgb = surface) => parseColour(t[token]!, over);

  const text: [string, Rgb, Rgb][] = [
    ['text on page', colour('--color-text'), bg],
    ['text on card', colour('--color-text'), surface],
    ['secondary text on card', colour('--color-text-secondary'), surface],
    ['muted text on card', colour('--color-muted'), surface],
    ['muted text on page', colour('--color-muted'), bg],
    ['muted text on table header', colour('--color-muted'), subtle],
    ['primary button label', colour('--color-primary-contrast'), colour('--color-primary')],
    [
      'primary button label, hover',
      colour('--color-primary-contrast'),
      colour('--color-primary-hover'),
    ],
    [
      'primary button label, pressed',
      colour('--color-primary-contrast'),
      colour('--color-primary-active'),
    ],
    [
      'danger button label',
      colour('--color-danger'),
      parseColour(t['--color-danger-bg']!, surface),
    ],
    ['link on card', colour('--color-link'), surface],
    ['link on page', colour('--color-link'), bg],
    ['link text on selected tab tint', colour('--color-link'), colour('--color-primary-subtle')],
    ['navigation item', colour('--nav-text'), colour('--nav-bg')],
    [
      'navigation item, active',
      colour('--nav-text-strong'),
      parseColour(t['--nav-active-bg']!, colour('--nav-bg')),
    ],
    ['navigation group label', colour('--nav-muted'), colour('--nav-bg')],
    ['navigation group button, current', colour('--nav-text-strong'), colour('--nav-bg')],
    [
      'navigation item or group button, hovered',
      colour('--nav-text-strong'),
      parseColour(t['--nav-hover-bg']!, colour('--nav-bg')),
    ],
    [
      'navigation item, not hovered, on the nav background',
      colour('--nav-text'),
      colour('--nav-bg'),
    ],
    ['top bar menu button icon', colour('--color-text'), colour('--color-surface')],
  ];
  for (const tone of ['success', 'warning', 'danger', 'info', 'neutral']) {
    text.push([
      `${tone} text on its tint, over a card`,
      colour(`--color-${tone}`),
      colour(`--color-${tone}-bg`),
    ]);
    text.push([
      `${tone} text on its tint, over the page`,
      colour(`--color-${tone}`, bg),
      colour(`--color-${tone}-bg`, bg),
    ]);
  }
  it.each(text)('%s is at least 4.5:1', (_label, fg, back) => {
    expect(contrast(fg, back)).toBeGreaterThanOrEqual(4.5);
  });

  const components: [string, Rgb, Rgb][] = [
    ['focus ring on card', colour('--color-focus'), surface],
    ['focus ring on page', colour('--color-focus'), bg],
    ['input border on card', colour('--color-border-strong'), surface],
    ['input border on page', colour('--color-border-strong'), bg],
    ['navigation accent bar', colour('--nav-accent'), colour('--nav-bg')],
    ['navigation focus ring', colour('--nav-focus'), colour('--nav-bg')],
  ];
  it.each(components)('%s is at least 3:1', (_label, fg, back) => {
    expect(contrast(fg, back)).toBeGreaterThanOrEqual(3);
  });
});

// --- rules the pages rely on ----------------------------------------------------------------

/** Class name -> the declarations of every rule whose selector list names it. */
function rulesByClass(): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of match[1]!.split(',')) {
      for (const cls of selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)) {
        map.set(cls[1]!, `${map.get(cls[1]!) ?? ''}${match[2]}`);
      }
    }
  }
  return map;
}
const rules = rulesByClass();

describe('classes the pages use', () => {
  it('defines the classes that used to have no styling', () => {
    for (const cls of [
      'filters',
      'table--editor',
      'check',
      'container',
      'fieldset',
      'approval-requirement',
      'language-select',
      'visually-hidden',
      'step-conditions',
      'choice-row',
      'applied-steps',
      'badge--error',
      'button',
      'details',
      'issues',
      'row--section',
      'row--subtotal',
      'row--total',
      'row--group',
      'row--error',
      'row--warning',
      'alert--warning',
      'theme-toggle',
      'theme-toggle__button',
    ]) {
      expect(rules.has(cls), `.${cls}`).toBe(true);
    }
  });

  it('keeps visually-hidden and sr-only as the same rule', () => {
    expect(css).toMatch(/\.sr-only,\s*\.visually-hidden\s*\{/);
  });

  it('keeps the table markup contracts the pages and browser tests rely on', () => {
    expect(rules.get('num')).toMatch(/text-align:\s*end/);
    expect(rules.get('num')).toMatch(/tabular-nums/);
    expect(rules.has('table-scroll')).toBe(true);
    expect(rules.get('card')).toMatch(/overflow-x:\s*auto/);
  });

  it('shows focus and respects reduced motion', () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-focus\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/transition-duration:\s*0\.01ms/);
  });

  it('forces the light palette when printing', () => {
    const printBlock = /@media print\s*\{([\s\S]*)\}\s*$/.exec(css)![1]!;
    expect(printBlock).toMatch(/:root:not\(\[data-theme\]\)/);
    expect(printBlock).toMatch(/--color-text:\s*#000000/);
  });

  it('uses logical properties only, so layouts mirror in right-to-left locales', () => {
    const physical = [
      /\b(margin|padding)-(left|right)\s*:/,
      /\bborder-(left|right)(-\w+)?\s*:/,
      /\btext-align\s*:\s*(left|right)\b/,
      /(^|[\s{;])(left|right)\s*:/m,
      /\bfloat\s*:\s*(left|right)\b/,
    ];
    for (const pattern of physical) expect(css).not.toMatch(pattern);
  });
});

describe('status colours', () => {
  // Every status badge renders through the shared Badge, whose only styling hook is `badge--<tone>`
  // for one of five tones. Status names never reach the stylesheet, so this guard checks the classes
  // the component really emits against the rules and tokens in styles.css. Which status gets which
  // tone is checked per vocabulary in status-badges.test.tsx.
  const TONES = ['danger', 'info', 'neutral', 'success', 'warning'] as const;

  /** The classes and the colour declarations the shared Badge produces for a tone. */
  function renderedBadge(tone: string) {
    const html = renderToStaticMarkup(
      createElement(Badge, { tone: tone as BadgeTone, children: 'x' }),
    );
    const classes = /class="([^"]*)"/.exec(html)![1]!.split(/\s+/);
    return classes;
  }

  /** The last value a rule declares for a property, ignoring spacing and declaration order. */
  function declared(rule: string, property: string): string | undefined {
    const values = [...rule.matchAll(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`, 'g'))];
    return values.at(-1)?.[1]?.replace(/\s+/g, ' ').trim();
  }

  /** The text colour token a rendered badge ends up with, found through the stylesheet. */
  function textTokenOf(element: ReactElement): string | undefined {
    const classes = /class="([^"]*)"/.exec(renderToStaticMarkup(element))![1]!.split(/\s+/);
    let token: string | undefined;
    for (const cls of classes) {
      const value = declared(rules.get(cls) ?? '', 'color');
      const match = value ? /^var\(--color-([\w-]+)\)$/.exec(value) : null;
      if (match) token = match[1];
    }
    return token;
  }

  it('knows exactly the five tones the shared Badge accepts', () => {
    const source = readFileSync(join(webRoot, 'src/shared/ui/Badge.tsx'), 'utf8');
    const union = /export type BadgeTone\s*=([^;]+);/.exec(source)![1]!;
    const tones = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!).sort();
    // A new tone needs a CSS rule, token pair and contrast row first: add them, then extend this list.
    expect(tones).toEqual([...TONES]);
  });

  it('styles every tone class the Badge renders, with that tone’s own colour pair', () => {
    expect(rules.has('badge')).toBe(true);
    for (const tone of TONES) {
      const classes = renderedBadge(tone);
      expect(classes, tone).toEqual(['badge', `badge--${tone}`]);
      const rule = rules.get(`badge--${tone}`);
      expect(rule, `.badge--${tone} has no rule`).toBeDefined();
      expect(declared(rule!, 'color'), `.badge--${tone} text`).toBe(`var(--color-${tone})`);
      expect(declared(rule!, 'background'), `.badge--${tone} fill`).toBe(`var(--color-${tone}-bg)`);
    }
  });

  it('defines each tone’s colour pair in both themes, and keeps the five tones apart', () => {
    for (const theme of [light, dark]) {
      for (const field of ['', '-bg']) {
        const values = TONES.map((tone) => theme[`--color-${tone}${field}`]);
        for (const [i, value] of values.entries())
          expect(value, `${TONES[i]}${field}`).toBeDefined();
        // Two tones sharing a colour would make their statuses indistinguishable.
        expect(new Set(values).size, `tones ${field || 'text'} colours`).toBe(TONES.length);
      }
    }
  });

  it('adds a leading dot to every toned badge, so meaning never rests on colour alone', () => {
    expect(css).toMatch(
      /\.badge\[class\*=['"]badge--['"]\]::before\s*\{[^}]*content:\s*(''|"")[^}]*background:\s*currentcolor/,
    );
  });

  it('has no component building its own status class name', () => {
    // The old pattern was `badge badge--${status.toLowerCase()}`, which needed a CSS rule per status.
    const offenders: string[] = [];
    const src = join(webRoot, 'src');
    for (const file of readdirSync(src, { recursive: true }) as string[]) {
      if (!/\.(ts|tsx)$/.test(file) || file.replace(/\\/g, '/') === 'shared/ui/Badge.tsx') continue;
      if (readFileSync(join(src, file), 'utf8').includes('badge--')) offenders.push(file);
    }
    expect(offenders, 'use <Badge tone> or a typed status map instead').toEqual([]);
  });

  it('colours real status badges by what the status means, through the stylesheet', () => {
    const accounting = (status: string) => createElement(AccountingStatusBadge, { status });
    const mapped = (status: string) =>
      createElement(MappedStatusBadge, { map: SAMPLE_STATUS_MAP, status });
    expect(textTokenOf(accounting('POSTED'))).toBe('success');
    expect(textTokenOf(accounting('PENDING_APPROVAL'))).toBe('warning');
    expect(textTokenOf(accounting('REVERSED'))).toBe('danger');
    // Finished or out of use is not an error: it must not look like one.
    expect(textTokenOf(accounting('DRAFT'))).toBe('neutral');
    expect(textTokenOf(accounting('CLOSED'))).toBe('neutral');
    expect(textTokenOf(mapped('SENT'))).toBe('info');
    // A status no map lists is neutral, whatever its name suggests.
    expect(textTokenOf(accounting('FAILED'))).toBe('neutral');
    expect(textTokenOf(mapped('PAID'))).toBe('neutral');
    expect(textTokenOf(mapped('constructor'))).toBe('neutral');
  });
});

const SAMPLE_STATUS_MAP = { SENT: { key: 'quotes.quotePages.status.SENT', tone: 'info' } } as const;

// --- grouped navigation and the drawer (UI phase 2) ----------------------------------------------

/** The declarations of the first block that follows `header` (matching braces). */
function blockAfter(header: string): string {
  const start = css.indexOf(header);
  expect(start, header).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
  }
  throw new Error(`Unclosed block after ${header}`);
}

describe('grouped navigation styles', () => {
  it('keeps the CSS drawer breakpoint in step with the one the layout code uses', () => {
    expect(COMPACT_QUERY).toBe('(max-width: 1024px)');
    expect(css).toContain(`@media ${COMPACT_QUERY} {`);
  });

  it('lets the hidden attribute collapse a group (the list sets display, which would override it)', () => {
    expect(rules.get('nav__list')).toMatch(/display:\s*flex/);
    expect(css).toMatch(/\.nav__list\[hidden\]\s*\{\s*display:\s*none;/);
  });

  it('scrolls only the navigation, so the brand and organization selector stay in view', () => {
    expect(rules.get('nav')).toMatch(/overflow-y:\s*auto/);
    expect(rules.get('nav')).toMatch(/min-height:\s*0/);
    expect(rules.get('sidebar')).toMatch(/overflow:\s*hidden/);
  });

  it('turns the sidebar into a closed-by-default drawer at the compact breakpoint', () => {
    const compact = blockAfter(`@media ${COMPACT_QUERY} {`);
    expect(compact).toMatch(/\.sidebar\s*\{[^}]*position:\s*fixed/);
    // Closed: invisible, so it leaves the tab order and the accessibility tree.
    expect(compact).toMatch(/\.sidebar\s*\{[^}]*visibility:\s*hidden/);
    expect(compact).toMatch(/\.sidebar\.sidebar--open\s*\{[^}]*visibility:\s*visible/);
    expect(compact).toMatch(/\.sidebar\.sidebar--open\s*\{[^}]*transform:\s*none/);
    expect(compact).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    // Mirrored for right-to-left locales.
    expect(compact).toMatch(/\.sidebar:dir\(rtl\)\s*\{[^}]*translateX\(100%\)/);
  });

  it('shows the menu and close buttons only in the drawer layout', () => {
    expect(rules.get('topbar__menu')).toMatch(/display:\s*none/);
    expect(rules.get('sidebar__close')).toMatch(/display:\s*none/);
    const compact = blockAfter(`@media ${COMPACT_QUERY} {`);
    expect(compact).toMatch(/\.sidebar__close,\s*\.topbar__menu\s*\{\s*display:\s*inline-grid/);
  });

  it('stops the page behind an open drawer from scrolling and dims it with the overlay token', () => {
    expect(css).toMatch(/body\[data-nav-open\]\s*\{\s*overflow:\s*hidden/);
    expect(rules.get('nav-backdrop')).toMatch(/var\(--color-overlay\)/);
  });

  it('layers the drawer above the page and the top bar, and below dialogs', () => {
    const z = (cls: string) => Number(/z-index:\s*(\d+)/.exec(rules.get(cls)!)![1]);
    expect(z('nav-backdrop')).toBeGreaterThan(z('topbar'));
    expect(z('modal-backdrop')).toBeGreaterThan(z('nav-backdrop'));
  });

  it('uses design tokens only for colour, so both themes style the new controls', () => {
    for (const cls of [
      'nav__group-button',
      'nav__group--current',
      'nav__list',
      'nav__chevron',
      'sidebar__header',
      'sidebar__close',
      'topbar__context',
      'topbar__menu',
      'nav-backdrop',
    ]) {
      expect(rules.has(cls), `.${cls}`).toBe(true);
      expect(rules.get(cls), `.${cls}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });

  it('keeps visible focus on the navigation controls and respects reduced motion for the drawer', () => {
    expect(rules.get('sidebar')).toBeDefined();
    expect(css).toMatch(/\.sidebar :focus-visible\s*\{[^}]*outline-color:\s*var\(--nav-focus\)/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration:\s*0\.01ms/,
    );
  });
});

// --- table primitives and typed badges (UI phase 3, batch A) ---------------------------------------

describe('badge tones and the table region', () => {
  it('defines every typed badge tone with the matching token pair', () => {
    const expected: Record<string, string> = {
      success: 'success',
      warning: 'warning',
      danger: 'danger',
      info: 'info',
      neutral: 'neutral',
    };
    for (const [tone, token] of Object.entries(expected)) {
      const rule = rules.get(`badge--${tone}`);
      expect(rule, `.badge--${tone}`).toBeDefined();
      expect(rule, `.badge--${tone}`).toContain(`var(--color-${token})`);
      expect(rule, `.badge--${tone}`).toContain(`var(--color-${token}-bg)`);
    }
  });

  it('lets the table region scroll sideways inside its card', () => {
    expect(rules.get('table-scroll')).toMatch(/overflow-x:\s*auto/);
    expect(rules.get('table-scroll')).toMatch(/max-width:\s*100%/);
  });
});

describe('form field components', () => {
  it('styles the checkbox field and its messages with tokens only', () => {
    expect(rules.has('checkbox-field')).toBe(true);
    expect(rules.get('checkbox-field')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(rules.get('field__error')).toContain('var(--color-danger)');
  });

  it('marks an invalid select, textarea and input the same way', () => {
    expect(css).toMatch(
      /\.field input\[aria-invalid='true'\],\s*\.field select\[aria-invalid='true'\],\s*\.field textarea\[aria-invalid='true'\]\s*\{\s*border-color:\s*var\(--color-danger\)/,
    );
  });
});

describe('tabs and filter bar', () => {
  it('wraps the tab strip and gives each tab a visible focus ring', () => {
    expect(rules.get('tabs')).toMatch(/flex-wrap:\s*wrap/);
    expect(css).toMatch(/:where\([^)]*button[^)]*\):focus-visible/);
  });

  it('lets filter fields take the whole row on a phone', () => {
    const phone = blockAfter('@media (max-width: 720px) {');
    expect(phone).toMatch(/\.filters \.field\s*\{[^}]*flex:\s*1 1 100%/);
    expect(rules.get('filters')).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe('dialog styles', () => {
  it('styles the dialog and the destructive button with tokens only', () => {
    for (const cls of [
      'dialog',
      'dialog__title',
      'dialog__description',
      'dialog__footer',
      'btn--danger',
    ]) {
      expect(rules.has(cls), `.${cls}`).toBe(true);
      expect(rules.get(cls), `.${cls}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
    expect(rules.get('btn--danger')).toContain('var(--color-danger)');
  });

  it('keeps the dialog inside the viewport and scrollable on small screens', () => {
    expect(rules.get('dialog')).toMatch(/max-height:\s*calc\(100dvh/);
    expect(rules.get('dialog')).toMatch(/overflow-y:\s*auto/);
    expect(rules.get('modal')).toMatch(/max-width:\s*440px/);
    expect(blockAfter('@media (max-width: 720px) {')).toMatch(/\.modal\s*\{[^}]*max-width:\s*none/);
  });

  it('layers the dialog backdrop above the navigation drawer and stops background scrolling', () => {
    const z = (cls: string) => Number(/z-index:\s*(\d+)/.exec(rules.get(cls)!)![1]);
    expect(z('modal-backdrop')).toBeGreaterThan(z('nav-backdrop'));
    expect(css).toMatch(/body\[data-dialog-open\]\s*\{\s*overflow:\s*hidden/);
    expect(rules.get('modal-backdrop')).toContain('var(--color-overlay)');
  });
});

// --- wide tables scroll inside their container instead of widening the page --------------------------

describe('table containment', () => {
  // A wide table cannot shrink below its content, so every ancestor up to the page must let the table's
  // container be narrower than the table: grid tracks that can shrink, a main column with no minimum
  // width, and a card (or the table region) that scrolls sideways instead of growing.
  it('lets the app shell grid, in both layouts, shrink below the width of a wide table', () => {
    expect(css).toMatch(
      /\.app-shell\s*\{[^}]*grid-template-columns:\s*var\(--sidebar-width\)\s+minmax\(0,\s*1fr\)/,
    );
    const compact = blockAfter('@media (max-width: 1024px) {');
    expect(compact).toMatch(/\.app-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('gives the main column no minimum width, so it can be narrower than its content', () => {
    expect(rules.get('main')).toMatch(/min-width:\s*0\b/);
  });

  it('makes a card scroll sideways instead of growing around a wide table', () => {
    expect(rules.get('card')).toMatch(/overflow-x:\s*auto/);
  });

  it('keeps the table region within its parent and scrolling sideways', () => {
    expect(rules.get('table-scroll')).toMatch(/max-width:\s*100%/);
    expect(rules.get('table-scroll')).toMatch(/overflow-x:\s*auto/);
  });

  it('keeps the shell and the page from hiding a table that overflows (no clipping above the card)', () => {
    // Clipping the page would hide overflow instead of scrolling it; scrolling belongs to the containers.
    for (const name of ['app-shell', 'main', 'content']) {
      expect(rules.get(name), `.${name}`).not.toMatch(/overflow(-x)?:\s*hidden/);
    }
  });
});
