import { unneutralizeFormula } from './csv.js';
import type { ImportOptions, RowMessage } from './schema.js';

/**
 * Cell normalization (S6-22/S6-23). Every conversion is explicit: dates use the batch's chosen
 * format and numbers its decimal separator, so nothing is guessed. Messages never contain cell
 * values (they outlive the 30-day redaction of the row data, L-11).
 */

export type Normalized<T> = { ok: true; value: T } | { ok: false; message: RowMessage };

const error = (code: string, field: string | null, message: string): RowMessage => ({
  severity: 'error',
  code,
  field,
  message,
});

export const rowError = error;
export const rowWarning = (code: string, field: string | null, message: string): RowMessage => ({
  severity: 'warning',
  code,
  field,
  message,
});

/** Trimmed text with our export escape removed; blank becomes null. */
export function text(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = unneutralizeFormula(raw.trim()).trim();
  return trimmed === '' ? null : trimmed;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 9999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** A calendar date in the batch's format, returned as YYYY-MM-DD. */
export function date(
  raw: string | null,
  format: ImportOptions['dateFormat'],
  field: string,
): Normalized<string | null> {
  if (raw === null) return { ok: true, value: null };
  const patterns: Record<ImportOptions['dateFormat'], RegExp> = {
    'YYYY-MM-DD': /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    'DD/MM/YYYY': /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/,
    'MM/DD/YYYY': /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/,
  };
  const match = patterns[format].exec(raw);
  const invalid = {
    ok: false as const,
    message: error('INVALID_DATE', field, `Enter a valid date in the ${format} format.`),
  };
  if (!match) return invalid;
  const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const [year, month, day] =
    format === 'YYYY-MM-DD' ? [a, b, c] : format === 'DD/MM/YYYY' ? [c, b, a] : [c, a, b];
  if (!isRealDate(year, month, day)) return invalid;
  return { ok: true, value: `${pad(year, 4)}-${pad(month)}-${pad(day)}` };
}

/**
 * An exact decimal in the batch's notation, returned as a plain decimal string ("-1234.50").
 * Thousands separators must form proper groups of three; parentheses mean negative; currency
 * symbols and exponents are rejected.
 */
export function decimal(
  raw: string | null,
  separator: ImportOptions['decimalSeparator'],
  field: string,
): Normalized<string | null> {
  if (raw === null) return { ok: true, value: null };
  let value = raw.replace(/[\s\u00a0\u202f]/g, '');
  let negative = false;
  const parens = /^\((.*)\)$/.exec(value);
  if (parens) {
    negative = true;
    value = parens[1]!;
  }
  if (value.startsWith('-')) {
    if (negative) value = '!'; // "(-1)" is not a number
    negative = true;
    value = value.slice(1);
  }
  const thousands = separator === '.' ? ',' : '.';
  const t = thousands === '.' ? '\\.' : ',';
  const d = separator === '.' ? '\\.' : ',';
  const grouped = new RegExp(`^\\d{1,3}(${t}\\d{3})+(${d}\\d+)?$`);
  const plain = new RegExp(`^\\d+(${d}\\d+)?$`);
  if (!grouped.test(value) && !plain.test(value)) {
    return {
      ok: false,
      message: error(
        'INVALID_NUMBER',
        field,
        `Enter a number using "${separator}" as the decimal separator.`,
      ),
    };
  }
  let normalized = value.split(thousands).join('');
  if (separator === ',') normalized = normalized.replace(',', '.');
  normalized = normalized.replace(/^0+(?=\d)/, '');
  return { ok: true, value: negative && /[1-9]/.test(normalized) ? `-${normalized}` : normalized };
}

const TRUE = new Set(['true', 'yes', 'y', '1']);
const FALSE = new Set(['false', 'no', 'n', '0']);

export function boolean(raw: string | null, field: string): Normalized<boolean | null> {
  if (raw === null) return { ok: true, value: null };
  const key = raw.toLowerCase();
  if (TRUE.has(key)) return { ok: true, value: true };
  if (FALSE.has(key)) return { ok: true, value: false };
  return {
    ok: false,
    message: error('INVALID_BOOLEAN', field, 'Use yes/no, true/false or 1/0.'),
  };
}

/** Case- and punctuation-insensitive key used to match headers and enumerated values. */
export function matchKey(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** One of `allowed`, matched case-insensitively and ignoring spaces, "_" and "-". */
export function oneOf<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  field: string,
): Normalized<T | null> {
  if (raw === null) return { ok: true, value: null };
  const found = allowed.find((a) => matchKey(a) === matchKey(raw));
  if (found) return { ok: true, value: found };
  return {
    ok: false,
    message: error(
      'INVALID_VALUE',
      field,
      `Use one of: ${allowed.map((a) => a.toLowerCase()).join(', ')}.`,
    ),
  };
}

/** A list separated by ";", "," or "|". */
export function list(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(/[;,|]/)
    .map((v) => v.trim())
    .filter(Boolean);
}
