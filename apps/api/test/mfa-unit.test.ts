import { describe, expect, it } from 'vitest';
import {
  HIGH_PRIVILEGE_PERMISSIONS,
  mfaRequirement,
  sessionSatisfiesMfa,
} from '../src/application/mfa-policy.js';
import { ConfigError, loadConfig } from '../src/infrastructure/config/config.js';
import {
  MfaKeyError,
  MfaKeyRing,
  totpSecretAad,
} from '../src/infrastructure/security/mfa-keyring.js';
import { qrSvgDataUri } from '../src/infrastructure/security/qr.js';
import {
  generateRecoveryCode,
  parseRecoveryCode,
} from '../src/infrastructure/security/recovery-codes.js';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from '../src/infrastructure/security/totp.js';
import { sanitizeMetadata } from '../src/modules/audit/events.js';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

describe('TOTP (RFC 6238, S7-11)', () => {
  // RFC 6238 Appendix B, SHA-1 seed "12345678901234567890" (8-digit reference values).
  const seed = Buffer.from('12345678901234567890', 'ascii');
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it('matches the RFC 6238 SHA-1 test vectors', () => {
    for (const [seconds, expected] of vectors) {
      const step = totpStep(new Date(seconds * 1000));
      expect(hotp(seed, step, 8)).toBe(expected);
      // Six-digit codes are the last six digits of the same value.
      expect(totpCode(seed, step)).toBe(expected.slice(-6));
    }
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314'];
    expected.forEach((code, counter) => expect(hotp(seed, counter)).toBe(code));
  });

  it('round-trips base32 (RFC 4648 vectors, no padding)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Decode('mzxw 6ytb-oi==').toString()).toBe('foobar');
    const secret = generateTotpSecret();
    expect(secret.length).toBe(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(() => base32Decode('0189')).toThrow();
  });

  it('accepts exactly the ±1 window, and only later steps than the last used one', () => {
    const secret = generateTotpSecret();
    const now = new Date('2026-09-28T10:00:15Z');
    const s = totpStep(now);
    const at = (step: number, window = 1, lastUsedStep: number | null = null) =>
      verifyTotp({ secret, code: totpCode(secret, step), now, window, lastUsedStep });
    expect(at(s)).toBe(s);
    expect(at(s - 1)).toBe(s - 1);
    expect(at(s + 1)).toBe(s + 1);
    expect(at(s - 2)).toBeNull();
    expect(at(s + 2)).toBeNull();
    expect(at(s - 1, 0)).toBeNull();
    expect(at(s, 0)).toBe(s);
    // Replay protection: the used step and anything earlier are refused.
    expect(at(s, 1, s)).toBeNull();
    expect(at(s - 1, 1, s - 1)).toBeNull();
    expect(at(s + 1, 1, s)).toBe(s + 1);
  });

  it('checks the window edges in real time (step boundaries)', () => {
    const secret = generateTotpSecret();
    const boundary = new Date(totpStep(new Date('2026-09-28T10:00:00Z')) * 30_000);
    const code = totpCode(secret, totpStep(boundary) - 1);
    // Valid for the rest of its own step and the next one...
    expect(
      verifyTotp({
        secret,
        code,
        now: new Date(boundary.getTime() + 29_999),
        window: 1,
        lastUsedStep: null,
      }),
    ).not.toBeNull();
    // ...but not two steps later.
    expect(
      verifyTotp({
        secret,
        code,
        now: new Date(boundary.getTime() + 30_000),
        window: 1,
        lastUsedStep: null,
      }),
    ).toBeNull();
  });

  it('rejects malformed codes before comparing', () => {
    const secret = generateTotpSecret();
    const now = new Date();
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 5x']) {
      expect(verifyTotp({ secret, code, now, window: 1, lastUsedStep: null })).toBeNull();
    }
    const valid = totpCode(secret, totpStep(now));
    expect(
      verifyTotp({
        secret,
        code: `${valid.slice(0, 3)} ${valid.slice(3)}`,
        now,
        window: 1,
        lastUsedStep: null,
      }),
    ).not.toBeNull();
  });

  it('builds a percent-encoded otpauth URI', () => {
    const uri = otpauthUri({ issuer: 'Intuit 2.0', account: 'a+b@example.test', secret: 'ABC' });
    expect(uri).toBe(
      'otpauth://totp/Intuit%202.0:a%2Bb%40example.test?secret=ABC&issuer=Intuit%202.0&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('MFA key ring (AES-256-GCM, S7-09)', () => {
  const ring = MfaKeyRing.parse(`k1:${key(1)},k2:${key(2)}`, 'k1');
  const aad = totpSecretAad('factor-1', 'user-1');
  const secret = Buffer.from('super secret totp seed');

  it('seals with the active key and opens again', () => {
    const sealed = ring.seal(secret, aad);
    expect(sealed.keyId).toBe('k1');
    expect(sealed.iv.length).toBe(12);
    expect(sealed.tag.length).toBe(16);
    expect(sealed.ciphertext.equals(secret)).toBe(false);
    expect(ring.open(sealed, aad).equals(secret)).toBe(true);
    // Fresh IV each time.
    expect(ring.seal(secret, aad).iv.equals(sealed.iv)).toBe(false);
  });

  it('rejects tampered ciphertext, IV and tag, and the wrong row binding (AAD)', () => {
    const sealed = ring.seal(secret, aad);
    const flip = (b: Buffer) => {
      const copy = Buffer.from(b);
      copy[0] = copy[0]! ^ 1;
      return copy;
    };
    expect(() => ring.open({ ...sealed, ciphertext: flip(sealed.ciphertext) }, aad)).toThrow(
      MfaKeyError,
    );
    expect(() => ring.open({ ...sealed, iv: flip(sealed.iv) }, aad)).toThrow(MfaKeyError);
    expect(() => ring.open({ ...sealed, tag: flip(sealed.tag) }, aad)).toThrow(MfaKeyError);
    expect(() => ring.open(sealed, totpSecretAad('factor-1', 'user-2'))).toThrow(MfaKeyError);
    expect(() => ring.open(sealed, totpSecretAad('factor-2', 'user-1'))).toThrow(MfaKeyError);
  });

  it('refuses unknown keys and supports rotation to a new active key', () => {
    const sealed = ring.seal(secret, aad);
    const other = MfaKeyRing.parse(`k9:${key(9)}`, 'k9');
    expect(() => other.open(sealed, aad)).toThrow(/not configured/);
    const rotated = MfaKeyRing.parse(`k1:${key(1)},k2:${key(2)}`, 'k2');
    expect(rotated.open(sealed, aad).equals(secret)).toBe(true);
    const resealed = rotated.seal(rotated.open(sealed, aad), aad);
    expect(resealed.keyId).toBe('k2');
    expect(
      MfaKeyRing.parse(`k2:${key(2)}`, 'k2')
        .open(resealed, aad)
        .equals(secret),
    ).toBe(true);
  });

  it('validates the key ring without revealing key material', () => {
    const bad = [
      ['', 'k1'],
      [`k1:${Buffer.alloc(16).toString('base64')}`, 'k1'],
      [`k1:${key(1)},k1:${key(2)}`, 'k1'],
      [`k1:${key(1)}`, 'k2'],
      [`bad id:${key(1)}`, 'bad id'],
      [`k1:not-base64!!`, 'k1'],
    ] as const;
    for (const [spec, active] of bad) {
      try {
        MfaKeyRing.parse(spec, active);
        expect.unreachable(`accepted ${spec}`);
      } catch (error) {
        expect(error).toBeInstanceOf(MfaKeyError);
        expect((error as Error).message).not.toContain(key(1));
      }
    }
  });
});

describe('recovery codes (S7-18)', () => {
  it('generates 16-character Crockford codes with a lookup id', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const code = generateRecoveryCode();
      expect(code.display).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/,
      );
      expect(parseRecoveryCode(code.display)).toEqual({
        lookupId: code.lookupId,
        secret: code.secret,
      });
      seen.add(code.display);
    }
    expect(seen.size).toBe(200);
  });

  it('normalizes input (case, spaces, hyphens, Crockford aliases) and rejects junk', () => {
    expect(parseRecoveryCode(' 7k2m qx4t9b hn3wpa ')).toEqual({
      lookupId: '7K2M',
      secret: 'QX4T9BHN3WPA',
    });
    expect(parseRecoveryCode('OILO-000000-000000')).toEqual({
      lookupId: '0110',
      secret: '000000000000',
    });
    expect(parseRecoveryCode('7K2M-QX4T9B-HN3WP')).toBeNull();
    expect(parseRecoveryCode('7K2M-QX4T9B-HN3WPU')).toBeNull();
    expect(parseRecoveryCode('')).toBeNull();
  });
});

describe('MFA policy (S7-27, S7-28, S7-36)', () => {
  const none = new Set<string>();

  it('is exactly the Decision 57a set (sales.settings.manage arrives with Phase 3B)', () => {
    expect([...HIGH_PRIVILEGE_PERMISSIONS].sort()).toEqual([
      'accounting.setup',
      'approvals.manage',
      'members.manage',
      'roles.manage',
    ]);
  });

  it('requires MFA for the Owner, privileged permission holders and organization policy', () => {
    const off = { requireMfaForAllMembers: false };
    expect(mfaRequirement({ isOwner: false, permissions: none }, off)).toEqual({
      required: false,
      reasons: [],
    });
    expect(mfaRequirement({ isOwner: true, permissions: none }, off).reasons).toEqual(['owner']);
    for (const permission of HIGH_PRIVILEGE_PERMISSIONS) {
      expect(
        mfaRequirement({ isOwner: false, permissions: new Set([permission]) }, off).reasons,
      ).toEqual(['privileged_permission']);
    }
    for (const permission of [
      'accounting.journals.post',
      'accounting.periods.reopen',
      'audit.read',
    ]) {
      expect(
        mfaRequirement({ isOwner: false, permissions: new Set([permission]) }, off).required,
      ).toBe(false);
    }
    expect(
      mfaRequirement({ isOwner: false, permissions: none }, { requireMfaForAllMembers: true })
        .reasons,
    ).toEqual(['organization_policy']);
  });

  it('accepts remembered devices only where the organization allows them; never while pending', () => {
    const allow = { allowTrustedDevices: true };
    const deny = { allowTrustedDevices: false };
    const s = (mfaMethod: 'totp' | 'recovery_code' | 'trusted_device' | null, pending = false) => ({
      mfaMethod,
      mfaPendingUntil: pending ? new Date() : null,
    });
    expect(sessionSatisfiesMfa(s('totp'), deny)).toBe(true);
    expect(sessionSatisfiesMfa(s('recovery_code'), deny)).toBe(true);
    expect(sessionSatisfiesMfa(s('trusted_device'), allow)).toBe(true);
    expect(sessionSatisfiesMfa(s('trusted_device'), deny)).toBe(false);
    expect(sessionSatisfiesMfa(s(null), allow)).toBe(false);
    expect(sessionSatisfiesMfa(s(null, true), allow)).toBe(false);
  });
});

describe('QR rendering (S7-10)', () => {
  it('renders an SVG data URI of rectangles only', () => {
    const uri = qrSvgDataUri('otpauth://totp/Intuit%202.0:x%40example.test?secret=ABC<script>');
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = Buffer.from(uri.split(',')[1]!, 'base64').toString('utf8');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).not.toMatch(/script|otpauth|secret|<text/i);
    expect(svg.match(/<(\w+)/g)?.sort()).toEqual(['<path', '<rect', '<svg']);
  });
});

describe('MFA configuration and audit hygiene', () => {
  const env = {
    APP_ENV: 'development',
    WEB_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgres://intuit_app:x@localhost:5432/intuit2_dev',
    SESSION_SECRET: 'a'.repeat(40),
    MFA_ENCRYPTION_KEYS: `k1:${key(3)}`,
    MFA_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  };

  it('applies the frozen defaults', () => {
    const { mfa } = loadConfig(env);
    expect(mfa.totpWindow).toBe(1);
    expect(mfa.recoveryCodeCount).toBe(10);
    expect(mfa.trustedDeviceLifetimeMs).toBe(30 * 24 * 60 * 60_000);
    expect(mfa.stepUpWindowMs).toBe(15 * 60_000);
    expect(mfa.keyRing.activeKeyId).toBe('k1');
  });

  it('never allows weaker settings than the frozen decisions', () => {
    for (const override of [
      { MFA_TOTP_WINDOW: '2' },
      { MFA_RECOVERY_CODE_COUNT: '9' },
      { TRUSTED_DEVICE_DAYS: '31' },
      { MFA_ENCRYPTION_KEYS: '' },
      { MFA_ENCRYPTION_ACTIVE_KEY_ID: 'k2' },
    ]) {
      expect(() => loadConfig({ ...env, ...override })).toThrow(ConfigError);
    }
    try {
      loadConfig({ ...env, MFA_ENCRYPTION_ACTIVE_KEY_ID: 'k2' });
    } catch (error) {
      expect((error as Error).message).not.toContain(key(3));
    }
  });

  it('drops secret-looking keys (codes, OTP) from audit metadata', () => {
    expect(
      sanitizeMetadata({
        recoveryCode: 'x',
        recovery_codes: ['x'],
        totpSecret: 'x',
        otp: '1',
        otpCode: '1',
        remaining: 3,
        method: 'totp',
        snapshotPolicy: 1,
      }),
    ).toEqual({ remaining: 3, method: 'totp', snapshotPolicy: 1 });
  });
});
