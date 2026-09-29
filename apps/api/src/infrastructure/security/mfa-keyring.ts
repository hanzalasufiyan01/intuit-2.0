import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM key ring for MFA secrets (Decision 25, S7-09). Keys live only in the environment
 * (`MFA_ENCRYPTION_KEYS`); each ciphertext records the id of the key that sealed it, so keys can
 * be rotated (new writes use the active key, `mfa:rotate-keys` re-encrypts old rows). The
 * additional authenticated data binds a ciphertext to its row, so it cannot be moved to another
 * user or factor.
 */
export interface SealedSecret {
  keyId: string;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export class MfaKeyError extends Error {}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class MfaKeyRing {
  private constructor(
    private readonly keys: ReadonlyMap<string, Buffer>,
    readonly activeKeyId: string,
  ) {}

  /** Parses `kid:base64key,kid2:base64key` and checks the active key id (fails fast). */
  static parse(spec: string, activeKeyId: string): MfaKeyRing {
    const keys = new Map<string, Buffer>();
    for (const entry of spec
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)) {
      const separator = entry.indexOf(':');
      const id = separator > 0 ? entry.slice(0, separator) : '';
      const material = separator > 0 ? entry.slice(separator + 1) : '';
      if (!KEY_ID.test(id)) throw new MfaKeyError('MFA_ENCRYPTION_KEYS has an invalid key id.');
      if (keys.has(id)) throw new MfaKeyError(`MFA_ENCRYPTION_KEYS repeats key id "${id}".`);
      const key = Buffer.from(material, 'base64');
      if (key.length !== 32 || key.toString('base64') !== material.replace(/\s/g, '')) {
        throw new MfaKeyError(`MFA encryption key "${id}" must be 32 bytes, base64-encoded.`);
      }
      keys.set(id, key);
    }
    if (keys.size === 0)
      throw new MfaKeyError('MFA_ENCRYPTION_KEYS must contain at least one key.');
    if (!keys.has(activeKeyId)) {
      throw new MfaKeyError('MFA_ENCRYPTION_ACTIVE_KEY_ID must name a key in MFA_ENCRYPTION_KEYS.');
    }
    return new MfaKeyRing(keys, activeKeyId);
  }

  hasKey(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  /** Seals with the active key and a fresh random IV. */
  seal(plaintext: Buffer, aad: string): SealedSecret {
    const keyId = this.activeKeyId;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(keyId)!, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { keyId, iv, ciphertext, tag: cipher.getAuthTag() };
  }

  /** Opens a sealed secret. Throws MfaKeyError for an unknown key or any authentication failure. */
  open(sealed: SealedSecret, aad: string): Buffer {
    const key = this.keys.get(sealed.keyId);
    if (!key) throw new MfaKeyError('The MFA encryption key for this secret is not configured.');
    if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) {
      throw new MfaKeyError('The MFA secret could not be decrypted.');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(sealed.tag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    } catch {
      throw new MfaKeyError('The MFA secret could not be decrypted.');
    }
  }
}

/** Additional authenticated data for a TOTP secret: binds it to the factor and its user. */
export function totpSecretAad(factorId: string, userId: string): string {
  return `intuit2:mfa:totp:${factorId}:${userId}`;
}
