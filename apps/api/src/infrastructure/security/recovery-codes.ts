import { randomInt } from 'node:crypto';

/**
 * Recovery codes (S7-18): `XXXX-XXXXXX-XXXXXX` in Crockford base32. The first group is a lookup
 * id stored in clear (it selects the single Argon2id hash to check, so an attempt costs one hash
 * verification); the remaining 12 characters (60 bits) are the secret, stored only as Argon2id.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LOOKUP_LENGTH = 4;
const SECRET_LENGTH = 12;

export interface RecoveryCode {
  /** What the user sees once, e.g. `7K2M-QX4T9B-HN3WPA`. */
  display: string;
  lookupId: string;
  secret: string;
}

function randomChars(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function generateRecoveryCode(): RecoveryCode {
  const lookupId = randomChars(LOOKUP_LENGTH);
  const secret = randomChars(SECRET_LENGTH);
  return {
    lookupId,
    secret,
    display: `${lookupId}-${secret.slice(0, 6)}-${secret.slice(6)}`,
  };
}

/**
 * Parses user input: case-insensitive, spaces and hyphens ignored, and the Crockford aliases
 * (I and L read as 1, O as 0). Returns null for anything that cannot be a recovery code.
 */
export function parseRecoveryCode(input: string): { lookupId: string; secret: string } | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (clean.length !== LOOKUP_LENGTH + SECRET_LENGTH) return null;
  for (const char of clean) if (!ALPHABET.includes(char)) return null;
  return { lookupId: clean.slice(0, LOOKUP_LENGTH), secret: clean.slice(LOOKUP_LENGTH) };
}
