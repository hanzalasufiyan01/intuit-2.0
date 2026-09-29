import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deriveDownloadKey,
  detectFileType,
  detectSignature,
  LocalStorageProvider,
  sanitizeFileName,
  signDownloadToken,
  storageKeyFor,
  tenantPrefix,
  verifyDownloadToken,
  zipEntryNames,
} from '../src/modules/files/index.js';
import { zip } from './zip.js';

/** Phase 3A S5 unit tests: detection (S5-06), names, tokens (S5-08), storage keys (S5-02/S5-03). */

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'intuit2-files-unit-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function detect(content: Buffer | string, name: string) {
  const file = path.join(dir, `f-${Math.random().toString(36).slice(2)}`);
  const bytes = Buffer.from(content);
  await writeFile(file, bytes);
  return detectFileType(file, bytes.length, name);
}

describe('type detection (S5-06, Decision 61)', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
  const workbook = zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' });

  it('recognises every allowed type by content and extension', async () => {
    expect(await detect(pdf, 'a.pdf')).toBe('pdf');
    expect(await detect(png, 'a.PNG')).toBe('png');
    expect(await detect(jpeg, 'a.jpg')).toBe('jpeg');
    expect(await detect(jpeg, 'a.jpeg')).toBe('jpeg');
    expect(await detect(webp, 'a.webp')).toBe('webp');
    expect(await detect(workbook, 'a.xlsx')).toBe('xlsx');
    expect(await detect('a,b\n1,2\n', 'a.csv')).toBe('csv');
    expect(await detect('\ufeffname,amount\nÄli,1\n', 'bom.csv')).toBe('csv');
  });

  it('rejects spoofed extensions and content outside the allowlist', async () => {
    expect(await detect(pdf, 'a.png')).toBeNull();
    expect(await detect(png, 'a.pdf')).toBeNull();
    expect(await detect(workbook, 'a.zip')).toBeNull();
    expect(await detect(zip({ 'word/document.xml': '<w/>' }), 'a.xlsx')).toBeNull();
    expect(await detect('<svg onload="x()"/>', 'a.svg')).toBeNull();
    expect(await detect('MZ\x90\x00', 'a.exe')).toBeNull();
    expect(await detect('a,b\n1,2\n', 'a.txt')).toBeNull();
    expect(await detect(pdf, 'noextension')).toBeNull();
  });

  it('accepts CSV only as NUL-free valid UTF-8', async () => {
    expect(await detect(Buffer.from([0x61, 0x2c, 0x00, 0x62]), 'a.csv')).toBeNull();
    expect(await detect(Buffer.from([0x61, 0xff, 0xfe, 0x62]), 'a.csv')).toBeNull();
    expect(await detect(Buffer.from([0x61, 0xc3]), 'a.csv')).toBeNull(); // truncated sequence
  });

  it('reads signatures and ZIP directories defensively', () => {
    expect(detectSignature(Buffer.alloc(0))).toBeNull();
    expect(detectSignature(Buffer.from('PK\x03\x04'))).toBe('zip');
    expect(zipEntryNames(Buffer.from('not a zip at all, nothing here'), 30)).toBeNull();
    expect(zipEntryNames(workbook, workbook.length)).toEqual([
      '[Content_Types].xml',
      'xl/workbook.xml',
    ]);
    const truncated = workbook.subarray(0, workbook.length - 10);
    expect(zipEntryNames(truncated, truncated.length)).toBeNull();
  });
});

describe('file name sanitization', () => {
  it('strips paths, control and bidi characters and leading dots', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\a\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('in\u0000voice\u0007.pdf')).toBe('invoice.pdf');
    expect(sanitizeFileName('photo\u202Egnp.exe')).toBe('photognp.exe');
    expect(sanitizeFileName('...hidden.csv')).toBe('hidden.csv');
    expect(sanitizeFileName('  many   spaces .pdf ')).toBe('many spaces .pdf');
    expect(sanitizeFileName('/')).toBe('file');
    expect(sanitizeFileName('Résumé 2026.pdf')).toBe('Résumé 2026.pdf');
  });

  it('caps names at 255 characters and keeps the extension', () => {
    const long = sanitizeFileName(`${'x'.repeat(400)}.xlsx`);
    expect(long).toHaveLength(255);
    expect(long.endsWith('.xlsx')).toBe(true);
  });
});

describe('signed download tokens (S5-08, K-5)', () => {
  const key = deriveDownloadKey('a-session-secret-of-sufficient-length-for-tests');
  const now = new Date('2026-09-28T10:00:00Z');
  const claims = {
    fileId: FILE,
    organizationId: ORG,
    userId: USER,
    expiresAt: now.getTime() + 5 * 60_000,
  };

  it('round-trips claims in the fileId.orgId.userId.exp format', () => {
    const token = signDownloadToken(key, claims);
    const [body] = token.split('.');
    expect(Buffer.from(body!, 'base64url').toString()).toBe(
      `${FILE}.${ORG}.${USER}.${claims.expiresAt}`,
    );
    expect(verifyDownloadToken(key, token, now)).toEqual(claims);
  });

  it('rejects expiry, tampering, other keys and malformed tokens', () => {
    const token = signDownloadToken(key, claims);
    expect(verifyDownloadToken(key, token, new Date(claims.expiresAt))).toBeNull();
    const other = signDownloadToken(key, { ...claims, organizationId: OTHER_ORG });
    const [, otherMac] = other.split('.');
    const [body] = token.split('.');
    expect(verifyDownloadToken(key, `${body}.${otherMac}`, now)).toBeNull();
    const flipped = token.slice(0, -2) + (token.endsWith('A') ? 'B' : 'A') + token.slice(-1);
    expect(verifyDownloadToken(key, flipped, now)).toBeNull();
    expect(
      verifyDownloadToken(deriveDownloadKey('another-secret-value-entirely'), token, now),
    ).toBeNull();
    for (const bad of ['', '.', 'abc', `${token}.x`, `${body}.`]) {
      expect(verifyDownloadToken(key, bad, now)).toBeNull();
    }
    // A correctly signed body with a malformed payload is still refused.
    const junkBody = Buffer.from('not.a.valid.claim').toString('base64url');
    const junkMac = createHmac('sha256', key).update(junkBody).digest('base64url');
    expect(verifyDownloadToken(key, `${junkBody}.${junkMac}`, now)).toBeNull();
  });

  it('derives a key separate from the session secret itself', () => {
    const secret = 'a-session-secret-of-sufficient-length-for-tests';
    expect(deriveDownloadKey(secret).equals(Buffer.from(secret).subarray(0, 32))).toBe(false);
    expect(deriveDownloadKey(secret)).toHaveLength(32);
  });
});

describe('storage keys and the local provider (S5-02, S5-03)', () => {
  it('builds tenant-prefixed keys from server values only', () => {
    expect(storageKeyFor(ORG, FILE, new Date('2026-03-05T00:00:00Z'))).toBe(
      `org/${ORG}/2026/03/${FILE}`,
    );
    expect(tenantPrefix(ORG)).toBe(`org/${ORG}/`);
    expect(() => tenantPrefix('../x')).toThrow();
  });

  it('stores, reads, lists and deletes inside its root and refuses anything else', async () => {
    const storage = new LocalStorageProvider(path.join(dir, 'root'));
    const key = storageKeyFor(ORG, FILE, new Date('2026-03-05T00:00:00Z'));
    await storage.put(key, Readable.from([Buffer.from('hello')]));
    expect(await storage.exists(key)).toBe(true);
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(key)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect((await storage.list(tenantPrefix(ORG))).map((o) => o.key)).toEqual([key]);
    expect(await storage.list(tenantPrefix(OTHER_ORG))).toEqual([]);
    for (const bad of ['../outside', `org/${ORG}/../../x`, '/abs/path', `org/${ORG}/2026/03/x`]) {
      await expect(storage.put(bad, Readable.from([Buffer.from('x')]))).rejects.toThrow();
    }
    await storage.delete(key);
    await storage.delete(key); // idempotent
    expect(await storage.exists(key)).toBe(false);
    await expect(readFile(path.join(dir, 'outside'))).rejects.toThrow();
  });
});
