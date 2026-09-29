import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * File name sanitization and signed download tokens (S5-08).
 */

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidirectional overrides/isolates and marks can disguise extensions ("gnp.exe").
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A safe display name: no path, no control or bidi characters, at most 255 characters. */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let name = base.replace(CONTROL, '').replace(BIDI, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '');
  if (name.length > 255) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, 255 - extension.length) + extension;
  }
  return name || 'file';
}

export interface DownloadClaims {
  fileId: string;
  organizationId: string;
  userId: string;
  /** Expiry, milliseconds since the epoch. */
  expiresAt: number;
}

/** The token key is derived from SESSION_SECRET with a dedicated HKDF label (key separation). */
export function deriveDownloadKey(sessionSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', sessionSecret, Buffer.alloc(0), 'intuit2 file-download v1', 32),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Token format (S5 §12): `base64url(fileId.orgId.userId.exp).base64url(HMAC-SHA256)`. */
export function signDownloadToken(key: Buffer, claims: DownloadClaims): string {
  const body = Buffer.from(
    [claims.fileId, claims.organizationId, claims.userId, String(claims.expiresAt)].join('.'),
  ).toString('base64url');
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** Returns the claims of a valid, unexpired token; null otherwise (constant-time comparison). */
export function verifyDownloadToken(key: Buffer, token: string, now: Date): DownloadClaims | null {
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', key).update(body).digest();
  const presented = Buffer.from(mac, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  const parts = Buffer.from(body, 'base64url').toString('utf8').split('.');
  if (parts.length !== 4) return null;
  const [fileId, organizationId, userId, exp] = parts as [string, string, string, string];
  if (!UUID.test(fileId) || !UUID.test(organizationId) || !UUID.test(userId)) return null;
  if (!/^\d{1,15}$/.test(exp)) return null;
  const expiresAt = Number(exp);
  if (expiresAt <= now.getTime()) return null;
  return { fileId, organizationId, userId, expiresAt };
}

/** Malware scanning hook (Decision 29; S5-07). Mandatory scanning is deferred. */
export type ScanResult = 'not_scanned' | 'clean' | 'infected';

export interface FileScanner {
  scan(filePath: string): Promise<ScanResult>;
}

/** Default scanner: records that no scan ran; the file is available. */
export class NoopScanner implements FileScanner {
  async scan(): Promise<ScanResult> {
    return 'not_scanned';
  }
}
