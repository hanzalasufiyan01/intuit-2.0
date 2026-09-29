/**
 * In-house RFC 4180 CSV reader and writer (Decision 75; S6-34, S6-39). No dependency.
 *
 * Reading is streamed: bytes are decoded as strict UTF-8 (S5-06 already guarantees it for
 * uploads), a leading BOM is dropped, and records are yielded one at a time. Quoted fields may
 * contain delimiters, quotes ("" escapes) and line breaks. Limits guard against hostile files.
 *
 * Writing produces UTF-8 with a BOM (Excel opens it as UTF-8) and CRLF line endings. Text cells
 * are always quoted and neutralized against formula injection (Decision 24).
 */

export type CsvDelimiter = ',' | ';' | '\t';

export class CsvError extends Error {
  constructor(
    readonly code: 'MALFORMED_CSV' | 'LINE_TOO_LONG' | 'TOO_MANY_COLUMNS' | 'INVALID_ENCODING',
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'CsvError';
  }
}

export interface CsvReadOptions {
  delimiter: CsvDelimiter;
  /** Maximum characters in one record (including quoted line breaks). */
  maxRecordChars: number;
  maxColumns: number;
}

export interface CsvRecord {
  /** Line on which the record starts (1-based). */
  line: number;
  /** Cells; a fully empty line is `[]` so callers can skip it and keep line numbers. */
  cells: string[];
}

type State = 'fieldStart' | 'unquoted' | 'quoted' | 'afterQuote';

/** Parses CSV records from a byte (or string) stream. */
export async function* readCsv(
  source: AsyncIterable<Buffer | string>,
  options: CsvReadOptions,
): AsyncGenerator<CsvRecord> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const { delimiter } = options;
  let started = false;
  let carry = '';
  let state: State = 'fieldStart';
  let field = '';
  let record: string[] = [];
  let recordChars = 0;
  let pendingCr = false;
  let physicalLine = 1;
  let recordLine = 1;

  const fail = (code: CsvError['code'], message: string): never => {
    throw new CsvError(code, `Line ${recordLine}: ${message}`, recordLine);
  };
  const endField = () => {
    record.push(field);
    field = '';
    state = 'fieldStart';
    if (record.length > options.maxColumns) {
      fail('TOO_MANY_COLUMNS', `more than ${options.maxColumns} columns.`);
    }
  };
  const endRecord = (): CsvRecord => {
    endField();
    const cells = record.length === 1 && record[0] === '' ? [] : record;
    const result = { line: recordLine, cells };
    record = [];
    recordChars = 0;
    return result;
  };
  const decode = (chunk: Buffer | string, stream: boolean): string => {
    if (typeof chunk === 'string') return chunk;
    try {
      return decoder.decode(chunk, { stream });
    } catch {
      return fail('INVALID_ENCODING', 'the file is not valid UTF-8 text.');
    }
  };

  const process = function* (text: string, final: boolean): Generator<CsvRecord> {
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]!;
      if (pendingCr) {
        pendingCr = false;
        if (c === '\n') continue; // CRLF: the record already ended at CR
      }
      recordChars += 1;
      if (recordChars > options.maxRecordChars) {
        fail('LINE_TOO_LONG', `longer than ${options.maxRecordChars} characters.`);
      }
      switch (state) {
        case 'quoted':
          if (c === '"') {
            if (i + 1 === text.length && !final) {
              // Escaped quote or closing quote? The next chunk decides.
              carry = '"';
              recordChars -= 1;
              return;
            }
            if (text[i + 1] === '"') {
              field += '"';
              i += 1;
              recordChars += 1;
            } else {
              state = 'afterQuote';
            }
          } else {
            if (c === '\n') physicalLine += 1;
            field += c;
          }
          break;
        case 'fieldStart':
        case 'unquoted':
        case 'afterQuote':
          if (c === delimiter) {
            endField();
          } else if (c === '\n' || c === '\r') {
            if (c === '\r') pendingCr = true;
            yield endRecord();
            physicalLine += 1;
            recordLine = physicalLine;
          } else if (state === 'afterQuote') {
            fail('MALFORMED_CSV', 'text after a closing quote.');
          } else if (c === '"') {
            if (state === 'fieldStart') state = 'quoted';
            else fail('MALFORMED_CSV', 'a quote inside an unquoted value.');
          } else {
            field += c;
            state = 'unquoted';
          }
          break;
      }
    }
  };

  const feed = async function* (): AsyncGenerator<{ text: string; final: boolean }> {
    for await (const chunk of source) yield { text: decode(chunk, true), final: false };
    yield { text: decode(Buffer.alloc(0), false), final: true };
  };

  for await (const piece of feed()) {
    let text = carry + piece.text;
    carry = '';
    if (!started && text.length > 0) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      started = true;
    }
    yield* process(text, piece.final);
  }
  // state is mutated inside process(); widen it for the final checks.
  const finalState = state as State;
  if (finalState === 'quoted') fail('MALFORMED_CSV', 'an unterminated quoted value.');
  if (field.length > 0 || record.length > 0 || finalState === 'afterQuote') {
    yield endRecord();
  }
}

/** Picks the delimiter used most often outside quotes on the header line (ties: comma). */
export function detectDelimiter(headerLine: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const c of headerLine) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === ',' || c === ';' || c === '\t')) counts[c] += 1;
  }
  const max = Math.max(counts[','], counts[';'], counts['\t']);
  if (max === 0 || counts[','] === max) return ',';
  return counts[';'] === max ? ';' : '\t';
}

// ---------------------------------------------------------------------------
// Formula injection (Decision 24; S6-34)
// ---------------------------------------------------------------------------

/** Characters that make spreadsheet programs treat a cell as a formula (incl. full-width forms). */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r', '＝', '＋', '－', '＠']);

/** Prefixes a text value that a spreadsheet would evaluate with an apostrophe. */
export function neutralizeFormula(value: string): string {
  return value.length > 0 && FORMULA_TRIGGERS.has(value[0]!) ? `'${value}` : value;
}

/**
 * Reverses our own export escape on import: an apostrophe followed by a formula trigger is
 * removed, so exported files re-import unchanged. Imported text is never evaluated.
 */
export function unneutralizeFormula(value: string): string {
  return value.length > 1 && value[0] === "'" && FORMULA_TRIGGERS.has(value[1]!)
    ? value.slice(1)
    : value;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A text cell, or a typed number/date cell written bare when well-formed. */
export type CsvCell = string | null | { number: string | null } | { date: string | null };

const NUMERIC = /^-?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * One CSV record ending in CRLF. Strings are text: always quoted and neutralized. `{ number }`
 * and `{ date }` cells are typed: a numeric string or ISO date is written bare, so "-100.00"
 * stays a number; anything else falls back to neutralized text.
 */
export function csvRecord(cells: readonly CsvCell[]): string {
  return (
    cells
      .map((cell) => {
        if (cell === null) return '';
        if (typeof cell === 'object') {
          const typed = 'number' in cell ? cell.number : cell.date;
          if (typed === null) return '';
          const pattern = 'number' in cell ? NUMERIC : ISO_DATE;
          return pattern.test(typed) ? typed : quote(neutralizeFormula(typed));
        }
        return quote(neutralizeFormula(cell));
      })
      .join(',') + '\r\n'
  );
}

/** UTF-8 byte order mark written at the start of every exported CSV. */
export const CSV_BOM = '\uFEFF';
