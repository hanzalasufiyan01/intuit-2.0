import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { decimal } from '../../domain/money.js';
import { CsvError, normalize, readCsv, type CsvDelimiter } from '../data-exchange/index.js';

/**
 * Bank statement providers (Phase 4B banking; the provider abstraction for a bank's transactions).
 * A provider turns a statement (or, later, a live bank feed) into plain transactions; nothing here
 * touches the database or the ledger. Two providers ship: CSV (with a column mapping chosen by the
 * user) and OFX (1.x SGML and 2.x XML). A live-feed provider can implement the same interface.
 *
 * Amounts are signed from the account's point of view: positive is money in, negative money out.
 * Every transaction gets a fingerprint (date, amount, text, reference and the occurrence number of
 * identical lines in the file), so importing an overlapping statement again recognizes what it
 * already holds; an OFX FITID is used as well when the bank supplies one.
 */

export const MAX_STATEMENT_ROWS = 25_000;
export const MAX_STATEMENT_CHARS = 5 * 1024 * 1024;

export interface ParsedTransaction {
  date: string;
  description: string;
  reference: string | null;
  /** Signed: positive is money in. */
  amount: string;
  /** The running balance on the statement, when given. */
  balance: string | null;
  /** The bank's own transaction id (OFX FITID), when given. */
  externalId: string | null;
  /** Row number in the file (CSV line or position in the OFX), for messages. */
  rowNumber: number;
}

export interface ParseProblem {
  rowNumber: number;
  field: string;
  message: string;
}

export interface ParsedStatement {
  transactions: ParsedTransaction[];
  problems: ParseProblem[];
  currency: string | null;
}

export interface CsvMapping {
  dateColumn: string;
  descriptionColumn: string;
  /** One signed amount column, or a debit column and a credit column. */
  amountColumn?: string | undefined;
  debitColumn?: string | undefined;
  creditColumn?: string | undefined;
  referenceColumn?: string | undefined;
  balanceColumn?: string | undefined;
  dateFormat: 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY';
  decimalSeparator: '.' | ',';
  delimiter: CsvDelimiter | 'auto';
}

export interface StatementProvider<Options> {
  key: 'csv' | 'ofx';
  parse(content: string, options: Options): Promise<ParsedStatement>;
}

const SPACES = /\s+/g;
const clean = (value: string) => value.replace(SPACES, ' ').trim();

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function detectDelimiter(headerLine: string): CsvDelimiter {
  const counts = {
    ',': headerLine.split(',').length,
    ';': headerLine.split(';').length,
    '\t': headerLine.split('\t').length,
  };
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0] as CsvDelimiter) ?? ',';
}

/** The header cells of a CSV statement, for the column mapping screen. */
export async function csvHeader(
  content: string,
): Promise<{ delimiter: CsvDelimiter; columns: string[]; sample: string[][] }> {
  const delimiter = detectDelimiter(content.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)[0] ?? '');
  const columns: string[] = [];
  const sample: string[][] = [];
  for await (const record of readCsv(Readable.from([Buffer.from(content, 'utf8')]), {
    delimiter,
    maxRecordChars: 20_000,
    maxColumns: 100,
  })) {
    if (record.cells.length === 0) continue;
    if (columns.length === 0) columns.push(...record.cells.map((c) => clean(c)));
    else sample.push(record.cells);
    if (sample.length >= 5) break;
  }
  return { delimiter, columns, sample };
}

export const csvProvider: StatementProvider<CsvMapping> = {
  key: 'csv',
  async parse(content, mapping) {
    const problems: ParseProblem[] = [];
    const transactions: ParsedTransaction[] = [];
    if (content.length > MAX_STATEMENT_CHARS) {
      return {
        transactions,
        problems: [{ rowNumber: 0, field: 'file', message: 'The statement is larger than 5 MB.' }],
        currency: null,
      };
    }
    const delimiter =
      mapping.delimiter === 'auto'
        ? detectDelimiter(content.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)[0] ?? '')
        : mapping.delimiter;
    let columns: string[] | null = null;
    let index: Record<string, number> = {};
    const find = (name: string | undefined, field: string, required: boolean) => {
      if (!name) {
        if (required) problems.push({ rowNumber: 1, field, message: 'Choose this column.' });
        return -1;
      }
      const at = columns!.findIndex((c) => c.toLowerCase() === name.trim().toLowerCase());
      if (at < 0) problems.push({ rowNumber: 1, field, message: `No column is named "${name}".` });
      return at;
    };
    try {
      for await (const record of readCsv(Readable.from([Buffer.from(content, 'utf8')]), {
        delimiter,
        maxRecordChars: 20_000,
        maxColumns: 100,
      })) {
        if (record.cells.length === 0) continue;
        if (!columns) {
          columns = record.cells.map((c) => clean(c));
          index = {
            date: find(mapping.dateColumn, 'dateColumn', true),
            description: find(mapping.descriptionColumn, 'descriptionColumn', true),
            amount: find(mapping.amountColumn, 'amountColumn', false),
            debit: find(mapping.debitColumn, 'debitColumn', false),
            credit: find(mapping.creditColumn, 'creditColumn', false),
            reference: find(mapping.referenceColumn, 'referenceColumn', false),
            balance: find(mapping.balanceColumn, 'balanceColumn', false),
          };
          if (index.amount! < 0 && (index.debit! < 0 || index.credit! < 0)) {
            if (!mapping.amountColumn && !(mapping.debitColumn && mapping.creditColumn)) {
              problems.push({
                rowNumber: 1,
                field: 'amountColumn',
                message: 'Choose an amount column, or both a debit and a credit column.',
              });
            }
          }
          if (problems.length) return { transactions, problems, currency: null };
          continue;
        }
        if (transactions.length + problems.length >= MAX_STATEMENT_ROWS) {
          problems.push({
            rowNumber: record.line,
            field: 'file',
            message: 'Too many rows (25,000 at most).',
          });
          break;
        }
        const cell = (at: number | undefined) =>
          at !== undefined && at >= 0 ? (normalize.text(record.cells[at] ?? null) ?? null) : null;
        const row = record.line;
        const dateRaw = cell(index.date);
        const date = normalize.date(dateRaw, mapping.dateFormat, 'date');
        if (!dateRaw || !date.ok || !date.value) {
          problems.push({
            rowNumber: row,
            field: 'date',
            message: `Enter a valid date in the ${mapping.dateFormat} format.`,
          });
          continue;
        }
        let amount: string | null = null;
        if ((index.amount ?? -1) >= 0) {
          const parsed = normalize.decimal(cell(index.amount), mapping.decimalSeparator, 'amount');
          if (!parsed.ok || parsed.value === null) {
            problems.push({
              rowNumber: row,
              field: 'amount',
              message: 'Enter the amount as a number.',
            });
            continue;
          }
          amount = parsed.value;
        } else {
          const debit = normalize.decimal(cell(index.debit), mapping.decimalSeparator, 'debit');
          const credit = normalize.decimal(cell(index.credit), mapping.decimalSeparator, 'credit');
          if (!debit.ok || !credit.ok) {
            problems.push({
              rowNumber: row,
              field: 'amount',
              message: 'Enter the debit and credit as numbers.',
            });
            continue;
          }
          const out = debit.value ? decimal(debit.value).abs() : decimal(0);
          const inn = credit.value ? decimal(credit.value).abs() : decimal(0);
          amount = inn.minus(out).toFixed();
        }
        if (decimal(amount).isZero()) {
          problems.push({ rowNumber: row, field: 'amount', message: 'The amount cannot be zero.' });
          continue;
        }
        const description = cell(index.description);
        if (!description) {
          problems.push({
            rowNumber: row,
            field: 'description',
            message: 'A description is needed.',
          });
          continue;
        }
        let balance: string | null = null;
        if ((index.balance ?? -1) >= 0 && cell(index.balance) !== null) {
          const parsed = normalize.decimal(
            cell(index.balance),
            mapping.decimalSeparator,
            'balance',
          );
          if (parsed.ok) balance = parsed.value;
        }
        transactions.push({
          date: date.value,
          description: clean(description).slice(0, 500),
          reference: cell(index.reference)?.slice(0, 100) ?? null,
          amount: decimal(amount).toFixed(),
          balance,
          externalId: null,
          rowNumber: row,
        });
      }
    } catch (error) {
      if (error instanceof CsvError) {
        problems.push({ rowNumber: error.line, field: 'file', message: error.message });
      } else throw error;
    }
    return { transactions, problems, currency: null };
  },
};

// ---------------------------------------------------------------------------
// OFX (1.x SGML and 2.x XML)
// ---------------------------------------------------------------------------

function entities(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** The text of the first <TAG>value in a block (SGML omits closing tags; XML has them). */
function tag(block: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
  if (!match) return null;
  const value = entities(match[1]!.trim());
  return value === '' ? null : value;
}

function ofxDate(raw: string | null): string | null {
  if (!raw) return null;
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(raw);
  if (!match) return null;
  const [, y, m, d] = match;
  const parsed = normalize.date(`${y}-${m}-${d}`, 'YYYY-MM-DD', 'date');
  return parsed.ok ? parsed.value : null;
}

export const ofxProvider: StatementProvider<Record<string, never>> = {
  key: 'ofx',
  async parse(content) {
    const problems: ParseProblem[] = [];
    const transactions: ParsedTransaction[] = [];
    if (content.length > MAX_STATEMENT_CHARS) {
      return {
        transactions,
        problems: [{ rowNumber: 0, field: 'file', message: 'The statement is larger than 5 MB.' }],
        currency: null,
      };
    }
    // No entity or DTD resolution: the content is only read with patterns, never evaluated.
    if (/<!DOCTYPE|<!ENTITY/i.test(content)) {
      return {
        transactions,
        problems: [
          {
            rowNumber: 0,
            field: 'file',
            message: 'This file contains a document type declaration and cannot be read.',
          },
        ],
        currency: null,
      };
    }
    if (!/<OFX>/i.test(content)) {
      return {
        transactions,
        problems: [{ rowNumber: 0, field: 'file', message: 'This is not an OFX statement.' }],
        currency: null,
      };
    }
    const currency = tag(content, 'CURDEF')?.toUpperCase() ?? null;
    const blocks = content.split(/<STMTTRN>/i).slice(1);
    let position = 0;
    for (const raw of blocks) {
      position += 1;
      if (transactions.length >= MAX_STATEMENT_ROWS) {
        problems.push({
          rowNumber: position,
          field: 'file',
          message: 'Too many transactions (25,000 at most).',
        });
        break;
      }
      const block = raw.split(/<\/STMTTRN>|<STMTTRN>/i)[0]!;
      const date = ofxDate(tag(block, 'DTPOSTED'));
      const amountRaw = tag(block, 'TRNAMT')?.replace(',', '.') ?? null;
      if (!date) {
        problems.push({
          rowNumber: position,
          field: 'date',
          message: 'The posting date is missing or invalid.',
        });
        continue;
      }
      if (!amountRaw || !/^[-+]?\d+(\.\d+)?$/.test(amountRaw)) {
        problems.push({
          rowNumber: position,
          field: 'amount',
          message: 'The amount is missing or not a number.',
        });
        continue;
      }
      if (decimal(amountRaw).isZero()) {
        problems.push({
          rowNumber: position,
          field: 'amount',
          message: 'The amount cannot be zero.',
        });
        continue;
      }
      const name = tag(block, 'NAME');
      const memo = tag(block, 'MEMO');
      const description = clean(
        [name, memo].filter(Boolean).join(' — ') || tag(block, 'TRNTYPE') || 'Bank transaction',
      );
      transactions.push({
        date,
        description: description.slice(0, 500),
        reference: (tag(block, 'CHECKNUM') ?? tag(block, 'REFNUM'))?.slice(0, 100) ?? null,
        amount: decimal(amountRaw).toFixed(),
        balance: null,
        externalId: tag(block, 'FITID')?.slice(0, 200) ?? null,
        rowNumber: position,
      });
    }
    if (transactions.length === 0 && problems.length === 0) {
      problems.push({
        rowNumber: 0,
        field: 'file',
        message: 'The statement holds no transactions.',
      });
    }
    return { transactions, problems, currency };
  },
};

// ---------------------------------------------------------------------------
// Fingerprints (duplicate detection)
// ---------------------------------------------------------------------------

/**
 * One fingerprint per transaction. Identical lines in one file (same date, amount, text and
 * reference) are numbered in file order, so two genuine identical transactions are both kept and a
 * re-import of an overlapping file reproduces the same fingerprints.
 */
export function withFingerprints(
  transactions: readonly ParsedTransaction[],
): (ParsedTransaction & { fingerprint: string })[] {
  const seen = new Map<string, number>();
  return transactions.map((t) => {
    const base = [
      t.date,
      decimal(t.amount).toFixed(4),
      clean(t.description).toLowerCase(),
      (t.reference ?? '').toLowerCase(),
    ].join('|');
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return {
      ...t,
      fingerprint: createHash('sha256').update(`${base}|${occurrence}`).digest('hex'),
    };
  });
}
