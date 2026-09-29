import { describe, expect, it } from 'vitest';
import { suggestMapping } from '../src/application/data-exchange/import-service.js';
import {
  csvRecord,
  CsvError,
  detectDelimiter,
  neutralizeFormula,
  normalize,
  readCsv,
  unneutralizeFormula,
  type CsvDelimiter,
} from '../src/modules/data-exchange/index.js';

/** Phase 3A S6 unit tests: CSV reader/writer (S6-39), formula safety (S6-34), normalization. */

async function parse(
  text: string | Buffer,
  options: {
    delimiter?: CsvDelimiter;
    chunk?: number;
    maxColumns?: number;
    maxRecordChars?: number;
  } = {},
) {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const size = options.chunk ?? bytes.length;
  async function* chunks() {
    for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
  }
  const out: string[][] = [];
  for await (const r of readCsv(chunks(), {
    delimiter: options.delimiter ?? ',',
    maxColumns: options.maxColumns ?? 200,
    maxRecordChars: options.maxRecordChars ?? 1_000_000,
  })) {
    out.push(r.cells);
  }
  return out;
}

describe('CSV reader (RFC 4180)', () => {
  const tricky =
    '\uFEFFcode,name,notes\r\n' +
    '1000,"Cash, petty","He said ""hi"""\r\n' +
    '1001,"Two\nlines",\n' +
    '\n' +
    '1002,Plain,"x"\r' +
    '1003,Last,end';

  const expected = [
    ['code', 'name', 'notes'],
    ['1000', 'Cash, petty', 'He said "hi"'],
    ['1001', 'Two\nlines', ''],
    [],
    ['1002', 'Plain', 'x'],
    ['1003', 'Last', 'end'],
  ];

  it('handles BOM, quotes, escaped quotes, embedded line breaks and CRLF/LF/CR endings', async () => {
    expect(await parse(tricky)).toEqual(expected);
  });

  it('gives the same result whatever the chunk boundaries (one byte at a time)', async () => {
    for (const chunk of [1, 2, 3, 7]) expect(await parse(tricky, { chunk })).toEqual(expected);
  });

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    expect(await parse('name\r\nRésumé ✓ ދިވެހި\r\n', { chunk: 1 })).toEqual([
      ['name'],
      ['Résumé ✓ ދިވެހި'],
    ]);
  });

  it('supports semicolon and tab delimiters and detects them from the header', async () => {
    expect(await parse('a;b\n1;"2;3"\n', { delimiter: ';' })).toEqual([
      ['a', 'b'],
      ['1', '2;3'],
    ]);
    expect(await parse('a\tb\n1\t2\n', { delimiter: '\t' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(detectDelimiter('code;name;"a,b"')).toBe(';');
    expect(detectDelimiter('code\tname')).toBe('\t');
    expect(detectDelimiter('code,name')).toBe(',');
    expect(detectDelimiter('single')).toBe(',');
    expect(detectDelimiter('a;b,c')).toBe(',');
  });

  it('rejects malformed input with a line number', async () => {
    await expect(parse('a,b\n"open,1\n')).rejects.toMatchObject({ code: 'MALFORMED_CSV' });
    await expect(parse('a,b\nx"y,1\n')).rejects.toMatchObject({ code: 'MALFORMED_CSV', line: 2 });
    await expect(parse('a,b\n"q"x,1\n')).rejects.toMatchObject({ code: 'MALFORMED_CSV' });
    await expect(parse(Buffer.from([0x61, 0x0a, 0xff, 0xfe]))).rejects.toMatchObject({
      code: 'INVALID_ENCODING',
    });
  });

  it('enforces the column and record-length limits', async () => {
    await expect(parse('a,b,c\n', { maxColumns: 2 })).rejects.toBeInstanceOf(CsvError);
    await expect(parse(`a\n${'x'.repeat(50)}\n`, { maxRecordChars: 20 })).rejects.toMatchObject({
      code: 'LINE_TOO_LONG',
    });
    // A quote bomb (never closed) is bounded by the record limit, not memory.
    await expect(parse(`a\n"${'x'.repeat(100)}`, { maxRecordChars: 50 })).rejects.toMatchObject({
      code: 'LINE_TOO_LONG',
    });
  });

  it('keeps empty trailing cells and ignores a final newline', async () => {
    expect(await parse('a,b\n1,\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
    expect(await parse('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('CSV writer and formula injection (Decision 24)', () => {
  it('quotes text, escapes quotes and writes typed numbers and dates bare', () => {
    expect(csvRecord(['a "b"', null, { number: '-100.50' }, { date: '2026-03-15' }])).toBe(
      '"a ""b""",,-100.50,2026-03-15\r\n',
    );
  });

  it('neutralizes every formula trigger in text cells, including full-width forms', () => {
    for (const payload of [
      '=HYPERLINK("http://x","y")',
      '+1+1',
      '-1+1',
      '@SUM(A1)',
      '\tcmd',
      '\rcmd',
      '＝1+1',
      '＋1',
      '－1',
      '＠A1',
    ]) {
      expect(neutralizeFormula(payload)).toBe(`'${payload}`);
      expect(csvRecord([payload])).toBe(`"'${payload.replace(/"/g, '""')}"\r\n`);
    }
    expect(neutralizeFormula('Safe')).toBe('Safe');
  });

  it('never lets a typed cell carry a formula', () => {
    expect(csvRecord([{ number: '=1+1' }])).toBe(`"'=1+1"\r\n`);
    expect(csvRecord([{ date: '@A1' }])).toBe(`"'@A1"\r\n`);
  });

  it('reverses only its own escape on import (round trip)', () => {
    expect(unneutralizeFormula("'=SUM(A1)")).toBe('=SUM(A1)');
    expect(unneutralizeFormula("'-5")).toBe('-5');
    expect(unneutralizeFormula("'quoted")).toBe("'quoted");
    expect(unneutralizeFormula("O'Neil")).toBe("O'Neil");
    expect(normalize.text(`  ${neutralizeFormula('=Petty cash')}  `)).toBe('=Petty cash');
  });
});

describe('normalization (S6-23)', () => {
  it('parses dates only in the chosen format and rejects impossible dates', () => {
    expect(normalize.date('2026-03-05', 'YYYY-MM-DD', 'd')).toEqual({
      ok: true,
      value: '2026-03-05',
    });
    expect(normalize.date('5/3/2026', 'DD/MM/YYYY', 'd')).toEqual({
      ok: true,
      value: '2026-03-05',
    });
    expect(normalize.date('3/5/2026', 'MM/DD/YYYY', 'd')).toEqual({
      ok: true,
      value: '2026-03-05',
    });
    expect(normalize.date('05.03.2026', 'DD/MM/YYYY', 'd')).toEqual({
      ok: true,
      value: '2026-03-05',
    });
    for (const [value, format] of [
      ['2026-02-30', 'YYYY-MM-DD'],
      ['31/04/2026', 'DD/MM/YYYY'],
      ['13/01/2026', 'MM/DD/YYYY'],
      ['2026-03-05', 'DD/MM/YYYY'],
      ['March 5', 'YYYY-MM-DD'],
    ] as const) {
      expect(normalize.date(value, format, 'd')).toMatchObject({
        ok: false,
        message: { code: 'INVALID_DATE' },
      });
    }
    expect(normalize.date(null, 'YYYY-MM-DD', 'd')).toEqual({ ok: true, value: null });
  });

  it('parses exact decimals in either notation without guessing', () => {
    const ok = (raw: string, sep: '.' | ',', value: string) =>
      expect(normalize.decimal(raw, sep, 'n')).toEqual({ ok: true, value });
    ok('1234.50', '.', '1234.50');
    ok('1,234.50', '.', '1234.50');
    ok('1.234,50', ',', '1234.50');
    ok('(250.00)', '.', '-250.00');
    ok('-0.01', '.', '-0.01');
    ok('  12 345.6 ', '.', '12345.6');
    ok('007', '.', '7');
    ok('-0', '.', '0');
    for (const raw of ['1,23', '1.234,5', '$10', '1e5', '(-1)', '+5', '12..3', 'abc', '']) {
      if (raw === '') continue;
      expect(normalize.decimal(raw, '.', 'n')).toMatchObject({
        ok: false,
        message: { code: 'INVALID_NUMBER' },
      });
    }
  });

  it('parses booleans, enumerations and lists', () => {
    expect(normalize.boolean('Yes', 'b')).toEqual({ ok: true, value: true });
    expect(normalize.boolean('0', 'b')).toEqual({ ok: true, value: false });
    expect(normalize.boolean('maybe', 'b')).toMatchObject({ ok: false });
    expect(normalize.oneOf('Accounts receivable', ['ACCOUNTS_RECEIVABLE', 'BANK'], 's')).toEqual({
      ok: true,
      value: 'ACCOUNTS_RECEIVABLE',
    });
    expect(normalize.oneOf('nope', ['BANK'], 's')).toMatchObject({ ok: false });
    expect(normalize.list('customer; vendor|other,')).toEqual(['customer', 'vendor', 'other']);
  });
});

describe('mapping suggestion (S6-42)', () => {
  it('matches keys, labels and synonyms case- and punctuation-insensitively, one column each', () => {
    const fields = [
      {
        key: 'code',
        label: 'Code',
        required: true,
        description: '',
        example: '',
        synonyms: ['GL Code'],
      },
      {
        key: 'name',
        label: 'Name',
        required: true,
        description: '',
        example: '',
        synonyms: ['Account name'],
      },
      {
        key: 'parent_code',
        label: 'Parent code',
        required: false,
        description: '',
        example: '',
        synonyms: [],
      },
      {
        key: 'currency',
        label: 'Currency',
        required: false,
        description: '',
        example: '',
        synonyms: [],
      },
    ];
    expect(suggestMapping(fields, ['G/L code', 'ACCOUNT NAME', 'Parent_Code', 'Other'])).toEqual({
      code: 0,
      name: 1,
      parent_code: 2,
      currency: null,
    });
  });
});
