import type pg from 'pg';
import { totpSecretAad, type MfaKeyRing } from '../infrastructure/security/mfa-keyring.js';

/**
 * MFA key rotation (S7-09). Re-encrypts every TOTP secret sealed with a key other than the active
 * one, in batches, under the active key. Runs as the owner role (the application role cannot
 * update secret columns). Each row is updated with a compare-and-set on its key id, so a rerun or a
 * concurrent run is safe. Revoked factors are re-encrypted too, so the old key can be removed once
 * nothing refers to it. `userId` limits a run to one user (targeted runs and tests).
 */
export interface RotationReport {
  reencrypted: number;
  remainingByKey: Record<string, number>;
}

export async function rotateMfaKeys(
  client: Pick<pg.Client, 'query'>,
  keyRing: MfaKeyRing,
  options: { batchSize?: number; userId?: string } = {},
): Promise<RotationReport> {
  const batchSize = options.batchSize ?? 200;
  const active = keyRing.activeKeyId;
  const scope = options.userId ? ' AND user_id = $3' : '';
  const scopeArgs = options.userId ? [options.userId] : [];
  let reencrypted = 0;
  for (;;) {
    const { rows } = await client.query<{
      id: string;
      user_id: string;
      key_id: string;
      secret_ciphertext: Buffer;
      secret_iv: Buffer;
      secret_tag: Buffer;
    }>(
      `SELECT id, user_id, key_id, secret_ciphertext, secret_iv, secret_tag
         FROM mfa_factors
        WHERE key_id IS NOT NULL AND key_id <> $1${scope}
        ORDER BY id
        LIMIT $2`,
      [active, batchSize, ...scopeArgs],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const aad = totpSecretAad(row.id, row.user_id);
      const secret = keyRing.open(
        {
          keyId: row.key_id,
          iv: row.secret_iv,
          ciphertext: row.secret_ciphertext,
          tag: row.secret_tag,
        },
        aad,
      );
      try {
        const sealed = keyRing.seal(secret, aad);
        const updated = await client.query(
          `UPDATE mfa_factors
              SET secret_ciphertext = $1, secret_iv = $2, secret_tag = $3, key_id = $4
            WHERE id = $5 AND key_id = $6`,
          [sealed.ciphertext, sealed.iv, sealed.tag, sealed.keyId, row.id, row.key_id],
        );
        reencrypted += updated.rowCount ?? 0;
      } finally {
        secret.fill(0);
      }
    }
  }
  const counts = await client.query<{ key_id: string; n: string }>(
    `SELECT key_id, count(*)::text AS n FROM mfa_factors
      WHERE key_id IS NOT NULL${options.userId ? ' AND user_id = $1' : ''}
      GROUP BY key_id`,
    scopeArgs,
  );
  return {
    reencrypted,
    remainingByKey: Object.fromEntries(counts.rows.map((r) => [r.key_id, Number(r.n)])),
  };
}
