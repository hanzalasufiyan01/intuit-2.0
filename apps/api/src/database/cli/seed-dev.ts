/**
 * Development seed (pnpm db:seed:dev). Creates an example organization with accounting set up,
 * a fiscal year with monthly periods, three users (Owner, Administrator, Member), an approval
 * policy, an exchange rate, an example draft journal and an approved + posted journal.
 *
 * Safety: refuses to run outside development/testing; the users' password comes only from
 * DEV_SEED_PASSWORD in the git-ignored .env and is never printed or committed. Idempotent: if
 * the seed organization's owner already exists, nothing is changed except the MFA step below.
 *
 * Phase 3B: a Sales demo (settings, two customers, two items, issued invoices in MVR and USD, a
 * receipt, a credit note and a draft invoice) is added through the real services; an
 * already-seeded database gets it once (the Owner signs in with password and authenticator code).
 *
 * Phase 3A S7: the Owner and the Administrator must use two-step verification (Decision 57a).
 * They are enrolled through the real verification path with the authenticator secret
 * DEV_SEED_TOTP_SECRET from the git-ignored .env (never printed); add that key to an
 * authenticator app to sign in as them. An already-seeded database is brought up to date.
 */
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../app.js';
import type { Principal } from '../../application/authorization.js';
import type { InvoiceDraftInput } from '../../application/invoice-service.js';
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
import { ValidationError } from '../../domain/errors.js';
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
  const now = await freshTotpTime();
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

/** Authenticator codes are single-use per time step: wait for a step not yet used by the seed. */
let lastTotpStep = -1;
async function freshTotpTime(): Promise<Date> {
  let now = systemClock.now();
  while (totpStep(now) <= lastTotpStep) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    now = systemClock.now();
  }
  lastTotpStep = totpStep(now);
  return now;
}

/** Signs a seeded privileged user in through the real password + authenticator-code path. */
async function signInWithMfa(user: { email: string }): Promise<Principal> {
  const login = await services.auth.login({ email: user.email, password: password! }, origin);
  const pending = await principalFor(login.issued.token);
  if (!login.mfaPending) return pending;
  const { token } = await services.auth.completeMfaChallenge(
    pending,
    {
      method: 'totp',
      code: totpCode(totpSecret, totpStep(await freshTotpTime())),
      rememberDevice: false,
    },
    origin,
  );
  return principalFor(token);
}

/**
 * Phase 3B: a small Sales demo through the real services (every posting goes Sales document →
 * accounting event → journal). Each step finds its record by a DEMO reference first, so the seed
 * resumes after an interruption and re-running changes nothing. Sales settings are only filled
 * in when not yet configured. Returns whether anything was added.
 */
async function seedSalesDemo(owner: Principal): Promise<boolean> {
  let added = false;
  const today = systemClock.now().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  // Dates inside the current fiscal year (the seed creates FY<year>).
  const daysAgo = (n: number) => {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000);
    const iso = date.toISOString().slice(0, 10);
    return iso < `${year}-01-02` ? `${year}-01-02` : iso;
  };
  let accounts = await services.accounting.listAccounts(owner);
  // Dev charts seeded before Phase 3A S1 left 1110/1120 unclassified; the template marks them
  // CASH/BANK, and receipts need a classified deposit account (Decision 42).
  for (const [code, subtype] of [
    ['1110', 'CASH'],
    ['1120', 'BANK'],
  ] as const) {
    const found = accounts.find((a) => a.code === code);
    if (found && found.subtype === null && found.isLeaf && found.type === 'ASSET') {
      await services.accounting.updateAccount(owner, found.id, { subtype }, origin);
      added = true;
    }
  }
  accounts = await services.accounting.listAccounts(owner);
  const account = (code: string) => accounts.find((a) => a.code === code)?.id ?? null;
  // Decision 42: a classified MVR bank or cash account (older dev charts may leave 1120 unclassified).
  const bank =
    accounts.find(
      (a) =>
        a.status === 'ACTIVE' &&
        a.currencyCode === 'MVR' &&
        (a.subtype === 'BANK' || a.subtype === 'CASH'),
    )?.id ?? null;
  const taxCodes = await services.tax.listCodes(owner);
  const gst = taxCodes.find((c) => c.code === 'GST')?.id ?? null;

  const settings = await services.salesSettings.get(owner);
  if (!settings.configured) {
    await services.salesSettings.update(
      owner,
      {
        version: settings.version,
        arAccountId: settings.arAccountId ?? settings.suggestedArAccountId ?? account('1130'),
        defaultRevenueAccountId: account('4100'),
        defaultDepositAccountId: bank,
        defaultTaxCodeId: gst,
        defaultTaxTreatment: 'exclusive',
        defaultPaymentTermsDays: 30,
      },
      origin,
    );
    added = true;
  }

  const customer = async (
    reference: string,
    displayName: string,
    currencyCode: string,
    emailAddress: string,
  ) => {
    const found = await services.customers.list(owner, {
      search: reference,
      status: 'all',
      limit: 5,
    });
    const match = found.items.find((c) => c.reference === reference);
    if (match) return match;
    added = true;
    return services.customers.create(
      owner,
      {
        currencyCode,
        paymentTermsDays: 30,
        party: {
          kind: 'organization',
          displayName,
          companyName: displayName,
          firstName: null,
          lastName: null,
          reference,
          tin: null,
          email: emailAddress,
          phone: null,
          website: null,
          notes: null,
          roles: ['customer'],
          contacts: [],
          addresses: [
            {
              kind: 'billing',
              label: null,
              line1: 'Boduthakurufaanu Magu',
              line2: null,
              city: 'Malé',
              region: null,
              postalCode: null,
              countryCode: 'MV',
              isDefault: true,
            },
          ],
        },
      },
      origin,
    );
  };
  const resort = await customer('DEMO-C1', 'Sunrise Island Resort', 'MVR', 'ap@sunrise.example');
  const divers = await customer('DEMO-C2', 'Coral Reef Divers', 'USD', 'accounts@coral.example');

  const item = async (
    sku: string,
    name: string,
    itemType: 'service' | 'product',
    unitPrice: string,
  ) => {
    const found = await services.items.list(owner, { search: sku, status: 'all', limit: 5 });
    const match = found.items.find((i) => i.sku === sku);
    if (match) return match;
    added = true;
    return services.items.create(
      owner,
      {
        sku,
        name,
        itemType,
        description: '',
        unitPrice,
        revenueAccountId: account(itemType === 'service' ? '4200' : '4100'),
        taxCodeId: gst,
      },
      origin,
    );
  };
  const consulting = await item('DEMO-SVC', 'Consulting (hour)', 'service', '750.00');
  const snorkel = await item('DEMO-SNK', 'Snorkel set', 'product', '450.00');

  const none = { idempotencyKey: null };
  /** Finds an invoice by reference, or creates it; issues it unless `draft`. */
  const invoice = async (
    reference: string,
    input: Omit<InvoiceDraftInput, 'reference'>,
    draft = false,
  ) => {
    const found = await services.invoices.list(owner, { search: reference, limit: 5 });
    let current: { id: string; version: number; status: string } | undefined = found.items.find(
      (i) => i.reference === reference,
    );
    if (!current) {
      current = (await services.invoices.create(owner, { ...input, reference }, none, origin))
        .value;
      added = true;
    }
    if (!draft && current.status === 'DRAFT') {
      current = (
        await services.invoices.issue(owner, current.id, { version: current.version }, none, origin)
      ).value;
      added = true;
    }
    return current;
  };

  // An MVR invoice, part paid; an overdue USD invoice with a credit note; and a draft.
  const resortInvoice = await invoice('PO-1042', {
    customerId: resort.id,
    invoiceDate: daysAgo(40),
    lines: [
      { itemId: consulting.id, quantity: '12' },
      { itemId: snorkel.id, quantity: '20' },
    ],
  });
  const receipts = await services.receipts.list(owner, { search: 'TT-55120', limit: 5 });
  if (!receipts.items.some((r) => r.reference === 'TT-55120')) {
    await services.receipts.record(
      owner,
      {
        customerId: resort.id,
        receiptDate: daysAgo(10),
        amount: '10000.00',
        ...(bank ? { depositAccountId: bank } : {}),
        reference: 'TT-55120',
        allocations: [{ invoiceId: resortInvoice.id, amount: '10000.00' }],
      },
      none,
      origin,
    );
    added = true;
  }
  const diversInvoice = await invoice('PO-DIVE-7', {
    customerId: divers.id,
    invoiceDate: daysAgo(75),
    lines: [
      { itemId: snorkel.id, description: 'Snorkel sets (USD)', quantity: '10', unitPrice: '29.00' },
    ],
  });
  const credits = await services.creditNotes.list(owner, { search: 'RMA-12', limit: 5 });
  let credit: { id: string; version: number; status: string } | undefined = credits.items.find(
    (n) => n.reference === 'RMA-12',
  );
  if (!credit) {
    credit = (
      await services.creditNotes.create(
        owner,
        {
          customerId: divers.id,
          creditDate: daysAgo(5),
          invoiceId: diversInvoice.id,
          reference: 'RMA-12',
          memo: 'Two sets returned damaged.',
          lines: [
            {
              itemId: snorkel.id,
              description: 'Returned snorkel sets',
              quantity: '2',
              unitPrice: '29.00',
            },
          ],
        },
        none,
        origin,
      )
    ).value;
    added = true;
  }
  if (credit.status === 'DRAFT') {
    await services.creditNotes.issue(owner, credit.id, { version: credit.version }, none, origin);
    added = true;
  }
  await invoice(
    'DEMO-DRAFT',
    {
      customerId: resort.id,
      invoiceDate: today,
      memo: 'Draft for next month’s maintenance visit.',
      lines: [{ itemId: consulting.id, quantity: '4' }],
    },
    true,
  );
  return added;
}

try {
  const existing = await inTransaction(database.db, {}, (tx) =>
    findUserByEmail(tx, USERS.owner.email),
  );
  if (existing) {
    const upgraded = [await ensureSeedMfa(USERS.owner), await ensureSeedMfa(USERS.admin)];
    const sales = await seedSalesDemo(await signInWithMfa(USERS.owner));
    console.log(
      upgraded.some(Boolean)
        ? 'Development seed already present; two-step verification set up for the Owner and Administrator (DEV_SEED_TOTP_SECRET).'
        : sales
          ? 'Development seed already present; Sales demo added.'
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

    await seedSalesDemo(owner);

    console.log('Development seed created:');
    for (const [role, user] of Object.entries(USERS))
      console.log(`  ${role.padEnd(6)} ${user.email}`);
    console.log('  Password: the DEV_SEED_PASSWORD value from your .env');
    console.log('  Owner and admin two-step verification key: DEV_SEED_TOTP_SECRET in your .env');
  }
} catch (error) {
  console.error('Development seed failed:', error instanceof Error ? error.message : error);
  if (error instanceof ValidationError) {
    for (const issue of error.details?.issues ?? [])
      console.error(`  ${issue.path}: ${issue.message}`);
  }
  process.exitCode = 1;
} finally {
  await app.close();
  await database.close();
}
