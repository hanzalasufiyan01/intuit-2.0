import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) on node:crypto (Decision 75, S7-11): HMAC-SHA-1, 6 digits, 30-second step.
 * The verification window is ±1 step at most (Decision 76); replay protection is the caller's
 * job (the matched step must be later than the factor's last used step, S7-16).
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** 160-bit secrets, the RFC 4226 recommendation. */
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, upper case, without padding (the form authenticator apps expect). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Decodes base32 (case-insensitive; spaces, hyphens and padding ignored). Throws on bad input. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 input');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** The RFC 6238 time step for an instant. */
export function totpStep(now: Date, periodSeconds = TOTP_PERIOD_SECONDS): number {
  return Math.floor(now.getTime() / 1000 / periodSeconds);
}

/** HOTP (RFC 4226) with dynamic truncation, zero-padded to `digits`. */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secret: Uint8Array, step: number, digits = TOTP_DIGITS): string {
  return hotp(secret, step, digits);
}

/** A well-formed code: exactly six digits (whitespace already stripped by the caller). */
export function normalizeTotpInput(input: string): string | null {
  const code = input.replace(/\s/g, '');
  return /^\d{6}$/.test(code) ? code : null;
}

/**
 * Checks a code against the steps around `now`. Only steps later than `lastUsedStep` qualify,
 * so a code (or an earlier code in the window) can never be accepted twice. Every candidate is
 * compared in constant time. Returns the matched step, or null.
 */
export function verifyTotp(input: {
  secret: Uint8Array;
  code: string;
  now: Date;
  window: number;
  lastUsedStep: number | null;
}): number | null {
  const code = normalizeTotpInput(input.code);
  if (!code) return null;
  const current = totpStep(input.now);
  const given = Buffer.from(code, 'utf8');
  let matched: number | null = null;
  for (let step = current - input.window; step <= current + input.window; step += 1) {
    const candidate = Buffer.from(totpCode(input.secret, step), 'utf8');
    const equal = timingSafeEqual(candidate, given);
    if (equal && matched === null && (input.lastUsedStep === null || step > input.lastUsedStep)) {
      matched = step;
    }
  }
  return matched;
}

/** Key URI for authenticator apps (Google Authenticator key-uri format). */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  // Percent-encoding (not "+") for spaces: several authenticator apps misread "+".
  const query = [
    `secret=${input.secret}`,
    `issuer=${encodeURIComponent(input.issuer)}`,
    'algorithm=SHA1',
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_PERIOD_SECONDS}`,
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}
