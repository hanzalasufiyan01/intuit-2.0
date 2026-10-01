/**
 * Minimal typings for the parts of PDFKit 0.20 used by the Sales PDF renderer (the package ships
 * no TypeScript declarations; Phase 3B D14 approved PDFKit without additional dependencies).
 */
declare module 'pdfkit' {
  interface PdfKitOptions {
    size?: string | [number, number];
    margin?: number;
    autoFirstPage?: boolean;
    bufferPages?: boolean;
    compress?: boolean;
    info?: Record<string, string | Date>;
    lang?: string;
    displayTitle?: boolean;
  }

  interface TextOptions {
    width?: number;
    align?: 'left' | 'right' | 'center' | 'justify';
    lineBreak?: boolean;
    features?: string[];
  }

  class PDFDocument {
    constructor(options?: PdfKitOptions);
    readonly page: { width: number; height: number };
    registerFont(name: string, source: string | Buffer): this;
    font(name: string): this;
    fontSize(size: number): this;
    fillColor(color: string): this;
    strokeColor(color: string): this;
    lineWidth(width: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(): this;
    text(text: string, x: number, y: number, options?: TextOptions): this;
    widthOfString(text: string, options?: TextOptions): number;
    image(source: Buffer, x: number, y: number, options?: { fit?: [number, number] }): this;
    addPage(): this;
    bufferedPageRange(): { start: number; count: number };
    switchToPage(index: number): this;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    end(): void;
  }

  export default PDFDocument;
}
