import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { Decimal } from 'decimal.js';
import { neutralizeFormula, type CsvCell, type CsvRecord } from './csv.js';

/**
 * In-house XLSX reader and writer (Decision 62; docs/xlsx-evaluation.md, fallback of section 6).
 * No dependency: a bounded ZIP reader on `node:zlib` and a restricted SpreadsheetML tokenizer.
 *
 * Reading (imports) yields the first worksheet as `CsvRecord`s of strings, so the import pipeline
 * is the same as for CSV. Safety criteria of the evaluation:
 * - zip-bomb limits enforced while inflating (declared sizes are the output cap, then checked),
 * - no DTD or entity resolution: `<!DOCTYPE` / `<!ENTITY` are refused and only the five XML
 *   entities and numeric character references are decoded,
 * - `.xlsx` only: macro-enabled content, binary workbooks, encryption and ZIP64 are refused,
 * - formulas are never evaluated: only the cached value is read,
 * - dates (1900 and 1904 systems) become `YYYY-MM-DD`.
 *
 * Writing (exports) produces a fixed SpreadsheetML package with typed cells; text is neutralized
 * against formula injection and never written as a formula.
 */

export type XlsxErrorCode =
  | 'NOT_XLSX'
  | 'MACRO_ENABLED'
  | 'ZIP_LIMIT'
  | 'MALFORMED_XLSX'
  | 'TOO_MANY_COLUMNS'
  | 'LINE_TOO_LONG'
  | 'ENCRYPTED';

export class XlsxError extends Error {
  constructor(
    readonly code: XlsxErrorCode,
    message: string,
    readonly line = 0,
  ) {
    super(message);
    this.name = 'XlsxError';
  }
}

export interface XlsxReadLimits {
  maxEntries: number;
  /** Largest uncompressed part. */
  maxEntryBytes: number;
  /** Sum of the uncompressed sizes of all parts. */
  maxTotalBytes: number;
  /** Largest uncompressed/compressed ratio of a part of 64 KiB or more. */
  maxRatio: number;
  maxColumns: number;
  maxRecordChars: number;
  maxSharedStrings: number;
}

export const DEFAULT_XLSX_LIMITS: XlsxReadLimits = {
  maxEntries: 200,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRatio: 200,
  maxColumns: 200,
  maxRecordChars: 1_000_000,
  maxSharedStrings: 1_000_000,
};

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

const ZIP64 = 0xffffffff;

function zipEntries(file: Buffer, limits: XlsxReadLimits): Map<string, ZipEntry> {
  const notZip = () => new XlsxError('NOT_XLSX', 'The file is not a valid .xlsx workbook.');
  let eocd = -1;
  for (let i = file.length - 22; i >= Math.max(0, file.length - 22 - 65_535); i -= 1) {
    if (file.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notZip();
  const entryCount = file.readUInt16LE(eocd + 10);
  const cdSize = file.readUInt32LE(eocd + 12);
  const cdOffset = file.readUInt32LE(eocd + 16);
  if (
    file.readUInt16LE(eocd + 4) !== 0 ||
    file.readUInt16LE(eocd + 6) !== 0 ||
    entryCount === 0xffff ||
    cdSize === ZIP64 ||
    cdOffset === ZIP64
  ) {
    throw new XlsxError('ZIP_LIMIT', 'Multi-part and ZIP64 workbooks are not supported.');
  }
  if (entryCount > limits.maxEntries) {
    throw new XlsxError('ZIP_LIMIT', `The workbook has more than ${limits.maxEntries} parts.`);
  }
  if (cdOffset + cdSize > eocd) throw notZip();
  const entries = new Map<string, ZipEntry>();
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < entryCount; n += 1) {
    if (p + 46 > file.length || file.readUInt32LE(p) !== 0x02014b50) throw notZip();
    const flags = file.readUInt16LE(p + 8);
    const method = file.readUInt16LE(p + 10);
    const crc = file.readUInt32LE(p + 16);
    const compressed = file.readUInt32LE(p + 20);
    const size = file.readUInt32LE(p + 24);
    const nameLength = file.readUInt16LE(p + 28);
    const extraLength = file.readUInt16LE(p + 30);
    const commentLength = file.readUInt16LE(p + 32);
    const offset = file.readUInt32LE(p + 42);
    if (p + 46 + nameLength > file.length) throw notZip();
    const name = file.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new XlsxError('ENCRYPTED', 'Encrypted workbooks are not supported.');
    if (compressed === ZIP64 || size === ZIP64 || offset === ZIP64) {
      throw new XlsxError('ZIP_LIMIT', 'ZIP64 workbooks are not supported.');
    }
    if (method !== 0 && method !== 8) throw notZip();
    const key = name.toLowerCase();
    if (seen.has(key)) throw new XlsxError('MALFORMED_XLSX', 'The workbook repeats a part name.');
    seen.add(key);
    if (size > limits.maxEntryBytes) {
      throw new XlsxError('ZIP_LIMIT', 'A part of the workbook is too large when unpacked.');
    }
    if (size >= 64 * 1024 && size / Math.max(compressed, 1) > limits.maxRatio) {
      throw new XlsxError(
        'ZIP_LIMIT',
        'The workbook compresses suspiciously well and was refused.',
      );
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new XlsxError('ZIP_LIMIT', 'The workbook is too large when unpacked.');
    }
    entries.set(name, { name, method, crc, compressed, size, offset });
  }
  return entries;
}

/** Unpacks one part. The declared size is the cap while inflating and must match exactly. */
function unpack(file: Buffer, entry: ZipEntry): Buffer {
  const bad = () => new XlsxError('MALFORMED_XLSX', `The part ${entry.name} is damaged.`);
  const o = entry.offset;
  if (o + 30 > file.length || file.readUInt32LE(o) !== 0x04034b50) throw bad();
  const start = o + 30 + file.readUInt16LE(o + 26) + file.readUInt16LE(o + 28);
  const end = start + entry.compressed;
  if (end > file.length) throw bad();
  const raw = file.subarray(start, end);
  let data: Buffer;
  if (entry.method === 0) {
    if (entry.compressed !== entry.size) throw bad();
    data = raw;
  } else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
    } catch {
      throw bad();
    }
  }
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw bad();
  return data;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function xmlText(data: Buffer, part: string): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data).replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new XlsxError('MALFORMED_XLSX', `The part ${part} declares a DTD, which is not allowed.`);
  }
  return text;
}

// eslint-disable-next-line no-control-regex
const NUL = /\u0000/g;
const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;

/** Decodes the five XML entities and character references; any other `&` is malformed. */
function decode(text: string): string {
  let out = text;
  if (out.includes('<![CDATA[')) {
    out = out.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) =>
      inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    );
  }
  if (!out.includes('&') && !out.includes('_x')) return out.replace(NUL, '');
  // A raw `&` that is not one of the allowed references cannot come from a well-formed part.
  if (out.replace(ENTITY, '').includes('&')) {
    throw new XlsxError('MALFORMED_XLSX', 'The workbook contains an undefined XML entity.');
  }
  const replaced = out.replace(ENTITY, (_m, name: string) => {
    switch (name) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = name.startsWith('#x')
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
        return Number.isInteger(code) &&
          code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : '';
      }
    }
  });
  // OOXML escapes control characters in strings as _xHHHH_.
  return replaced
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return code === 0 ? '' : String.fromCharCode(code);
    })
    .replace(NUL, '');
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    result[m[1]!] = decode(m[2] ?? m[3] ?? '');
  }
  return result;
}

/** The concatenated `<t>` text of a shared string or inline string (phonetic runs skipped). */
function runsText(xml: string): string {
  const cleaned = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const pattern = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  for (let m = pattern.exec(cleaned); m; m = pattern.exec(cleaned)) out += decode(m[1] ?? '');
  return out;
}

function columnIndex(ref: string): number {
  let index = 0;
  for (const c of ref) {
    if (c < 'A' || c > 'Z') break;
    index = index * 26 + (c.charCodeAt(0) - 64);
  }
  return index - 1;
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .replace(/_./g, '')
    .replace(/\*./g, '');
  return /[ymdhs]/i.test(stripped);
}

function dateStyles(styles: string | null): Set<number> {
  const dates = new Set<number>();
  if (!styles) return dates;
  const custom = new Map<number, string>();
  const formats = /<numFmt\b([^>]*?)\/?>/g;
  for (let m = formats.exec(styles); m; m = formats.exec(styles)) {
    const a = attributes(m[1]!);
    if (a.numFmtId && a.formatCode !== undefined) custom.set(Number(a.numFmtId), a.formatCode);
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
  if (!block) return dates;
  const xfs = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
  let index = 0;
  for (let m = xfs.exec(block[1]!); m; m = xfs.exec(block[1]!)) {
    const id = Number(attributes(m[1]!).numFmtId ?? 0);
    const code = custom.get(id);
    if (code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id)) {
      dates.add(index);
    }
    index += 1;
  }
  return dates;
}

/** An Excel serial date as `YYYY-MM-DD` (null when it is not a calendar date). */
export function excelSerialToIso(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial)) return null;
  const days = Math.floor(serial);
  let ms: number;
  if (date1904) {
    if (days < 0) return null;
    ms = Date.UTC(1904, 0, 1) + days * 86_400_000;
  } else {
    if (days < 1 || days === 60) return null; // 1900-02-29 never existed
    ms = Date.UTC(1899, 11, days < 60 ? 31 : 30) + days * 86_400_000;
  }
  const d = new Date(ms);
  if (d.getUTCFullYear() < 1900 || d.getUTCFullYear() > 9999) return null;
  return d.toISOString().slice(0, 10);
}

/** A plain decimal string from a stored number (no exponent). */
function plainNumber(raw: string): string {
  const text = raw.trim();
  if (!/[eE]/.test(text)) return text;
  try {
    return new Decimal(text).toFixed();
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function resolveTarget(target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : `xl/${target}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

/**
 * Yields the rows of the first worksheet as records of strings. Throws `XlsxError` for a file that
 * is not an allowed workbook. Each record's `line` is the worksheet row number.
 */
export function* readXlsx(
  file: Buffer,
  limits: XlsxReadLimits = DEFAULT_XLSX_LIMITS,
): Generator<CsvRecord> {
  const entries = zipEntries(file, limits);
  const part = (name: string): string | null => {
    const entry = entries.get(name);
    return entry ? xmlText(unpack(file, entry), name) : null;
  };

  const types = part('[Content_Types].xml');
  const workbook = part('xl/workbook.xml');
  if (types === null || workbook === null) {
    throw new XlsxError('NOT_XLSX', 'The file is not an .xlsx workbook.');
  }
  if (
    /macroEnabled|vnd\.ms-excel\.sheet\.binary|vnd\.ms-office\.vbaProject/i.test(types) ||
    [...entries.keys()].some((n) => /vbaProject\.bin$/i.test(n) || /\.xlsb$/i.test(n))
  ) {
    throw new XlsxError('MACRO_ENABLED', 'Macro-enabled and binary workbooks are not accepted.');
  }

  const sheetTag = /<sheet\b([^>]*?)\/?>/.exec(workbook);
  if (!sheetTag) throw new XlsxError('MALFORMED_XLSX', 'The workbook has no worksheet.');
  const sheet = attributes(sheetTag[1]!);
  const relId = sheet['r:id'] ?? sheet.id;
  const rels = part('xl/_rels/workbook.xml.rels');
  if (!relId || rels === null)
    throw new XlsxError('MALFORMED_XLSX', 'The worksheet is not linked.');
  let sheetPath: string | null = null;
  const relPattern = /<Relationship\b([^>]*?)\/?>/g;
  for (let m = relPattern.exec(rels); m; m = relPattern.exec(rels)) {
    const a = attributes(m[1]!);
    if (a.Id === relId && a.Target && /\/worksheet$/.test(a.Type ?? '')) {
      sheetPath = resolveTarget(a.Target);
    }
  }
  if (!sheetPath || !entries.has(sheetPath)) {
    throw new XlsxError('MALFORMED_XLSX', 'The first sheet is not a worksheet.');
  }
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/i.test(workbook);

  const shared: string[] = [];
  const sharedXml = part('xl/sharedStrings.xml');
  if (sharedXml) {
    const items = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
    for (let m = items.exec(sharedXml); m; m = items.exec(sharedXml)) {
      if (shared.length >= limits.maxSharedStrings) {
        throw new XlsxError('ZIP_LIMIT', 'The workbook has too many distinct strings.');
      }
      shared.push(runsText(m[1] ?? ''));
    }
  }
  const dates = dateStyles(part('xl/styles.xml'));
  const sheetXml = part(sheetPath)!;

  const rows = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let lastRow = 0;
  for (let rm = rows.exec(sheetXml); rm; rm = rows.exec(sheetXml)) {
    const rowAttrs = attributes(rm[1]!);
    const line = rowAttrs.r ? Number(rowAttrs.r) : lastRow + 1;
    if (!Number.isInteger(line) || line <= lastRow) {
      throw new XlsxError('MALFORMED_XLSX', 'The worksheet rows are out of order.');
    }
    lastRow = line;
    const cells: string[] = [];
    let chars = 0;
    let column = 0;
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    for (let cm = cellPattern.exec(rm[2] ?? ''); cm; cm = cellPattern.exec(rm[2] ?? '')) {
      const a = attributes(cm[1]!);
      column = a.r ? columnIndex(a.r) : column;
      if (column < 0)
        throw new XlsxError('MALFORMED_XLSX', 'A cell has an invalid reference.', line);
      if (column >= limits.maxColumns) {
        throw new XlsxError(
          'TOO_MANY_COLUMNS',
          `Row ${line}: more than ${limits.maxColumns} columns.`,
          line,
        );
      }
      const inner = cm[2] ?? '';
      const type = a.t ?? 'n';
      const v = /<v\b[^>]*?>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 'inlineStr') {
        const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1];
        value = inline === undefined ? '' : runsText(inline);
      } else if (v !== undefined) {
        const text = decode(v);
        switch (type) {
          case 's': {
            const index = Number(text);
            if (!Number.isInteger(index) || index < 0 || index >= shared.length) {
              throw new XlsxError('MALFORMED_XLSX', 'A cell refers to a missing string.', line);
            }
            value = shared[index]!;
            break;
          }
          case 'str':
            value = text;
            break;
          case 'b':
            value = text.trim() === '1' ? 'TRUE' : 'FALSE';
            break;
          case 'e':
            value = '';
            break;
          case 'd':
            value = /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
            break;
          default: {
            // Number; a date-formatted number becomes an ISO date.
            const style = a.s === undefined ? -1 : Number(a.s);
            const serial = Number(text);
            value =
              dates.has(style) && Number.isFinite(serial)
                ? (excelSerialToIso(serial, date1904) ?? plainNumber(text))
                : plainNumber(text);
          }
        }
      }
      chars += value.length;
      if (chars > limits.maxRecordChars) {
        throw new XlsxError(
          'LINE_TOO_LONG',
          `Row ${line}: longer than ${limits.maxRecordChars} characters.`,
          line,
        );
      }
      while (cells.length < column) cells.push('');
      cells[column] = value;
      column += 1;
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    yield { line, cells };
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const NUMERIC = /^-?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
/** Excel's limits: rows, columns and characters in a cell. */
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;
export const XLSX_MAX_CELL_CHARS = 32_767;

function escapeXml(value: string): string {
  return value
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function isoToSerial(iso: string): number | null {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null;
  }
  const serial = Math.round((ms - Date.UTC(1899, 11, 30)) / 86_400_000);
  return serial >= 61 ? serial : null; // only dates from 1900-03-01 (after Excel's phantom leap day)
}

export class XlsxTooLargeError extends Error {
  constructor() {
    super('The workbook is too large.');
    this.name = 'XlsxTooLargeError';
  }
}

/** Builds a one-sheet workbook; the first row written is the (bold) header. */
export class XlsxWriter {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private rows = 0;

  /** `maxXmlBytes` caps the uncompressed sheet XML; exceeding it throws `XlsxTooLargeError`. */
  constructor(private readonly maxXmlBytes: number) {}

  get rowCount(): number {
    return this.rows;
  }

  addRow(cells: readonly CsvCell[]): void {
    this.rows += 1;
    if (this.rows > XLSX_MAX_ROWS) throw new XlsxTooLargeError();
    if (cells.length > XLSX_MAX_COLUMNS) throw new XlsxTooLargeError();
    const header = this.rows === 1;
    let xml = `<row r="${this.rows}">`;
    cells.forEach((cell, column) => {
      if (cell === null) return;
      const ref = `${columnLetters(column)}${this.rows}`;
      if (typeof cell === 'object') {
        const typed = 'number' in cell ? cell.number : cell.date;
        if (typed === null) return;
        if ('number' in cell && NUMERIC.test(typed)) {
          xml += `<c r="${ref}"><v>${typed}</v></c>`;
          return;
        }
        if ('date' in cell && ISO_DATE.test(typed)) {
          const serial = isoToSerial(typed);
          if (serial !== null) {
            xml += `<c r="${ref}" s="1"><v>${serial}</v></c>`;
            return;
          }
        }
        xml += this.text(ref, typed, header);
        return;
      }
      xml += this.text(ref, cell, header);
    });
    xml += '</row>';
    this.bytes += Buffer.byteLength(xml);
    if (this.bytes > this.maxXmlBytes) throw new XlsxTooLargeError();
    this.chunks.push(xml);
  }

  private text(ref: string, value: string, header: boolean): string {
    const safe = neutralizeFormula(value.replace(XML_INVALID, '')).slice(0, XLSX_MAX_CELL_CHARS);
    if (safe === '') return '';
    return `<c r="${ref}"${header ? ' s="2"' : ''} t="inlineStr"><is><t xml:space="preserve">${escapeXml(safe)}</t></is></c>`;
  }

  /** The finished .xlsx file. */
  finish(): Buffer {
    const sheet =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${this.chunks.join('')}</sheetData></worksheet>`;
    return zip([
      ['[Content_Types].xml', CONTENT_TYPES],
      ['_rels/.rels', ROOT_RELS],
      ['xl/workbook.xml', WORKBOOK],
      ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
      ['xl/styles.xml', STYLES],
      ['xl/worksheets/sheet1.xml', sheet],
    ]);
  }
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTENT_TYPES =
  XML_HEAD +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';
const ROOT_RELS =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const WORKBOOK =
  XML_HEAD +
  `<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WORKBOOK_RELS =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`;
const STYLES =
  XML_HEAD +
  `<styleSheet xmlns="${NS}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** A deterministic ZIP (deflate, fixed timestamps). */
function zip(files: readonly (readonly [string, string])[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const packed = deflateRawSync(data, { level: 6 });
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
