import { hash, verify } from '@node-rs/argon2';

// Algorithm.Argon2id from @node-rs/argon2 (an ambient const enum, so referenced by value).
const ARGON2ID = 2;

/** Password hashing contract. Implementations must use Argon2id. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
  /** Performs a verification against a fixed hash to equalize timing for unknown accounts. */
  verifyDummy(password: string): Promise<void>;
}

/** OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1). */
const ARGON2ID_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function createArgon2idPasswordHasher(): PasswordHasher {
  let dummyHash: Promise<string> | undefined;
  return {
    hash: (password) => hash(password, ARGON2ID_OPTIONS),
    async verify(passwordHash, password) {
      try {
        return await verify(passwordHash, password);
      } catch {
        return false;
      }
    },
    async verifyDummy(password) {
      dummyHash ??= hash('dummy-password-for-timing-equalization', ARGON2ID_OPTIONS);
      try {
        await verify(await dummyHash, password);
      } catch {
        // Result intentionally ignored.
      }
    },
  };
}
