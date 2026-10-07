import { inflateSync } from 'node:zlib';

/**
 * A small reader for the PDFs PDFKit writes, for tests (Phase 4B-7, Thaana review). It returns every
 * glyph the first page draws — its font, the Unicode of the glyph (from the font's own ToUnicode
 * map), and where it is placed — so a test can check the order and position text is DRAWN in, not
 * only what text extraction would give. Standard library only.
 */

interface PdfObject {
  dict: string;
  data: Buffer | null;
}

export interface DrawnGlyph {
  /** The BaseFont, e.g. `EZZZZZ+NotoSansThaana-Regular`. */
  font: string;
  codePoint: number;
  /** Where the glyph is drawn, in points: x from the left, y baseline from the page bottom. */
  x: number;
  y: number;
  /** Its advance width in points. */
  width: number;
}

function readObjects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const re = /(\d+) 0 obj\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endobj', start);
    const body = text.slice(start, end);
    const s = body.indexOf('stream');
    let dict = body;
    let data: Buffer | null = null;
    if (s >= 0) {
      dict = body.slice(0, s);
      const dataStart = start + s + (text.startsWith('stream\r\n', start + s) ? 8 : 7);
      const dataEnd = text.indexOf('endstream', dataStart);
      const raw = pdf.subarray(dataStart, dataEnd);
      if (/FlateDecode/.test(dict)) {
        try {
          data = inflateSync(raw);
        } catch {
          data = inflateSync(raw.subarray(0, raw.length - 1));
        }
      } else data = raw;
    }
    objects.set(Number(match[1]), { dict: dict.replace(/\s+/g, ' '), data });
    re.lastIndex = end;
  }
  return objects;
}

interface FontInfo {
  name: string;
  widths: Map<number, number>;
  toUnicode: Map<number, number>;
}

function readFonts(objects: Map<number, PdfObject>): Map<string, FontInfo> {
  const get = (id: string) => objects.get(Number(id))!;
  const page = [...objects.values()].find((o) => /\/Type \/Page\b(?!s)/.test(o.dict))!;
  const resources = get(/\/Resources (\d+) 0 R/.exec(page.dict)![1]!);
  const fontDict = /\/Font ?<<([^>]*)>>/.exec(resources.dict)![1]!;
  const fonts = new Map<string, FontInfo>();
  for (const m of fontDict.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
    const type0 = get(m[2]!).dict;
    const descendant = get(/\/DescendantFonts \[(\d+) 0 R\]/.exec(type0)![1]!).dict;
    const widths = new Map<number, number>();
    const w = /\/W ?\[(.*)\]/.exec(descendant)![1]!;
    for (const g of w.matchAll(/(\d+) \[([^\]]*)\]/g)) {
      g[2]!
        .trim()
        .split(/\s+/)
        .forEach((value, i) => widths.set(Number(g[1]) + i, Number(value)));
    }
    // PDFKit's ToUnicode: one bfrange whose array gives each subset glyph's code point.
    const cmap = get(/\/ToUnicode (\d+) 0 R/.exec(type0)![1]!).data!.toString('latin1');
    const toUnicode = new Map<number, number>();
    for (const r of cmap.matchAll(
      /beginbfrange\s*<([0-9a-f]{4})>\s*<[0-9a-f]{4}>\s*\[([^\]]*)\]/gi,
    )) {
      [...r[2]!.matchAll(/<([0-9a-f]+)>/gi)].forEach((e, i) =>
        toUnicode.set(parseInt(r[1]!, 16) + i, parseInt(e[1]!, 16)),
      );
    }
    fonts.set(m[1]!, { name: /\/BaseFont \/(\S+)/.exec(type0)![1]!, widths, toUnicode });
  }
  return fonts;
}

/** Every glyph drawn on page one, in the order the content stream draws them. */
export function drawnGlyphs(pdf: Buffer): DrawnGlyph[] {
  const objects = readObjects(pdf);
  const fonts = readFonts(objects);
  const page = [...objects.values()].find((o) => /\/Type \/Page\b(?!s)/.test(o.dict))!;
  const content = objects.get(Number(/\/Contents (\d+) 0 R/.exec(page.dict)![1]))!.data!;
  const out: DrawnGlyph[] = [];
  let font = '';
  let size = 9;
  let tx = 0;
  let ty = 0;
  for (const line of content.toString('latin1').split('\n')) {
    let m: RegExpExecArray | null;
    if ((m = /^(?:-?[\d.]+ ){4}(-?[\d.]+) (-?[\d.]+) Tm/.exec(line))) {
      tx = Number(m[1]);
      ty = Number(m[2]);
    } else if ((m = /^\/(F\d+) ([\d.]+) Tf/.exec(line))) {
      font = m[1]!;
      size = Number(m[2]);
    } else if ((m = /^\[(.*)\] TJ/.exec(line))) {
      const info = fonts.get(font)!;
      let x = tx;
      for (const part of m[1]!.matchAll(/<([0-9a-f]+)>|(-?[\d.]+)/gi)) {
        if (part[1]) {
          for (const hex of part[1].match(/.{4}/g)!) {
            const gid = parseInt(hex, 16);
            const width = ((info.widths.get(gid) ?? 0) / 1000) * size;
            out.push({
              font: info.name,
              codePoint: info.toUnicode.get(gid) ?? 0,
              x,
              y: ty,
              width,
            });
            x += width;
          }
        } else x -= (Number(part[2]) / 1000) * size;
      }
    }
  }
  return out;
}

export const isThaanaFont = (g: DrawnGlyph) => g.font.includes('NotoSansThaana');
/** A Thaana vowel sign (fili) or sukun: a combining mark. */
export const isThaanaMark = (cp: number) => cp >= 0x07a6 && cp <= 0x07b0;
