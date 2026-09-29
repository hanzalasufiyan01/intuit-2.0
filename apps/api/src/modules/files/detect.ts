import { open } from 'node:fs/promises';

/**
 * File type detection by content (Decision 61; S5-06). Magic bytes are authoritative; the
 * declared extension must agree. No third-party dependency: XLSX is recognised from the ZIP
 * central directory and CSV (which has no signature) by being NUL-free valid UTF-8.
 */

export const detectedTypes = ['pdf', 'png', 'jpeg', 'webp', 'csv', 'xlsx'] as const;
export type DetectedType = (typeof detectedTypes)[number];

export const MIME_TYPES: Record<DetectedType, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const EXTENSIONS: Record<DetectedType, readonly string[]> = {
  pdf: ['pdf'],
  png: ['png'],
  jpeg: ['jpg', 'jpeg'],
  webp: ['webp'],
  csv: ['csv'],
  xlsx: ['xlsx'],
};

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

const startsWith = (head: Buffer, bytes: readonly number[], offset = 0) =>
  head.length >= offset + bytes.length && bytes.every((b, i) => head[offset + i] === b);

/** Binary signatures, from the first bytes of the file. */
export function detectSignature(head: Buffer): DetectedType | 'zip' | null {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp'; // RIFF....WEBP
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return 'zip'; // PK\x03\x04
  return null;
}

/**
 * Names in a ZIP central directory, found through the end-of-central-directory record in the
 * last 64 KiB + 22 bytes. Returns null when the structure is not a well-formed ZIP.
 */
export function zipEntryNames(tail: Buffer, fileSize: number): string[] | null {
  const EOCD = 0x06054b50;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== EOCD) continue;
    const entries = tail.readUInt16LE(i + 10);
    const size = tail.readUInt32LE(i + 12);
    const offset = tail.readUInt32LE(i + 16);
    const tailStart = fileSize - tail.length;
    const start = offset - tailStart;
    if (start < 0 || start + size > tail.length) return null;
    const names: string[] = [];
    let p = start;
    for (let n = 0; n < entries; n += 1) {
      if (p + 46 > tail.length || tail.readUInt32LE(p) !== 0x02014b50) return null;
      const nameLength = tail.readUInt16LE(p + 28);
      const extraLength = tail.readUInt16LE(p + 30);
      const commentLength = tail.readUInt16LE(p + 32);
      names.push(tail.toString('utf8', p + 46, p + 46 + nameLength));
      p += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  }
  return null;
}

const isXlsx = (names: readonly string[]) =>
  names.includes('[Content_Types].xml') && names.includes('xl/workbook.xml');

/** Streams the file checking it is NUL-free, valid UTF-8 (a leading BOM is allowed). */
async function isUtf8Text(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) return false;
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        return false;
      }
    }
    try {
      decoder.decode();
    } catch {
      return false;
    }
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Detects the type of a stored temporary file. Returns null when the content is not an allowed
 * type or disagrees with the declared extension (callers answer 415).
 */
export async function detectFileType(
  filePath: string,
  fileSize: number,
  declaredName: string,
): Promise<DetectedType | null> {
  const extension = extensionOf(declaredName);
  const handle = await open(filePath, 'r');
  let head: Buffer;
  let tail: Buffer;
  try {
    head = Buffer.alloc(Math.min(16, fileSize));
    await handle.read(head, 0, head.length, 0);
    const tailLength = Math.min(fileSize, 64 * 1024 + 22);
    tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, fileSize - tailLength);
  } finally {
    await handle.close();
  }
  let detected: DetectedType | null;
  const signature = detectSignature(head);
  if (signature === 'zip') {
    const names = zipEntryNames(tail, fileSize);
    detected = names && isXlsx(names) ? 'xlsx' : null;
  } else if (signature) {
    detected = signature;
  } else if (extension === 'csv') {
    // CSV has no signature: only accepted when declared as .csv and plain UTF-8 text.
    detected = (await isUtf8Text(filePath)) ? 'csv' : null;
  } else {
    detected = null;
  }
  if (!detected || !EXTENSIONS[detected].includes(extension)) return null;
  return detected;
}
