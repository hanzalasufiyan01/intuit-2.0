import { createHmac } from 'node:crypto';

/** RFC 6238 time-based one-time password (SHA-1, 6 digits, 30 s), as authenticator apps compute it. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = '';
  for (const ch of clean) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`Invalid base32 character ${ch}`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / 30);
}

export function totp(secret: string, step = totpStep()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return (binary % 1_000_000).toString().padStart(6, '0');
}

/** Waits until the current 30 s window has ended, so a code used once is never offered twice. */
export async function untilNextStep(): Promise<void> {
  const wait = (totpStep() + 1) * 30_000 - Date.now() + 500;
  await new Promise((resolve) => setTimeout(resolve, wait));
}
