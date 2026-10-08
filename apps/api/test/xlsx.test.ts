import { describe, expect, it } from 'vitest';
import {
  DEFAULT_XLSX_LIMITS,
  excelSerialToIso,
  readXlsx,
  XlsxError,
  XlsxTooLargeError,
  XlsxWriter,
} from '../src/modules/data-exchange/index.js';
import { buildZip, DATE_STYLES, row, text, workbook } from './xlsx-fixtures.js';

/**
 * The in-house workbook reader and writer (Decision 62): values only, bounded, no DTDs, no
 * macros, formulas never evaluated, formula-neutralized output.
 */

const read = (file: Buffer, limits = DEFAULT_XLSX_LIMITS) => [...readXlsx(file, limits)];
const cellsOf = (file: Buffer) => read(file).map((r) => r.cells);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof XlsxError ? error.code : 'OTHER';
  }
  return null;
};

describe('reading values', () => {
  it('reads shared, inline, rich, boolean, numeric and cached-formula cells of the first sheet', () => {
    const file = workbook({
      sharedStrings: [
        '<t>Code</t>',
        '<r><t>Na</t></r><r><t>me</t></r>',
        '<t>A &amp; B &lt;1&gt;</t>',
      ],
      sheetData: [
        row(
          1,
          '<c r="A1" t="s"><v>0</v></c>',
          '<c r="B1" t="s"><v>1</v></c>',
          '<c r="C1" t="s"><v>2</v></c>',
        ),
        row(
          2,
          text('A2', 'X1'),
          '<c r="B2" t="b"><v>1</v></c>',
          '<c r="C2"><v>1.5E-3</v></c>',
          '<c r="D2" t="str"><f>A2&amp;"!"</f><v>X1!</v></c>',
          '<c r="E2" t="e"><v>#DIV/0!</v></c>',
          '<c r="F2"><f>1+1</f></c>',
        ),
      ].join(''),
    });
    expect(read(file)).toEqual([
      { line: 1, cells: ['Code', 'Name', 'A & B <1>'] },
      { line: 2, cells: ['X1', 'TRUE', '0.0015', 'X1!'] },
    ]);
  });

  it('keeps sparse cells in their columns and the worksheet row numbers', () => {
    const file = workbook({
      sheetData: [
        row(1, text('A1', 'a'), text('C1', 'c')),
        '<row r="2"/>',
        row(5, text('B5', 'x')),
      ].join(''),
    });
    expect(read(file)).toEqual([
      { line: 1, cells: ['a', '', 'c'] },
      { line: 2, cells: [] },
      { line: 5, cells: ['', 'x'] },
    ]);
  });

  it('turns date-formatted numbers into ISO dates in the 1900 and 1904 systems', () => {
    const cells = (date1904: boolean) =>
      cellsOf(
        workbook({
          styles: DATE_STYLES,
          date1904,
          sheetData: row(
            1,
            '<c r="A1" s="1"><v>46082</v></c>',
            '<c r="B1" s="2"><v>46082</v></c>',
            '<c r="C1"><v>46082</v></c>',
            '<c r="D1" t="d"><v>2026-03-01T00:00:00</v></c>',
          ),
        }),
      )[0];
    expect(cells(false)).toEqual(['2026-03-01', '2026-03-01', '46082', '2026-03-01']);
    // The same serial is four years and a day later in the 1904 system.
    expect(cells(true)).toEqual(['2030-03-02', '2030-03-02', '46082', '2026-03-01']);
    expect(excelSerialToIso(61, false)).toBe('1900-03-01');
    expect(excelSerialToIso(60, false)).toBeNull(); // Excel's phantom 1900-02-29
    expect(excelSerialToIso(1, false)).toBe('1900-01-01');
  });

  it('never evaluates formulas: the cached value is read and a missing one is empty', () => {
    const file = workbook({
      sheetData: row(
        1,
        '<c r="A1" t="str"><f>HYPERLINK("http://evil")</f><v>cached</v></c>',
        '<c r="B1"><f>1+1</f></c>',
        '<c r="C1"><f>2+2</f><v>4</v></c>',
      ),
    });
    expect(cellsOf(file)).toEqual([['cached', '', '4']]);
  });

  it('keeps text that starts with a formula trigger as plain text', () => {
    const file = workbook({
      sheetData: row(1, text('A1', '=cmd|&apos; /C calc&apos;!A1'), text('B1', '@SUM(1)')),
    });
    expect(cellsOf(file)).toEqual([["=cmd|' /C calc'!A1", '@SUM(1)']]);
  });

  it('decodes character references and OOXML control escapes, and drops NUL', () => {
    const file = workbook({
      sheetData: row(1, text('A1', 'a&#233;b&#x41;_x0009_c_x0000_d')),
    });
    expect(cellsOf(file)).toEqual([['aébA\tcd']]);
  });
});

describe('refusing hostile or unsupported workbooks', () => {
  const good = (extra: Parameters<typeof workbook>[0] = { sheetData: row(1, text('A1', 'x')) }) =>
    workbook(extra);

  it('refuses files that are not a workbook', () => {
    expect(code(() => read(Buffer.from('plain text')))).toBe('NOT_XLSX');
    expect(code(() => read(buildZip([{ name: 'word/document.xml', data: '<w/>' }])))).toBe(
      'NOT_XLSX',
    );
  });

  it('refuses macro-enabled and binary workbooks', () => {
    const macro = good({
      sheetData: row(1, text('A1', 'x')),
      extraParts: [{ name: 'xl/vbaProject.bin', data: 'MACROS' }],
    });
    expect(code(() => read(macro))).toBe('MACRO_ENABLED');
    const typed = good({
      sheetData: row(1, text('A1', 'x')),
      contentTypes:
        '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
    });
    expect(code(() => read(typed))).toBe('MACRO_ENABLED');
  });

  it('refuses a DTD or an undefined entity (no entity expansion)', () => {
    const doctype = good({
      sheetData: '',
      sheetXml:
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&a;</t></is></c></row></sheetData></worksheet>',
    });
    expect(code(() => read(doctype))).toBe('MALFORMED_XLSX');
    const undefinedEntity = good({
      sheetData: row(1, text('A1', 'a &custom; b')),
    });
    expect(code(() => read(undefinedEntity))).toBe('MALFORMED_XLSX');
  });

  it('refuses encrypted parts, ZIP64 markers and duplicate or excessive parts', () => {
    const encrypted = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>', flags: 1 },
      { name: 'xl/workbook.xml', data: '<workbook/>' },
    ]);
    expect(code(() => read(encrypted))).toBe('ENCRYPTED');
    const zip64 = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>', declaredSize: 0xffffffff },
      { name: 'xl/workbook.xml', data: '<workbook/>' },
    ]);
    expect(code(() => read(zip64))).toBe('ZIP_LIMIT');
    const duplicate = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: '<workbook/>' },
      { name: 'XL/WORKBOOK.XML', data: '<workbook/>' },
    ]);
    expect(code(() => read(duplicate))).toBe('MALFORMED_XLSX');
    const many = buildZip(
      Array.from({ length: DEFAULT_XLSX_LIMITS.maxEntries + 1 }, (_, i) => ({
        name: `p${i}.xml`,
        data: '<a/>',
      })),
    );
    expect(code(() => read(many))).toBe('ZIP_LIMIT');
  });

  it('refuses a zip bomb before inflating it', () => {
    // 5 MB of zeros deflates to a few KB: far beyond the allowed ratio.
    const bomb = good({
      sheetData: row(1, text('A1', 'x')),
      extraParts: [{ name: 'xl/media/bomb.bin', data: Buffer.alloc(5 * 1024 * 1024) }],
    });
    expect(code(() => read(bomb))).toBe('ZIP_LIMIT');
    expect(code(() => read(bomb, { ...DEFAULT_XLSX_LIMITS, maxRatio: 1_000_000 }))).toBeNull();
    const big = good({
      sheetData: row(1, text('A1', 'x')),
      extraParts: [{ name: 'xl/media/big.bin', data: Buffer.alloc(2 * 1024 * 1024, 7) }],
    });
    expect(code(() => read(big, { ...DEFAULT_XLSX_LIMITS, maxEntryBytes: 1024 * 1024 }))).toBe(
      'ZIP_LIMIT',
    );
    expect(code(() => read(big, { ...DEFAULT_XLSX_LIMITS, maxTotalBytes: 1024 * 1024 }))).toBe(
      'ZIP_LIMIT',
    );
  });

  it('caps inflation at the declared size and checks the CRC', () => {
    // The sheet claims to be tiny but inflates to more: refused while inflating.
    const lying = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: '<workbook/>'.padEnd(5000, ' '), declaredSize: 20 },
    ]);
    expect(code(() => read(lying))).toBe('MALFORMED_XLSX');
    const badCrc = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>', crc: 12345 },
      { name: 'xl/workbook.xml', data: '<workbook/>' },
    ]);
    expect(code(() => read(badCrc))).toBe('MALFORMED_XLSX');
  });

  it('refuses rows with too many columns or too many characters', () => {
    const wide = good({ sheetData: row(1, text('A1', 'a'), text('GR1', 'far')) });
    expect(code(() => read(wide, { ...DEFAULT_XLSX_LIMITS, maxColumns: 100 }))).toBe(
      'TOO_MANY_COLUMNS',
    );
    const long = good({ sheetData: row(1, text('A1', 'x'.repeat(50))) });
    expect(code(() => read(long, { ...DEFAULT_XLSX_LIMITS, maxRecordChars: 10 }))).toBe(
      'LINE_TOO_LONG',
    );
  });

  it('refuses a missing sheet, a missing string and out-of-order rows', () => {
    expect(
      code(() =>
        read(
          good({
            sheetData: '',
            workbookXml: '<workbook><sheets/></workbook>',
          }),
        ),
      ),
    ).toBe('MALFORMED_XLSX');
    expect(code(() => read(good({ sheetData: row(1, '<c r="A1" t="s"><v>9</v></c>') })))).toBe(
      'MALFORMED_XLSX',
    );
    expect(
      code(() => read(good({ sheetData: row(2, text('A2', 'a')) + row(1, text('A1', 'b')) }))),
    ).toBe('MALFORMED_XLSX');
  });
});

describe('writing workbooks', () => {
  it('round-trips headers, text, numbers and dates through the reader', () => {
    const writer = new XlsxWriter(1_000_000);
    writer.addRow(['code', 'name', 'amount', 'date']);
    writer.addRow(['A1', 'Café & <Bar> "x"', { number: '-100.50' }, { date: '2026-03-01' }]);
    writer.addRow(['A2', null, { number: null }, { date: 'not a date' }]);
    expect(cellsOf(writer.finish())).toEqual([
      ['code', 'name', 'amount', 'date'],
      ['A1', 'Café & <Bar> "x"', '-100.50', '2026-03-01'],
      ['A2', '', '', 'not a date'],
    ]);
    expect(writer.rowCount).toBe(3);
  });

  it('neutralizes formulas and never writes one', () => {
    const writer = new XlsxWriter(1_000_000);
    writer.addRow(['text']);
    writer.addRow(['=1+1']);
    writer.addRow(['+SUM(A1)']);
    writer.addRow(['@cmd']);
    writer.addRow(['-5 apples']);
    writer.addRow([{ number: '=1+1' }]);
    const file = writer.finish();
    const values = cellsOf(file).map((r) => r[0]);
    expect(values).toEqual(['text', "'=1+1", "'+SUM(A1)", "'@cmd", "'-5 apples", "'=1+1"]);
    // No part of the package contains a formula element.
    expect(file.toString('latin1')).not.toContain('<f>');
  });

  it('strips characters that XML cannot carry and caps the cell length', () => {
    const writer = new XlsxWriter(1_000_000);
    writer.addRow(['h']);
    writer.addRow([`a\u0001b\u0000c${'x'.repeat(40_000)}`]);
    const value = cellsOf(writer.finish())[1]![0]!;
    expect(value.startsWith('abcx')).toBe(true);
    expect(value).toHaveLength(32_767);
  });

  it('refuses to grow beyond its size cap', () => {
    const writer = new XlsxWriter(200);
    writer.addRow(['a']);
    expect(() => {
      for (let i = 0; i < 50; i++) writer.addRow(['some longer text value']);
    }).toThrow(XlsxTooLargeError);
  });

  it('produces the same bytes for the same rows', () => {
    const make = () => {
      const w = new XlsxWriter(1_000_000);
      w.addRow(['a', 'b']);
      w.addRow(['1', { number: '2' }]);
      return w.finish();
    };
    expect(make().equals(make())).toBe(true);
  });
});
