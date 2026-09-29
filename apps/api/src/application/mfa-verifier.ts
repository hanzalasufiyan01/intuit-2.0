import { randomUUID } from 'node:crypto';
import { MfaUnavailableError } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { MfaKeyError, totpSecretAad } from '../infrastructure/security/mfa-keyring.js';
import {
  generateRecoveryCode,
  parseRecoveryCode,
} from '../infrastructure/security/recovery-codes.js';
import { verifyTotp } from '../infrastructure/security/totp.js';
import {
  consumeRecoveryCode,
  consumeTotpStep,
  countUsableRecoveryCodes,
  findUsableRecoveryCode,
  getActiveTotpFactor,
  insertRecoveryCodes,
  type MfaFactor,
} from '../modules/identity/index.js';
import type { AppDependencies } from './dependencies.js';
import { inTransaction } from './unit-of-work.js';

/** A prepared recovery-code set: plaintext for the one-time display, hashes for storage. */
export interface PreparedRecoveryCodes {
  setId: string;
  display: string[];
  rows: { lookupId: string; codeHash: string }[];
}

/**
 * Second-factor checks shared by the login challenge, step-up and enrollment (S7-14, S7-16,
 * S7-18). Secrets are decrypted only here, for one comparison, and never leave this class.
 */
export class MfaVerifier {
  constructor(private readonly deps: AppDependencies) {}

  /** Decrypts a factor's secret. A missing key or failed authentication is MFA_UNAVAILABLE. */
  openSecret(factor: MfaFactor): Buffer {
    if (!factor.secretCiphertext || !factor.secretIv || !factor.secretTag || !factor.keyId) {
      throw new MfaUnavailableError();
    }
    try {
      return this.deps.config.mfa.keyRing.open(
        {
          keyId: factor.keyId,
          iv: factor.secretIv,
          ciphertext: factor.secretCiphertext,
          tag: factor.secretTag,
        },
        totpSecretAad(factor.id, factor.userId),
      );
    } catch (error) {
      // Only the factor id and the kind of failure are logged; never key or secret material.
      this.deps.logger.error(
        { factorId: factor.id, reason: error instanceof MfaKeyError ? 'key' : 'unknown' },
        'MFA secret could not be decrypted',
      );
      throw new MfaUnavailableError();
    }
  }

  /** Checks a TOTP code without consuming it (enrollment of a pending factor). */
  matchStep(factor: MfaFactor, code: string, now: Date): number | null {
    const secret = this.openSecret(factor);
    try {
      return verifyTotp({
        secret,
        code,
        now,
        window: this.deps.config.mfa.totpWindow,
        lastUsedStep: factor.lastUsedStep,
      });
    } finally {
      secret.fill(0);
    }
  }

  /**
   * Verifies a code against the user's active authenticator and consumes its time step
   * (replay-safe under concurrency). Returns false for any failure.
   */
  async verifyTotp(tx: Transaction, userId: string, code: string, now: Date): Promise<boolean> {
    const factor = await getActiveTotpFactor(tx, userId);
    if (!factor) return false;
    const step = this.matchStep(factor, code, now);
    if (step === null) return false;
    return consumeTotpStep(tx, { factorId: factor.id, step, now });
  }

  /**
   * Checks and consumes one recovery code. The Argon2id check runs outside any transaction; the
   * single-use update then decides races. Returns the remaining count on success.
   */
  async useRecoveryCode(
    userId: string,
    input: string,
    now: Date,
  ): Promise<{ ok: true; remaining: number } | { ok: false }> {
    const parsed = parseRecoveryCode(input);
    const row = parsed
      ? await inTransaction(this.deps.db, { userId }, (tx) =>
          findUsableRecoveryCode(tx, userId, parsed.lookupId),
        )
      : undefined;
    if (!parsed || !row) {
      await this.deps.passwordHasher.verifyDummy(input);
      return { ok: false };
    }
    if (!(await this.deps.passwordHasher.verify(row.codeHash, parsed.secret))) {
      return { ok: false };
    }
    return inTransaction(this.deps.db, { userId }, async (tx) => {
      if (!(await consumeRecoveryCode(tx, { id: row.id, userId, now }))) return { ok: false };
      return { ok: true, remaining: await countUsableRecoveryCodes(tx, userId) };
    });
  }

  /** Generates and hashes a new set (hashing is slow, so it happens before any transaction). */
  async prepareRecoveryCodes(): Promise<PreparedRecoveryCodes> {
    const codes: ReturnType<typeof generateRecoveryCode>[] = [];
    const lookups = new Set<string>();
    while (codes.length < this.deps.config.mfa.recoveryCodeCount) {
      const code = generateRecoveryCode();
      if (lookups.has(code.lookupId)) continue;
      lookups.add(code.lookupId);
      codes.push(code);
    }
    const hashes = await Promise.all(codes.map((c) => this.deps.passwordHasher.hash(c.secret)));
    return {
      setId: randomUUID(),
      display: codes.map((c) => c.display),
      rows: codes.map((c, i) => ({ lookupId: c.lookupId, codeHash: hashes[i]! })),
    };
  }

  async storeRecoveryCodes(
    tx: Transaction,
    userId: string,
    prepared: PreparedRecoveryCodes,
    now: Date,
  ): Promise<void> {
    await insertRecoveryCodes(tx, { userId, setId: prepared.setId, codes: prepared.rows, now });
  }
}
