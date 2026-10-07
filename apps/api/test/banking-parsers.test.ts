import { describe, expect, it } from 'vitest';
import {
  csvHeader,
  csvProvider,
  ofxProvider,
  withFingerprints,
  type CsvMapping,
} from '../src/modules/banking/index.js';

/** Statement providers: CSV with a column mapping, OFX 1.x and 2.x, and duplicate fingerprints. */

const mapping: CsvMapping = {
  dateColumn: 'Date',
  descriptionColumn: 'Description',
  amountColumn: 'Amount',
  dateFormat: 'YYYY-MM-DD',
  decimalSeparator: '.',
  delimiter: 'auto',
};

describe('CSV statements', () => {
  it('reads the header and a sample for the mapping screen', async () => {
    const header = await csvHeader('Date;Description;Amount\n2026-03-01;Rent;-10\n');
    expect(header).toMatchObject({ delimiter: ';', columns: ['Date', 'Description', 'Amount'] });
    expect(header.sample).toEqual([['2026-03-01', 'Rent', '-10']]);
  });

  it('keeps the sign of one amount column and strips a byte-order mark', async () => {
    const parsed = await csvProvider.parse(
      '\uFEFFDate,Description,Amount\n2026-03-01,Salary,1500.50\n2026-03-02,"Rent, March",-800\n',
      mapping,
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.transactions.map((t) => [t.date, t.description, t.amount])).toEqual([
      ['2026-03-01', 'Salary', '1500.5'],
      ['2026-03-02', 'Rent, March', '-800'],
    ]);
  });

  it('combines debit and credit columns and honours a decimal comma', async () => {
    const parsed = await csvProvider.parse(
      'Datum;Text;Soll;Haben\n10/03/2026;Miete;1.250,00;\n12/03/2026;Erstattung;;75,5\n',
      {
        dateColumn: 'Datum',
        descriptionColumn: 'Text',
        debitColumn: 'Soll',
        creditColumn: 'Haben',
        dateFormat: 'DD/MM/YYYY',
        decimalSeparator: ',',
        delimiter: ';',
      },
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.transactions.map((t) => [t.date, t.amount])).toEqual([
      ['2026-03-10', '-1250'],
      ['2026-03-12', '75.5'],
    ]);
  });

  it('reports every unreadable row with its line and never throws', async () => {
    const parsed = await csvProvider.parse(
      'Date,Description,Amount\n2026-03-01,Good,10\nnope,Bad date,5\n2026-03-03,,5\n2026-03-04,Zero,0\n2026-03-05,Text amount,abc\n',
      mapping,
    );
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.problems.map((p) => [p.rowNumber, p.field])).toEqual([
      [3, 'date'],
      [4, 'description'],
      [5, 'amount'],
      [6, 'amount'],
    ]);
  });

  it('refuses a mapping that names a missing column', async () => {
    const parsed = await csvProvider.parse('Date,Description,Amount\n2026-03-01,x,1\n', {
      ...mapping,
      amountColumn: 'Nope',
    });
    expect(parsed.transactions).toEqual([]);
    expect(parsed.problems[0]).toMatchObject({ field: 'amountColumn' });
  });

  it('keeps a formula-looking description as plain text (exports neutralize it)', async () => {
    const parsed = await csvProvider.parse(
      'Date,Description,Amount\n2026-03-01,"=HYPERLINK(""http://x"")",5\n',
      mapping,
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.transactions[0]!.description).toBe('=HYPERLINK("http://x")');
  });
});

const sgml = (body: string, header = 'OFXHEADER:100\nDATA:OFXSGML\n\n') =>
  `${header}<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>MVR\n<BANKTRANLIST>\n${body}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe('OFX statements', () => {
  it('reads OFX 1.x SGML (no closing tags)', async () => {
    const parsed = await ofxProvider.parse(
      sgml(
        '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260312120000<TRNAMT>-20.00<FITID>A1<NAME>Shop<MEMO>Groceries\n</STMTTRN>\n<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260313<TRNAMT>150.25<FITID>A2<NAME>Client\n</STMTTRN>\n',
      ),
      {},
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.currency).toBe('MVR');
    expect(parsed.transactions.map((t) => [t.date, t.amount, t.externalId, t.description])).toEqual(
      [
        ['2026-03-12', '-20', 'A1', 'Shop — Groceries'],
        ['2026-03-13', '150.25', 'A2', 'Client'],
      ],
    );
  });

  it('reads OFX 2.x XML with entities', async () => {
    const parsed = await ofxProvider.parse(
      `<?xml version="1.0"?><OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF><BANKTRANLIST><STMTTRN><DTPOSTED>20260301</DTPOSTED><TRNAMT>-5.5</TRNAMT><FITID>X</FITID><NAME>Fish &amp; Chips</NAME></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
      {},
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.transactions[0]).toMatchObject({ description: 'Fish & Chips', amount: '-5.5' });
  });

  it('refuses entity declarations, other files and an empty statement', async () => {
    expect(
      (await ofxProvider.parse('<!DOCTYPE x [<!ENTITY a "b">]><OFX></OFX>', {})).problems,
    ).toHaveLength(1);
    expect((await ofxProvider.parse('Date,Amount\n', {})).problems[0]!.message).toMatch(
      /not an OFX/,
    );
    expect((await ofxProvider.parse(sgml(''), {})).problems[0]!.message).toMatch(/no transactions/);
  });

  it('reports a transaction with a bad date or amount and keeps reading', async () => {
    const parsed = await ofxProvider.parse(
      sgml(
        '<STMTTRN><DTPOSTED>x<TRNAMT>1\n</STMTTRN>\n<STMTTRN><DTPOSTED>20260301<TRNAMT>abc\n</STMTTRN>\n<STMTTRN><DTPOSTED>20260301<TRNAMT>3<FITID>ok\n</STMTTRN>\n',
      ),
      {},
    );
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.problems.map((p) => p.field)).toEqual(['date', 'amount']);
  });
});

describe('fingerprints', () => {
  const t = (date: string, amount: string, description: string) => ({
    date,
    description,
    reference: null,
    amount,
    balance: null,
    externalId: null,
    rowNumber: 1,
  });

  it('numbers identical lines in a file so two genuine ones are both kept', () => {
    const [a, b, c] = withFingerprints([
      t('2026-03-01', '-5', 'Coffee'),
      t('2026-03-01', '-5.00', ' coffee '),
      t('2026-03-02', '-5', 'Coffee'),
    ]);
    expect(a!.fingerprint).not.toBe(b!.fingerprint);
    expect(a!.fingerprint).not.toBe(c!.fingerprint);
  });

  it('reproduces the same fingerprints for an overlapping statement', () => {
    const first = withFingerprints([
      t('2026-03-01', '-5', 'Coffee'),
      t('2026-03-01', '-5', 'Coffee'),
    ]);
    const second = withFingerprints([t('2026-03-01', '-5', 'Coffee')]);
    expect(second[0]!.fingerprint).toBe(first[0]!.fingerprint);
  });
});
