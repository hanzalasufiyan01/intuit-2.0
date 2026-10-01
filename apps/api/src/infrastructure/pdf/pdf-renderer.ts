import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

/**
 * Provider abstraction for rendering Sales document PDFs (Decision 43: the library sits behind
 * this interface). A renderer receives only the document's frozen render snapshot (Decision 21)
 * plus the resources the snapshot references (the logo), and is deterministic: the same input
 * yields the same bytes.
 */
export interface PdfRenderer {
  readonly name: string;
  render(snapshot: Record<string, unknown>, resources?: PdfResources): Promise<Buffer>;
}

export interface PdfResources {
  /** The seller's logo (PNG or JPEG), when the snapshot references one. */
  logo?: Buffer | undefined;
}

/** Bundled fonts (SIL OFL, see assets/fonts/OFL.txt): Latin and Thaana for Dhivehi (Decision 50). */
const FONT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../assets/fonts',
);
const FONTS = {
  regular: path.join(FONT_DIR, 'NotoSans-Regular.ttf'),
  bold: path.join(FONT_DIR, 'NotoSans-Bold.ttf'),
  thaana: path.join(FONT_DIR, 'NotoSansThaana-Regular.ttf'),
  thaanaBold: path.join(FONT_DIR, 'NotoSansThaana-Bold.ttf'),
};

/**
 * PDFKit renderer (Phase 3B D14, approved 2026-10-01). Fonts are embedded and subset; Thaana text
 * is shaped right-to-left by fontkit, and a line mixing scripts is laid out with a right-to-left
 * base direction, run by run. The document date is fixed so output is reproducible.
 */
export class PdfkitRenderer implements PdfRenderer {
  readonly name = 'pdfkit';

  render(snapshot: Record<string, unknown>, resources: PdfResources = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const s = snapshot as unknown as Snapshot;
      const doc = new PDFDocument({
        size: 'A4',
        // The layout keeps its own margins; PDFKit's stays small so it never paginates by itself.
        margin: 10,
        autoFirstPage: true,
        bufferPages: true,
        info: {
          Title: `${s.documentType === 'invoice' ? 'Invoice' : 'Credit note'} ${s.number}`,
          Producer: 'Intuit 2.0',
          Creator: 'Intuit 2.0',
          CreationDate: FIXED_DATE,
          ModDate: FIXED_DATE,
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      try {
        doc.registerFont('regular', FONTS.regular);
        doc.registerFont('bold', FONTS.bold);
        doc.registerFont('thaana', FONTS.thaana);
        doc.registerFont('thaanaBold', FONTS.thaanaBold);
        draw(doc, s, resources);
        doc.end();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Snapshot shape (written by application/sales-documents.ts renderSnapshot)
// ---------------------------------------------------------------------------

interface Address {
  line1: string;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
}

interface Snapshot {
  documentType: 'invoice' | 'credit_note';
  number: string;
  invoiceDate?: string;
  dueDate?: string;
  creditDate?: string;
  creditedInvoiceNumber?: string | null;
  currencyCode: string;
  taxTreatment: string;
  reference: string | null;
  memo: string;
  seller: {
    legalName: string;
    tradingName: string | null;
    tin: string | null;
    gstRegistrationNumber: string | null;
    email: string | null;
    phone: string | null;
    address: Address | null;
  } | null;
  customer: {
    displayName: string;
    companyName: string | null;
    tin: string | null;
    email: string | null;
    billingAddress: Address | null;
  } | null;
  lines: {
    description: string;
    quantity: string;
    unitPrice: string;
    taxCode: string | null;
    taxRate: string | null;
    taxAmount: string;
    total: string;
  }[];
  totals: { subtotal: string; discountTotal: string; taxTotal: string; total: string };
}

// ---------------------------------------------------------------------------
// Bidirectional text: Thaana (U+0780–U+07BF) runs are right-to-left
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date('2000-01-01T00:00:00Z');
const MARGIN = 50;
const THAANA = /[ހ-޿]/;

interface Run {
  text: string;
  rtl: boolean;
}

/** Splits text into script runs; neutral characters join the run before them. */
function runs(text: string): Run[] {
  const out: Run[] = [];
  for (const ch of text) {
    const rtl = THAANA.test(ch);
    const neutral = /[\s.,:;()\-/]/.test(ch);
    const last = out[out.length - 1];
    if (last && (last.rtl === rtl || neutral)) last.text += ch;
    else out.push({ text: ch, rtl });
  }
  return out;
}

function fontFor(run: Run, bold: boolean) {
  return run.rtl ? (bold ? 'thaanaBold' : 'thaana') : bold ? 'bold' : 'regular';
}

function measure(doc: PDFDocument, text: string, size: number, bold: boolean): number {
  doc.fontSize(size);
  return runs(text).reduce((sum, run) => {
    doc.font(fontFor(run, bold));
    return sum + doc.widthOfString(run.text);
  }, 0);
}

/**
 * Draws one line of text at (x, y); `align: 'right'` ends it at x. A line containing Thaana has a
 * right-to-left base direction, so its runs are placed from the right.
 */
function line(
  doc: PDFDocument,
  text: string,
  x: number,
  y: number,
  options: { size?: number; bold?: boolean; align?: 'left' | 'right' } = {},
) {
  const size = options.size ?? 9;
  const bold = options.bold ?? false;
  const parts = runs(text);
  const rtlBase = parts.some((p) => p.rtl);
  const ordered = rtlBase ? [...parts].reverse() : parts;
  const total = measure(doc, text, size, bold);
  let cursor = options.align === 'right' ? x - total : x;
  doc.fontSize(size);
  for (const run of ordered) {
    const content = rtlBase && !run.rtl ? run.text.trim() : run.text;
    doc.font(fontFor(run, bold));
    doc.text(content, cursor, y, { lineBreak: false });
    cursor += doc.widthOfString(content) + (rtlBase && !run.rtl ? doc.widthOfString(' ') : 0);
  }
}

function wrap(doc: PDFDocument, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || measure(doc, candidate, size, false) <= width) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function money(value: string, currency: string): string {
  const negative = value.trim().startsWith('-');
  const digits =
    currency === 'JPY' ? 0 : currency === 'KWD' || currency === 'BHD' || currency === 'OMR' ? 3 : 2;
  const [whole, fraction = ''] = Math.abs(Number(value)).toFixed(digits).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${fraction ? `${grouped}.${fraction}` : grouped}`;
}

function addressLines(a: Address | null): string[] {
  if (!a) return [];
  return [
    a.line1,
    a.line2,
    [a.city, a.region, a.postalCode].filter(Boolean).join(' '),
    a.countryCode,
  ].filter((l): l is string => Boolean(l));
}

function draw(doc: PDFDocument, s: Snapshot, resources: PdfResources) {
  const width = doc.page.width;
  const bottom = doc.page.height - MARGIN;
  const right = width - MARGIN;
  let y = MARGIN;
  const need = (height: number, onNewPage?: () => void) => {
    if (y + height > bottom) {
      doc.addPage();
      y = MARGIN;
      onNewPage?.();
    }
  };

  // Header: logo or seller name, and the document title.
  let headerHeight = 18;
  if (resources.logo) {
    try {
      doc.image(resources.logo, MARGIN, y, { fit: [140, 48] });
      headerHeight = 52;
    } catch {
      line(doc, s.seller?.tradingName ?? s.seller?.legalName ?? '', MARGIN, y, {
        size: 14,
        bold: true,
      });
    }
  } else {
    line(doc, s.seller?.tradingName ?? s.seller?.legalName ?? '', MARGIN, y, {
      size: 14,
      bold: true,
    });
  }
  line(doc, s.documentType === 'invoice' ? 'TAX INVOICE' : 'CREDIT NOTE', right, y, {
    size: 16,
    bold: true,
    align: 'right',
  });
  y += headerHeight + 6;

  const sellerLines = [
    resources.logo || s.seller?.tradingName ? s.seller?.legalName : null,
    ...addressLines(s.seller?.address ?? null),
    s.seller?.tin ? `TIN ${s.seller.tin}` : null,
    s.seller?.gstRegistrationNumber ? `GST ${s.seller.gstRegistrationNumber}` : null,
    s.seller?.email,
    s.seller?.phone,
  ].filter((l): l is string => Boolean(l));
  const meta: [string, string][] = [
    ['Number', s.number],
    ...(s.invoiceDate ? [['Date', s.invoiceDate] as [string, string]] : []),
    ...(s.dueDate ? [['Due', s.dueDate] as [string, string]] : []),
    ...(s.creditDate ? [['Date', s.creditDate] as [string, string]] : []),
    ...(s.creditedInvoiceNumber ? [['Invoice', s.creditedInvoiceNumber] as [string, string]] : []),
    ...(s.reference ? [['Reference', s.reference] as [string, string]] : []),
    ['Currency', s.currencyCode],
  ];
  for (let i = 0; i < Math.max(sellerLines.length, meta.length); i += 1) {
    if (sellerLines[i]) line(doc, sellerLines[i]!, MARGIN, y);
    if (meta[i]) {
      line(doc, meta[i]![0], right - 110, y, { bold: true, align: 'right' });
      line(doc, meta[i]![1], right, y, { align: 'right' });
    }
    y += 13;
  }
  y += 10;
  line(doc, 'Bill to', MARGIN, y, { bold: true });
  y += 13;
  for (const text of [
    s.customer?.displayName,
    s.customer?.companyName && s.customer.companyName !== s.customer.displayName
      ? s.customer.companyName
      : null,
    ...addressLines(s.customer?.billingAddress ?? null),
    s.customer?.tin ? `TIN ${s.customer.tin}` : null,
  ].filter((l): l is string => Boolean(l))) {
    line(doc, text, MARGIN, y);
    y += 13;
  }
  y += 14;

  // Lines table.
  const col = { description: MARGIN, quantity: 330, price: 400, tax: 460, total: right };
  const header = () => {
    line(doc, 'Description', col.description, y, { bold: true });
    line(doc, 'Qty', col.quantity, y, { bold: true, align: 'right' });
    line(doc, 'Unit price', col.price, y, { bold: true, align: 'right' });
    line(doc, 'Tax', col.tax, y, { bold: true, align: 'right' });
    line(doc, 'Amount', col.total, y, { bold: true, align: 'right' });
    y += 14;
    doc
      .lineWidth(0.5)
      .strokeColor('#999999')
      .moveTo(MARGIN, y - 2)
      .lineTo(right, y - 2)
      .stroke();
    y += 2;
  };
  header();
  for (const item of s.lines) {
    const described = wrap(doc, item.description, 9, col.quantity - col.description - 40);
    need(13 * described.length + 3, header);
    line(doc, item.quantity, col.quantity, y, { align: 'right' });
    line(doc, money(item.unitPrice, s.currencyCode), col.price, y, { align: 'right' });
    line(
      doc,
      item.taxCode ? `${item.taxCode} ${item.taxRate ? Number(item.taxRate) : ''}%` : '-',
      col.tax,
      y,
      {
        align: 'right',
      },
    );
    line(doc, money(item.total, s.currencyCode), col.total, y, { align: 'right' });
    for (const text of described) {
      line(doc, text, col.description, y);
      y += 13;
    }
    y += 3;
  }

  // Totals.
  need(80);
  y += 6;
  const totals: [string, string, boolean][] = [
    ['Subtotal', s.totals.subtotal, false],
    ...(Number(s.totals.discountTotal)
      ? [['Discount', `-${s.totals.discountTotal}`, false] as [string, string, boolean]]
      : []),
    [s.taxTreatment === 'inclusive' ? 'Tax included' : 'Tax', s.totals.taxTotal, false],
    [`Total ${s.currencyCode}`, s.totals.total, true],
  ];
  for (const [label, value, bold] of totals) {
    line(doc, label, col.tax, y, { size: 10, bold, align: 'right' });
    line(doc, money(value, s.currencyCode), col.total, y, { size: 10, bold, align: 'right' });
    y += 15;
  }
  if (s.memo) {
    y += 10;
    for (const text of wrap(doc, s.memo, 9, right - MARGIN)) {
      need(13);
      line(doc, text, MARGIN, y);
      y += 13;
    }
  }

  // Page numbers.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    line(doc, `Page ${i + 1} of ${range.count}`, right, doc.page.height - MARGIN + 18, {
      size: 8,
      align: 'right',
    });
  }
}
