import pg from 'pg';
import { loadConfig } from '../../infrastructure/config/config.js';
import { loadEnvFile } from '../../infrastructure/config/load-env.js';
import { rotateMfaKeys } from '../mfa-key-rotation.js';

/**
 * Re-encrypts MFA secrets under MFA_ENCRYPTION_ACTIVE_KEY_ID (S7-09). Runs as the owner role
 * (DATABASE_MIGRATION_URL). Prints counts only, never key or secret material.
 */
loadEnvFile();
const config = loadConfig();
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL is not set (key rotation runs as the intuit_owner role).');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const report = await rotateMfaKeys(client, config.mfa.keyRing);
  console.log(`Re-encrypted ${report.reencrypted} MFA secret(s).`);
  for (const [keyId, count] of Object.entries(report.remainingByKey)) {
    console.log(`  key ${keyId}: ${count} secret(s)`);
  }
} catch (error) {
  console.error(
    'MFA key rotation failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
