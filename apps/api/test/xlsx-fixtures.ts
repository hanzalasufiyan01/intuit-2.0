import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Hand-built workbooks for the XLSX tests: a ZIP writer that can also lie (wrong sizes or CRC,
 * encryption flag, ZIP64 sentinels) and a minimal SpreadsheetML workbook builder.
 */

export interface ZipPart {
  name: string;
  data: string | Buffer;
  /** 0 = stored, 8 = deflated (default). */
  method?: 0 | 8;
  /** Overrides for the central directory (to simulate hostile archives). */
  declaredSize?: number;
  declaredCompressed?: number;
  crc?: number;
  flags?: number;
}

export function buildZip(parts: readonly ZipPart[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const data = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8');
    const method = part.method ?? 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(part.name, 'utf8');
    const crc = part.crc ?? crc32(data);
    const size = part.declaredSize ?? data.length;
    const compressed = part.declaredCompressed ?? packed.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(part.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(part.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/></Types>';

export interface WorkbookOptions {
  /** The XML between <sheetData> tags. */
  sheetData: string;
  sharedStrings?: readonly string[];
  /** A full styles.xml, or undefined for none. */
  styles?: string;
  date1904?: boolean;
  contentTypes?: string;
  extraParts?: readonly ZipPart[];
  /** Replaces the whole sheet part (for DTD / entity attacks). */
  sheetXml?: string;
  workbookXml?: string;
}

/** A styles part whose cell format 1 is the built-in date format 14 and 2 a custom yyyy-mm-dd. */
export const DATE_STYLES =
  `<styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>` +
  '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>';

export function workbook(options: WorkbookOptions): Buffer {
  const sheet =
    options.sheetXml ??
    `<?xml version="1.0"?><worksheet xmlns="${NS}"><sheetData>${options.sheetData}</sheetData></worksheet>`;
  const parts: ZipPart[] = [
    { name: '[Content_Types].xml', data: options.contentTypes ?? CONTENT_TYPES },
    {
      name: 'xl/workbook.xml',
      data:
        options.workbookXml ??
        `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${REL}">` +
          (options.date1904 ? '<workbookPr date1904="1"/>' : '') +
          '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    {
      name: 'xl/worksheets/sheet2.xml',
      data: `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SECOND SHEET</t></is></c></row></sheetData></worksheet>`,
    },
    ...(options.sharedStrings
      ? [
          {
            name: 'xl/sharedStrings.xml',
            data: `<sst xmlns="${NS}">${options.sharedStrings.map((s) => `<si>${s}</si>`).join('')}</sst>`,
          },
        ]
      : []),
    ...(options.styles ? [{ name: 'xl/styles.xml', data: options.styles }] : []),
    ...(options.extraParts ?? []),
  ];
  return buildZip(parts);
}

/** `<row>` helper: cells given as raw `<c>` XML in order of the columns A, B, ... */
export const row = (r: number, ...cells: string[]) => `<row r="${r}">${cells.join('')}</row>`;
export const text = (ref: string, value: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
