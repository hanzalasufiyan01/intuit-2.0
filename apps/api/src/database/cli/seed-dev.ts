/**
 * Development seed (pnpm db:seed:dev). Creates an example organization with accounting set up,
 * a fiscal year with monthly periods, three users (Owner, Administrator, Member), an approval
 * policy, an exchange rate, an example draft journal and an approved + posted journal.
 *
 * Safety: refuses to run outside development/testing; the users' password comes only from
 * DEV_SEED_PASSWORD in the git-ignored .env and is never printed or committed. Idempotent: if
 * the seed organization's owner already exists, nothing is changed except the MFA step below.
 *
 * Phase 3A S7: the Owner and the Administrator must use two-step verification (Decision 57a).
 * They are enrolled through the real verification path with the authenticator secret
 * DEV_SEED_TOTP_SECRET from the git-ignored .env (never printed); add that key to an
 * authenticator app to sign in as them. An already-seeded database is brought up to date.
 */
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../app.js';
import type { Principal } from '../../application/authorization.js';
import { inTransaction } from '../../application/unit-of-work.js';
import { systemClock } from '../../infrastructure/clock.js';
import { loadConfig } from '../../infrastructure/config/config.js';
import { loadEnvFile } from '../../infrastructure/config/load-env.js';
import { MockEmailProvider } from '../../infrastructure/email/email-provider.js';
import { totpSecretAad } from '../../infrastructure/security/mfa-keyring.js';
import { createArgon2idPasswordHasher } from '../../infrastructure/security/password-hasher.js';
import { base32Decode, totpCode, totpStep } from '../../infrastructure/security/totp.js';
import {
  findUserByEmail,
  hasActiveFactor,
  insertPendingTotpFactor,
} from '../../modules/identity/index.js';
import { createDatabase } from '../client.js';

loadEnvFile();
const config = loadConfig({ ...process.env, LOG_LEVEL: 'warn' });

if (config.appEnv !== 'development' && config.appEnv !== 'testing') {
  console.error(`Refusing to seed development data in APP_ENV=${config.appEnv}.`);
  process.exit(1);
}
const password = process.env.DEV_SEED_PASSWORD;
if (!password || password.length < config.password.minLength) {
  console.error(
    `Set DEV_SEED_PASSWORD (at least ${config.password.minLength} characters) in your .env to seed development users.`,
  );
  process.exit(1);
}

let totpSecret: Buffer;
try {
  totpSecret = base32Decode(process.env.DEV_SEED_TOTP_SECRET ?? '');
} catch {
  totpSecret = Buffer.alloc(0);
}
if (totpSecret.length < 16) {
  console.error(
    'Set DEV_SEED_TOTP_SECRET (a base32 authenticator key of at least 16 bytes) in your .env ' +
      'to seed development users that use two-step verification.',
  );
  process.exit(1);
}

const USERS = {
  owner: { email: 'owner@intuit2-dev.test', displayName: 'Dev Owner' },
  admin: { email: 'admin@intuit2-dev.test', displayName: 'Dev Administrator' },
  member: { email: 'member@intuit2-dev.test', displayName: 'Dev Member' },
};
const origin = { requestId: 'seed-dev', ipAddress: null, userAgent: 'seed-dev' };

const database = createDatabase({ connectionString: config.database.url, poolMax: 2 });
const email = new MockEmailProvider(config.email.from);
const { app, services } = await buildApp({
  deps: {
    db: database.db,
    config,
    clock: systemClock,
    passwordHasher: createArgon2idPasswordHasher(),
    emailProvider: email,
  },
});

async function principalFor(token: string): Promise<Principal> {
  const principal = await services.auth.authenticate(token, origin);
  if (!principal) throw new Error('Seed session could not be validated');
  return principal;
}

/**
 * Enrolls a seed user's authenticator with DEV_SEED_TOTP_SECRET: the pending factor is stored
 * sealed like any other, then confirmed through MfaService.completeEnrollment with a real code.
 * Returns the (rotated) MFA-verified session. Recovery codes are issued but not printed; generate
 * new ones under Account security if needed.
 */
async function enrollSeedMfa(principal: Principal): Promise<Principal> {
  const now = systemClock.now();
  const factorId = randomUUID();
  await inTransaction(database.db, { userId: principal.user.id }, async (tx) => {
    const sealed = config.mfa.keyRing.seal(totpSecret, totpSecretAad(factorId, principal.user.id));
    await insertPendingTotpFactor(tx, {
      id: factorId,
      userId: principal.user.id,
      secretCiphertext: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
      keyId: sealed.keyId,
      now,
      expiresAt: new Date(now.getTime() + config.mfa.enrollmentTtlMs),
    });
  });
  const { sessionToken } = await services.mfa.completeEnrollment(
    principal,
    { enrollmentId: factorId, code: totpCode(totpSecret, totpStep(now)) },
    origin,
  );
  return principalFor(sessionToken);
}

/** Brings an already-seeded privileged user up to S7: enrolls MFA if they have none. */
async function ensureSeedMfa(user: { email: string }): Promise<boolean> {
  const found = await inTransaction(database.db, {}, (tx) => findUserByEmail(tx, user.email));
  if (!found) return false;
  const enrolled = await inTransaction(database.db, { userId: found.id }, (tx) =>
    hasActiveFactor(tx, found.id),
  );
  if (enrolled) return false;
  const login = await services.auth.login({ email: user.email, password: password! }, origin);
  await enrollSeedMfa(await principalFor(login.issued.token));
  return true;
}

function tokenSentTo(address: string): string {
  const match = email.lastTo(address)?.text.match(/#token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error(`No invitation email captured for ${address}`);
  return match[1];
}

try {
  const existing = await inTransaction(database.db, {}, (tx) =>
    findUserByEmail(tx, USERS.owner.email),
  );
  if (existing) {
    const upgraded = [await ensureSeedMfa(USERS.owner), await ensureSeedMfa(USERS.admin)];
    console.log(
      upgraded.some(Boolean)
        ? 'Development seed already present; two-step verification set up for the Owner and Administrator (DEV_SEED_TOTP_SECRET).'
        : 'Development seed already present; nothing changed.',
    );
  } else {
    const registered = await services.auth.register(
      { ...USERS.owner, password, organizationName: 'Maldives Demo Trading' },
      origin,
    );
    const owner = await enrollSeedMfa(await principalFor(registered.issued.token));
    await services.accounting.setUp(
      owner,
      { baseCurrency: 'MVR', templateKey: 'maldives' },
      origin,
    );
    const year = new Date().getUTCFullYear();
    await services.accounting.createFiscalYear(
      owner,
      { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
      origin,
    );

    const roles = await services.roles.listRoles(owner);
    const roleId = (name: string) => roles.find((r) => r.name === name)!.id;
    const join = async (user: { email: string; displayName: string }, role: string) => {
      await services.invitations.createInvitation(
        owner,
        { email: user.email, roleId: roleId(role) },
        origin,
      );
      const accepted = await services.invitations.accept(
        { token: tokenSentTo(user.email), displayName: user.displayName, password },
        null,
        origin,
      );
      return principalFor(accepted.issued!.token);
    };
    const admin = await enrollSeedMfa(await join(USERS.admin, 'Administrator'));
    await join(USERS.member, 'Member');

    // Journals require one approval from an Administrator (never the preparer).
    await services.approvals.setPolicy(
      owner,
      {
        actionKey: 'accounting.journal.post',
        steps: [
          {
            name: 'Administrator approval',
            requiredApprovals: 1,
            roleIds: [roleId('Administrator')],
            membershipIds: [],
          },
        ],
      },
      origin,
    );
    await services.accounting.recordExchangeRate(
      owner,
      { fromCurrency: 'USD', rateDate: `${year}-01-01`, rate: '15.42' },
      origin,
    );

    const accounts = await services.accounting.listAccounts(owner);
    const account = (code: string) => accounts.find((a) => a.code === code)!.id;
    const line = (code: string, side: 'debit' | 'credit', amount: string) => ({
      accountId: account(code),
      description: '',
      debit: side === 'debit' ? amount : null,
      credit: side === 'credit' ? amount : null,
    });

    const capital = await services.journals.createJournal(
      owner,
      {
        entryDate: `${year}-01-02`,
        description: 'Owner capital contribution',
        reference: 'SEED-1',
        currency: 'MVR',
        exchangeRate: null,
        lines: [line('1120', 'debit', '50000.00'), line('3100', 'credit', '50000.00')],
      },
      origin,
    );
    await services.journals.submitJournal(owner, capital.id, origin);
    await services.journals.decideJournal(admin, capital.id, 'approved', 'Seed approval', origin);
    await services.journals.postJournal(owner, capital.id, origin);

    await services.journals.createJournal(
      owner,
      {
        entryDate: `${year}-01-15`,
        description: 'Example draft: office rent',
        reference: 'SEED-2',
        currency: 'MVR',
        exchangeRate: null,
        lines: [line('5300', 'debit', '7500.00'), line('1120', 'credit', '7500.00')],
      },
      origin,
    );

    console.log('Development seed created:');
    for (const [role, user] of Object.entries(USERS))
      console.log(`  ${role.padEnd(6)} ${user.email}`);
    console.log('  Password: the DEV_SEED_PASSWORD value from your .env');
    console.log('  Owner and admin two-step verification key: DEV_SEED_TOTP_SECRET in your .env');
  }
} catch (error) {
  console.error('Development seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await app.close();
  await database.close();
}
