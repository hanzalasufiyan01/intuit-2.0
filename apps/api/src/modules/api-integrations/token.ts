import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * The opaque API credential `itk_<public id>_<secret>` (ADR 0011 section 2): an 8-character
 * public id (looked up before any tenant context exists) and a 256-bit secret. Only the SHA-256
 * of the secret is ever stored; the secret is a high-entropy random value, so a fast hash is
 * appropriate and lookups need no slow password hashing.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PREFIX = 'itk_';
const TOKEN_PATTERN = /^itk_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedToken {
  /** The full credential. Shown once at creation and never stored. */
  token: string;
  publicId: string;
  secretHash: Buffer;
}

export function hashTokenSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function generateToken(): GeneratedToken {
  let publicId = '';
  for (let i = 0; i < 8; i += 1) publicId += ALPHABET[randomInt(ALPHABET.length)];
  const secret = randomBytes(32).toString('base64url');
  return { token: `${PREFIX}${publicId}_${secret}`, publicId, secretHash: hashTokenSecret(secret) };
}

/** Splits a credential; null when it is not shaped like one (no hint is given why). */
export function parseToken(
  value: string | undefined | null,
): { publicId: string; secret: string } | null {
  const match = TOKEN_PATTERN.exec((value ?? '').trim());
  return match ? { publicId: match[1]!, secret: match[2]! } : null;
}

/** Constant-time comparison of a presented secret with the stored hash. */
export function secretMatches(secret: string, storedHash: Buffer): boolean {
  const presented = hashTokenSecret(secret);
  return presented.length === storedHash.length && timingSafeEqual(presented, storedHash);
}

/** A credential never appears in full anywhere but its one-time creation response. */
export const tokenDisplayPrefix = (publicId: string) => `${PREFIX}${publicId}`;
