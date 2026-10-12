import type { MfaKeyRing } from '../../infrastructure/security/mfa-keyring.js';
import type { SealedColumns } from './data.js';

/**
 * `SecretCipher` for webhook signing secrets (ADR 0011 sections 11.4 and 13): AES-256-GCM through
 * the key ring (key id + iv + tag + ciphertext). The additional authenticated data binds a
 * ciphertext to its endpoint, rotation and role (current/previous), so it cannot be moved to
 * another endpoint or swapped between the two columns. The plaintext secret is only ever held in
 * memory while signing; it is never logged or stored in the delivery history.
 */
export class WebhookSecretCipher {
  constructor(private readonly keyRing: MfaKeyRing) {}

  private aad(endpointId: string, version: number, role: 'current' | 'previous') {
    return `webhook_endpoint:${endpointId}:${version}:${role}`;
  }

  seal(
    secret: string,
    endpointId: string,
    version: number,
    role: 'current' | 'previous' = 'current',
  ): SealedColumns {
    const sealed = this.keyRing.seal(
      Buffer.from(secret, 'utf8'),
      this.aad(endpointId, version, role),
    );
    return { keyId: sealed.keyId, iv: sealed.iv, tag: sealed.tag, ciphertext: sealed.ciphertext };
  }

  open(
    sealed: SealedColumns,
    endpointId: string,
    version: number,
    role: 'current' | 'previous' = 'current',
  ): string {
    return this.keyRing.open(sealed, this.aad(endpointId, version, role)).toString('utf8');
  }
}
