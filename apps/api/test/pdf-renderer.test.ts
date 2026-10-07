import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PdfkitRenderer } from '../src/infrastructure/pdf/pdf-renderer.js';
import {
  creditNoteSnapshot,
  debitNoteSnapshot,
  invoiceSnapshot,
  remittanceSnapshot,
} from './pdf-fixtures.js';
import { drawnGlyphs, isThaanaFont, isThaanaMark, type DrawnGlyph } from './pdf-text.js';

/**
 * Phase 4B-7 (D10): the shared renderer gained an additive `remittance_advice` branch. The three
 * existing document types must render byte for byte as they did before it. The hashes below were
 * captured from the renderer at commit 6ca38f3, before the branch existed, from the fixed snapshots
 * in `pdf-fixtures.ts`; any change to how an invoice, a credit note or a debit note is drawn
 * changes one of them.
 */

const PINNED = {
  invoice: '60724fb9bb37bc1b1a646694652fac172cfeeca2aaf914fbc346526cfa6eb0e6',
  creditNote: '485092db7f688b321c75ba064830fd65245c01bc84c5d9aa34e798d6bd10be37',
  debitNote: '260b8102c62921f0d658ca3d827b1546245f5c3501220f9c60f61dd9927ca0a5',
} as const;

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const renderer = new PdfkitRenderer();

describe('existing document PDFs are byte-identical (D10)', () => {
  it('renders the Sales invoice exactly as before', async () => {
    expect(sha(await renderer.render(invoiceSnapshot))).toBe(PINNED.invoice);
  });
  it('renders the Sales credit note exactly as before', async () => {
    expect(sha(await renderer.render(creditNoteSnapshot))).toBe(PINNED.creditNote);
  });
  it('renders the Purchases debit note exactly as before', async () => {
    expect(sha(await renderer.render(debitNoteSnapshot))).toBe(PINNED.debitNote);
  });
});

/**
 * Phase 4B-7, Thaana review: what is DRAWN, not what text extraction would give. PDFKit shapes text
 * word by word and appends the words in logical order, so a plain `line()` puts the first of several
 * Thaana words on the left. The remittance advice draws right-to-left lines word by word in reverse,
 * with each word shaped right to left and its combining marks directly before their base letters.
 */
describe('Thaana in the remittance advice is drawn in the right order', () => {
  // U+0780 haa, U+0784 baa, U+078B dhaalu; U+07A6 abafili, U+07AA ubufili, U+07A8 ibifili.
  const HAA = 0x0780;
  const BAA = 0x0784;
  const DHAALU = 0x078b;
  const word = (base: string, mark: string) => `${base}${mark}`;
  const thaana = (g: DrawnGlyph[]) => g.filter(isThaanaFont);
  const first = (g: DrawnGlyph[], cp: number) => g.find((x) => x.codePoint === cp)!;
  /** Every glyph on the vendor line: the line that carries the Thaana, found by its baseline. */
  const render = async (displayName: string) => {
    const all = drawnGlyphs(await renderer.render(remittanceSnapshot({ displayName })));
    const anchor = all.find(isThaanaFont);
    return anchor ? all.filter((g) => Math.abs(g.y - anchor.y) < 0.5) : all;
  };

  it('puts the first of several Thaana words at the right (right-to-left word order)', async () => {
    // Logical order: haa-word, baa-word, dhaalu-word. Right-to-left: haa at the far right.
    const glyphs = thaana(await render(`${word('ހ', 'ަ')} ${word('ބ', 'ު')} ${word('ދ', 'ި')}`));
    expect(first(glyphs, HAA).x).toBeGreaterThan(first(glyphs, BAA).x);
    expect(first(glyphs, BAA).x).toBeGreaterThan(first(glyphs, DHAALU).x);
  });

  it('draws each word right to left with every mark directly before its base letter', async () => {
    // Logical: ތ ި ލ ަ ދ ު ނ ް މ ަ ތ ީ  (consonant followed by its vowel sign).
    const logical = [
      [0x078c, 0x07a8],
      [0x078d, 0x07a6],
      [0x078b, 0x07aa],
      [0x0782, 0x07b0],
      [0x0789, 0x07a6],
      [0x078c, 0x07a9],
    ];
    const name = logical.map((pair) => String.fromCodePoint(...pair)).join('');
    const glyphs = thaana(await render(name));
    // Visual order, left to right: the last consonant first, each preceded by its sign.
    const expected = [...logical].reverse().flatMap(([base, mark]) => [mark!, base!]);
    expect(glyphs.map((g) => g.codePoint)).toEqual(expected);
    // Each sign sits on its own base letter, not on a neighbour.
    glyphs.forEach((g, i) => {
      if (!isThaanaMark(g.codePoint)) return;
      const base = glyphs[i + 1]!;
      expect(isThaanaMark(base.codePoint)).toBe(false);
      expect(Math.abs(g.x - base.x)).toBeLessThan(5); // within about half an em at 9 pt
      expect(g.y).toBeCloseTo(base.y, 0);
    });
    // And the letters advance from left to right in that order.
    const bases = glyphs.filter((g) => !isThaanaMark(g.codePoint));
    bases.slice(1).forEach((g, i) => expect(g.x).toBeGreaterThan(bases[i]!.x));
  });

  it('places Latin runs against Thaana in right-to-left order', async () => {
    const latin = (g: DrawnGlyph[], cp: number) =>
      g.find((x) => !isThaanaFont(x) && x.codePoint === cp)!;
    // Thaana first: it is the right-hand run, Latin to its left.
    const thaanaFirst = await render(`${word('ހ', 'ަ')} Atoll`);
    expect(latin(thaanaFirst, 0x41).x).toBeLessThan(first(thaana(thaanaFirst), HAA).x);
    // Latin first: it is the right-hand run, Thaana to its left.
    const latinFirst = await render(`Atoll ${word('ހ', 'ަ')}`);
    expect(first(thaana(latinFirst), HAA).x).toBeLessThan(latin(latinFirst, 0x41).x);
    // Words inside one Latin run keep their order ("Atoll Supplies" reads left to right).
    const both = await render(`${word('ހ', 'ަ')} Atoll Supplies`);
    expect(latin(both, 0x41).x).toBeLessThan(latin(both, 0x53).x);
  });

  it('draws a hyphen or slash beside Thaana in the Latin font (the Thaana font has no glyph)', async () => {
    const glyphs = await render(`${word('ހ', 'ަ')}-${word('ބ', 'ު')}/7`);
    const marks = glyphs.filter((g) => g.codePoint === 0x2d || g.codePoint === 0x2f);
    expect(marks).toHaveLength(2);
    expect(marks.every((g) => !isThaanaFont(g))).toBe(true);
  });

  it('keeps left-to-right text drawn left to right, in order', async () => {
    const all = drawnGlyphs(
      await renderer.render(remittanceSnapshot({ displayName: 'Island Supplies' })),
    );
    expect(all.some(isThaanaFont)).toBe(false);
    const wanted = [...'Island Supplies'].map((c) => c.codePointAt(0)!);
    const at = all.findIndex((_, i) => wanted.every((cp, k) => all[i + k]?.codePoint === cp));
    expect(at).toBeGreaterThanOrEqual(0);
    const run = all.slice(at, at + wanted.length);
    run.slice(1).forEach((g, k) => expect(g.x).toBeGreaterThan(run[k]!.x));
  });
});
